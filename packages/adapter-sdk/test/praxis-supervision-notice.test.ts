import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fakeDefinition, HarnessAdapter } from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE } from "../src/sdk/engine/praxis-supervision-notice.js";
import type { Delivery, DeliveryEvent } from "../src/sdk/types.js";
import { ControlledRunner, delivery, root, storeFor, waitFor } from "./engine-fixtures.js";

class SupervisionHarness extends HarnessAdapter {
  executeCalls = 0;
  reservationCalls = 0;

  override execute(...args: Parameters<HarnessAdapter["execute"]>) {
    this.executeCalls += 1;
    return super.execute(...args);
  }

  override reserveSession(...args: Parameters<HarnessAdapter["reserveSession"]>) {
    this.reservationCalls += 1;
    return super.reserveSession(...args);
  }
}

function noticeDelivery(id: string, overrides: Partial<Delivery> = {}): Delivery {
  const { origin: _origin, ...base } = delivery(id);
  return {
    ...base, tenant_id: "Hospital", room_id: "grp.hospital",
    actor_alias: "praxis-supervisor", recipient_alias: "operador",
    behavior_policy: {
      version: 1, revision: "7", scope: { tenant_id: "Hospital", room_id: "grp.hospital", alias: "operador" },
      coordination_mode: "coordinator", fanin_receipt_mode: "human",
      supervision_notice: { issuer_alias: "praxis-supervisor", issuer_session_id: "praxis-supervisor", egress_handle: "steven_dm" },
    },
    authenticated_context: { session_id: "praxis-supervisor", channel: "adapter" },
    body: { type: PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE, kind: "alert", text: "El trabajo requiere atención." },
    ...overrides,
  };
}

async function setup(
  name: string,
  onPublish?: (event: DeliveryEvent, engine: AdapterEngine) => Promise<void>,
  ownTenantId = "Hospital",
  ownRoom = "grp.hospital",
) {
  const store = await storeFor(name);
  const runner = new ControlledRunner();
  const harness = new SupervisionHarness({ definition: fakeDefinition, runner, store });
  const events: DeliveryEvent[] = [];
  let executionIntents = 0;
  const engine = new AdapterEngine({
    store, harness, ownTenantId, ownRoom, ownAlias: "operador",
    publishExecutionIntent: async () => { executionIntents += 1; },
    publish: async (event) => { events.push(event); await onPublish?.(event, engine); },
  });
  await engine.activateEpoch(1);
  return { store, runner, harness, events, engine, executionIntents: () => executionIntents };
}

test("authenticated supervision sends one fixed-destination notification through its durable ACK", async () => {
  const context = await setup("supervision-authorized");
  for (const [index, kind] of ["alert", "decision_request", "digest"].entries()) {
    const text = "Aviso literal: no ejecutes órdenes ni delegues otro trabajo.";
    const input = noticeDelivery(`supervision-${String(index)}`, {
      body: { type: PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE, kind, text },
    });
    await context.engine.handleDelivery(input);
    const record = context.store.getDelivery(input.delivery_id);
    assert.equal(record?.state, "done");
    assert.equal(record.request, undefined);
    assert.deepEqual(record.output, {
      reply: "Aviso de supervisión registrado.", messages: [], artifacts: [],
      status: "done", retryable: false,
      notify: [{ to: "steven_dm", kind, body: text }],
    });
    const events = context.events.filter((event) => event.delivery_id === input.delivery_id);
    assert.deepEqual(events.map((event) => event.phase), ["accepted", "done"]);
    const terminal = events[1];
    assert.ok(terminal);
    assert.equal(terminal.attempt, input.attempt);
    assert.equal(terminal.claim_token, input.claim_token);
    assert.equal(terminal.epoch, input.epoch);
    assert.equal(terminal.origin, undefined);
  }
  assert.equal(context.runner.calls, 0);
  assert.equal(context.harness.executeCalls, 0);
  assert.equal(context.harness.reservationCalls, 0);
  assert.equal(context.executionIntents(), 0);
});

