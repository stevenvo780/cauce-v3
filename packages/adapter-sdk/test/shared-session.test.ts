import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { claudeDefinition, codexDefinition } from "../src/harnesses/index.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import type {
  TmuxController,
  TmuxResult,
  TmuxRunControl,
} from "../src/shared-session/tmux.js";
import {
  acquirePaneInputBarrier,
  CliTmux,
  clearCurrentPaneQuarantine,
  clearPaneQuarantine,
  killSessionIdIfNamed,
  paneIdentity,
  pastePrompt,
  releasePaneInputBarrier,
  sendEnter,
  withoutLifecycleIdentity,
} from "../src/shared-session/tmux.js";
import {
  fileQuarantinePersistence,
  PasteSessionRunner,
  turnBudgetMs,
  type QuarantinePersistence,
} from "../src/shared-session/paste-runner.js";
import { CONTEXT_MARK, DEGRADED_MARK, RESET_MARK } from "../src/shared-session/notice.js";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { inputBoxState } from "../src/shared-session/pane.js";
import {
  claudeTranscript,
  descendsFrom,
  findFinalAssistant,
  indexByUuid,
  stripJsonFence,
  type TranscriptEntry,
} from "../src/shared-session/transcript.js";
import { codexTranscript, rolloutSessionId, type RolloutLine } from "../src/shared-session/rollout.js";
import {
  ensureSharedSession,
  paneEnvironmentPrefix,
  resumeArgumentSuffix,
  transcriptDirectory,
  transcriptDirectoryIn,
} from "../src/shared-session/session.js";
import {
  claudeHasPreviousConversation,
  codexHasPreviousConversation,
} from "../src/shared-session/resume.js";
import type { ResumeSpec, TranscriptReader } from "../src/shared-session/types.js";
import {
  cliSharedSessionSpec,
  loadSharedSessionConfig,
  sharedSessionPaneEnvironment,
} from "../src/shared-session/config.js";

const stateRoot = resolve(".test-state/shared-session");

const EXACT_TMUX_PANE_STATE_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
  "#{pane_start_command}",
  "#{pane_input_off}",
  "#{pane_in_mode}",
  "#{@cauce_input_barrier}",
  "#{@cauce_quarantined_pane}",
  "#{@cauce_creation_nonce}",
].join("\t");

async function exactTmuxPaneState(tmux: TmuxController, paneId: string): Promise<string> {
  const state = await tmux.run([
    "display-message", "-p", "-t", paneId, EXACT_TMUX_PANE_STATE_FORMAT,
  ]);
  assert.equal(state.exitCode, 0, state.stderr);
  return state.stdout;
}

async function exactTmuxPaneStateViaList(tmux: TmuxController, paneId: string): Promise<string> {
  const state = await tmux.run([
    "list-panes", "-a", "-f", `#{==:#{pane_id},${paneId}}`, "-F", EXACT_TMUX_PANE_STATE_FORMAT,
  ]);
  assert.equal(state.exitCode, 0, state.stderr);
  const rows = state.stdout.split(/\r?\n/u).filter((row) => row !== "");
  assert.equal(rows.length, 1, `debe existir exactamente ${paneId}`);
  return `${rows[0]}\n`;
}

const ENVELOPE = {
  reply: "hecho",
  messages: [] as const,
  status: "done" as const,
  retryable: false,
  artifacts: [] as const,
};

function envelopeText(reply = "hecho", correlationId?: string): string {
  return JSON.stringify({
    ...ENVELOPE,
    reply,
    ...(correlationId === undefined ? {} : { cauce_correlation_id: correlationId }),
  });
}

function correlationIdFromPrompt(prompt: string): string {
  const match = /"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(prompt);
  assert.ok(match?.[1], "el prompt inyectado debe llevar un nonce criptográfico de 256 bits");
  return match[1];
}

async function freshState(name: string): Promise<{ state: string; home: string; workspace: string }> {
  const directory = join(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  const home = join(directory, "home");
  const workspace = "/workspace";
  await mkdir(transcriptDirectory(home, workspace), { recursive: true });
  await mkdir(directory, { recursive: true });
  return { state: directory, home, workspace };
}

/** Una entrada de transcript con la misma forma que escribe `claude` de verdad. */
function userEntry(uuid: string, parentUuid: string | null, text: string, sessionId: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid, isSidechain: false, sessionId,
    promptSource: "typed", message: { role: "user", content: text },
  });
}

function assistantEntry(
  uuid: string,
  parentUuid: string,
  text: string,
  sessionId: string,
  stopReason: string = "end_turn",
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid, isSidechain: false, sessionId,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
}

/**
 * tmux simulado con la fidelidad que estas pruebas necesitan: qué comandos recibió, qué había en
 * la caja de entrada y qué se llegó a pegar. El transcript lo escribe el propio test cuando la
 * "TUI" recibe un Enter, igual que hace claude.
 */
class FakeTmux implements TmuxController {
  readonly calls: string[][] = [];
  readonly sessionOptions = new Map<string, string>();
  readonly paneOptions = new Map<string, string>();
  sessionExists = true;
  sessionName = "cauce-kratos";
  sessionId = "$0";
  private nextSessionNumber = 1;
  windowId = "@0";
  private nextWindowNumber = 1;
  paneId = "%0";
  private nextPaneNumber = 1;
  /** Ventanas realmente presentes en la sesión. Por defecto, la de la TUI. */
  windows: string[] = ["agente"];
  paneContent = "❯ ";
  panePid = "4242";
  inputOff = false;
  paneInMode = false;
  readonly configuredInputHooks = new Set<string>();
  private readonly waitSignals = new Set<string>();
  private readonly waiters = new Map<string, Set<(result: TmuxResult) => void>>();
  /** Comando original del panel, usado para acreditar sesiones anteriores a los marcadores. */
  paneStartCommand = "exec claude";
  /** Panes adicionales dentro de la ventana TUI, situación que debe fallar cerrada. */
  extraPaneCount = 0;
  failQuarantineRead = false;
  failQuarantineWrite = false;
  failKillPane = false;
  failEnter = false;
  failClearInput = false;
  clearInputNoop = false;
  failDeleteBuffer = false;
  failBufferScrub = false;
  failBufferInspection = false;
  newSessionFails = false;
  /**
   * Trozo del argv del panel que hace que el proceso salga al instante.
   *
   * Modela lo medido el 2026-08-06 con claude 2.1.223: `claude --continue` sin conversación previa
   * escribe «No conversation found to continue» y sale con código 1. tmux crea la sesión y acto
   * seguido se la lleva, porque su último panel murió. Sin esto, el doble daría por vivo un panel
   * que en la realidad no existe, que es justo el fallo que estas pruebas tienen que ver.
   */
  fatalPaneArguments: string | undefined;
  readonly buffers = new Map<string, string>();
  inputContent = "";
  pasted: string | undefined;
  submittedCount = 0;
  interruptedCount = 0;
  interruptStopsTurn = true;
  onSubmit: ((text: string) => Promise<void> | void) | undefined;

  replaceSession(options?: { alias?: string; harness?: "claude" | "codex" }): string {
    this.sessionExists = true;
    this.sessionId = `$${this.nextSessionNumber}`;
    this.nextSessionNumber += 1;
    this.windows = ["agente"];
    this.panePid = String(Number(this.panePid) + 1);
    this.windowId = `@${this.nextWindowNumber}`;
    this.nextWindowNumber += 1;
    this.paneId = `%${this.nextPaneNumber}`;
    this.nextPaneNumber += 1;
    this.inputContent = "";
    this.pasted = undefined;
    this.sessionOptions.clear();
    this.paneOptions.clear();
    this.inputOff = false;
    if (options?.alias !== undefined) this.sessionOptions.set("@cauce_alias", options.alias);
    if (options?.harness !== undefined) this.sessionOptions.set("@cauce_harness", options.harness);
    return this.sessionId;
  }

  /** `respawn-pane -k` conserva `%pane_id`, pero cambia proceso y vacía su input. */
  respawnPane(command?: string): void {
    this.panePid = String(Number(this.panePid) + 1);
    if (command !== undefined) this.paneStartCommand = command;
    this.inputContent = "";
    this.pasted = undefined;
    this.paneContent = "❯ ";
  }

  /** Modela bytes de un cliente adjunto; `select-pane -d` los descarta. */
  humanType(text: string): boolean {
    if (this.inputOff) return false;
    this.inputContent += text;
    return true;
  }

  private signalWaitChannel(channel: string): TmuxResult {
    const waiting = this.waiters.get(channel);
    if (waiting === undefined || waiting.size === 0) this.waitSignals.add(channel);
    else {
      this.waiters.delete(channel);
      for (const wake of waiting) wake(ok(0));
    }
    // Muchos doubles históricos envuelven `run` y no reenvían `control`. Resolver el waiter
    // hermano modela el AbortController que el controller real recibe al observar la otra rama.
    const sibling = channel.endsWith("-accepted")
      ? `${channel.slice(0, -"accepted".length)}rejected`
      : channel.endsWith("-rejected")
        ? `${channel.slice(0, -"rejected".length)}accepted`
        : undefined;
    if (sibling !== undefined) {
      const siblingWaiters = this.waiters.get(sibling);
      if (siblingWaiters !== undefined) {
        this.waiters.delete(sibling);
        for (const wake of siblingWaiters) wake(ambiguousTmuxResult("sibling settled"));
      }
    }
    return ok(0);
  }

  private waitForChannel(channel: string, control?: TmuxRunControl): Promise<TmuxResult> {
    if (this.waitSignals.delete(channel)) return Promise.resolve(ok(0));
    return new Promise((resolveWait) => {
      let settled = false;
      const finish = (result: TmuxResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        control?.signal?.removeEventListener("abort", aborted);
        const waiting = this.waiters.get(channel);
        waiting?.delete(finish);
        if (waiting?.size === 0) this.waiters.delete(channel);
        resolveWait(result);
      };
      const aborted = (): void => {
        finish(ambiguousTmuxResult("aborted"));
      };
      const timer = setTimeout(() => {
        finish(ambiguousTmuxResult("timed_out"));
      }, Math.max(1, control?.timeoutMs ?? 250));
      const waiting = this.waiters.get(channel) ?? new Set<(result: TmuxResult) => void>();
      waiting.add(finish);
      this.waiters.set(channel, waiting);
      control?.signal?.addEventListener("abort", aborted, { once: true });
      if (control?.signal?.aborted === true) aborted();
    });
  }

  private targetExists(target: string | undefined): boolean {
    if (!this.sessionExists || target === undefined) return false;
    if (target.startsWith("%")) return target === this.paneId;
    const sessionTarget = target.slice(0, target.lastIndexOf(":") < 0
      ? target.length
      : target.lastIndexOf(":"));
    return sessionTarget === this.sessionId
      || sessionTarget === this.sessionName
      || sessionTarget === `=${this.sessionName}`;
  }

