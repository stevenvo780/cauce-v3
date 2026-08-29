import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { paneIdentity } from "../src/shared-session/tmux.js";
import {
  fileQuarantinePersistence,
  type QuarantinePersistence,
} from "../src/shared-session/paste-runner.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  ENVELOPE,
  FakeTmux,
  RecordingFallback,
  assistantEntry,
  claudeRunner,
  controlledTmuxHang,
  correlationIdFromPrompt,
  envelopeText,
  freshState,
  userEntry,
} from "./shared-session-fixtures.js";
import type { TmuxResult } from "./shared-session-fixtures.js";

test("cancelar después de Enter drena la TUI antes de liberar la cola", async () => {
  const { home, workspace } = await freshState("abort-post-enter");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "turno previo", sessionId)}\n`);
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  tmux.interruptStopsTurn = false;
  let submittedPrompt: string | undefined;
  let release!: () => void;
  const terminalMayFinish = new Promise<void>((resolveFinish) => {
    release = resolveFinish;
  });
  tmux.onSubmit = (text) => {
    submittedPrompt = text;
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
    void terminalMayFinish.then(async () => {
      const userUuid = randomUUID();
      await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
      await appendFile(
        file,
        `${assistantEntry(randomUUID(), userUuid, envelopeText("terminó"), sessionId)}\n`,
      );
      tmux.paneContent = "❯ ";
    });
  };
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "send-keys" && args.includes("Enter")) controller.abort();
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  let settled = false;
  const pending = runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "ejecutar una vez",
    timeoutMs: 10_000,
    signal: controller.signal,
  }).finally(() => {
    settled = true;
  });
  while (submittedPrompt === undefined) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(settled, false, "la llamada cancelada no puede liberar mientras la TUI sigue");
  release();

  const outcome = await pending;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  assert.equal(tmux.interruptedCount, 1);
  assert.match(outcome.stderr, /transcript confirmó/u);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
});

test("cancelación post-Enter acotada pone en cuarentena el pane exacto y la cola no se bloquea", async () => {
  const { home, workspace } = await freshState("abort-post-enter-quarantine");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  tmux.interruptStopsTurn = false;
  tmux.onSubmit = () => {
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "send-keys" && args.includes("Enter")) controller.abort();
    return response;
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

  const first = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "turno que no confirma cierre",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(first.cancelled, true);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /cuarentena/u);
  assert.equal(tmux.interruptedCount, 1);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  const second = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no reutilizar la TUI ambigua",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(second.cancelled, false);
  assert.equal(fallback.calls, 1, "la siguiente entrega progresa por el transporte aislado");
  assert.equal(tmux.submittedCount, 1, "la generación en cuarentena no recibe otro prompt");
});

test("una pantalla ociosa tras Escape no acredita cierre y la misma generación queda en cuarentena", async () => {
  const { home, workspace } = await freshState("abort-idle-no-es-terminal");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.onSubmit = () => {
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "send-keys" && args.includes("Enter")) controller.abort();
    return response;
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

  const pid = tmux.panePid;
  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "la pantalla no es un commit log",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(tmux.paneContent, "❯ ", "Escape volvió visualmente ociosa la TUI");
  assert.equal(tmux.panePid, pid, "la generación exacta sigue viva");
  assert.match(outcome.stderr, /no alcanzó un límite terminal.*cuarentena/u);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.equal(fallback.calls, 0);
});

test("la cuarentena en disco sobrevive a otro runner si tmux no pudo guardar su opción", async () => {
  const { state, home, workspace } = await freshState("abort-quarantine-durable");
  const quarantineFile = join(state, "quarantine");
  const tmux = new FakeTmux();
  tmux.failQuarantineWrite = true;
  tmux.interruptStopsTurn = false;
  tmux.onSubmit = () => {
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "send-keys" && args.includes("Enter")) controller.abort();
    return response;
  };
  const firstRunner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    cancelDrainTimeoutMs: 15,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  const first = await firstRunner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "turno sin cierre durable",
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  assert.equal(first.cancelled, true);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
  assert.match(await readFile(quarantineFile, "utf8"), /^\$0:@0:%0:4242\n$/u);

  // New instance: does not keep `locallyQuarantined`; only the durable evidence can block it.
  const restartedRunner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback, quarantineFile,
  });
  const second = await restartedRunner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no reutilizar tras restart",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(second.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1);
});

test("quarantine-pending sobrevive restart si disco, tmux y kill se cuelgan post-paste", async () => {
  const { state, home, workspace } = await freshState("quarantine-pending-operaciones-colgadas");
  const quarantineFile = join(state, "quarantine");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  let postPaste = false;
  let diskPromotionHung = false;
  let tmuxPromotionHung = false;
  let killHung = false;
  const persistence: QuarantinePersistence = {
    ...fileQuarantinePersistence,
    persist: async (path, identity) => {
      if (postPaste && path === quarantineFile) {
        diskPromotionHung = true;
        return new Promise<boolean>(() => undefined);
      }
      return fileQuarantinePersistence.persist(path, identity);
    },
  };
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (postPaste && args[0] === "set-option"
      && args.includes("@cauce_quarantined_pane")) {
      tmuxPromotionHung = true;
      return controlledTmuxHang(control);
    }
    if (postPaste && args[0] === "if-shell"
      && args.some((argument) => argument.includes("kill-pane"))) {
      killHung = true;
      return controlledTmuxHang(control);
    }
    const response = await originalRun(args, stdin, control);
    if (args[0] === "send-keys" && args.includes("Enter")) postPaste = true;
    return response;
  };
  const firstRunner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    quarantinePersistence: persistence,
    quarantineOperationTimeoutMs: 100,
    turnTimeoutMs: 15,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  const first = await firstRunner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "operaciones de promoción que no contestan",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(first.timedOut, true);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /quarantine-pending.*durable en disco/u);
  assert.equal(diskPromotionHung, true);
  assert.equal(tmuxPromotionHung, true);
  assert.equal(killHung, true);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  await assert.rejects(readFile(quarantineFile, "utf8"), { code: "ENOENT" });
  const pendingFiles = (await readdir(state)).filter((name) => name.startsWith("quarantine.")
    && name.endsWith(".pending"));
  assert.equal(pendingFiles.length, 1);
  assert.match(
    await readFile(join(state, pendingFiles[0] ?? "missing"), "utf8"),
    /^\$0:@0:%0:4242\n$/u,
  );

  // Simulates a runner restart and the loss of tmux redundancy. Only the real on-disk pending
  // remains, written BEFORE the paste; the test persistence no longer participates in this instance.
  postPaste = false;
  tmux.sessionOptions.delete("@cauce_quarantined_pane");
  const restartedRunner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    quarantineOperationTimeoutMs: 100,
  });
  const second = await restartedRunner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no reutilizar tras reiniciar el proceso",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(second.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1);
});

test("restart reconcilia pending sólo con sobre terminal válido del mismo nonce", async () => {
  const { state, home, workspace } = await freshState("pending-terminal-restart");
  const quarantineFile = join(state, "quarantine");
  const correlationId = "d".repeat(64);
  const tmux = new FakeTmux();
  const identity = await paneIdentity(tmux, tmux.paneId);
  assert.ok(identity);
  const pending = `${quarantineFile}.${correlationId}.pending`;
  assert.equal(await fileQuarantinePersistence.persist(pending, identity), true);
  tmux.sessionOptions.set("@cauce_quarantined_pane", "$0:@0:%0:4242");

  const directory = transcriptDirectory(home, workspace);
  const transcriptSession = randomUUID();
  const transcript = join(directory, `${transcriptSession}.jsonl`);
  await appendFile(
    transcript,
    `${assistantEntry(
      randomUUID(),
      randomUUID(),
      envelopeText("terminal antes del crash", correlationId),
      transcriptSession,
    )}\n`,
  );
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(transcript, `${userEntry(userUuid, null, text, transcriptSession)}\n`);
    await appendFile(
      transcript,
      `${assistantEntry(
        randomUUID(),
        userUuid,
        envelopeText("turno posterior", correlationIdFromPrompt(text)),
        transcriptSession,
      )}\n`,
    );
  };
  const fallback = new RecordingFallback("{}");
  const restarted = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback, quarantineFile,
  });

  const outcome = await restarted.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "usar la generación después de reconciliar",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.stdout, /turno posterior/u);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  await assert.rejects(readFile(pending, "utf8"), { code: "ENOENT" });
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
});

for (const falseTerminal of [
  {
    name: "otro correlation",
    text: envelopeText("sobre ajeno", "e".repeat(64)),
  },
  {
    name: "sobre contractual inválido",
    text: JSON.stringify({
      ...ENVELOPE,
      reply: 123,
      cauce_correlation_id: "f".repeat(64),
    }),
  },
] as const) {
  test(`${falseTerminal.name} no reconcilia quarantine-pending al reiniciar`, async () => {
    const { state, home, workspace } = await freshState(`pending-falso-${falseTerminal.name}`);
    const quarantineFile = join(state, "quarantine");
    const correlationId = "f".repeat(64);
    const pending = `${quarantineFile}.${correlationId}.pending`;
    const tmux = new FakeTmux();
    const identity = await paneIdentity(tmux, tmux.paneId);
    assert.ok(identity);
    assert.equal(await fileQuarantinePersistence.persist(pending, identity), true);
    tmux.sessionOptions.set("@cauce_quarantined_pane", "$0:@0:%0:4242");
    const transcriptSession = randomUUID();
    await appendFile(
      join(transcriptDirectory(home, workspace), `${transcriptSession}.jsonl`),
      `${assistantEntry(
        randomUUID(),
        randomUUID(),
        falseTerminal.text,
        transcriptSession,
      )}\n`,
    );
    const fallback = new RecordingFallback("{}");
    const restarted = claudeRunner({
      alias: "kratos", home, workspace, tmux, fallback, quarantineFile,
    });

    await restarted.run({
      command: "claude",
      args: [],
      harness: "claude",
      stdin: "no reutilizar con evidencia falsa",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    assert.equal(fallback.calls, 1);
    assert.equal(tmux.submittedCount, 0);
    assert.equal(await readFile(pending, "utf8"), "$0:@0:%0:4242\n");
    assert.equal(tmux.sessionOptions.get("@cauce_quarantined_pane"), "$0:@0:%0:4242");
  });
}

for (const incomplete of [
  { name: "temporal", file: ".quarantine.crash.tmp", body: "$0:@0:%0:" },
  { name: "pending incompleto", file: "quarantine.crash.pending", body: "$0:@0:%0:" },
] as const) {
  test(`${incomplete.name} de cuarentena bloquea un runner nuevo`, async () => {
    const { state, home, workspace } = await freshState(`quarantine-${incomplete.name}`);
    const quarantineFile = join(state, "quarantine");
    await appendFile(join(state, incomplete.file), incomplete.body);
    const tmux = new FakeTmux();
    const fallback = new RecordingFallback("{}");
    const runner = claudeRunner({
      alias: "kratos", home, workspace, tmux, fallback, quarantineFile,
    });

    const outcome = await runner.run({
      command: "claude",
      args: [],
      harness: "claude",
      stdin: "no pegar ante estado de disco incompleto",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    assert.equal(outcome.cancelled, false);
    assert.equal(fallback.calls, 1);
    assert.equal(tmux.used("load-buffer"), false);
    assert.equal(tmux.submittedCount, 0);
  });
}

test("un fallo al leer la cuarentena falla cerrado antes de pegar", async () => {
  const { home, workspace } = await freshState("quarantine-unreadable");
  const tmux = new FakeTmux();
  tmux.failQuarantineRead = true;
  const fallback = new RecordingFallback("{}");
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no pegar a ciegas",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.used("load-buffer"), false);
});

test("la limpieza CAS no borra una cuarentena concurrente de la generación actual", async () => {
  const { home, workspace } = await freshState("quarantine-clear-cas");
  const tmux = new FakeTmux();
  tmux.sessionOptions.set("@cauce_quarantined_pane", "$0:@0:%0:1111");
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  let raced = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (!raced && args[0] === "if-shell"
      && args.some((argument) => argument.includes("@cauce_quarantined_pane"))) {
      raced = true;
      tmux.sessionOptions.set("@cauce_quarantined_pane", "$0:@0:%0:4242");
    }
    return originalRun(args, stdin);
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no borrar marca nueva",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(tmux.sessionOptions.get("@cauce_quarantined_pane"), "$0:@0:%0:4242");
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(fallback.calls, 1);
});

test("cancelar tras Enter sigue un rename lógico e interrumpe el mismo proceso", async () => {
  const { home, workspace } = await freshState("abort-post-enter-rename");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "send-keys" && args.includes("Enter")) {
      tmux.sessionName = "renombrada-por-humano";
      controller.abort();
    }
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback, cancelDrainTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "cancelar con rename",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(tmux.interruptedCount, 1);
  assert.equal(fallback.calls, 0);
});
