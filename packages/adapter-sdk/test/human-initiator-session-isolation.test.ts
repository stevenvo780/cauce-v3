import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { sessionFromDelivery, prepareDeliveryInvocation, humanHarnessSelector } from "../src/sdk/engine/delivery-context.js";
import type { Delivery } from "../src/sdk/types.js";
import type { HarnessSessionReservation } from "../src/contracts/harness.js";
import { HUMAN_A, HUMAN_B, humanDelivery, isolatedEngine, waitForRequests, IsolatedCommandRunner } from "./human-initiator-session-isolation.fixtures.js";

test("durable humans sharing an alias have distinct session selectors", () => {
  assert.notEqual(sessionFromDelivery(humanDelivery(HUMAN_A), "Steven").sessionKey,
    sessionFromDelivery(humanDelivery(HUMAN_B), "Steven").sessionKey);
});
test("one human conversation survives login and root message changes", () => {
  const first = { ...humanDelivery(), authenticated_context: { channel: "mcp", session_id: "login-first" } };
  const second = { ...humanDelivery(), authenticated_context: { channel: "mcp", session_id: "login-second" } };
  assert.equal(sessionFromDelivery(first, "Steven").sessionKey, sessionFromDelivery(second, "Steven").sessionKey);
});
test("present null initiator fails closed instead of using legacy actor scope", () => {
  const malformed = { ...humanDelivery(), human_initiator: null } as unknown as Delivery;
  assert.throws(() => sessionFromDelivery(malformed, "Steven"));
});


test("delegated cross-tenant roots retain the initiator but receiver identity isolates keys", () => {
  const root = humanDelivery();
  const delegated = { ...root, message_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", tenant_id: "Miguel" };
  assert.equal(sessionFromDelivery(root, "Steven").sessionKey, sessionFromDelivery(delegated, "Steven").sessionKey);
  assert.notEqual(sessionFromDelivery(root, "Steven").sessionKey, sessionFromDelivery(delegated, "Miguel").sessionKey);
  assert.throws(() => sessionFromDelivery({ ...root, tenant_id: "Miguel" }, "Steven"));
});

test("strict initiator validation rejects present undefined, extra fields, bad UUID and UTF8 overflow", () => {
  const root = humanDelivery();
  for (const human of [undefined, {}, { ...root.human_initiator, human_id: "alias:argos" },
    { ...root.human_initiator, role: "operator" }, { ...root.human_initiator, conversation_id: "😀".repeat(129) }]) {
    assert.throws(() => sessionFromDelivery({ ...root, human_initiator: human } as unknown as Delivery, "Steven"));
  }
  const padded = humanDelivery(HUMAN_A, " conversation ");
  assert.notEqual(sessionFromDelivery(padded, "Steven").sessionKey,
    sessionFromDelivery(humanDelivery(HUMAN_A, "conversation"), "Steven").sessionKey);
});

test("body identity never supplies a durable initiator or changes legacy session scope", () => {
  const { human_initiator, ...legacy } = humanDelivery();
  assert.equal(sessionFromDelivery(legacy, "Steven").sessionKey,
    sessionFromDelivery({ ...legacy, body: { ...legacy.body, human_initiator } }, "Steven").sessionKey);
});

test("headless native selectors isolate two humans and preserve one conversation across roots", async (t) => {
  const context = await isolatedEngine(t);
  for (const human of [HUMAN_A, HUMAN_B, HUMAN_A]) await context.run(humanDelivery(human));
  const ids = context.headless.requests.map((request) => request.args.at(-1));
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[0], ids[2]);
  assert.equal(context.manual.requests.length, 0);
  assert.equal(context.selections(), 3);
  assert.ok(context.headless.requests[0]?.stdin.includes(`"human_id":"${HUMAN_A}"`));
});

