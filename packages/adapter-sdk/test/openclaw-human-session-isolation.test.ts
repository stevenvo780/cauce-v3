import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from "@cauce/protocol";
import { helloCapabilityStrings } from "../src/sdk/client.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { canonicalOpenClawTerminalKey } from "../src/sdk/durable-store/session-file.js";
import {
  CapturingOpenClawCliRunner,
  createDeliveryEngine,
  createOpenClawHarnesses,
  freshOpenClawState,
  humanDelivery,
  legacyBodyDelivery,
  openOpenClawApiFixture,
  runDeliveries,
} from "./openclaw-human-session-isolation.fixtures.js";

const HUMAN_A = "11111111-1111-4111-8111-111111111111";
const HUMAN_B = "22222222-2222-4222-8222-222222222222";
const LEGACY_POINTER = "openclaw:argos:shared:argos";

test("OpenClaw aísla tenant, conversación y receptor; A recupera su user API tras reiniciar sin mover el pointer legacy", async () => {
  const state = await freshOpenClawState("api-scope");
  const api = await openOpenClawApiFixture();
  const store = await DurableStore.open(join(state, "store"));
  await store.setSession(LEGACY_POINTER, { native_id: "legacy-terminal-native", initialized: true });
  try {
    const first = await runDeliveries({
      stateDirectory: state,
      endpoint: api.endpoint,
      store,
      ownTenantId: "Steven",
      deliveries: [
        humanDelivery({ id: "a1", humanId: HUMAN_A, tenantId: "Steven", conversationId: "same-chat", loginSessionId: "login-before" }),
        humanDelivery({ id: "b1", humanId: HUMAN_B, tenantId: "Miguel", conversationId: "same-chat" }),
        humanDelivery({ id: "a-other-chat", humanId: HUMAN_A, tenantId: "Steven", conversationId: "other-chat" }),
      ],
    });
    assert.ok(first.humanHarness, "OpenClaw debe disponer de runner aislado para el canal API oficial");
    assert.ok(helloCapabilityStrings(first.harness.definition.capabilities, true)
      .includes(HUMAN_MESSAGE_INITIATOR_CAPABILITY));
    assert.equal(first.events.filter((event) => event.phase === "done").length, 3);
    const [userA1, userB1, userOtherConversation] = api.requests.map((request) => request.user);
    for (const user of [userA1, userB1, userOtherConversation]) assert.equal(typeof user, "string");
    assert.notEqual(userA1, userB1, "UUID humano distinto separa el scope OpenClaw");
    assert.notEqual(userA1, userOtherConversation, "conversación distinta separa el scope OpenClaw");
    assert.deepEqual(api.requests.map((request) => request.model), [
      "openclaw/fixture", "openclaw/fixture", "openclaw/fixture",
    ]);
    assert.deepEqual(store.getSession(LEGACY_POINTER), { native_id: "legacy-terminal-native", initialized: true },
      "las conversaciones humanas no deben reemplazar el pointer legacy del terminal");

    const reopened = await DurableStore.open(join(state, "store"));
    const resumed = await runDeliveries({
      stateDirectory: state,
      endpoint: api.endpoint,
      store: reopened,
      ownTenantId: "Steven",
      deliveries: [humanDelivery({ id: "a2", humanId: HUMAN_A, tenantId: "Steven", conversationId: "same-chat", loginSessionId: "login-after" })],
    });
    assert.equal(resumed.events.filter((event) => event.phase === "done").length, 1);
    assert.equal(api.requests[3]?.user, userA1, "la misma sesión humana debe sobrevivir a la reapertura del store y a otro login");
    assert.equal(api.requests[3]?.model, "openclaw/fixture", "el iniciador no modifica el agente/modelo" );

    const otherRecipient = await runDeliveries({
      stateDirectory: state,
      endpoint: api.endpoint,
      store: reopened,
      ownTenantId: "OtherReceiver",
      recipientAlias: "athena",
      deliveries: [humanDelivery({ id: "a-other-recipient", humanId: HUMAN_A, tenantId: "Steven",
        conversationId: "same-chat", recipientAlias: "athena" })],
    });
    assert.equal(otherRecipient.events.filter((event) => event.phase === "done").length, 1);
    assert.notEqual(api.requests[4]?.user, userA1, "el tenant del receptor separa el namespace local");

    const otherAlias = await runDeliveries({
      stateDirectory: state,
      endpoint: api.endpoint,
      store: reopened,
      ownTenantId: "Steven",
      recipientAlias: "athena",
      deliveries: [humanDelivery({ id: "a-other-alias", humanId: HUMAN_A, tenantId: "Steven",
        conversationId: "same-chat", recipientAlias: "athena" })],
    });
    assert.equal(otherAlias.events.filter((event) => event.phase === "done").length, 1);
    assert.notEqual(api.requests[5]?.user, userA1, "un alias de receptor distinto no comparte sesiones");
    assert.notEqual(api.requests[4]?.user, api.requests[5]?.user,
      "el tenant del receptor también forma parte del aislamiento cuando el alias coincide");

    const otherInitiatorTenant = await runDeliveries({
      stateDirectory: state,
      endpoint: api.endpoint,
      store: reopened,
      ownTenantId: "Steven",
      deliveries: [humanDelivery({ id: "a-same-human-other-tenant", humanId: HUMAN_A,
        tenantId: "Miguel", conversationId: "same-chat", recipientAlias: "argos" })],
    });
    assert.equal(otherInitiatorTenant.events.filter((event) => event.phase === "done").length, 1);
    assert.notEqual(api.requests[6]?.user, userA1,
      "el mismo UUID humano y chat en otro tenant iniciador no debe reutilizar la sesión");
    assert.deepEqual(reopened.getSession(LEGACY_POINTER), { native_id: "legacy-terminal-native", initialized: true },
      "ninguna sesión humana debe publicar un pointer canónico, incluso bajo su namespace dedicado");
    assert.equal(reopened.getSession("openclaw:athena:shared:athena"), undefined,
      "el namespace humano de otro alias no puede crear su propio pointer terminal");
  } finally {
    await api.close();
  }
});