  async run(
    args: readonly string[],
    stdin?: string,
    control?: TmuxRunControl,
  ): Promise<TmuxResult> {
    if (control?.signal?.aborted === true) return ambiguousTmuxResult("aborted");
    const separator = args.indexOf(";");
    if (separator >= 0) {
      const first = await this.run(args.slice(0, separator), stdin, control);
      if (first.exitCode !== 0) return first;
      const rest = await this.run(args.slice(separator + 1), undefined, control);
      return {
        exitCode: rest.exitCode,
        stdout: `${first.stdout}${rest.stdout}`,
        stderr: `${first.stderr}${rest.stderr}`,
      };
    }
    this.calls.push([...args]);
    const [command] = args;
    if (command === "wait-for") {
      const channel = args.at(-1);
      if (channel === undefined) return ok(1);
      return args.includes("-S")
        ? this.signalWaitChannel(channel)
        : this.waitForChannel(channel, control);
    }
    if (command === "if-shell") {
      const condition = args.at(-3) ?? "";
      const accept = (): Promise<TmuxResult> => this.run(
        args.at(-2)?.split(" ") ?? [],
        undefined,
        control,
      );
      const reject = (): Promise<TmuxResult> => this.run(
        args.at(-1)?.split(" ") ?? [],
        undefined,
        control,
      );
      const quarantined = /#\{==:#\{@cauce_quarantined_pane\},([^}]+)\}/u.exec(condition)?.[1];
      if (quarantined !== undefined) {
        if (!this.sessionExists
          || this.sessionOptions.get("@cauce_quarantined_pane") !== quarantined) {
          return reject();
        }
        return accept();
      }
      if (condition === "#{==:#{@cauce_quarantined_pane},}") {
        return this.sessionExists && !this.sessionOptions.has("@cauce_quarantined_pane")
          ? accept()
          : reject();
      }
      if (condition.includes("#{m/r:^[$][0-9]+:@[0-9]+:%[0-9]+:[0-9]+$,")
        && condition.includes("#{!=:#{@cauce_quarantined_pane},")) {
        const current = /#\{!=:#\{@cauce_quarantined_pane\},([^}]+)\}/u.exec(condition)?.[1];
        const value = this.sessionOptions.get("@cauce_quarantined_pane");
        const stale = value !== undefined
          && /^\$[0-9]+:@[0-9]+:%[0-9]+:[0-9]+$/u.test(value)
          && value !== current;
        return this.sessionExists && stale ? accept() : reject();
      }
      if (condition.includes("#{||:#{!=:#{pane_input_off},0},")
        && condition.includes("#{!=:#{pane_in_mode},0}")
        && condition.includes("#{!=:#{@cauce_input_barrier},}")) {
        const busy = this.inputOff || this.paneInMode
          || this.paneOptions.has("@cauce_input_barrier");
        return this.sessionExists && busy ? accept() : reject();
      }
      const expectedSession = /#\{==:#\{session_id\},(\$[0-9]+)\}/u.exec(condition)?.[1];
      const expectedSessionName = /#\{==:#\{session_name\},([^}]+)\}/u.exec(condition)?.[1];
      const expectedWindowId = /#\{==:#\{window_id\},(@[0-9]+)\}/u.exec(condition)?.[1];
      const expectedWindowName = /#\{==:#\{window_name\},([^}]+)\}/u.exec(condition)?.[1];
      const expectedPane = /#\{==:#\{pane_id\},(%[0-9]+)\}/u.exec(condition)?.[1];
      const expectedPid = /#\{==:#\{pane_pid\},([0-9]+)\}/u.exec(condition)?.[1];
      const expectedBarrier = /#\{==:#\{@cauce_input_barrier\},([a-f0-9]{64})\}/u
        .exec(condition)?.[1];
      const expectsBarrierEmpty = condition.includes("#{==:#{@cauce_input_barrier},}");
      const expectsInputOn = condition.includes("#{==:#{pane_input_off},0}");
      const expectsInputOff = condition.includes("#{==:#{pane_input_off},1}");
      const expectsNormalMode = condition.includes("#{==:#{pane_in_mode},0}");
      const expectedCreation = /#\{==:#\{@cauce_creation_nonce\},([a-f0-9]{64})\}/u
        .exec(condition)?.[1];
      if (expectedSessionName !== undefined && expectedPane === undefined) {
        if (!this.sessionExists || expectedSession !== this.sessionId
          || expectedSessionName !== this.sessionName) {
          return reject();
        }
        return accept();
      }
      if (!this.sessionExists || expectedSession !== this.sessionId
        || expectedPane !== this.paneId || expectedPid !== this.panePid
        || (expectedWindowId !== undefined && expectedWindowId !== this.windowId)
        || (expectedBarrier !== undefined
          && this.paneOptions.get("@cauce_input_barrier") !== expectedBarrier)
        || (expectsBarrierEmpty && this.paneOptions.has("@cauce_input_barrier"))
        || (expectsInputOn && this.inputOff)
        || (expectsInputOff && !this.inputOff)
        || (expectsNormalMode && this.paneInMode)
        || (expectedCreation !== undefined
          && this.sessionOptions.get("@cauce_creation_nonce") !== expectedCreation)
        || (expectedSessionName !== undefined && expectedSessionName !== this.sessionName)
        || (expectedWindowName !== undefined
          && expectedWindowName !== (this.windows.includes("agente")
            ? "agente" : (this.windows[0] ?? "agente")))) {
        return reject();
      }
      return accept();
    }
    if (command === "has-session") {
      const targetIndex = args.indexOf("-t");
      const target = targetIndex < 0 ? undefined : args[targetIndex + 1];
      const matches = this.sessionExists
        && (target === this.sessionId || target === `=${this.sessionName}`);
      return ok(matches ? 0 : 1);
    }
    if (command === "list-sessions") {
      if (!this.sessionExists) return { exitCode: 1, stdout: "", stderr: "no server running" };
      return { exitCode: 0, stdout: `${this.sessionName}\t${this.sessionId}\n`, stderr: "" };
    }
    if (command === "show-hooks") {
      const targetIndex = args.indexOf("-t");
      const namedHook = targetIndex >= 0 && targetIndex + 2 < args.length
        ? args.at(-1)
        : undefined;
      if (namedHook !== undefined) {
        if (this.configuredInputHooks.has(namedHook)) {
          return { exitCode: 0, stdout: `${namedHook}[0] run-shell sleep\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: args.includes("-g") ? `${namedHook}\n` : "", stderr: "" };
      }
      const configured = [...this.configuredInputHooks]
        .map((hook) => `${hook}[0] run-shell sleep`);
      return {
        exitCode: 0,
        stdout: args.includes("-g")
          ? ["after-bind-key", ...configured].join("\n") + "\n"
          : configured.length === 0 ? "" : `${configured.join("\n")}\n`,
        stderr: "",
      };
    }
    if (command === "show-options") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) {
        return { exitCode: 1, stdout: "", stderr: "can't find session" };
      }
      const option = args.at(-1) ?? "";
      if (option === "@cauce_quarantined_pane" && this.failQuarantineRead) {
        return { exitCode: 1, stdout: "", stderr: "read failed" };
      }
      const value = this.sessionOptions.get(option);
      return { exitCode: 0, stdout: value === undefined ? "" : `${value}\n`, stderr: "" };
    }
    // `list-windows` es la única fuente honesta de qué ventanas hay: `display-message` cae a la
    // ventana actual cuando la pedida no existe. El doble modela eso, no lo esquiva.
    if (command === "list-windows") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) {
        return { exitCode: 1, stdout: "", stderr: "can't find session" };
      }
      return { exitCode: 0, stdout: `${this.windows.join("\n")}\n`, stderr: "" };
    }
    if (command === "list-panes") {
      if (args.includes("-a")) {
        if (!this.sessionExists) return { exitCode: 0, stdout: "", stderr: "" };
        const paneIds = [this.paneId];
        for (let index = 0; index < this.extraPaneCount; index += 1) {
          paneIds.push(`%${900 + index}`);
        }
        return { exitCode: 0, stdout: `${paneIds.join("\n")}\n`, stderr: "" };
      }
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) {
        return { exitCode: 1, stdout: "", stderr: "can't find session" };
      }
      const window = this.windows.includes("agente") ? "agente" : (this.windows[0] ?? "agente");
      const rows = [
        `${this.sessionId}\t${this.sessionName}\t${this.windowId}\t${window}\t${this.paneId}`
          + `\t${this.panePid}\t0\t${this.paneStartCommand}`,
      ];
      for (let index = 0; index < this.extraPaneCount; index += 1) {
        rows.push(`${this.sessionId}\t${this.sessionName}\t${this.windowId}\t${window}\t%${900 + index}`
          + `\t${9000 + index}\t0\t${this.paneStartCommand}`);
      }
      return { exitCode: 0, stdout: `${rows.join("\n")}\n`, stderr: "" };
    }
    if (command === "new-session" || command === "new-window") {
      if (this.newSessionFails) return { exitCode: 1, stdout: "", stderr: "no server running" };
      if (command === "new-session" && this.sessionExists) {
        return { exitCode: 1, stdout: "", stderr: "duplicate session" };
      }
      this.sessionExists = true;
      const sessionIndex = args.indexOf("-s");
      if (sessionIndex >= 0 && args[sessionIndex + 1] !== undefined) {
        this.sessionName = args[sessionIndex + 1] ?? this.sessionName;
      }
      if (command === "new-session") {
        this.sessionId = `$${this.nextSessionNumber}`;
        this.nextSessionNumber += 1;
        this.windowId = `@${this.nextWindowNumber}`;
        this.nextWindowNumber += 1;
        this.paneId = `%${this.nextPaneNumber}`;
        this.nextPaneNumber += 1;
        this.inputContent = "";
        this.pasted = undefined;
        this.inputOff = false;
        this.paneOptions.clear();
      }
      const nameIndex = args.indexOf("-n");
      const created = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
      if (command === "new-session") this.windows = [];
      if (command === "new-session") this.sessionOptions.clear();
      if (created !== undefined && !this.windows.includes(created)) this.windows.push(created);
      const argv = args.at(-1) ?? "";
      if (command === "new-session") this.paneStartCommand = argv;
      if (this.fatalPaneArguments !== undefined && argv.includes(this.fatalPaneArguments)) {
        // tmux devolvió 0: la sesión SÍ se creó. Lo que se murió fue el proceso de dentro, y con él
        // se fue la sesión entera. `new-session` no tiene forma de contarlo.
        this.sessionExists = false;
        this.windows = [];
      }
      return command === "new-session"
        ? { exitCode: 0, stdout: `${this.sessionId}\n`, stderr: "" }
        : ok(0);
    }
    // Matar una sesión que ya no existe no es un fallo: es el estado que se buscaba.
    if (command === "kill-session") {
      const targetIndex = args.indexOf("-t");
      const target = targetIndex < 0 ? undefined : args[targetIndex + 1];
      const existia = this.sessionExists
        && (target === this.sessionId || target === `=${this.sessionName}`);
      if (!existia) return ok(1);
      this.sessionExists = false;
      this.windows = [];
      this.sessionOptions.clear();
      this.paneOptions.clear();
      this.inputOff = false;
      return ok(existia ? 0 : 1);
    }
    if (command === "kill-pane") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      if (this.failKillPane) return ok(1);
      this.sessionExists = false;
      this.windows = [];
      this.inputContent = "";
      this.paneOptions.clear();
      this.inputOff = false;
      return ok(0);
    }
    // El renombrado importa de verdad: es lo que enclavaba la sesión. El doble lo aplica sobre la
    // lista de ventanas para que `list-windows` deje de ver la ventana vieja, igual que tmux.
    if (command === "rename-window") {
      const target = args[2] ?? "";
      const from = target.slice(target.lastIndexOf(":") + 1);
      const to = args[3];
      const index = this.windows.indexOf(from);
      if (index < 0 || to === undefined) return { exitCode: 1, stdout: "", stderr: "can't find window" };
      this.windows[index] = to;
      return ok(0);
    }
    if (command === "capture-pane") {
      // Sin sesión no hay panel que capturar, y tmux lo dice fallando. Importa: `capturePane`
      // devuelve `undefined` y eso es lo que hace que la espera sepa distinguir "la TUI todavía
      // está arrancando" de "acá ya no hay nadie".
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) {
        return { exitCode: 1, stdout: "", stderr: "can't find session" };
      }
      const rendered = this.inputContent === ""
        ? this.paneContent
        : `${this.paneContent}\n[Pasted text #1 +${this.inputContent.split("\n").length} lines]\n❯ `;
      return { exitCode: 0, stdout: rendered, stderr: "" };
    }
    if (command === "display-message" && args[1] === "-p"
      && args.at(-1)?.includes("#{pane_input_off}")) {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      return {
        exitCode: 0,
        stdout: `${this.sessionId}\t${this.sessionName}\t`
          + `${this.windowId}\t`
          + `${this.windows.includes("agente") ? "agente" : (this.windows[0] ?? "agente")}`
          + `\t${this.paneId}\t${this.panePid}\t0\t${this.inputOff ? "1" : "0"}`
          + `\t${this.paneInMode ? "1" : "0"}`
          + `\t${this.paneOptions.get("@cauce_input_barrier") ?? ""}\n`,
        stderr: "",
      };
    }
    if (command === "display-message" && args[1] === "-p"
      && args.at(-1) === "#{pane_start_command}") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      return { exitCode: 0, stdout: `${this.paneStartCommand}\n`, stderr: "" };
    }
    if (command === "display-message" && args[1] === "-p"
      && args.at(-1)?.includes("#{pane_id}")) {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      return {
        exitCode: 0,
        stdout: `${this.sessionId}\t${this.sessionName}\t`
          + `${this.windowId}\t`
          + `${this.windows.includes("agente") ? "agente" : (this.windows[0] ?? "agente")}`
          + `\t${this.paneId}\t${this.panePid}\t0\n`,
        stderr: "",
      };
    }
    if (command === "display-message" && args[1] === "-p") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      return { exitCode: 0, stdout: `${this.panePid}\n`, stderr: "" };
    }
    if (command === "set-option") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) {
        return { exitCode: 1, stdout: "", stderr: "can't find session" };
      }
      const optionIndex = args.findIndex((value) => value.startsWith("@cauce_"));
      if (optionIndex >= 0) {
        const option = args[optionIndex];
        const value = args[optionIndex + 1];
        const paneScoped = args.some((argument) => /^-[A-Za-z]*p[A-Za-z]*$/u.test(argument));
        const options = paneScoped ? this.paneOptions : this.sessionOptions;
        if (option === undefined) return ok(1);
        if (option === "@cauce_quarantined_pane" && this.failQuarantineWrite) return ok(1);
        if (args.some((argument) => /^-[A-Za-z]*u[A-Za-z]*$/u.test(argument))) {
          options.delete(option);
        }
        else {
          if (value === undefined) return ok(1);
          options.set(option, value);
        }
      }
      return ok(0);
    }
    if (command === "select-pane") {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      if (args.includes("-d")) this.inputOff = true;
      if (args.includes("-e")) this.inputOff = false;
      return ok(0);
    }
    if (command === "load-buffer") {
      const name = args[args.indexOf("-b") + 1];
      if (name === undefined) return ok(1);
      if (this.failBufferScrub && stdin === "CAUCE_BUFFER_SCRUBBED") return ok(1);
      this.buffers.set(name, stdin ?? "");
      return ok(0);
    }
    if (command === "list-buffers") {
      if (this.failBufferInspection) return ok(1);
      return {
        exitCode: 0,
        stdout: this.buffers.size === 0 ? "" : `${[...this.buffers.keys()].join("\n")}\n`,
        stderr: "",
      };
    }
    if (command === "show-buffer") {
      if (this.failBufferInspection) return ok(1);
      const name = args[args.indexOf("-b") + 1];
      const value = name === undefined ? undefined : this.buffers.get(name);
      return value === undefined
        ? ok(1)
        : { exitCode: 0, stdout: value, stderr: "" };
    }
    if (command === "paste-buffer") {
      const target = args[args.indexOf("-t") + 1];
      const name = args[args.indexOf("-b") + 1];
      const value = name === undefined ? undefined : this.buffers.get(name);
      if (!this.targetExists(target) || value === undefined) return ok(1);
      if (this.inputOff) {
        if (args.includes("-d")) this.buffers.delete(name!);
        return ok(0);
      }
      this.inputContent += value;
      this.pasted = value;
      if (args.includes("-d")) this.buffers.delete(name!);
      return ok(0);
    }
    if (command === "delete-buffer") {
      const name = args[args.indexOf("-b") + 1];
      if (name === undefined) return ok(1);
      if (this.failDeleteBuffer) return ok(1);
      const existed = this.buffers.delete(name);
      return ok(existed ? 0 : 1);
    }
    if (command === "send-keys" && args.includes("Enter")) {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      if (this.inputOff) return ok(0);
      if (this.failEnter) return ok(1);
      const text = this.inputContent;
      this.inputContent = "";
      if (text === "") return ok(0);
      this.submittedCount += 1;
      if (this.onSubmit !== undefined) void this.onSubmit(text);
      return ok(0);
    }
    if (command === "send-keys" && args.includes("Escape")) {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      if (this.inputOff) return ok(0);
      this.interruptedCount += 1;
      if (this.interruptStopsTurn) this.paneContent = "❯ ";
      return ok(0);
    }
    if (command === "send-keys" && args.includes("C-u")) {
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) return ok(1);
      if (this.inputOff) return ok(0);
      if (this.failClearInput) return ok(1);
      if (!this.clearInputNoop) this.inputContent = "";
      return ok(0);
    }
    return ok(0);
  }

  used(command: string): boolean {
    return this.calls.some((call) => call[0] === command);
  }
}

