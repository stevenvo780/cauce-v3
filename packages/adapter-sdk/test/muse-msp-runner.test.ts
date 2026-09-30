import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

test("Muse MSP onRequest confirms the mode before a headless turn", async () => {
  const { config } = await fixture("onrequest", "onRequest");
  const sessionId = mintId();
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task",
    sessionId, timeoutMs: 5_000, signal: new AbortController().signal,
  });
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
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
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
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
  const parsed = parseMuseMspOutput(run.stdout);
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

test("Muse hard timeout retains its duration cap while the exact turn produces items", async () => {
  const { config } = await fixture("hard-timeout-vivo");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({ slowSteps: 8, stepMs: 80 }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic long task",
    sessionId: mintId(), timeoutMs: 250, timeoutKind: "hard", signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, true);
});

test("Muse foreign-turn progress cannot keep a silent no-progress turn alive", async () => {
  const { config } = await fixture("foreign-progress");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({
    slowSteps: 8, stepMs: 80, foreignProgress: true,
  }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task without progress",
    sessionId: mintId(), timeoutMs: 250, timeoutKind: "no-progress", signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, true);
});

test("Muse exact-turn streaming deltas keep the no-progress turn alive", async () => {
  const { config } = await fixture("streaming-progress");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({
    slowSteps: 8, stepMs: 80, deltaProgress: true,
  }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic streamed task",
    sessionId: mintId(), timeoutMs: 250, timeoutKind: "no-progress", signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, false);
  assert.match(run.stdout, /Muse responde/u);
});

test("Muse stale item replays do not refresh the no-progress clock", async () => {
  const { config } = await fixture("stale-progress");
  await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({
    slowSteps: 8, stepMs: 80, staleProgress: true,
  }));
  const run = await new MuseMspRunner(config).run({
    harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task with replayed progress",
    sessionId: mintId(), timeoutMs: 250, timeoutKind: "no-progress", signal: new AbortController().signal,
  });
  assert.equal(run.timedOut, true);
});

for (const [name, scenario] of [
  ["duplicate-delta", { duplicateDelta: true }], ["empty-delta", { emptyDelta: true }],
] as const) {
  test(`Muse ${name} cannot refresh the no-progress clock`, async () => {
    const { config } = await fixture(`false-delta-progress-${name}`);
    await writeFile(resolve(config.workspace, "fake-muse-scenario.json"), JSON.stringify({
      slowSteps: 8, stepMs: 80, deltaProgress: true, ...scenario,
    }));
    const run = await new MuseMspRunner(config).run({
      harness: "muse", command: fakeMuse, args: ["serve"], stdin: "Synthetic task with no new bytes",
      sessionId: mintId(), timeoutMs: 250, timeoutKind: "no-progress", signal: new AbortController().signal,
    });
    assert.equal(run.timedOut, true);
  });
}

