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
  SessionConcurrencyRunner,
  claimToken,
  delivery,
  setup,
  setupSessionConcurrency,
  storeFor,
  waitForQueued,
} from "./engine-fixtures.js";
test("profile adoption requires the exact measured document set from the delivery contract", () => {
  const path = "/runtime/.codex/AGENTS.md";
  const sha = "a".repeat(64);
  const contracted: Delivery = {
    ...delivery("profile001"),
    profile_runtime_contract: {
      revision: 7,
      generation: "runtime-generation-7",
      documents: [{ name: "AGENTS.md", path, sha }],
    },
  };
  const measured = {
    source: "runtime-files" as const,
    sha256: "b".repeat(64),
    documents: [{ path, sha256: sha }],
    text: "managed profile",
  };

  assert.deepEqual(profileAdoptionFor(contracted, measured), {
    evidence: "adapter_delivery",
    revision: 7,
    generation: "runtime-generation-7",
    documents: [{ name: "AGENTS.md", path, sha }],
  });
  assert.equal(profileAdoptionFor(contracted, {
    ...measured,
    documents: [{ path, sha256: "c".repeat(64) }],
  }), undefined);
  assert.equal(profileAdoptionFor(contracted, {
    ...measured,
    documents: [...measured.documents, { path: "/runtime/extra.md", sha256: sha }],
  }), undefined);
  assert.equal(profileAdoptionFor({ ...contracted, profile_runtime_contract: undefined }, measured), undefined);
});
test("accepted is durable and published before started and execution", async () => {
  const context = await setup("engine-order");
  let phasesAtRun: string[] = [];
  let executionMarkedAtRun = 0;
  context.runner.onRun = () => {
    phasesAtRun = context.events.map((event) => event.phase);
    executionMarkedAtRun = context.events.filter((event) => event.execution_started === true).length;
  };
  await context.engine.handleDelivery(delivery("order-1"));
  assert.deepEqual(phasesAtRun, ["accepted", "started", "started"]);
  // La marca ya estaba emitida cuando el harness arrancó, no después: emitirla después dejaría
  // una corrida que muere en el primer segundo indistinguible de una que nunca arrancó.
  assert.equal(executionMarkedAtRun, 1);
  assert.deepEqual(
    context.events.map((event) => event.phase),
    ["accepted", "started", "started", "done"],
  );
  assert.deepEqual(
    context.events.map((event) => event.execution_started === true),
    [false, false, true, false],
  );
  assert.equal(context.store.getDelivery("order-1")?.state, "done");
  assert.deepEqual(
    context.store.pendingEvents().map((event) => event.phase),
    ["accepted", "started", "started", "done"],
  );
});

test("concurrent deliveries for one authenticated session share one UUID and execute in order", async () => {
  const store = await storeFor("engine-session-serialized");
  const runner = new SessionConcurrencyRunner();
  let markFirstAccepted!: () => void;
  let releaseFirstAccepted!: () => void;
  const firstAccepted = new Promise<void>((resolveAccepted) => {
    markFirstAccepted = resolveAccepted;
  });
  const acceptedBarrier = new Promise<void>((resolveBarrier) => {
    releaseFirstAccepted = resolveBarrier;
  });
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness,
    publish: async (event) => {
      if (event.delivery_id === "session-serialized-a"
        && event.phase === "accepted"
        && event.claim_renewal !== true) {
        markFirstAccepted();
        await acceptedBarrier;
      }
    },
    claimRenewalMs: 25,
  });
  await engine.activateEpoch(1);
  const firstInput: Delivery = {
    ...delivery("session-serialized-a"),
    body: { prompt: "first session turn", timeout_ms: 2_000 },
  };
  const secondInput: Delivery = {
    ...delivery("session-serialized-b"),
    body: { prompt: "second session turn", timeout_ms: 2_000 },
  };

  const first = engine.handleDelivery(firstInput);
  await firstAccepted;
  const second = engine.handleDelivery(secondInput);
  await waitForQueued(store, secondInput.delivery_id);

  assert.equal(runner.requests.length, 0);
  releaseFirstAccepted();
  await runner.waitForCalls(1);
  assert.match(runner.requests[0]?.stdin ?? "", /first session turn/u);
  runner.releaseNext();

  await runner.waitForCalls(2);
  assert.match(runner.requests[1]?.stdin ?? "", /second session turn/u);
  const nativeSessionIds = runner.requests.map((request) => request.args.at(-1));
  assert.equal(new Set(nativeSessionIds).size, 1);
  assert.match(nativeSessionIds[0] ?? "", /^[0-9a-f-]{36}$/u);

  runner.releaseNext();
  await Promise.all([first, second]);
  assert.equal(runner.maxActive, 1);
});

