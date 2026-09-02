import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { transcriptDirectory } from "../src/shared-session/session.js";
import { paneIdentity } from "../src/shared-session/tmux.js";
import type { TmuxResult } from "../src/shared-session/tmux.js";
import { fileQuarantinePersistence } from "../src/shared-session/paste-runner.js";
import type { QuarantinePersistence } from "../src/shared-session/paste-runner.js";
import {
  FakeTmux,
  RecordingFallback,
  ambiguousTmuxResult,
  assistantEntry,
  claudeRunner,
  controlledDelayedTmuxMutation,
  controlledTmuxHang,
  correlationIdFromPrompt,
  envelopeText,
  freshState,
  ok,
  userEntry,
} from "./shared-session-fixtures.js";

async function armings(state: string): Promise<string[]> {
  return (await readdir(state)).filter((name) => name.endsWith(".arming"));
}

async function waitForSettled(
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

for (const mutationResult of [
  { name: "testigo wait-for negativo exacto", kind: "not_applied" },
  { name: "exit 78 legado e incierto", kind: "exit_78" },
  { name: "exit 1 incierto", kind: "exit_one" },
  { name: "exit null", kind: "null" },
  { name: "excepción de transporte", kind: "throw" },
] as const) {
  test(`paste triestado: ${mutationResult.name} decide fallback sin adivinar`, async () => {
    const { home, workspace } = await freshState(`paste-tristate-${mutationResult.kind}`);
    const tmux = new FakeTmux();
    const fallback = new RecordingFallback("{}");
    const originalRun = tmux.run.bind(tmux);
    tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
      if (args[0] === "if-shell"
        && args.some((argument) => argument.includes("paste-buffer"))) {
        if (mutationResult.kind === "throw") throw new Error("transport disconnected");
        if (mutationResult.kind === "null") return ambiguousTmuxResult("unknown completion");
        if (mutationResult.kind === "not_applied") {
          return originalRun(args.at(-1)?.split(" ") ?? [], undefined, control);
        }
        return ok(mutationResult.kind === "exit_78" ? 78 : 1);
      }
      return originalRun(args, stdin, control);
    };
    const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

    const outcome = await runner.run({
      command: "claude",
      args: [],
      harness: "claude",
      stdin: "mutación triestado",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    if (mutationResult.kind === "not_applied") {
      assert.equal(fallback.calls, 1, "sólo el wait-for exacto acredita que paste no ocurrió");
      assert.equal(outcome.exitCode, 0);
      assert.equal(tmux.sessionExists, true);
    } else {
      assert.equal(fallback.calls, 0);
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.harnessStarted, undefined);
      assert.match(outcome.stderr, /resultado.*pegaba.*ambiguo/u);
      assert.equal(tmux.sessionExists, false, "la generación incierta se termina exactamente");
    }
    assert.equal(tmux.submittedCount, 0);
    assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  });
}

test("paste demorado se reapea y no puede concatenarse con input humano posterior", async () => {
  const { home, workspace } = await freshState("paste-demorado-reap");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  let pasteClientReaped = false;
  let killClientReaped = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "if-shell"
      && args.some((argument) => argument.includes("paste-buffer"))) {
      const response = await controlledDelayedTmuxMutation(
        control,
        80,
        () => originalRun(args, stdin, control),
      );
      pasteClientReaped = response.exitCode === null;
      return response;
    }
    if (args[0] === "if-shell"
      && args.some((argument) => argument.includes("kill-pane"))) {
      const response = await controlledTmuxHang(control);
      killClientReaped = response.exitCode === null;
      return response;
    }
    return originalRun(args, stdin, control);
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineOperationTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "paste que no puede aparecer tarde",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /resultado.*pegaba.*ambiguo/u);
  assert.equal(pasteClientReaped, true);
  assert.equal(killClientReaped, true);
  assert.equal(fallback.calls, 0);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  tmux.inputContent = "TEXTO HUMANO POSTERIOR AL REAP";
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(tmux.inputContent, "TEXTO HUMANO POSTERIOR AL REAP");
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(tmux.calls.some((call) => call.includes("C-u") || call.includes("Enter")), false);
});

