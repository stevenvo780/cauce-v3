import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  HARNESS_DEFINITIONS,
  HarnessAdapter,
  fakeDefinition,
} from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine, profileAdoptionFor } from "../src/sdk/engine.js";
import type {
  CancelDelivery,
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
} from "../src/sdk/types.js";
import {
  ControlledRunner,
  SUCCESS,
  delivery,
  setup,
  storeFor,
} from "./engine-fixtures.js";
test("recovery fails previously started work rather than executing it twice", async () => {
  const store = await storeFor("engine-recovery");
  await store.activateEpoch(1);
  const input = delivery("recover-1");
  await store.accept(input, new Date().toISOString());
  await store.transition(input.delivery_id, "started", new Date().toISOString(), { retainRequest: true });
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => {
      events.push(event);
    },
  });
  await engine.recover();
  assert.equal(runner.calls, 0);
  assert.deepEqual(events.map((event) => event.phase), ["started", "failed"]);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED_AMBIGUOUS");
  assert.equal(events.at(-1)?.error?.retryable, false);
  assert.equal(store.getDelivery(input.delivery_id)?.state, "failed");
});

test("recovery may execute an accepted record that never reached dispatch", async () => {
  const store = await storeFor("engine-accepted-recovery");
  await store.activateEpoch(1);
  const input = delivery("recover-accepted");
  await store.accept(input, new Date().toISOString());
  const runner = new ControlledRunner();
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async () => undefined,
  });
  await engine.recover();
  assert.equal(runner.calls, 1);
  assert.equal(store.getDelivery(input.delivery_id)?.state, "done");
});

test("reconnect recovery leaves a currently owned process running", async () => {
  const runner = new ControlledRunner();
  runner.blockUntilAbort = true;
  const context = await setup("engine-live-recovery", runner);
  const running = context.engine.handleDelivery(delivery("live-recovery-1"));
  while (runner.calls === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  await context.engine.recover();
  assert.equal(runner.calls, 1);
  assert.equal(context.events.some((event) => event.error?.code === "INTERRUPTED_AMBIGUOUS"), false);
  await context.engine.cancel({ type: "cancel", delivery_id: "live-recovery-1", epoch: 1 });
  await running;
});

test("retryable failure executes one higher attempt but never the same attempt twice", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-attempt-retry", runner);
  const first = delivery("attempt-retry", 1, 1);
  await context.engine.handleDelivery(first);
  await context.engine.handleDelivery(first);
  assert.equal(runner.calls, 1);

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery(delivery("attempt-retry", 1, 2, first.claim_token));
  assert.equal(runner.calls, 1);
  const second = delivery("attempt-retry", 1, 2);
  await context.engine.handleDelivery(second);
  await context.engine.handleDelivery(second);
  assert.equal(runner.calls, 2);
  assert.equal(context.store.getDelivery(second.delivery_id)?.attempt, 2);
  assert.equal(context.store.getDelivery(second.delivery_id)?.state, "done");
});

test("delayed attempt-one ACK cannot acknowledge attempt-two events", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "retry",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-delayed-ack", runner);
  await context.engine.handleDelivery(delivery("delayed-ack", 1, 1));
  const oldTerminal = context.store.pendingEvents().find((event) => event.attempt === 1 && event.phase === "failed");
  assert.ok(oldTerminal);

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery(delivery("delayed-ack", 1, 2));
  const currentAccepted = context.store.pendingEvents().find((event) => event.attempt === 2 && event.phase === "accepted");
  assert.ok(currentAccepted);
  assert.equal(await context.store.acknowledge(oldTerminal), true);
  assert.equal(context.store.pendingEvents().some((event) => event.event_id === currentAccepted.event_id), true);
});