interface MuseFixtureState {
  readonly turns: readonly { commandId: string; reasoningEffort: string; model: string }[];
  readonly reads: number;
  readonly pages: number;
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

for (const [name, scenario, code] of [
  ["unavailable", { preflightUnavailable: true }, "MUSE_VIEW_UNAVAILABLE"],
  ["unknown-history", { historyReason: "unknownHistoryReason" }, "MUSE_VIEW_HEALTH_UNKNOWN"],
  ["missing-cursor", { missingCursor: true }, "MUSE_PROTOCOL_FAILED"],
  ["missing-variants", { missingVariants: true }, "MUSE_EFFORT_UNVERIFIED"],
  ["unknown-variants", { unknownVariants: true }, "MUSE_EFFORT_UNVERIFIED"],
  ["bundled-capabilities", { catalogSource: "bundledCatalog" }, "MUSE_EFFORT_UNVERIFIED"],
  ["configured-capabilities", { catalogSource: "configCatalog" }, "MUSE_EFFORT_UNVERIFIED"],
  ["unknown-capabilities", { catalogSource: "unresolvedCatalog" }, "MUSE_EFFORT_UNVERIFIED"],
  ["invalid-variants", { invalidVariants: true }, "MUSE_CATALOG_INVALID"],
  ["broken-handshake", { brokenHandshake: true }, "MUSE_PROTOCOL_FAILED"],
] as const) {
  test(`Muse refuses ${name} before submitting a turn`, async () => {
    const config = await scenarioFixture(name, scenario);
    await assert.rejects(execute(config), (error: unknown) =>
      error instanceof ProcessExecutionError && error.code === code && !error.retryable);
    assert.equal((await stateOf(config)).turns.length, 0);
  });
}

test("Muse never clamps max to a contributor tier or to its default", async () => {
  const config = await scenarioFixture("contributor-max", {});
  await assert.rejects(execute({ ...config, model: "muse-spark-1.3-contributor", reasoningEffort: "max" }),
    (error: unknown) => error instanceof ProcessExecutionError
      && error.code === "MUSE_REASONING_UNSUPPORTED" && !error.retryable);
  assert.equal((await stateOf(config)).turns.length, 0);
});

test("Muse pins the advertised standard max route despite stale contributor metadata", async () => {
  const config = await scenarioFixture("standard-max", { staleModelMetadata: true });
  const telemetry: MuseMspTelemetry[] = [];
  const run = await execute({ ...config, reasoningEffort: "max", onTelemetry: (event) => { telemetry.push(event); } });
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
  const state = await stateOf(config);
  assert.equal(state.turns.length, 1);
  const turn = state.turns[0];
  assert.ok(turn);
  assert.equal(turn.reasoningEffort, "max");
  assert.equal(turn.model, "muse-spark-1.3");
  assert.ok(telemetry.some((event) => event.event === "muse_model_selection"
    && event.model === "muse-spark-1.3" && event.requested_effort === "max"
    && event.supported_efforts?.includes("max")));
  assert.doesNotMatch(JSON.stringify(telemetry), /Synthetic task|credential|billing|effective_effort/u);
});

test("Muse supports complete variants from the legacy native host without tier descriptions", async () => {
  const config = await scenarioFixture("native-140-catalog", { legacyCatalog: true });
  const run = await execute({ ...config, reasoningEffort: "max" });
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
  assert.equal((await stateOf(config)).turns[0]?.reasoningEffort, "max");
});

test("Muse admits the first turn with the before-genesis cursor explicitly returned by its host", async () => {
  const config = await scenarioFixture("before-genesis", { beforeGenesis: true });
  const run = await execute({ ...config, reasoningEffort: "max" });
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
  assert.equal((await stateOf(config)).turns.length, 1);
});

test("Muse admits contributor max only when the live subscription catalog advertises it", async () => {
  const config = await scenarioFixture("subscription-contributor", { subscriptionContributorMax: true });
  const run = await execute({ ...config, model: "muse-spark-1.3-contributor", reasoningEffort: "max" });
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
  const turn = (await stateOf(config)).turns[0];
  assert.ok(turn);
  assert.equal(turn.reasoningEffort, "max");
  assert.equal(turn.model, "muse-spark-1.3-contributor");
});

test("Muse never invents ultra when the provider catalog's maximum is max", async () => {
  const config = await scenarioFixture("provider-without-ultra", {});
  await assert.rejects(execute({ ...config, reasoningEffort: "ultra" }),
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

for (const fault of ["idle", "health", "protocol"] as const) {
  test(`Muse recovers a lost durable terminal after ${fault} without another submission`, async () => {
    const config = await scenarioFixture(`recover-${fault}`, { lostTerminal: true, fault });
    const telemetry: MuseMspTelemetry[] = [];
    const run = await execute({ ...config, onTelemetry: (event) => { telemetry.push(event); } });
    assert.equal(parseMuseMspOutput(run.stdout).output.reply, "Muse responde");
    const state = await stateOf(config);
    assert.equal(state.turns.length, 1);
    assert.equal(state.reads, 2);
    assert.equal(state.pages, 1);
    assert.ok(telemetry.some((event) => event.event === "muse_turn_reconciled"));
  });
}

for (const [name, scenario, detail] of [
  ["view-stays-unavailable", { lostTerminal: true, fault: "health", recoveryUnavailable: true }, "MUSE_VIEW_UNAVAILABLE"],
  ["wrong-turn", { wrongTerminal: true }, "MUSE_TERMINAL_UNVERIFIED"],
  ["no-terminal", { noTerminal: true }, "MUSE_TERMINAL_UNVERIFIED"],
  ["foreign-page", { lostTerminal: true, fault: "idle", foreignPage: true }, "MUSE_FOREIGN_VIEW"],
  ["stalled-page", { lostTerminal: true, fault: "idle", stalledPage: true }, "MUSE_VIEW_PAGE_STALLED"],
  ["gap-failed", { lostTerminal: true, fault: "gap", pageError: true }, "MUSE_GAP_FAILED"],
  ["host-exit", { noTerminal: true, fault: "exit" }, "MUSE_HOST_EXITED"],
  ["truncated", { truncated: true }, "MUSE_OUTPUT_TRUNCATED"],
  ["invalid-range", { invalidTerminalRange: true }, "MUSE_PROTOCOL_FAILED"],
] as const) {
  test(`Muse reports ${name} without resubmitting the admitted turn`, async () => {
    const config = await scenarioFixture(name, scenario);
    const started = Date.now();
    await assert.rejects(execute(config), (error: unknown) =>
      error instanceof ProcessExecutionError && error.code === "MUSE_EXECUTION_AMBIGUOUS"
      && !error.retryable && error.message.includes(detail));
    assert.ok(Date.now() - started < 3_000, "observation failure must not wait out the execution deadline");
    assert.equal((await stateOf(config)).turns.length, 1);
  });
}

test("Muse final selection is not overwritten by a late revision of earlier commentary", async () => {
  const config = await scenarioFixture("late-commentary", { lateCommentary: true });
  const run = await execute(config);
  assert.equal(parseMuseMspOutput(run.stdout).output.reply, "Muse responde");
});

test("Muse bounds an unanswered health read before any provider turn", async () => {
  const config = await scenarioFixture("read-timeout", { hangRead: true });
  await assert.rejects(execute(config, 500), (error: unknown) =>
    error instanceof ProcessExecutionError && error.code === "MUSE_PREFLIGHT_TIMEOUT");
  assert.equal((await stateOf(config)).turns.length, 0);
});

test("Muse can verify a read-limited projection through an explicit bounded page", async () => {
  const config = await scenarioFixture("read-limit", { historyReason: "projectionReadLimit" });
  const run = await execute(config);
  assert.equal(parseMuseMspOutput(run.stdout).output.status, "done");
  assert.equal((await stateOf(config)).pages, 1);
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
