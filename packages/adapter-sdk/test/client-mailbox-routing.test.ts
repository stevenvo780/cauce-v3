import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import { protocolPrompt, textoFijoDelSobre } from "../src/harnesses/shared/prompt.js";
import { routingTargetsFromDelivery } from "../src/sdk/engine/delivery-context.js";
import { helloCapabilityStrings } from "../src/sdk/client.js";
import { AdapterError } from "../src/sdk/errors.js";
import { validateDeliveryOutput, validateStructuredOutput } from "../src/sdk/output-parser.js";
import { EmissionRuntime } from "../src/sdk/mcp-emission/runtime.js";
import type { EmissionGateway } from "../src/sdk/mcp-emission/tools.js";
import type { Delivery, StructuredOutput } from "../src/sdk/types.js";
import { renewableDelivery } from "./client-fixtures.js";

const MAILBOX = { label: "Steven laptop", available: true } as const;
const TARGETS = [
  { tenant_id: "Steven", alias: "zeus", online: true },
  { tenant_id: "Steven", alias: "mbx-0123456789abcdef0123456789abcdef0123456789abcdef", online: false, client_mailbox: MAILBOX },
  { tenant_id: "Steven", alias: "mbx-fedcba9876543210fedcba9876543210fedcba9876543210", online: false },
  { tenant_id: "Steven", alias: "mbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", online: false,
    client_mailbox: { label: "x", available: false } },
  { tenant_id: "Steven", alias: "dup", online: false, client_mailbox: MAILBOX },
  { tenant_id: "Isa", alias: "dup", online: true },
] as const;
const EMPTY = { reply: null, messages: [], status: "done", retryable: false, artifacts: [] } as const;
const MAILBOX_ALIAS = "mbx-0123456789abcdef0123456789abcdef0123456789abcdef";

function check(messages: { to: string; body: string }[], routingTargets: unknown = TARGETS): StructuredOutput {
  const output = validateStructuredOutput({ ...EMPTY, messages });
  return validateDeliveryOutput(output, {
    messageType: "request", selfAlias: "jarvis", routingTargets: routingTargets as never,
  });
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof AdapterError && error.code === expected;
}

test("parser accepts a direct message to an offline available client mailbox", () => {
  const output = check([{ to: MAILBOX_ALIAS, body: "dejá esto para cuando vuelvas" }]);
  assert.equal(output.messages[0]?.to, MAILBOX_ALIAS);
});

test("parser still rejects offline targets without a valid available mailbox marker", () => {
  assert.throws(() => check([{ to: "mbx-fedcba9876543210fedcba9876543210fedcba9876543210", body: "hi" }]), code("OFFLINE_DELEGATION_TARGET"));
  assert.throws(() => check([{ to: "mbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", body: "hi" }]), code("OFFLINE_DELEGATION_TARGET"));
  const forged = [{ tenant_id: "Steven", alias: "fake", online: false, client_mailbox: "available" }];
  assert.throws(() => check([{ to: "fake", body: "hi" }], forged), code("OFFLINE_DELEGATION_TARGET"));
  const truthy = [{ tenant_id: "Steven", alias: "fake", online: false, client_mailbox: { label: "x", available: "true" } }];
  assert.throws(() => check([{ to: "fake", body: "hi" }], truthy), code("OFFLINE_DELEGATION_TARGET"));
});

test("parser denies an ambiguous alias even when one candidate is an available mailbox", () => {
  assert.throws(() => check([{ to: "dup", body: "hi" }]), code("AMBIGUOUS_DELEGATION_TARGET"));
});

test("@all counts only online peers and never mailboxes", () => {
  const mailboxOnly = [
    { tenant_id: "Steven", alias: MAILBOX_ALIAS, online: false, client_mailbox: MAILBOX },
  ];
  assert.throws(() => check([{ to: "@all", body: "everyone" }], mailboxOnly), code("NO_ONLINE_TARGETS"));
  // With one online peer the aggregate budget is sized for exactly one expansion, not one per mailbox.
  assert.doesNotThrow(() => check([{ to: "@all", body: "everyone" }], [...mailboxOnly, TARGETS[0]]));
});

test("projection preserves a valid client_mailbox and drops malformed metadata", () => {
  const delivery = { routing_targets: [
    ...TARGETS,
    { tenant_id: "Steven", alias: "bad1", online: false, client_mailbox: { label: "", available: true } },
    { tenant_id: "Steven", alias: "bad2", online: false, client_mailbox: { label: "x" } },
    { tenant_id: "Steven", alias: "bad3", online: false, client_mailbox: [MAILBOX] },
  ] } as unknown as Delivery;
  const projected = routingTargetsFromDelivery(delivery);
  const byAlias = new Map(projected.map((target) => [`${target.tenant_id}/${target.alias}`, target]));
  assert.deepEqual(byAlias.get(`Steven/${MAILBOX_ALIAS}`)?.client_mailbox, MAILBOX);
  assert.equal(byAlias.get("Steven/zeus")?.client_mailbox, undefined);
  for (const alias of ["mbx-fedcba9876543210fedcba9876543210fedcba9876543210", "mbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bad1", "bad2", "bad3"]) {
    assert.equal("client_mailbox" in (byAlias.get(`Steven/${alias}`) ?? {}), false, alias);
  }
});

test("every harness advertises client_mailbox_v1 and teaches the mailbox rules in the shared prompt", () => {
  for (const definition of Object.values(HARNESS_DEFINITIONS)) {
    assert.equal(definition.capabilities.client_mailbox_v1, true, definition.id);
    assert.ok(helloCapabilityStrings(definition.capabilities).includes("client_mailbox_v1"), definition.id);
  }
  const prompt = textoFijoDelSobre(undefined);
  assert.match(prompt, /client_mailbox/u);
  assert.match(prompt, /explicitly asks for a direct message/u);
  assert.match(prompt, /offline durable mailbox/u);
  assert.match(prompt, /never claim it was read or run, never use "@all"/u);
});

