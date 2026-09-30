import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AdapterClient } from "../src/sdk/client.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter, fakeDefinition } from "../src/harnesses/index.js";
import { EmissionRuntime } from "../src/sdk/mcp-emission/runtime.js";
import { EmissionGatewayError, type EmissionGateway } from "../src/sdk/mcp-emission/tools.js";
import type { CommandRunner, Delivery } from "../src/sdk/types.js";
import type { PromptOrigin } from "../src/shared-session/prompt-origin.js";
import { FakeConnection, ScriptedConnector, renewableDelivery, waitUntil } from "./client-fixtures.js";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = { tenant: "Steven", room: "grp.steven", alias: "argos" };
interface GatewayCall { readonly method: string; readonly path: string; readonly body?: unknown }

function recordingGateway(answer: (call: GatewayCall) => unknown = () => ({
  message_id: MESSAGE_ID, delivery_ids: ["22222222-2222-4222-8222-222222222222"], duplicate: false,
})): { calls: GatewayCall[]; gateway: EmissionGateway } {
  const calls: GatewayCall[] = [];
  return { calls, gateway: async (method, path, body) => {
    const call = { method, path, ...(body === undefined ? {} : { body }) };
    calls.push(call);
    return answer(call);
  } };
}

async function runtimeWith(
  gateway: EmissionGateway, inFlight: number | null = 0, origin: PromptOrigin | "unreadable" | null = "human",
) {
  const directory = await mkdtemp(join(tmpdir(), "cauce-mcp-root-"));
  const runtime = new EmissionRuntime(directory, "instance-root", gateway, undefined, IDENTITY);
  if (inFlight !== null) runtime.trackDeliveries(() => inFlight);
  if (origin !== null) runtime.trackPromptOrigin(async () => (origin === "unreadable" ? undefined : origin));
  return { runtime, close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

function begin(runtime: EmissionRuntime, signal = new AbortController().signal) {
  const delivery: Delivery = { ...renewableDelivery("root", "000000000911", Date.now() + 60_000), recipient_alias: "argos" };
  return runtime.begin({ delivery, signal, isCurrent: () => true,
    context: { self_alias: "argos", sender_alias: "kant", tenant_id: "Steven", room_id: "grp.steven",
      channel: "telegram", agent_message: false, message_type: "request",
      routing_targets: [{ tenant_id: "Steven", alias: "zeus", online: true }] },
  });
}

const textOf = (result: { content: { text: string }[] }): string => result.content.map((item) => item.text).join("");

test("with no turn and no delivery, cauce_send publishes exactly one root in the own tenant and room", async () => {
  const { calls, gateway } = recordingGateway();
  const f = await runtimeWith(gateway);
  try {
    const result = await f.runtime.call("cauce_send", { to: "zeus", body: "revisá el disco" });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v3/messages");
    const body = call.body as Record<string, unknown>;
    assert.deepEqual({ ...body, idempotency_key: undefined }, {
      room_id: "grp.steven", recipients: [{ tenant_id: "Steven", alias: "zeus" }],
      body: { text: "revisá el disco" }, lane: "interactive", idempotency_key: undefined,
    });
    assert.match(String(body.idempotency_key), /^tui:[0-9a-f-]{36}$/u);
    assert.match(textOf(result), new RegExp(MESSAGE_ID, "u"));
    assert.match(textOf(result), /cauce_result/u);
  } finally { await f.close(); }
});

test("sending the same text again is a new message; only a retry of the same MCP call reuses its key", async () => {
  const { calls, gateway } = recordingGateway();
  const f = await runtimeWith(gateway);
  try {
    await f.runtime.call("cauce_send", { to: "zeus", body: "uno" });
    await f.runtime.call("cauce_send", { to: "zeus", body: "uno" });
    const retried = { turn: undefined, token: null, callId: "shim-1:7" };
    await f.runtime.call("cauce_send", { to: "zeus", body: "uno" }, retried);
    await f.runtime.call("cauce_send", { to: "zeus", body: "uno" }, retried);
    const keys = calls.map((call) => (call.body as { idempotency_key: string }).idempotency_key);
    assert.equal(keys.length, 4);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(keys[2], keys[3]);
    assert.notEqual(keys[2], keys[0]);
  } finally { await f.close(); }
});

test("a send the gateway reports as duplicate says so instead of claiming a new message", async () => {
  const { gateway } = recordingGateway(() => ({ message_id: MESSAGE_ID, delivery_ids: [], duplicate: true }));
  const f = await runtimeWith(gateway);
  try {
    const result = await f.runtime.call("cauce_send", { to: "zeus", body: "uno" });
    assert.match(textOf(result), /ya se había hecho/u);
    assert.doesNotMatch(textOf(result), /Enviado como mensaje nuevo/u);
    assert.match(textOf(result), new RegExp(MESSAGE_ID, "u"));
  } finally { await f.close(); }
});

test("only a prompt a person typed can send outside a delivery; a bus prompt, an unreadable log or no TUI refuse", async () => {
  for (const [origin, message] of [
    ["cauce", /pedido de Cauce/u], ["unreadable", /No pude confirmar/u], [null, /no tiene una terminal compartida/u],
  ] as const) {
    const { calls, gateway } = recordingGateway();
    const f = await runtimeWith(gateway, 0, origin);
    try {
      const result = await f.runtime.call("cauce_send", { to: "zeus", body: "hola" });
      assert.equal(result.isError, true, String(origin));
      assert.match(textOf(result), message);
      assert.deepEqual(calls, []);
    } finally { await f.close(); }
  }
});

test("a turn that exists but is not the unique active one never falls through to a root", async () => {
  const { calls, gateway } = recordingGateway();
  const f = await runtimeWith(gateway);
  try {
    const pending = begin(f.runtime);
    assert.equal((await f.runtime.call("cauce_send", { to: "zeus", body: "antes de activar" })).isError, true);
    const abort = new AbortController();
    const closed = begin(f.runtime, abort.signal);
    f.runtime.end(pending);
    closed.activate(); abort.abort();
    assert.equal((await f.runtime.call("cauce_send", { to: "zeus", body: "turno cerrado" })).isError, true);
    f.runtime.end(closed);
    assert.equal((await f.runtime.call("cauce_send", { to: "zeus", body: "token viejo" }, { turn: undefined, token: closed.token })).isError, true);
    assert.deepEqual(calls, []);
  } finally { await f.close(); }
});

test("a delivery in flight in the engine, or no engine to ask, blocks the root", async () => {
  for (const inFlight of [1, null]) {
    const { calls, gateway } = recordingGateway();
    const f = await runtimeWith(gateway, inFlight);
    try {
      const result = await f.runtime.call("cauce_send", { to: "zeus", body: "hola" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), inFlight === 1
        ? /^Hay una entrega de Cauce en curso en este adaptador; no se envió nada\. Reintentá cauce_send cuando termine\.$/u
        : /no tiene una terminal compartida/u);
      assert.doesNotMatch(textOf(result), /wait for a Cauce delivery/u);
      assert.deepEqual(calls, []);
    } finally { await f.close(); }
  }
});

test("@all, @human, itself, lists and invalid aliases are refused before the gateway", async () => {
  const { calls, gateway } = recordingGateway();
  const f = await runtimeWith(gateway);
  try {
    for (const to of ["@all", "@human", "argos", "zeus,kant", "zeus kant", "Not An Alias", " "]) {
      assert.equal((await f.runtime.call("cauce_send", { to, body: "hola" })).isError, true, to);
    }
    assert.deepEqual(calls, []);
  } finally { await f.close(); }
});

test("the open-roots limit becomes an error that lists what the alias is waiting on", async () => {
  const { gateway } = recordingGateway(() => {
    throw new EmissionGatewayError("Gateway HTTP 409: agent_root_limit", 409, {
      error: "agent_root_limit", limit: 8,
      open_roots: [{ message_id: MESSAGE_ID, recipients: [{ tenant_id: "Steven", alias: "zeus", status: "started" }] }],
    });
  });
  const f = await runtimeWith(gateway);
  try {
    const result = await f.runtime.call("cauce_send", { to: "kant", body: "otra más" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Ya tenés 8 mensajes abiertos; esperá a que terminen \(cauce_result\)/u);
    assert.match(textOf(result), new RegExp(`${MESSAGE_ID} -> zeus \\(started\\)`, "u"));
  } finally { await f.close(); }
});

test("cauce_result reads the message with and without a turn", async () => {
  const { calls, gateway } = recordingGateway(() => ({
    id: MESSAGE_ID, deliveries: [{ alias: "zeus", status: "done", reply: "disco al 40%" }],
  }));
  const f = await runtimeWith(gateway, 1);
  try {
    const bare = await f.runtime.call("cauce_result", { message_id: MESSAGE_ID });
    assert.equal(bare.isError, undefined, textOf(bare));
    assert.deepEqual(JSON.parse(textOf(bare)), {
      message_id: MESSAGE_ID, terminado: true, entregas: [{ alias: "zeus", status: "done", reply: "disco al 40%" }],
    });
    begin(f.runtime).activate();
    assert.equal((await f.runtime.call("cauce_result", { message_id: MESSAGE_ID })).isError, undefined);
    assert.equal((await f.runtime.call("cauce_result", { message_id: "no-es-uuid" })).isError, true);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), Array(2).fill(`GET /v3/messages/${MESSAGE_ID}`));
  } finally { await f.close(); }
});

test("cauce_result keeps a root unfinished while its chain still runs", async () => {
  const { gateway } = recordingGateway(() => ({
    id: MESSAGE_ID, chain_open: true, deliveries: [{ alias: "zeus", status: "done", reply: "provisional" }],
  }));
  const f = await runtimeWith(gateway);
  try {
    const result = JSON.parse(textOf(await f.runtime.call("cauce_result", { message_id: MESSAGE_ID }))) as Record<string, unknown>;
    assert.equal(result.terminado, false);
    assert.match(String(result.cadena), /sigue trabajando/u);
  } finally { await f.close(); }
});

test("the TUI sees cauce_result and a truthful cauce_send through the MCP shim, and the shim publishes the root", async () => {
  const { calls, gateway } = recordingGateway();
  const f = await runtimeWith(gateway);
  await f.runtime.listen();
  const client = new Client({ name: "root-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [
    fileURLToPath(new URL("../src/bin/cauce-mcp.js", import.meta.url)), f.runtime.socketPath,
  ], stderr: "pipe" }));
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((tool) => tool.name === "cauce_result"));
    assert.match(tools.find((tool) => tool.name === "cauce_send")?.description ?? "", /no delivery in flight[\s\S]*cauce_result/u);
    assert.match(tools.find((tool) => tool.name === "cauce_send")?.description ?? "", /typed by a person/u);
    for (let index = 0; index < 2; index += 1) {
      const result = await client.callTool({ name: "cauce_send", arguments: { to: "zeus", body: "desde la TUI" } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }
    const keys = calls.map((call) => (call.body as { idempotency_key: string }).idempotency_key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1], "two tool calls with the same text are two messages");
  } finally { await client.close(); await f.close(); }
});

