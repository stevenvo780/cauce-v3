import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import {
  CliTmux,
  acquirePaneInputBarrier,
  paneIdentity,
  pastePrompt,
  sendEnter,
} from "../src/shared-session/tmux.js";
import {
  FakeTmux,
  TmuxResult,
  adapterFor,
  claudeRunner,
  exactTmuxPaneState,
  expectSharedTuiUnavailable,
  freshState,
  randomUUID,
} from "./shared-session-fixtures.js";

test("cancelar durante acquire se observa tras capture y preserva la caja humana", async () => {
  const { home, workspace } = await freshState("abort-acquire");
  const tmux = new FakeTmux();
  tmux.paneContent = "❯ borrador humano";
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "capture-pane") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no ejecutar",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.equal(tmux.paneContent, "❯ borrador humano");
});

test("cancelar durante el aviso conserva el fallo canónico no retryable", async () => {
  const { state, home, workspace } = await freshState("abort-durante-aviso");
  const tmux = new FakeTmux();
  tmux.paneContent = "❯ borrador humano";
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  let announced = false;
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin, control);
    if (args[0] === "display-message" && args[1] !== "-p") {
      announced = true;
      controller.abort(new Error("adapter shutdown"));
    }
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux });
  const adapter = await adapterFor(runner, state, "kratos", "claude");

  const error = await expectSharedTuiUnavailable(adapter.execute({
    prompt: "no ejecutar",
    sessionKey: "auth-v2:prueba",
    timeoutMs: 10_000,
    signal: controller.signal,
  }));

  assert.equal(announced, true);
  assert.match(error.message, /input_busy/u);
  assert.equal(tmux.pasted, undefined);
  assert.equal(tmux.submittedCount, 0);
  const records = await readDegradations(state);
  assert.equal(records[0]?.executionPrevented, true);
  assert.equal(records[0].fellBack, false);
});

test("cancelar después del paste compromete Enter y nunca deja un prompt ejecutable", async () => {
  const { home, workspace } = await freshState("abort-tras-paste");
  const tmux = new FakeTmux();
  const controller = new AbortController();
  const submitted: string[] = [];
  tmux.onSubmit = (text) => {
    submitted.push(text);
  };
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "paste-buffer") {
      controller.abort();
    }
    return response;
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    cancelDrainTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no ejecutar",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal(tmux.used("load-buffer"), true);
  assert.equal(tmux.calls.some((call) => call.includes("Enter")), true);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.equal(submitted.length, 1);
  assert.match(submitted[0] ?? "", /no ejecutar/u);
  assert.equal(tmux.inputContent, "");
  assert.equal(tmux.buffers.size, 0);
  assert.equal(tmux.interruptedCount, 1);
  const interrupt = tmux.calls.find((call) => call[0] === "send-keys" && call.includes("Escape"));
  assert.equal(interrupt?.[interrupt.indexOf("-t") + 1], tmux.paneId);
  // A later human Enter finds an empty box: it cannot revive the cancelled delivery.
  await tmux.run(["send-keys", "-t", tmux.paneId, "Enter"]);
  assert.equal(submitted.length, 1);
});

test("un settle colgado tras paste termina la generación antes de liberar", async () => {
  const { home, workspace } = await freshState("settle-colgado-post-paste");
  const tmux = new FakeTmux();
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    settleMs: 50,
    quarantineOperationTimeoutMs: 20,
    sleep: (ms) => ms === 50 ? new Promise<void>(() => undefined) : Promise.resolve(),
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "prompt que no puede quedar ejecutable",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /wait between paste and Enter.*ambig/u);
  assert.equal(tmux.sessionExists, false, "la caja pegada no puede quedar reutilizable");
  assert.equal(tmux.calls.some((call) => call.includes("Enter") || call.includes("C-u")), false);
});