test("concurrent deliveries for different authenticated sessions execute in parallel", async () => {
  const context = await setupSessionConcurrency("engine-session-parallel");
  const firstInput = delivery("session-parallel-a");
  const secondBase = delivery("session-parallel-b");
  const authenticatedContext = secondBase.authenticated_context;
  assert.ok(authenticatedContext);
  const secondInput: Delivery = {
    ...secondBase,
    authenticated_context: {
      ...authenticatedContext,
      session_id: "session-99",
    },
  };

  const first = context.engine.handleDelivery(firstInput);
  await context.runner.waitForCalls(1);
  const second = context.engine.handleDelivery(secondInput);
  await context.runner.waitForCalls(2);

  assert.equal(context.runner.maxActive, 2);
  assert.notEqual(
    context.runner.requests[0]?.args.at(-1),
    context.runner.requests[1]?.args.at(-1),
  );

  context.runner.releaseNext();
  context.runner.releaseNext();
  await Promise.all([first, second]);
});

/**
 * EL escenario del dueño del sistema, tal como lo describió el revisor, y el motivo de todo el
 * carril de agentes.
 *
 * jarvis (openclaw, sessionStrategy 'generated' ⇒ candado activo) atiende a su dueño en el chat
 * C. La cadena delega y vuelve como `agent.response` HEREDANDO
 * `origin={adapter:'telegram', conversation_id:C}`, así que antes le tocaba la MISMA clave de
 * sesión: esa respuesta agarraba el candado de la conversación de la persona y lo retenía toda
 * su corrida. Cuando el dueño escribía, su mensaje entraba rápido al gateway y se quedaba
 * esperando ese candado. 114 minutos de mediana en midas, 235 en el peor caso.
 *
 * Lo que se afirma acá es exactamente lo que pidió el dueño: la tarea agente-a-agente NO se
 * cancela ni se acorta —sigue bloqueada— y aun así el mensaje humano ejecuta.
 */
test("a human message executes while agent-to-agent work of the same conversation is still running", async () => {
  const context = await setupSessionConcurrency("engine-human-lane-preemption");
  const agentWork: Delivery = {
    ...delivery("human-lane-agent-work"),
    actor_alias: "kant",
    body: { type: "agent.response", text: "kant volvió con el resultado" },
  };
  // Misma conversación, mismo origin, misma clave base: lo único que difiere es la clase.
  const ownerMessage: Delivery = {
    ...delivery("human-lane-owner-message"),
    body: { prompt: "che, ¿qué estás haciendo?" },
  };

  const agent = context.engine.handleDelivery(agentWork);
  await context.runner.waitForCalls(1);

  const owner = context.engine.handleDelivery(ownerMessage);
  // Sin carriles esto se colgaba acá para siempre: waitForCalls(2) no llegaba nunca hasta que
  // la tarea del agente terminara.
  await context.runner.waitForCalls(2);
  assert.equal(context.runner.maxActive, 2);
  assert.match(context.runner.requests[1]?.stdin ?? "", /qué estás haciendo/u);
  // Sesiones nativas distintas: es el costo declarado del cambio (el agente pierde el hilo
  // conversacional entre los dos carriles) y a la vez lo que hace posible la concurrencia.
  assert.notEqual(
    context.runner.requests[0]?.args.at(-1),
    context.runner.requests[1]?.args.at(-1),
  );

  // El humano puede terminar primero sin que nadie haya tocado la tarea larga.
  context.runner.releaseNext();
  context.runner.releaseNext();
  await Promise.all([agent, owner]);
});

/**
 * El contracargo del test de arriba: separar carriles no puede volver concurrente lo que tiene
 * que seguir serializado. Dos mensajes de la MISMA persona en la misma conversación siguen
 * ejecutándose de a uno, o el harness se pisaría a sí mismo dentro de una conversación.
 */
test("two human messages of the same conversation stay serialized", async () => {
  const context = await setupSessionConcurrency("engine-human-lane-serialized");
  const first = context.engine.handleDelivery({
    ...delivery("human-lane-first"),
    body: { prompt: "primera pregunta" },
  });
  await context.runner.waitForCalls(1);
  const second = context.engine.handleDelivery({
    ...delivery("human-lane-second"),
    body: { prompt: "segunda pregunta" },
  });
  // la segunda entrega ya no pasa por 'started' mientras hace fila —
  // se estaciona en 'accepted' y late ahí. `waitForQueued` es el reemplazo exacto de la vieja
  // `waitForStarted` para este caso: mismo punto del ciclo, señal correcta.
  await waitForQueued(context.store, "human-lane-second");

  assert.equal(context.runner.requests.length, 1);
  assert.equal(context.runner.maxActive, 1);

  context.runner.releaseNext();
  await context.runner.waitForCalls(2);
  context.runner.releaseNext();
  await Promise.all([first, second]);
  assert.equal(context.runner.maxActive, 1);
  assert.equal(
    context.runner.requests[0]?.args.at(-1),
    context.runner.requests[1]?.args.at(-1),
  );
});

