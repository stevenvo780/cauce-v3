import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { claudeTranscript, type TranscriptEntry } from "../src/shared-session/transcript.js";
import type { TranscriptReader } from "../src/shared-session/types.js";
import {
  FakeTmux,
  RecordingFallback,
  TmuxResult,
  adapterFor,
  assistantEntry,
  claudeRunner,
  controlledDelayedTmuxMutation,
  controlledTmuxHang,
  envelopeText,
  execute,
  freshState,
  randomUUID,
  userEntry,
} from "./shared-session-fixtures.js";

test("un scan de transcript colgado no retrasa el plazo post-cancelación", async () => {
  const { home, workspace } = await freshState("abort-hung-transcript-scan");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const baseTranscript = claudeTranscript(join(home, ".claude"), workspace);
  let fileScans = 0;
  const transcript: TranscriptReader<TranscriptEntry> = {
    ...baseTranscript,
    files: () => {
      fileScans += 1;
      if (fileScans === 2) {
        controller.abort();
        return new Promise<readonly string[]>(() => undefined);
      }
      return baseTranscript.files();
    },
  };
  tmux.interruptStopsTurn = false;
  tmux.onSubmit = () => {
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  const runner = new PasteSessionRunner({
    alias: "kratos",
    harness: "claude",
    workspace,
    transcript,
    tmux,
    fallback,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
    acquireTimeoutMs: 30,
    turnTimeoutMs: 2_000,
    cancelDrainTimeoutMs: 15,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
  });

  const startedAt = Date.now();
  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "cancelar durante scan",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.ok(Date.now() - startedAt < 500, "el scan colgado no puede retener la cola");
  assert.equal(tmux.interruptedCount, 1);
  assert.match(outcome.stderr, /cuarentena/u);
});

test("un clearDegradation colgado después de Enter tampoco bloquea la cancelación", async () => {
  const { home, workspace } = await freshState("abort-hung-clear-degradation");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.interruptStopsTurn = false;
  tmux.onSubmit = () => {
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "set-option" && args.includes("-w")) {
      controller.abort();
      return controlledTmuxHang(control);
    }
    return originalRun(args, stdin, control);
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    cancelDrainTimeoutMs: 15,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  const startedAt = Date.now();
  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "cancelar durante limpieza visual",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.ok(Date.now() - startedAt < 500, "la limpieza visual no puede retener la cola");
  assert.equal(tmux.interruptedCount, 1);
  assert.match(outcome.stderr, /cuarentena/u);
});

test("Enter ambiguo nunca intenta C-u y deja cuarentena sin ejecutar fallback", async () => {
  const { home, workspace } = await freshState("enter-y-clear-fallan");
  const tmux = new FakeTmux();
  tmux.failEnter = true;
  tmux.failKillPane = true;
  const fallback = new RecordingFallback("{}");
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no duplicar aunque la caja quede armada",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(outcome.cancelled, false);
  assert.match(outcome.stderr, /Enter.*ambiguo.*cuarentena/u);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.equal(tmux.submittedCount, 0);
  assert.match(tmux.inputContent, /no duplicar/u);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.equal(fallback.calls, 0);

  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "la siguiente entrega tampoco reutiliza esa caja",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 0);
});

test("ni siquiera un C-u potencialmente exitoso se envía después de Enter ambiguo", async () => {
  const { home, workspace } = await freshState("enter-falla-clear-noop");
  const tmux = new FakeTmux();
  tmux.failEnter = true;
  tmux.failKillPane = true;
  tmux.clearInputNoop = true;
  const fallback = new RecordingFallback("{}");
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const first = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "la caja sigue armada aunque C-u diga cero",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(first.exitCode, 1);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /Enter.*ambiguo.*cuarentena/u);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.match(tmux.inputContent, /caja sigue armada/u);
  assert.equal(tmux.submittedCount, 0);
  assert.equal(fallback.calls, 0);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no pegar sobre la caja ambigua",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 0);
  assert.match(tmux.inputContent, /caja sigue armada/u);
});

test("Enter demorado se reapea sin mutar ni borrar input humano posterior", async () => {
  const { home, workspace } = await freshState("tmux-cuelga-post-paste");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  let postPaste = false;
  let enterClientReaped = false;
  let killClientReaped = false;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (postPaste && args[0] === "if-shell"
      && args.some((argument) => argument.includes("send-keys")
        && argument.includes("Enter"))) {
      const response = await controlledDelayedTmuxMutation(
        control,
        80,
        () => originalRun(args, stdin, control),
      );
      enterClientReaped = response.exitCode === null;
      return response;
    }
    if (postPaste && args[0] === "if-shell"
      && args.some((argument) => argument.includes("kill-pane"))) {
      const response = await controlledTmuxHang(control);
      killClientReaped = response.exitCode === null;
      return response;
    }
    const response = await originalRun(args, stdin, control);
    if (args[0] === "paste-buffer" && response.exitCode === 0) postPaste = true;
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineOperationTimeoutMs: 20,
  });

  const startedAt = Date.now();
  const first = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "el socket deja de responder después del paste",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.ok(Date.now() - startedAt < 500, "la incertidumbre de tmux debe quedar acotada");
  assert.equal(first.exitCode, 1);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /Enter.*ambiguo.*cuarentena/u);
  assert.equal(enterClientReaped, true);
  assert.equal(killClientReaped, true);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.match(tmux.inputContent, /socket deja de responder/u);
  assert.equal(fallback.calls, 0);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  tmux.inputContent += " TEXTO HUMANO POSTERIOR";
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(tmux.inputContent, /TEXTO HUMANO POSTERIOR$/u);
  assert.equal(tmux.submittedCount, 0, "el Enter demorado no puede revivir después del reap");

  postPaste = false;
  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no reutilizar después del cuelgue",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 0);
});