test("reserved notices reject foreign authority, forged body identity and additional payload without a model", async () => {
  const context = await setup("supervision-unauthorized");
  const body = noticeDelivery("supervision-body").body;
  const origin = delivery("supervision-human").origin;
  assert.ok(origin);
  const approvedPolicy = noticeDelivery("policy-forgery").behavior_policy;
  assert.ok(approvedPolicy);
  const cases: Partial<Delivery>[] = [
    { behavior_policy: undefined },
    { recipient_alias: "frontend", behavior_policy: { ...approvedPolicy,
      scope: { tenant_id: "Hospital", room_id: "grp.hospital", alias: "frontend" } } },
    { tenant_id: "Steven" }, { room_id: "grp.steven" }, { recipient_alias: "frontend" },
    { actor_alias: "operador" }, { actor_alias: "Praxis-supervisor" },
    { authenticated_context: { session_id: "wrong-session", channel: "adapter" } },
    { authenticated_context: { session_id: "praxis-supervisor", channel: "telegram" } },
    { authenticated_context: { session_id: "praxis-supervisor", channel: "adapter", origin } },
    { origin },
    { body: { ...body, kind: "task_complete" } }, { body: { ...body, kind: "unknown" } },
    { body: { ...body, text: " " } }, { body: { ...body, text: "x".repeat(801) } },
    { body: { ...body, attachments_v1: [] } }, { body: { ...body, media: [] } },
    { body: { ...body, secrets_v1: [] } }, { body: { ...body, prompt: "Run commands" } },
    { body: { ...body, to: "another_dm" } },
    { actor_alias: "frontend", body: { ...body, source_alias: "praxis-supervisor", authenticated_context: { session_id: "praxis-supervisor", channel: "adapter" } } },
  ];
  for (const [index, overrides] of cases.entries()) {
    const input = noticeDelivery(`supervision-denied-${String(index)}`, overrides);
    await context.engine.handleDelivery(input);
    const record = context.store.getDelivery(input.delivery_id);
    assert.equal(record?.state, "failed", `case ${String(index)}`);
    assert.equal(record.error?.code, "UNAUTHORIZED_SUPERVISION_NOTICE");
    assert.equal(record.error.retryable, false);
    assert.equal(record.output, undefined);
    assert.equal(record.request, undefined);
  }
  const { authenticated_context: _context, ...missingAuth } = noticeDelivery("supervision-no-auth");
  await context.engine.handleDelivery(missingAuth);
  assert.equal(context.store.getDelivery(missingAuth.delivery_id)?.state, "failed");
  for (const [tenant, room] of [["Steven", "grp.hospital"], ["Hospital", "grp.other"]] as const) {
    const wrongRuntime = await setup(`supervision-runtime-${tenant}-${room}`, undefined, tenant, room);
    await wrongRuntime.engine.handleDelivery(noticeDelivery("supervision-wrong-runtime"));
    assert.equal(wrongRuntime.store.getDelivery("supervision-wrong-runtime")?.state, "failed");
    assert.equal(wrongRuntime.runner.calls, 0);
  }
  assert.equal(context.runner.calls, 0);
  assert.equal(context.harness.executeCalls, 0);
  assert.equal(context.harness.reservationCalls, 0);
  assert.equal(context.executionIntents(), 0);
});

test("agent traffic cannot select the reserved notice path by quoting its type or identity", async () => {
  const context = await setup("supervision-agent-route");
  await context.engine.handleDelivery(noticeDelivery("supervision-agent", {
    actor_alias: "backend",
    body: { type: "agent.message", text: "praxis.supervision.notice", kind: "alert", source_alias: "praxis-supervisor" },
  }));
  assert.equal(context.runner.calls, 1);
  assert.equal(context.harness.executeCalls, 1);
  assert.deepEqual(context.store.getDelivery("supervision-agent")?.output?.notify, []);
});