test("simultaneous human turns use separate immutable adapters while legacy TTY remains independent", async (t) => {
  const context = await isolatedEngine(t);
  context.headless.hold = true;
  context.manual.hold = true;
  t.after(() => { context.headless.release(); context.manual.release(); });
  const { human_initiator, ...legacy } = humanDelivery();
  void human_initiator;
  const a = humanDelivery(HUMAN_A);
  const b = humanDelivery(HUMAN_B);
  const work = [context.run(a), context.run(b), context.run(legacy)];
  await Promise.all([waitForRequests(context.headless, 2), waitForRequests(context.manual, 1)]);
  assert.equal(context.selections(), 3);
  for (const input of [a, b]) {
    const turn = context.emission.recorded.get(input.delivery_id);
    assert.ok(turn);
    const foreign = await context.emission.call("cauce_reply", { reply: "foreign", status: "done", retryable: false },
      { turn, token: "wrong-turn-token" });
    assert.equal(foreign.isError, true);
    const own = await context.emission.call("cauce_reply", { reply: input.human_initiator?.human_id, status: "done", retryable: false },
      { turn, token: turn.token });
    assert.equal(own.isError, undefined);
  }
  assert.notEqual(context.headless.requests[0]?.args.at(-1), context.headless.requests[1]?.args.at(-1));
  context.headless.release(); context.manual.release();
  await Promise.all(work);
  for (const input of [a, b]) {
    const done = context.events.find((event) => event.delivery_id === input.delivery_id && event.phase === "done");
    assert.ok(done);
    assert.equal(done.output?.reply, input.human_initiator?.human_id);
    assert.equal(done.claim_token, input.claim_token);
    assert.equal(done.attempt, input.attempt);
    assert.equal(done.epoch, input.epoch);
  }
});

test("invalid initiator closes durably before prompt, reservation selection and started", async (t) => {
  const context = await isolatedEngine(t);
  const invalid = { ...humanDelivery(), human_initiator: null } as unknown as Delivery;
  await context.run(invalid);
  assert.equal(context.selections(), 0);
  assert.equal(context.headless.requests.length + context.manual.requests.length, 0);
  assert.equal(context.events.some((event) => event.phase === "started"), false);
  assert.ok(context.events.some((event) => event.phase === "failed"));
});

test("cancel and fencing affect only the selected human turn", async (t) => {
  const context = await isolatedEngine(t);
  context.headless.hold = true;
  t.after(() => { context.headless.release(); });
  const a = humanDelivery(HUMAN_A); const b = humanDelivery(HUMAN_B);
  const work = [context.run(a), context.run(b)];
  await waitForRequests(context.headless, 2);
  await context.engine.cancel({ type: "cancel", delivery_id: a.delivery_id, epoch: 1 });
  assert.equal(context.headless.requests[0]?.signal.aborted, true);
  assert.equal(context.headless.requests[1]?.signal.aborted, false);
  context.headless.release(); await Promise.all(work);
  const before = context.headless.requests.length;
  await context.run({ ...humanDelivery(), epoch: 0 });
  assert.equal(context.headless.requests.length, before);
});


test("unsupported harness isolation fails before any session reservation or native turn", async (t) => {
  const context = await isolatedEngine(t);
  const { HarnessAdapter } = await import("../src/harnesses/shared.js");
  const { fakeDefinition } = await import("../src/harnesses/fake.js");
  const { deliveryHarnesses } = await import("../src/bin/shared.js");
  const adapters = deliveryHarnesses({ definition: fakeDefinition, runner: context.manual, store: context.store }, context.headless);
  assert.equal(adapters.humanHarness, undefined);
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner: context.manual, store: context.store });
  const invocation = prepareDeliveryInvocation(humanDelivery(), harness, undefined, "Steven");
  assert.ok(invocation.selectionError);
  assert.equal(invocation.reservation, undefined);
  assert.equal(context.manual.requests.length, 0);
});


test("derived agent traffic keeps the human conversation lane and PostgreSQL UUID casing", async (t) => {
  const context = await isolatedEngine(t);
  const root = humanDelivery(HUMAN_A.toUpperCase());
  await context.run(root);
  await context.run({ ...humanDelivery(),
    human_initiator: { ...root.human_initiator, human_id: HUMAN_A,
      tenant_id: "Steven", root_message_id: root.message_id, conversation_id: "conversation-one" },
    body: { type: "agent-output", prompt: "delegated task" } });
  assert.equal(context.headless.requests.length, 2);
  const firstSessionId = context.headless.requests[0]?.args.at(-1);
  assert.equal(typeof firstSessionId, "string");
  assert.notEqual(firstSessionId, "");
  assert.equal(firstSessionId, context.headless.requests[1]?.args.at(-1));
});

