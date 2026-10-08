import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type { Delivery } from "../src/sdk/types.js";
import {
  CapturingOpenClawCliRunner, createDeliveryEngine, freshOpenClawState, humanDelivery,
} from "./openclaw-human-session-isolation.fixtures.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const LISTED = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const POINTER = "openclaw:argos:shared:argos";
const CANONICAL = "canonical-native-0001";
const FAKE_BRIDGE = fileURLToPath(new URL("../../test/fixtures/openclaw-transcript.mjs", import.meta.url));

function withoutInitiator(delivery: Delivery): Delivery {
  const { human_initiator: _initiator, ...rest } = delivery;
  void _initiator;
  return rest;
}

function telegram(id: string, chatId: string): Delivery {
  return { ...withoutInitiator(humanDelivery({ id })), actor_alias: "argos",
    body: { type: "telegram.message", text: `hola ${id}`, chat_type: chatId.startsWith("-") ? "supergroup" : "private" },
    authenticated_context: { session_id: `tg-${id}`, channel: "telegram",
      origin: { adapter: "telegram", channel: "telegram", conversation_id: chatId, relay: [], metadata: {} } } };
}

function agentMessage(id: string): Delivery {
  return { ...withoutInitiator(humanDelivery({ id })), body: { type: "agent.message", text: `encargo ${id}` },
    authenticated_context: { session_id: `adapter-${id}`, channel: "adapter" } };
}

const console_ = (id: string, humanId: string, tenantId = "Steven"): Delivery => ({
  ...humanDelivery({ id, humanId, tenantId }), authenticated_context: { session_id: `login-${id}`, channel: "console" } });

function useEnvironment(t: TestContext, environment: Readonly<Record<string, string>>): void {
  const previous = { owner: process.env.CAUCE_OWNER_HUMAN_ID, listed: process.env.CAUCE_SHARED_HUMAN_IDS };
  Reflect.deleteProperty(process.env, "CAUCE_OWNER_HUMAN_ID");
  Reflect.deleteProperty(process.env, "CAUCE_SHARED_HUMAN_IDS");
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of [["CAUCE_OWNER_HUMAN_ID", previous.owner], ["CAUCE_SHARED_HUMAN_IDS", previous.listed]] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
}

async function scenario(t: TestContext, name: string, environment: Readonly<Record<string, string>>) {
  useEnvironment(t, environment);
  const state = await freshOpenClawState(name);
  const store = await DurableStore.open(join(state, "store"));
  await store.setSession(POINTER, { native_id: CANONICAL, initialized: true });
  const runner = new CapturingOpenClawCliRunner();
  const context = await createDeliveryEngine({ stateDirectory: state, runner, store, ownTenantId: "Steven" });
  const session = async (delivery: Delivery): Promise<string | undefined> => {
    const before = runner.requests.length;
    await context.engine.handleDelivery(delivery);
    assert.equal(context.events.filter((event) => event.delivery_id === delivery.delivery_id && event.phase === "done").length, 1,
      `${delivery.delivery_id} debe terminar`);
    assert.equal(runner.requests.length, before + 1);
    return runner.requests[before]?.sessionId;
  };
  return { store, session };
}

test("OpenClaw: dueño y SHARED_HUMANS, por consola, human-mcp o DM de Telegram, hablan en la conversación que abre la web", async (t) => {
  const { store, session } = await scenario(t, "canonical", {
    CAUCE_OWNER_HUMAN_ID: OWNER, CAUCE_SHARED_HUMAN_IDS: `Miguel:${LISTED}` });
  assert.equal(await session(console_("owner-console", OWNER)), CANONICAL);
  assert.equal(await session(humanDelivery({ id: "listed-mcp", humanId: LISTED, tenantId: "Miguel" })), CANONICAL);
  assert.equal(await session(telegram("dm", "6979524541")), CANONICAL);
  const continuation = { ...humanDelivery({ id: "owner-chain", humanId: OWNER }),
    body: { type: "agent.response", text: "resultado de otro agente" } };
  assert.equal(await session(continuation), CANONICAL, "la continuación de su cadena vuelve a la misma conversación");

  const foreign = await session(console_("foreign", FOREIGN));
  const group = await session(telegram("group", "-1001234"));
  const agent = await session(agentMessage("agent"));
  for (const other of [foreign, group, agent]) assert.notEqual(other, CANONICAL);
  assert.deepEqual(store.getSession(POINTER), { native_id: CANONICAL, initialized: true },
    "un humano ajeno, un grupo o un agente no mueven la conversación que muestra la web");
});