test("la reconciliación de terminal no adopta una sesión humana al arrancar", async () => {
  const state = await freshOpenClawState("human-not-terminal");
  const api = await openOpenClawApiFixture();
  try {
    const context = await createDeliveryEngine({ stateDirectory: state, endpoint: api.endpoint });
    await context.engine.handleDelivery(humanDelivery({ id: "human-only-terminal-check", humanId: HUMAN_A }));
    const persisted = await readFile(join(state, "store", "sessions.json"), "utf8");
    assert.match(persisted, /human-initiator-v1/u, "la sesión humana debe existir antes de probar la recuperación");

    const deferredStore = await DurableStore.open(join(state, "store"), { deferSessions: true });
    await deferredStore.reconcileCanonicalOpenClawTerminalSession("argos");
    const terminalKey = canonicalOpenClawTerminalKey("argos");
    assert.ok(terminalKey !== undefined);
    assert.equal(deferredStore.getSession(terminalKey), undefined,
      "el reconciliador de terminal no debe adoptar el único registro humano disponible");
  } finally {
    await api.close();
  }
});

test("body falsificado no concede identidad; IDs nulos o malformados fallan antes de iniciar OpenClaw", async () => {
  const state = await freshOpenClawState("untrusted-selector");
  const api = await openOpenClawApiFixture();
  try {
    const official = await createOpenClawHarnesses({ stateDirectory: state, endpoint: api.endpoint });
    assert.ok(official.humanHarness, "el transporte API oficial habilita la capacidad humana");
    assert.ok(helloCapabilityStrings(official.harness.definition.capabilities, true)
      .includes(HUMAN_MESSAGE_INITIATOR_CAPABILITY));

    const overridden = await createOpenClawHarnesses({
      stateDirectory: join(state, "override"),
      endpoint: api.endpoint,
      commandOverride: { command: "/bin/echo", baseArgs: ["not-the-openclaw-bridge"] },
    });
    assert.equal(overridden.humanHarness, undefined, "un comando arbitrario no es un transporte OpenClaw verificado");
    assert.equal(helloCapabilityStrings(overridden.harness.definition.capabilities, false)
      .includes(HUMAN_MESSAGE_INITIATOR_CAPABILITY), false);

    const nullInitiator = {
      ...humanDelivery({ id: "null-initiator" }),
      human_initiator: null,
    } as unknown as ReturnType<typeof humanDelivery>;
    const malformedInitiator = humanDelivery({ id: "malformed-initiator", humanId: "not-a-uuid" });
    const rejected = await runDeliveries({ stateDirectory: state, endpoint: api.endpoint,
      deliveries: [nullInitiator, malformedInitiator] });
    assert.equal(rejected.events.filter((event) => event.phase === "failed").length, 2);
    assert.equal(api.requests.length, 0, "la validación de identidad sucede antes de cualquier request API");

    const bodyOnly = legacyBodyDelivery("body-only", HUMAN_B);
    const legacy = await runDeliveries({ stateDirectory: state, endpoint: api.endpoint, deliveries: [bodyOnly] });
    assert.equal(legacy.events.filter((event) => event.phase === "done").length, 1);
    assert.equal(api.requests.length, 1);
    assert.notEqual(api.requests[0]?.user, HUMAN_B, "un campo del body no puede elegir el user nativo");
    const sessions = await readFile(join(state, "store", "sessions.json"), "utf8");
    assert.equal(sessions.includes("fixture-token"), false, "el bearer de prueba no se guarda en sesiones");
  } finally {
    await api.close();
  }
});

