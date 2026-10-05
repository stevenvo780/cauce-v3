import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessAdapter } from "../src/harnesses/shared/adapter.js";
import { fakeDefinition } from "../src/harnesses/fake.js";
import { openCodeDefinition } from "../src/harnesses/opencode.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type { HarnessExecuteRequest, HarnessSessionReservation } from "../src/contracts/harness.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import { delivery } from "./engine-fixtures.js";

function barrier(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const success = { reply: "completed", messages: [], status: "done", retryable: false, artifacts: [] };
function result(stdout = JSON.stringify(success)): CommandRunResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
}
async function temporaryStore(t: TestContext, beforeCleanup?: () => Promise<void>): Promise<DurableStore> {
  const directory = await mkdtemp(join(tmpdir(), "reservation-owner-"));
  t.after(async () => {
    try { await beforeCleanup?.(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  return DurableStore.open(directory);
}
function request(signal = new AbortController().signal): HarnessExecuteRequest {
  return { prompt: "synthetic turn", sessionKey: "same-conversation", timeoutMs: 2000, signal };
}

test("Engine retains its reservation until a continuation result is persisted", { timeout: 5000 }, async (t) => {
  const firstRun = barrier();
  const releaseRun = barrier();
  const doneEntered = barrier();
  const persistDone = barrier();
  const cleanup: { engine?: AdapterEngine } = {};
  const executions: Promise<void>[] = [];
  const store = await temporaryStore(t, async () => {
    cleanup.engine?.stop();
    firstRun.open(); releaseRun.open(); doneEntered.open(); persistDone.open();
    await Promise.allSettled(executions);
  });
  const prompts: string[] = [];
  const order: string[] = [];
  let firstDone = false;
  let prematureRelease = false;
  let reservations = 0;
  const reservationKeys: string[] = [];
  const runner: CommandRunner = { run: async (input) => {
    prompts.push(input.stdin);
    const index = prompts.length;
    order.push(`runner:${String(index)}`);
    if (index === 2) { firstRun.open(); await releaseRun.promise; }
    const output = { ...success, reply: index === 2 ? "first-local-reply" : "completed",
      messages: index === 1 ? [{ to: "socrates", body: "one" }, { to: "seneca", body: "two" }] : [] };
    return result(`${JSON.stringify({ type: "text", sessionID: "ses_control", part: { type: "text", text: JSON.stringify(output) } })}\n`);
  } };
  class ObservedAdapter extends HarnessAdapter {
    override reserveSession(...args: Parameters<HarnessAdapter["reserveSession"]>): HarnessSessionReservation | undefined {
      const reserved = super.reserveSession(...args);
      reservations += 1;
      const firstContinuation = reservations === 2;
      if (reserved === undefined) return undefined;
      reservationKeys.push(reserved.key);
      return { key: reserved.key, wait: (signal) => reserved.wait(signal), release: () => {
        if (firstContinuation && !firstDone) prematureRelease = true;
        reserved.release();
      } };
    }
  }
  const harness = new ObservedAdapter({ definition: openCodeDefinition, runner, store, sessionNamespace: "argos" });
  const engine = new AdapterEngine({ store, harness, ownTenantId: "Steven", executionIntentMode: "local-test-only", publish: async () => { order.push("lifecycle"); } });
  cleanup.engine = engine;
  await engine.activateEpoch(1);
  const root = { ...delivery("owner-root"), trace_id: "owner-trace", body: { prompt: "synthetic fanout" },
    routing_targets: [{ tenant_id: "Steven", alias: "socrates", online: true }, { tenant_id: "Steven", alias: "seneca", online: true }] };
  const correlation = { root_message_id: root.message_id, root_delivery_id: root.delivery_id, response_to_delivery_id: root.delivery_id };
  const a = { ...delivery("owner-a"), trace_id: root.trace_id, actor_alias: "socrates", body: { type: "agent.response", text: "one", correlation } };
  const b = { ...delivery("owner-b"), trace_id: root.trace_id, actor_alias: "seneca", body: { type: "agent.response", text: "two", correlation } };
  const original = store.transitionAndEnqueue.bind(store);
  store.transitionAndEnqueue = async (...args) => {
    if (args[0] === a.delivery_id && args[1] === "done") { doneEntered.open(); await persistDone.promise; }
    const persisted = await original(...args);
    if (args[0] === a.delivery_id && args[1] === "done") { firstDone = true; order.push("A:done"); }
    return persisted;
  };
  await engine.handleDelivery(root);
  const first = engine.handleDelivery(a);
  executions.push(first);
  await firstRun.promise;
  const second = engine.handleDelivery(b);
  executions.push(second);
  releaseRun.open();
  try {
    await doneEntered.promise;
    assert.equal(reservations, 3);
    assert.equal(reservationKeys.length, 3);
    assert.ok(reservationKeys[1]);
    assert.equal(reservationKeys[1], reservationKeys[2]);
    assert.equal(prematureRelease, false, "Adapter released the caller reservation before local done");
    assert.equal(prompts.length, 2);
  } finally {
    persistDone.open();
    await Promise.all([first, second]);
    engine.stop();
  }
  assert.ok(prompts[2]?.includes("first-local-reply"));
  assert.ok(order.indexOf("runner:3") > order.indexOf("A:done"));
});

test("Adapter releases its own reservation after success and runner failure", async (t) => {
  const store = await temporaryStore(t);
  let calls = 0;
  const runner: CommandRunner = { run: async () => {
    calls += 1;
    if (calls === 1) throw new Error("synthetic runner failure");
    return result();
  } };
  const adapter = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  await assert.rejects(adapter.execute(request()));
  await adapter.execute(request());
  await adapter.execute(request());
  assert.equal(calls, 3);
});

test("Adapter releases its own reservation after cancellation", { timeout: 5000 }, async (t) => {
  const store = await temporaryStore(t);
  const entered = barrier();
  let calls = 0;
  const runner: CommandRunner = { run: async (input) => {
    calls += 1;
    if (calls === 1) {
      entered.open();
      await new Promise<void>((resolve) => { input.signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      return { ...result(""), cancelled: true, signal: "SIGTERM", exitCode: null };
    }
    return result();
  } };
  const adapter = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const controller = new AbortController();
  t.after(() => { controller.abort(new Error("test cleanup")); });
  const first = adapter.execute(request(controller.signal));
  const rejected = assert.rejects(first);
  await entered.promise;
  controller.abort(new Error("synthetic cancel"));
  await rejected;
  await adapter.execute(request());
  assert.equal(calls, 2);
});

test("Caller reservation is not released by success, failure or key mismatch", async (t) => {
  const store = await temporaryStore(t);
  let calls = 0;
  let releases = 0;
  let waits = 0;
  const runner: CommandRunner = { run: async () => { calls += 1; if (calls === 2) throw new Error("synthetic failure"); return result(); } };
  const adapter = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const reservation: HarnessSessionReservation = { key: "fake:same-conversation", wait: async () => { waits += 1; }, release: () => { releases += 1; } };
  await adapter.execute({ ...request(), sessionReservation: reservation });
  await assert.rejects(adapter.execute({ ...request(), sessionReservation: reservation }));
  await assert.rejects(adapter.execute({ ...request(), sessionReservation: { ...reservation, key: "foreign-key" } }), /Session reservation mismatch/u);
  assert.equal(releases, 0);
  assert.equal(waits, 2);
  assert.equal(calls, 2);
  reservation.release();
  assert.equal(releases, 1);
});


test("Caller retains ownership after cancelled or rejected reservation wait", { timeout: 5000 }, async (t) => {
  const store = await temporaryStore(t);
  let calls = 0;
  let releases = 0;
  const entered = barrier();
  const runner: CommandRunner = { run: async () => { calls += 1; return result(); } };
  const adapter = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const controller = new AbortController();
  t.after(() => { controller.abort(new Error("test cleanup")); });
  const reservation: HarnessSessionReservation = {
    key: "fake:same-conversation",
    wait: async (signal) => {
      entered.open();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { reject(new Error("synthetic wait cancelled")); }, { once: true });
      });
    },
    release: () => { releases += 1; },
  };
  const cancelled = assert.rejects(adapter.execute({ ...request(controller.signal), sessionReservation: reservation }), /synthetic wait cancelled/u);
  await entered.promise;
  controller.abort();
  await cancelled;
  await assert.rejects(adapter.execute({ ...request(), sessionReservation: {
    ...reservation, wait: async () => { throw new Error("synthetic wait rejected"); },
  } }), /synthetic wait rejected/u);
  assert.equal(calls, 0);
  assert.equal(releases, 0);
  reservation.release();
  assert.equal(releases, 1);
});

test("Caller release controls one lane while the other lane stays independent", async (t) => {
  const store = await temporaryStore(t);
  const inputs: CommandRunRequest[] = [];
  const runner: CommandRunner = { run: async (input) => { inputs.push(input); return result(); } };
  const adapter = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const human = adapter.reserveSession("same-conversation", "human");
  const agent = adapter.reserveSession("same-conversation", "agent");
  assert.ok(human); assert.ok(agent);
  assert.notEqual(human.key, agent.key);
  try {
    await adapter.execute({ ...request(), sessionReservation: human });
    await adapter.execute({ ...request(), sessionLane: "agent", sessionReservation: agent });
    assert.equal(inputs.length, 2);
  } finally { human.release(); agent.release(); }
  await adapter.execute(request());
  assert.equal(inputs.length, 3);
});