function ok(exitCode: number): TmuxResult {
  return { exitCode, stdout: "", stderr: "" };
}

function ambiguousTmuxResult(reason: string): TmuxResult {
  return { exitCode: null, stdout: "", stderr: reason };
}

/** Un cliente fake que sólo termina cuando su cancelación/deadline lo reapea. */
function controlledTmuxHang(control?: TmuxRunControl): Promise<TmuxResult> {
  return new Promise((resolveHang) => {
    const signalAborted = (): boolean => control?.signal?.aborted === true;
    if (signalAborted()) {
      resolveHang(ambiguousTmuxResult("aborted and reaped"));
      return;
    }
    const finish = (reason: string): void => {
      clearTimeout(timer);
      control?.signal?.removeEventListener("abort", aborted);
      resolveHang(ambiguousTmuxResult(reason));
    };
    const aborted = (): void => {
      finish("aborted and reaped");
    };
    const timer = setTimeout(() => {
      finish("timed out and reaped");
    }, Math.max(1, control?.timeoutMs ?? 50));
    control?.signal?.addEventListener("abort", aborted, { once: true });
    if (signalAborted()) aborted();
  });
}

function controlledDelayedTmuxMutation(
  control: TmuxRunControl | undefined,
  delayMs: number,
  mutation: () => Promise<TmuxResult>,
): Promise<TmuxResult> {
  return new Promise((resolveDelayed) => {
    let settled = false;
    const mutationTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      control?.signal?.removeEventListener("abort", aborted);
      void mutation().then(resolveDelayed);
    }, delayMs);
    const finishAmbiguous = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(mutationTimer);
      clearTimeout(deadlineTimer);
      control?.signal?.removeEventListener("abort", aborted);
      resolveDelayed(ambiguousTmuxResult(reason));
    };
    const aborted = (): void => {
      finishAmbiguous("aborted and reaped before delayed mutation");
    };
    const deadlineTimer = setTimeout(() => {
      finishAmbiguous("timed out and reaped before delayed mutation");
    }, Math.max(1, control?.timeoutMs ?? 50));
    if (control?.signal?.aborted === true) aborted();
    else control?.signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** El camino de siempre. Registra si lo llamaron, que es justo lo que hay que poder afirmar. */
class RecordingFallback implements CommandRunner {
  calls = 0;
  constructor(private readonly stdout: string) {}
  run(_request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    return Promise.resolve({
      stdout: this.stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false,
    });
  }
}

const immediate = (): Promise<void> => Promise.resolve();

function claudeRunner(
  options: {
    alias: string;
    home: string;
    workspace: string;
    tmux: FakeTmux;
    fallback: CommandRunner;
    sleep?: (ms: number) => Promise<void>;
    cancelDrainTimeoutMs?: number;
    quarantineFile?: string;
    quarantineOperationTimeoutMs?: number;
    quarantinePersistence?: QuarantinePersistence;
    settleMs?: number;
    turnTimeoutMs?: number;
    injectTimeoutMs?: number;
    correlationTimeoutMs?: number;
    quietTimeoutMs?: number;
    mergedGraceMs?: number;
  },
): PasteSessionRunner<TranscriptEntry> {
  options.tmux.sessionName = `cauce-${options.alias}`;
  return new PasteSessionRunner({
    alias: options.alias,
    harness: "claude",
    workspace: options.workspace,
    transcript: claudeTranscript(join(options.home, ".claude"), options.workspace),
    tmux: options.tmux,
    fallback: options.fallback,
    sleep: options.sleep ?? immediate,
    acquireTimeoutMs: 30,
    turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
    settleMs: options.settleMs ?? 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    ...(options.cancelDrainTimeoutMs === undefined
      ? {}
      : { cancelDrainTimeoutMs: options.cancelDrainTimeoutMs }),
    ...(options.quarantineFile === undefined ? {} : { quarantineFile: options.quarantineFile }),
    ...(options.quarantineOperationTimeoutMs === undefined
      ? {}
      : { quarantineOperationTimeoutMs: options.quarantineOperationTimeoutMs }),
    ...(options.quarantinePersistence === undefined
      ? {}
      : { quarantinePersistence: options.quarantinePersistence }),
    ...(options.injectTimeoutMs === undefined ? {} : { injectTimeoutMs: options.injectTimeoutMs }),
    ...(options.correlationTimeoutMs === undefined
      ? {}
      : { correlationTimeoutMs: options.correlationTimeoutMs }),
    ...(options.quietTimeoutMs === undefined ? {} : { quietTimeoutMs: options.quietTimeoutMs }),
    ...(options.mergedGraceMs === undefined ? {} : { mergedGraceMs: options.mergedGraceMs }),
  });
}

async function adapterFor(
  runner: CommandRunner,
  state: string,
  alias: string,
  harness: "claude" | "codex",
): Promise<HarnessAdapter> {
  const store = await DurableStore.open(join(state, "store"));
  return new HarnessAdapter({
    definition: harness === "claude" ? claudeDefinition : codexDefinition,
    runner,
    store,
    sessionNamespace: alias,
    sharedSession: { alias, harness, stateDirectory: state },
  });
}