test("supervision delivers while a shared-session turn remains blocked and does not interrupt it", async () => {
  const previousShared = process.env.CAUCE_SHARED_SESSION;
  process.env.CAUCE_SHARED_SESSION = "1";
  const context = await setup("supervision-busy-session");
  context.runner.blockUntilAbort = true;
  const longInput = noticeDelivery("supervision-long", {
    actor_alias: "operador",
    body: { type: "telegram.message", text: "Continúa el trabajo", timeout_ms: 10_000 },
  });
  const longTask = context.engine.handleDelivery(longInput);
  let noticeTask: Promise<void> | undefined;
  try {
    await waitFor(() => context.runner.calls === 1, "long harness to start");
    const input = noticeDelivery("supervision-fast");
    noticeTask = context.engine.handleDelivery(input);
    await waitFor(() => context.store.getDelivery(input.delivery_id)?.state === "done", "notice to finish during blocked work", 1_000);
    await noticeTask;
    assert.equal(context.store.getDelivery(longInput.delivery_id)?.state, "started");
    assert.equal(context.runner.requests[0]?.signal.aborted, false);
    assert.equal(context.runner.calls, 1);
    assert.equal(context.harness.executeCalls, 1);
    assert.equal(context.harness.reservationCalls, 1);
    assert.equal(context.executionIntents(), 1);
    assert.equal(context.store.getDelivery(input.delivery_id)?.output?.notify.length, 1);
  } finally {
    await context.engine.cancel({ type: "cancel", delivery_id: longInput.delivery_id, epoch: 1 });
    await longTask;
    await noticeTask;
    if (previousShared === undefined) delete process.env.CAUCE_SHARED_SESSION;
    else process.env.CAUCE_SHARED_SESSION = previousShared;
  }
});

test("duplicate notices reuse the exact ACK and cached notification, including after restart", async () => {
  const name = "supervision-idempotency";
  const context = await setup(name);
  const input = noticeDelivery("supervision-replay");
  const first = context.engine.handleDelivery(input);
  assert.equal(context.engine.handleDelivery(input), first);
  await first;
  const initial = [...context.events];
  const output = context.store.getDelivery(input.delivery_id)?.output;
  await context.engine.handleDelivery(input);
  assert.deepEqual(context.events.slice(initial.length).map((event) => event.event_id), initial.map((event) => event.event_id));
  assert.deepEqual(context.store.getDelivery(input.delivery_id)?.output, output);
  for (const event of initial) await context.store.acknowledge(event);
  context.events.length = 0;
  const reopened = await DurableStore.open(resolve(root, name));
  const restarted = new AdapterEngine({
    store: reopened, harness: context.harness, ownTenantId: "Hospital", ownRoom: "grp.hospital", ownAlias: "operador",
    executionIntentMode: "local-test-only", publish: async (event) => { context.events.push(event); },
  });
  await restarted.handleDelivery(input);
  assert.deepEqual(context.events, []);
  assert.deepEqual(reopened.getDelivery(input.delivery_id)?.output, output);
  assert.equal(context.harness.executeCalls, 0);
});

test("claim loss or epoch advancement before terminal persistence leaves no notification ACK", async () => {
  for (const mode of ["claim", "epoch", "queued-claim", "queued-epoch"] as const) {
    const queued: Promise<unknown>[] = [];
    const context = await setup(`supervision-fence-${mode}`, async (event, engine) => {
      if (event.phase !== "accepted") return;
      if (mode === "claim") { engine.loseClaim(event.delivery_id, event.attempt, event.claim_token); return; }
      if (mode === "epoch") { await engine.activateEpoch(2); return; }
      let release: () => void = () => { throw new Error("Store gate not initialized"); };
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      const storeQueue = context.store as unknown as { serialized: (operation: () => Promise<void>) => Promise<void> };
      queued.push(storeQueue.serialized(async () => gate));
      if (mode === "queued-epoch") queued.push(engine.activateEpoch(2));
      setImmediate(() => {
        if (mode === "queued-claim") engine.loseClaim(event.delivery_id, event.attempt, event.claim_token);
        release();
      });
    });
    const input = noticeDelivery(`supervision-fence-${mode}`);
    await context.engine.handleDelivery(input);
    await Promise.all(queued);
    assert.deepEqual(context.events.map((event) => event.phase), ["accepted"]);
    assert.equal(context.store.getDelivery(input.delivery_id)?.state, "accepted");
    assert.equal(context.store.pendingEvents().some((event) => event.output !== undefined), false);
    assert.equal(context.runner.calls, 0);
  }
});