test("accepted recovery uses the same human selector and completed retries never execute again", async (t) => {
  const context = await isolatedEngine(t);
  const input = humanDelivery();
  await context.store.acceptAndEnqueue(input, new Date().toISOString());
  await context.engine.recover();
  assert.equal(context.headless.requests.length, 1);
  await context.run(input);
  assert.equal(context.headless.requests.length, 1);
  assert.equal(context.manual.requests.length, 0);
});


test("official Codex observed sessions resume each human's native ID independently", async (t) => {
  const context = await isolatedEngine(t);
  const { codexDefinition } = await import("../src/harnesses/codex.js");
  const { deliveryHarnesses } = await import("../src/bin/shared.js");
  const { AdapterEngine } = await import("../src/sdk/engine.js");
  const { humanHarnessSelector } = await import("../src/sdk/engine/delivery-context.js");
  const runner = new IsolatedCommandRunner("codex");
  const adapters = deliveryHarnesses({ definition: codexDefinition, runner: context.manual,
    store: context.store, sessionNamespace: "argos" }, runner);
  const engine = new AdapterEngine({ store: context.store, harness: adapters.harness, ownTenantId: "Steven",
    harnessForDelivery: humanHarnessSelector(adapters.harness, adapters.humanHarness),
    executionIntentMode: "local-test-only", publish: async () => undefined });
  t.after(() => { engine.stop(); runner.release(); });
  for (const human of [HUMAN_A, HUMAN_B, HUMAN_A, HUMAN_B]) await engine.handleDelivery(humanDelivery(human));
  const [freshA, freshB, resumedA, resumedB] = runner.requests;
  assert.ok(freshA && freshB && resumedA && resumedB);
  assert.equal(freshA.args.includes("resume"), false);
  assert.equal(freshB.args.includes("resume"), false);
  assert.equal(freshA.sessionId, undefined);
  assert.equal(freshB.sessionId, undefined);
  assert.ok(resumedA.sessionId && resumedB.sessionId);
  assert.notEqual(resumedA.sessionId, resumedB.sessionId);
  assert.ok(resumedA.args.includes("resume"));
  assert.ok(resumedB.args.includes("resume"));
  assert.ok(resumedA.args.includes(resumedA.sessionId));
  assert.ok(resumedB.args.includes(resumedB.sessionId));
});


test("shared TTY environment preserves the manual lane and cannot collapse durable human sessions", async (t) => {
  const context = await isolatedEngine(t);
  const { humanHarnessSelector } = await import("../src/sdk/engine/delivery-context.js");
  const previous = process.env.CAUCE_SHARED_SESSION;
  const reservations = [];
  try {
    process.env.CAUCE_SHARED_SESSION = "1";
    const { human_initiator, ...legacy } = humanDelivery();
    void human_initiator;
    const selector = humanHarnessSelector(context.adapters.harness, context.adapters.humanHarness);
    const manual = prepareDeliveryInvocation(legacy, context.adapters.harness, selector, "Steven");
    reservations.push(manual.reservation);
    const a = prepareDeliveryInvocation(humanDelivery(HUMAN_A), context.adapters.harness, selector, "Steven");
    reservations.push(a.reservation);
    const b = prepareDeliveryInvocation(humanDelivery(HUMAN_B), context.adapters.harness, selector, "Steven");
    reservations.push(b.reservation);
    assert.equal(manual.harness, context.adapters.harness);
    assert.equal(manual.session.sessionKey, "shared:argos");
    assert.equal(a.harness, context.adapters.humanHarness);
    assert.equal(b.harness, context.adapters.humanHarness);
    assert.notEqual(a.session.sessionKey, b.session.sessionKey);
    assert.match(a.session.sessionKey ?? "", /^auth-v3:/u);
  } finally {
    for (const reservation of reservations) reservation?.release();
    if (previous === undefined) delete process.env.CAUCE_SHARED_SESSION;
    else process.env.CAUCE_SHARED_SESSION = previous;
  }
});


