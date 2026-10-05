import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";

const secretLikeKeys = [
  "API_KEY",
  "OPENAI_API_KEY",
  "CAUCE_TOKEN",
  "DATABASE_PASSWORD",
  "CAUCE_SESSION",
  "CAUCE_COOKIES",
  "AUTH",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "BASIC_AUTH",
  "client-authentication",
  "credential",
  "SERVICE_CREDENTIALS",
] as const;

test("child inherits only Hermes discovery configuration, not parent secrets", () => {
  const runnerModule = new URL("../src/sdk/process-runner.js", import.meta.url).href;
  const inspectedKeys = [
    "HERMES_HOME", "HERMES_INFERENCE_MODEL", "CAUCE_HERMES_RUNTIME_DIR", "CAUCE_HERMES_SOURCE_DIR",
    ...secretLikeKeys,
  ];
  const childProbe = `
    const keys = ${JSON.stringify(inspectedKeys)};
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));
  `;
  const isolatedParent = `
    const { SpawnCommandRunner } = await import(${JSON.stringify(runnerModule)});
    const result = await new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["--input-type=module", "--eval", ${JSON.stringify(childProbe)}],
      harness: "hermes",
      stdin: "",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    if (result.exitCode !== 0) {
      process.stderr.write(result.stderr);
      process.exit(1);
    }
    process.stdout.write(result.stdout);
  `;
  const hermesHome = "/tmp/hermes profile discovery";
  const hermesModel = "provider/model:exact";
  const hermesRuntime = "/opt/cauce-v3-hermes-runtime/iza/release-exact";
  const hermesSource = "/tmp/hermes source discovery";
  const parentEnvironment: NodeJS.ProcessEnv = {
    HERMES_HOME: hermesHome,
    HERMES_INFERENCE_MODEL: hermesModel,
    CAUCE_HERMES_RUNTIME_DIR: hermesRuntime,
    CAUCE_HERMES_SOURCE_DIR: hermesSource,
  };
  for (const key of secretLikeKeys) parentEnvironment[key] = "blocked-parent-value";

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", isolatedParent], {
    encoding: "utf8",
    env: parentEnvironment,
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(result.stdout) as Record<string, string | null>;
  assert.equal(received.HERMES_HOME, hermesHome);
  assert.equal(received.HERMES_INFERENCE_MODEL, hermesModel);
  assert.equal(received.CAUCE_HERMES_RUNTIME_DIR, hermesRuntime);
  assert.equal(received.CAUCE_HERMES_SOURCE_DIR, hermesSource);
  for (const key of secretLikeKeys) assert.equal(received[key], null, `${key} leaked to the child`);
});

test("child inherits CODEX_HOME and CLAUDE_CONFIG_DIR from the adapter env, not an unrelated var", () => {
  const runnerModule = new URL("../src/sdk/process-runner.js", import.meta.url).href;
  const inspectedKeys = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", ...secretLikeKeys];
  const childProbe = `
    const keys = ${JSON.stringify(inspectedKeys)};
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));
  `;
  const isolatedParent = `
    const { SpawnCommandRunner } = await import(${JSON.stringify(runnerModule)});
    const result = await new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["--input-type=module", "--eval", ${JSON.stringify(childProbe)}],
      harness: "codex",
      stdin: "",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    if (result.exitCode !== 0) {
      process.stderr.write(result.stderr);
      process.exit(1);
    }
    process.stdout.write(result.stdout);
  `;
  // Mirrors a container where several aliases share $HOME but each adapter process (the main
  // harness AND, with this fix, the headless human/MCP harness) resolves a distinct credential
  // home for its own alias, e.g. CLAUDE_CONFIG_DIR=/home/dev/.local/share/cauce-v3/config/kratos/.claude.
  const codexHome = "/home/dev/.local/share/cauce-v3/config/atlas/.codex";
  const claudeConfigDir = "/home/dev/.local/share/cauce-v3/config/kratos/.claude";
  const parentEnvironment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    // Not a credential-home variable for any harness kind: must not leak just because it
    // resembles one.
    GROK_HOME: "/home/dev/.local/share/cauce-v3/config/kratos/.grok",
  };
  for (const key of secretLikeKeys) parentEnvironment[key] = "blocked-parent-value";

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", isolatedParent], {
    encoding: "utf8",
    env: parentEnvironment,
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(result.stdout) as Record<string, string | null>;
  assert.equal(received.CODEX_HOME, codexHome);
  assert.equal(received.CLAUDE_CONFIG_DIR, claudeConfigDir);
  assert.equal(received.GROK_HOME, null, "GROK_HOME leaked despite not being allowlisted");
  for (const key of secretLikeKeys) assert.equal(received[key], null, `${key} leaked to the child`);
});