function execute(adapter: HarnessAdapter, prompt = "hola"): Promise<{
  reply: string | null;
  messages: readonly unknown[];
  status: string;
}> {
  return adapter.execute({
    prompt,
    sessionKey: "auth-v2:prueba",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// 1. El bus sigue produciendo el sobre, y lo hace a través de la TUI real.
// ---------------------------------------------------------------------------

test("el turno del bus produce el sobre completo cosechado del transcript", async () => {
  const { state, home, workspace } = await freshState("sobre");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    // El modelo responde envuelto en vallado Markdown, como se midió en la TUI de verdad.
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), userUuid, "```json\n" + envelopeText("desde la TUI") + "\n```", sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde la TUI");
  assert.equal(output.status, "done");
  assert.deepEqual(output.messages, []);
  // El sobre salió de la sesión compartida, no del camino de siempre.
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  for (const call of tmux.calls.filter((entry) =>
    entry[0] === "capture-pane" || entry[0] === "paste-buffer"
      || (entry[0] === "send-keys" && entry.includes("Enter")))) {
    const target = call[call.indexOf("-t") + 1];
    assert.equal(target, "%0", `operación no exacta: ${call.join(" ")}`);
  }
  // Y sin ningún aviso pegado: el turno sí pasó por la terminal.
  assert.ok(!(output.reply ?? "").includes(DEGRADED_MARK));
  assert.deepEqual(await readDegradations(state), []);
});

// ---------------------------------------------------------------------------
// 2. La TUI del dueño NO tiene que hablar el contrato del bus.
// ---------------------------------------------------------------------------

test("los turnos en prosa del dueño conviven con el sobre del bus", async () => {
  const { state, home, workspace } = await freshState("prosa");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  // Conversación previa del dueño: preguntas y respuestas en prosa, sin una sola llave.
  let head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "que tal vas?", sessionId)}\n`);
  const proseAnswer = randomUUID();
  await appendFile(file, `${assistantEntry(proseAnswer, head, "Bien, terminando el informe.", sessionId)}\n`);
  head = proseAnswer;

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("respuesta del bus"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // La prosa del dueño no rompió nada y no se coló como resultado del bus.
  assert.equal(output.reply, "respuesta del bus");
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// 3. Los dos ven el MISMO contexto: una sola rama, y se verifica la descendencia.
//    Esta es la prueba de regresión exacta de por qué la salida (a) quedó descartada.
// ---------------------------------------------------------------------------

test("no se cosecha una respuesta de una rama hermana", async () => {
  const { state, home, workspace } = await freshState("rama");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const shared = randomUUID();
  await appendFile(file, `${userEntry(shared, null, "cabeza comun", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    // Rama HERMANA: cuelga del mismo padre que nuestro turno, exactamente como pasaba con
    // `--print --resume` corriendo en paralelo a la TUI. No debe cosecharse jamás.
    const sibling = randomUUID();
    await appendFile(file, `${userEntry(sibling, shared, "otro pedido", sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), sibling, envelopeText("RAMA HERMANA"), sessionId)}\n`);
    // Nuestra rama, colgando de la cabeza de la propia TUI.
    const mine = randomUUID();
    await appendFile(file, `${userEntry(mine, shared, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), mine, envelopeText("MI RAMA"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "MI RAMA");
});

test("el turno del bus cuelga de la cabeza viva de la TUI, no de la raiz", async () => {
  const { state, home, workspace } = await freshState("cabeza");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const root = randomUUID();
  const head = randomUUID();
  await appendFile(file, `${userEntry(root, null, "primero", sessionId)}\n`);
  await appendFile(file, `${assistantEntry(head, root, "listo", sessionId)}\n`);

  let injectedParent: string | undefined;
  const tmux = new FakeTmux();
  tmux.onSubmit = async (text) => {
    // La TUI encadena desde su cabeza en memoria: eso es lo que da UNA sola rama.
    injectedParent = head;
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("ok"), sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback: new RecordingFallback("{}"),
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  await execute(adapter);
  assert.equal(injectedParent, head);
});

// ---------------------------------------------------------------------------
// 4. Escrituras simultáneas: el bus NUNCA escribe encima del dueño.
// ---------------------------------------------------------------------------

test("con la caja ocupada el bus espera y no pega nada", async () => {
  const { state, home, workspace } = await freshState("ocupada");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ estoy escribiendo algo a medias";
  let releases = 0;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "capture-pane") {
      releases += 1;
      // El dueño suelta la línea al tercer sondeo.
      if (releases >= 3) tmux.paneContent = "❯ ";
      // Antes de soltarla no se pudo haber pegado nada.
      if (releases < 3) assert.equal(tmux.pasted, undefined);
    }
    return originalRun(args, stdin);
  };
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("tras esperar"), sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback: new RecordingFallback("{}"),
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "tras esperar");
  assert.ok(releases >= 3, "tuvo que sondear hasta que la caja quedo libre");
});

test("una caja que nunca se libera degrada con aviso y sin inyectar", async () => {
  const { state, home, workspace } = await freshState("nunca-libre");
  const tmux = new FakeTmux();
  tmux.paneContent = "❯ el dueno dejo esto a medias";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("por el camino viejo") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // Nunca se tocó la caja del dueño.
  assert.equal(tmux.pasted, undefined);
  assert.equal(tmux.submittedCount, 0);
  // Se respondió, pero DICIÉNDOLO.
  assert.equal(fallback.calls, 1);
  assert.ok((output.reply ?? "").includes(DEGRADED_MARK));
  assert.ok((output.reply ?? "").includes("input_busy"));
  assert.ok((output.reply ?? "").includes("por el camino viejo"));
});

// ---------------------------------------------------------------------------
// 5. El mecanismo caído SE AVISA. Es donde murió el intento anterior.
// ---------------------------------------------------------------------------

test("sin sesion compartida se responde igual pero el aviso viaja en el reply", async () => {
  const { state, home, workspace } = await freshState("caido");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.newSessionFails = true;
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("respuesta clasica") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(fallback.calls, 1);
  const reply = output.reply ?? "";
  assert.ok(reply.includes(DEGRADED_MARK), "el aviso tiene que llegar por Telegram");
  assert.ok(reply.includes("session_absent"));
  assert.ok(reply.includes("cauce kratos"), "tiene que decir como restablecerlo");
  assert.ok(reply.includes("respuesta clasica"), "la respuesta real no se pierde");

  // Y queda registrado de forma durable, que es lo que `cauce <alias>` muestra al entrar.
  const records = await readDegradations(state);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.reason, "session_absent");
  assert.equal(records[0]?.alias, "kratos");
  assert.equal(records[0]?.fellBack, true);

  // No existe un `$N` acreditado al cual avisar. Apuntar por nombre acá abriría una carrera:
  // una sesión homónima creada después del preflight recibiría un aviso que no le pertenece.
  // El aviso durable del reply/registro de arriba es la única superficie segura en este caso.
  assert.equal(tmux.used("display-message"), false);
  assert.equal(tmux.used("set-option"), false);
  // Pero SIN renombrar la ventana. Ver la prueba de enclavamiento de más abajo.
  assert.equal(tmux.used("rename-window"), false);
});

test("una TUI reiniciada avisa aunque el turno si pase por la terminal", async () => {
  const { state, home, workspace } = await freshState("reinicio");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("sigo aca"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  await execute(adapter);

  // claude se auto-actualiza y se relanza: el panel pasa a ser otro proceso.
  tmux.panePid = "9999";
  const second = await execute(adapter, "segundo");

  const reply = second.reply ?? "";
  assert.ok(reply.includes(RESET_MARK), "el reinicio se tiene que ver");
  assert.ok(reply.includes("context_reset"));
  assert.ok(reply.includes("sigo aca"), "el turno si paso por la terminal");
  assert.equal(fallback.calls, 0, "un reinicio NO es motivo para caer al camino viejo");
});

// ---------------------------------------------------------------------------
// codex: el MISMO mecanismo, y el sobre sale de su rollout.
// ---------------------------------------------------------------------------

/**
 * Una línea de rollout con la forma EXACTA que escribe codex 0.144.6.
 *
 * Copiada del rollout vivo de socrates del 2026-07-31, no de la documentación: es el fichero en el
 * que quedó registrado el `PEGADO` que se probó a mano en su panel.
 */
function rolloutLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
}

function codexStarted(turnId: string): string {
  return rolloutLine("event_msg", { type: "task_started", turn_id: turnId });
}

/** El pedido, tal como lo registra codex: `response_item` de rol `user` CON su `turn_id`. */
function codexUser(text: string, turnId: string): string {
  return rolloutLine("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

/** El cierre del turno, que trae el desenlace Y la respuesta final, los dos con `turn_id`. */
function codexComplete(turnId: string, text: string): string {
  return rolloutLine("event_msg", {
    type: "task_complete", turn_id: turnId, last_agent_message: text,
  });
}

function codexAborted(turnId: string): string {
  return rolloutLine("event_msg", {
    type: "turn_aborted", turn_id: turnId, reason: "interrupted",
  });
}

async function codexWorkspace(name: string): Promise<{
  state: string;
  codexHome: string;
  rollout: string;
  sessionId: string;
}> {
  const { state, home } = await freshState(name);
  const codexHome = join(home, ".codex");
  const day = join(codexHome, "sessions", "2026", "07", "31");
  await mkdir(day, { recursive: true });
  const sessionId = randomUUID();
  // El nombre lleva el session_id, que es de donde sale la sesión observada sin abrir el fichero.
  const rollout = join(day, `rollout-2026-07-31T16-33-07-${sessionId}.jsonl`);
  await appendFile(rollout, `${rolloutLine("session_meta", { session_id: sessionId })}\n`);
  return { state, codexHome, rollout, sessionId };
}

function codexRunner(
  options: { alias: string; codexHome: string; tmux: FakeTmux; fallback: CommandRunner },
): PasteSessionRunner<RolloutLine> {
  options.tmux.sessionName = `cauce-${options.alias}`;
  if (options.tmux.sessionOptions.size === 0) options.tmux.paneStartCommand = "exec codex";
  return new PasteSessionRunner({
    alias: options.alias,
    harness: "codex",
    workspace: "/workspace",
    transcript: codexTranscript(options.codexHome),
    tmux: options.tmux,
    fallback: options.fallback,
    sleep: immediate,
    acquireTimeoutMs: 30,
    turnTimeoutMs: 2_000,
    injectTimeoutMs: 20,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
  });
}

test("el turno del bus entra por la caja de codex y el sobre sale de su rollout", async () => {
  const { state, codexHome, rollout, sessionId } = await codexWorkspace("codex-sobre");
  const tmux = new FakeTmux();
  // La caja de codex se dibuja con `›`, no con `❯`.
  tmux.paneContent = "› ";
  const fallback = new RecordingFallback("{}");
  const turnId = "019fb910-ddd9-7d80-af14-8cb69357d917";
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted(turnId),
      codexUser(text, turnId),
      codexComplete(turnId, envelopeText("desde codex")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde codex");
  assert.equal(fallback.calls, 0);
  // El pedido entró por la caja de entrada, entre corchetes y como UNA sola entrada.
  assert.ok(tmux.used("load-buffer"));
  assert.ok(tmux.calls.some((call) => call[0] === "paste-buffer" && call.includes("-p")));
  assert.equal(tmux.submittedCount, 1);
  // Y la conversación observada es la del rollout, que es la que reanudaría el camino de siempre.
  assert.equal(rolloutSessionId(rollout), sessionId);
});

test("codex ignora un rollout headless ajeno y rescata sólo el sobre con su nonce", async () => {
  const { state, codexHome, rollout } = await codexWorkspace("codex-multifile-headless");
  const headlessSessionId = randomUUID();
  const headless = join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "31",
    `rollout-2026-07-31T16-34-00-${headlessSessionId}.jsonl`,
  );
  await appendFile(
    headless,
    `${rolloutLine("session_meta", { session_id: headlessSessionId })}\n`,
  );
  const tmux = new FakeTmux();
  tmux.paneContent = "› \nEsc to interrupt\n";
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(
      headless,
      `${codexComplete("headless", envelopeText("RESPUESTA HEADLESS"))}\n`,
    );
    await appendFile(
      rollout,
      `${codexComplete(
        "fundido",
        envelopeText("RESPUESTA TUI", correlationIdFromPrompt(text)),
      )}\n`,
    );
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("RESPUESTA TUI"));
  assert.ok(!(output.reply ?? "").includes("RESPUESTA HEADLESS"));
  assert.equal(fallback.calls, 0);
});

test("codex recorta el salto final al enviar y aun así se reconoce el turno", async () => {
  // Medido en ws-prizma el 2026-07-31: se pegó un fichero de 88 bytes acabado en `\n` y el
  // `response_item` guardó 87. `protocolPrompt` termina SIEMPRE en `\n`, así que con igualdad
  // byte a byte el runner no reconocería jamás su propio turno; vería el `task_started` —el turno
  // corrió de verdad— y esperaría el presupuesto entero. El dueño: agente mudo 30 minutos con la
  // respuesta ya escrita en su panel.
  const { state, codexHome, rollout } = await codexWorkspace("codex-recorte");
  const tmux = new FakeTmux();
  tmux.paneContent = "› ";
  const fallback = new RecordingFallback("{}");
  const turnId = "019fb92d-2577-7c12-a243-7152c7e05bce";
  tmux.onSubmit = async (text) => {
    // Exactamente lo que hace la caja de codex: recorta el blanco final.
    assert.ok(/\s$/u.test(text), "el prompt de protocolo tiene que llegar con blanco al final");
    await appendFile(rollout, `${[
      codexStarted(turnId),
      codexUser(text.replace(/\s+$/u, ""), turnId),
      codexComplete(turnId, envelopeText("recortado y reconocido")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "recortado y reconocido");
  // Lo que importa: NO degradó al camino de siempre y NO se comió el presupuesto.
  assert.equal(fallback.calls, 0);
});

test("el turno del dueño no puede cortar la cosecha del turno del bus", async () => {
  // El rollout es COMPARTIDO: mientras corre el turno del bus, el dueño puede lanzar el suyo desde
  // el panel. Sin filtrar por `turn_id`, su `task_complete` cerraría la cosecha y el bus se
  // llevaría la respuesta ajena.
  const { state, codexHome, rollout } = await codexWorkspace("codex-turno-ajeno");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted("turno-del-bus"),
      codexUser(text, "turno-del-bus"),
      codexStarted("turno-del-dueño"),
      codexUser("lo que escribió el dueño", "turno-del-dueño"),
      codexComplete("turno-del-dueño", envelopeText("RESPUESTA AJENA")),
      codexComplete("turno-del-bus", envelopeText("MI RESPUESTA")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "MI RESPUESTA");
  assert.equal(fallback.calls, 0);
});

test("codex avisa cuando compacta durante el turno", async () => {
  const { state, codexHome, rollout } = await codexWorkspace("codex-compactacion");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted("t1"),
      codexUser(text, "t1"),
      // Forma real: el aviso de compactación de codex NO trae ningún campo, ni cifras ni id.
      rolloutLine("event_msg", { type: "context_compacted" }),
      codexComplete("t1", envelopeText("respondido tras compactar")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.ok(reply.includes("respondido tras compactar"));
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_compacted"));
  assert.equal(fallback.calls, 0);
  assert.equal((await readDegradations(state))[0]?.fellBack, false);
});

test("Enter aceptado sin startedTurn queda ambiguo y bloquea un segundo pegado", async () => {
  // Aceptar Enter es el commit: que el rollout todavía no lo haya registrado NO prueba que no
  // corrió. El antiguo fallback podía ejecutar el mismo pedido dos veces y liberar el mismo pane.
  const { state: _state, codexHome } = await codexWorkspace("codex-sin-registro");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  // El Enter no produce nada: el rollout no crece.
  tmux.onSubmit = undefined;

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const first = await runner.run({
    command: "codex",
    args: [],
    harness: "codex",
    stdin: "pedido que pudo arrancar",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(first.timedOut, true);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /paste\+Enter.*cuarentena/u);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  const second = await runner.run({
    command: "codex",
    args: [],
    harness: "codex",
    stdin: "no reutilizar la generación ambigua",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  assert.equal(second.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1, "el segundo pedido no entra en el pane ambiguo");
});

test("un turno que el dueño interrumpe no se cobra como respuesta", async () => {
  // Sin esto el runner espera el presupuesto entero por una respuesta que ya nadie va a escribir, y
  // el dueño ve un agente mudo durante los 30 minutos del plazo de ACK.
  const { state, codexHome, rollout } = await codexWorkspace("codex-interrumpido");
  void state;
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted("t1"),
      codexUser(text, "t1"),
      codexAborted("t1"),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const outcome = await runner.run({
    command: "codex",
    args: [],
    harness: "codex",
    stdin: "pedido del bus",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /se interrumpió/u);
  // Y NO se reintenta por el camino de siempre: el turno sí entró en la terminal.
  assert.equal(fallback.calls, 0);
});

test("cancelar durante el preflight corta después del await y no ejecuta ningún camino", async () => {
  const { home, workspace } = await freshState("abort-preflight");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "list-sessions") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no ejecutar",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, false);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.calls.some((call) => call.includes("Enter")), false);
});

test("cancelar durante acquire se observa tras capture y preserva la caja humana", async () => {
  const { home, workspace } = await freshState("abort-acquire");
  const tmux = new FakeTmux();
  tmux.paneContent = "❯ borrador humano";
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "capture-pane") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no ejecutar",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.calls.some((call) => call.includes("C-u")), false);
  assert.equal(tmux.paneContent, "❯ borrador humano");
});

test("cancelar después del paste compromete Enter y nunca deja un prompt ejecutable", async () => {
  const { home, workspace } = await freshState("abort-tras-paste");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
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
    fallback,
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
  // Un Enter humano posterior encuentra una caja vacía: no puede revivir la entrega cancelada.
  await tmux.run(["send-keys", "-t", tmux.paneId, "Enter"]);
  assert.equal(submitted.length, 1);
  assert.equal(fallback.calls, 0);
});

test("un settle colgado tras paste termina la generación antes de liberar", async () => {
  const { home, workspace } = await freshState("settle-colgado-post-paste");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
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
  assert.match(outcome.stderr, /espera entre paste y Enter.*ambiguo/u);
  assert.equal(tmux.sessionExists, false, "la caja pegada no puede quedar reutilizable");
  assert.equal(tmux.calls.some((call) => call.includes("Enter") || call.includes("C-u")), false);
  assert.equal(fallback.calls, 0);
});

test(
  "tmux real: cancelar tras paste igualmente compromete Enter y borra el buffer nombrado",
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-shared-commit-"));
    const output = join(scratch, "submitted.txt");
    const socket = `cauce-test-${process.pid}-${randomUUID().slice(0, 8)}`;
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
      // La frontera comprometida ignora la cancelación y entrega Enter al MISMO pane exacto.
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

      // Un Enter posterior no vuelve a ejecutar el prompt: el proceso ya consumió la caja.
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
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const socket = `cauce-copy-mode-${process.pid}-${randomUUID().slice(0, 8)}`;
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

      // `choose-tree` apila una segunda modalidad humana sin ejecutar un proceso fallido ni
      // contaminar stdout/stderr. La rama rechazada no puede disparar after-display y apilar una
      // tercera modalidad.
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
  {
    skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0
      || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
  },
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
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
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
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
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

  // Simula un crash/runner ajeno en la fase anterior al commit. Su correlation y token no son los
  // del intento vencido: debe ser ignorable, pero jamás borrado por una compensación amplia.
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

  // La operación no cooperativa realmente termina tarde y escribe a disco; su continuación causal
  // retira sólo SU preparación. El arming de otro token sobrevive byte a byte.
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
  assert.equal(latePreparationPublished, true);
  assert.deepEqual(
    (await readdir(state)).filter((name) => name.endsWith(".arming")),
    [basename(foreignArming)],
  );
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
    // La segunda precondición ya acreditó pane/PID/nombres, pero aún no capturó la caja.
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
      // Esta es exactamente la ventana R4: la foto ya volvió y el if-shell aún no empezó.
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
    const { home, workspace } = await freshState(`input-hook-inseguro-${index}`);
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
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-after-load-preexisting-"));
    const output = join(scratch, "lines.txt");
    const socket = `cauce-after-load-${process.pid}-${randomUUID().slice(0, 8)}`;
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
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cauce-after-load-race-"));
    const output = join(scratch, "lines.txt");
    const socket = `cauce-after-load-race-${process.pid}-${randomUUID().slice(0, 8)}`;
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
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const socket = `cauce-test-${process.pid}-${randomUUID().slice(0, 8)}`;
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

  // Nueva instancia: no conserva `locallyQuarantined`; sólo la evidencia durable puede bloquearla.
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

  // Simula reinicio del runner y pérdida de la redundancia tmux. Sólo queda el pending real de
  // disco, escrito ANTES del paste; la persistencia de prueba ya no participa en esta instancia.
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
  assert.match(outcome.stderr, /presupuesto terminó.*cuarentena/u);
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
  assert.match(outcome.stderr, /presupuesto terminó.*cuarentena/u);
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
  // La sesión responde a has-session pero el panel no existe: la TUI se murió dentro.
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
  // Regresión de un fallo medido en ws-prizma el 2026-07-30. Con la sesión `cauce-socrates`
  // teniendo sólo la ventana `servidor`, `tmux display-message -p -t cauce-socrates:agente` NO
  // falla: cae a la ventana actual y devuelve su PID con exit 0. Ni el prefijo `=` lo evita.
  //
  // Consecuencia real: `ensure` decía `ready:true`, `cauce socrates` anunciaba COMPARTIDA y el
  // adaptador daba por compartida una conversación con una ventana que no existía — la clase de
  // éxito silencioso que este trabajo existe para eliminar. La única defensa es enumerar con
  // `list-windows` y comparar por igualdad exacta.
  const { state, home, workspace } = await freshState("ventana-fantasma");
  const tmux = new FakeTmux();
  tmux.sessionExists = true;
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  tmux.windows = ["servidor"]; // la ventana `agente` se murió al nacer
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    // El tmux real MIENTE acá: responde por otra ventana en vez de fallar.
    if (args[0] === "display-message" && args[1] === "-p") {
      return { exitCode: 0, stdout: "14667\n", stderr: "" };
    }
    return originalRun(args, stdin);
  };
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // Cayó al camino de siempre y lo dijo, en vez de creerse el PID prestado.
  assert.equal(fallback.calls, 1);
  assert.ok((output.reply ?? "").includes("tui_absent"));
  assert.equal((await readDegradations(state))[0]?.reason, "tui_absent");
});

// ---------------------------------------------------------------------------
// Piezas sueltas cuyo comportamiento exacto sostiene todo lo de arriba.
// ---------------------------------------------------------------------------

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
  // Si la hereda, el servidor de tmux se demoniza con ella puesta, el supervisor lo ve como
  // proceso no rastreado y el alias no se puede reiniciar NUNCA MAS (exit 78, unidad `failed`,
  // adaptador viejo vivo). Medido en atlas y dedalo el 2026-08-06.
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
        assert.notEqual(pidText, undefined, `el cliente ${stem} debe haber arrancado`);
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

// ---------------------------------------------------------------------------
// Regresión de los agujeros que midieron los tres diagnósticos del 2026-07-30.
// Cada prueba de acá reproduce un fallo OBSERVADO, no uno imaginado.
// ---------------------------------------------------------------------------

/** Una compactación real, con la forma exacta que escribe claude 2.1.220. */
function boundaryEntry(
  uuid: string,
  logicalParentUuid: string,
  trigger: "auto" | "manual",
  preTokens: number,
  postTokens: number,
): string {
  return JSON.stringify({
    type: "system", subtype: "compact_boundary", uuid, parentUuid: null, logicalParentUuid,
    isSidechain: false, content: "Conversation compacted", level: "info",
    compactMetadata: {
      trigger, preTokens, postTokens,
      cumulativeDroppedTokens: preTokens - postTokens, durationMs: 153_352,
    },
  });
}

function parseEntries(...lines: readonly string[]): readonly TranscriptEntry[] {
  return lines.map((line) => JSON.parse(line) as TranscriptEntry);
}

test("la cosecha atraviesa una compactación a mitad de turno", () => {
  // El fallo medido: una compactación CORTA la cadena de padres —el `compact_boundary` trae
  // `parentUuid: null` y la continuidad sólo vive en `logicalParentUuid`— y además REEMITE el
  // segmento preservado con los MISMOS uuid recolgados del resumen (1.873 uuid repetidos en un
  // transcript real de 13.976 entradas). Con cualquiera de las dos cosas sin tratar,
  // `findFinalAssistant` devuelve `undefined`: el runner no cosecha nunca, agota una hora de
  // presupuesto y entrega AMBIGUO. El agente contestó y el dueño ve una entrega muerta.
  const inj = "11111111-1111-4111-8111-111111111111";
  const a1 = "22222222-2222-4222-8222-222222222222";
  const leaf = "33333333-3333-4333-8333-333333333333";
  const boundary = "44444444-4444-4444-8444-444444444444";
  const summary = "55555555-5555-4555-8555-555555555555";
  const final = "66666666-6666-4666-8666-666666666666";
  const sid = "sesion-1";

  const entries = parseEntries(
    userEntry(inj, null, "pedido del bus", sid),
    assistantEntry(a1, inj, "voy a mirar", sid, "tool_use"),
    userEntry(leaf, a1, "resultado de la herramienta", sid),
    boundaryEntry(boundary, leaf, "auto", 767_812, 12_269),
    userEntry(summary, boundary, "resumen de la conversación", sid),
    // La copia REEMITIDA del segmento preservado: mismo uuid, otro padre.
    userEntry(leaf, summary, "resultado de la herramienta", sid),
    assistantEntry(final, summary, envelopeText("tras compactar"), sid),
  );

  const answer = findFinalAssistant(entries, inj);
  assert.notEqual(answer, undefined);
  assert.ok((answer?.text ?? "").includes("tras compactar"));

  // Y las dos piezas por separado, para que se vea qué sostiene qué.
  const byUuid = indexByUuid(entries);
  assert.equal(byUuid.get(leaf)?.parentUuid, a1, "el índice se queda con la PRIMERA aparición");
  assert.equal(descendsFrom(byUuid, entries[6]!, inj), true);
});

test("una compactación durante el turno se cosecha Y se avisa con sus cifras", async () => {
  const { state, home, workspace } = await freshState("compactacion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const injected = randomUUID();
    const leaf = randomUUID();
    const boundary = randomUUID();
    const summary = randomUUID();
    await appendFile(file, `${userEntry(injected, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(leaf, injected, "trabajando", sessionId, "tool_use")}\n`);
    await appendFile(file, `${boundaryEntry(boundary, leaf, "auto", 767812, 12269)}\n`);
    await appendFile(file, `${userEntry(summary, boundary, "resumen", sessionId)}\n`);
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), summary, envelopeText("respondido tras compactar"), sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  // 1. La entrega NO se pierde.
  assert.ok(reply.includes("respondido tras compactar"));
  assert.equal(fallback.calls, 0, "compactar no es motivo para caer al camino viejo");
  // 2. Y el remitente se entera de que la memoria ya no es la que cree, con las cifras del evento.
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_compacted"));
  assert.ok(reply.includes("auto"));
  assert.ok(reply.includes("767812"), "las cifras las trae el propio evento");
  assert.ok(reply.includes("12269"));
  // 3. Y el dueño también, en su panel, sin teñirlo de rojo (no es una caída).
  assert.ok(tmux.calls.some((call) =>
    call[0] === "display-message" && call.some((part) => part.includes("context_compacted"))));
  assert.equal(
    tmux.calls.some((call) => call[0] === "set-option" && call.includes("status-style")
      && call.includes("bg=red,fg=white")),
    false,
  );
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "context_compacted");
  assert.equal(records[0]?.fellBack, false);
});

test("un /clear del dueño se dice en la respuesta en vez de mentir", async () => {
  // Medido: `/clear` cierra el `.jsonl` y abre otro con sessionId nuevo, sin marcar el viejo y SIN
  // reiniciar el proceso (`pane_pid` idéntico), así que el heurístico de PID no lo ve jamás. La
  // cosecha seguía funcionando perfecta: el bus entregaba una respuesta impecable producida por un
  // contexto vacío, con cero señal en ninguna superficie.
  const { state, home, workspace } = await freshState("clear");
  const directory = transcriptDirectory(home, workspace);
  const primera = randomUUID();
  const segunda = randomUUID();
  let sessionId = primera;

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const file = join(directory, `${sessionId}.jsonl`);
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("respondido"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const first = await execute(adapter);
  assert.ok(!(first.reply ?? "").includes(CONTEXT_MARK), "el primer turno no puede avisar de nada");

  // El dueño teclea /clear: fichero nuevo, sessionId nuevo, MISMO proceso en el panel.
  sessionId = segunda;
  const second = await execute(adapter, "segundo pedido");

  const reply = second.reply ?? "";
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_cleared"));
  assert.ok(reply.includes("respondido"), "el turno SÍ pasó por la terminal: no se degrada");
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.panePid, "4242", "sin reinicio de proceso: el PID no delata nada");
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "context_cleared");
  assert.equal(records[0]?.fellBack, false);
});

test("resucitar la sesión no puede parecer una sesión compartida de siempre", async () => {
  // Medido: borrada la sesión entera, la entrega creó una TUI nueva, contestó en 75,9 s con
  // `exitCode 0` y CERO avisos. `ensure` ya devolvía `created:true` y el runner lo descartaba.
  const { state, home, workspace } = await freshState("resurreccion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("desde una TUI nueva"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.ok(reply.includes("desde una TUI nueva"), "el turno sí se sirvió");
  assert.equal(fallback.calls, 0, "crear la sesión NO es caer al camino viejo");
  assert.ok(reply.includes(RESET_MARK));
  assert.ok(reply.includes("session_created"));
  assert.equal((await readDegradations(state))[0]?.reason, "session_created");
});

test("un diálogo abierto no se confunde con una línea a medio escribir", async () => {
  const { state, home, workspace } = await freshState("modal");
  const tmux = new FakeTmux();
  // El diálogo real de confianza de carpeta, tal como lo dibuja claude 2.1.220.
  tmux.paneContent = "Quick safety check\n❯ 1. Yes, I trust this folder";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("por el camino viejo") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.equal(tmux.pasted, undefined, "no se pega NADA dentro de un diálogo");
  assert.ok(reply.includes("modal_blocking"));
  assert.ok(reply.includes("contestá el diálogo"), "la salida es contestar, no borrar");
  assert.ok(!reply.includes("input_busy"));
  assert.equal((await readDegradations(state))[0]?.reason, "modal_blocking");
});

test("una degradación NO deja la sesión enclavada para siempre", async () => {
  // El defecto más grave que encontró el diagnóstico 2, verificado de punta a punta: al degradar,
  // la versión anterior renombraba la ventana a `⚠ CAUCE-DEGRADADO`; `tuiTarget()` la busca por
  // nombre, así que a partir de ahí TODAS las entregas degradaban `tui_absent` en 0,2 s, para
  // siempre, con la TUI viva y sana delante, y diciéndole al dueño la mentira «la sesión existe
  // pero no tiene panel de TUI».
  const { state, home, workspace } = await freshState("enclavada");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ el dueno esta escribiendo";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("de vuelta en la terminal"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const degraded = await execute(adapter);
  assert.ok((degraded.reply ?? "").includes(DEGRADED_MARK));
  assert.deepEqual(tmux.windows, ["agente"], "la ventana conserva su identidad");

  // El dueño suelta la caja: el turno siguiente tiene que volver a la terminal.
  tmux.paneContent = "❯ ";
  const recovered = await execute(adapter, "segundo");
  assert.ok((recovered.reply ?? "").includes("de vuelta en la terminal"));
  assert.equal(fallback.calls, 1, "sólo degradó el primero");
});

test("una sesión ya enclavada por el build viejo se repara sola", async () => {
  const { state, home, workspace } = await freshState("reparacion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  // Como quedan hoy las sesiones que ya degradaron con la versión que renombraba.
  tmux.windows = ["⚠ CAUCE-DEGRADADO"];
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("resucitada"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("resucitada"));
  assert.deepEqual(tmux.windows, ["agente"]);
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// El entorno del panel: el mismo lo cree quien lo cree.
// ---------------------------------------------------------------------------

test("la TUI arranca con el mismo entorno la cree el adaptador o el CLI", () => {
  // El servidor tmux se queda con el entorno del PRIMER cliente que lo crea y DESCARTA el de los
  // siguientes (medido en ws-prizma con un socket aislado). Por eso el entorno viaja en el ARGV del
  // panel y por eso los dos creadores tienen que sacarlo del mismo sitio.
  const environment = { HOME: "/home/dev" } as NodeJS.ProcessEnv;
  const adapter = loadSharedSessionConfig("codex", "socrates", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  const cli = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", environment);
  assert.deepEqual(adapter?.paneEnvironment, { CODEX_HOME: "/home/dev/.codex" });
  assert.deepEqual(cli.environment, adapter?.paneEnvironment);

  // claude usa su propia variable, y es la MISMA con la que se resuelven los transcripts.
  const claude = loadSharedSessionConfig("claude", "kratos", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  assert.deepEqual(claude?.paneEnvironment, { CLAUDE_CONFIG_DIR: "/home/dev/.claude" });
  assert.equal(claude?.configDirectory, "/home/dev/.claude");
  assert.equal(
    transcriptDirectoryIn(claude.configDirectory, "/workspace"),
    transcriptDirectory("/home/dev", "/workspace"),
  );

  // Un valor declarado manda sobre el defecto; uno relativo es un error, no un apaño silencioso.
  assert.deepEqual(
    sharedSessionPaneEnvironment("codex", "/home/dev", { CODEX_HOME: "/datos/codex" }),
    { CODEX_HOME: "/datos/codex" },
  );
  assert.throws(() => sharedSessionPaneEnvironment("codex", "/home/dev", { CODEX_HOME: "relativo" }));
});

test("el entorno se escapa y entra en el argv del panel", async () => {
  const prefix = paneEnvironmentPrefix({ CODEX_HOME: "/home/dev/.codex" });
  assert.deepEqual(prefix, { ok: true, prefix: "env CODEX_HOME='/home/dev/.codex' " });
  // Un valor con comilla no puede salirse a la línea de comandos.
  const raro = paneEnvironmentPrefix({ CLAUDE_CONFIG_DIR: "/tmp/x'; rm -rf /" });
  assert.equal(raro.ok, true);
  assert.equal(raro.ok && raro.prefix.includes("'\\''"), true);
  // Y un nombre inválido falla DICIÉNDOLO, en vez de arrancar la TUI con menos entorno del pedido.
  assert.equal(paneEnvironmentPrefix({ "MAL NOMBRE": "x" }).ok, false);

  const { home, workspace } = await freshState("entorno-argv");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  await ensureSharedSession(
    tmux,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude",
      environment: { CLAUDE_CONFIG_DIR: `${home}/.claude` },
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );
  const created = tmux.calls.find((call) => call[0] === "new-session");
  assert.ok(created?.at(-1)?.startsWith(`exec env CLAUDE_CONFIG_DIR='${home}/.claude' claude`));
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "kratos");
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "claude");
});

// ---------------------------------------------------------------------------
// Identidad de la sesion: el nombre solo no acredita qué harness vive adentro.
// ---------------------------------------------------------------------------

test("una sesion legacy correcta se infiere una vez y queda marcada alias+harness", async () => {
  const { workspace } = await freshState("identidad-legacy");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-socrates";
  tmux.sessionOptions.clear();
  tmux.paneStartCommand = "bash -lc 'exec env CODEX_HOME=/home/dev/.codex /usr/local/bin/codex resume --last'";

  const result = await ensureSharedSession(
    tmux,
    { alias: "socrates", harness: "codex", workspace, command: "/usr/local/bin/codex" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.created, false);
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "socrates");
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "codex");
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("new-session"), false);
});

test("una sesion marcada con otro harness falla cerrado y nunca se destruye", async () => {
  const { workspace } = await freshState("identidad-harness-incompatible");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-salva";
  tmux.sessionOptions.set("@cauce_alias", "salva");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  tmux.paneStartCommand = "exec claude";

  const result = await ensureSharedSession(
    tmux,
    { alias: "salva", harness: "codex", workspace, command: "codex" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "session_harness_mismatch");
  assert.match(result.detail, /conserva intacta/u);
  assert.equal(tmux.sessionExists, true);
  assert.deepEqual(tmux.windows, ["agente"]);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("rename-window"), false);
  assert.equal(tmux.used("new-session"), false);
});

test("respawn-pane no hereda la identidad aunque conserve marcadores y pane_id", async () => {
  const { workspace } = await freshState("identidad-respawn-marcada");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-kratos";
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  const paneId = tmux.paneId;
  tmux.respawnPane("exec sh");

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(tmux.paneId, paneId, "respawn-pane conservó %pane_id");
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("new-session"), false);
});

test("una ventana TUI con más de un pane falla cerrada sin elegir el activo", async () => {
  const { workspace } = await freshState("identidad-multipane");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-kratos";
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  tmux.extraPaneCount = 1;

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(tmux.used("kill-session"), false);
});

test(
  "tmux real: un respawn con otro comando invalida una sesión marcada",
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const socket = `cauce-identity-${process.pid}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-s", "cauce-kratos", "-n", "agente", "exec sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      assert.equal((await tmux.run([
        "set-option", "-t", "cauce-kratos", "@cauce_alias", "kratos",
      ])).exitCode, 0);
      assert.equal((await tmux.run([
        "set-option", "-t", "cauce-kratos", "@cauce_harness", "claude",
      ])).exitCode, 0);

      const before = await ensureSharedSession(
        tmux,
        { alias: "kratos", harness: "claude", workspace: "/tmp", command: "sleep" },
        { sleep: immediate, readyTimeoutMs: 30 },
      );
      assert.equal(before.ready, true, before.detail);
      assert.ok(before.pane);
      const respawned = await tmux.run([
        "respawn-pane", "-k", "-t", before.pane.paneId, "exec tail -f /dev/null",
      ]);
      assert.equal(respawned.exitCode, 0, respawned.stderr);

      const after = await ensureSharedSession(
        tmux,
        { alias: "kratos", harness: "claude", workspace: "/tmp", command: "sleep" },
        { sleep: immediate, readyTimeoutMs: 30 },
      );
      assert.equal(after.ready, false);
      assert.equal(after.failure, "session_identity_unverified");
      assert.equal((await tmux.run(["has-session", "-t", "=cauce-kratos"])).exitCode, 0);
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
    }
  },
);

test("el adaptador degrada con razon explicita ante harness incompatible", async () => {
  const { state, codexHome } = await codexWorkspace("identidad-harness-aviso");
  const tmux = new FakeTmux();
  tmux.sessionOptions.set("@cauce_alias", "socrates");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  const fallback = new RecordingFallback([
    JSON.stringify({ type: "thread.started", thread_id: "fallback" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: envelopeText("camino seguro") },
    }),
  ].join("\n"));
  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");

  const result = await execute(adapter);

  assert.equal(fallback.calls, 1);
  assert.match(result.reply ?? "", /session_harness_mismatch/u);
  assert.match(result.reply ?? "", /conservó intacta/u);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
});

test("un marcador de otro alias falla cerrado sin corregirlo ni tocar el panel", async () => {
  const { workspace } = await freshState("identidad-alias-incompatible");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-atlas";
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "codex");

  const result = await ensureSharedSession(
    tmux,
    { alias: "atlas", harness: "codex", workspace, command: "codex" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "session_alias_mismatch");
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "kratos");
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("rename-window"), false);
});

test("una sesion legacy ambigua queda viva pero no se acredita", async () => {
  const { workspace } = await freshState("identidad-legacy-ambigua");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-salva";
  tmux.sessionOptions.clear();
  tmux.paneStartCommand = "bash -lc 'exec codex-wrapper --fallback claude'";

  const result = await ensureSharedSession(
    tmux,
    { alias: "salva", harness: "codex", workspace, command: "codex-wrapper" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "session_identity_unverified");
  assert.equal(tmux.sessionOptions.size, 0, "una inferencia ambigua no puede dejar marcas parciales");
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("rename-window"), false);
});

test("dos ensure concurrentes acreditan el mismo session_id y el perdedor no mata por nombre", async () => {
  const { workspace } = await freshState("ensure-doble");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const spec = { alias: "socrates", harness: "codex" as const, workspace, command: "codex" };

  const [first, second] = await Promise.all([
    ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 30 }),
    ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 30 }),
  ]);

  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(first.sessionId, second.sessionId);
  assert.match(first.sessionId ?? "", /^\$[0-9]+$/u);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 2);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "socrates");
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "codex");
});

test("el cleanup atómico rechaza un rename en la antigua frontera compare-kill", async () => {
  const tmux = new FakeTmux();
  const creationNonce = "a".repeat(64);
  tmux.sessionOptions.set("@cauce_creation_nonce", creationNonce);
  const identity = await paneIdentity(tmux, tmux.paneId);
  assert.ok(identity);
  const ownership = {
    ...identity,
    paneStartCommand: tmux.paneStartCommand,
    creationNonce,
  };
  const originalRun = tmux.run.bind(tmux);
  let raced = false;
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    if (!raced && args[0] === "if-shell"
      && args.some((argument) => argument.includes("#{session_name}"))) {
      raced = true;
      tmux.sessionName = "renombrada-antes-de-la-orden";
    }
    return originalRun(args, stdin);
  };

  const killed = await killSessionIdIfNamed(tmux, ownership);

  assert.equal(killed, false);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.sessionName, "renombrada-antes-de-la-orden");
  assert.equal(tmux.calls.filter((call) => call[0] === "if-shell").length, 1);
  assert.equal(tmux.used("list-sessions"), false, "no existe compare separado antes del kill");
  assert.equal(tmux.used("kill-session"), false);
});

test(
  "tmux real: cleanup CAS de cuarentena preserva exactamente una marca concurrente y la UI",
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const socket = `cauce-quarantine-cas-${process.pid}-${randomUUID().slice(0, 8)}`;
    const base = new CliTmux(socket);
    try {
      const created = await base.run([
        "new-session", "-d", "-s", "quarantine-cas", "-n", "agente", "sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      const identity = await paneIdentity(base, "quarantine-cas:agente");
      assert.ok(identity);
      const stale = "$9:@9:%9:9999";
      const concurrent = "$8:@8:%8:8888";
      assert.equal((await base.run([
        "set-option", "-t", identity.sessionId, "@cauce_quarantined_pane", stale,
      ])).exitCode, 0);
      assert.equal((await base.run([
        "set-hook", "-g", "after-display-message", "list-panes -F HOOK_OUTPUT",
      ])).exitCode, 0);
      let racedState: string | undefined;
      const tmux: TmuxController = {
        run: async (args, stdin, control): Promise<TmuxResult> => {
          if (racedState === undefined && args[0] === "if-shell"
            && args.some((argument) => argument.includes("@cauce_quarantined_pane"))) {
            const changed = await base.run([
              "set-option", "-t", identity.sessionId,
              "@cauce_quarantined_pane", concurrent,
            ]);
            assert.equal(changed.exitCode, 0, changed.stderr);
            racedState = await exactTmuxPaneStateViaList(base, identity.paneId);
          }
          return base.run(args, stdin, control);
        },
      };

      assert.equal(await clearPaneQuarantine(tmux, identity), false);
      assert.equal((await base.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.ok(racedState);
      assert.equal(await exactTmuxPaneState(base, identity.paneId), racedState);
      assert.equal(racedState.split("\t")[11], concurrent);
      assert.doesNotThrow(() => process.kill(Number(identity.panePid), 0));

      // La otra cleanup CAS tampoco puede tocar UI al rechazar/aceptar: el hook copy-mode sólo se
      // dispararía si reapareciera display-message en su canal de testigo o postcondición.
      const currentGeneration = `${identity.sessionId}:${identity.windowId}`
        + `:${identity.paneId}:${identity.panePid}`;
      assert.equal((await base.run([
        "set-option", "-t", identity.sessionId,
        "@cauce_quarantined_pane", currentGeneration,
      ])).exitCode, 0);
      const currentMarked = await exactTmuxPaneState(base, identity.paneId);
      assert.equal((await base.run([
        "set-hook", "-g", "after-display-message", `copy-mode -t ${identity.paneId}`,
      ])).exitCode, 0);
      assert.equal(await clearCurrentPaneQuarantine(base, identity), true);
      assert.equal((await base.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      const cleared = currentMarked.split("\t");
      cleared[11] = "";
      assert.equal(await exactTmuxPaneState(base, identity.paneId), cleared.join("\t"));
    } finally {
      await base.run(["kill-server"]).catch(() => undefined);
    }
  },
);

test(
  "tmux real: rename antes del if-shell atómico preserva la sesión original por id",
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const socket = `cauce-test-${process.pid}-${randomUUID().slice(0, 8)}`;
    const base = new CliTmux(socket);
    try {
      const created = await base.run([
        "new-session", "-d", "-s", "cleanup-original", "-n", "agente", "sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      const identity = await paneIdentity(base, "cleanup-original:agente");
      assert.ok(identity);
      const creationNonce = "b".repeat(64);
      assert.equal(
        (await base.run([
          "set-option", "-t", identity.sessionId, "@cauce_creation_nonce", creationNonce,
        ])).exitCode,
        0,
      );
      const startCommand = (await base.run([
        "display-message", "-p", "-t", identity.paneId, "#{pane_start_command}",
      ])).stdout.replace(/\r?\n$/u, "");
      const ownership = { ...identity, paneStartCommand: startCommand, creationNonce };
      assert.equal((await base.run([
        "set-hook", "-g", "after-display-message", `copy-mode -t ${identity.paneId}`,
      ])).exitCode, 0);
      let raced = false;
      let racedState: string | undefined;
      const tmux: TmuxController = {
        run: async (args, stdin): Promise<TmuxResult> => {
          if (!raced && args[0] === "if-shell") {
            raced = true;
            const renamed = await base.run([
              "rename-session", "-t", identity.sessionId, "cleanup-renamed",
            ]);
            assert.equal(renamed.exitCode, 0, renamed.stderr);
            racedState = await exactTmuxPaneStateViaList(base, identity.paneId);
          }
          return base.run(args, stdin);
        },
      };

      assert.equal(
        await killSessionIdIfNamed(tmux, ownership),
        false,
      );
      assert.equal((await base.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal((await base.run(["has-session", "-t", identity.sessionId])).exitCode, 0);
      assert.equal(
        (await base.run(["display-message", "-p", "-t", identity.sessionId, "#{session_name}"]))
          .stdout.trim(),
        "cleanup-renamed",
      );
      assert.ok(racedState);
      assert.equal(racedState.split("\t")[9], "0", "cleanup rechazado no dispara copy-mode");
      assert.equal(await exactTmuxPaneState(base, identity.paneId), racedState);
    } finally {
      await base.run(["kill-server"]).catch(() => undefined);
    }
  },
);

test(
  "tmux real: respawn con PID nuevo invalida ownership y cleanup preserva el proceso humano",
  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const socket = `cauce-cleanup-${process.pid}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-s", "cleanup-respawn", "-n", "agente", "sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      const before = await paneIdentity(tmux, "cleanup-respawn:agente");
      assert.ok(before);
      const creationNonce = "c".repeat(64);
      assert.equal((await tmux.run([
        "set-option", "-t", before.sessionId, "@cauce_creation_nonce", creationNonce,
      ])).exitCode, 0);
      const startCommand = (await tmux.run([
        "display-message", "-p", "-t", before.paneId, "#{pane_start_command}",
      ])).stdout.replace(/\r?\n$/u, "");
      const ownership = { ...before, paneStartCommand: startCommand, creationNonce };

      const respawned = await tmux.run([
        "respawn-pane", "-k", "-t", before.paneId, "sleep 30",
      ]);
      assert.equal(respawned.exitCode, 0, respawned.stderr);
      let after = await paneIdentity(tmux, before.paneId);
      for (let attempt = 0; after?.panePid === before.panePid && attempt < 50; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        after = await paneIdentity(tmux, before.paneId);
      }
      assert.ok(after);
      assert.notEqual(after.panePid, before.panePid);
      const replacementState = await exactTmuxPaneState(tmux, before.paneId);
      assert.equal((await tmux.run([
        "set-hook", "-g", "after-display-message", "list-panes -F HOOK_OUTPUT",
      ])).exitCode, 0);
      assert.equal(await killSessionIdIfNamed(tmux, ownership), false);
      assert.equal((await tmux.run([
        "set-hook", "-gu", "after-display-message",
      ])).exitCode, 0);
      assert.equal((await tmux.run(["has-session", "-t", before.sessionId])).exitCode, 0);
      assert.equal(await exactTmuxPaneState(tmux, before.paneId), replacementState);
      assert.equal((await paneIdentity(tmux, before.paneId))?.panePid, after.panePid);
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
    }
  },
);

test("una sesión viva cuya ventana cambió durante creación se conserva y no habilita fallback", async () => {
  const { workspace } = await freshState("cleanup-id-propio");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const originalRun = tmux.run.bind(tmux);
  let firstCreatedId: string | undefined;
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "new-session" && firstCreatedId === undefined && response.exitCode === 0) {
      firstCreatedId = response.stdout.trim();
      // La sesión sigue viva con el mismo id/nombre, pero el panel de la TUI murió.
      tmux.windows = ["shell"];
    }
    return response;
  };
  const resume = fakeResume(["--continue"], true);

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(outcome.sessionId, firstCreatedId);
  assert.equal(tmux.sessionExists, true);
  assert.deepEqual(tmux.windows, ["shell"]);
  assert.equal(tmux.used("kill-session"), false);
});

test("un reemplazo con el mismo nombre falla cerrado y nunca se adopta ni se mata", async () => {
  const { workspace } = await freshState("replacement-mismo-nombre");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const originalRun = tmux.run.bind(tmux);
  let ownId: string | undefined;
  let replacementId: string | undefined;
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "new-session" && ownId === undefined && response.exitCode === 0) {
      ownId = response.stdout.trim();
      replacementId = tmux.replaceSession({ alias: "kratos", harness: "claude" });
    }
    return response;
  };

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(outcome.sessionId, ownId);
  assert.equal(tmux.sessionId, replacementId);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
});

