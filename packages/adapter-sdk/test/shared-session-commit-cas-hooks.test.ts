import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  CliTmux,
  acquirePaneInputBarrier,
  paneIdentity,
  pastePrompt,
  releasePaneInputBarrier,
} from "../src/shared-session/tmux.js";
import { fileQuarantinePersistence } from "../src/shared-session/paste-runner.js";
import {
  FakeTmux,
  RecordingFallback,
  claudeRunner,
  exactTmuxPaneState,
  freshState,
  ok,
} from "./shared-session-fixtures.js";
import type { TmuxController, TmuxResult } from "./shared-session-fixtures.js";

test("commitPrepared hace CAS de nombre y jamás reemplaza el pending de otro intento", async () => {
  const { state } = await freshState("pending-commit-name-cas");
  const tmux = new FakeTmux();
  const firstIdentity = await paneIdentity(tmux, tmux.paneId);
  assert.ok(firstIdentity);
  const foreignIdentity = { ...firstIdentity, panePid: "5252" };
  const pending = join(state, `quarantine.${"c".repeat(64)}.pending`);
  const firstPreparation = join(
    state,
    `quarantine.${"c".repeat(64)}.${"d".repeat(64)}.arming`,
  );
  const foreignPreparation = join(
    state,
    `quarantine.${"c".repeat(64)}.${"e".repeat(64)}.arming`,
  );
  assert.equal(await fileQuarantinePersistence.persist(firstPreparation, firstIdentity), true);
  assert.equal(
    await fileQuarantinePersistence.commitPrepared(firstPreparation, pending, firstIdentity),
    true,
  );
  const committedBytes = await readFile(pending, "utf8");
  assert.equal(await fileQuarantinePersistence.persist(foreignPreparation, foreignIdentity), true);

  assert.equal(
    await fileQuarantinePersistence.commitPrepared(foreignPreparation, pending, foreignIdentity),
    false,
  );
  assert.equal(await readFile(pending, "utf8"), committedBytes);
  assert.equal(await readFile(foreignPreparation, "utf8"), "$0:@0:%0:5252\n");
});

test("input humano después de load-buffer se revalida justo antes de paste", async () => {
  const { home, workspace } = await freshState("input-entre-load-y-paste");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin, control);
    if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED"
      && response.exitCode === 0) {
      tmux.inputContent = "TEXTO HUMANO DESPUÉS DEL LOAD";
    }
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no concatenar inmediatamente antes del paste",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.inputContent, "TEXTO HUMANO DESPUÉS DEL LOAD");
  assert.equal(tmux.used("load-buffer"), true);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(tmux.submittedCount, 0);
  assert.equal(tmux.buffers.size, 0);
});

test("input humano entre la revalidación de identidad y el paste se preserva", async () => {
  const { home, workspace } = await freshState("input-entre-identidad-y-paste");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const originalRun = tmux.run.bind(tmux);
  let injectedRace = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin, control);
    // The second precondition already attested pane/PID/names, but has not yet captured the box.
    if (!injectedRace && tmux.buffers.size > 0
      && args[0] === "if-shell" && args[4]?.includes("#{pane_input_off}")) {
      injectedRace = true;
      tmux.inputContent = "TEXTO HUMANO EN LA ÚLTIMA REVALIDACIÓN";
    }
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no concatenar después de revalidar identidad",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(injectedRace, true);
  assert.equal(outcome.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.inputContent, "TEXTO HUMANO EN LA ÚLTIMA REVALIDACIÓN");
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(tmux.submittedCount, 0);
  assert.equal(tmux.buffers.size, 0);
});

test("la barrera descarta input humano después de la última captura y antes del if-shell", async () => {
  const { home, workspace } = await freshState("input-race-despues-ultima-captura");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const submitted: string[] = [];
  tmux.onSubmit = (text) => {
    submitted.push(text);
  };
  const originalRun = tmux.run.bind(tmux);
  let bufferLoaded = false;
  let raceAttempted = false;
  let humanAccepted: boolean | undefined;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin, control);
    if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED") bufferLoaded = true;
    if (!raceAttempted && bufferLoaded && args[0] === "capture-pane") {
      raceAttempted = true;
      // This is exactly the R4 window: the snapshot has already returned and the if-shell has not yet started.
      humanAccepted = tmux.humanType("HUMAN_RACE");
    }
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    turnTimeoutMs: 15,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "CAUCE_PROMPT",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(raceAttempted, true);
  assert.equal(humanAccepted, false, "pane_input_off debe descartar el byte del cliente humano");
  assert.equal(outcome.timedOut, true);
  assert.equal(fallback.calls, 0);
  assert.equal(submitted.length, 1);
  assert.match(submitted[0] ?? "", /CAUCE_PROMPT/u);
  assert.doesNotMatch(submitted[0] ?? "", /HUMAN_RACE/u);
  assert.equal(tmux.inputContent, "");
});

