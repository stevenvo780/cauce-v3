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
  SUCCESS,
  claimToken,
  conversation,
  delivery,
  originless,
  sessionOf,
  setup,
  setupSessionConcurrency,
} from "./engine-fixtures.js";
test("two authenticated conversations never share a session, whatever the untrusted label says", async () => {
  const context = await setup("engine-tenant-session");
  const steven: Delivery = {
    ...delivery("tenant-session-a"),
    ...conversation({ conversationId: "6979524541" }),
    body: { prompt: "perform the task", session_key: "same-label" },
  };
  const miguel: Delivery = {
    ...delivery("tenant-session-b"),
    tenant_id: "Miguel",
    ...conversation({ conversationId: "-1003969325671" }),
    body: { prompt: "perform the task", session_key: "same-label" },
  };
  await context.engine.handleDelivery(steven);
  await context.engine.handleDelivery(miguel);
  assert.notEqual(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * La consola y las herramientas de ops publican SIN `origin`: hasta ahora eso significaba que no
 * había clave y cada entrega corría sin continuidad (243 publicaciones de consola en prod al
 * 2026-07-29, 0 con origen). La conversación es el actor autenticado, y el tenant es parte de
 * ella: dos tenants distintos por la misma superficie no se tocan.
 */
test("originless publishes are isolated per authenticated tenant", async () => {
  const context = await setup("engine-console-tenant");
  const steven = originless(delivery("console-tenant-a"), "console-steven");
  const pablo: Delivery = {
    ...originless(delivery("console-tenant-b"), "console-pablo"),
    tenant_id: "Pablo",
  };
  await context.engine.handleDelivery(steven);
  await context.engine.handleDelivery(pablo);
  assert.notEqual(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * Punto 4: la consola tiene que converger en UNA conversación por operador. El `session_id` de
 * un principal OIDC es el `sid` del login y cambia en cada re-login; si entrara en la clave, la
 * consola estrenaría sesión cada vez que Steven vuelve a entrar.
 */
test("console keeps one session per operator across re-login", async () => {
  const context = await setup("engine-console-relogin");
  await context.engine.handleDelivery(originless(delivery("console-login-a"), "sid-primer-login"));
  await context.engine.handleDelivery(originless(delivery("console-login-b"), "sid-segundo-login"));
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * El store fabrica `delivery:<id>:attempt:<n>` cuando el mensaje raíz no traía sesión
 * autenticada. Ese identificador es por ENTREGA: si entrara en la clave daría una sesión nativa
 * por entrega, que es exactamente el defecto que este cambio arregla.
 */
test("per-delivery synthetic session ids never fragment the conversation", async () => {
  const context = await setup("engine-ephemeral-session-id");
  await context.engine.handleDelivery(
    originless(delivery("ephemeral-a"), "delivery:11111111-1111-4111-8111-111111111111:attempt:1", "agent-output"),
  );
  await context.engine.handleDelivery(
    originless(delivery("ephemeral-b"), "delivery:22222222-2222-4222-8222-222222222222:attempt:1", "agent-output"),
  );
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * El tenant que separa es el del RECEPTOR, que sale de la configuración local del adaptador y no
 * viaja en la entrega. Nadie del otro lado del bus puede moverlo.
 */
test("recipient tenant scopes the session and is taken from local configuration", async () => {
  const steven = await setup("engine-recipient-tenant-steven", new ControlledRunner(), {
    ownTenantId: "Steven",
  });
  const miguel = await setup("engine-recipient-tenant-miguel", new ControlledRunner(), {
    ownTenantId: "Miguel",
  });
  const shared = { ...delivery("recipient-tenant"), ...conversation({ conversationId: "6979524541" }) };
  await steven.engine.handleDelivery(shared);
  await miguel.engine.handleDelivery(shared);
  assert.notEqual(sessionOf(steven.runner, 0), sessionOf(miguel.runner, 0));
});

/**
 * La reparación medida: en prod hay 6 conversaciones de Telegram cuyas filas viejas no traen
 * `bridge_tenant` y las nuevas sí. Mismo chat, mismo bot, mismo alias, dos sesiones nativas.
 * El tenant del PUENTE no identifica ninguna conversación y no puede partirla.
 */
test("bridge tenant no longer splits one conversation in two", async () => {
  const context = await setup("engine-bridge-tenant-merge");
  const legacy: Delivery = {
    ...delivery("bridge-tenant-legacy"),
    ...conversation({ conversationId: "6979524541", metadata: {} }),
  };
  const current: Delivery = {
    ...delivery("bridge-tenant-current"),
    ...conversation({
      conversationId: "6979524541",
      metadata: { bridge_alias: "zeus", bridge_tenant: "Steven", chat_type: "private" },
    }),
  };
  await context.engine.handleDelivery(legacy);
  await context.engine.handleDelivery(current);
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * Antes esto exigía que una `agent.response`
 * cross-tenant cayera en la MISMA sesión nativa que el pedido del humano. Esa igualdad era
 * exactamente el bloqueo: el candado de sesión es FIFO estricta, así que la respuesta de la
 * delegación se quedaba con la sesión de la conversación durante toda su corrida y el dueño
 * esperaba detrás (114 min de mediana en midas). Ahora el tráfico agente-a-agente vive en un
 * carril propio y los dos pueden correr a la vez.
 *
 * Lo que este test SIGUE protegiendo, que es la razón por la que existe: el alcance de la
 * sesión lo gobierna la CONVERSACIÓN y no el tenant de la entrega. Dos respuestas que llegan de
 * tenants distintos sobre la misma conversación tienen que compartir sesión; lo único que cambió
 * es cuál.
 *
 * 2026-07-29: antes ese alcance salía de `origin.metadata.bridge_tenant`, con caída a
 * `delivery.tenant_id` cuando faltaba — o sea que el mismo chat se partía en dos según quién
 * publicara. Ahora ni uno ni otro entran en la clave y la igualdad de abajo vale por
 * construcción, no por coincidencia.
 */
test("the conversation, not the delivery tenant, keeps cross-tenant agent responses in one shared agent-lane session", async () => {
  const context = await setup("engine-agent-response-session");
  const root = delivery("agent-response-session-a");
  const trustedOrigin = {
    ...root.origin!,
    metadata: { bridge_alias: "jarvis", bridge_tenant: "Steven" },
  };
  const rootContext = root.authenticated_context!;
  const request: Delivery = {
    ...root,
    actor_alias: "jarvis",
    recipient_alias: "jarvis",
    origin: trustedOrigin,
    authenticated_context: {
      ...rootContext,
      origin: trustedOrigin,
    },
  };
  const response: Delivery = {
    ...delivery("agent-response-session-b"),
    tenant_id: "Pablo",
    actor_alias: "seneca",
    recipient_alias: "jarvis",
    body: { type: "agent.response", text: "seneca result" },
    origin: trustedOrigin,
    authenticated_context: {
      ...rootContext,
      origin: trustedOrigin,
    },
  };
  const otherTenantResponse: Delivery = {
    ...response,
    delivery_id: "agent-response-session-c",
    event_id: "agent-response-session-c",
    tenant_id: "Miguel",
  };

  await context.engine.handleDelivery(request);
  await context.engine.handleDelivery(response);
  await context.engine.handleDelivery(otherTenantResponse);
  const humanSession = context.runner.requests[0]?.args.at(-1);
  const agentSession = context.runner.requests[1]?.args.at(-1);
  const otherTenantSession = context.runner.requests[2]?.args.at(-1);
  assert.ok(humanSession && agentSession && otherTenantSession);
  // El carril de agentes NO es la sesión del humano: eso es lo que le devuelve disponibilidad
  // al dueño sin cancelar la tarea larga.
  assert.notEqual(agentSession, humanSession);
  // Pero sigue siendo UNA sola sesión por conversación, derivada del bridge_tenant de
  // confianza: el tenant de la entrega no la parte en dos.
  assert.equal(otherTenantSession, agentSession);
  assert.match(context.runner.requests[1]?.stdin ?? "", /"message_type":"agent.response"/u);
  assert.match(context.runner.requests[1]?.stdin ?? "", /"sender_alias":"seneca"/u);
});

test("body session_key cannot select a different authenticated session", async () => {
  const context = await setup("engine-untrusted-session-key");
  const first: Delivery = {
    ...delivery("untrusted-session-a"),
    body: { prompt: "perform the task", session_key: "attacker-label-a" },
  };
  const second: Delivery = {
    ...delivery("untrusted-session-b"),
    body: { prompt: "perform the task", session_key: "attacker-label-b" },
  };
  await context.engine.handleDelivery(first);
  await context.engine.handleDelivery(second);
  assert.equal(context.runner.requests[0]?.args.at(-1), context.runner.requests[1]?.args.at(-1));
});

test("stale claim token neither executes nor acknowledges the current event", async () => {
  const context = await setup("engine-stale-claim");
  const current = delivery("stale-claim", 1, 1);
  await context.engine.handleDelivery(current);
  const terminal = context.store.pendingEvents().find((event) => event.phase === "done");
  assert.ok(terminal);
  assert.equal(await context.store.acknowledge({ ...terminal, claim_token: claimToken(1, 1) }), false);
  assert.equal(context.store.pendingEvents().some((event) => event.event_id === terminal.event_id), true);

  await context.engine.handleDelivery(delivery("stale-claim", 1, 1, claimToken(1, 1)));
  assert.equal(context.runner.calls, 1);
});

/**
 * Este test exigía lo contrario desde 44521b6:
 * "attempts 1 and 2 must have different session IDs". 
 * pasaba a 1499 de 5312 entregas (28,2 %): el reintento le contestaba a la persona desde una
 * sesión sin memoria — el síntoma "se duplican las instancias" — y peor, esa sesión acumulaba un
 * intercambio real que la sesión principal nunca vería.
 *
 * Lo que 44521b6 quería frenar (el transcript creciendo en cada reintento, socrates ~300K →
 * 1,8MB en 4 intentos) es el caso "el intento anterior murió a mitad de ejecución", y ese lo
 * fenced `DurableStore.accept` desde e5c909e: un intento mayor sólo se acepta si el anterior
 * terminó en `failed` con `retryable: true` — ver el test "crash recovery marks started work
 * ambiguous and blocks automatic redelivery", que comprueba que ni siquiera se ejecuta.
 */
test("a retry of the same conversation keeps the same session", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-session-retry-v3", runner);
  const attempt1 = delivery("session-retry-v3", 1, 1);
  const attempt2 = delivery("session-retry-v3", 1, 2);

  await context.engine.handleDelivery(attempt1);
  assert.equal(runner.calls, 1, "el primer intento tiene que ejecutar");

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery(attempt2);
  assert.equal(runner.calls, 2, "el reintento tiene que ejecutar");

  assert.equal(
    sessionOf(context.runner, 0),
    sessionOf(context.runner, 1),
    "un reintento de la misma conversación no puede estrenar sesión: le contestaría a la persona sin memoria",
  );
});

/**
 * El mensaje SIGUIENTE de la misma persona, en el mismo chat, también cae en esa sesión — que es
 * lo que el dueño percibe como "es el mismo, se acuerda". Antes no: el reintento se iba a una
 * sesión propia y el mensaje siguiente volvía a la de attempt 1, así que las dos divergían.
 */
test("the next message of the same conversation lands in the session the retry used", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-session-retry-continuity", runner);
  const chat = conversation({ conversationId: "6979524541" });
  await context.engine.handleDelivery({ ...delivery("retry-continuity-a", 1, 1), ...chat });
  runner.stdout = SUCCESS;
  await context.engine.handleDelivery({ ...delivery("retry-continuity-a", 1, 2), ...chat });
  await context.engine.handleDelivery({ ...delivery("retry-continuity-b", 1, 1), ...chat });

  assert.equal(runner.calls, 3);
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 2));
  assert.equal(sessionOf(context.runner, 1), sessionOf(context.runner, 2));
});

