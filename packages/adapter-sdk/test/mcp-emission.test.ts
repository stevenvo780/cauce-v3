import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AdapterClient } from "../src/sdk/client.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter, fakeDefinition } from "../src/harnesses/index.js";
import { EmissionRuntime, forwardEmission } from "../src/sdk/mcp-emission/runtime.js";
import type { EmissionGateway } from "../src/sdk/mcp-emission/tools.js";
import type { CommandRunner, Delivery, StructuredOutput } from "../src/sdk/types.js";
import { FakeConnection, ScriptedConnector, renewableDelivery, waitUntil } from "./client-fixtures.js";

const EMPTY: StructuredOutput = { reply: "ok", messages: [], notify: [], status: "done", retryable: false, artifacts: [] };

async function fixture(gateway: EmissionGateway = async () => ({ deliveries: [] })) {
  const directory = await mkdtemp(join(tmpdir(), "cauce-mcp-"));
  const runtime = new EmissionRuntime(directory, "instance-mcp", gateway);
  await runtime.listen();
  const client = new Client({ name: "emission-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [
    fileURLToPath(new URL("../src/bin/cauce-mcp.js", import.meta.url)), runtime.socketPath,
  ], stderr: "pipe" });
  await client.connect(transport);
  return { directory, runtime, client, close: async () => {
    await client.close(); await runtime.close(); await rm(directory, { recursive: true, force: true });
  } };
}

function active(runtime: EmissionRuntime, signal = new AbortController().signal) {
  const delivery: Delivery = { ...renewableDelivery("mcp", "000000000901", Date.now() + 60_000), recipient_alias: "argos" };
  const turn = runtime.begin({ delivery, signal, isCurrent: () => true,
    context: { self_alias: "argos", sender_alias: "kant", tenant_id: "Steven", room_id: "grp.steven",
      channel: "telegram", agent_message: false, message_type: "request", routing_targets: [
        { tenant_id: "Steven", alias: "zeus", online: true },
        { tenant_id: "Steven", alias: "offline", online: false },
        { tenant_id: "Miguel", alias: "foreign", online: true },
        { tenant_id: "Isa", alias: "foreign", online: true },
      ] },
  });
  turn.activate();
  return turn;
}

test("MCP schema errors preserve the live turn and deposits are durable and a reply cannot be replaced", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.client.listTools()).tools.length, 8);
    const abort = new AbortController();
    const turn = active(f.runtime, abort.signal);
    const invalid: [string, Record<string, unknown>][] = [
      ["cauce_artifact_add", { name: "../secret", uri: "/tmp/result" }],
      ["cauce_artifact_add", { name: "result", uri: "/tmp/result", media_type: "broken" }],
      ["cauce_artifact_add", { name: "result", uri: "/tmp/result", sha256: "no" }],
      ["cauce_notify", { to: "A person", kind: "alert", body: "hello" }],
      ["cauce_notify", { to: "steven_dm", kind: "unknown", body: "hello" }],
      ["cauce_send", { to: "offline", body: "hello" }],
      ["cauce_send", { to: "foreign", body: "hello" }],
      ["cauce_send", { to: "kant", body: "hello" }],
      ["cauce_progress", { text: "é".repeat(513) }],
      ["cauce_progress", { text: "bad\0progress" }],
      ["cauce_reply", { reply: "ok", status: "error", retryable: false }],
      ["cauce_reply", { reply: "ok", status: "done", retryable: true }],
      ["cauce_reply", { reply: "ok", status: "done", retryable: false, delivery_id: "forged" }],
      ["cauce_reply", { reply: null, status: "done", retryable: false }],
    ];
    for (const [name, args] of invalid) {
      const before = turn.status();
      const result = await f.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.deepEqual(turn.status(), before);
    }
    assert.equal((await f.client.callTool({ name: "cauce_reply", arguments: { reply: "preserved", status: "done", retryable: false } })).isError, undefined);
    assert.equal((await f.client.callTool({ name: "cauce_reply", arguments: { reply: "replace", status: "done", retryable: false } })).isError, true);
    const saved = JSON.parse(await readFile(join(f.directory, "mcp-emission", `${turn.options.delivery.delivery_id}.1.json`), "utf8")) as { output: StructuredOutput };
    assert.equal(saved.output.reply, "preserved");
    abort.abort();
    assert.equal((await f.client.callTool({ name: "cauce_send", arguments: { to: "zeus", body: "stale" } })).isError, true);
    assert.equal(turn.output?.messages.length, 0);
  } finally { await f.close(); }
});

test("failed replies withdraw staged delegations and preserve notifications", async () => {
  const f = await fixture();
  try {
    const turn = active(f.runtime);
    assert.equal((await f.client.callTool({ name: "cauce_send", arguments: { to: "zeus", body: "provisional task" } })).isError, undefined);
    assert.equal((await f.client.callTool({ name: "cauce_notify", arguments: { to: "steven_dm", kind: "alert", body: "task failed" } })).isError, undefined);
    const reply = await f.client.callTool({ name: "cauce_reply", arguments: { reply: "Task failed", status: "failed", retryable: false } });
    assert.equal(reply.isError, undefined);
    const output = turn.output;
    assert.ok(output);
    assert.equal(output.status, "failed");
    assert.equal(output.messages.length, 0);
    assert.equal(output.notify.length, 1);
    assert.match(JSON.stringify(reply), /delegations_discarded_on_failure/u);
  } finally { await f.close(); }
});