// ---------------------------------------------------------------------------
// Rehacer el panel no puede costarle al alias su conversación.
//
// La madrugada del 2026-08-06 un `cauce kant on` rehizo el panel de kant y se llevó 38 MB de
// conversación acumulada desde el 2 de agosto. El rollout seguía intacto en disco y nadie volvió a
// abrirlo: el contexto vivía sólo en el proceso, y el panel arrancaba SIEMPRE pelado.
//
// Estas pruebas fijan las dos redes. Sin ellas, el arreglo se pierde en el próximo refactor y el
// fallo vuelve exactamente igual de mudo.
// ---------------------------------------------------------------------------

/** Un `ResumeSpec` de mentira, con la respuesta que el test quiera y un contador de llamadas. */
function fakeResume(
  args: readonly string[],
  hay: boolean | (() => Promise<boolean>),
): { spec: ResumeSpec; preguntas: () => number } {
  let preguntas = 0;
  return {
    spec: {
      args,
      hasPreviousConversation: async (): Promise<boolean> => {
        preguntas += 1;
        return typeof hay === "boolean" ? hay : hay();
      },
    },
    preguntas: () => preguntas,
  };
}

test("con conversacion previa, el panel nace REANUDANDO en vez de en blanco", async () => {
  const { workspace } = await freshState("reanuda-codex");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const resume = fakeResume(["resume", "--last"], true);

  const result = await ensureSharedSession(
    tmux,
    {
      alias: "socrates", harness: "codex", workspace, command: "codex",
      environment: { CODEX_HOME: "/home/dev/.codex" },
      resume: resume.spec,
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.created, true);
  // Que lo diga importa tanto como que lo haga: el aviso que lee el dueño distingue "se creó vacía"
  // de "se creó con su conversación", y decir lo primero cuando pasó lo segundo es mentirle.
  assert.equal(result.resumed, true);
  const created = tmux.calls.find((call) => call[0] === "new-session");
  assert.equal(created?.at(-1), "exec env CODEX_HOME='/home/dev/.codex' codex resume --last");
  assert.equal(resume.preguntas(), 1);
});

test("sin conversacion previa NO se intenta reanudar: se arranca pelado", async () => {
  // `claude --continue` sin nada que continuar sale con código 1 y mata el panel (medido con
  // claude 2.1.223). Preguntar antes cuesta leer un directorio; no preguntar cuesta un alias mudo.
  const { workspace } = await freshState("reanuda-sin-nada");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.fatalPaneArguments = "--continue";
  const resume = fakeResume(["--continue"], false);

  const result = await ensureSharedSession(
    tmux,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude", resume: resume.spec,
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.resumed, undefined);
  const creadas = tmux.calls.filter((call) => call[0] === "new-session");
  assert.equal(creadas.length, 1, "sin conversacion previa no hay dos intentos, hay uno");
  assert.equal(creadas[0]?.at(-1), "exec claude");
});

test("si la reanudacion mata el panel, se rehace EN BLANCO y se dice", async () => {
  // La regla que ordena las dos malas opciones: un panel sin contexto es malo, un panel que no
  // arranca es peor. Un alias mudo es el fallo más caro de la flota.
  const { workspace } = await freshState("reanuda-falla");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  // El detector dice que sí hay conversación, pero el harness no la puede abrir: un rollout roto,
  // una versión que cambió el subcomando, un permiso. Esa discrepancia TIENE que ser sobrevivible.
  tmux.fatalPaneArguments = "--continue";
  const resume = fakeResume(["--continue"], true);
  const avisos: string[] = [];

  const result = await ensureSharedSession(
    tmux,
    { alias: "zeus", harness: "claude", workspace, command: "claude", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 30, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, true, "el panel tiene que quedar EN PIE aunque la reanudacion falle");
  assert.equal(result.created, true);
  assert.equal(result.resumed, undefined, "no se puede declarar reanudado lo que arranco vacio");
  const creadas = tmux.calls.filter((call) => call[0] === "new-session");
  assert.equal(creadas.length, 2);
  assert.equal(creadas[0]?.at(-1), "exec claude --continue");
  assert.equal(creadas[1]?.at(-1), "exec claude");
  // El panel fatal se llevó la sesión entera. No se mata por nombre: si otro creador hubiera
  // ocupado `cauce-zeus` en ese instante, ese kill borraría SU conversación.
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);
  // Y el dueño tiene que poder enterarse de que su conversación no volvió.
  assert.equal(avisos.length, 1);
  assert.ok(avisos[0]?.includes("EN BLANCO"), avisos[0]);
});

test("un panel VIVO pero lento no se mata: se reporta, no se rehace", async () => {
  // Una conversación grande tarda en dibujarse —la de kant pesaba 38 MB—. Confundir "tarda" con
  // "se murió" sería cometer a mano el mismo borrado que este mecanismo viene a evitar.
  const { workspace } = await freshState("reanuda-lenta");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.paneContent = "❯ el dueño estaba escribiendo esto";  // caja ocupada: nunca "lista"
  const resume = fakeResume(["resume", "--last"], true);
  const avisos: string[] = [];

  const result = await ensureSharedSession(
    tmux,
    { alias: "atlas", harness: "codex", workspace, command: "codex", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 5, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "tui_absent");
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);
  assert.deepEqual(avisos, []);
});

test("un detector que revienta no deja al alias sin panel", async () => {
  const { workspace } = await freshState("reanuda-detector-roto");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const avisos: string[] = [];
  const roto: ResumeSpec = {
    args: ["--continue"],
    hasPreviousConversation: () => Promise.reject(new Error("EACCES: sessions/")),
  };

  const result = await ensureSharedSession(
    tmux,
    { alias: "vulcano", harness: "claude", workspace, command: "claude", resume: roto },
    { sleep: immediate, readyTimeoutMs: 30, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, true);
  assert.equal(tmux.calls.find((call) => call[0] === "new-session")?.at(-1), "exec claude");
  assert.ok(avisos[0]?.includes("EACCES"), avisos[0]);
});

test("los argumentos de reanudacion no pueden colarse al shell", () => {
  assert.deepEqual(resumeArgumentSuffix(["resume", "--last"]), { ok: true, suffix: " resume --last" });
  assert.deepEqual(resumeArgumentSuffix(["--continue"]), { ok: true, suffix: " --continue" });
  assert.deepEqual(resumeArgumentSuffix(undefined), { ok: true, suffix: "" });
  assert.deepEqual(resumeArgumentSuffix([]), { ok: true, suffix: "" });
  // Falla cerrado en vez de mandarle al login shell algo que nadie escribió a propósito.
  assert.equal(resumeArgumentSuffix(["; rm -rf /"]).ok, false);
  assert.equal(resumeArgumentSuffix(["$(whoami)"]).ok, false);
});

test("codex: solo cuenta una conversacion interactiva de ESTE directorio", async () => {
  const { state } = await freshState("detector-codex");
  const codexHome = join(state, ".codex");
  const dia = join(codexHome, "sessions", "2026", "08", "06");
  await mkdir(dia, { recursive: true });
  const cabecera = (cwd: string, source: unknown): string => `${JSON.stringify({
    timestamp: "2026-08-06T09:57:18.709Z",
    type: "session_meta",
    payload: { session_id: randomUUID(), cwd, source, originator: "codex-tui" },
  })}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`;

  // Sin nada, no hay nada que reanudar. Es la rama que impide el panel muerto.
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // La de OTRO directorio no cuenta: `resume --last` filtra por cwd, y prometer una reanudación que
  // codex no va a hacer es volver a dejar el panel a merced del harness.
  await appendFile(join(dia, `rollout-2026-08-06T09-00-00-${randomUUID()}.jsonl`),
    cabecera("/otro/sitio", "cli"));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // La de un subagente tampoco: codex la esconde salvo `--include-non-interactive`.
  await appendFile(join(dia, `rollout-2026-08-06T09-30-00-${randomUUID()}.jsonl`),
    cabecera("/workspace", { subagent: "revisor" }));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // Y la del dueño, en su directorio, sí.
  await appendFile(join(dia, `rollout-2026-08-06T09-57-00-${randomUUID()}.jsonl`),
    cabecera("/workspace", "cli"));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), true);
});

