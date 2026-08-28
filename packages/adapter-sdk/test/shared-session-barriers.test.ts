import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  CliTmux,
  acquirePaneInputBarrier,
  pastePrompt,
  releasePaneInputBarrier,
  sendEnter,
  paneIdentity,
} from "../src/shared-session/tmux.js";
import type { TmuxController, TmuxResult } from "../src/shared-session/tmux.js";
import {
  FakeTmux,
  RecordingFallback,
  ambiguousTmuxResult,
  claudeRunner,
  exactTmuxPaneState,
  freshState,
  ok,
} from "./shared-session-fixtures.js";

test("las formas exhaustivas de ocupación rechazada son busy y no mutan input ni token", async () => {
  const identity = {
    sessionId: "$0",
    sessionName: "cauce-kratos",
    windowId: "@0",
    windowName: "agente",
    paneId: "%0",
    panePid: "4242",
  } as const;
  const scenarios = [
    { name: "input deshabilitado", inputOff: true, paneInMode: false },
    { name: "copy-mode con input habilitado", inputOff: false, paneInMode: true },
    { name: "token ajeno", inputOff: false, paneInMode: false, token: "e".repeat(64) },
    { name: "todas las señales", inputOff: true, paneInMode: true, token: "f".repeat(64) },
  ] as const;

  for (const scenario of scenarios) {
    const tmux = new FakeTmux();
    tmux.inputOff = scenario.inputOff;
    tmux.paneInMode = scenario.paneInMode;
    if ("token" in scenario) tmux.paneOptions.set("@cauce_input_barrier", scenario.token);
    const previousToken = tmux.paneOptions.get("@cauce_input_barrier");

    assert.deepEqual(
      await acquirePaneInputBarrier(tmux, identity, "a".repeat(64)),
      { state: "busy" },
      scenario.name,
    );
    assert.equal(tmux.inputOff, scenario.inputOff, scenario.name);
    assert.equal(tmux.paneInMode, scenario.paneInMode, scenario.name);
    assert.equal(tmux.paneOptions.get("@cauce_input_barrier"), previousToken, scenario.name);
    assert.equal(tmux.calls.some((call) => call[0] === "select-pane"), false, scenario.name);
    assert.equal(
      tmux.calls.some((call) => ["display-message", "list-panes", "run-shell"].includes(call[0]!)),
      false,
      `${scenario.name}: toda negativa y sus probes deben ser hookless`,
    );
    for (const call of tmux.calls.filter((candidate) => candidate[0] === "if-shell")) {
      assert.match(
        call.at(-1) ?? "",
        /^wait-for -S cauce-cas-v2-[a-f0-9]{64}-rejected$/u,
        `${scenario.name}: rama negativa con token exacto no falsificable por stdout`,
      );
    }
  }
});

test("una postcondición exacta acredita la barrera aunque se pierda el exit status", async () => {
  const identity = {
    sessionId: "$0",
    sessionName: "cauce-kratos",
    windowId: "@0",
    windowName: "agente",
    paneId: "%0",
    panePid: "4242",
  } as const;
  const tmux = new FakeTmux();
  const originalRun = tmux.run.bind(tmux);
  let lostStatus = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin, control);
    if (!lostStatus && args[0] === "if-shell"
      && args.some((argument) => argument.includes("@cauce_input_barrier")
        && argument.includes("select-pane -d"))) {
      lostStatus = true;
      return ambiguousTmuxResult("exit status perdido tras commit");
    }
    return response;
  };

  const acquired = await acquirePaneInputBarrier(tmux, identity, "b".repeat(64));
  assert.equal(acquired.state, "acquired");
  assert.equal(lostStatus, true);
  assert.equal(tmux.inputOff, true);
  assert.equal(tmux.paneOptions.get("@cauce_input_barrier"), "b".repeat(64));
  if (acquired.state === "acquired") {
    assert.equal(await releasePaneInputBarrier(tmux, acquired.barrier), "applied");
  }
});

