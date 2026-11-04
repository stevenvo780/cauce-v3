import assert from "node:assert/strict";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import type { CommandRunRequest } from "../src/sdk/types.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  FakeTmux,
  adapterFor,
  ambiguousTmuxResult,
  claudeRunner,
  execute,
  freshState,
  userEntry,
} from "./shared-session-fixtures.js";
import type { TmuxResult } from "./shared-session-fixtures.js";

const PASTE = /paste-buffer -b (\S+)/u;
const isMutation = (args: readonly string[], command: string): boolean =>
  args[0] === "if-shell" && args.some((argument) => argument.includes(command));

/** tmux loses the paste's result after the text landed in the box. Enter is never sent. */
function losePasteResult(tmux: FakeTmux, onPaste?: (text: string) => Promise<void>): void {
  const originalRun = tmux.run.bind(tmux);
  let lost = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (!lost && isMutation(args, "paste-buffer")) {
      lost = true;
      const name = args.map((argument) => PASTE.exec(argument)?.[1]).find((value) => value !== undefined);
      const text = name === undefined ? "" : tmux.buffers.get(name) ?? "";
      tmux.inputContent += text;
      await onPaste?.(text);
      return ambiguousTmuxResult("paste result lost");
    }
    return originalRun(args, stdin, control);
  };
}

/** perseo d40e3c05: killing the last pane takes the tmux server down before it answers. */
function killTakesServerDown(tmux: FakeTmux, stderr: string): void {
  const originalRun = tmux.run.bind(tmux);
  let serverGone = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (serverGone) return { exitCode: 1, stdout: "", stderr };
    if (isMutation(args, "kill-pane")) {
      serverGone = true;
      tmux.sessionExists = false;
      return ambiguousTmuxResult("server exited before answering");
    }
    return originalRun(args, stdin, control);
  };
}

function request(stdin = "pedido que nunca salió"): CommandRunRequest {
  return { command: "claude", args: [], harness: "claude", stdin, timeoutMs: 10_000, signal: new AbortController().signal };
}

async function pendingSidecars(state: string): Promise<string[]> {
  return (await readdir(state)).filter((name) => name.endsWith(".pending"));
}

test("un pegado ambiguo sin Enter, con la generación terminada y sin rastro, se reintenta", async () => {
  const { state, home, workspace } = await freshState("pegado-ambiguo-sin-enter");
  const tmux = new FakeTmux();
  losePasteResult(tmux);
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, quarantineFile: join(state, "quarantine") });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, false);
  assert.match(outcome.stderr, /^prompt_not_submitted: tmux perdió el resultado de la mutación/u);
  const degradation = runner.takeDegradation();
  assert.equal(degradation?.reason, "prompt_not_submitted");
  assert.equal(degradation.executionPrevented, true);
  assert.equal(degradation.fellBack, false);
  assert.equal(tmux.submittedCount, 0);
  assert.equal(tmux.calls.some((call) => call.includes("Enter")), false, "Enter nunca salió");
  assert.equal(tmux.sessionExists, false, "la generación ambigua se terminó");
  assert.deepEqual(await pendingSidecars(state), [], "no queda pending de un pedido que no llegó");
});

test("el adaptador lo entrega como PROMPT_NOT_SUBMITTED reintentable", async () => {
  const { state, home, workspace } = await freshState("pegado-ambiguo-adaptador");
  const tmux = new FakeTmux();
  losePasteResult(tmux);
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, quarantineFile: join(state, "quarantine") });
  const adapter = await adapterFor(runner, state, "kratos", "claude");

  await assert.rejects(execute(adapter), (error: unknown) => {
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.code, "PROMPT_NOT_SUBMITTED");
    assert.equal(error.retryable, true);
    assert.match(error.message, /No hay que reenviarlo/u);
    return true;
  });
});

test("perseo: el kill tumba el servidor tmux sin respuesta y aun así se acredita que no salió", async () => {
  const { state, home, workspace } = await freshState("pegado-ambiguo-servidor-caido");
  const tmux = new FakeTmux();
  losePasteResult(tmux);
  killTakesServerDown(tmux, "no server running on /home/node/.cauce/perseo/tmux-1000/cauce\n");
  const runner = claudeRunner({ alias: "perseo", home, workspace, tmux, quarantineFile: join(state, "quarantine") });

  const outcome = await runner.run(request());

  assert.equal(outcome.harnessStarted, false);
  assert.equal(runner.takeDegradation()?.reason, "prompt_not_submitted");
  assert.deepEqual(await pendingSidecars(state), []);
});

test("si el servidor no responde por otra causa no hay prueba y queda ambiguo", async () => {
  const { state, home, workspace } = await freshState("pegado-ambiguo-servidor-sin-permiso");
  const tmux = new FakeTmux();
  losePasteResult(tmux);
  killTakesServerDown(tmux, "error connecting to /home/node/.cauce/perseo/tmux-1000/cauce (Permission denied)\n");
  const runner = claudeRunner({ alias: "perseo", home, workspace, tmux, quarantineFile: join(state, "quarantine") });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.notEqual(outcome.harnessStarted, false);
  assert.match(outcome.stderr, /el estado de ejecución es ambiguo/u);
  assert.equal(runner.takeDegradation(), undefined);
  assert.equal((await pendingSidecars(state)).length, 1, "el pending sigue protegiendo la generación");
});

test("si la generación sobrevive, alguien podría pulsar Enter: queda ambiguo", async () => {
  const { state, home, workspace } = await freshState("pegado-ambiguo-generacion-viva");
  const tmux = new FakeTmux();
  tmux.failKillPane = true;
  losePasteResult(tmux);
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, quarantineFile: join(state, "quarantine") });
  const adapter = await adapterFor(runner, state, "kratos", "claude");

  await assert.rejects(execute(adapter), (error: unknown) => {
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.code, "PROCESS_EXIT_AMBIGUOUS");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(tmux.sessionExists, true);
  assert.equal((await pendingSidecars(state)).length, 1);
});

test("si el registro de la terminal tiene el pedido, no se reintenta", async () => {
  const { state, home, workspace } = await freshState("pegado-ambiguo-en-registro");
  const sessionId = randomUUID();
  const file = join(transcriptDirectory(home, workspace), `${sessionId}.jsonl`);
  await appendFile(file, `${userEntry(randomUUID(), null, "turno previo", sessionId)}\n`);
  const tmux = new FakeTmux();
  losePasteResult(tmux, async (text) => {
    await appendFile(file, `${userEntry(randomUUID(), null, text, sessionId)}\n`);
  });
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, quarantineFile: join(state, "quarantine") });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /el estado de ejecución es ambiguo/u);
  assert.equal(runner.takeDegradation(), undefined);
  assert.equal(tmux.sessionExists, false);
});

test("un Enter ambiguo nunca se reintenta aunque la generación ya no exista", async () => {
  const { state, home, workspace } = await freshState("enter-ambiguo-no-reintenta");
  const tmux = new FakeTmux();
  tmux.failEnter = true;
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, quarantineFile: join(state, "quarantine") });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /el estado de ejecución es ambiguo/u);
  assert.equal(runner.takeDegradation(), undefined);
  assert.ok(tmux.calls.some((call) => call.includes("Enter")), "Enter sí se intentó");
});
