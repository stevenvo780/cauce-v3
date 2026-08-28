import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inputBoxState } from "../src/shared-session/pane.js";
import { stripJsonFence } from "../src/shared-session/transcript.js";
import { CliTmux, withoutLifecycleIdentity } from "../src/shared-session/tmux.js";

test("la caja de entrada se reconoce ocupada en los casos medidos", () => {
  assert.equal(inputBoxState("❯ ").occupied, false);
  assert.equal(inputBoxState("linea\n❯ ").occupied, false);
  assert.equal(inputBoxState("❯ algo a medias").occupied, true);
  assert.equal(inputBoxState("│ ❯ dentro del recuadro │").occupied, true);
  // Un pegado sin enviar cuenta como ocupada aunque el cursor parezca libre.
  assert.equal(inputBoxState("[Pasted text #1 +12 lines]\n❯ ").occupied, true);
  assert.equal(inputBoxState("paste again to expand\n❯ ").occupied, true);
  // Fallar cerrado: sin panel legible no se inyecta.
  assert.equal(inputBoxState(undefined).occupied, true);
  assert.equal(inputBoxState("sin caja de entrada").occupied, true);
});

test("tmux no hereda la identidad de ciclo de vida del adaptador", () => {
  // Evita que el servidor tmux herede variables de entorno de ciclo de vida del adaptador.
  const limpio = withoutLifecycleIdentity({
    CAUCE_ALIAS: "atlas",
    CAUCE_STATE_DIR: "/home/dev/.local/state/cauce-v3/atlas",
    CAUCE_CONTROL_DIR: "/home/dev/.local/state/cauce-v3/atlas/control",
    CAUCE_CONTAINER_ID: "cauce-atlas",
    CAUCE_CONTAINER_GENERATION: "2d15ee55",
    PATH: "/usr/bin",
    HOME: "/home/dev",
  });
  // Las CINCO de `IDENTITY_ENV_KEYS`, no solo las tres que hoy mira el barrido de /proc.
  assert.equal(limpio.CAUCE_ALIAS, undefined);
  assert.equal(limpio.CAUCE_STATE_DIR, undefined);
  assert.equal(limpio.CAUCE_CONTROL_DIR, undefined);
  assert.equal(limpio.CAUCE_CONTAINER_ID, undefined);
  assert.equal(limpio.CAUCE_CONTAINER_GENERATION, undefined);
  // El resto del entorno NO se toca: la TUI arranca con lo que le hace falta.
  assert.equal(limpio.PATH, "/usr/bin");
  assert.equal(limpio.HOME, "/home/dev");
});

test("CliTmux cancela y reapea cada operación sin permitir una mutación tardía", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cauce-tmux-reap-"));
  const executable = join(scratch, "fake-tmux.mjs");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.CAUCE_TEST_PID_FILE, String(process.pid));',
    'setTimeout(() => writeFileSync(process.env.CAUCE_TEST_LATE_FILE, "MUTATED"), 300);',
    '// Ignorar TERM obliga a CliTmux a escalar a KILL antes de resolver.',
    'process.on("SIGTERM", () => undefined);',
    "setInterval(() => undefined, 1000);",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(executable, 0o700);

  try {
    const operations = [
      { name: "load", args: ["load-buffer", "-b", "safe", "-"], stdin: "safe-prompt" },
      {
        name: "mutate",
        args: [
          "if-shell", "-F", "1", "send-keys -t %0 Enter",
          "wait-for -S cauce-test-cas-rejected",
        ],
      },
      { name: "delete", args: ["delete-buffer", "-b", "safe"] },
      { name: "inspect", args: ["display-message", "-p", "-t", "%0", "#{pane_pid}"] },
      {
        name: "overwrite",
        args: ["load-buffer", "-b", "safe", "-"],
        stdin: "CAUCE_BUFFER_SCRUBBED",
      },
    ] as const;
    const lateFiles: string[] = [];
    for (const operation of operations) {
      for (const mode of ["timeout", "abort"] as const) {
        const stem = `${operation.name}-${mode}`;
        const pidFile = join(scratch, `${stem}.pid`);
        const lateFile = join(scratch, `${stem}.late`);
        lateFiles.push(lateFile);
        const controller = new AbortController();
        const tmux = new CliTmux(
          "fake-socket",
          {
            ...process.env,
            CAUCE_TEST_PID_FILE: pidFile,
            CAUCE_TEST_LATE_FILE: lateFile,
          },
          2_000,
          executable,
        );
        const pending = tmux.run(
          operation.args,
          "stdin" in operation ? operation.stdin : undefined,
          mode === "timeout"
            ? { timeoutMs: 100 }
            : { signal: controller.signal, timeoutMs: 2_000 },
        );

        let pidText: string | undefined;
        for (let attempt = 0; attempt < 100 && pidText === undefined; attempt += 1) {
          try {
            pidText = await readFile(pidFile, "utf8");
          } catch {
            await new Promise((resolveWait) => setTimeout(resolveWait, 5));
          }
        }
        if (pidText === undefined) {
          assert.equal(
            mode,
            "timeout",
            `el cliente ${stem} debe haber arrancado antes de una cancelación explícita`,
          );
          const outcome = await pending;
          assert.equal(outcome.exitCode, null);
          assert.match(outcome.stderr, /timed_out/u);
          continue;
        }
        const pid = Number(pidText);
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        if (mode === "abort") controller.abort();

        const outcome = await pending;
        assert.equal(outcome.exitCode, null);
        assert.match(outcome.stderr, mode === "timeout" ? /timed_out/u : /aborted/u);
        assert.throws(
          () => process.kill(pid, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
          `CliTmux no puede resolver ${stem} hasta que el PID ${pid} haya cerrado`,
        );
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    for (const lateFile of lateFiles) {
      await assert.rejects(
        readFile(lateFile, "utf8"),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        "ningún cliente reapeado puede mutar después de su deadline",
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("el cursor de codex se reconoce con los dos glifos que dibuja segun su version", () => {
  // codex 0.144.x dibuja `›` (U+203A); 0.145.0 lo redibujo como `»` (U+00BB). Los dos son la MISMA
  // caja de entrada: si uno no se reconoce, el panel queda "sin caja" y el turno degrada con
  // `modal_blocking` por un modal que no existe.
  for (const cursor of ["›", "»"]) {
    assert.equal(inputBoxState(`${cursor} `).occupied, false);
    assert.equal(inputBoxState(`conversacion previa\n${cursor} `).occupied, false);
    assert.equal(inputBoxState(`${cursor} algo a medias`).occupied, true);
    // Lo que NO debe pasar nunca: confundir la caja vacia con un dialogo a pantalla completa.
    assert.notEqual(inputBoxState(`conversacion previa\n${cursor} `).kind, "modal");
  }
});

test("el vallado Markdown se quita solo cuando envuelve todo el texto", () => {
  assert.equal(stripJsonFence("```json\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(stripJsonFence("```\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(stripJsonFence('{"a":1}'), '{"a":1}');
  // Un bloque de código EN MEDIO es contenido, no transporte: no se toca.
  const mixed = "texto\n```json\n{\"a\":1}\n```\nmas texto";
  assert.equal(stripJsonFence(mixed), mixed);
});