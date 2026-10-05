import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { HarnessAdapter, codexDefinition } from "../src/harnesses/index.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import type { CommandRunRequest, CommandRunResult, DeliveryEvent, HarnessConsumptionWitness, StructuredOutput } from "../src/sdk/types.js";
import { consumptionWitness } from "../src/shared-session/consumption.js";
import { delivery, root, storeFor, SUCCESS } from "./engine-fixtures.js";
import { FakeConnection, ScriptedConnector, makeClient, waitUntil } from "./client-fixtures.js";

const sid = "00000000-0000-4000-8000-000000000001";
async function setup(name: string, options: { noProof?: boolean; wrongInput?: boolean; foreignSid?: boolean;
  nonzero?: boolean; failed?: boolean; beforeReturn?: (engine: AdapterEngine) => Promise<void> } = {}) {
  const store = await storeFor(name); await store.activateEpoch(1);
  const events: DeliveryEvent[] = []; let calls = 0;
  let observed: HarnessConsumptionWitness | undefined;
  const runner = { run: async (request: CommandRunRequest): Promise<CommandRunResult> => {
    calls += 1;
    const witness = consumptionWitness("codex", options.foreignSid ? "foreign-session" : sid, "turn-A",
      options.wrongInput ? "wrong-input" : request.stdin);
    if (options.beforeReturn !== undefined) await options.beforeReturn(engine);
    return { stdout: [JSON.stringify({ type: "thread.started", thread_id: sid }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text:
        options.failed ? JSON.stringify({ reply: "failed", messages: [], artifacts: [], status: "failed", retryable: false }) : SUCCESS } }),
      JSON.stringify({ type: "turn.completed" })].join("\n"), stderr: "", signal: null,
      exitCode: options.nonzero ? 1 : 0, timedOut: false, cancelled: false,
      ...(options.noProof || witness === undefined ? {} : { consumptionWitness: witness }) };
  } };
  const harness = new HarnessAdapter({ definition: codexDefinition, runner, store });
  const engine = new AdapterEngine({ store, harness, executionIntentMode: "local-test-only",
    publish: async (event) => { events.push(event); observed = event.harness_consumption_v1 ?? observed; } });
  return { store, engine, events, calls: () => calls, proof: () => observed };
}

test("terminal receipt is fsynced with its ACK and replayed with the same event identity", async () => {
  const context = await setup("receipt-durable-replay"); const input = delivery("receipt-A");
  await context.engine.handleDelivery(input);
  const terminal = context.events.find((event) => event.phase === "done"); assert.ok(terminal?.harness_consumption_v1);
  assert.ok(context.events.filter((event) => event.phase !== "done").every((event) => event.harness_consumption_v1 === undefined));
  const directory = resolve(root, "receipt-durable-replay");
  const reopened = await DurableStore.open(directory);
  const replay = reopened.pendingEvents().find((event) => event.event_id === terminal.event_id);
  assert.deepEqual(replay, terminal);
  await context.engine.handleDelivery(input); assert.equal(context.calls(), 1);
  assert.equal(context.store.pendingEvents().filter((event) => event.phase === "done").length, 1);
  assert.equal(JSON.stringify(terminal.harness_consumption_v1).includes("perform the task"), false);
});

for (const [name, options] of Object.entries({ noProof: { noProof: true }, input: { wrongInput: true },
  sid: { foreignSid: true }, nonzero: { nonzero: true }, failed: { failed: true } })) {
  test(`receipt stays unknown for ${name}`, async () => {
    const context = await setup(`receipt-negative-${name}`, options);
    await context.engine.handleDelivery(delivery(`receipt-${name}`));
    assert.equal(context.proof(), undefined);
    assert.ok(context.store.pendingEvents().every((event) => event.harness_consumption_v1 === undefined));
  });
}

test("proof returned after fencing does not enter any durable ACK", async () => {
  const context = await setup("receipt-fenced", { beforeReturn: async (engine) => { await engine.activateEpoch(2); } });
  await context.engine.handleDelivery(delivery("receipt-fenced"));
  assert.equal(context.proof(), undefined);
  assert.ok(context.store.pendingEvents().every((event) => event.harness_consumption_v1 === undefined));
});

test("ownership-lost receipt discards local consumption before retry", async () => {
  const context = await setup("receipt-ownership-lost"); const input = delivery("receipt-lost");
  await context.engine.handleDelivery(input);
  const event = context.events.find((candidate) => candidate.phase === "done"); assert.ok(event);
  await context.store.acknowledgeResult(event, { terminal_receipt: "ownership_lost" });
  assert.equal(context.store.getDelivery(input.delivery_id)?.harness_consumption_v1, undefined);
});


test("client sends receipt as ACK result and unconfirmed replay keeps the same proof", async () => {
  const connection = new FakeConnection(1);
  const context = await makeClient("receipt-wire", new ScriptedConnector(connection), { epoch: 1 });
  const input = delivery("receipt-wire"); await context.store.accept(input, new Date().toISOString());
  const witness = consumptionWitness("codex", sid, "turn-wire", "input"); assert.ok(witness);
  const terminal = await context.store.transitionAndEnqueue(input.delivery_id, "done", new Date().toISOString(),
    { output: JSON.parse(SUCCESS) as StructuredOutput,
      consumptionWitness: witness });
  const stop = new AbortController(); const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "ack" && frame.event_id === terminal.event.event_id), "receipt ACK");
    const ack = connection.sent.find((frame) => frame.type === "ack" && frame.event_id === terminal.event.event_id);
    assert.ok(ack?.type === "ack");
    assert.deepEqual(ack.result?.harness_consumption_v1, witness);
    connection.push({ type: "ack_result", event_id: ack.event_id, delivery_id: ack.delivery_id,
      attempt: ack.attempt, claim_token: ack.claim_token, status: "done", applied: false, receipt: "superseded" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.deepEqual(context.store.pendingEvents().find((event) => event.event_id === ack.event_id)?.harness_consumption_v1, witness);
    connection.push({ type: "ack_result", event_id: ack.event_id, delivery_id: ack.delivery_id,
      attempt: ack.attempt, claim_token: ack.claim_token, status: "done", applied: true, receipt: "applied" });
    await waitUntil(() => !context.store.pendingEvents().some((event) => event.event_id === ack.event_id), "applied ACK cleared");
  } finally { stop.abort(); await running; }
});