test("load-buffer demorado queda ambiguo, reapeado y con barrera durable", async () => {
  const { home, workspace } = await freshState("load-demorado-reap");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  let loadClientReaped = false;
  let lateLoadApplied = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED") {
      const response = await controlledDelayedTmuxMutation(control, 80, async () => {
        lateLoadApplied = true;
        return originalRun(args, stdin, control);
      });
      loadClientReaped = response.exitCode === null;
      return response;
    }
    if (args[0] === "if-shell"
      && args.some((argument) => argument.includes("kill-pane"))) {
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
    quarantineOperationTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "load que no puede aparecer tarde",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(loadClientReaped, true);
  assert.equal(fallback.calls, 0);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  tmux.inputContent = "INPUT HUMANO POSTERIOR AL LOAD REAPEADO";
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(lateLoadApplied, false);
  assert.equal(tmux.inputContent, "INPUT HUMANO POSTERIOR AL LOAD REAPEADO");
  assert.equal(tmux.used("paste-buffer"), false);
});

test("probe demorado queda ambiguo, reapeado y no inicia load ni paste", async () => {
  const { home, workspace } = await freshState("inspect-demorado-reap");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  let inspectClientReaped = false;
  let lateInspectApplied = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (tmux.sessionOptions.has("@cauce_quarantined_pane")
      && args[0] === "if-shell" && args[4]?.includes("#{pane_input_off}")) {
      const response = await controlledDelayedTmuxMutation(control, 80, async () => {
        lateInspectApplied = true;
        return originalRun(args, stdin, control);
      });
      inspectClientReaped = response.exitCode === null;
      return response;
    }
    if (args[0] === "if-shell"
      && args.some((argument) => argument.includes("kill-pane"))) {
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
    quarantineOperationTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "inspect que no puede completarse tarde",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(inspectClientReaped, true);
  assert.equal(fallback.calls, 0);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(lateInspectApplied, false);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.used("paste-buffer"), false);
});

test("delete-buffer demorado se reapea y el scrub posterior queda acreditado", async () => {
  const { home, workspace } = await freshState("delete-demorado-reap");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  let deleteAttempts = 0;
  let deleteClientReaped = false;
  let lateDeleteApplied = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "delete-buffer" && deleteAttempts === 0) {
      deleteAttempts += 1;
      const response = await controlledDelayedTmuxMutation(control, 80, async () => {
        lateDeleteApplied = true;
        return originalRun(args, stdin, control);
      });
      deleteClientReaped = response.exitCode === null;
      return response;
    }
    const response = await originalRun(args, stdin, control);
    if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED") controller.abort();
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

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "buffer que debe neutralizarse",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, false);
  assert.equal(deleteClientReaped, true);
  assert.equal(fallback.calls, 0);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(lateDeleteApplied, false);
  assert.equal(tmux.buffers.size, 0);
});

test("overwrite demorado se reapea y conserva la cuarentena durable", async () => {
  const { home, workspace } = await freshState("overwrite-demorado-reap");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  let overwriteClientReaped = false;
  let lateOverwriteApplied = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "delete-buffer") return ok(1);
    if (args[0] === "load-buffer" && stdin === "CAUCE_BUFFER_SCRUBBED") {
      const response = await controlledDelayedTmuxMutation(control, 80, async () => {
        lateOverwriteApplied = true;
        return originalRun(args, stdin, control);
      });
      overwriteClientReaped = response.exitCode === null;
      return response;
    }
    const response = await originalRun(args, stdin, control);
    if (args[0] === "load-buffer") controller.abort();
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

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "buffer cuyo scrub pierde confirmación",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /scrub.*ambiguo.*cuarentena/u);
  assert.equal(overwriteClientReaped, true);
  assert.equal(fallback.calls, 0);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(lateOverwriteApplied, false);
});

test("cancelar durante load-buffer impide incluso el paste-buffer posterior", async () => {
  const { home, workspace } = await freshState("abort-entre-load-paste");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "load-buffer") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no pegar",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(tmux.used("load-buffer"), true);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(tmux.buffers.size, 0);
  assert.equal(tmux.calls.some((call) => call[0] === "delete-buffer"), true);
  assert.equal(tmux.calls.some((call) => call.includes("Enter")), false);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.equal(fallback.calls, 0);
});

