import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import type { CommandRunRequest } from "../src/sdk/types.js";
import { museTranscript, type MuseLogLine } from "../src/shared-session/muse.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import {
  FakeTmux,
  adapterFor,
  ambiguousTmuxResult,
  correlationIdFromPrompt,
  envelopeText,
  execute,
} from "./shared-session-fixtures.js";
import type { TmuxResult } from "./shared-session-fixtures.js";
import { museWorkspace } from "./muse-shared-session-fixtures.js";

// ---------------------------------------------------------------------------------------------
// perseo 13:09Z / operador 16:52Z (9-nov, Praxis/server2): the hourly backup verification starved
// the disk, tmux answered late and `acquirePaneInputBarrier` came back `ambiguous`. The runner
// quarantined the generation at once and every later delivery died with SHARED_TUI_UNAVAILABLE,
// although both composers were empty: the paste only happens after the barrier is held.
// ---------------------------------------------------------------------------------------------

const IDLE_PANE = [
  "  Muse Code 1.4.0",
  "",
  "─".repeat(130),
  "❯",
  "─".repeat(130),
  "  muse-spark-1.3-contributor · max · /workspace · YOLO",
].join("\n");

const FOREIGN_TOKEN = "e".repeat(64);
const PROBE_ACCEPT = /^wait-for -S cauce-cas-v2-[a-f0-9]{64}-accepted$/u;

function isAcquireCas(args: readonly string[]): boolean {
  return args[0] === "if-shell"
    && args.some((argument) => argument.includes("@cauce_input_barrier") && argument.includes("select-pane -d"));
}

function isProbe(args: readonly string[]): boolean {
  return args[0] === "if-shell" && PROBE_ACCEPT.test(args.at(-2) ?? "");
}

type LostAcquisition = "applied" | "not_applied";

interface Scenario {
  /** How the FIRST acquisition CAS loses its answer; later ones run normally. */
  readonly lost?: LostAcquisition;
  /** Probes answered with a timeout right after the lost acquisition (Infinity = all of them). */
  readonly silencedProbes?: number;
  /** Runs right after the lost acquisition, to change the pane before the re-probes. */
  readonly afterLoss?: (tmux: FakeTmux) => void;
  /** Times out the acquisition's very first probe instead (before any CAS is sent). */
  readonly silenceFirstAcquisitionProbe?: boolean;
  /** Every acquisition CAS is lost without applying (exercises the in-process bound). */
  readonly loseEveryAcquisition?: boolean;
  readonly budgetMs?: number;
}

async function museScenario(name: string, scenario: Scenario): Promise<{
  readonly runner: PasteSessionRunner<MuseLogLine>;
  readonly tmux: FakeTmux;
  readonly state: string;
  readonly notices: string[];
  readonly lostTokens: string[];
  /** Lets tmux answer every probe again. */
  readonly answerAgain: () => void;
}> {
  const { state, museData, log } = await museWorkspace(name);
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-hegel";
  tmux.paneStartCommand = "exec env XDG_DATA_HOME='/d' muse --yolo --trust-workspace --reasoning-effort max";
  tmux.paneContent = IDLE_PANE;
  tmux.onSubmit = async (text) => {
    const correlation = correlationIdFromPrompt(text);
    await log.append(
      log.intent("i-bus", text),
      log.started("i-bus", text),
      log.message("i-bus", envelopeText("entró tras recuperar la barrera", correlation)),
      log.terminal("i-bus"),
    );
  };
  const lostTokens: string[] = [];
  let silenced = 0;
  let armed = false;
  let firstAcquisitionProbeSilenced = false;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "set-option" && args.includes("@cauce_quarantined_pane") && !args.includes("-u")) armed = true;
    if (scenario.silenceFirstAcquisitionProbe === true && !firstAcquisitionProbeSilenced && armed
      && isProbe(args) && (args.at(-3) ?? "").includes("#{==:#{window_name},")) {
      firstAcquisitionProbeSilenced = true;
      return ambiguousTmuxResult("tmux client timed_out");
    }
    if (isAcquireCas(args) && (scenario.loseEveryAcquisition === true
      || (scenario.lost !== undefined && lostTokens.length === 0))) {
      const accept = args.at(-2) ?? "";
      lostTokens.push(/@cauce_input_barrier ([a-f0-9]{64})/u.exec(accept)?.[1] ?? "");
      if ((scenario.lost ?? "not_applied") === "applied") {
        // tmux ran the list, but neither witness reached Cauce: exactly the starved-host case.
        await originalRun([...args.slice(0, -2), accept.replace(/ ; wait-for -S \S+$/u, ""), ""], stdin, control);
      }
      scenario.afterLoss?.(tmux);
      silenced = scenario.silencedProbes ?? 0;
      return ambiguousTmuxResult("tmux client timed_out");
    }
    if (silenced > 0 && isProbe(args)) {
      silenced -= 1;
      return ambiguousTmuxResult("tmux client timed_out");
    }
    return originalRun(args, stdin, control);
  };
  const notices: string[] = [];
  const runner = new PasteSessionRunner({
    alias: "hegel",
    harness: "muse",
    workspace: "/workspace",
    transcript: museTranscript(museData),
    tmux,
    sleep: () => Promise.resolve(),
    acquireTimeoutMs: 30,
    generatingWaitMs: 40,
    turnTimeoutMs: 2_000,
    injectTimeoutMs: 2_000,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    quarantineFile: join(state, ".shared-session-quarantine"),
    barrierResolutionBudgetMs: scenario.budgetMs ?? 5_000,
    barrierResolutionProbeTimeoutMs: 1_000,
    onNotice: (detail) => { notices.push(detail); },
  });
  return { runner, tmux, state, notices, lostTokens, answerAgain: () => { silenced = 0; } };
}

