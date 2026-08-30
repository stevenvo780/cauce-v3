import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

export type { TmuxController, TmuxResult, TmuxRunControl };
import {
  fileQuarantinePersistence,
  PasteSessionRunner,
  type QuarantinePersistence,
} from "../src/shared-session/paste-runner.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import { claudeTranscript, type TranscriptEntry } from "../src/shared-session/transcript.js";

export const stateRoot = resolve(".test-state/shared-session");

for (const [command, args] of [["tmux", ["-V"]], ["script", ["--version"]]] as const) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  assert.equal(result.status, 0, `${command} is required for shared-session integration tests`);
}

export const EXACT_TMUX_PANE_STATE_FORMAT = [
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

export async function exactTmuxPaneState(tmux: TmuxController, paneId: string): Promise<string> {
  const state = await tmux.run([
    "display-message", "-p", "-t", paneId, EXACT_TMUX_PANE_STATE_FORMAT,
  ]);
  assert.equal(state.exitCode, 0, state.stderr);
  return state.stdout;
}

export async function exactTmuxPaneStateViaList(tmux: TmuxController, paneId: string): Promise<string> {
  const state = await tmux.run([
    "list-panes", "-a", "-f", `#{==:#{pane_id},${paneId}}`, "-F", EXACT_TMUX_PANE_STATE_FORMAT,
  ]);
  assert.equal(state.exitCode, 0, state.stderr);
  const rows = state.stdout.split(/\r?\n/u).filter((row) => row !== "");
  assert.equal(rows.length, 1, `debe existir exactamente ${paneId}`);
  return `${String(rows[0])}\n`;
}

export const ENVELOPE = {
  reply: "hecho",
  messages: [] as const,
  status: "done" as const,
  retryable: false,
  artifacts: [] as const,
};

export function envelopeText(reply = "hecho", correlationId?: string): string {
  return JSON.stringify({
    ...ENVELOPE,
    reply,
    ...(correlationId === undefined ? {} : { cauce_correlation_id: correlationId }),
  });
}

export function correlationIdFromPrompt(prompt: string): string {
  const match = /"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(prompt);
  assert.ok(match?.[1], "el prompt inyectado debe llevar un nonce criptográfico de 256 bits");
  return match[1];
}

export async function freshState(name: string): Promise<{ state: string; home: string; workspace: string }> {
  const directory = join(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  const home = join(directory, "home");
  const workspace = "/workspace";
  await mkdir(transcriptDirectory(home, workspace), { recursive: true });
  await mkdir(directory, { recursive: true });
  return { state: directory, home, workspace };
}

/** A transcript entry with the same shape that real `claude` writes. */
export function userEntry(uuid: string, parentUuid: string | null, text: string, sessionId: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid, isSidechain: false, sessionId,
    promptSource: "typed", message: { role: "user", content: text },
  });
}

export function assistantEntry(
  uuid: string,
  parentUuid: string,
  text: string,
  sessionId: string,
  stopReason = "end_turn",
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid, isSidechain: false, sessionId,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
}

/**
 * Simulated tmux with the fidelity these tests need: which commands it received, what was in the
 * input box, and what ended up pasted. The transcript is written by the test itself when the "TUI"
 * receives an Enter, the same way claude does it.
 */
export class FakeTmux implements TmuxController {
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
  /** Windows actually present in the session. By default, the TUI's one. */
  windows: string[] = ["agente"];
  paneContent = "❯ ";
  panePid = "4242";
  inputOff = false;
  paneInMode = false;
  readonly configuredInputHooks = new Set<string>();
  private readonly waitSignals = new Set<string>();
  private readonly waiters = new Map<string, Set<(result: TmuxResult) => void>>();
  /** Original panel command, used to accredit sessions prior to the markers. */
  paneStartCommand = "exec claude";
  /** Additional panes inside the TUI window, a situation that must fail closed. */
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
   * Substring of the panel argv that makes the process exit immediately.
   *
   * Models the case where `claude --continue` with no prior conversation
   * writes "No conversation found to continue" and exits with code 1.
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
    this.sessionId = `$${String(this.nextSessionNumber)}`;
    this.nextSessionNumber += 1;
    this.windows = ["agente"];
    this.panePid = String(Number(this.panePid) + 1);
    this.windowId = `@${String(this.nextWindowNumber)}`;
    this.nextWindowNumber += 1;
    this.paneId = `%${String(this.nextPaneNumber)}`;
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