test("input humano tras fsync de arming se revalida antes de load-buffer y no se concatena", async () => {
  const { state, home, workspace } = await freshState("input-durante-pending-fsync");
  const quarantineFile = join(state, "quarantine");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const persistence: QuarantinePersistence = {
    ...fileQuarantinePersistence,
    persist: async (path, identity) => {
      const persisted = await fileQuarantinePersistence.persist(path, identity);
      if (path.endsWith(".arming")) tmux.inputContent = "TEXTO HUMANO DURANTE FSYNC";
      return persisted;
    },
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    quarantinePersistence: persistence,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no concatenar después del pending",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.inputContent, "TEXTO HUMANO DURANTE FSYNC");
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(tmux.submittedCount, 0);
});

test("persist pre-paste vencido sólo publica arming y su cleanup exacto no bloquea el restart", async () => {
  const { state, home, workspace } = await freshState("pending-late-arming-causal");
  const quarantineFile = join(state, "quarantine");
  const directory = transcriptDirectory(home, workspace);
  const transcriptSession = randomUUID();
  const transcript = join(directory, `${transcriptSession}.jsonl`);
  const head = randomUUID();
  await appendFile(transcript, `${userEntry(head, null, "turno humano previo", transcriptSession)}\n`);
  const tmux = new FakeTmux();
  const identity = await paneIdentity(tmux, tmux.paneId);
  assert.ok(identity);

  // Simulates a foreign crash/runner in the phase before commit. Its correlation and token are not
  // those of the expired attempt: it must be ignorable, but never erased by a wide compensation.
  const foreignArming = `${quarantineFile}.${"a".repeat(64)}.${"b".repeat(64)}.arming`;
  assert.equal(await fileQuarantinePersistence.persist(foreignArming, identity), true);
  const foreignBytes = await readFile(foreignArming, "utf8");

  let delayNextArming = true;
  let latePreparationPublished = false;
  const persistence: QuarantinePersistence = {
    ...fileQuarantinePersistence,
    persist: async (path, currentIdentity) => {
      if (delayNextArming && path.endsWith(".arming") && path !== foreignArming) {
        delayNextArming = false;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        const persisted = await fileQuarantinePersistence.persist(path, currentIdentity);
        latePreparationPublished = persisted;
        return persisted;
      }
      return fileQuarantinePersistence.persist(path, currentIdentity);
    },
  };
  const fallback = new RecordingFallback("{}");
  const firstRunner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    quarantinePersistence: persistence,
    quarantineOperationTimeoutMs: 20,
  });

  const first = await firstRunner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "preparación que vence antes de publicar",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(first.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 0);
  assert.equal(
    (await readdir(state)).some((name) => name.endsWith(".pending")),
    false,
    "el timeout nunca publica el nombre que significa paste posible",
  );

  // The non-cooperative operation really does finish late and write to disk; its causal continuation
  // withdraws only ITS preparation. The arming of another token survives byte for byte.
  await waitForSettled(
    async () => latePreparationPublished && (await armings(state)).length === 1,
  );
  assert.equal(latePreparationPublished, true);
  assert.deepEqual(await armings(state), [basename(foreignArming)]);
  assert.equal(await readFile(foreignArming, "utf8"), foreignBytes);

  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(transcript, `${userEntry(userUuid, head, text, transcriptSession)}\n`);
    await appendFile(
      transcript,
      `${assistantEntry(
        randomUUID(),
        userUuid,
        envelopeText("turno posterior al restart", correlationIdFromPrompt(text)),
        transcriptSession,
      )}\n`,
    );
  };
  const restartedRunner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    quarantineFile,
    quarantinePersistence: persistence,
    // The 20 ms deadline above exists only to force the first arming timeout. The restart is the
    // recovery assertion and must use the production-sized operation budget, otherwise scheduler
    // contention can turn a valid recovery into an unrelated fallback.
  });
  const second = await restartedRunner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "la preparación huérfana no bloquea",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(second.exitCode, 0);
  assert.equal(tmux.submittedCount, 1);
  assert.equal(fallback.calls, 1);
  assert.equal(await readFile(foreignArming, "utf8"), foreignBytes);
  assert.equal((await readdir(state)).some((name) => name.endsWith(".pending")), false);
});
