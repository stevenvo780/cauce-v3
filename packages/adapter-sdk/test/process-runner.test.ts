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
  const inspectedKeys = ["HERMES_HOME", "HERMES_INFERENCE_MODEL", ...secretLikeKeys];
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
  const parentEnvironment: NodeJS.ProcessEnv = {
    HERMES_HOME: hermesHome,
    HERMES_INFERENCE_MODEL: hermesModel,
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