test(
  "tmux real: cancelar tras paste igualmente compromete Enter y borra el buffer nombrado",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-shared-commit-"));
    const output = join(scratch, "submitted.txt");
    const socket = `cauce-test-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket, { ...process.env, CAUCE_TEST_OUTPUT: output });
    const session = "commit";
    try {
      const created = await tmux.run([
        "new-session", "-d", "-x", "120", "-y", "30", "-s", session, "-n", "agente",
        "exec sh -c 'IFS= read -r line; printf %s \"$line\" > \"$CAUCE_TEST_OUTPUT\"; sleep 30'",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);

      let identity = await paneIdentity(tmux, `${session}:agente`);
      for (let attempt = 0; identity === undefined && attempt < 50; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        identity = await paneIdentity(tmux, `${session}:agente`);
      }
      assert.ok(identity, "tmux real no publicó la identidad del pane");

      const text = `cancel-boundary-${randomUUID()}`;
      const buffer = `cauce-test-${randomUUID()}`;
      const controller = new AbortController();
      assert.deepEqual(
        await pastePrompt(tmux, identity, buffer, text, {
          signal: controller.signal,
          verifyInputEmpty: false,
        }),
        { state: "pasted", bufferScrubbed: true },
      );
      controller.abort();
      // The committed boundary ignores the cancellation and delivers Enter to the EXACT SAME pane.
      assert.equal(await sendEnter(tmux, identity), "applied");

      let observed: string | undefined;
      for (let attempt = 0; observed === undefined && attempt < 100; attempt += 1) {
        try {
          observed = await readFile(output, "utf8");
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      assert.equal(observed, text);
      assert.notEqual((await tmux.run(["show-buffer", "-b", buffer])).exitCode, 0);

      // A later Enter does not run the prompt again: the process already consumed the box.
      await sendEnter(tmux, identity);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      assert.equal(await readFile(output, "utf8"), text);
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "tmux real: copy-mode rechaza la adquisición como busy y conserva vivo el pane humano",
  async () => {
    const socket = `cauce-copy-mode-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
    const session = "copy-mode";
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-x", "120", "-y", "30", "-s", session, "-n", "agente",
        "exec sh -c 'while :; do sleep 60; done'",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      const identity = await paneIdentity(tmux, `${session}:agente`);
      assert.ok(identity, "tmux real debe publicar la identidad exacta antes de copy-mode");

      const enteredCopyMode = await tmux.run(["copy-mode", "-t", identity.paneId]);
      assert.equal(enteredCopyMode.exitCode, 0, enteredCopyMode.stderr);
      const before = await exactTmuxPaneState(tmux, identity.paneId);
      assert.equal(before.split("\t")[8], "0");
      assert.equal(before.split("\t")[9], "1", "copy-mode simple debe tener stack 1");
      assert.equal(before.split("\t")[10], "");
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-display-message", `copy-mode -t ${identity.paneId}`,
      ])).exitCode, 0);
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-list-panes", `copy-mode -t ${identity.paneId}`,
      ])).exitCode, 0);

      assert.deepEqual(
        await acquirePaneInputBarrier(tmux, identity, "d".repeat(64)),
        { state: "busy" },
      );
      assert.equal((await tmux.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal((await tmux.run(["set-hook", "-gu", "after-list-panes"])).exitCode, 0);

      const current = await paneIdentity(tmux, identity.paneId);
      assert.deepEqual(current, identity, "la misma generación humana debe seguir viva");
      assert.doesNotThrow(() => process.kill(Number(identity.panePid), 0));
      assert.equal(
        await exactTmuxPaneState(tmux, identity.paneId),
        before,
        "la rama negativa debe preservar byte a byte copy-mode stack 1",
      );

      // `choose-tree` stacks a second human modality without running a failed process or
      // contaminating stdout/stderr. The rejected branch cannot fire after-display and stack a
      // third modality.
      assert.equal((await tmux.run(["choose-tree", "-t", identity.paneId])).exitCode, 0);
      const stacked = await exactTmuxPaneState(tmux, identity.paneId);
      assert.equal(stacked.split("\t")[9], "2", "el escenario debe partir de stack 2");
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-display-message", `copy-mode -t ${identity.paneId}`,
      ])).exitCode, 0);
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-list-panes", `copy-mode -t ${identity.paneId}`,
      ])).exitCode, 0);
      assert.deepEqual(
        await acquirePaneInputBarrier(tmux, identity, "e".repeat(64)),
        { state: "busy" },
      );
      assert.equal((await tmux.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal((await tmux.run(["set-hook", "-gu", "after-list-panes"])).exitCode, 0);
      assert.equal(
        await exactTmuxPaneState(tmux, identity.paneId),
        stacked,
        "la rama negativa debe preservar byte a byte copy/view-mode stack 2",
      );
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
    }
  },
);
