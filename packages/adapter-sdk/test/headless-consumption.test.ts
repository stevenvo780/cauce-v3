import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { consumptionWitness, inputDigest } from "../src/shared-session/consumption.js";
import { validateStructuredOutput } from "../src/sdk/output-parser.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import { claudeDefinition, codexDefinition } from "../src/harnesses/index.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { deliveryHarnesses } from "../src/bin/shared.js";
import { humanHarnessSelector } from "../src/sdk/engine/delivery-context.js";
import { HUMAN_A, HUMAN_B, humanDelivery } from "./human-initiator-session-isolation.fixtures.js";
import type { DeliveryEvent, CommandRunRequest } from "../src/sdk/types.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/headless-transcript.mjs", import.meta.url));
const sidA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sidB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function setup(harness: "claude" | "codex") {
  const root = await mkdtemp(join(tmpdir(), "hc-"));
  const config = join(root, "config"); const workspace = join(root, "workspace");
  await mkdir(config, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const runner = new SpawnCommandRunner({ killGraceMs: 10, orphanPipeGraceMs: 100 });
  function request(sid: string, mode = "valid", resume = false): CommandRunRequest {
    return { command: process.execPath, args: [fixture, harness, sid, mode], harness,
      env: harness === "claude" ? { CLAUDE_CONFIG_DIR: config } : { CODEX_HOME: config }, cwd: workspace,
      stdin: `owned exact input ${randomUUID()}`, signal: new AbortController().signal, timeoutMs: 2_000,
      ...(harness === "claude" || resume ? { sessionId: sid } : {}), resumeSession: resume };
  }
  return { root, config, workspace, runner, request, clean: () => rm(root, { recursive: true, force: true }) };
}

for (const harness of ["claude", "codex"] as const) {
  test(`${harness} child transcript proves isolated A/B/A input and native turns`, async () => {
    const context = await setup(harness);
    try {
      const first = context.request(sidA); const a = await context.runner.run(first);
      const second = context.request(sidB); const b = await context.runner.run(second);
      const resumed = context.request(sidA, "valid", true); const again = await context.runner.run(resumed);
      for (const [request, result, sid] of [[first, a, sidA], [second, b, sidB], [resumed, again, sidA]] as const) {
        assert.equal(result.exitCode, 0); assert.ok(result.consumptionWitness);
        assert.equal(result.consumptionWitness.native_session_id, sid);
        assert.equal(result.consumptionWitness.input_sha256, inputDigest(request.stdin));
        assert.equal(result.consumptionWitness.harness_id, harness);
        assert.notEqual(result.consumptionWitness.native_turn_id, sid);
      }
      assert.notEqual(a.consumptionWitness?.native_turn_id, again.consumptionWitness?.native_turn_id);
      assert.notEqual(a.consumptionWitness?.input_sha256, b.consumptionWitness?.input_sha256);
    } finally { await context.clean(); }
  });

  for (const mode of ["wrong-sid", "wrong-input", "whitespace-input", "wrong-final", "wrong-parent", "incomplete",
    "no-file", "nonzero", "symlink", "hardlink", "partial", "unsafe-mode", "oversize"] as const) {
    test(`${harness} does not attest ${mode}`, async () => {
      const context = await setup(harness);
      try {
        const result = await context.runner.run(context.request(sidA, mode));
        assert.equal(result.exitCode, mode === "nonzero" ? 1 : 0, result.stderr);
        assert.equal(result.consumptionWitness, undefined);
      }
      finally { await context.clean(); }
    });
  }

  for (const mode of ["replay-turn", "replay-only", "replace-prefix", "replace-inode", "replace-directory", "replace-config"] as const) {
    test(`${harness} resume rejects ${mode}`, async () => {
      const context = await setup(harness);
      try {
        const first = context.request(sidA); assert.ok((await context.runner.run(first)).consumptionWitness);
        const next = { ...context.request(sidA, mode, true), stdin: first.stdin };
        const result = await context.runner.run(next); assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.consumptionWitness, undefined);
      } finally { await context.clean(); }
    });
  }

  test(`${harness} timed out or cancelled process never attests a persisted final`, async () => {
    const context = await setup(harness);
    try {
      const timeout = await context.runner.run({ ...context.request(sidA, "hang"), timeoutMs: 150 });
      assert.equal(timeout.timedOut, true); assert.equal(timeout.consumptionWitness, undefined);
      const stop = new AbortController(); const abort = setTimeout(() => { stop.abort(); }, 150);
      try {
        const cancelled = await context.runner.run({ ...context.request(sidB, "hang"), signal: stop.signal });
        assert.equal(cancelled.cancelled, true); assert.equal(cancelled.consumptionWitness, undefined);
      } finally { clearTimeout(abort); }
    } finally { await context.clean(); }
  });
}

for (const mode of ["wrong-workspace", "wrong-source"] as const) {
  test(`codex session_meta rejects ${mode}`, async () => {
    const context = await setup("codex");
    try {
      const result = await context.runner.run(context.request(sidA, mode)); assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.consumptionWitness, undefined);
    }
    finally { await context.clean(); }
  });
}

test("a native SID already present before an initial run is not adopted", async () => {
  const context = await setup("codex");
  try {
    assert.ok((await context.runner.run(context.request(sidA))).consumptionWitness);
    assert.equal((await context.runner.run(context.request(sidA))).consumptionWitness, undefined);
    assert.equal((await context.runner.run(context.request(sidB, "valid", true))).consumptionWitness, undefined);
  } finally { await context.clean(); }
});

