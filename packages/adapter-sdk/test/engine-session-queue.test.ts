import assert from "node:assert/strict";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import test from "node:test";
import { HarnessAdapter, fakeDefinition } from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
} from "../src/sdk/types.js";
import { testStateRoot } from "./test-state.js";

/**
 * P0-2 — a parked delivery must be neither invisible nor immortal.
 *
 * Until 2026-07-29 `AdapterEngine` emitted the 'started' ACK and started the claim renewal BEFORE
 * taking the session lock, so a delivery that only queued was declared in execution, the store
 * sealed `execution_started_at` on it and every renewal bumped `ack_deadline_at` 30 minutes
 * forward: the reaper never picked it up. These tests pin both halves of the fix — while queued,
 * it heartbeats as 'accepted' with a ceiling; when it actually runs, it heartbeats as 'started'.
 */

const root = testStateRoot();

async function storeFor(name: string): Promise<DurableStore> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

const SUCCESS = JSON.stringify({
  reply: "completed",
  messages: [],
  status: "done",
  retryable: false,
  artifacts: [],
});

/** Two deliveries from the SAME origin thread share `sessionKey`, and therefore the lock. */
function delivery(id: string): Delivery {
  const pad = id.padEnd(12, "0").slice(0, 12);
  const origin = {
    adapter: "telegram",
    channel: "telegram",
    conversation_id: "room-42",
    external_message_id: `message-${id}`,
    relay: [],
    metadata: {},
  } as const;
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${pad}`,
    message_id: `00000000-0000-4000-8000-${pad}`,
    request_id: `10000000-0000-4000-8000-${pad}`,
    trace_id: `trace-${id}`,
    epoch: 1,
    attempt: 1,
    claim_token: `20000000-0000-4000-8000-${pad}`,
    ack_deadline_at: new Date(Date.now() + 300_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: "argos",
    origin: { ...origin, relay: [], metadata: {} },
    authenticated_context: {
      session_id: "session-42",
      channel: "telegram",
      origin: { ...origin, relay: [], metadata: {} },
    },
    body: { prompt: "perform the task", timeout_ms: 60_000, session_key: "thread-1" },
  };
}

/** Blocks execution until the test releases it, so the queue can be observed. */
class GatedRunner implements CommandRunner {
  started = 0;
  private readonly releases: (() => void)[] = [];

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.started += 1;
    await new Promise<void>((release) => {
      if (request.signal.aborted) release();
      else this.releases.push(release);
    });
    return { stdout: SUCCESS, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
  }

  releaseAll(): void {
    while (this.releases.length > 0) this.releases.shift()?.();
  }
}

function harnessFor(store: DurableStore, runner: CommandRunner): HarnessAdapter {
  return new HarnessAdapter({ definition: fakeDefinition, runner, store });
}

/** Simulates the gateway: accepts the ACK and confirms the claim, which is what resets the watchdog. */
function confirmingPublisher(
  engine: () => AdapterEngine,
  events: DeliveryEvent[],
): (event: DeliveryEvent) => Promise<void> {
  return async (event) => {
    events.push(event);
    if (event.claim_renewal === true) {
      engine().confirmClaim(event.delivery_id, event.attempt, event.claim_token);
    }
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((next) => setTimeout(next, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("una entrega en cola late en 'accepted' y sólo pasa a 'started' cuando toma el candado", async () => {
  const store = await storeFor("queue-accepted-heartbeat");
  const runner = new GatedRunner();
  const events: DeliveryEvent[] = [];
  const engine: AdapterEngine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: harnessFor(store, runner),
    publish: confirmingPublisher(() => engine, events),
    claimRenewalMs: 10,
    claimWatchdogMs: 10_000,
  });
  await engine.activateEpoch(1);

  const queued = (): DeliveryEvent[] => events.filter((event) => event.delivery_id === "second");

  const first = engine.handleDelivery(delivery("first"));
  await waitFor(() => runner.started === 1, "la primera entrega toma el candado y ejecuta");

  const second = engine.handleDelivery(delivery("second"));
  await waitFor(
    () => queued().filter((event) => event.claim_renewal === true).length >= 3,
    "la entrega en cola late para no ser recogida por el reaper",
  );

  // While queued: it stays 'accepted' and did not invoke the harness. Not a single 'started' ACK.
  assert.equal(runner.started, 1, "la segunda entrega no puede haber invocado al harness");
  assert.deepEqual(
    [...new Set(queued().map((event) => event.phase))],
    ["accepted"],
    "una entrega en cola sólo puede emitir ACK 'accepted'",
  );
  assert.equal(store.getDelivery("second")?.state, "accepted");
  const heartbeatsWhileQueued = queued().length;

  // The first one is released: only then does the second declare execution.
  runner.releaseAll();
  await first;
  await waitFor(() => runner.started === 2, "la segunda entrega toma el candado liberado");

  const timeline = queued();
  const startedIndex = timeline.findIndex((event) => event.phase === "started");
  assert.ok(startedIndex >= 0, "al tomar el candado debe emitir 'started'");
  assert.ok(
    startedIndex >= heartbeatsWhileQueued,
    "el 'started' llega recién después de los latidos de cola, no antes",
  );
  assert.deepEqual(
    [...new Set(timeline.slice(0, startedIndex).map((event) => event.phase))],
    ["accepted"],
    "todo lo emitido antes de tomar el candado fue 'accepted'",
  );
  assert.equal(store.getDelivery("second")?.state, "started");

  runner.releaseAll();
  await second;
  assert.equal(queued().filter((event) => event.phase === "done").length, 1);
});

test("la entrega que ejecuta sí renueva, y renueva con 'started'", async () => {
  const store = await storeFor("running-started-heartbeat");
  const runner = new GatedRunner();
  const events: DeliveryEvent[] = [];
  const engine: AdapterEngine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: harnessFor(store, runner),
    publish: confirmingPublisher(() => engine, events),
    claimRenewalMs: 10,
    claimWatchdogMs: 10_000,
  });
  await engine.activateEpoch(1);

  const only = engine.handleDelivery(delivery("solo"));
  await waitFor(() => runner.started === 1, "la entrega ejecuta");
  await waitFor(
    () => events.filter((event) => event.claim_renewal === true).length >= 3,
    "una entrega en ejecución sigue renovando",
  );

  assert.deepEqual(
    [...new Set(events.filter((event) => event.claim_renewal === true).map((event) => event.phase))],
    ["started"],
    "la renovación de una entrega que ejecuta es 'started', el ACK que sella execution_started_at",
  );
  assert.equal(store.getDelivery("solo")?.state, "started");

  runner.releaseAll();
  await only;
});

test("la espera en cola tiene techo: vence RETRYABLE y sin haber declarado ejecución nunca", async () => {
  const store = await storeFor("queue-budget-exhausted");
  const runner = new GatedRunner();
  const events: DeliveryEvent[] = [];
  const engine: AdapterEngine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: harnessFor(store, runner),
    publish: confirmingPublisher(() => engine, events),
    claimRenewalMs: 10,
    claimWatchdogMs: 10_000,
    queueWaitTimeoutMs: 120,
  });
  await engine.activateEpoch(1);

  const first = engine.handleDelivery(delivery("head"));
  await waitFor(() => runner.started === 1, "la primera entrega toma el candado");
  const second = engine.handleDelivery(delivery("tail"));

  await second; // it expires on its own: nobody releases the lock

  const queued = events.filter((event) => event.delivery_id === "tail");
  assert.equal(
    queued.filter((event) => event.phase === "started").length,
    0,
    "una entrega que sólo hizo cola no puede haber emitido jamás 'started': ese ACK es el que sella "
    + "execution_started_at y la dejaría retenida para replay manual sin haber corrido nunca",
  );
  const failure = queued.find((event) => event.phase === "failed");
  assert.ok(failure, "la espera vencida debe cerrar la entrega en vez de renovar para siempre");
  assert.equal(failure.error?.code, "SESSION_QUEUE_TIMEOUT");
  assert.equal(
    failure.error.retryable,
    true,
    "nada ejecutó, así que la entrega vuelve a la cola limpia en vez de morir en dead-letters",
  );
  assert.equal(runner.started, 1, "el harness nunca vio la entrega encolada");

  runner.releaseAll();
  await first;
});

test("un latido de cola que el gateway no aplica no es pérdida de propiedad", async () => {
  const store = await storeFor("queue-renewal-not-applied");
  const runner = new GatedRunner();
  const events: DeliveryEvent[] = [];
  const logs: Record<string, unknown>[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: harnessFor(store, runner),
    // Gateway prior to this version: never confirms the queue heartbeat.
    publish: async (event) => { events.push(event); },
    logger: (entry) => { logs.push(entry as unknown as Record<string, unknown>); },
    claimRenewalMs: 10,
    claimWatchdogMs: 10_000,
    queueWaitTimeoutMs: 200,
  });
  await engine.activateEpoch(1);

  const first = engine.handleDelivery(delivery("blocker"));
  await waitFor(() => runner.started === 1, "la primera entrega toma el candado");
  const second = engine.handleDelivery(delivery("waiter"));
  await waitFor(
    () => events.some((event) => event.delivery_id === "waiter" && event.claim_renewal === true),
    "la entrega en cola late",
  );

  // 'superseded' receipt on a queue heartbeat: no signal, no loss of claim.
  engine.logDroppedQueueRenewal("waiter", 1);
  assert.ok(logs.some((entry) => entry.reason === "queue_renewal_not_applied"));
  assert.equal(
    events.filter((event) => event.delivery_id === "waiter" && event.phase === "failed").length,
    0,
    "un latido de cola no aplicado no puede cerrar la entrega con CLAIM_OWNERSHIP_LOST",
  );

  await second;
  const failure = events.find((event) => event.delivery_id === "waiter" && event.phase === "failed");
  assert.equal(
    failure?.error?.retryable,
    true,
    "con un gateway sin renovación en cola la entrega degrada a vencer sola y reintentarse",
  );

  runner.releaseAll();
  await first;
});