test("the engine reports its deliveries in flight to the emission runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cauce-mcp-engine-"));
  const runtime = new EmissionRuntime(directory, "instance-engine", async () => ({}), undefined, IDENTITY);
  const probe: { count?: () => number } = {};
  const tracked = (): number => (probe.count === undefined ? -1 : probe.count());
  const track = runtime.trackDeliveries.bind(runtime);
  runtime.trackDeliveries = (count) => { probe.count = count; track(count); };
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  try {
    const store = await DurableStore.open(directory);
    const connection = new FakeConnection();
    const runner: CommandRunner = { run: async () => {
      started = true; await held;
      return { stdout: JSON.stringify({ reply: "ok", messages: [], notify: [], status: "done", retryable: false, artifacts: [] }),
        stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
    } };
    const adapter = new AdapterClient({ config: { tenantId: "Steven", alias: "argos", instanceId: "instance-engine", stateDirectory: directory, heartbeatMs: 10_000 },
      store, connector: new ScriptedConnector(connection), harness: new HarnessAdapter({ definition: fakeDefinition, store, runner }), emission: runtime,
    });
    running = adapter.run(stop.signal);
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    assert.equal(tracked(), 0);
    connection.push(renewableDelivery("engine", "000000000921", Date.now() + 30_000));
    await waitUntil(() => started);
    assert.equal(tracked(), 1);
    release();
    await waitUntil(() => connection.sent.some((frame) => frame.type === "ack" && frame.status === "done"));
    await waitUntil(() => tracked() === 0);
  } finally {
    release(); stop.abort(); await running; await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});