test("request.env rejects every secret-like key", async () => {
  const runner = new SpawnCommandRunner();

  for (const key of secretLikeKeys) {
    await assert.rejects(
      runner.run({
        command: process.execPath,
        args: ["--eval", "process.exit(0)"],
        env: { [key]: "blocked-request-value" },
        harness: "hermes",
        stdin: "stdin-only",
        timeoutMs: 2_000,
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof ProcessExecutionError && error.code === "SECRET_ENV_REJECTED",
      `${key} was accepted via request.env`,
    );
  }
});

test("spawn failure remains an unequivocally pre-execution retryable error", async () => {
  const runner = new SpawnCommandRunner();
  await assert.rejects(
    runner.run({
      command: "__cauce_missing_executable__",
      args: [],
      harness: "fake",
      stdin: "",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof ProcessExecutionError
      && error.code === "SPAWN_FAILED"
      && error.retryable,
  );
});

test("an already-aborted signal never spawns a process and remains non-ambiguous", async () => {
  const events: string[] = [];
  const runner = new SpawnCommandRunner({
    logger: (entry) => events.push(entry.event),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runner.run({
      command: "__must_not_be_spawned__",
      args: [],
      harness: "fake",
      stdin: "",
      timeoutMs: 2_000,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof ProcessExecutionError
      && error.code === "CANCELLED"
      && !error.retryable,
  );
  assert.deepEqual(events, []);
});

test("output limit after spawn is explicitly ambiguous and non-retryable", async () => {
  const runner = new SpawnCommandRunner({ maxOutputBytes: 16, killGraceMs: 10 });
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: ["--eval", "process.stdout.write('x'.repeat(4096));setTimeout(()=>{},1000)"],
      harness: "fake",
      stdin: "",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof ProcessExecutionError
      && error.code === "OUTPUT_LIMIT_AMBIGUOUS"
      && !error.retryable,
  );
});

const progressingChild = `
  const until = Date.now() + 1_500;
  const tick = setInterval(() => {
    process.stderr.write("<<cauce:progress>>\\n");
    if (Date.now() >= until) { clearInterval(tick); process.stdout.write("done"); }
  }, 100);
`;

test("a turn that keeps advancing outlives its no-progress window as many times as it needs", async () => {
  const result = await new SpawnCommandRunner({ killGraceMs: 15 }).run({
    command: process.execPath,
    args: ["--eval", progressingChild],
    harness: "fake",
    stdin: "",
    timeoutMs: 300,
    timeoutKind: "no-progress",
    signal: new AbortController().signal,
  });
  assert.equal(result.timedOut, false,
    "a live turn is never cut by its duration: the 45-min and 30-min caps killed turns that were still working (29-09)");
  assert.equal(result.stdout, "done");
  assert.doesNotMatch(result.stderr, /<<cauce:progress>>/u, "progress marks are transport, not harness output");
});

test("a silent turn dies once its no-progress window passes", async () => {
  const result = await new SpawnCommandRunner({ killGraceMs: 15 }).run({
    command: process.execPath,
    args: ["--eval", "setTimeout(() => {}, 60_000)"],
    harness: "fake",
    stdin: "",
    timeoutMs: 300,
    timeoutKind: "no-progress",
    signal: new AbortController().signal,
  });
  assert.equal(result.timedOut, true, "a hung harness does not raise an error; it goes quiet");
});

test("a sender-requested hard timeout still caps a chatty turn", async () => {
  const result = await new SpawnCommandRunner({ killGraceMs: 15 }).run({
    command: process.execPath,
    args: ["--eval", progressingChild],
    harness: "fake",
    stdin: "",
    timeoutMs: 300,
    signal: new AbortController().signal,
  });
  assert.equal(result.timedOut, true, "body.timeout_ms is the sender's explicit cap and keeps wall-clock semantics");
});
