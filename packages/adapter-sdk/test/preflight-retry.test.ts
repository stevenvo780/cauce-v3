import assert from "node:assert/strict";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError } from "../src/sdk/errors.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type {
  CommandRunResult,
  CommandRunner,
  HarnessDefinition,
} from "../src/sdk/types.js";
import { HARNESS_START_MARKER } from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";
import {
  nuncaEmpezoElTurno,
} from "../src/harnesses/shared.js";
import { testStateRoot } from "./test-state.js";

const stateRoot = testStateRoot();

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

function fixedRunner(result: Partial<CommandRunResult>): CommandRunner {
  return {
    run: async (): Promise<CommandRunResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      ...result,
    }),
  };
}

async function ejecutar(
  definition: HarnessDefinition,
  runner: CommandRunner,
  name: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<AdapterError> {
  const adapter = new HarnessAdapter({
    definition,
    runner,
    store: await freshStore(name),
  });
  try {
    await adapter.execute({ prompt: "haz el trabajo", timeoutMs: 2_000, signal });
  } catch (error) {
    assert.ok(error instanceof AdapterError, `se esperaba un AdapterError, llegó ${String(error)}`);
    return error;
  }
  throw new Error("se esperaba un fallo del harness");
}

/* ------------------------------------------------------------------ R1 ---- */

test("R1: el testigo del transporte prueba que el turno nunca empezó y la entrega se reintenta", async () => {
  // codex declares `stdout-first-byte`: its `--json` mode writes its first thread event before
  // any model call. Zero bytes = the CLI gave up starting.
  const error = await ejecutar(
    HARNESS_DEFINITIONS.codex,
    fixedRunner({ stdout: "", stderr: "", harnessStarted: false }),
    "r1-testigo",
  );
  assert.equal(error.code, "PROCESS_EXIT_PREFLIGHT");
  assert.equal(error.retryable, true);
});

test("R1 NO reintenta una entrega que alcanzó a producir efectos: hubo salida por stdout", async () => {
  // The case the rule cannot break. The harness wrote over the turn channel —even if `parse`
  // does not understand it— so there was a turn: it could have called the model, written files,
  // or sent an email. Retrying would duplicate those effects.
  const error = await ejecutar(
    HARNESS_DEFINITIONS.codex,
    fixedRunner({
      stdout: '{"type":"thread.started"}\n{"type":"item.completed"}\n',
      stderr: "Error loading config.toml: unknown variant `writes`\n",
      harnessStarted: true,
    }),
    "r1-con-efectos",
  );
  assert.equal(error.code, "PROCESS_EXIT_AMBIGUOUS");
  assert.equal(error.retryable, false);
});

test("R1 NO reintenta un derrumbe a mitad de turno sin salida ni diagnóstico de arranque", async () => {
  // Empty stdout, exit on its own, but stderr does not say "I could not start": it says it
  // crashed. Indistinguishable from a turn that worked for twenty minutes and died before print.
  const error = await ejecutar(
    HARNESS_DEFINITIONS.claude,
    fixedRunner({
      stdout: "",
      stderr: "TypeError: Cannot read properties of undefined\n    at Object.<anonymous>\n",
    }),
    "r1-derrumbe",
  );
  assert.equal(error.code, "PROCESS_EXIT_AMBIGUOUS");
  assert.equal(error.retryable, false);
});

/* ------------------------------------------------- R1b: sesión fantasma ---- */

/**
 * The pointer to a native session the harness no longer finds has to be FORGOTTEN.
 *
 * Without this, R1 becomes a trap of its own making: the failure is retryable, the retry resumes
 */
test("R1b: la sesión nativa que ya no existe se OLVIDA, para que el reintento no repita el mismo fallo", async () => {
  const store = await freshStore("r1b-fantasma");
  const clave = "claude:shared:kratos";
  await store.setSession(clave, { native_id: "f7649225-0000-4000-8000-000000000000", initialized: true });
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner: fixedRunner({
      stdout: "",
      stderr: "No conversation found with session ID: f7649225-0000-4000-8000-000000000000\n",
    }),
    store,
  });

  await assert.rejects(
    adapter.execute({
      prompt: "haz el trabajo",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      sessionKey: "shared:kratos",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "PROCESS_EXIT_PREFLIGHT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(store.getSession(clave), undefined, "el puntero muerto sobrevivió al fallo");
});

/* ------------------------------------------------------------------ R2 ---- */

/**
 * Aborts DURING execution, which is when it really happens: `engine.stop()` aborts every
 * in-flight controller. Aborting before calling `execute` is no good for testing this — the
 * adapter cuts in its own guard and the transport never gets to weigh in.
 */
function runnerQueAborta(
  controller: AbortController,
  motivo: AdapterError,
  result: Partial<CommandRunResult>,
): CommandRunner {
  return {
    run: async (): Promise<CommandRunResult> => {
      controller.abort(motivo);
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        ...result,
      };
    },
  };
}

test("R2: el apagado del adaptador conserva su retryable al cruzar el transporte", async () => {
  const controller = new AbortController();
  const error = await ejecutar(
    HARNESS_DEFINITIONS.codex,
    runnerQueAborta(
      controller,
      new AdapterError("SHUTDOWN", "Adapter is stopping", true),
      { harnessStarted: false, exitCode: 143 },
    ),
    "r2-apagado",
    controller.signal,
  );
  assert.equal(error.code, "EXECUTION_CANCELLED_PREFLIGHT");
  assert.equal(error.retryable, true);
  assert.match(error.message, /SHUTDOWN/u);
});

test("R2 NO reintenta un apagado que cortó un turno YA en marcha", async () => {
  const controller = new AbortController();
  const error = await ejecutar(
    HARNESS_DEFINITIONS.codex,
    runnerQueAborta(
      controller,
      new AdapterError("SHUTDOWN", "Adapter is stopping", true),
      { stdout: '{"type":"thread.started"}\n', harnessStarted: true, exitCode: 143 },
    ),
    "r2-en-marcha",
    controller.signal,
  );
  assert.equal(error.code, "EXECUTION_CANCELLED_AMBIGUOUS");
  assert.equal(error.retryable, false);
});

test("el runner de procesos atestigua el primer byte y avisa una sola vez", async () => {
  const runner = new SpawnCommandRunner({ killGraceMs: 15 });
  const avisos: number[] = [];
  const conStdout = await runner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write('a');process.stdout.write('b');process.exit(0)"],
    harness: "fake",
    stdin: "",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    startWitness: { kind: "stdout-first-byte" },
    onHarnessStart: () => avisos.push(1),
  });
  assert.equal(conStdout.harnessStarted, true);
  assert.equal(avisos.length, 1);

  const sinNada = await runner.run({
    command: process.execPath,
    args: ["-e", "process.stderr.write('Error loading config.toml: unknown variant `writes`');process.exit(1)"],
    harness: "fake",
    stdin: "",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    startWitness: { kind: "stdout-first-byte" },
  });
  assert.equal(sinNada.harnessStarted, false);

  const conMarca = await runner.run({
    command: process.execPath,
    args: ["-e", `process.stderr.write(${JSON.stringify(`${HARNESS_START_MARKER}\n`)});process.exit(1)`],
    harness: "fake",
    stdin: "",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    startWitness: { kind: "stderr-marker", marker: HARNESS_START_MARKER },
  });
  assert.equal(conMarca.harnessStarted, true);

  // Without a declared witness the transport has no opinion, and `undefined` never enables pre-flight.
  const sinTestigo = await runner.run({
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    harness: "fake",
    stdin: "",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(sinTestigo.harnessStarted, undefined);
  assert.equal(nuncaEmpezoElTurno({ ...sinTestigo, exitCode: 1 }, undefined), false);
});

test("los dos puentes propios escriben la marca antes de la llamada efectiva", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const ruta of [
    "bridge/openclaw-stdin-bridge.mjs",
    "bridge/hermes-stdin-bridge.py",
  ]) {
    const fuente = await readFile(resolve(ruta), "utf8");
    assert.ok(fuente.includes(HARNESS_START_MARKER), `${ruta} no escribe la marca`);
  }
});
