import assert from "node:assert/strict";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type { CommandRunResult, SafeRunnerLog } from "../src/sdk/types.js";
import { testStateRoot } from "./test-state.js";

/**
 * BUG 1 — `terminate()` was a no-op when the child had already exited and its pipes were still
 * open. `close` never arrives while a descendant keeps stdout/stderr, so the runner's promise
 * stayed alive FOREVER: the timeout fired and gave up on the first line (`if (child.exitCode !==
 * null) return`), and cancellation also closed nothing.
 *
 * Every test below would hang without the fix, which is exactly what must be demonstrated;
 * that is why everything goes through `withDeadline`, so the broken case FAILS with a message
 * instead of leaving the runner stuck.
 */
const FIXTURE = resolve("test/fixtures/orphan-pipe-tree.mjs");
const stateRoot = testStateRoot("orphan-pipes");
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
    timer = setTimeout(() => { fail(new Error(`${what}: la entrega quedó colgada más de ${String(ms)} ms`)); }, ms);
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
      // The grandchild survives 60 s and would write its marker at 400 ms if nobody kills it.
      args: [FIXTURE, marker, payload, "60000", "400"],
      harness: "fake",
      stdin: "orphan pipe drain",
      // A realistic agent timeout: NOTHING may depend on it expiring.
      timeoutMs: 3_600_000,
      signal: new AbortController().signal,
    }),
    10_000,
    "nieto con stdout heredado",
  );

  // The turn finished well: the harness output is kept intact, the work is not lost.
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), payload);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  // And there is an operational trail of why it was closed.
  assert.equal(events.some((entry) => entry.event === "orphaned_pipes"), true);

  // Killing the child pid was not enough: the grandchild was the one holding the descriptors.
  await sleep(600);
  assert.equal(await exists(marker), false, "el nieto sobrevivió a la cosecha del grupo");
});

test("el timeout dispara aunque el hijo ya haya salido con las tuberías tomadas", skipOnWindows, async () => {
  const marker = await markerPath("timeout");
  // An enormous pipe window: only the timeout can close this delivery.
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
  setTimeout(() => { controller.abort(); }, 200);

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
