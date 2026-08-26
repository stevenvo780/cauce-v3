import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { HarnessAdapter, fakeDefinition, openClawDefinition } from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type {
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
} from "../src/sdk/types.js";

/**
 * De qué conversación salió cada sesión, escrito al lado del `native_id`.
 *
 * El defecto que arregla: la clave de sesión es un sha256, o sea irreversible, y el valor
 * guardaba sólo `{native_id, initialized}`. Un alias openclaw con 14 conversaciones las mostraba
 * todas iguales —"sin origen"— y `cauce <alias>` abría una cualquiera mientras el cartel
 * afirmaba que era la misma que el bus. Esa afirmación no se podía comprobar; ahora sí.
 *
 * Estas pruebas van por el camino REAL (`AdapterEngine.handleDelivery` → `HarnessAdapter` →
 * `DurableStore`), no llamando a la función privada: lo que se fija es lo que termina en disco.
 */

const root = resolve(".test-state");

const SUCCESS = JSON.stringify({
  reply: "listo",
  messages: [],
  status: "done",
  retryable: false,
  artifacts: [],
});

class OkRunner implements CommandRunner {
  async run(): Promise<CommandRunResult> {
    return { stdout: SUCCESS, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
  }
}

async function storeFor(name: string): Promise<DurableStore> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

function base(id: string): Omit<Delivery, "origin" | "authenticated_context"> {
  const pad = id.padEnd(12, "0").slice(0, 12);
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
    recipient_alias: "jarvis",
    body: { prompt: "hola", timeout_ms: 60_000 },
  };
}

/** Lo que manda el puente de Telegram: DM privado del dueño. */
function telegramDelivery(id: string): Delivery {
  const origin = () => ({
    adapter: "telegram",
    channel: "telegram",
    conversation_id: "8981434475",
    external_message_id: `message-${id}`,
    relay: [],
    metadata: { chat_type: "private", bridge_alias: "jarvis", bridge_tenant: "Steven" },
  });
  return {
    ...base(id),
    origin: origin(),
    authenticated_context: { session_id: "tg:bot:chat:user", channel: "telegram", origin: origin() },
  };
}

/** Publicación de consola por mTLS: sin ruta de retorno, la conversación es el actor. */
function consoleDelivery(id: string): Delivery {
  return {
    ...base(id),
    authenticated_context: { session_id: "sid-de-login", channel: "console" },
  };
}

/** Una entrega sin canal: no hay conversación que nombrar, y no se inventa ninguna. */
function sinCanalDelivery(id: string): Delivery {
  return { ...base(id) };
}

async function corre(nombre: string, delivery: Delivery): Promise<Record<string, unknown>> {
  const store = await storeFor(nombre);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({
      definition: fakeDefinition,
      runner: new OkRunner(),
      store,
      sessionNamespace: "jarvis",
      fallbackSessionKey: "alias-default",
    }),
    publish: async (event: DeliveryEvent) => {
      events.push(event);
      if (event.claim_renewal === true) engine.confirmClaim(event.delivery_id, event.attempt, event.claim_token);
    },
    claimRenewalMs: 10_000,
    claimWatchdogMs: 60_000,
  });
  await engine.activateEpoch(1);
  await engine.handleDelivery(delivery);
  assert.equal(events.filter((event) => event.phase === "done").length, 1, "la entrega tiene que cerrar bien");
  const crudo = await readFile(resolve(root, nombre, "sessions.json"), "utf8");
  return (JSON.parse(crudo) as { sessions: Record<string, unknown> }).sessions;
}

test("un DM de Telegram queda etiquetado con su canal y su chat", async () => {
  const sesiones = await corre("origen-telegram", telegramDelivery("tg-1"));
  const claves = Object.keys(sesiones);
  assert.equal(claves.length, 1);
  assert.ok(claves[0]!.startsWith("fake:jarvis:auth-v3:"), `clave inesperada: ${claves[0]}`);
  assert.deepEqual((sesiones[claves[0]!] as Record<string, unknown>).origin, {
    adapter: "telegram",
    channel: "telegram",
    conversation_id: "8981434475",
  });
});

test("una publicación de consola se etiqueta como consola, no como Telegram", async () => {
  const sesiones = await corre("origen-consola", consoleDelivery("con-1"));
  const clave = Object.keys(sesiones)[0]!;
  assert.deepEqual((sesiones[clave] as Record<string, unknown>).origin, {
    adapter: "console",
    channel: "console",
    conversation_id: "operator:Steven:kant",
  });
});

test("sin canal no se inventa origen: la entrada queda con la forma vieja", async () => {
  const sesiones = await corre("origen-ausente", sinCanalDelivery("nada-1"));
  const clave = Object.keys(sesiones)[0]!;
  assert.equal(clave, "fake:jarvis:alias-default");
  assert.deepEqual(Object.keys(sesiones[clave] as Record<string, unknown>).sort(), ["initialized", "native_id"]);
});

test("OpenClaw mueve el pointer estable a la conversación humana real sin colapsar sesiones", async () => {
  const nombre = "openclaw-terminal-pointer";
  const store = await storeFor(nombre);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({
      definition: openClawDefinition,
      runner: new OkRunner(),
      store,
      sessionNamespace: "jarvis",
      fallbackSessionKey: "alias-default",
    }),
    publish: async (event: DeliveryEvent) => {
      events.push(event);
      if (event.claim_renewal === true) {
        engine.confirmClaim(event.delivery_id, event.attempt, event.claim_token);
      }
    },
    claimRenewalMs: 10_000,
    claimWatchdogMs: 60_000,
  });
  await engine.activateEpoch(1);

  await engine.handleDelivery(telegramDelivery("oc-tg"));
  const pointerKey = "openclaw:jarvis:shared:jarvis";
  const first = store.getSession(pointerKey);
  assert.ok(first);
  assert.deepEqual(first.origin, {
    adapter: "telegram", channel: "telegram", conversation_id: "8981434475",
  });

  await engine.handleDelivery(consoleDelivery("oc-console"));
  const second = store.getSession(pointerKey);
  assert.ok(second);
  assert.notEqual(second.native_id, first.native_id, "el pointer cambia de conversación nativa");
  assert.deepEqual(second.origin, {
    adapter: "console", channel: "console", conversation_id: "operator:Steven:kant",
  });
  const persisted = JSON.parse(
    await readFile(resolve(root, nombre, "sessions.json"), "utf8"),
  ) as { sessions: Record<string, unknown> };
  assert.equal(Object.keys(persisted.sessions).length, 3, "dos conversaciones más un pointer, sin colapsarlas");
  assert.equal(events.filter((event) => event.phase === "done").length, 2);
});