async function runtimeWith(gateway: EmissionGateway) {
  const directory = await mkdtemp(join(tmpdir(), "cauce-mailbox-"));
  const runtime = new EmissionRuntime(directory, "instance-mailbox", gateway, undefined,
    { tenant: "Steven", room: "grp.steven", alias: "argos" });
  runtime.trackDeliveries(() => 0);
  runtime.trackPromptOrigin(async () => "human");
  return { runtime, close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

const textOf = (result: { content: { text: string }[] }): string => result.content.map((item) => item.text).join("");

test("cauce_send inside a delivery stages a mailbox target but refuses unmarked offline and ambiguous ones", async () => {
  const calls: string[] = [];
  const f = await runtimeWith(async (method, path) => { calls.push(`${method} ${path}`); return {}; });
  const delivery: Delivery = { ...renewableDelivery("mbx", "000000000931", Date.now() + 60_000), recipient_alias: "argos" };
  try {
    const turn = f.runtime.begin({ delivery, signal: new AbortController().signal, isCurrent: () => true,
      context: { self_alias: "argos", sender_alias: "kant", tenant_id: "Steven", room_id: "grp.steven",
        channel: "telegram", agent_message: false, message_type: "request", routing_targets: [...TARGETS] as never } });
    turn.activate();
    for (const to of ["mbx-fedcba9876543210fedcba9876543210fedcba9876543210", "mbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "dup"]) {
      assert.equal((await f.runtime.call("cauce_send", { to, body: "hi" })).isError, true, to);
    }
    const ok = await f.runtime.call("cauce_send", { to: MAILBOX_ALIAS, body: "para el buzón" });
    assert.equal(ok.isError, undefined, textOf(ok));
    assert.deepEqual(turn.status().messages, 1);
    assert.deepEqual(calls, []);
  } finally { await f.close(); }
});

test("outside a delivery POST confirms enqueueing and GET reports mailbox storage", async () => {
  const stored = { label: "Cronos", state: "stored" };
  const f = await runtimeWith(async (method) => method === "POST"
    ? { message_id: "11111111-1111-4111-8111-111111111111", delivery_ids: ["d1"], duplicate: false }
    : { id: "11111111-1111-4111-8111-111111111111", deliveries: [{ alias: MAILBOX_ALIAS, status: "done", attempt: 0, client_mailbox: stored }] });
  try {
    const sent = await f.runtime.call("cauce_send", { to: MAILBOX_ALIAS, body: "hola" });
    assert.equal(sent.isError, undefined, textOf(sent));
    const receipt = JSON.parse(textOf(sent)) as Record<string, unknown>;
    assert.equal(receipt.almacenado_en_buzon, undefined);
    assert.match(String(receipt.nota), /Encolado/u);
    const read = JSON.parse(textOf(await f.runtime.call("cauce_result", {
      message_id: "11111111-1111-4111-8111-111111111111",
    }))) as { entregas: { status: string; reply: unknown; buzon?: boolean }[]; terminado: boolean; nota_buzon: string };
    assert.deepEqual(read.entregas, [{ alias: MAILBOX_ALIAS, status: "stored", reply: null, buzon: true }]);
    assert.equal(read.terminado, true);
    assert.match(read.nota_buzon, /No implica que alguien lo haya leído ni ejecutado/u);
  } finally { await f.close(); }
});

test("mailbox authorization uses the exact marker schema and requires offline status", () => {
  for (const marker of [
    { available: true }, { label: "", available: true },
    { label: "x".repeat(129), available: true }, { label: 1, available: true },
    { ...MAILBOX, extra: true }, null, [],
  ]) {
    const target = { tenant_id: "Steven", alias: "fake", online: false, client_mailbox: marker };
    assert.throws(() => check([{ to: "fake", body: "hi" }], [target]), code("OFFLINE_DELEGATION_TARGET"));
    const projected = routingTargetsFromDelivery({ routing_targets: [target] } as unknown as Delivery);
    assert.equal(projected[0]?.client_mailbox, undefined);
  }
  const onlineMailbox = { tenant_id: "Steven", alias: "fake", online: true, client_mailbox: MAILBOX };
  assert.throws(() => check([{ to: "fake", body: "hi" }], [onlineMailbox]), code("OFFLINE_DELEGATION_TARGET"));
  assert.deepEqual(routingTargetsFromDelivery({ routing_targets: [onlineMailbox] } as unknown as Delivery), []);
  assert.doesNotThrow(() => check([{ to: "fake", body: "hi" }], [
    { ...onlineMailbox, online: false, client_mailbox: { label: "x".repeat(128), available: true } },
  ]));
});

test("mailbox metadata fits the existing fleet envelope budget", () => {
  const targets = ["argos", "atlas", "gaia", "hegel", "heraclito", "iza", "janus", "jarvis", "kant", "kratos", "salva", "socrates"]
    .map(alias => ({ tenant_id: "Steven", alias, online: true }));
  const prompt = protocolPrompt("Revisa el estado del gateway y decime si hay entregas muertas.", undefined, {
    self_alias: "zeus", sender_alias: "argos", tenant_id: "Steven", room_id: "grp.steven", channel: "telegram",
    agent_message: true, message_type: "agent.message", self_role: "R".repeat(1200),
    routing_targets: [...targets, { tenant_id: "Steven", alias: MAILBOX_ALIAS, online: false,
      client_mailbox: { label: "x".repeat(128), available: true } }],
  });
  assert.ok(prompt.length <= 10_500, `Mailbox envelope has ${String(prompt.length)} characters`);
});