test("concurrent socket emission rejects ambiguity and never deposits in another human turn", async (t) => {
  const context = await isolatedEngine(t);
  const { forwardEmission } = await import("../src/sdk/mcp-emission/runtime.js");
  await context.emission.listen();
  context.headless.hold = true;
  const a = humanDelivery(HUMAN_A); const b = humanDelivery(HUMAN_B);
  const work = [context.run(a), context.run(b)];
  await waitForRequests(context.headless, 2);
  const turnA = context.emission.recorded.get(a.delivery_id);
  const turnB = context.emission.recorded.get(b.delivery_id);
  assert.ok(turnA && turnB);
  const result = await forwardEmission(context.emission.socketPath, "cauce_reply",
    { reply: "must not be deposited", status: "done", retryable: false }, turnA.token);
  assert.equal(result.isError, true);
  assert.equal(turnA.output, undefined);
  assert.equal(turnB.output, undefined);
  context.headless.release(); await Promise.all(work);
});

function consoleDelivery(subject = "a"): Delivery {
  const { human_initiator, ...legacy } = humanDelivery();
  void human_initiator;
  return { ...legacy, console_human_subject: `human:${subject.repeat(64)}`,
    authenticated_context: { channel: "console", session_id: `console:${subject}` } };
}

test("authenticated console humans without initiators bypass shared TTY and resume their own native sessions", async (t) => {
  const context = await isolatedEngine(t);
  const { AdapterEngine } = await import("../src/sdk/engine.js");
  const previous = process.env.CAUCE_SHARED_SESSION;
  process.env.CAUCE_SHARED_SESSION = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CAUCE_SHARED_SESSION;
    else process.env.CAUCE_SHARED_SESSION = previous;
  });
  const engine = new AdapterEngine({ store: context.store, emission: context.emission,
    harness: context.adapters.harness, ownTenantId: "Steven",
    harnessForDelivery: humanHarnessSelector(context.adapters.harness, context.adapters.humanHarness),
    executionIntentMode: "local-test-only", publish: async (event) => { context.events.push(event); } });
  t.after(() => { engine.stop(); });
  await engine.activateEpoch(1);
  for (const subject of ["a", "b", "a"]) await engine.handleDelivery(consoleDelivery(subject));
  assert.equal(context.manual.requests.length, 0);
  assert.equal(context.headless.requests.length, 3);
  const [a, b, again] = context.headless.requests;
  assert.ok(a && b && again);
  assert.notEqual(a.args.at(-1), b.args.at(-1));
  assert.equal(a.args.at(-1), again.args.at(-1));
  assert.ok(again.args.includes("--resume"));
  assert.equal(context.events.filter((event) => event.phase === "done").length, 3);
});

test("console isolation requires a supported dedicated harness and a selector before reservation", async (t) => {
  const context = await isolatedEngine(t);
  const input = consoleDelivery();
  for (const selector of [undefined, humanHarnessSelector(context.adapters.harness, undefined)]) {
    const invocation = prepareDeliveryInvocation(input, context.adapters.harness, selector, "Steven");
    assert.ok(invocation.selectionError);
    assert.equal(invocation.reservation, undefined);
  }
  assert.equal(context.headless.requests.length + context.manual.requests.length, 0);
});

test("body tags cannot evade authenticated console isolation or grant it to manual MCP", async (t) => {
  const context = await isolatedEngine(t);
  const selector = humanHarnessSelector(context.adapters.harness, context.adapters.humanHarness);
  const authenticated = consoleDelivery();
  for (const type of ["agent-output", "agent.fanin"]) {
    const spoofed = { ...authenticated, body: { ...authenticated.body, type } };
    const selected = prepareDeliveryInvocation(spoofed, context.adapters.harness, selector, "Steven");
    try {
      assert.equal(selected.harness, context.adapters.humanHarness);
      assert.equal(selected.session.sessionKey, sessionFromDelivery(authenticated, "Steven").sessionKey);
      assert.equal(selected.session.sessionLane, "human");
      assert.ok(selected.reservation);
    } finally { selected.reservation?.release(); }
  }
  const { human_initiator, ...manual } = humanDelivery();
  const forged = { ...manual, body: { ...manual.body, human_initiator,
    authenticated_context: authenticated.authenticated_context, console_human_subject: authenticated.console_human_subject } };
  const legacy = prepareDeliveryInvocation(forged, context.adapters.harness, selector, "Steven");
  try { assert.equal(legacy.harness, context.adapters.harness); }
  finally { legacy.reservation?.release(); }
});