test("un rename post-paste compromete Enter y jamás intenta C-u", async () => {
  const { home, workspace } = await freshState("rename-clear-falla");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "paste-buffer" && response.exitCode === 0) {
      tmux.sessionName = "renombrada-por-humano";
    }
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback, turnTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "el cleanup del rename debe acreditarse",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /budget ended.*cuarentena/u);
  assert.equal(tmux.inputContent, "");
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.equal(tmux.calls.some((call) => call[0] === "send-keys" && call.includes("Enter")), true);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.equal(tmux.submittedCount, 1);
  assert.equal(fallback.calls, 0);
});

test("respawn-pane entre paste y Enter se detecta por PID aunque conserve pane_id", async () => {
  const { home, workspace } = await freshState("respawn-entre-paste-enter");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalPaneId = tmux.paneId;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "paste-buffer" && response.exitCode === 0) tmux.respawnPane();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no caer en proceso nuevo",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /generación cambió.*ambiguo/u);
  assert.equal(tmux.paneId, originalPaneId, "tmux preservó el pane id como en respawn-pane");
  assert.equal(tmux.submittedCount, 0);
  assert.equal(tmux.inputContent, "", "el proceso nuevo no heredó la caja del anterior");
  assert.equal(tmux.calls.some((call) => call[0] === "send-keys" && call.includes("Enter")), false);
  assert.equal(fallback.calls, 0);
});

test("un rename tras paste envía el prompt una vez y no usa C-u", async () => {
  const { home, workspace } = await freshState("rename-entre-paste-enter");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "paste-buffer" && response.exitCode === 0) {
      tmux.sessionName = "renombrada-por-humano";
    }
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback, turnTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no quedar armado",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /budget ended.*cuarentena/u);
  assert.equal(tmux.submittedCount, 1);
  assert.equal(tmux.inputContent, "");
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  await tmux.run(["send-keys", "-t", tmux.paneId, "Enter"]);
  assert.equal(tmux.submittedCount, 1);
  assert.equal(fallback.calls, 0);
});

test("reemplazar el mismo nombre después del paste falla cerrado antes de Enter", async () => {
  const { home, workspace } = await freshState("replacement-antes-enter");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalId = tmux.sessionId;
  let replacementId: string | undefined;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "paste-buffer") {
      replacementId = tmux.replaceSession({ alias: "kratos", harness: "claude" });
    }
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no debe caer en reemplazo",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /generación cambió.*ambiguo/u);
  assert.equal(tmux.sessionId, replacementId);
  assert.notEqual(replacementId, originalId);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.calls.some((call) => call.includes("Enter")), false);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(fallback.calls, 0);
});

test("una sesion viva sin panel de TUI se reporta como tui_absent, no como ausente", async () => {
  const { state, home, workspace } = await freshState("sin-panel");
  const tmux = new FakeTmux();
  tmux.sessionExists = true;
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  // The session answers has-session but the pane does not exist: the TUI died inside.
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    if (args[0] === "list-panes") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "display-message" && args[1] === "-p") return { exitCode: 1, stdout: "", stderr: "" };
    return originalRun(args, stdin);
  };
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("tui_absent"));
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "tui_absent");
});

test("la ventana de la TUI que no existe NO se confunde con otra ventana de la sesión", async () => {
  // If the window does not exist in the tmux session, it must be detected and degraded cleanly
  // by enumerating with `list-windows` and comparing for exact equality.
  const { state, home, workspace } = await freshState("ventana-fantasma");
  const tmux = new FakeTmux();
  tmux.sessionExists = true;
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  tmux.windows = ["servidor"]; // the `agente` window died at birth
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    // The real tmux LIES here: it answers for another window instead of failing.
    if (args[0] === "display-message" && args[1] === "-p") {
      return { exitCode: 0, stdout: "14667\n", stderr: "" };
    }
    return originalRun(args, stdin);
  };
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // It fell through to the usual path and said so, instead of believing the borrowed PID.
  assert.equal(fallback.calls, 1);
  assert.ok((output.reply ?? "").includes("tui_absent"));
  assert.equal((await readDegradations(state))[0]?.reason, "tui_absent");
});