test("control negativo: sin dueño ni SHARED_HUMANS el alias OpenClaw conserva el comportamiento anterior", async (t) => {
  const { store, session } = await scenario(t, "legacy", {});
  assert.notEqual(await session(console_("owner-console", OWNER)), CANONICAL, "sin dueño declarado la consola sigue aislada");
  const dm = await session(telegram("dm", "6979524541"));
  assert.notEqual(dm, CANONICAL);
  assert.equal(store.getSession(POINTER)?.native_id, dm, "sin la regla, el último turno humano del arnés principal mueve el puntero");
});

test("un dueño que pertenece a otro tenant no entra por su UUID: sólo el dueño del propio tenant o un tenant:uuid listado", async (t) => {
  const { session } = await scenario(t, "other-tenant", { CAUCE_OWNER_HUMAN_ID: OWNER });
  assert.notEqual(await session(console_("owner-uuid-other-tenant", OWNER, "Miguel")), CANONICAL);
  assert.notEqual(await session(humanDelivery({ id: "unlisted", humanId: LISTED, tenantId: "Miguel" })), CANONICAL);
});

test("alias OpenClaw nuevo: el primer turno del dueño crea la conversación canónica y el DM siguiente la retoma", async (t) => {
  useEnvironment(t, { CAUCE_OWNER_HUMAN_ID: OWNER });
  const state = await freshOpenClawState("fresh");
  const runner = new CapturingOpenClawCliRunner();
  const context = await createDeliveryEngine({ stateDirectory: state, runner, ownTenantId: "Steven" });
  await context.engine.handleDelivery(console_("first", OWNER));
  const minted = runner.requests[0]?.sessionId;
  assert.equal(typeof minted, "string");
  assert.deepEqual(context.store.getSession(POINTER), { native_id: minted, initialized: true });
  await context.engine.handleDelivery(telegram("next-dm", "6979524541"));
  assert.equal(runner.requests[1]?.sessionId, minted);
});

test("el ACK de un turno OpenClaw lleva native_session_id = la conversación que abre la web", async (t) => {
  useEnvironment(t, { CAUCE_OWNER_HUMAN_ID: OWNER });
  const state = await freshOpenClawState("witness");
  const previousHome = process.env.HOME;
  process.env.HOME = await realpath(state);
  t.after(() => { process.env.HOME = previousHome; });
  const store = await DurableStore.open(join(state, "store"));
  const context = await createDeliveryEngine({ stateDirectory: state, store, ownTenantId: "Steven",
    runner: new SpawnCommandRunner({ killGraceMs: 10, orphanPipeGraceMs: 100 }),
    commandOverride: { command: process.execPath, baseArgs: [FAKE_BRIDGE] } });
  for (const id of ["first", "second"]) await context.engine.handleDelivery(console_(id, OWNER));
  const done = context.events.filter((event) => event.phase === "done");
  assert.equal(done.length, 2);
  const canonical = store.getSession(POINTER)?.native_id;
  assert.equal(typeof canonical, "string");
  for (const event of done) {
    assert.equal(event.harness_consumption_v1?.harness_id, "openclaw");
    assert.equal(event.harness_consumption_v1.native_session_id, canonical);
  }
  assert.notEqual(done[0]?.harness_consumption_v1?.native_turn_id, done[1]?.harness_consumption_v1?.native_turn_id);
});
