import assert from "node:assert/strict";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError } from "../src/sdk/errors.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  HarnessDefinition,
} from "../src/sdk/types.js";
import { HARNESS_START_MARKER } from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";
import {
  esDiagnosticoDeArranque,
  nuncaEmpezoElTurno,
  sinMarcaDeArranque,
} from "../src/harnesses/shared.js";

/**
 * R1 and R2 of the retry policy.
 *
 * What these tests defend is NOT "retry more". It is the distinction between "did nothing"
 * and "we do not know if it did anything", which is why half the cases here assert that an
 * AMBIGUOUS delivery is still not retried. A test that only checked the new retries would
 * let through the regression that really matters: duplicating work that already had effects.
 *
 * "Pre-flight" failures (no structured output and no effects) are classified with
 * `retryable=true` only when it can be guaranteed the process did not begin its execution.
 */

const stateRoot = resolve(".test-state");

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
    await adapter.execute({ prompt: "hacé el trabajo", timeoutMs: 2_000, signal });
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

test("R1: un diagnóstico de arranque del CLI basta aunque el transporte no atestigüe", async () => {
  // claude has no declared witness (`--print --output-format json` only writes at the end), but
  // the CLI itself says it gave up before opening the turn.
  const error = await ejecutar(
    HARNESS_DEFINITIONS.claude,
    fixedRunner({ stdout: "", stderr: "Error: Session ID 7f3a is already in use.\n" }),
    "r1-diagnostico",
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

test("R1 NO reintenta cuando lo matamos nosotros: señal, timeout o cancelación son ambiguos", () => {
  const base: CommandRunResult = {
    stdout: "",
    stderr: "Error loading config.toml: unknown variant `writes`",
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
  };
  const detalle = base.stderr;
  assert.equal(nuncaEmpezoElTurno({ ...base, exitCode: 1 }, detalle), true);
  assert.equal(nuncaEmpezoElTurno({ ...base, signal: "SIGKILL" }, detalle), false);
  assert.equal(nuncaEmpezoElTurno({ ...base, exitCode: 1, timedOut: true }, detalle), false);
  assert.equal(nuncaEmpezoElTurno({ ...base, exitCode: 1, cancelled: true }, detalle), false);
  assert.equal(nuncaEmpezoElTurno({ ...base, exitCode: null }, detalle), false);
});

test("el diagnóstico de arranque es una lista blanca: lo que no coincide sigue siendo ambiguo", () => {
  for (const arranque of [
    "Error loading config.toml: unknown variant `writes`, expected one of `auto`",
    "Error: thread/resume: thread/resume failed: failed to resolve rollout",
    "no rollout found for thread 019",
    "Error: Session ID 7f3a-11 is already in use.",
    "No conversation found with session ID: 019",
    "/bin/sh: 1: codex: command not found",
    "error: unexpected argument '--jsonl' found",
    "openclaw stdin bridge failed: OpenClaw modules were absent or ambiguous",
  ]) {
    assert.equal(esDiagnosticoDeArranque(arranque), true, arranque);
  }
  for (const enMedio of [
    "TypeError: Cannot read properties of undefined",
    "FATAL ERROR: JavaScript heap out of memory",
    "thread 'main' panicked at src/main.rs:42",
    "Killed",
    // Outside the whitelist ON PURPOSE: a provider runs out mid-turn with this same text, after
    // the agent has already had effects. It costs 26 measured deliveries and it pays them.
    "hermes -z: agent failed: Codex provider quota exhausted",
    "hermes -z: agent failed: No usable credentials found for provider codex",
    "",
    undefined,
  ]) {
    assert.equal(esDiagnosticoDeArranque(enMedio), false, String(enMedio));
  }
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

test("R2 NO se aplica a otras causas de cancelación: sólo el apagado es infraestructura", async () => {
  for (const motivo of [
    new AdapterError("STALE_EPOCH", "Rejected epoch 3; active epoch is 4", false),
    new AdapterError("CLAIM_OWNERSHIP_LOST", "Claim is no longer ours", false),
  ]) {
    const controller = new AbortController();
    const error = await ejecutar(
      HARNESS_DEFINITIONS.codex,
      runnerQueAborta(controller, motivo, { harnessStarted: false, exitCode: 143 }),
      `r2-otro-${motivo.code}`,
      controller.signal,
    );
    assert.equal(error.code, "EXECUTION_CANCELLED_AMBIGUOUS");
    assert.equal(error.retryable, false);
  }
});

/* -------------------------------------------------- testigo y transporte -- */

test("el testigo declarado viaja hasta el transporte, y sólo el de este harness", async () => {
  // The transport keeps the request and fails: what is measured is what ARRIVES to it, not the
  // result. So each harness is exercised with its own `parse` without fabricating a different
  // output per format.
  const capturados: CommandRunRequest[] = [];
  const runner: CommandRunner = {
    run: async (request) => {
      capturados.push(request);
      return { stdout: "", stderr: "", exitCode: 1, signal: null, timedOut: false, cancelled: false };
    },
  };
  for (const definition of [
    HARNESS_DEFINITIONS.codex,
    HARNESS_DEFINITIONS.hermes,
    HARNESS_DEFINITIONS.openclaw,
    HARNESS_DEFINITIONS.claude,
  ]) {
    const adapter = new HarnessAdapter({
      definition,
      runner,
      store: await freshStore(`testigo-${definition.id}`),
    });
    await adapter.execute({
      prompt: "hola",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    }).catch(() => undefined);
  }
  assert.deepEqual(capturados.map((request) => request.startWitness?.kind), [
    "stdout-first-byte",
    "stderr-marker",
    "stderr-marker",
    undefined,
  ]);
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

test("un transporte que NO ve bytes nunca atestigua, aunque el harness declare testigo", async () => {
  // The gap this test closes: `codex` declares a witness, but under a shared session the
  // transport harvests a tmux panel and never sees a single byte from the harness. If the
  // engine trusted the harness over the transport, it would stop sealing `execution_started_at`
  // and a half-hour turn that loses its final ACK would have to be paid for again.
  const cosechador: CommandRunner = {
    run: async () => ({
      stdout: "", stderr: "", exitCode: 1, signal: null, timedOut: false, cancelled: false,
    }),
  };
  const conProceso = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.codex,
    runner: new SpawnCommandRunner(),
    store: await freshStore("testigo-proceso"),
  });
  const conCosecha = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.codex,
    runner: cosechador,
    store: await freshStore("testigo-cosecha"),
  });
  assert.equal(conProceso.witnessesHarnessStart, true);
  assert.equal(conCosecha.witnessesHarnessStart, false);

  const sinCosechar = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner: new SpawnCommandRunner(),
    store: await freshStore("testigo-sin-declarar"),
  });
  assert.equal(sinCosechar.witnessesHarnessStart, false);
});

test("la marca de arranque no ensucia la causa que ve el operador", () => {
  const stderr = `${HARNESS_START_MARKER}\nhermes -z: agent failed: quota exhausted\n`;
  assert.equal(sinMarcaDeArranque(stderr).includes(HARNESS_START_MARKER), false);
  assert.match(sinMarcaDeArranque(stderr), /quota exhausted/u);
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
