import assert from "node:assert/strict";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type { CommandRunResult, SafeRunnerLog } from "../src/sdk/types.js";

/**
 * BUG 1 — `terminate()` era un no-op cuando el hijo ya había salido y sus tuberías seguían
 * abiertas. `close` no llega nunca mientras un descendiente conserve stdout/stderr, así que la
 * promesa del runner quedaba viva PARA SIEMPRE: el timeout disparaba y se rendía en la primera
 * línea (`if (child.exitCode !== null) return`), y la cancelación tampoco cerraba nada.
 *
 * Cada test de acá abajo se cuelga sin arreglo, que es exactamente lo que hay que demostrar; por
 * eso todo pasa por `withDeadline`, para que el caso roto FALLE con un mensaje en vez de dejar
 * plantado al corredor.
 */
const FIXTURE = resolve("test/fixtures/orphan-pipe-tree.mjs");
const stateRoot = resolve(".test-state/orphan-pipes");
const skipOnWindows = { skip: process.platform === "win32" };

async function markerPath(name: string): Promise<string> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return resolve(directory, "grandchild-survived");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what}: la entrega quedó colgada más de ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("un nieto que hereda stdout no cuelga la entrega para siempre", skipOnWindows, async () => {
  const marker = await markerPath("drain");
  const payload = '{"reply":"trabajo terminado","messages":[],"status":"done","retryable":false,"artifacts":[]}';
  const events: SafeRunnerLog[] = [];
  const runner = new SpawnCommandRunner({
    killGraceMs: 15,
    orphanPipeGraceMs: 150,
    logger: (entry) => events.push(entry),
  });

  const result = await withDeadline(
    runner.run({
      command: process.execPath,
      // El nieto sobrevive 60 s y escribiría su marcador a los 400 ms si nadie lo mata.
      args: [FIXTURE, marker, payload, "60000", "400"],
      harness: "fake",
      stdin: "orphan pipe drain",
      // Un timeout agéntico realista: NADA puede depender de que expire.
      timeoutMs: 3_600_000,
      signal: new AbortController().signal,
    }),
    10_000,
    "nieto con stdout heredado",
  );

  // El turno terminó bien: la salida del harness se conserva entera, no se pierde el trabajo.
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), payload);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  // Y queda huella operativa de por qué se cerró.
  assert.equal(events.some((entry) => entry.event === "orphaned_pipes"), true);

  // Matar el pid del hijo no alcanzaba: el nieto es quien tenía los descriptores.
  await sleep(600);
  assert.equal(await exists(marker), false, "el nieto sobrevivió a la cosecha del grupo");
});

test("el timeout dispara aunque el hijo ya haya salido con las tuberías tomadas", skipOnWindows, async () => {
  const marker = await markerPath("timeout");
  // Ventana de tuberías larguísima: sólo el timeout puede cerrar esta entrega.
  const runner = new SpawnCommandRunner({ killGraceMs: 15, orphanPipeGraceMs: 600_000 });

  const result = await withDeadline(
    runner.run({
      command: process.execPath,
      args: [FIXTURE, marker, "", "60000", "400"],
      harness: "fake",
      stdin: "orphan pipe timeout",
      timeoutMs: 250,
      signal: new AbortController().signal,
    }),
    10_000,
    "timeout con hijo ya salido",
  );

  assert.equal(result.timedOut, true);
  await sleep(600);
  assert.equal(await exists(marker), false, "el nieto sobrevivió al timeout");
});

test("la cancelación cierra la entrega aunque el hijo ya haya salido", skipOnWindows, async () => {
  const marker = await markerPath("cancel");
  const controller = new AbortController();
  const runner = new SpawnCommandRunner({ killGraceMs: 15, orphanPipeGraceMs: 600_000 });

  const running: Promise<CommandRunResult> = runner.run({
    command: process.execPath,
    args: [FIXTURE, marker, "", "60000", "400"],
    harness: "fake",
    stdin: "orphan pipe cancel",
    timeoutMs: 3_600_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);

  const result = await withDeadline(running, 10_000, "cancelación con hijo ya salido");

  assert.equal(result.cancelled, true);
  await sleep(600);
  assert.equal(await exists(marker), false, "el nieto sobrevivió a la cancelación");
});

test("el límite de salida sigue siendo ambiguo cuando un nieto retiene las tuberías", skipOnWindows, async () => {
  const marker = await markerPath("output-limit");
  const runner = new SpawnCommandRunner({ maxOutputBytes: 16, killGraceMs: 15, orphanPipeGraceMs: 150 });

  await withDeadline(
    assert.rejects(
      runner.run({
        command: process.execPath,
        args: [FIXTURE, marker, "x".repeat(4096), "60000", "400"],
        harness: "fake",
        stdin: "orphan pipe output limit",
        timeoutMs: 3_600_000,
        signal: new AbortController().signal,
      }),
      /OUTPUT_LIMIT_AMBIGUOUS|exceeded the configured limit/u,
    ),
    10_000,
    "límite de salida con hijo ya salido",
  );
});