test("copy-mode en el runner degrada sin liberar barrera inexistente ni terminar al humano", async () => {
  const { home, workspace } = await freshState("copy-mode-runner");
  const tmux = new FakeTmux();
  tmux.paneInMode = true;
  const fallback = new RecordingFallback("fallback copy-mode");
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no tocar copy-mode",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.paneInMode, true);
  assert.equal(tmux.inputOff, false);
  assert.equal(tmux.paneOptions.has("@cauce_input_barrier"), false);
  assert.equal(tmux.calls.some((call) => call[0] === "kill-pane"), false);
  assert.equal(tmux.calls.some((call) => call[0] === "select-pane" && call.includes("-e")), false);
  assert.equal(tmux.used("paste-buffer"), false);
});

test("adquisición no acreditada conserva pending sin release ni terminación", async () => {
  const { home, workspace } = await freshState("input-barrier-no-acreditada");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("no debe ejecutarse");
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "if-shell"
      && args.some((argument) => argument.includes("@cauce_input_barrier")
        && argument.includes("select-pane -d"))) return ok(1);
    return originalRun(args, stdin, control);
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "adquisición incierta",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /no se acreditó ownership.*no se intentó liberarla ni terminar/u);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.inputOff, false);
  assert.equal(tmux.paneOptions.has("@cauce_input_barrier"), false);
  assert.equal(tmux.calls.some((call) => call[0] === "kill-pane"), false);
  assert.equal(tmux.calls.some((call) => call[0] === "select-pane" && call.includes("-e")), false);
});

