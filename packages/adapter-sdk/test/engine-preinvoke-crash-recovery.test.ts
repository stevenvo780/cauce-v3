import assert from "node:assert/strict";
import test from "node:test";
import {HarnessAdapter, fakeDefinition} from '../src/harnesses/index.js';
import {AdapterEngine} from '../src/sdk/engine.js';
import type {DeliveryEvent} from '../src/sdk/types.js';
import {
  ControlledRunner,
  delivery,
  setup,
  storeFor,
} from "./engine-fixtures.js";
test("crash recovery holds a preinvoke-v1 attempt once its exact intent receipt exists", async () => {
  const store = await storeFor("engine-crash-redelivery");
  await store.activateEpoch(1);
  const first = delivery("crash-redelivery", 1, 1);
  await store.accept(first, new Date().toISOString());
  await store.transition(first.delivery_id, "started", new Date().toISOString(), {
    retainRequest: true,
    attempt: first.attempt,
    claimToken: first.claim_token,
    executionIntentProtocol: "preinvoke-v1",
  });
  const intent: DeliveryEvent = {
    event_id: "40000000-0000-4000-8000-000000000001",
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: first.claim_token,
    epoch: 1,
    phase: "started",
    occurred_at: new Date().toISOString(),
    claim_renewal: true,
    execution_started: true,
  };
  await store.enqueue(intent);
  assert.equal(await store.acknowledgeResult(intent, {
    execution_intent_receipt: "applied",
  }), true);
  assert.equal(
    store.getDelivery(first.delivery_id)?.execution_intent_receipt_event_id,
    intent.event_id,
  );
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });

  await engine.recover();
  assert.equal(runner.calls, 0);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED_AMBIGUOUS");
  assert.equal(events.at(-1)?.error?.retryable, false);
  await engine.handleDelivery(delivery("crash-redelivery", 1, 2));
  assert.equal(runner.calls, 0);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "failed");
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 1);
});

test("crash recovery retries preinvoke-v1 when a local intent has no remote receipt", async () => {
  const store = await storeFor("engine-crash-intent-no-receipt");
  await store.activateEpoch(1);
  const first = delivery("crash-intent-no-receipt", 1, 1);
  await store.accept(first, new Date().toISOString());
  await store.transition(first.delivery_id, "started", new Date().toISOString(), {
    retainRequest: true,
    attempt: first.attempt,
    claimToken: first.claim_token,
    executionIntentProtocol: "preinvoke-v1",
  });
  await store.enqueue({
    event_id: "40000000-0000-4000-8000-000000000002",
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: first.claim_token,
    epoch: 1,
    phase: "started",
    occurred_at: new Date().toISOString(),
    claim_renewal: true,
    execution_started: true,
  });
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });

  await engine.recover();
  assert.equal(runner.calls, 0);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED_PREFLIGHT");
  assert.equal(events.at(-1)?.error?.retryable, true);

  await engine.handleDelivery(delivery("crash-intent-no-receipt", 1, 2));
  assert.equal(runner.calls, 1);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "done");
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 2);
});

test("crash recovery retries a preinvoke-v1 attempt that never committed execution intent", async () => {
  const store = await storeFor("engine-crash-before-intent");
  await store.activateEpoch(1);
  const first = delivery("crash-before-intent", 1, 1);
  await store.accept(first, new Date().toISOString());
  await store.transition(first.delivery_id, "started", new Date().toISOString(), {
    retainRequest: true,
    attempt: first.attempt,
    claimToken: first.claim_token,
    executionIntentProtocol: "preinvoke-v1",
  });
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });

  await engine.recover();
  assert.equal(runner.calls, 0);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED_PREFLIGHT");
  assert.equal(events.at(-1)?.error?.retryable, true);

  await engine.handleDelivery(delivery("crash-before-intent", 1, 2));
  assert.equal(runner.calls, 1);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "done");
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 2);
});