test("MCP deposited output differing from canonical final does not attest consumption", async () => {
  const context = await setup("codex");
  try {
    const output = validateStructuredOutput({ reply: "different result" });
    assert.equal((await context.runner.run({ ...context.request(sidA), emissionOutput: () => output })).consumptionWitness, undefined);
  } finally { await context.clean(); }
});

test("a receipt uses the native transcript input identifier, not an SDK-generated turn", async () => {
  const context = await setup("claude");
  try {
    const request = context.request(sidA); const result = await context.runner.run(request);
    const file = join(context.config, "projects", context.workspace.replace(/\//gu, "-"), `${sidA}.jsonl`);
    const entries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { uuid: string });
    const input = entries[0]; assert.ok(input);
    assert.deepEqual(result.consumptionWitness, consumptionWitness("claude", sidA, input.uuid, request.stdin));
  } finally { await context.clean(); }
});

for (const harness of ["claude", "codex"] as const) {
  test(`${harness} dedicated human engine persists genuine child evidence for A/B/A`, async () => {
    const context = await setup(harness);
    try {
      const store = await DurableStore.open(join(context.root, "durable")); await store.activateEpoch(1);
      const calls: CommandRunRequest[] = []; const events: DeliveryEvent[] = []; let manualCalls = 0;
      const headless = { witnessesHarnessStart: true, run: async (request: CommandRunRequest) => {
        const owned = { ...request, cwd: context.workspace }; calls.push(owned); return context.runner.run(owned);
      } };
      const selected = deliveryHarnesses({ definition: harness === "claude" ? claudeDefinition : codexDefinition,
        store, runner: { run: async () => { manualCalls++; throw new Error("Manual lane reached"); } },
        sessionNamespace: "isolated-test-alias",
        commandOverride: { command: process.execPath, prefixArgs: [fixture, `adapter-${harness}`] },
        resolveCredentialEnv: async () => harness === "claude" ? { CLAUDE_CONFIG_DIR: context.config } : { CODEX_HOME: context.config },
      }, headless);
      const engine = new AdapterEngine({ store, harness: selected.harness,
        harnessForDelivery: humanHarnessSelector(selected.harness, selected.humanHarness),
        executionIntentMode: "local-test-only", publish: async (event) => { events.push(event); } });
      for (const human of [HUMAN_A, HUMAN_B, HUMAN_A]) await engine.handleDelivery(humanDelivery(human));
      const finals = events.filter((event) => event.phase === "done"); assert.equal(finals.length, 3);
      const proofs = finals.map((event) => event.harness_consumption_v1);
      for (const [index, event] of finals.entries()) {
        assert.ok(event.harness_consumption_v1); assert.equal(event.harness_consumption_v1.harness_id, harness);
        assert.equal(event.harness_consumption_v1.input_sha256, inputDigest(calls[index]?.stdin ?? ""));
        assert.deepEqual(store.pendingEvents().find((pending) => pending.event_id === event.event_id), event);
      }
      assert.notEqual(proofs[0]?.native_session_id, proofs[1]?.native_session_id);
      assert.equal(proofs[0]?.native_session_id, proofs[2]?.native_session_id);
      assert.notEqual(proofs[0]?.native_turn_id, proofs[2]?.native_turn_id);
      assert.equal(calls[0]?.resumeSession, false); assert.equal(calls[2]?.resumeSession, true);
      assert.equal(manualCalls, 0);
    } finally { await context.clean(); }
  });
}

test("unsupported native formats never acquire consumption from stdout", async () => {
  const context = await setup("claude");
  try {
    for (const harness of ["openclaw", "muse"] as const) {
      const result = await context.runner.run({ ...context.request(randomUUID()), harness });
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.consumptionWitness, undefined);
    }
  } finally { await context.clean(); }
});

for (const harness of ["claude", "codex"] as const) {
  test(`${harness} validates native plain final through the same CLI parser`, async () => {
    const context = await setup(harness);
    try { assert.ok((await context.runner.run(context.request(sidA, "plain"))).consumptionWitness); }
    finally { await context.clean(); }
  });

  test(`${harness} preserves an explicitly configured canonical root behind a stable link`, async () => {
    const context = await setup(harness);
    try {
      const link = join(context.root, "configured"); await symlink(context.config, link);
      const request = context.request(sidA);
      const env = { [harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: link };
      const result = await context.runner.run({ ...request, env });
      assert.equal(result.exitCode, 0, result.stderr); assert.ok(result.consumptionWitness);
    } finally { await context.clean(); }
  });
}

for (const directory of ["config", "workspace"] as const) {
  test(`group-writable ${directory} leaves consumption UNKNOWN without altering execution`, async () => {
    const context = await setup("claude");
    try {
      await chmod(context[directory], 0o775);
      const result = await context.runner.run(context.request(sidA));
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.consumptionWitness, undefined);
    } finally { await context.clean(); }
  });
}

test("moving an old native SID to a new pathname does not make it a fresh session", async () => {
  const context = await setup("codex");
  try {
    assert.ok((await context.runner.run(context.request(sidA))).consumptionWitness);
    const result = await context.runner.run(context.request(sidA, "move-session"));
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.consumptionWitness, undefined);
  } finally { await context.clean(); }
});