test("a custom selector cannot send console or durable human turns into a shared harness", async (t) => {
  const context = await isolatedEngine(t);
  assert.equal(context.adapters.harness.supportsEmissionEndpoint, false);
  for (const input of [consoleDelivery(), humanDelivery()]) {
    const invocation = prepareDeliveryInvocation(input, context.adapters.harness,
      () => context.adapters.harness, "Steven");
    try {
      assert.ok(invocation.selectionError);
      assert.equal(invocation.reservation, undefined);
    } finally { invocation.reservation?.release(); }
  }
  assert.equal(context.manual.requests.length, 0);
});

test("the configured owner lands in the one shared session; other humans stay isolated", async (t) => {
  const context = await isolatedEngine(t);
  const previous = { shared: process.env.CAUCE_SHARED_SESSION, owner: process.env.CAUCE_OWNER_HUMAN_ID };
  const reservations = [];
  try {
    process.env.CAUCE_SHARED_SESSION = "1";
    process.env.CAUCE_OWNER_HUMAN_ID = HUMAN_A.toUpperCase();
    const selector = humanHarnessSelector(context.adapters.harness, context.adapters.humanHarness);
    const owner = prepareDeliveryInvocation(humanDelivery(HUMAN_A), context.adapters.harness, selector, "Steven");
    reservations.push(owner.reservation);
    assert.equal(owner.harness, context.adapters.harness);
    assert.equal(owner.session.sessionKey, "shared:argos");
    assert.equal(owner.humanInitiator?.human_id, HUMAN_A);
    const other = prepareDeliveryInvocation(humanDelivery(HUMAN_B), context.adapters.harness, selector, "Steven");
    reservations.push(other.reservation);
    assert.equal(other.harness, context.adapters.humanHarness);
    assert.match(other.session.sessionKey ?? "", /^auth-v3:/u);
    const foreignTenant = prepareDeliveryInvocation(humanDelivery(HUMAN_A), context.adapters.harness, selector, "Miguel");
    assert.notEqual(foreignTenant.harness, context.adapters.harness);
    reservations.push(foreignTenant.reservation);
    delete process.env.CAUCE_SHARED_SESSION;
    const noShared = prepareDeliveryInvocation(humanDelivery(HUMAN_A), context.adapters.harness, selector, "Steven");
    reservations.push(noShared.reservation);
    assert.equal(noShared.harness, context.adapters.humanHarness);
  } finally {
    for (const reservation of reservations) reservation?.release();
    if (previous.shared === undefined) delete process.env.CAUCE_SHARED_SESSION; else process.env.CAUCE_SHARED_SESSION = previous.shared;
    if (previous.owner === undefined) delete process.env.CAUCE_OWNER_HUMAN_ID; else process.env.CAUCE_OWNER_HUMAN_ID = previous.owner;
  }
});

test("the owner's console turn in the shared session executes instead of failing on emission scope", async (t) => {
  const context = await isolatedEngine(t);
  const previous = { shared: process.env.CAUCE_SHARED_SESSION, owner: process.env.CAUCE_OWNER_HUMAN_ID };
  t.after(() => {
    if (previous.shared === undefined) delete process.env.CAUCE_SHARED_SESSION; else process.env.CAUCE_SHARED_SESSION = previous.shared;
    if (previous.owner === undefined) delete process.env.CAUCE_OWNER_HUMAN_ID; else process.env.CAUCE_OWNER_HUMAN_ID = previous.owner;
  });
  process.env.CAUCE_SHARED_SESSION = "1";
  process.env.CAUCE_OWNER_HUMAN_ID = HUMAN_A;
  assert.equal(context.adapters.harness.supportsEmissionEndpoint, false);
  const owner = humanDelivery(HUMAN_A);
  const other = humanDelivery(HUMAN_B);
  await context.run(owner);
  await context.run(other);
  const outcome = (input: Delivery) => context.events.filter((event) => event.delivery_id === input.delivery_id
    && (event.phase === "done" || event.phase === "failed")).map((event) => event.error?.code ?? event.phase);
  assert.deepEqual(outcome(owner), ["done"]);
  assert.equal(context.manual.requests.length, 1);
  assert.ok(context.manual.requests[0]?.stdin.includes(`"human_id":"${HUMAN_A}"`));
  assert.deepEqual(outcome(other), ["done"]);
  assert.equal(context.headless.requests.length, 1);
  assert.ok(context.headless.requests[0]?.stdin.includes(`"human_id":"${HUMAN_B}"`));
});