test("a duplicate started frame retries a local intent that has no remote receipt", async () => {
  const store = await storeFor("engine-duplicate-before-intent");
  await store.activateEpoch(1);
  const first = delivery("duplicate-before-intent", 1, 1);
  await store.accept(first, new Date().toISOString());
  await store.transition(first.delivery_id, "started", new Date().toISOString(), {
    retainRequest: true,
    attempt: first.attempt,
    claimToken: first.claim_token,
    executionIntentProtocol: "preinvoke-v1",
  });
  await store.enqueue({
    event_id: "40000000-0000-4000-8000-000000000003",
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: first.claim_token,
    epoch: 1,
    phase: "started",
    occurred_at: new Date().toISOString(),
    claim_renewal: true,
    execution_started: true,
  });
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });

  await engine.handleDelivery(first);
  assert.equal(runner.calls, 0);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED_PREFLIGHT");
  assert.equal(events.at(-1)?.error?.retryable, true);

  await engine.handleDelivery(delivery("duplicate-before-intent", 1, 2));
  assert.equal(runner.calls, 1);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "done");
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 2);
});

test("a duplicate started frame holds once its exact remote intent receipt exists", async () => {
  const store = await storeFor("engine-duplicate-intent-receipt");
  await store.activateEpoch(1);
  const first = delivery("duplicate-intent-receipt", 1, 1);
  await store.accept(first, new Date().toISOString());
  await store.transition(first.delivery_id, "started", new Date().toISOString(), {
    retainRequest: true,
    attempt: first.attempt,
    claimToken: first.claim_token,
    executionIntentProtocol: "preinvoke-v1",
  });
  const intent: DeliveryEvent = {
    event_id: "40000000-0000-4000-8000-000000000004",
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: first.claim_token,
    epoch: 1,
    phase: "started",
    occurred_at: new Date().toISOString(),
    claim_renewal: true,
    execution_started: true,
  };
  await store.enqueue(intent);
  assert.equal(await store.acknowledgeResult(intent, {
    execution_intent_receipt: "duplicate",
  }), true);
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });

  await engine.handleDelivery(first);
  assert.equal(runner.calls, 0);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED_AMBIGUOUS");
  assert.equal(events.at(-1)?.error?.retryable, false);

  await engine.handleDelivery(delivery("duplicate-intent-receipt", 1, 2));
  assert.equal(runner.calls, 0);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "failed");
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 1);
});

test("out-of-order event receipts correlate by full event identity", async () => {
  const context = await setup("engine-event-correlation");
  await context.engine.handleDelivery(delivery("event-correlation"));
  // The third event is the `execution_started` mark; it correlates by full identity like any
  // other and does not alter the order of the rest.
  const [accepted, started, executionStarted, done] = context.store.pendingEvents();
  assert.ok(accepted && started && executionStarted && done);
  assert.equal(executionStarted.execution_started, true);
  assert.equal(await context.store.acknowledge(done), true);
  assert.deepEqual(
    context.store.pendingEvents().map((event) => event.event_id),
    [accepted.event_id, started.event_id, executionStarted.event_id],
  );
  assert.equal(await context.store.acknowledge(accepted), true);
  assert.deepEqual(
    context.store.pendingEvents().map((event) => event.event_id),
    [started.event_id, executionStarted.event_id],
  );
});

/**
 * Previously this separated by `delivery.tenant_id`, which is the SENDER's tenant: the same
 * person, in the same chat, talking to the same agent, landed in different sessions depending
 * on which agent published the delivery. That separation was not a boundary — the test below
 * ("trusted bridge tenant...") requires the opposite for the same conversation — and was one
 * of the causes of the "instances duplicate" symptom.
 *
 * What it still protects, which is the reason it exists: two distinct authenticated
 * conversations (two humans, two chats) never share a session even when they bring the same
 * `session_key` label in the body, which is an untrusted field.
 */
