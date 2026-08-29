import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
} from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";

const stateRoot = resolve(".test-state");

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return Promise.resolve({
      stdout: JSON.stringify({ result: "listo" }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
  }
}

test("HarnessAdapter pasa al hijo el env de la cuenta resuelta", async () => {
  const runner = new RecordingRunner();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await freshStore("account-env-applied"),
    resolveCredentialEnv: () => Promise.resolve({
      CLAUDE_CONFIG_DIR: "/datos/agents/argos/.claude",
    }),
  });

  await adapter.execute({
    prompt: "hola",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(runner.requests.length, 1);
  assert.deepEqual(runner.requests[0]?.env, { CLAUDE_CONFIG_DIR: "/datos/agents/argos/.claude" });
});

test("sin resolutor el hijo se lanza SIN env añadido: comportamiento de hoy intacto", async () => {
  const runner = new RecordingRunner();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await freshStore("account-env-absent"),
  });

  await adapter.execute({
    prompt: "hola",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  // `undefined`, not `{}`: the runner must not even receive the key, so the
  // behavior is byte-for-byte identical to before this patch.
  assert.equal(runner.requests[0]?.env, undefined);
});

test("si el resolutor falla se sigue despachando sin override, no se cae la ejecución", async () => {
  // Skipping dispatch because we could not ask WHICH account to use would swap a cost problem
  // for an outage.
  const runner = new RecordingRunner();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await freshStore("account-env-resolver-fails"),
    resolveCredentialEnv: () => Promise.reject(new Error("gateway no responde")),
  });

  await adapter.execute({
    prompt: "hola",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(runner.requests.length, 1);
  assert.equal(runner.requests[0]?.env, undefined);
});