test(
  "tmux real: input de cliente tras la última captura no se concatena con paste+Enter",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-input-barrier-"));
    const output = join(scratch, "lines.txt");
    const socket = `cauce-race-${process.pid}-${randomUUID().slice(0, 8)}`;
    const session = "barrier";
    const base = new CliTmux(socket, { ...process.env, CAUCE_TEST_OUTPUT: output });
    let client: ReturnType<typeof spawn> | undefined;
    try {
      const created = await base.run([
        "new-session", "-d", "-x", "120", "-y", "30", "-s", session, "-n", "agente",
        "exec sh -c 'printf \"❯ \"; while IFS= read -r line; do "
          + "printf \"%s\\n\" \"$line\" >> \"$CAUCE_TEST_OUTPUT\"; printf \"❯ \"; done'",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      client = spawn(
        "script",
        ["-qfec", `exec tmux -L ${socket} attach-session -t ${session}`, "/dev/null"],
        {
          env: { ...process.env, TERM: "xterm-256color" },
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      let attached = false;
      for (let attempt = 0; !attached && attempt < 100; attempt += 1) {
        const clients = await base.run(["list-clients", "-F", "#{client_session}"]);
        attached = clients.exitCode === 0 && clients.stdout.split(/\r?\n/u).includes(session);
        if (!attached) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.equal(attached, true, "el cliente humano real debe estar adjunto");
      const identity = await paneIdentity(base, `${session}:agente`);
      assert.ok(identity);
      const token = "a".repeat(64);
      const acquired = await acquirePaneInputBarrier(base, identity, token);
      assert.equal(acquired.state, "acquired");
      if (acquired.state !== "acquired") return;

      let loaded = false;
      let raced = false;
      const tmux: TmuxController = {
        run: async (args, stdin, control): Promise<TmuxResult> => {
          const response = await base.run(args, stdin, control);
          if (args[0] === "load-buffer" && stdin !== "CAUCE_BUFFER_SCRUBBED") loaded = true;
          if (!raced && loaded && args[0] === "capture-pane") {
            raced = true;
            client?.stdin?.write("HUMAN_RACE");
            // Da tiempo a que el servidor reciba y descarte el byte con `pane_input_off=1`.
            await new Promise((resolveWait) => setTimeout(resolveWait, 40));
          }
          return response;
        },
      };
      const prompt = `CAUCE_PROMPT-${randomUUID()}`;
      const pasted = await pastePrompt(tmux, identity, `cauce-${randomUUID()}`, prompt, {
        inputBarrier: acquired.barrier,
        verifyInputEmpty: true,
      });
      assert.deepEqual(pasted, { state: "pasted", bufferScrubbed: true });
      assert.equal(await sendEnter(tmux, identity, undefined, acquired.barrier), "applied");
      assert.equal(await releasePaneInputBarrier(tmux, acquired.barrier), "applied");
      assert.equal(raced, true);

      client.stdin?.write("HUMAN_AFTER\n");
      let lines: string[] = [];
      for (let attempt = 0; lines.length < 2 && attempt < 100; attempt += 1) {
        try {
          lines = (await readFile(output, "utf8")).trimEnd().split("\n");
        } catch {
          // El primer Enter puede no haber llegado todavía al proceso del pane.
        }
        if (lines.length < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.deepEqual(lines, [prompt, "HUMAN_AFTER"]);
      assert.equal(lines.some((line) => line.includes("HUMAN_RACE")), false);
    } finally {
      client?.stdin?.end();
      client?.kill("SIGTERM");
      await base.run(["kill-server"]).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "tmux real: token ajeno rechaza adquisición sin alterar modo, input, identidad ni opción",
  async () => {
    const socket = `cauce-foreign-token-${process.pid}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-s", "foreign-token", "-n", "agente", "sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      const identity = await paneIdentity(tmux, "foreign-token:agente");
      assert.ok(identity);
      assert.equal((await tmux.run([
        "set-option", "-p", "-t", identity.paneId,
        "@cauce_input_barrier", "f".repeat(64),
      ])).exitCode, 0);
      const before = await exactTmuxPaneState(tmux, identity.paneId);
      const beforeScreen = await tmux.run(["capture-pane", "-p", "-t", identity.paneId]);
      assert.equal(beforeScreen.exitCode, 0, beforeScreen.stderr);
      assert.equal(before.split("\t")[8], "0");
      assert.equal(before.split("\t")[9], "0");
      assert.equal(before.split("\t")[10], "f".repeat(64));
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-display-message",
        `send-keys -t ${identity.paneId} X X`,
      ])).exitCode, 0);

      assert.deepEqual(
        await acquirePaneInputBarrier(tmux, identity, "a".repeat(64)),
        { state: "busy" },
      );
      const foreignBarrier = { identity, token: "a".repeat(64) } as const;
      assert.equal(
        await sendEnter(tmux, identity, undefined, foreignBarrier),
        "not_applied",
        "mutateUnderInputBarrier rechaza sin disparar el hook",
      );
      assert.equal(
        await releasePaneInputBarrier(tmux, foreignBarrier),
        "not_applied",
        "release rechaza token ajeno sin disparar el hook",
      );
      assert.equal((await tmux.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal(await exactTmuxPaneState(tmux, identity.paneId), before);
      assert.deepEqual(
        await tmux.run(["capture-pane", "-p", "-t", identity.paneId]),
        beforeScreen,
        "la negativa no dispara el hook que habría inyectado XX",
      );

      // Este hook reproduce el spoof de R7: display-message imprimía primero el sentinel y su hook
      // agregaba HOOK_OUTPUT, de modo que la clasificación por stdout era falsificable.
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-display-message", "list-panes -F HOOK_OUTPUT",
      ])).exitCode, 0);
      assert.deepEqual(
        await acquirePaneInputBarrier(tmux, identity, "b".repeat(64)),
        { state: "busy" },
      );
      assert.equal((await tmux.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal(await exactTmuxPaneState(tmux, identity.paneId), before);
      assert.doesNotThrow(() => process.kill(Number(identity.panePid), 0));
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
    }
  },
);

test(
  "tmux real: mutación con identidad anterior preserva exactamente el pane respawnado",
  async () => {
    const socket = `cauce-replacement-${process.pid}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-s", "replacement", "-n", "agente", "sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      const oldIdentity = await paneIdentity(tmux, "replacement:agente");
      assert.ok(oldIdentity);
      const respawned = await tmux.run([
        "respawn-pane", "-k", "-t", oldIdentity.paneId, "sleep 29",
      ]);
      assert.equal(respawned.exitCode, 0, respawned.stderr);
      let replacement = await paneIdentity(tmux, oldIdentity.paneId);
      for (let attempt = 0;
        replacement?.panePid === oldIdentity.panePid && attempt < 50;
        attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        replacement = await paneIdentity(tmux, oldIdentity.paneId);
      }
      assert.ok(replacement);
      assert.notEqual(replacement.panePid, oldIdentity.panePid);
      const before = await exactTmuxPaneState(tmux, replacement.paneId);
      const beforeScreen = await tmux.run(["capture-pane", "-p", "-t", replacement.paneId]);
      assert.equal(beforeScreen.exitCode, 0, beforeScreen.stderr);
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-display-message",
        `run-shell -t ${replacement.paneId} `
          + "'printf HOOK_STDOUT; printf HOOK_STDERR >&2; exit 7'",
      ])).exitCode, 0);

      assert.equal(await sendEnter(tmux, oldIdentity), "not_applied");
      assert.equal((await tmux.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal(await exactTmuxPaneState(tmux, replacement.paneId), before);
      assert.deepEqual(
        await tmux.run(["capture-pane", "-p", "-t", replacement.paneId]),
        beforeScreen,
        "la negativa no ejecuta el hook con stdout/stderr/exit 7 ni abre view-mode",
      );
      assert.doesNotThrow(() => process.kill(Number(replacement.panePid), 0));
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
    }
  },
);

test("la mutación atómica rechaza respawn-pane después del probe y antes de Enter/paste", async () => {
  const identity = {
    sessionId: "$0",
    sessionName: "cauce-kratos",
    windowId: "@0",
    windowName: "agente",
    paneId: "%0",
    panePid: "4242",
  } as const;

  const enterTmux = new FakeTmux();
  const originalEnterRun = enterTmux.run.bind(enterTmux);
  let swappedEnter = false;
  enterTmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (!swappedEnter && args[0] === "if-shell"
      && args.some((argument) => argument.includes("send-keys")
        && argument.includes("Enter"))) {
      swappedEnter = true;
      enterTmux.respawnPane();
    }
    return originalEnterRun(args, stdin, control);
  };
  assert.equal(await sendEnter(enterTmux, identity), "not_applied");
  assert.equal(enterTmux.submittedCount, 0);
  assert.equal(enterTmux.calls.some((call) => call[0] === "send-keys"), false);

  const pasteTmux = new FakeTmux();
  const acquired = await acquirePaneInputBarrier(pasteTmux, identity, "c".repeat(64));
  assert.equal(acquired.state, "acquired");
  if (acquired.state !== "acquired") return;
  const originalPasteRun = pasteTmux.run.bind(pasteTmux);
  let swappedPaste = false;
  pasteTmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalPasteRun(args, stdin, control);
    if (!swappedPaste && args[0] === "if-shell"
      && args[4]?.includes("#{pane_input_off}")
      && !args.some((argument) => argument.includes("paste-buffer"))) {
      swappedPaste = true;
      pasteTmux.respawnPane();
    }
    return response;
  };
  assert.deepEqual(
    await pastePrompt(
      pasteTmux,
      identity,
      "cauce-atomic-buffer",
      "no caer en proceso nuevo",
      { inputBarrier: acquired.barrier, verifyInputEmpty: true },
    ),
    { state: "not_pasted", reason: "identity_changed", bufferScrubbed: true },
  );
  assert.equal(pasteTmux.inputContent, "");
  assert.equal(pasteTmux.buffers.size, 0);
});