const HUMAN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function withSharedHumans(t: TestContext, values: Record<string, string | undefined>): void {
  const keys = ["CAUCE_SHARED_SESSION", "CAUCE_OWNER_HUMAN_ID", "CAUCE_SHARED_HUMAN_IDS"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = previous[key];
    }
  });
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
  }
}

test("a listed human of another tenant shares the TUI; unlisted, mismatched or malformed entries stay isolated", async (t) => {
  const context = await isolatedEngine(t, "Miguel");
  withSharedHumans(t, { CAUCE_SHARED_SESSION: "1", CAUCE_OWNER_HUMAN_ID: HUMAN_A,
    CAUCE_SHARED_HUMAN_IDS: ` Miguel:${HUMAN_C}, Steven:${HUMAN_B} ,Steven:not-a-uuid,${HUMAN_C}` });
  const selector = humanHarnessSelector(context.adapters.harness, context.adapters.humanHarness);
  const reservations: (HarnessSessionReservation | undefined)[] = [];
  t.after(() => { for (const reservation of reservations) reservation?.release(); });
  const prepare = (human: string) => {
    const invocation = prepareDeliveryInvocation(humanDelivery(human), context.adapters.harness, selector, "Miguel");
    reservations.push(invocation.reservation);
    return invocation;
  };
  const listed = prepare(HUMAN_B);
  assert.equal(listed.harness, context.adapters.harness);
  assert.equal(listed.session.sessionKey, "shared:argos");
  assert.equal(listed.ownerShared, true);
  const ownerOfOtherTenant = prepare(HUMAN_A);
  assert.equal(ownerOfOtherTenant.harness, context.adapters.humanHarness);
  const wrongTenant = prepare(HUMAN_C);
  assert.equal(wrongTenant.harness, context.adapters.humanHarness);
  assert.match(wrongTenant.session.sessionKey ?? "", /^auth-v3:/u);
  assert.equal(wrongTenant.ownerShared, undefined);
  process.env.CAUCE_SHARED_HUMAN_IDS = `Steven:${HUMAN_B.toUpperCase()}`;
  assert.equal(prepare(HUMAN_B).harness, context.adapters.humanHarness);
  process.env.CAUCE_SHARED_HUMAN_IDS = `Steven:${HUMAN_B}`;
  delete process.env.CAUCE_SHARED_SESSION;
  assert.equal(prepare(HUMAN_B).harness, context.adapters.humanHarness);
});

test("a listed human's console turn runs in the shared TUI of another tenant's alias; a third human stays headless", async (t) => {
  const context = await isolatedEngine(t, "Miguel");
  withSharedHumans(t, { CAUCE_SHARED_SESSION: "1", CAUCE_OWNER_HUMAN_ID: HUMAN_C, CAUCE_SHARED_HUMAN_IDS: `Steven:${HUMAN_A}` });
  const listed = humanDelivery(HUMAN_A);
  const third = humanDelivery(HUMAN_B);
  await context.run(listed);
  await context.run(third);
  const outcome = (input: Delivery) => context.events.filter((event) => event.delivery_id === input.delivery_id
    && (event.phase === "done" || event.phase === "failed")).map((event) => event.error?.code ?? event.phase);
  assert.deepEqual(outcome(listed), ["done"]);
  assert.equal(context.manual.requests.length, 1);
  assert.ok(context.manual.requests[0]?.stdin.includes(`"human_id":"${HUMAN_A}"`));
  assert.deepEqual(outcome(third), ["done"]);
  assert.equal(context.headless.requests.length, 1);
  assert.ok(context.headless.requests[0]?.stdin.includes(`"human_id":"${HUMAN_B}"`));
});