test("claude: cuenta el transcript del directorio, y solo si tiene algo dentro", async () => {
  const { state } = await freshState("detector-claude");
  const configDirectory = join(state, ".claude");
  const proyecto = transcriptDirectoryIn(configDirectory, "/workspace");

  // Ni siquiera existe el directorio: no hay nada que continuar.
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  // Existe y está vacío: tampoco. `--continue` saldría con código 1 y se llevaría el panel.
  await mkdir(proyecto, { recursive: true });
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  // Un `.jsonl` de cero bytes es un fichero recién creado, no una conversación.
  await appendFile(join(proyecto, `${randomUUID()}.jsonl`), "");
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  await appendFile(join(proyecto, `${randomUUID()}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1" })}\n`);
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), true);

  // Y lo de OTRO workspace no se cuenta: claude reanuda por directorio de trabajo.
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/otro"), false);
});

test("los dos creadores del panel reanudan igual", async () => {
  // El adaptador y `cauce <alias>` son los dos únicos que crean la sesión, y el que gana la carrera
  // le impone su forma al panel para siempre. Si sólo uno reanudara, la conversación del dueño
  // dependería de quién llegó primero — que es como se perdieron los 38 MB de kant: por el CLI.
  const cli = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", {});
  assert.deepEqual(cli.resume?.args, ["resume", "--last"]);
  const claude = cliSharedSessionSpec("claude", "kratos", "/workspace", "/home/dev", {});
  assert.deepEqual(claude.resume?.args, ["--continue"]);
});

