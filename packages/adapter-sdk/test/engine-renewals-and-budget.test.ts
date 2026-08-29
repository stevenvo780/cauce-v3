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
  SUCCESS,
  ControlledRunner,
  SessionConcurrencyRunner,
  claimToken,
  delivery,
  setup,
  setupSessionConcurrency,
  storeFor,
} from "./engine-fixtures.js";
test("a running harness emits durable started renewals until it completes", async () => {
  const store = await storeFor("engine-renewable-claim");
  const runner = new SessionConcurrencyRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
    claimRenewalMs: 10,
  });
  await engine.activateEpoch(1);
  const input: Delivery = {
    ...delivery("renewable-claim"),
    body: { prompt: "long work", timeout_ms: 86_400_000 },
  };

  const running = engine.handleDelivery(input);
  await runner.waitForCalls(1);
  while (events.filter((event) => event.phase === "started").length < 2) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(runner.requests[0]?.timeoutMs, 86_400_000);
  assert.ok(store.pendingEvents().filter((event) => event.phase === "started").length >= 2);

  runner.releaseNext();
  await running;
  const startedAtCompletion = events.filter((event) => event.phase === "started").length;
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(events.filter((event) => event.phase === "started").length, startedAtCompletion);
  assert.equal(events.at(-1)?.phase, "done");
});

test("a renewal fsync failure aborts the harness instead of running without ownership", async () => {
  const store = await storeFor("engine-renewal-persistence-failure");
  const runner = new ControlledRunner();
  runner.blockUntilAbort = true;
  const events: DeliveryEvent[] = [];
  const enqueue = store.enqueue.bind(store);
  let failedRenewals = 0;
  let harnessStarted = false;
  runner.onRun = () => {
    harnessStarted = true;
  };
  Object.defineProperty(store, "enqueue", {
    configurable: true,
    value: async (event: DeliveryEvent) => {
      if (event.claim_renewal === true && harnessStarted) {
        failedRenewals += 1;
        throw new Error("injected renewal fsync failure");
      }
      return enqueue(event);
    },
  });
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
    claimRenewalMs: 10,
  });
  await engine.activateEpoch(1);

  const keepAlive = setInterval(() => undefined, 100);
  try {
    await engine.handleDelivery({
      ...delivery("renewal-persistence-failure"),
      body: { prompt: "must abort after failed renewal", timeout_ms: 86_400_000 },
    });
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(failedRenewals, 1);
  assert.equal(store.getDelivery("renewal-persistence-failure")?.state, "failed");
  assert.equal(events.at(-1)?.phase, "failed");
  assert.equal(events.at(-1)?.error?.code, "EXECUTION_CANCELLED_AMBIGUOUS");
});

test("a durable intent fsync failure prevents even a witnessed harness from being invoked", async () => {
  class WitnessedRunner extends ControlledRunner {
    readonly witnessesHarnessStart = true;
  }

  const store = await storeFor("engine-witnessed-start-persistence-failure");
  const runner = new WitnessedRunner();
  const events: DeliveryEvent[] = [];
  const enqueue = store.enqueue.bind(store);
  let failedMarkers = 0;
  Object.defineProperty(store, "enqueue", {
    configurable: true,
    value: async (event: DeliveryEvent) => {
      if (event.execution_started === true) {
        failedMarkers += 1;
        throw new Error("injected execution-start fsync failure");
      }
      return enqueue(event);
    },
  });
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({
      definition: {
        ...fakeDefinition,
        startWitness: { kind: "stdout-first-byte" },
      },
      runner,
      store,
    }),
    publish: async (event) => { events.push(event); },
  });
  await engine.activateEpoch(1);

  await engine.handleDelivery(delivery("witnessed-start-fsync-failure"));

  assert.equal(runner.calls, 0);
  assert.equal(failedMarkers, 1);
  assert.equal(
    events.some((event) => event.execution_started === true),
    false,
    "a marker that failed fsync cannot be published as durable",
  );
  assert.equal(events.some((event) => event.phase === "done"), false);
  const failed = events.at(-1);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "EXECUTION_INTENT_PERSISTENCE_FAILED");
  assert.equal(failed?.error?.retryable, true);
  assert.equal(store.getDelivery("witnessed-start-fsync-failure")?.state, "failed");
});

