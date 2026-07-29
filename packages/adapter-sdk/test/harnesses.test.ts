import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { CANONICAL_OPEN_CODE_SESSION_FILE, DurableStore } from "../src/sdk/durable-store.js";
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
const canonicalScope = `auth-v1:${"A".repeat(43)}`;

function fixture(definition: HarnessDefinition): string {
  return resolve(`test/fixtures/fake-${definition.id}.mjs`);
}

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
          (error: unknown) => {
            if (!(error instanceof AdapterError)) return false;
            assert.equal(error.retryable, false);
            return error.code === (
              scenario === "timeout" ? "EXECUTION_TIMEOUT_AMBIGUOUS" : "MALFORMED_OUTPUT"
            );
          },
        );
        return;
      }

      const output = await adapter.execute(request);
      if (scenario === "success") {
        assert.equal(output.status, "done");
        assert.equal(output.retryable, false);
        assert.deepEqual(output.messages, []);
      } else {
        assert.equal(output.status, "failed");
        assert.equal(output.retryable, scenario === "retry");
      }
    });
  }
}

test("all harness adapters reject direct fan-in before provider or session access", async () => {
  for (const definition of definitions) {
    let runnerCalls = 0;
    const runner: CommandRunner = {
      run: async () => {
        runnerCalls += 1;
        throw new Error("provider runner must not be called for fan-in");
      },
    };
    const storeName = `direct-fanin-${definition.id}`;
    const store = await freshStore(storeName);
    const sessionsPath = resolve(stateRoot, storeName, "sessions.json");
    const sessionsBefore = await optionalFile(sessionsPath);
    const adapter = new HarnessAdapter({ definition, runner, store });

    await assert.rejects(
      adapter.execute({
        prompt: "untrusted aggregate",
        context: {
          self_alias: "jarvis",
          sender_alias: "cauce",
          tenant_id: "Steven",
          room_id: "grp.steven",
          channel: "cauce",
          agent_message: true,
          message_type: "agent.fanin",
          routing_targets: [],
        },
        sessionKey: "must-not-be-resolved",
        timeoutMs: 2_000,
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof AdapterError
        && error.code === "FANIN_HARNESS_EXECUTION_FORBIDDEN"
        && error.retryable === false,
    );

    assert.equal(runnerCalls, 0, `${definition.id} provider runner was called`);
    assert.equal(
      await optionalFile(sessionsPath),
      sessionsBefore,
      `${definition.id} session state changed`,
    );
  }
});

test("process exit after execution begins is ambiguous and non-retryable", async () => {
  for (const [name, stdout] of [
    ["unstructured", "not-json"],
    ["structured-success", JSON.stringify({
      reply: "unsafe success",
      messages: [],
      status: "done",
      retryable: false,
      artifacts: [],
    })],
  ] as const) {
    const runner: CommandRunner = {
      run: async () => ({
        stdout,
        stderr: "",
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
      }),
    };
    const adapter = new HarnessAdapter({
      definition: HARNESS_DEFINITIONS.fake,
      runner,
      store: await freshStore(`process-exit-${name}`),
    });
    await assert.rejects(
      adapter.execute({
        prompt: "execute once",
        timeoutMs: 2_000,
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof AdapterError
        && error.code === "PROCESS_EXIT_AMBIGUOUS"
        && error.retryable === false,
    );
  }
});

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

test("Codex receives images through its native provider attachment argument", async () => {
  for (const definition of [HARNESS_DEFINITIONS.codex]) {
    const runner = new RecordingRunner(new SpawnCommandRunner());
    const adapter = new HarnessAdapter({
      definition,
      runner,
      store: await freshStore(`native-image-${definition.id}`),
      commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
    });
    await adapter.execute({
      prompt: "describe the supplied image",
      attachments: [{
        kind: "image", name: "pixel.png", mimeType: "image/png",
        path: "/tmp/cauce-fixture/pixel.png", size: 67, sha256: "a".repeat(64),
      }],
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    const request = runner.requests[0];
    assert.ok(request);
    assert.ok(request.args.includes("--image"));
    assert.ok(request.args.includes("/tmp/cauce-fixture/pixel.png"));
    assert.match(request.stdin, /delivery_mode=native/u);
  }
});

test("a provider without a native document input gets an explicit filesystem fallback", async () => {
  const runner = new RecordingRunner(new SpawnCommandRunner());
  const definition = HARNESS_DEFINITIONS.codex;
  const adapter = new HarnessAdapter({
    definition,
    runner,
    store: await freshStore("document-fallback-codex"),
    commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
  });
  await adapter.execute({
    prompt: "extract the document text",
    attachments: [{
      kind: "document", name: "report.pdf", mimeType: "application/pdf",
      path: "/tmp/cauce-fixture/report.pdf", size: 42, sha256: "b".repeat(64),
    }],
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  const request = runner.requests[0];
  assert.ok(request);
  assert.equal(request.args.includes("/tmp/cauce-fixture/report.pdf"), false);
  assert.match(request.stdin, /delivery_mode=filesystem_fallback/u);
  assert.match(request.stdin, /provider does not expose native application\/pdf input/u);
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

test("OpenCode starts without a session, stores the observed ID, then resumes it", async () => {
  const definition = HARNESS_DEFINITIONS.opencode;
  const store = await freshStore("opencode-observed-session");
  const runner = new RecordingRunner(new SpawnCommandRunner());
  const adapter = new HarnessAdapter({
    definition,
    runner,
    store,
    commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
  });
  const request = {
    prompt: "SCENARIO:success",
    sessionKey: "conversation-observed",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  };

  await adapter.execute(request);
  assert.deepEqual(runner.requests[0]?.args, [
    fixture(definition),
    "run",
    "--format",
    "json",
    "--attach",
    "http://127.0.0.1:4097",
    "--dir",
    "/workspace/kant",
  ]);
  assert.deepEqual(store.getSession("opencode:conversation-observed"), {
    native_id: "ses_opencode_native",
    initialized: true,
  });

  await adapter.execute(request);
  assert.deepEqual(runner.requests[1]?.args, [
    fixture(definition),
    "run",
    "--format",
    "json",
    "--attach",
    "http://127.0.0.1:4097",
    "--dir",
    "/workspace/kant",
    "--session",
    "ses_opencode_native",
  ]);
});

test("Kant OpenCode persists its mapping before publishing a sticky canonical pointer", async () => {
  const definition = HARNESS_DEFINITIONS.opencode;
  const directoryName = "opencode-canonical-session";
  const directory = resolve(stateRoot, directoryName);
  const store = await freshStore(directoryName);
  await store.reconcileCanonicalOpenCodeSession();
  const adapter = new HarnessAdapter({
    definition,
    runner: new SpawnCommandRunner(),
    store,
    sessionNamespace: "kant",
    canonicalOpenCodeSession: true,
    commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
  });

  await adapter.execute({
    prompt: "SCENARIO:success",
    sessionKey: canonicalScope,
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  assert.deepEqual(store.getSession(`opencode:kant:${canonicalScope}`), {
    native_id: "ses_opencode_native",
    initialized: true,
  });
  const firstPointer = JSON.parse(
    await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(firstPointer, {
    version: 1,
    state: "active",
    alias: "kant",
    harness: "opencode",
    scope_key: canonicalScope,
    session_id: "ses_opencode_native",
  });

  const otherScope = `auth-v1:${"B".repeat(43)}`;
  await adapter.execute({
    prompt: "SCENARIO:success",
    sessionKey: otherScope,
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  const stickyPointer = JSON.parse(
    await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(stickyPointer.scope_key, canonicalScope);
});

test("Kant OpenCode never publishes nonzero, malformed, missing or invalid native sessions", async () => {
  const definition = HARNESS_DEFINITIONS.opencode;
  for (const scenario of ["fail", "malformed", "no-session", "invalid-session"] as const) {
    const directoryName = `opencode-canonical-reject-${scenario}`;
    const directory = resolve(stateRoot, directoryName);
    const store = await freshStore(directoryName);
    await store.reconcileCanonicalOpenCodeSession();
    const adapter = new HarnessAdapter({
      definition,
      runner: new SpawnCommandRunner(),
      store,
      sessionNamespace: "kant",
      canonicalOpenCodeSession: true,
      commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
    });
    const execution = adapter.execute({
      prompt: `SCENARIO:${scenario}`,
      sessionKey: canonicalScope,
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    if (scenario === "malformed") await assert.rejects(execution, AdapterError);
    else await execution;

    assert.equal(store.getSession(`opencode:kant:${canonicalScope}`), undefined);
    const current = JSON.parse(
      await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(current.state, "unavailable");
    assert.equal(current.reason, "missing");
  }
});

test("Kant OpenCode repairs one invalid legacy mapping without resuming it", async () => {
  const definition = HARNESS_DEFINITIONS.opencode;
  const directoryName = "opencode-canonical-repair-invalid";
  const directory = resolve(stateRoot, directoryName);
  const store = await freshStore(directoryName);
  await store.setSession(`opencode:kant:${canonicalScope}`, {
    native_id: "legacy-generated-uuid",
    initialized: true,
  });
  assert.equal((await store.reconcileCanonicalOpenCodeSession()).state, "unavailable");
  const runner = new RecordingRunner(new SpawnCommandRunner());
  const adapter = new HarnessAdapter({
    definition,
    runner,
    store,
    sessionNamespace: "kant",
    canonicalOpenCodeSession: true,
    commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
  });

  await adapter.execute({
    prompt: "SCENARIO:success",
    sessionKey: canonicalScope,
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  assert.equal(runner.requests[0]?.args.includes("--session"), false);
  assert.equal(store.getSession(`opencode:kant:${canonicalScope}`)?.native_id, "ses_opencode_native");
  const repaired = JSON.parse(
    await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(repaired.state, "active");
  assert.equal(repaired.session_id, "ses_opencode_native");
});

test("canonical OpenCode publication cannot be enabled for another alias", async () => {
  assert.throws(() => new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.opencode,
    runner: new SpawnCommandRunner(),
    store: {} as DurableStore,
    sessionNamespace: "other",
    canonicalOpenCodeSession: true,
  }), /restricted to alias 'kant'/u);
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