test("cancelling a queued session delivery skips execution without breaking the session queue", async () => {
  const context = await setupSessionConcurrency("engine-session-queued-cancel", 25);
  const firstInput = delivery("session-cancel-a");
  const secondInput = delivery("session-cancel-b");
  const thirdInput = delivery("session-cancel-c");

  const first = context.engine.handleDelivery(firstInput);
  await context.runner.waitForCalls(1);
  const second = context.engine.handleDelivery(secondInput);
  await waitForQueued(context.store, secondInput.delivery_id);
  const third = context.engine.handleDelivery(thirdInput);
  await waitForQueued(context.store, thirdInput.delivery_id);
  await context.engine.cancel({
    type: "cancel",
    delivery_id: secondInput.delivery_id,
    epoch: 1,
  });
  await second;

  assert.equal(context.runner.requests.length, 1);
  assert.equal(context.store.getDelivery(secondInput.delivery_id)?.error?.code, "CANCELLED");

  context.runner.releaseNext();
  await first;
  await context.runner.waitForCalls(2);
  assert.equal(
    context.runner.requests[0]?.args.at(-1),
    context.runner.requests[1]?.args.at(-1),
  );
  context.runner.releaseNext();
  await third;
});

test("fencing queued session work skips stale execution and releases the queue", async () => {
  const context = await setupSessionConcurrency("engine-session-queued-fence", 25);
  const firstInput = delivery("session-fence-a");
  const secondInput = delivery("session-fence-b");

  const first = context.engine.handleDelivery(firstInput);
  await context.runner.waitForCalls(1);
  const second = context.engine.handleDelivery(secondInput);
  await waitForQueued(context.store, secondInput.delivery_id);
  await context.engine.activateEpoch(2);
  await second;

  assert.equal(context.runner.requests.length, 1);
  assert.equal(context.store.getDelivery(secondInput.delivery_id)?.error?.code, "FENCED");
  assert.equal(context.store.getDelivery(secondInput.delivery_id)?.error?.retryable, true);
  context.runner.releaseNext();
  await first;
  assert.equal(
    context.store.getDelivery(firstInput.delivery_id)?.error?.code,
    "EXECUTION_CANCELLED_AMBIGUOUS",
  );
  assert.equal(context.store.getDelivery(firstInput.delivery_id)?.error?.retryable, false);

  const current = context.engine.handleDelivery(delivery("session-fence-c", 2));
  await context.runner.waitForCalls(2);
  context.runner.releaseNext();
  await current;
  assert.equal(context.store.getDelivery("session-fence-c")?.state, "done");
});

test("shutdown is retryable before dispatch but successful output obtained after abort is ambiguous", async () => {
  const context = await setupSessionConcurrency("engine-session-shutdown-boundary", 25);
  const dispatchedInput = delivery("session-stop-dispatched");
  const queuedInput = delivery("session-stop-queued");

  const dispatched = context.engine.handleDelivery(dispatchedInput);
  await context.runner.waitForCalls(1);
  const queued = context.engine.handleDelivery(queuedInput);
  await waitForQueued(context.store, queuedInput.delivery_id);

  context.engine.stop();
  await queued;
  assert.equal(context.runner.requests.length, 1);
  assert.equal(context.store.getDelivery(queuedInput.delivery_id)?.error?.code, "SHUTDOWN");
  assert.equal(context.store.getDelivery(queuedInput.delivery_id)?.error?.retryable, true);

  context.runner.releaseNext();
  await dispatched;
  assert.equal(context.store.getDelivery(dispatchedInput.delivery_id)?.error?.code,
    "EXECUTION_CANCELLED_AMBIGUOUS");
  assert.equal(context.store.getDelivery(dispatchedInput.delivery_id)?.error?.retryable, false);
});

test("confirmed terminal delivery is neither executed nor published twice", async () => {
  const context = await setup("engine-duplicate");
  const input = delivery("duplicate-1");
  await context.engine.handleDelivery(input);
  for (const event of context.store.pendingEvents()) await context.store.acknowledge(event);
  const published = context.events.length;
  await context.engine.handleDelivery(input);
  assert.equal(context.runner.calls, 1);
  assert.equal(context.events.length, published);
  assert.equal(context.store.pendingEvents().length, 0);
});

test("terminal output preserves delivery origin for relay routing", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "completed",
    messages: [{ to: "audit", body: "done" }],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-origin", runner);
  await context.engine.handleDelivery({
    ...delivery("origin-1"),
    routing_targets: [{ tenant_id: "Steven", alias: "audit", online: true }],
  });
  const done = context.events.find((event) => event.phase === "done");
  assert.deepEqual(done?.origin, {
    adapter: "telegram",
    channel: "telegram",
    conversation_id: "room-42",
    external_message_id: "message-9",
    relay: [],
    metadata: {},
  });
  assert.equal(done?.output?.reply, "completed");
  assert.equal(done?.output?.messages[0]?.to, "audit");
});