test("body timeout cannot exceed the seven-day operator ceiling", async () => {
  const context = await setup("engine-timeout-ceiling");
  await context.engine.handleDelivery({
    ...delivery("timeout-ceiling"),
    body: { prompt: "too long", timeout_ms: 604_800_001 },
  });

  assert.equal(context.runner.calls, 0);
  assert.equal(context.events.at(-1)?.phase, "failed");
  assert.equal(context.events.at(-1)?.error?.code, "INVALID_TIMEOUT");
});

test("a queued serialized session keeps renewing its claim, in 'accepted', before execution", async () => {
  const context = await setupSessionConcurrency("engine-session-ack-budget", 50);
  const firstInput = delivery("session-ack-budget-a");
  const secondInput: Delivery = {
    ...delivery("session-ack-budget-b"),
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    body: { prompt: "queued turn", timeout_ms: 60_000 },
  };

  const first = context.engine.handleDelivery(firstInput);
  await context.runner.waitForCalls(1);
  const second = context.engine.handleDelivery(secondInput);
  // The queued delivery has to keep renewing its claim —otherwise the reaper takes it away in the
  // middle of the queue— but renewing in 'accepted'. Before, this test expected two 'started' ACKs,
  // which was the defect written as an assertion: it declared execution without holding the lock.
  const renewalDeadline = Date.now() + 5_000;
  while (context.events.filter(
    (event) => event.delivery_id === secondInput.delivery_id
      && event.phase === "accepted"
      && event.claim_renewal === true,
  ).length < 2) {
    if (Date.now() >= renewalDeadline) throw new Error("queued claim renewal timeout");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(
    context.events.filter(
      (event) => event.delivery_id === secondInput.delivery_id && event.phase === "started",
    ).length,
    0,
    "mientras hace fila no puede haber emitido un solo ACK 'started'",
  );

  assert.equal(context.runner.requests.length, 1);
  context.runner.releaseNext();
  await context.runner.waitForCalls(2);
  assert.equal(context.runner.requests[1]?.timeoutMs, 60_000);
  context.runner.releaseNext();
  await Promise.all([first, second]);
  assert.equal(context.store.getDelivery(secondInput.delivery_id)?.state, "done");
});

test("advancing the fencing epoch preserves post-dispatch cancellation ambiguity", async () => {
  const runner = new ControlledRunner();
  runner.blockUntilAbort = true;
  const context = await setup("engine-fence", runner);
  const running = context.engine.handleDelivery(delivery("fence-1"));
  while (runner.calls === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  await context.engine.activateEpoch(2);
  await running;
  const failed = context.events.at(-1);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "EXECUTION_CANCELLED_AMBIGUOUS");
  assert.equal(failed?.error?.retryable, false);
  assert.equal(failed?.epoch, 2);
});

test("outbox removes events only after relay ACK", async () => {
  const context = await setup("engine-ack");
  await context.engine.handleDelivery(delivery("ack-1"));
  const pending = context.store.pendingEvents();
  // accepted + started + started(execution_started) + done. The third is the mark of the harness's
  // real start, which is durable like any other event: if the socket is down when the harness
  // starts, it is dispatched on reconnect and the database still learns that it was already paid.
  assert.equal(pending.length, 4);
  const first = pending[0];
  assert.ok(first);
  assert.equal(await context.store.acknowledge(first), true);
  assert.equal(context.store.pendingEvents().length, 3);
  assert.equal(await context.store.acknowledge({
    ...first,
    event_id: "00000000-0000-4000-8000-000000000000",
  }), false);
});

test("structured retryable failure becomes a retryable failed lifecycle event", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-retryable", runner);
  await context.engine.handleDelivery(delivery("retryable-1"));
  const failed = context.events.at(-1);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.retryable, true);
  assert.equal(failed?.output?.status, "failed");
});