test("persistent MCP stdio client reaches engine ACK with damaged final text and falls back next turn", async () => {
  const gatewayCalls: { method: string; path: string; body?: unknown }[] = [];
  const f = await fixture(async (method, path, body) => { gatewayCalls.push({ method, path, body }); return { ok: true }; });
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const store = await DurableStore.open(f.directory);
    const connection = new FakeConnection();
    let count = 0;
    const runner: CommandRunner = { run: async (request) => {
      count += 1;
      if (count === 1) {
        assert.match(request.stdin, /cauce_reply/u);
        for (const [name, args] of [
          ["cauce_send", { to: "zeus", body: "inspect the requested file" }],
          ["cauce_artifact_add", { name: "result.txt", uri: "data:text/plain;base64,aGk=" }],
          ["cauce_notify", { to: "steven_dm", kind: "task_complete", body: "finished" }],
          ["cauce_progress", { text: "checking" }],
          ["cauce_queue", {}],
          ["cauce_retry", { delivery_id: "20000000-0000-4000-8000-000000000999" }],
          ["cauce_reply", { reply: "complete through MCP", status: "done", retryable: false }],
        ] as const) {
          const result = await f.client.callTool({ name, arguments: args });
          assert.equal(result.isError, undefined, JSON.stringify(result));
        }
      }
      return { stdout: count === 1 ? '{"reply">truncated' : JSON.stringify({ ...EMPTY, reply: "text fallback" }),
        stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
    } };
    const adapter = new AdapterClient({ config: { tenantId: "Steven", alias: "agent_mcp", instanceId: "instance-mcp", stateDirectory: f.directory, heartbeatMs: 10_000 },
      store, connector: new ScriptedConnector(connection), harness: new HarnessAdapter({ definition: fakeDefinition, store, runner }), emission: f.runtime,
    });
    running = adapter.run(stop.signal);
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = { ...renewableDelivery("mcp", "000000000902", Date.now() + 30_000), routing_targets: [{ tenant_id: "Miguel", alias: "zeus", online: true }] };
    connection.push(input);
    await waitUntil(() => connection.sent.some((frame) => frame.type === "ack" && frame.status === "done"));
    const ack = connection.sent.find((frame) => frame.type === "ack" && frame.status === "done");
    assert.ok(ack?.type === "ack");
    assert.equal(ack.claim_token, input.claim_token);
    assert.equal(ack.attempt, input.attempt);
    assert.deepEqual(ack.result?.output, { ...EMPTY, reply: "complete through MCP", messages: [{ to: "zeus", body: "inspect the requested file" }], notify: [{ to: "steven_dm", kind: "task_complete", body: "finished" }], artifacts: [{ name: "result.txt", uri: "data:text/plain;base64,aGk=" }] });
    assert.deepEqual(gatewayCalls[0]?.body, { text: "checking", attempt: input.attempt, claim_token: input.claim_token, epoch: input.epoch, instance_id: "instance-mcp" });
    const next = renewableDelivery("mcp", "000000000903", Date.now() + 30_000);
    connection.push(next);
    await waitUntil(() => connection.sent.some((frame) => frame.type === "ack" && frame.delivery_id === next.delivery_id && frame.status === "done"));
    const fallback = connection.sent.find((frame) => frame.type === "ack" && frame.delivery_id === next.delivery_id && frame.status === "done");
    assert.ok(fallback?.type === "ack");
    assert.deepEqual(fallback.result?.output, { ...EMPTY, reply: "text fallback" });
    assert.equal(count, 2);
  } finally { stop.abort(); await running; await f.close(); }
});

test("an existing shim survives adapter restart and refuses ambiguous concurrent turns", async () => {
  const f = await fixture();
  let next: EmissionRuntime | undefined;
  try {
    const abort = new AbortController();
    const first = active(f.runtime, abort.signal);
    const firstToken = first.token;
    const second = active(f.runtime);
    abort.abort();
    assert.equal((await f.client.callTool({ name: "cauce_reply", arguments: { reply: "wrong scope", status: "done", retryable: false } })).isError, true);
    f.runtime.end(first); f.runtime.end(second);
    await f.runtime.close();
    assert.equal((await f.client.callTool({ name: "cauce_status", arguments: {} })).isError, true);
    next = new EmissionRuntime(f.directory, "instance-restarted", async () => ({}));
    await next.listen();
    const restarted = active(next);
    assert.equal((await forwardEmission(next.socketPath, "cauce_reply", { reply: "stale prior turn", status: "done", retryable: false }, firstToken)).isError, true);
    assert.equal(restarted.output, undefined);
    assert.equal((await f.client.callTool({ name: "cauce_reply", arguments: { reply: "after restart", status: "done", retryable: false } })).isError, undefined);
  } finally { await next?.close(); await f.close(); }
});

test("a delayed HTTP body from a cancelled turn never deposits into the next turn", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const first = active(f.runtime, abort.signal);
    const body = JSON.stringify({ name: "cauce_reply", turn_token: first.token,
      arguments: { reply: "old turn", status: "done", retryable: false } });
    let finish: (() => void) | undefined;
    const response = new Promise<string>((resolve, reject) => {
      const outgoing = request({ socketPath: f.runtime.socketPath, path: "/tool", method: "POST" }, (incoming) => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { text += chunk; });
        incoming.on("end", () => { resolve(text); });
        incoming.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.write(body.slice(0, 30));
      finish = () => { outgoing.end(body.slice(30)); };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort(); f.runtime.end(first);
    const second = active(f.runtime);
    assert.ok(finish); finish();
    assert.equal((JSON.parse(await response) as { isError?: boolean }).isError, true);
    assert.equal(second.output, undefined);
  } finally { await f.close(); }
});