test("todo hook tmux efectivo rechaza la barrera antes de tocar la caja", async () => {
  const hooks = [
    "after-load-buffer",
    "after-capture-pane",
    "after-list-buffers",
    "after-save-buffer",
    "after-paste-buffer",
    "after-send-keys",
    "client-focus-in",
    "alert-activity",
    "session-created",
    "window-linked",
  ];
  for (const [index, hook] of hooks.entries()) {
    const { home, workspace } = await freshState(`input-hook-inseguro-${String(index)}`);
    const tmux = new FakeTmux();
    tmux.configuredInputHooks.add(hook);
    const fallback = new RecordingFallback("{}");
    const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

    await runner.run({
      command: "claude",
      args: [],
      harness: "claude",
      stdin: "no abrir carrera con hook",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    assert.equal(fallback.calls, 1, hook);
    assert.equal(tmux.used("load-buffer"), false, hook);
    assert.equal(tmux.used("paste-buffer"), false, hook);
    assert.equal(tmux.inputOff, false, hook);
    assert.equal(tmux.paneOptions.has("@cauce_input_barrier"), false, hook);
    assert.equal(tmux.configuredInputHooks.has(hook), true, `${hook}: no se toca estado ajeno`);
  }
});

test(
  "tmux real: after-load-buffer preexistente falla cerrado sin duplicar ni tocar el pane",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-after-load-preexisting-"));
    const output = join(scratch, "lines.txt");
    const socket = `cauce-after-load-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket, { ...process.env, CAUCE_TEST_OUTPUT: output });
    const buffer = `cauce-${randomUUID()}`;
    try {
      assert.equal((await tmux.run([
        "new-session", "-d", "-x", "120", "-y", "30", "-s", "hostile-load", "-n", "agente",
        "exec sh -c 'printf \"❯ \"; while IFS= read -r line; do "
          + "printf \"%s\\n\" \"$line\" >> \"$CAUCE_TEST_OUTPUT\"; printf \"❯ \"; done'",
      ])).exitCode, 0);
      const identity = await paneIdentity(tmux, "hostile-load:agente");
      assert.ok(identity);
      const hostile = `select-pane -e -t ${identity.paneId}`
        + ` ; paste-buffer -b ${buffer} -t ${identity.paneId} -p`
        + ` ; send-keys -t ${identity.paneId} Enter`
        + ` ; select-pane -d -t ${identity.paneId}`;
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-load-buffer", hostile,
      ])).exitCode, 0);
      const before = await exactTmuxPaneState(tmux, identity.paneId);

      assert.deepEqual(
        await acquirePaneInputBarrier(tmux, identity, "1".repeat(64)),
        { state: "unsafe_hooks" },
      );

      assert.equal(await exactTmuxPaneState(tmux, identity.paneId), before);
      assert.notEqual((await tmux.run(["show-buffer", "-b", buffer])).exitCode, 0);
      await assert.rejects(readFile(output, "utf8"));
      const preserved = await tmux.run([
        "show-hooks", "-g", "-t", identity.paneId, "after-load-buffer",
      ]);
      assert.equal(preserved.exitCode, 0, preserved.stderr);
      assert.match(preserved.stdout, /^after-load-buffer\[0\] /mu);
      assert.doesNotThrow(() => process.kill(Number(identity.panePid), 0));
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "tmux real: hook agregado durante la barrera impide load y release hasta retirarlo",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-after-load-race-"));
    const output = join(scratch, "lines.txt");
    const socket = `cauce-after-load-race-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
    const base = new CliTmux(socket, { ...process.env, CAUCE_TEST_OUTPUT: output });
    const buffer = `cauce-${randomUUID()}`;
    try {
      assert.equal((await base.run([
        "new-session", "-d", "-x", "120", "-y", "30", "-s", "hook-race", "-n", "agente",
        "exec sh -c 'printf \"❯ \"; while IFS= read -r line; do "
          + "printf \"%s\\n\" \"$line\" >> \"$CAUCE_TEST_OUTPUT\"; printf \"❯ \"; done'",
      ])).exitCode, 0);
      const identity = await paneIdentity(base, "hook-race:agente");
      assert.ok(identity);
      const initial = await exactTmuxPaneState(base, identity.paneId);
      const acquired = await acquirePaneInputBarrier(base, identity, "2".repeat(64));
      assert.equal(acquired.state, "acquired");
      if (acquired.state !== "acquired") return;
      const fenced = await exactTmuxPaneState(base, identity.paneId);
      const hostile = `select-pane -e -t ${identity.paneId}`
        + ` ; paste-buffer -b ${buffer} -t ${identity.paneId} -p`
        + ` ; send-keys -t ${identity.paneId} Enter`
        + ` ; select-pane -d -t ${identity.paneId}`;
      let installed = false;
      const tmux: TmuxController = {
        run: async (args, stdin, control): Promise<TmuxResult> => {
          const response = await base.run(args, stdin, control);
          if (!installed && args[0] === "capture-pane") {
            installed = true;
            const hook = await base.run(["set-hook", "-g", "after-load-buffer", hostile]);
            assert.equal(hook.exitCode, 0, hook.stderr);
          }
          return response;
        },
      };

      assert.deepEqual(
        await pastePrompt(tmux, identity, buffer, "NO_DUPLICAR", {
          inputBarrier: acquired.barrier,
          verifyInputEmpty: true,
        }),
        { state: "not_pasted", reason: "mutation_rejected", bufferScrubbed: true },
      );
      assert.equal(installed, true);
      assert.equal(await exactTmuxPaneState(base, identity.paneId), fenced);
      assert.equal(await releasePaneInputBarrier(base, acquired.barrier), "not_applied");
      assert.equal(
        await exactTmuxPaneState(base, identity.paneId),
        fenced,
        "un release sin acreditación conserva exactamente input_off y el token propio",
      );
      assert.notEqual((await base.run(["show-buffer", "-b", buffer])).exitCode, 0);
      await assert.rejects(readFile(output, "utf8"));
      assert.doesNotThrow(() => process.kill(Number(identity.panePid), 0));

      assert.equal((await base.run([
        "set-hook", "-gu", "after-load-buffer",
      ])).exitCode, 0);
      assert.equal(await releasePaneInputBarrier(base, acquired.barrier), "applied");
      assert.equal(await exactTmuxPaneState(base, identity.paneId), initial);
    } finally {
      await base.run(["kill-server"]).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test("delete-buffer fallido se recupera sobrescribiendo y acreditando un contenido inocuo", async () => {
  const { home, workspace } = await freshState("abort-load-delete-falla-scrub-ok");
  const tmux = new FakeTmux();
  tmux.failDeleteBuffer = true;
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "prompt privado que no debe sobrevivir",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, false);
  assert.deepEqual([...tmux.buffers.values()], ["CAUCE_BUFFER_SCRUBBED"]);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(fallback.calls, 0);
});

test("si delete y scrub no se acreditan el aborto falla cerrado y pone la generación en cuarentena", async () => {
  const { home, workspace } = await freshState("abort-load-scrub-inacreditable");
  const tmux = new FakeTmux();
  tmux.failDeleteBuffer = true;
  tmux.failBufferScrub = true;
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "contenido que jamás debe aparecer en el diagnóstico",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /scrub.*ambiguo.*cuarentena/u);
  assert.doesNotMatch(outcome.stderr, /contenido que jamás/u);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(fallback.calls, 0);
});

test(
  "tmux real: aborto tras load y delete fallido deja sólo el marcador inocuo acreditado",
  async () => {
    const socket = `cauce-test-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
    const base = new CliTmux(socket);
    const controller = new AbortController();
    const buffer = `cauce-test-${randomUUID()}`;
    const secret = `buffer-private-${randomUUID()}`;
    try {
      assert.equal((await base.run([
        "new-session", "-d", "-s", "buffer-scrub", "-n", "agente", "sleep 30",
      ])).exitCode, 0);
      const identity = await paneIdentity(base, "buffer-scrub:agente");
      assert.ok(identity);
      const tmux: TmuxController = {
        run: async (args, stdin): Promise<TmuxResult> => {
          if (args[0] === "delete-buffer") return ok(1);
          const response = await base.run(args, stdin);
          if (args[0] === "load-buffer" && stdin === secret) controller.abort();
          return response;
        },
      };

      const outcome = await pastePrompt(tmux, identity, buffer, secret, {
        signal: controller.signal,
        verifyInputEmpty: false,
      });
      assert.deepEqual(outcome, {
        state: "not_pasted",
        reason: "cancelled",
        bufferScrubbed: true,
      });
      const remaining = await base.run(["show-buffer", "-b", buffer]);
      assert.equal(remaining.exitCode, 0);
      assert.equal(remaining.stdout, "CAUCE_BUFFER_SCRUBBED");
      assert.notEqual(remaining.stdout, secret);
    } finally {
      await base.run(["kill-server"]).catch(() => undefined);
    }
  },
);