  /** `respawn-pane -k` keeps `%pane_id`, but changes the process and clears its input. */
  respawnPane(command?: string): void {
    this.panePid = String(Number(this.panePid) + 1);
    if (command !== undefined) this.paneStartCommand = command;
    this.inputContent = "";
    this.pasted = undefined;
    this.paneContent = "❯ ";
  }

  /** Models bytes from an attached client; `select-pane -d` discards them. */
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
    // Many historical doubles wrap `run` and do not forward `control`. Resolving the sibling
    // waiter models the AbortController that the real controller receives on observing the other branch.
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
    // `list-windows` is the only honest source of which windows exist: `display-message` falls
    // back to the current window when the requested one does not exist. The double models this, it does not evade it.
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
          paneIds.push(`%${String(900 + index)}`);
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
        rows.push(`${this.sessionId}\t${this.sessionName}\t${this.windowId}\t${window}\t%${String(900 + index)}`
          + `\t${String(9000 + index)}\t0\t${this.paneStartCommand}`);
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
        this.sessionId = `$${String(this.nextSessionNumber)}`;
        this.nextSessionNumber += 1;
        this.windowId = `@${String(this.nextWindowNumber)}`;
        this.nextWindowNumber += 1;
        this.paneId = `%${String(this.nextPaneNumber)}`;
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
        // tmux returned 0: the session WAS created. What died was the process inside it, and
        // with it the whole session went. `new-session` has no way to report it.
        this.sessionExists = false;
        this.windows = [];
      }
      return command === "new-session"
        ? { exitCode: 0, stdout: `${this.sessionId}\n`, stderr: "" }
        : ok(0);
    }
    // Killing a session that no longer exists is not a failure: it is the state that was sought.
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
      return ok(0);
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
    // The renaming actually matters: it is what keyed the session. The double applies it on the
    // window list so that `list-windows` stops seeing the old window, just like tmux does.
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
      // Without a session there is no pane to capture, and tmux reports that by failing. It
      // matters: `capturePane` returns `undefined` and that is what lets the wait distinguish
      // "the TUI is still booting" from "nobody is here anymore".
      const target = args[args.indexOf("-t") + 1];
      if (!this.targetExists(target)) {
        return { exitCode: 1, stdout: "", stderr: "can't find session" };
      }
      const rendered = this.inputContent === ""
        ? this.paneContent
        : `${this.paneContent}\n[Pasted text #1 +${String(this.inputContent.split("\n").length)} lines]\n❯ `;
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
          + (this.windows.includes("agente") ? "agente" : (this.windows[0] ?? "agente"))
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
          + (this.windows.includes("agente") ? "agente" : (this.windows[0] ?? "agente"))
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
      if (name === undefined) return ok(1);
      if (this.inputOff) {
        if (args.includes("-d")) this.buffers.delete(name);
        return ok(0);
      }
      this.inputContent += value;
      this.pasted = value;
      if (args.includes("-d")) this.buffers.delete(name);
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

export function ok(exitCode: number): TmuxResult {
  return { exitCode, stdout: "", stderr: "" };
}

export function ambiguousTmuxResult(reason: string): TmuxResult {
  return { exitCode: null, stdout: "", stderr: reason };
}

/** A fake client that only finishes when its cancellation/deadline reaps it. */
export function controlledTmuxHang(control?: TmuxRunControl): Promise<TmuxResult> {
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

export function controlledDelayedTmuxMutation(
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

/** The regular path. Records whether it was called, which is exactly what needs to be assertable. */
export class RecordingFallback implements CommandRunner {
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

export function claudeRunner(
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

export async function adapterFor(
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

export function execute(adapter: HarnessAdapter, prompt = "hola"): Promise<{
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

export { randomUUID };
export { fileQuarantinePersistence };
