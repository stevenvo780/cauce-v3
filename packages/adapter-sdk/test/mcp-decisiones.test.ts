import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadCliRuntimeConfig } from "../src/bin/config.js";
import { decisionesRoute, type DecisionesForwarder } from "../src/sdk/mcp-emission/decisiones.js";
import { EmissionRuntime } from "../src/sdk/mcp-emission/runtime.js";

interface Forwarded { method: string; path: string; body?: unknown }

async function fixture(forwarder: DecisionesForwarder | undefined) {
  const directory = await mkdtemp(join(tmpdir(), "cauce-decisiones-mcp-"));
  const runtime = new EmissionRuntime(directory, "instance-decisiones", async () => ({}), forwarder);
  await runtime.listen();
  const client = new Client({ name: "decisiones-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [
    fileURLToPath(new URL("../src/bin/cauce-decisiones-mcp.js", import.meta.url)), runtime.socketPath,
  ], stderr: "pipe" }));
  return { client, close: async () => { await client.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const [first] = result.content as { text: string }[];
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

test("the stdio decisions server maps each tool to one fixed service route through the alias socket", async () => {
  const seen: Forwarded[] = [];
  const f = await fixture(async (method, path, body) => {
    seen.push({ method, path, ...(body === undefined ? {} : { body }) });
    return path === "/v1/decidir" && (body as { plantilla?: string }).plantilla === "caida"
      ? { status: 503, body: { error: "jev_sobrecargado", respaldo: { decision: "llm" } } }
      : { status: 200, body: { ok: true } };
  });
  try {
    assert.deepEqual((await f.client.listTools()).tools.map((tool) => tool.name).sort(), ["decidir", "decidir_plantilla", "listar_plantillas"]);
    assert.equal((await f.client.callTool({ name: "listar_plantillas", arguments: {} })).isError, undefined);
    await f.client.callTool({ name: "listar_plantillas", arguments: { plantilla: "ruteo_alias" } });
    await f.client.callTool({ name: "decidir_plantilla", arguments: { plantilla: "ruteo_alias", state: { pedido: { texto: "x" } }, restringir: { destino: ["zeus"] } } });
    await f.client.callTool({ name: "decidir", arguments: { state: "x", questions: { a: { type: "noul", instructions: "x" } }, umbrales: { confianza: 0.7 } } });
    assert.deepEqual(seen, [
      { method: "GET", path: "/v1/plantillas" },
      { method: "GET", path: "/v1/plantillas/ruteo_alias" },
      { method: "POST", path: "/v1/decidir", body: { plantilla: "ruteo_alias", state: { pedido: { texto: "x" } }, opciones: { restringir: { destino: ["zeus"] } } } },
      { method: "POST", path: "/v1/decidir", body: { state: "x", questions: { a: { type: "noul", instructions: "x" } }, umbrales: { confianza: 0.7 } } },
    ]);
    const failed = await f.client.callTool({ name: "decidir_plantilla", arguments: { plantilla: "caida", state: {} } });
    assert.equal(failed.isError, true);
    assert.deepEqual(payload(failed), { error: "jev_sobrecargado", respaldo: { decision: "llm" } });
    const forged = await f.client.callTool({ name: "decidir", arguments: { state: "x", questions: {}, tenant_id: "Steven" } });
    assert.equal(forged.isError, true);
    assert.equal(seen.length, 5);
  } finally { await f.close(); }
});

test("an adapter without a decisions service answers so the model falls back to its own reasoning", async () => {
  const f = await fixture(undefined);
  try {
    const result = await f.client.callTool({ name: "decidir", arguments: { state: "x", questions: {} } });
    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "decisiones_no_configurado");
  } finally { await f.close(); }
});

test("an unreachable service is a typed tool error, never a crash of the MCP server", async () => {
  const f = await fixture(async () => { throw new Error("ECONNREFUSED"); });
  try {
    const result = await f.client.callTool({ name: "listar_plantillas", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "decisiones_inalcanzable");
    assert.equal((await f.client.listTools()).tools.length, 3);
  } finally { await f.close(); }
});

test("only three operations and safe template ids can become a route", () => {
  assert.throws(() => decisionesRoute("borrar", {}), /desconocida/u);
  assert.throws(() => decisionesRoute("listar_plantillas", { plantilla: "a/../b" }), /id de plantilla/u);
  assert.throws(() => decisionesRoute("decidir", null), /objeto/u);
  assert.deepEqual(decisionesRoute("listar_plantillas", {}), { method: "GET", path: "/v1/plantillas" });
});

test("CAUCE_DECISIONES_URL and decisiones_url accept only a bare https origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "cauce-decisiones-config-"));
  try {
    const write = async (url: string) => {
      const path = resolve(root, "adapters.json");
      await writeFile(path, JSON.stringify({ aliases: { zeus: {
        tenant: "Steven", instance_id: "zeus-1", state_directory: "state", relay_url: "wss://gateway.example/v3/adapter", decisiones_url: url,
      } } }));
      return loadCliRuntimeConfig("claude", ["--config", path, "--alias", "zeus"]);
    };
    assert.equal((await write("https://100.64.0.11:8447")).decisionesUrl, "https://100.64.0.11:8447");
    for (const bad of ["http://100.64.0.11:8447", "https://user:pw@host:8447", "https://host:8447/v1", "https://host:8447?x=1"]) {
      await assert.rejects(write(bad), /https origin/u, bad);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
