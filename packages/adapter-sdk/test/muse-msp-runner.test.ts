import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createUuidV7Mint } from "@muse-code/sdk";
import { DurableStore } from "../src/sdk/durable-store.js";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import { MuseMspRunner, type MuseRunnerConfig } from "../src/sdk/muse-msp-runner.js";
import { HarnessAdapter } from "../src/harnesses/index.js";
import { museMspDefinition } from "../src/harnesses/muse-msp.js";
import { parseMuseMspOutput } from "../src/sdk/output-parser.js";
import { testStateRoot } from "./test-state.js";
import type { MuseMspTelemetry } from "../src/sdk/muse-msp-session.js";

const fakeMuse = resolve("test/fixtures/fake-muse-msp.mjs");
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
    definition: museMspDefinition,
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
    definition: museMspDefinition,
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

test("Muse turn that keeps producing items outlives its no-progress window", async () => {
  const { config } = await fixture("sin-progreso-vivo");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({ slowSteps: 8, stepMs: 80 }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic long task",
    sessionId: mintId(), timeoutMs: 250, timeoutKind: "no-progress", signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, false, "a live turn is never cut by its duration, only by silence");
  assert.match(run.stdout, /Muse responde/u);
});

test("Muse turn that goes silent dies once its no-progress window passes", async () => {
  const { config } = await fixture("sin-progreso-colgado");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({ hang: true }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic hung task",
    sessionId: mintId(), timeoutMs: 300, timeoutKind: "no-progress", signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, true);
});

interface MuseFixtureState {
  readonly turns: readonly { commandId: string; reasoningEffort: string; model: string }[];
  readonly reads: number;
  readonly pages: number;
  readonly capabilityRequests: readonly (readonly string[])[];
  readonly openings: readonly { method: string; sessionId: string; endpoint: string | null;
    command?: string; binary?: string; toolNames: readonly string[] }[];
}

async function stateOf(config: MuseRunnerConfig): Promise<MuseFixtureState> {
  return JSON.parse(await readFile(resolve(config.dataHome, "fake-muse-state.json"), "utf8")) as MuseFixtureState;
}

async function scenarioFixture(name: string, scenario: Record<string, unknown>): Promise<MuseRunnerConfig> {
  const { config } = await fixture(name);
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify(scenario));
  return config;
}

function execute(config: MuseRunnerConfig, timeoutMs = 5_000) {
  return new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task must not enter telemetry",
    sessionId: mintId(), timeoutMs, signal: new AbortController().signal,
  });
}

test("Muse never clamps max to a contributor tier or to its default", async () => {
  const config = await scenarioFixture("contributor-max", {});
  await assert.rejects(execute({ ...config, model: "muse-spark-1.3-contributor", reasoningEffort: "max" }),
    (error: unknown) => error instanceof ProcessExecutionError
      && error.code === "MUSE_REASONING_UNSUPPORTED" && !error.retryable);
  assert.equal((await stateOf(config)).turns.length, 0);
});

test("Muse accepts a durable terminal before acknowledgement and follows the acknowledgement turn id", async () => {
  const target = mintId();
  const config = await scenarioFixture("terminal-before-ack", { terminalBeforeAck: true, ackTurnId: target });
  const telemetry: MuseMspTelemetry[] = [];
  const run = await execute({ ...config, onTelemetry: (event) => { telemetry.push(event); } });
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
  const state = await stateOf(config);
  assert.equal(state.turns.length, 1);
  assert.notEqual(state.turns[0]?.commandId, target);
  assert.equal(telemetry.find((event) => event.event === "muse_turn_admitted")?.turn_id, target);
});

test("Muse recovers the exact durable answer when its live message was lost", async () => {
  const config = await scenarioFixture("lost-message", { lostMessage: true });
  const run = await execute(config);
  assert.equal(parseMuseMspOutput(run.stdout).output.reply, "Muse responde");
  const state = await stateOf(config);
  assert.equal(state.turns.length, 1);
  assert.equal(state.reads, 2);
  assert.equal(state.pages, 1);
});

