/**
 * Getting out of a quarantine WITHOUT a human respawning the pane.
 *
 * A quarantine marks a generation whose turn did not reach an observable terminal boundary, so it
 * is not reused. Until now it only lifted when the pane generation CHANGED (`stale`), which in
 * practice meant a person killing and recreating the TUI: inside a live generation it was
 * permanent, and every delivery from then on came out as `session_identity_unverified` and went to
 * the isolated transport, and the shared conversation stopped receiving anything.
 *
 * What these tests fix is that a live generation which PROVES it is healthy —not generating, free
 * and empty input box, same pane and PID— releases its own quarantine. And what they defend is the
 * opposite side: a pending this process did not arm keeps needing the envelope proof, because only
 * that one credits a terminal boundary nobody in this process saw.
 *
 * None of this can execute a delivery twice: the one that armed the quarantine already ended
 * AMBIGUOUS and is never resent from here. What is released is the pane, for the NEXT delivery.
 */
import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CommandRunResult } from "../src/sdk/types.js";
import type { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import type { TranscriptEntry } from "../src/shared-session/transcript.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  FakeTmux,
  RecordingFallback,
  assistantEntry,
  claudeRunner,
  correlationIdFromPrompt,
  envelopeText,
  freshState,
  userEntry,
} from "./shared-session-fixtures.js";

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1)));

function runOnce(
  runner: PasteSessionRunner<TranscriptEntry>,
  stdin: string,
): Promise<CommandRunResult> {
  return runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
}

async function pendingSidecars(state: string): Promise<string[]> {
  return (await readdir(state)).filter((name) => name.endsWith(".pending"));
}

/** The delivery whose paste is lost and leaves the generation quarantined. */
function losePaste(tmux: FakeTmux): void {
  tmux.onSubmit = () => undefined;
}

test("la cuarentena de la generación VIVA se levanta sola cuando el panel vuelve a estar ocioso", async () => {
  const { state, home, workspace } = await freshState("cuarentena-autocura");
  const quarantineFile = join(state, "quarantine");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "turno previo", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  losePaste(tmux);

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    turnTimeoutMs: 600_000,
    sleep: realSleep,
  });

  const first = await runOnce(runner, "la que se pierde");
  assert.equal(first.timedOut, true, first.stderr);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.match(await readFile(quarantineFile, "utf8"), /^\$0:@0:%0:4242\n$/u);
  assert.equal((await pendingSidecars(state)).length, 1, "el pending del pegado sigue en disco");

  // The generation does not change: same pane, same PID, same conversation. What changes is that
  // the panel is idle again — no "esc to interrupt" band and an empty prompt.
  assert.equal(tmux.panePid, "4242");
  assert.equal(tmux.paneContent, "❯ ");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), userUuid, envelopeText("la siguiente sí"), sessionId)}\n`,
    );
  };

  const second = await runOnce(runner, "la siguiente");

  // Before this fix the quarantine was permanent within the generation: this went to the isolated
  // transport and the shared conversation never saw the delivery again.
  assert.equal(fallback.calls, 0, "no debió degradar al transporte aislado");
  assert.equal(tmux.submittedCount, 2, "la segunda entrega sí entró por el panel");
  assert.equal(second.timedOut, false);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.match(second.stdout, /la siguiente sí/u);
  // And the release is complete on the three surfaces, not just in memory.
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
  await assert.rejects(readFile(quarantineFile, "utf8"), { code: "ENOENT" });
  assert.deepEqual(await pendingSidecars(state), []);
});

test("un pending de la MISMA generación que este proceso no armó NO se autocura con el panel ocioso", async () => {
  const { state, home, workspace } = await freshState("cuarentena-ajena");
  const quarantineFile = join(state, "quarantine");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  await appendFile(file, `${userEntry(randomUUID(), null, "turno previo", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  losePaste(tmux);

  const primero = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    turnTimeoutMs: 600_000,
    sleep: realSleep,
  });
  const first = await runOnce(primero, "la que se pierde");
  assert.equal(first.timedOut, true, first.stderr);
  const sidecarsTrasLaPerdida = await pendingSidecars(state);
  assert.equal(sidecarsTrasLaPerdida.length, 1);

  // A DIFFERENT process —the adapter restarted— inherits an idle panel of the same generation and
  // a pending it never armed. It cannot know whether that turn finished: only the envelope of that
  // exact nonce credits it, and there is none. The barrier holds.
  assert.equal(tmux.paneContent, "❯ ");
  tmux.onSubmit = () => undefined;
  const reiniciado = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback, quarantineFile,
  });
  const second = await runOnce(reiniciado, "tras el reinicio");

  assert.equal(fallback.calls, 1, "debió degradar: la cuarentena ajena no se levanta sola");
  assert.equal(tmux.submittedCount, 1, "no se pegó nada en el panel");
  assert.equal(second.cancelled, false);
  // And nothing was half-cleared: the three marks survive intact.
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.match(await readFile(quarantineFile, "utf8"), /^\$0:@0:%0:4242\n$/u);
  assert.deepEqual(await pendingSidecars(state), sidecarsTrasLaPerdida);
});

