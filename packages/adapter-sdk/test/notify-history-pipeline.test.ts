import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/shared/adapter.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { emissionGateway } from "../src/sdk/mcp-emission/gateway.js";
import { HttpEgressReceiptSource } from "../src/sdk/egress-receipt-source.js";
import { fakeDefinition } from "../src/harnesses/fake.js";
import { ControlledRunner, delivery, originless } from "./engine-fixtures.js";
import { wireReceipt, scope, incidentId } from "./notify-history-fixtures.js";

for (const mode of ["ok", "unavailable", "foreign"] as const) {
  test(`engine HTTP durable restart harness pipeline: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "notify-pipeline-"));
    const token = join(directory, "test-token"); await writeFile(token, "fixture-token", { mode: 0o600 });
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, "Bearer fixture-token");
      const url = new URL(req.url ?? "", "http://contract.test");
      assert.equal(url.pathname, "/v3/agent/egress");
      assert.deepEqual([...url.searchParams.keys()], ["delivery_ids"]);
      assert.equal(url.searchParams.get("delivery_ids"), incidentId);
      res.setHeader("content-type", "application/json");
      if (mode === "unavailable") { res.writeHead(404).end('{"error":"unavailable"}'); return; }
      res.end(JSON.stringify({ requested: [incidentId], items: [wireReceipt({
        source_delivery_id: mode === "foreign" ? "00000000-0000-4000-8000-000000000099" : incidentId,
      })] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    let store = await DurableStore.open(directory, { maxInlineTerminalRecords: 1 });
    try {
      await store.activateEpoch(1);
      for (const id of [incidentId, "later-terminal"]) {
        const input = originless(delivery(id), "generated-session");
        const accepted = await store.acceptAndEnqueue(input, new Date().toISOString()); assert.ok(accepted.event);
        await store.acknowledge(accepted.event);
        const terminal = await store.transitionAndEnqueue(id, "done", new Date().toISOString(), {
          output: { reply: null, messages: [], artifacts: [], status: "done", retryable: false,
            notify: id === incidentId ? [{ to: "steven_dm", kind: "alert", body: "Originless durable notice" }] : [] },
        });
        await store.acknowledge(terminal.event);
      }
      store.close(); store = await DurableStore.open(directory);
      assert.equal(store.getDelivery(incidentId)?.origin, undefined);
      const runner = new ControlledRunner();
      const source = new HttpEgressReceiptSource(emissionGateway({
        tenant: "Steven", alias: "argos", room: "grp.steven", instanceId: "test-instance", stateDirectory: directory,
        relayUrl: `ws://127.0.0.1:${String(address.port)}/v3/ws`, environment: "test",
        heartbeatMs: 1000, defaultTimeoutMs: 5000, developmentIdentity: false, bearerTokenFile: token,
      }), { tenant_id: "Steven", alias: "argos" });
      const engine = new AdapterEngine({ store, harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
        ownTenantId: "Steven", executionIntentMode: "local-test-only", publish: async () => undefined,
        egressReceipts: source,
      });
      const input = delivery(`human-${mode}`);
      await engine.handleDelivery({ ...input, authenticated_context: { session_id: "human-thread", channel: "telegram",
        origin: { adapter: scope.adapter, channel: scope.channel, conversation_id: scope.conversation_id,
          relay: [], metadata: { reply_to: { message_id: "2703", is_fleet_bot: true } } } } });
      assert.equal(calls, 1); assert.equal(runner.calls, 1);
      const prompt = runner.requests[0]?.stdin ?? "";
      assert.ok(prompt.includes("NOTIFICATION HISTORY DATA"));
      assert.equal(prompt.includes("Originless durable notice"), mode === "ok");
      assert.ok(prompt.includes(mode === "ok" ? '"status":"sent"' : '"source":"unavailable"'));
      assert.deepEqual(store.getDelivery(input.delivery_id)?.output?.notify, []);
    } finally {
      store.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