// ---------------------------------------------------------------------------
// El presupuesto de un turno sale de la entrega, no de una constante escondida.
//
// El 2026-08-04 `harvest` hacía `Math.min(request.timeoutMs, 3_600_000)` con un
// `turnTimeoutMs` que NADIE pasaba: todo turno moría a los 60:00 exactos, aunque la entrega
// declarara 24 h. Dos entregas de Miguel a kratos murieron así, y como el alias sirve una por
// vez, la cola detrás se fue muriendo igual. Ningún error: sólo silencio.
//
// Estas pruebas fijan la regla. Sin ellas, el default vuelve en el próximo refactor.
// ---------------------------------------------------------------------------

test("sin recorte explicito, el turno usa el presupuesto de la entrega", () => {
  const veinticuatroHoras = 24 * 60 * 60_000;
  assert.equal(turnBudgetMs(veinticuatroHoras), veinticuatroHoras);
});

test("no queda ningun techo de una hora escondido", () => {
  const unaHora = 3_600_000;
  // El caso exacto que mato las entregas de kratos: la entrega pedia mucho mas de una hora.
  assert.ok(turnBudgetMs(6 * unaHora) > unaHora, "un turno de 6 h no puede recortarse a 1 h");
  assert.equal(turnBudgetMs(unaHora + 1), unaHora + 1);
});