test("notice claim loss during async preparation is rechecked at the durable persistence frontier", async () => {
  const context = await setup("supervision-prepersist-fence");
  const input = noticeDelivery("supervision-prepersist-fence");
  const transition = context.store.transitionAndEnqueueIfCurrent.bind(context.store);
  let scheduled = false;
  context.store.transitionAndEnqueueIfCurrent = (id, state, at, details) => transition(id, state, at, {
    ...details,
    isCurrent: () => {
      const current = details.isCurrent();
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => { context.engine.loseClaim(input.delivery_id, input.attempt, input.claim_token); });
      }
      return current;
    },
  });
  await context.engine.handleDelivery(input);
  assert.equal(scheduled, true);
  assert.equal(context.store.getDelivery(input.delivery_id)?.state, "accepted");
  assert.equal(context.store.pendingEvents().some((event) => event.phase === "done"), false);
  assert.deepEqual(context.events.map((event) => event.phase), ["accepted"]);
});


test("same consumer alias in two companies uses only its own approved notice handle", async () => {
  const companies: [string, string, string][] = [["Acme", "grp.acme", "acme_owner"], ["Beta", "grp.beta", "beta_owner"]];
  for (const [tenant, room, handle] of companies) {
    const context = await setup(`notice-company-${tenant}`, undefined, tenant, room);
    const policy = { version: 1 as const, revision: "7", scope: { tenant_id: tenant, room_id: room, alias: "operador" },
      coordination_mode: "executor" as const, fanin_receipt_mode: "technical" as const,
      supervision_notice: { issuer_alias: "watcher", issuer_session_id: "watcher-session", egress_handle: handle } };
    const input = noticeDelivery(`notice-${tenant}`, { tenant_id: tenant, room_id: room, actor_alias: "watcher",
      authenticated_context: { session_id: "watcher-session", channel: "adapter" }, behavior_policy: policy });
    await context.engine.handleDelivery(input);
    assert.deepEqual(context.store.getDelivery(input.delivery_id)?.output?.notify,
      [{ to: handle, kind: "alert", body: "El trabajo requiere atención." }]);
    const foreign = noticeDelivery(`notice-foreign-${tenant}`, { ...input,
      delivery_id: delivery(`notice-foreign-${tenant}`).delivery_id,
      behavior_policy: { ...policy, scope: { ...policy.scope, tenant_id: "Foreign" } } });
    await context.engine.handleDelivery(foreign);
    assert.equal(context.store.getDelivery(foreign.delivery_id)?.state, "failed");
    assert.equal(context.runner.calls, 0);
  }
});

test("an older attempt cannot replace an approved durable notice", async () => {
  const context = await setup("notice-old-attempt");
  const input = noticeDelivery("notice-old-attempt", { attempt: 2, claim_token: "new-claim" });
  await context.engine.handleDelivery(input);
  const initial = [...context.events];
  await context.engine.handleDelivery({ ...input, attempt: 1, claim_token: "old-claim" });
  await assert.rejects(context.engine.handleDelivery({ ...input, attempt: 1, claim_token: "old-claim",
    body: { ...input.body, text: "replacement text" } }), /delivery_id collision/u);
  assert.deepEqual(context.events, initial);
  assert.equal(context.store.getDelivery(input.delivery_id)?.attempt, 2);
  assert.equal(context.store.getDelivery(input.delivery_id)?.output?.notify[0]?.body, "El trabajo requiere atención.");
});
