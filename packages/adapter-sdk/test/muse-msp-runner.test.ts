import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createUuidV7Mint } from "@muse-code/sdk";
import { DurableStore } from "../src/sdk/durable-store.js";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import { MuseMspRunner, type MuseRunnerConfig } from "../src/sdk/muse-msp-runner.js";
import { HarnessAdapter, museDefinition } from "../src/harnesses/index.js";
import { parseMuseOutput } from "../src/sdk/output-parser.js";
import { testStateRoot } from "./test-state.js";

const fakeMuse = resolve("test/fixtures/fake-muse.mjs");
const mintId = createUuidV7Mint();

async function fixture(
  name: string,
  approvalMode: MuseRunnerConfig["approvalMode"] = "denyUnmatched",
): Promise<{ config: MuseRunnerConfig; stateDirectory: string }> {
  const root = testStateRoot(`muse-${name}`);
  const home = resolve(root, "alias-home");
  const workspace = resolve(root, "workspace");
  const configHome = resolve(home, "muse-config");
  const dataHome = resolve(home, "muse-data");
  const stateDirectory = resolve(root, "cauce-state");
  for (const path of [workspace, configHome, dataHome, stateDirectory]) {
    await mkdir(path, { recursive: true });
  }
  return {
    config: {
      executable: fakeMuse,
      configHome,
      dataHome,
      workspace,
      approvalMode,
      model: "muse-spark-1.3",
      reasoningEffort: "high",
    },
    stateDirectory,
  };
}

test("Muse MSP maintains one durable UUIDv7 conversation across adapter reconstruction", async () => {
  const { config, stateDirectory } = await fixture("persistent");
  const firstStore = await DurableStore.open(stateDirectory);
  const first = new HarnessAdapter({
    definition: museDefinition,
    runner: new MuseMspRunner(config),
    store: firstStore,
    sessionNamespace: "teseo",
  });
  const firstOutput = await first.execute({
    prompt: "First synthetic task",
    sessionKey: "conversation-7",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(firstOutput.reply, "Muse responde");
  const stored = firstStore.getSession("muse:teseo:conversation-7");
  assert.ok(stored);
  assert.match(stored.native_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(stored.initialized, true);

  const secondStore = await DurableStore.open(stateDirectory);
  const second = new HarnessAdapter({
    definition: museDefinition,
    runner: new MuseMspRunner(config),
    store: secondStore,
    sessionNamespace: "teseo",
  });
  const secondOutput = await second.execute({
    prompt: "Second synthetic task",
    sessionKey: "conversation-7",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(secondOutput.status, "done");

  const state = JSON.parse(await readFile(resolve(config.dataHome, "fake-muse-state.json"), "utf8")) as {
    sessions: Record<string, { workspaceRoot: string; approvalMode: string; modelId: string; turnCount: number }>;
    turns: { sessionId: string; reasoningEffort: string; input: { text: string }[] }[];
    hostEnv: { home: string; configHome: string; dataHome: string; codexHome: string | null }[];
  };
  assert.equal(Object.keys(state.sessions).length, 1);
  assert.deepEqual(state.turns.map((turn) => turn.sessionId), [stored.native_id, stored.native_id]);
  assert.equal(state.sessions[stored.native_id]?.workspaceRoot, config.workspace);
  assert.equal(state.sessions[stored.native_id]?.approvalMode, "denyUnmatched");
  assert.equal(state.sessions[stored.native_id]?.modelId, "muse-spark-1.3");
  assert.equal(state.sessions[stored.native_id]?.turnCount, 2);
  assert.deepEqual(state.turns.map((turn) => turn.reasoningEffort), ["high", "high"]);
  assert.ok(state.turns[0]?.input[0]?.text.includes("First synthetic task"));
  assert.ok(state.hostEnv.every((env) => env.home === resolve(config.configHome, "..")
    && env.configHome === config.configHome && env.dataHome === config.dataHome
    && env.codexHome === null));
});

test("Muse MSP onRequest confirms the mode before a headless turn", async () => {
  const { config } = await fixture("onrequest", "onRequest");
  const sessionId = mintId();
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
    sessionId, timeoutMs: 5_000, signal: new AbortController().signal,
  });
  assert.equal(parseMuseOutput(run.stdout).output.status, "done");
  const state = JSON.parse(await readFile(resolve(config.dataHome, "fake-muse-state.json"), "utf8")) as {
    sessions: Record<string, { approvalMode: string }>;
  };
  assert.equal(state.sessions[sessionId]?.approvalMode, "onRequest");
});

test("Muse YOLO requires allowAll and disables the sandbox at host startup", async () => {
  const { config } = await fixture("yolo", "allowAll");
  const yolo = { ...config, yolo: true };
  assert.throws(() => new MuseMspRunner(config), /configured together/u);
  assert.throws(() => new MuseMspRunner({ ...config, approvalMode: "onRequest", yolo: true }), /configured together/u);
  const sessionId = mintId();
  const run = await new MuseMspRunner(yolo).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
    sessionId, timeoutMs: 5_000, signal: new AbortController().signal,
  });
  assert.equal(parseMuseOutput(run.stdout).output.status, "done");
  const state = JSON.parse(await readFile(resolve(config.dataHome, "fake-muse-state.json"), "utf8")) as {
    sessions: Record<string, { approvalMode: string }>;
    hostEnv: { args: string[] }[];
  };
  assert.equal(state.sessions[sessionId]?.approvalMode, "allowAll");
  assert.deepEqual(state.hostEnv[0]?.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
});

test("Muse MSP timeout is marked ambiguous and does not submit a second turn", async () => {
  const { config } = await fixture("timeout");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({ hang: true }));
  const runner = new MuseMspRunner(config);
  const run = await runner.run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
    sessionId: mintId(), timeoutMs: 500, signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, true);
  assert.equal(run.stdout, "");
  const state = JSON.parse(await readFile(resolve(config.dataHome, "fake-muse-state.json"), "utf8")) as {
    turns: unknown[];
  };
  assert.equal(state.turns.length, 1);
});

test("Muse MSP lost session is a preflight failure that can retire the stale mapping", async () => {
  const { config } = await fixture("missing");
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
    sessionId: mintId(), resumeSession: true, timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(run.exitCode, 1);
  assert.equal(run.harnessStarted, false);
  assert.match(run.stderr, /no conversation found with session id/u);
});

test("Muse MSP terminal failure remains failed even with visible answer text", async () => {
  const { config } = await fixture("failed");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({
    terminal: "failed",
    answer: JSON.stringify({ reply: "Unsafe success", messages: [], status: "done", retryable: false }),
  }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
    sessionId: mintId(), timeoutMs: 5_000, signal: new AbortController().signal,
  });
  const parsed = parseMuseOutput(run.stdout);
  assert.equal(parsed.output.status, "failed");
  assert.equal(parsed.output.retryable, false);
  assert.match(parsed.output.reply ?? "", /synthetic model failure/u);
});

test("Muse refuses foreign project context before starting the host", async () => {
  const { config } = await fixture("foreign-context");
  await mkdir(resolve(config.workspace, ".codex"));
  await assert.rejects(
    new MuseMspRunner(config).run({
      harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
      sessionId: mintId(), timeoutMs: 5_000, signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProcessExecutionError
      && error.code === "MUSE_PREFLIGHT_FAILED" && !error.retryable,
  );
});