test("un recorte explicito acota, y solo hacia abajo", () => {
  assert.equal(turnBudgetMs(10_000, 2_000), 2_000);
  // Un recorte mayor que el presupuesto no puede AMPLIARLO: la entrega manda.
  assert.equal(turnBudgetMs(2_000, 10_000), 2_000);
});

// ---------------------------------------------------------------------------
// El 2026-08-04, ya sin el techo de 60 min, apareció el fallo simétrico: claude NO declara
// `startedTurn` a propósito, así que nunca degradaba tras pegar. Si el pegado se perdía —se
// entreveró con lo que tecleaba una persona en la MISMA caja de entrada— `harvest` se quedaba
// esperando el presupuesto de la entrega: 24 h reteniendo el lock de la sesión. Resultado medido:
// 16 entregas encoladas, 4 h sin una sola respuesta, y reiniciar el adaptador no lo soltaba porque
// la siguiente entrega volvía a trabarse igual.
//
// La red de seguridad corta por CORRELACIÓN, no por presupuesto: un turno legítimo puede durar
// horas, pero su entrada aparece en el registro en segundos.
// ---------------------------------------------------------------------------

test("un pegado que nunca aparece en el registro suelta la sesion en vez de retenerla", async () => {
  const { state: _state, home, workspace } = await freshState("pegado-perdido");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-zeus";
  const fallback = new RecordingFallback("{}");
  // El pegado se pierde: la TUI NUNCA escribe la entrada en el transcript.
  tmux.onSubmit = async () => {};

  const runner = new PasteSessionRunner({
    alias: "zeus",
    harness: "claude",
    workspace,
    transcript: claudeTranscript(join(home, ".claude"), workspace),
    tmux,
    fallback,
    sleep: immediate,
    acquireTimeoutMs: 30,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    // Presupuesto enorme (como las 24 h reales), corte de correlación corto.
    turnTimeoutMs: 60 * 60_000,
    correlationTimeoutMs: 20,
    // Desde `fix/fusion-turnos-20260806` soltar un pegado perdido exige DOS cosas: que venza el
    // plazo de correlación Y que el registro lleve `quietTimeoutMs` sin crecer. Recortar sólo el
    // primero ya no acorta nada: el silencio se quedaba en su default de 5 min y este test tardaba
    // 300 s de reloj —medido: 300003 ms, el 90 % de toda la suite de adapter-sdk— y bajo carga
    // arrastraba a dos tests de `engine-session-queue` a `cancelledByParent`.
    //
    // En producción NO cambia nada y por eso alcanza con calibrar el test: con los defaults los dos
    // plazos arrancan juntos en t0 y vencen juntos a los 5 min, que es lo que este test comprueba.
    quietTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "pedido que se perdio",
    timeoutMs: 24 * 60 * 60_000,
    signal: new AbortController().signal,
  });

  // Suelta la sesión como AMBIGUO...
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.harnessStarted, undefined);
  // ...y NO lo re-ejecuta por el camino de respaldo: si el pegado sí había entrado, correría dos veces.
  assert.equal(fallback.calls, 0);
  assert.match(outcome.stderr, /límite correlacionado.*cuarentena/u);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "la siguiente entrega no reutiliza el pane",
    timeoutMs: 24 * 60 * 60_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1);
});

test("el timeout general con turno correlacionado bloquea la generación hasta un límite terminal", async () => {
  const { home, workspace } = await freshState("timeout-correlacionado-sin-final");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "turno previo", sessionId)}\n`);
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(file, `${userEntry(randomUUID(), head, text, sessionId)}\n`);
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    turnTimeoutMs: 20,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  const first = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "turno correlacionado sin desenlace",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(first.timedOut, true);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /presupuesto terminó.*cuarentena/u);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no compartir pane tras timeout ambiguo",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1);
});

// ---------------------------------------------------------------------------
// kratos, 2026-08-04: el turno del bus SI se pego y SI termino bien, pero claude compacto a mitad
// y el `compact_boundary` quedo con `parentUuid: null` y un `logicalParentUuid` que apuntaba HACIA
// ADELANTE, a una entrada que a su vez colgaba del propio boundary: un ciclo cerrado. Ninguna ruta
// llegaba ya a la entrada inyectada, `findFinalAssistant` devolvia undefined en cada sondeo y
// `harvest` giraba reteniendo el lock de la sesion. Resultado medido: 8 h sin contestar con la
// respuesta ya escrita en el registro desde hacia 6 h, y 8 entregas encoladas detras.
// ---------------------------------------------------------------------------

test("una compactacion con la cadena rota no deja la respuesta sin cosechar", () => {
  // Reproduce la forma exacta: user inyectado -> compactacion -> respuesta, con el ciclo.
  const entries = [
    { type: "user", uuid: "u-inyectado", message: { role: "user", content: "pedido del bus" } },
    { type: "system", subtype: "compact_boundary", uuid: "b-boundary", parentUuid: null, logicalParentUuid: "x-adelante" },
    { type: "assistant", uuid: "a-1", parentUuid: "b-boundary", message: { role: "assistant", content: [{ type: "text", text: "intermedio" }] } },
    { type: "user", uuid: "x-adelante", parentUuid: "a-1", message: { role: "user", content: "resumen" } },
    {
      type: "assistant",
      uuid: "a-final",
      parentUuid: "x-adelante",
      message: { role: "assistant", content: [{ type: "text", text: "la respuesta de verdad" }], stop_reason: "end_turn" },
    },
  ] as unknown as TranscriptEntry[];

  const encontrada = findFinalAssistant(entries, "u-inyectado");
  assert.ok(encontrada !== undefined, "la respuesta posterior a una compactacion tiene que cosecharse");
  assert.equal(encontrada?.text, "la respuesta de verdad");
});

test("sin compactacion de por medio se sigue exigiendo descendencia real", () => {
  // Lo que tecleo el dueño en paralelo NO desciende de nuestra entrada y no debe cosecharse.
  const entries = [
    { type: "user", uuid: "u-inyectado", message: { role: "user", content: "pedido del bus" } },
    { type: "user", uuid: "u-del-dueno", message: { role: "user", content: "otra cosa" } },
    {
      type: "assistant",
      uuid: "a-del-dueno",
      parentUuid: "u-del-dueno",
      message: { role: "assistant", content: [{ type: "text", text: "respuesta ajena" }], stop_reason: "end_turn" },
    },
  ] as unknown as TranscriptEntry[];

  assert.equal(findFinalAssistant(entries, "u-inyectado"), undefined);
});