test("el sobre que llega tarde levanta la cuarentena aunque el panel siga generando", async () => {
  const { state, home, workspace } = await freshState("cuarentena-sobre-tardio");
  const quarantineFile = join(state, "quarantine");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "turno previo", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  let perdido: string | undefined;
  tmux.onSubmit = (text) => {
    perdido = correlationIdFromPrompt(text);
  };

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    turnTimeoutMs: 600_000,
    sleep: realSleep,
  });

  const first = await runOnce(runner, "la que se dio por perdida");
  assert.equal(first.timedOut, true, first.stderr);
  assert.ok(perdido !== undefined);

  // The merged turn DID finish, hours later, and emitted the envelope of that exact nonce. The
  // panel is busy again with the owner's next turn, so the idle path cannot help: the only thing
  // that lifts the quarantine here is the envelope proof.
  await appendFile(
    file,
    `${assistantEntry(randomUUID(), head, envelopeText("tardísimo", perdido), sessionId)}\n`,
  );
  tmux.paneContent = "✻ Herding… (esc to interrupt)\n❯ ";
  tmux.onSubmit = async (text) => {
    await appendFile(
      file,
      `${assistantEntry(
        randomUUID(),
        head,
        envelopeText("la siguiente sí", correlationIdFromPrompt(text)),
        sessionId,
      )}\n`,
    );
  };

  const second = await runOnce(runner, "la siguiente");

  // Before this fix the durable marks WERE cleaned by `reconcileTerminalPending` and the delivery
  // degraded anyway: the in-memory latch answered "current" with no evidence left behind it, and
  // only restarting the adapter or respawning the pane cleared it.
  assert.equal(fallback.calls, 0, "no debió degradar al transporte aislado");
  assert.equal(tmux.submittedCount, 2);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.match(second.stdout, /la siguiente sí/u);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
  assert.deepEqual(await pendingSidecars(state), []);
});

test("el panel OCUPADO no levanta la cuarentena: ni generando ni con un pegado sin enviar", async () => {
  const { state, home, workspace } = await freshState("cuarentena-panel-ocupado");
  const quarantineFile = join(state, "quarantine");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  await appendFile(file, `${userEntry(randomUUID(), null, "turno previo", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  losePaste(tmux);

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    turnTimeoutMs: 600_000,
    sleep: realSleep,
  });
  const first = await runOnce(runner, "la que se pierde");
  assert.equal(first.timedOut, true, first.stderr);

  // Still generating: the turn that swallowed the paste may be alive, so nothing is released.
  tmux.paneContent = "✻ Herding… (esc to interrupt)\n❯ ";
  const conTurnoEnCurso = await runOnce(runner, "mientras genera");
  assert.equal(fallback.calls, 1, "generando NO es sano");
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.match(await readFile(quarantineFile, "utf8"), /^\$0:@0:%0:4242\n$/u);
  assert.equal(conTurnoEnCurso.cancelled, false);

  // Idle band, but the owner has something typed in the box: pasting would concatenate onto it.
  tmux.paneContent = "❯ estoy escribiendo yo";
  await runOnce(runner, "mientras el dueño escribe");
  assert.equal(fallback.calls, 2, "una caja ocupada NO es sana");
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.equal(tmux.submittedCount, 1);
});