async function pendingFiles(state: string): Promise<string[]> {
  return (await readdir(state)).filter((name) => /^\.shared-session-quarantine\..*\.pending$/u.test(name));
}

function request(signal = new AbortController().signal): CommandRunRequest {
  return { command: "muse", args: [], harness: "muse", stdin: "pedido del bus", timeoutMs: 10_000, signal };
}

test("(a) barrera propia aplicada con el resultado perdido: se libera, se retira el pending y el turno entra", async () => {
  const { runner, tmux, state, notices, lostTokens } = await museScenario("barrera-propia-perdida", {
    lost: "applied",
    silencedProbes: 3,
  });

  const output = await execute(await adapterFor(runner, state, "hegel", "muse"));

  assert.equal(output.reply, "entró tras recuperar la barrera");
  assert.equal(tmux.submittedCount, 1, "un solo pegado: el del intento que sí acreditó la barrera");
  assert.equal(lostTokens.length, 1);
  assert.ok(tmux.calls.some((call) => call[0] === "if-shell"
    && (call.at(-2) ?? "").startsWith("select-pane -e -t %0 ; set-option -pu -t %0 @cauce_input_barrier")
    && (call.at(-3) ?? "").includes(`#{==:#{@cauce_input_barrier},${lostTokens[0] ?? ""}}`)),
  "el release es un CAS sobre el token propio exacto");
  assert.deepEqual(await pendingFiles(state), []);
  await assert.rejects(readFile(join(state, ".shared-session-quarantine")), { code: "ENOENT" });
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
  assert.equal(tmux.inputOff, false);
  assert.equal(tmux.paneOptions.has("@cauce_input_barrier"), false);
  assert.equal(tmux.used("kill-pane"), false);
  assert.match(notices.join("\n"), /barrera era propia y se liberó; no se pegó nada/u);
  assert.equal(runner.takeDegradation(), undefined);
});

test("(b) CAS perdido que nunca se aplicó: sin cuarentena, se reintenta y el turno entra", async () => {
  const { runner, tmux, state, notices, lostTokens } = await museScenario("barrera-nunca-aplicada", {
    lost: "not_applied",
    silencedProbes: 2,
  });

  const output = await execute(await adapterFor(runner, state, "hegel", "muse"));

  assert.equal(output.reply, "entró tras recuperar la barrera");
  assert.equal(tmux.submittedCount, 1);
  assert.equal(lostTokens.length, 1);
  assert.deepEqual(await pendingFiles(state), []);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
  assert.equal(tmux.calls.filter((call) => call[0] === "if-shell"
    && (call.at(-2) ?? "").startsWith("select-pane -e -t %0 ; set-option -pu")).length, 1,
  "solo el release del intento que sí adquirió: nada ajeno ni inexistente se libera");
  assert.match(notices.join("\n"), /barrera nunca se aplicó; no se pegó nada/u);
});

test("duda anterior al CAS: no se re-sondea, se retira el pending y el turno entra", async () => {
  const { runner, tmux, state, notices, lostTokens } = await museScenario("barrera-duda-previa", {
    silenceFirstAcquisitionProbe: true,
  });

  const output = await execute(await adapterFor(runner, state, "hegel", "muse"));

  assert.equal(output.reply, "entró tras recuperar la barrera");
  assert.equal(tmux.submittedCount, 1);
  assert.deepEqual(lostTokens, []);
  assert.deepEqual(await pendingFiles(state), []);
  assert.match(notices.join("\n"), /duda fue anterior a la mutación/u);
});

test("(c) mientras tanto apareció una exclusión AJENA: input_busy sin tocarla y sin pending", async () => {
  const { runner, tmux, state } = await museScenario("barrera-ajena-tras-perdida", {
    lost: "not_applied",
    silencedProbes: 1,
    afterLoss: (pane) => {
      pane.paneOptions.set("@cauce_input_barrier", FOREIGN_TOKEN);
      pane.inputOff = true;
    },
  });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, false);
  assert.equal(runner.takeDegradation()?.reason, "input_busy");
  assert.equal(tmux.paneOptions.get("@cauce_input_barrier"), FOREIGN_TOKEN);
  assert.equal(tmux.inputOff, true);
  assert.equal(tmux.calls.some((call) => (call.at(-2) ?? "").includes("select-pane -e")), false);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.deepEqual(await pendingFiles(state), []);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
});

