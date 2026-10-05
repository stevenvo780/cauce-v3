import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EmissionRuntime, forwardEmission, socketExchange } from "../src/sdk/mcp-emission/runtime.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { deliveryHarnesses } from "../src/bin/shared.js";
import { claudeDefinition } from "../src/harnesses/claude.js";
import { humanHarnessSelector } from "../src/sdk/engine/delivery-context.js";
import type { DeliveryEvent } from "../src/sdk/types.js";
import { humanDelivery, HUMAN_A, HUMAN_B } from "./human-initiator-session-isolation.fixtures.js";
import { waitUntil } from "./client-fixtures.js";
import { socketFixture, CHILD } from "./mcp-emission-concurrent-socket.fixtures.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

test("two canonical runner children deposit through separate MCP sockets", async () => {
  const f = await socketFixture();
  try {
    const a = f.begin("A", "000000000901"); const b = f.begin("B", "000000000902");
    const endpoints = await Promise.all([f.runtime.endpointFor(a.turn), f.runtime.endpointFor(b.turn)]);
    assert.notEqual(endpoints[0], endpoints[1]);
    const ra = f.child("A", endpoints[0]); const rb = f.child("B", endpoints[1]);
    const identities = await Promise.all([f.ready("A"), f.ready("B")]);
    assert.deepEqual(identities.map((identity) => identity.endpoint), endpoints);
    for (const endpoint of endpoints) assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
    await Promise.all([f.go("A"), f.go("B")]);
    for (const result of await Promise.all([ra, rb])) {
      assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout), { isError: false });
    }
    assert.deepEqual([a.turn.output?.reply, b.turn.output?.reply], ["own-A", "own-B"]);
    const saved = await Promise.all([a, b].map(async ({ delivery }) => JSON.parse(
      await readFile(join(f.directory, "mcp-emission", `${delivery.delivery_id}.1.json`), "utf8")) as { output: { reply: string } }));
    assert.deepEqual(saved.map((state) => state.output.reply), ["own-A", "own-B"]);
    for (const turn of [a.turn, b.turn]) { f.runtime.end(turn); await f.runtime.releaseEndpoint(turn); }
    for (const endpoint of endpoints) await assert.rejects(stat(endpoint), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("cancelled endpoint never becomes the surviving turn or an outside root", async () => {
  const f = await socketFixture();
  try {
    const a = f.begin("A", "000000000903"); const b = f.begin("B", "000000000904");
    const pa = await f.runtime.endpointFor(a.turn); const pb = await f.runtime.endpointFor(b.turn);
    const ra = f.child("A", pa); const rb = f.child("B", pb);
    await Promise.all([f.ready("A"), f.ready("B")]);
    a.controller.abort(); await f.runtime.releaseEndpoint(a.turn);
    await Promise.all([f.go("A"), f.go("B")]);
    assert.deepEqual(JSON.parse((await ra).stdout), { isError: true });
    assert.deepEqual(JSON.parse((await rb).stdout), { isError: false });
    assert.equal(a.turn.output, undefined); assert.equal(b.turn.output?.reply, "own-B");
    await assert.rejects(forwardEmission(pa, "cauce_send", { to: "zeus", body: "stale" }));
  } finally { await f.close(); }
});

test("global TTY remains ambiguous while two bound children succeed", async () => {
  const f = await socketFixture();
  try {
    f.begin("A", "000000000905"); f.begin("B", "000000000906");
    const legacy = f.child("TTY"); await f.ready("TTY"); await f.go("TTY");
    assert.deepEqual(JSON.parse((await legacy).stdout), { isError: true });
  } finally { await f.close(); }
});

test("wrong, malformed and revoked scopes cannot deposit into a bound turn", async () => {
  const f = await socketFixture();
  let current = true;
  try {
    const a = f.begin("A", "000000000907", () => current); const b = f.begin("B", "000000000908");
    const endpoint = await f.runtime.endpointFor(a.turn);
    for (const token of [b.turn.token, "unknown", null, {}, 17]) {
      const result = await socketExchange(endpoint, "/tool", "POST", { name: "cauce_reply", turn_token: token,
        arguments: { reply: "wrong", status: "done", retryable: false } });
      assert.equal(result.isError, true);
    }
    current = false;
    assert.equal((await forwardEmission(endpoint, "cauce_reply", { reply: "revoked", status: "done", retryable: false }, a.turn.token)).isError, true);
    assert.equal((await forwardEmission(endpoint, "cauce_queue", {}, a.turn.token)).isError, true);
    assert.equal(a.turn.output, undefined); assert.equal(b.turn.output, undefined);
    f.runtime.end(a.turn); await f.runtime.releaseEndpoint(a.turn);
    await assert.rejects(f.runtime.endpointFor(a.turn));
  } finally { await f.close(); }
});

test("runner rejects forged env override including undefined without weakening secret filtering", async () => {
  const runner = new SpawnCommandRunner();
  const request = { command: process.execPath, args: ["--eval", "process.exit(99)"], harness: "fake" as const,
    stdin: "", timeoutMs: 1000, signal: new AbortController().signal };
  for (const value of ["/tmp/forged", undefined]) {
    await assert.rejects(runner.run({ ...request, env: { CAUCE_EMISSION_SOCKET_PATH: value } as unknown as Record<string, string> }),
      (error: unknown) => error instanceof ProcessExecutionError && error.code === "EMISSION_ENDPOINT_OVERRIDE");
  }
  for (const value of ["", "relative", " /tmp/endpoint", "/tmp/endpoint\0"])
    await assert.rejects(runner.run({ ...request, emissionSocketPath: value }),
      (error: unknown) => error instanceof ProcessExecutionError && error.code === "INVALID_EMISSION_ENDPOINT");
  await assert.rejects(runner.run({ ...request, env: { CAUCE_TURN_TOKEN: "never-sent" } }),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === "SECRET_ENV_REJECTED");
});

test("outside root revalidates a delivery that starts while queued", async () => {
  const held = gate(); const entered = gate(); let publications = 0;
  const f = await socketFixture(async (_method, path) => {
    if (path === "/v3/agent/queue") { entered.open(); await held.promise; }
    if (path === "/v3/messages") publications++;
    return {};
  }, { tenant: "Steven", room: "grp.steven", alias: "argos" });
  try {
    const runtime = f.runtime;
    runtime.trackDeliveries(() => 0); runtime.trackPromptOrigin(async () => "human");
    const blocking = runtime.call("cauce_queue", {}); await entered.promise;
    const pending = runtime.call("cauce_send", { to: "zeus", body: "queued" });
    f.begin("A", "000000000909"); held.open(); await blocking;
    assert.equal((await pending).isError, true); assert.equal(publications, 0);
  } finally { held.open(); await f.close(); }
});

test("outside root revalidates a delivery that starts during origin lookup", async () => {
  const entered = gate(); const held = gate(); let publications = 0;
  const f = await socketFixture(async () => { publications++; return {}; }, { tenant: "Steven", room: "grp.steven", alias: "argos" });
  try {
    const runtime = f.runtime;
    runtime.trackDeliveries(() => 0);
    runtime.trackPromptOrigin(async () => { entered.open(); await held.promise; return "human"; });
    const pending = runtime.call("cauce_send", { to: "zeus", body: "origin-wait" });
    await entered.promise; f.begin("A", "000000000910"); held.open();
    assert.equal((await pending).isError, true); assert.equal(publications, 0);
  } finally { held.open(); await f.close(); }
});


test("Engine selects isolated human harnesses and canonical runner MCP replies reach distinct ACKs", async () => {
  const f = await socketFixture();
  const store = await DurableStore.open(f.directory);
  let manualCalls = 0;
  const adapters = deliveryHarnesses({ definition: claudeDefinition, store,
    runner: { run: async () => { manualCalls++; throw new Error("Manual TTY must not execute a human delivery"); } },
    commandOverride: { command: process.execPath, prefixArgs: ["--input-type=module", "-e", CHILD, f.runtime.socketPath, f.directory], baseArgs: [] },
    sessionNamespace: "argos", sharedSession: { alias: "argos", harness: "claude", stateDirectory: f.directory },
  }, f.runner);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({ store, emission: f.runtime, harness: adapters.harness,
    harnessForDelivery: humanHarnessSelector(adapters.harness, adapters.humanHarness), ownTenantId: "Steven",
    executionIntentMode: "local-test-only", publish: async (event) => { events.push(event); } });
  const tasks: Promise<void>[] = [];
  try {
    await engine.activateEpoch(1);
    const inputs = [humanDelivery(HUMAN_A), humanDelivery(HUMAN_B)].map((input, index) => ({ ...input,
      ack_deadline_at: new Date(Date.now() + 60_000).toISOString(), body: { text: `socket-case-${index === 0 ? "A" : "B"}` } }));
    tasks.push(...inputs.map(async (input) => { await engine.handleDelivery(input); }));
    await waitUntil(() => existsSync(join(f.directory, "A.ready")) && existsSync(join(f.directory, "B.ready")));
    const identities = await Promise.all([f.ready("A"), f.ready("B")]);
    assert.notEqual(identities[0].endpoint, identities[1].endpoint);
    assert.ok(identities.every((identity) => identity.endpoint !== null));
    await Promise.all([f.go("A"), f.go("B")]);
    await Promise.all(tasks);
    const done = inputs.map((input) => events.find((event) => event.delivery_id === input.delivery_id && event.phase === "done"));
    assert.deepEqual(done.map((event) => event?.output?.reply), ["own-A", "own-B"]);
    for (const [index, event] of done.entries()) {
      assert.equal(event?.claim_token, inputs[index]?.claim_token);
      assert.equal(event?.epoch, 1);
    }
    assert.equal(manualCalls, 0);
    for (const identity of identities) {
      assert.ok(identity.endpoint); await assert.rejects(stat(identity.endpoint), { code: "ENOENT" });
    }
  } finally {
    engine.stop(); await Promise.allSettled(tasks); await f.close();
  }
});

test("endpoint creation coalesces and close during creation leaves no socket", async () => {
  const f = await socketFixture();
  try {
    const a = f.begin("A", "000000000911");
    const [first, second] = await Promise.all([f.runtime.endpointFor(a.turn), f.runtime.endpointFor(a.turn)]);
    assert.equal(first, second);
    const b = f.begin("B", "000000000912");
    const pending = f.runtime.endpointFor(b.turn); f.runtime.end(b.turn);
    await assert.rejects(pending);
    await f.runtime.close(); await assert.rejects(stat(first), { code: "ENOENT" });
  } finally { await f.close(); }
});


test("canonical runner cancellation reaps only child A while child B still deposits", async () => {
  const f = await socketFixture();
  const stopA = new AbortController();
  try {
    const a = f.begin("A", "000000000913"); const b = f.begin("B", "000000000914");
    const pa = await f.runtime.endpointFor(a.turn); const pb = await f.runtime.endpointFor(b.turn);
    const ra = f.child("A", pa, stopA.signal); const rb = f.child("B", pb);
    const [identityA, identityB] = await Promise.all([f.ready("A"), f.ready("B")]);
    a.controller.abort(); stopA.abort();
    const cancelled = await ra;
    assert.equal(cancelled.cancelled, true);
    for (const pid of [identityA.pid, identityA.mcpPid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    process.kill(identityB.pid, 0); process.kill(identityB.mcpPid, 0);
    await f.go("B");
    assert.equal((await rb).exitCode, 0);
    assert.equal(a.turn.output, undefined); assert.equal(b.turn.output?.reply, "own-B");
  } finally { stopA.abort(); await f.close(); }
});

test("an unknown endpoint never falls back to the unique legacy turn", async () => {
  const f = await socketFixture();
  try {
    const a = f.begin("A", "000000000915");
    const child = f.child("unknown", join(f.directory, "unknown.sock"));
    await f.ready("unknown"); await f.go("unknown");
    assert.deepEqual(JSON.parse((await child).stdout), { isError: true });
    assert.equal(a.turn.output, undefined);
  } finally { await f.close(); }
});

test("legacy global scope cannot attach a manual shim to the remaining headless turn", async () => {
  const f = await socketFixture();
  try {
    const a = f.begin("A", "000000000916"); const b = f.begin("B", "000000000917");
    await Promise.all([f.runtime.endpointFor(a.turn), f.runtime.endpointFor(b.turn)]);
    f.runtime.end(a.turn); await f.runtime.releaseEndpoint(a.turn);
    const scope = await socketExchange(f.runtime.socketPath, "/scope", "GET");
    assert.equal(scope.turn_token, null);
    const legacy = f.child("TTY"); await f.ready("TTY"); await f.go("TTY");
    assert.deepEqual(JSON.parse((await legacy).stdout), { isError: true });
    assert.equal(b.turn.output, undefined);
  } finally { await f.close(); }
});

test("a unique unbound legacy turn still accepts its manual MCP child", async () => {
  const f = await socketFixture();
  try {
    const legacy = f.begin("legacy", "000000000918");
    const child = f.child("TTY"); await f.ready("TTY"); await f.go("TTY");
    assert.deepEqual(JSON.parse((await child).stdout), { isError: false });
    assert.equal(legacy.turn.output?.reply, "own-TTY");
  } finally { await f.close(); }
});


test("an oversized bound endpoint fails closed without exposing its turn globally", async () => {
  const f = await socketFixture();
  const directory = join(f.directory, "x".repeat(85 - Buffer.byteLength(f.directory) - 1));
  await mkdir(directory);
  const runtime = new EmissionRuntime(directory, "own-path-limit", async () => ({}));
  try {
    await runtime.listen();
    const input = f.begin("A", "000000000919");
    const turn = runtime.begin({ delivery: input.delivery, signal: input.controller.signal,
      context: input.turn.options.context, isCurrent: () => true });
    turn.activate();
    await assert.rejects(runtime.endpointFor(turn), /Emission endpoint exceeds Unix socket path limit/u);
    assert.equal((await socketExchange(runtime.socketPath, "/scope", "GET")).turn_token, null);
    assert.equal(turn.output, undefined);
  } finally { await runtime.close(); await f.close(); }
});


test("runtime shutdown rejects an outside root already waiting for its origin", async () => {
  const entered = gate(); const held = gate(); let publications = 0;
  const f = await socketFixture(async () => { publications++; return {}; }, { tenant: "Steven", room: "grp.steven", alias: "argos" });
  try {
    f.runtime.trackDeliveries(() => 0);
    f.runtime.trackPromptOrigin(async () => { entered.open(); await held.promise; return "human"; });
    const pending = f.runtime.call("cauce_send", { to: "zeus", body: "shutdown-wait" });
    await entered.promise; await f.runtime.close(); held.open();
    assert.equal((await pending).isError, true); assert.equal(publications, 0);
    assert.throws(() => f.begin("closed", "000000000920"), /Emission runtime is closing/u);
  } finally { held.open(); await f.close(); }
});


test("a human cannot downgrade into a shared harness when scoped emission is unavailable", async () => {
  const f = await socketFixture();
  const store = await DurableStore.open(f.directory);
  let invocations = 0;
  const adapters = deliveryHarnesses({ definition: claudeDefinition, store,
    runner: { run: async () => { invocations++; throw new Error("Shared harness must not run"); } },
    sharedSession: { alias: "argos", harness: "claude", stateDirectory: f.directory },
  }, f.runner);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({ store, emission: f.runtime, harness: adapters.harness,
    harnessForDelivery: () => adapters.harness, executionIntentMode: "local-test-only",
    publish: async (event) => { events.push(event); } });
  try {
    await engine.activateEpoch(1);
    await engine.handleDelivery(humanDelivery());
    assert.equal(invocations, 0);
    assert.equal(events.some((event) => event.phase === "started" || event.execution_started === true), false);
    assert.equal(events.find((event) => event.phase === "failed")?.error?.code, "UNSUPPORTED_HUMAN_EMISSION_SCOPE");
    assert.equal((await socketExchange(f.runtime.socketPath, "/scope", "GET")).turn_token, null);
  } finally { engine.stop(); await f.close(); }
});
