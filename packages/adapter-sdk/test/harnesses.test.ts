import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError } from "../src/sdk/errors.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  HarnessDefinition,
  SafeRunnerLog,
} from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";

const stateRoot = resolve(".test-state");
const definitions = Object.values(HARNESS_DEFINITIONS);

function fixture(definition: HarnessDefinition): string {
  return resolve(`test/fixtures/fake-${definition.id}.mjs`);
}

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];
  constructor(private readonly inner: CommandRunner) {}

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return this.inner.run(request);
  }
}

for (const definition of definitions) {
  for (const scenario of ["success", "fail", "timeout", "malformed", "retry"] as const) {
    test(`${definition.id}: ${scenario} with fake executable`, async () => {
      const store = await freshStore(`matrix-${definition.id}-${scenario}`);
      const adapter = new HarnessAdapter({
        definition,
        runner: new SpawnCommandRunner({ killGraceMs: 15 }),
        store,
        commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
      });
      const request = {
        prompt: `SCENARIO:${scenario}`,
        timeoutMs: scenario === "timeout" ? 40 : 2_000,
        signal: new AbortController().signal,
      };

      if (scenario === "timeout" || scenario === "malformed") {
        await assert.rejects(
          adapter.execute(request),
          (error: unknown) =>
            error instanceof AdapterError &&
            error.code === (scenario === "timeout" ? "TIMEOUT" : "MALFORMED_OUTPUT"),
        );
        return;
      }

      const output = await adapter.execute(request);
      if (scenario === "success") {
        assert.equal(output.status, "done");
        assert.equal(output.retryable, false);
        assert.equal(output.messages[0]?.to, "ops");
      } else {
        assert.equal(output.status, "failed");
        assert.equal(output.retryable, scenario === "retry");
      }
    });
  }
}

test("prompt secrets are confined to stdin and omitted from safe logs for every adapter", async () => {
  const secret = "TOP-SECRET-PROMPT-71d626";
  for (const definition of definitions) {
    const logs: SafeRunnerLog[] = [];
    const recording = new RecordingRunner(new SpawnCommandRunner({ logger: (entry) => logs.push(entry) }));
    const adapter = new HarnessAdapter({
      definition,
      runner: recording,
      store: await freshStore(`secret-${definition.id}`),
      commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
    });
    await adapter.execute({
      prompt: `SCENARIO:success ${secret}`,
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    const captured = recording.requests[0];
    assert.ok(captured);
    assert.match(captured.stdin, new RegExp(secret, "u"));
    assert.doesNotMatch(JSON.stringify(captured.args), new RegExp(secret, "u"));
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret, "u"));
    assert.deepEqual(Object.keys(logs[0] ?? {}).sort(), ["event", "harness"]);
  }
});

test("persistent session mappings survive adapter reconstruction where supported", async () => {
  for (const definition of definitions.filter((candidate) => candidate.capabilities.persistent_sessions)) {
    const directoryName = `session-${definition.id}`;
    const firstStore = await freshStore(directoryName);
    const firstRunner = new RecordingRunner(new SpawnCommandRunner());
    const first = new HarnessAdapter({
      definition,
      runner: firstRunner,
      store: firstStore,
      commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
    });
    await first.execute({
      prompt: "SCENARIO:success",
      sessionKey: "conversation-7",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    const session = firstStore.getSession(`${definition.id}:conversation-7`);
    assert.ok(session);
    assert.equal(session.initialized, true);

    const reopened = await DurableStore.open(resolve(stateRoot, directoryName));
    const secondRunner = new RecordingRunner(new SpawnCommandRunner());
    const second = new HarnessAdapter({
      definition,
      runner: secondRunner,
      store: reopened,
      commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
    });
    await second.execute({
      prompt: "SCENARIO:success",
      sessionKey: "conversation-7",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    const secondArgs = secondRunner.requests[0]?.args ?? [];
    assert.ok(secondArgs.includes(session.native_id), `${definition.id} did not resume mapped native session`);
    if (definition.id === "claude") assert.ok(secondArgs.includes("--resume"));
    if (definition.id === "codex") assert.ok(secondArgs.includes("resume"));
  }
});

test("Hermes remains explicitly stateless", async () => {
  const definition = HARNESS_DEFINITIONS.hermes;
  const runner = new RecordingRunner(new SpawnCommandRunner());
  const adapter = new HarnessAdapter({
    definition,
    runner,
    store: await freshStore("hermes-stateless"),
    commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
  });
  await adapter.execute({
    prompt: "SCENARIO:success",
    sessionKey: "ignored",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  assert.equal(runner.requests[0]?.args.some((argument) => argument.includes("session")), false);
});

test("timeout terminates the complete POSIX process group", { skip: process.platform === "win32" }, async () => {
  const directory = resolve(stateRoot, "process-group");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const marker = resolve(directory, "grandchild-survived");
  const runner = new SpawnCommandRunner({ killGraceMs: 15 });
  const result = await runner.run({
    command: process.execPath,
    args: [resolve("test/fixtures/process-tree.mjs"), marker],
    harness: "fake",
    stdin: "process group test",
    timeoutMs: 40,
    signal: new AbortController().signal,
  });
  assert.equal(result.timedOut, true);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const exists = await stat(marker).then(
    () => true,
    () => false,
  );
  assert.equal(exists, false, "grandchild survived process-group termination");
});

test("cancellation terminates the complete POSIX process group", { skip: process.platform === "win32" }, async () => {
  const directory = resolve(stateRoot, "cancel-process-group");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const marker = resolve(directory, "grandchild-survived");
  const controller = new AbortController();
  const runner = new SpawnCommandRunner({ killGraceMs: 15 });
  const running = runner.run({
    command: process.execPath,
    args: [resolve("test/fixtures/process-tree.mjs"), marker],
    harness: "fake",
    stdin: "process group cancellation test",
    timeoutMs: 2_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 40);
  const result = await running;
  assert.equal(result.cancelled, true);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const exists = await stat(marker).then(
    () => true,
    () => false,
  );
  assert.equal(exists, false, "grandchild survived cancellation");
});

test("OpenClaw smoke uses authentic version or an explicit packaged fake fallback", async (context) => {
  const result = spawnSync("openclaw", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    await stat(resolve("dist/src/bin/openclaw.js"));
    const fallback = spawnSync(process.execPath, [fixture(HARNESS_DEFINITIONS.openclaw)], {
      encoding: "utf8",
      input: "SCENARIO:success",
      timeout: 5_000,
    });
    assert.equal(fallback.status, 0);
    assert.match(fallback.stdout, /openclaw success/u);
    context.diagnostic("openclaw executable absent; validated packaged adapter bin with fake executable");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});