test("(d) la generación cambió: reemplazo antes de Enter, sin pending ni mutaciones", async () => {
  const { runner, tmux, state } = await museScenario("barrera-generacion-reemplazada", {
    lost: "not_applied",
    silencedProbes: 1,
    afterLoss: (pane) => { pane.respawnPane(); },
  });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, false);
  assert.match(outcome.stderr, /reemplazada antes de Enter/u);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.equal(tmux.calls.some((call) => (call.at(-2) ?? "").includes("select-pane -e")), false);
  assert.deepEqual(await pendingFiles(state), []);
});

test("(e) tmux sigue sin contestar todo el plazo: cuarentena durable como antes, sin release", async () => {
  const { runner, tmux, state, lostTokens, answerAgain } = await museScenario("barrera-indeterminable", {
    lost: "applied",
    silencedProbes: Number.POSITIVE_INFINITY,
    budgetMs: 350,
  });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined, "sigue siendo ambiguo para el motor");
  assert.match(outcome.stderr,
    /tampoco se acreditó al re-sondear.*no se acreditó ownership.*no se intentó liberarla ni terminar.*durable en disco/u);
  const pending = await pendingFiles(state);
  assert.deepEqual(pending, [`.shared-session-quarantine.${lostTokens[0] ?? ""}.pending`]);
  assert.equal(await readFile(join(state, pending[0] ?? ""), "utf8"), "$0:@0:%0:4242\n");
  assert.equal(tmux.paneOptions.get("@cauce_input_barrier"), lostTokens[0], "el token propio sigue intacto");
  assert.equal(tmux.inputOff, true);
  assert.equal(tmux.calls.some((call) => (call.at(-2) ?? "").includes("select-pane -e")), false);
  assert.equal(tmux.used("kill-pane"), false);
  assert.equal(tmux.used("paste-buffer"), false);

  answerAgain();
  const next = await runner.run(request());
  assert.equal(next.harnessStarted, false);
  assert.equal(runner.takeDegradation()?.reason, "session_identity_unverified",
    "la generación queda bloqueada hasta rescatar o reemplazar, igual que antes");
});

test("barrera propia que tmux no deja liberar (hook nuevo): se conserva y queda en cuarentena", async () => {
  const { runner, tmux, state, lostTokens } = await museScenario("barrera-propia-con-hook", {
    lost: "applied",
    afterLoss: (pane) => { pane.configuredInputHooks.add("after-select-pane"); },
  });

  const outcome = await runner.run(request());

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.harnessStarted, undefined);
  assert.match(outcome.stderr, /barrera es propia, pero tmux no permitió liberarla/u);
  assert.equal(tmux.paneOptions.get("@cauce_input_barrier"), lostTokens[0]);
  assert.equal(tmux.configuredInputHooks.has("after-select-pane"), true, "no se toca estado ajeno");
  assert.equal(tmux.calls.some((call) => (call.at(-2) ?? "").includes("select-pane -e")), false);
  assert.equal((await pendingFiles(state)).length, 1);
});

test("cancelar durante el re-sondeo corta enseguida y conserva la cuarentena", async () => {
  const controller = new AbortController();
  const { runner, state } = await museScenario("barrera-cancelada", {
    lost: "applied",
    silencedProbes: Number.POSITIVE_INFINITY,
    budgetMs: 60_000,
    afterLoss: () => { setTimeout(() => { controller.abort(); }, 50); },
  });

  const started = Date.now();
  const outcome = await runner.run(request(controller.signal));

  assert.ok(Date.now() - started < 5_000, "el plazo largo no retiene una entrega cancelada");
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, undefined);
  assert.equal((await pendingFiles(state)).length, 1);
});

test("si cada adquisición pierde su resultado, el reintento en proceso tiene tope y pasa al store como reintentable", async () => {
  const { runner, tmux, state, lostTokens } = await museScenario("barrera-perdida-siempre", {
    loseEveryAcquisition: true,
  });

  const error = await execute(await adapterFor(runner, state, "hegel", "muse")).then(
    () => assert.fail("la entrega no debía completarse"),
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof ProcessExecutionError);
  assert.equal(error.code, "PROCESS_EXIT_PREFLIGHT");
  assert.equal(error.retryable, true);
  assert.match(error.message, /3 veces seguidas.*no se pegó nada/u);
  assert.equal(lostTokens.length, 3);
  assert.equal(tmux.used("paste-buffer"), false);
  assert.deepEqual(await pendingFiles(state), []);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), false);
});