test("CLI usa sessionKey aislado y conserva el target del agente al reabrir el store", async () => {
  const state = await freshOpenClawState("cli-scope");
  const runner = new CapturingOpenClawCliRunner();
  const first = await createDeliveryEngine({ stateDirectory: state, runner });
  assert.ok(first.humanHarness, "el CLI oficial también requiere un harness humano dedicado");
  await first.engine.handleDelivery(humanDelivery({ id: "cli-a1", humanId: HUMAN_A }));
  await first.engine.handleDelivery(humanDelivery({ id: "cli-b1", humanId: HUMAN_B }));
  assert.equal(first.events.filter((event) => event.phase === "done").length, 2);
  const firstSession = runner.requests[0]?.sessionId;
  const secondSession = runner.requests[1]?.sessionId;
  assert.equal(typeof firstSession, "string");
  assert.equal(typeof secondSession, "string");
  assert.notEqual(firstSession, secondSession, "CLI separa los dos iniciadores del mismo alias");
  for (const invocation of runner.requests.slice(0, 2)) {
    assert.equal(invocation.harness, "openclaw");
    assert.equal(invocation.command, process.execPath);
    assert.ok(invocation.args.includes("--session-key"));
    assert.equal(invocation.sessionId, invocation.args[invocation.args.indexOf("--session-key") + 1]);
  }

  const reopened = await DurableStore.open(join(state, "store"));
  const resumed = await createDeliveryEngine({ stateDirectory: state, runner, store: reopened });
  assert.ok(resumed.humanHarness);
  await resumed.engine.handleDelivery(humanDelivery({ id: "cli-a2", humanId: HUMAN_A }));
  assert.equal(resumed.events.filter((event) => event.phase === "done").length, 1);
  assert.equal(runner.requests[2]?.sessionId, firstSession, "el CLI mantiene A tras reabrir el estado durable");
});

test("cancelar la petición HTTP de A no cancela el turno OpenClaw de B", async () => {
  const state = await freshOpenClawState("concurrent-cancel");
  const api = await openOpenClawApiFixture({ holdResponses: true });
  try {
    const context = await createDeliveryEngine({ stateDirectory: state, endpoint: api.endpoint });
    assert.ok(context.humanHarness, "el transporte API debe aislar cada conversación antes de ejecutar concurrentemente");
    const deliveryA = humanDelivery({ id: "cancel-a", humanId: HUMAN_A });
    const deliveryB = humanDelivery({ id: "keep-b", humanId: HUMAN_B });
    const runA = context.engine.handleDelivery(deliveryA);
    const runB = context.engine.handleDelivery(deliveryB);
    await api.waitForRequests(2);
    const requestA = api.requests.find((request) => String(request.content).includes("cancel-a"));
    const requestB = api.requests.find((request) => String(request.content).includes("keep-b"));
    assert.ok(requestA);
    assert.ok(requestB);
    assert.notEqual(requestA.user, requestB.user);

    await context.engine.cancel({ type: "cancel", delivery_id: deliveryA.delivery_id, epoch: 1 });
    await api.waitForDisconnect(requestA.user);
    api.respond(requestB.user);
    await Promise.all([runA, runB]);
    assert.equal(context.events.find((event) => event.delivery_id === deliveryA.delivery_id && event.phase === "failed")?.phase, "failed");
    assert.equal(context.events.find((event) => event.delivery_id === deliveryB.delivery_id && event.phase === "done")?.phase, "done");
  } finally {
    await api.close();
  }
});