async function environmentFixture(name: string) {
  const { config } = await fixture(name);
  const capture = resolve(config.dataHome, "captured-environment.jsonl");
  const executable = resolve(config.workspace, "capture-muse.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  endpoint: process.env.CAUCE_EMISSION_SOCKET_PATH ?? null,
  marker: process.env.CAUCE_SCOPE_LABEL ?? null,
  home: process.env.HOME, configHome: process.env.XDG_CONFIG_HOME,
  dataHome: process.env.XDG_DATA_HOME, noUpdate: process.env.MUSE_NO_AUTO_UPDATE,
  cwd: process.cwd(), codexHome: process.env.CODEX_HOME ?? null,
  claudeHome: process.env.CLAUDE_CONFIG_DIR ?? null,
  userProfilePresent: process.env.USERPROFILE !== undefined,
  turnTokenPresent: process.env.CAUCE_TURN_TOKEN !== undefined,
}) + '\\n');
await import(${JSON.stringify(pathToFileURL(fakeMuse).href)});
`, { mode: 0o755 });
  return { config: { ...config, executable }, capture };
}

test("Muse MSP binds each headless host to its owned emission endpoint", async () => {
  const { config, capture } = await environmentFixture("owned-endpoints");
  const runner = new MuseMspRunner(config);
  const tasks = ['A', 'B'].map((marker) => ({ marker, sessionId: mintId(), endpoint: resolve(config.workspace, `${marker}.sock`) }));
  const outputs = await Promise.all(tasks.map(async ({ marker, sessionId, endpoint }) => {
    const output = await runner.run({ harness: "muse", command: "caller-must-not-select-an-executable", args: [],
      stdin: "Synthetic task", sessionId, timeoutMs: 5_000, signal: new AbortController().signal,
      cwd: "/caller-must-not-select-a-workspace", env: { CAUCE_SCOPE_LABEL: marker, PATH: "/caller-must-not-control-path" }, emissionSocketPath: endpoint });
    return parseMuseMspOutput(output.stdout);
  }));
  assert.deepEqual(outputs.map((output) => output.nativeSessionId), tasks.map((task) => task.sessionId));
  assert.notEqual(outputs[0]?.nativeSessionId, outputs[1]?.nativeSessionId);
  const captures = (await readFile(capture, "utf8")).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(captures.length, 2);
  for (const task of tasks) {
    const child = captures.find((row) => row.marker === task.marker);
    assert.ok(child);
    assert.equal(child.endpoint, task.endpoint);
    assert.equal(child.home, resolve(config.configHome, ".."));
    assert.equal(child.configHome, config.configHome);
    assert.equal(child.dataHome, config.dataHome);
    assert.equal(child.noUpdate, "1");
    assert.equal(child.cwd, config.workspace);
    assert.equal(child.codexHome, null);
    assert.equal(child.claudeHome, null);
    assert.equal(child.userProfilePresent, false);
    assert.equal(child.turnTokenPresent, false);
  }
});

test("Muse MSP rejects caller-owned endpoint and secret-like environment keys", async () => {
  const { config, capture } = await environmentFixture("rejected-environment");
  const undefinedEndpoint: Record<string, string> = {};
  Object.defineProperty(undefinedEndpoint, "CAUCE_EMISSION_SOCKET_PATH", { value: undefined });
  const attempts: readonly { env: Readonly<Record<string, string>>; code: string }[] = [
    { env: { CAUCE_EMISSION_SOCKET_PATH: "/tmp/caller.sock" }, code: "EMISSION_ENDPOINT_OVERRIDE" },
    { env: undefinedEndpoint, code: "EMISSION_ENDPOINT_OVERRIDE" },
    { env: { CAUCE_TURN_TOKEN: "synthetic-denied" }, code: "SECRET_ENV_REJECTED" },
    { env: { CAUCE_PASSWORD: "synthetic-denied" }, code: "SECRET_ENV_REJECTED" },
  ];
  for (const { env, code } of attempts) {
    await assert.rejects(new MuseMspRunner(config).run({ harness: "muse", command: fakeMuse, args: [], stdin: "Synthetic task",
      sessionId: mintId(), env, timeoutMs: 5_000, signal: new AbortController().signal }),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === code);
  }
  await assert.rejects(readFile(capture), { code: "ENOENT" });
});

function scopedExecute(config: MuseRunnerConfig, sessionId: string, endpoint: string, resumeSession = false) {
  return new MuseMspRunner(config).run({ harness: "muse", command: fakeMuse, args: [], stdin: "Synthetic scoped task",
    sessionId, emissionSocketPath: endpoint, resumeSession, timeoutMs: 5_000, signal: new AbortController().signal });
}

test("Muse scoped calls register required Cauce MCP for start, resume and conflict recovery", async () => {
  const config = await scenarioFixture("session-mcp-registry", {});
  const a = mintId(), b = mintId();
  const endpoints = ['A1', 'B', 'A2', 'A3'].map(label => resolve(config.workspace, `${label}.sock`));
  for (const [index, sessionId] of [a, b, a, a].entries()) {
    const endpoint = endpoints[index]; assert.ok(endpoint);
    const output = await scopedExecute(config, sessionId, endpoint, index === 2);
    assert.equal(parseMuseMspOutput(output.stdout).nativeSessionId, sessionId);
  }
  const state = await stateOf(config);
  assert.equal(state.turns.length, 4);
  assert.deepEqual(state.capabilityRequests, [['sessionMcp'], ['sessionMcp'], ['sessionMcp'], ['sessionMcp']]);
  assert.deepEqual(state.openings.map(row => row.method), ['session/start', 'session/start', 'session/resume', 'session/start', 'session/resume']);
  assert.deepEqual(state.openings.map(row => row.endpoint), [...endpoints, endpoints[3]]);
  for (const row of state.openings) {
    assert.equal(row.command, process.execPath);
    assert.equal(row.binary, fileURLToPath(new URL('../src/bin/cauce-mcp.js', import.meta.url)));
    assert.ok(row.toolNames.includes('cauce_reply'));
    assert.ok(row.toolNames.includes('cauce_status'));
  }
});
