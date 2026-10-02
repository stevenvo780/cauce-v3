import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { grokTranscript, newGrokSessionId, type GrokUpdateLine } from "../src/shared-session/grok.js";
import type { NativePointerAttestor } from "../src/shared-session/native-witness.js";
import type { ResumeSpec } from "../src/shared-session/types.js";
import { FakeTmux, freshState, type TmuxResult, type TmuxRunControl } from "./shared-session-fixtures.js";

// Frames of grok 1.0.41 captured on hades (tmux 200x50, `capture-pane -e`), trimmed to the lines
// every classifier reads: history tail, opt-in banner, input box and footer.
const BORDER = "\u001b[38;5;239m";
const RESET = "\u001b[39m";
const KEY = (key: string, action: string): string =>
  `\u001b[0;1m\u001b[38;5;251m\u001b[48;5;233m${key}\u001b[0m\u001b[38;5;242m\u001b[48;5;233m:${action}`;
const SEPARATOR = "\u001b[2m  │  ";

const FOOTERS = {
  idle: [KEY("Shift+Tab", "mode"), KEY("Ctrl+x", "shortcuts")],
  typed: [KEY("Enter", "send"), KEY("Alt+Enter", "newline"), KEY("Shift+Tab", "mode"), KEY("Ctrl+x", "shortcuts")],
  running: [KEY("Shift+Tab", "mode"), KEY("Ctrl+c", "cancel"), KEY("Ctrl+x", "shortcuts")],
  queued: [KEY("Enter", "send now"), KEY("Shift+Tab", "mode"), KEY("Ctrl+c", "cancel"),
    KEY("Ctrl+;", "queue"), KEY("Ctrl+x", "shortcuts")],
  tool: [KEY("Shift+Tab", "mode"), KEY("Ctrl+c", "cancel"), KEY("Ctrl+b", "send to bg"), KEY("Ctrl+x", "shortcuts")],
  quit: [KEY("Ctrl+c", "press again to quit")],
  // Scrollback focused (Tab on 1.0.41): the box greys out and shows «Build anything» or the owner's text.
  unfocused: [KEY("Ctrl+e", "expand thinking"), KEY("Space", "prompt"), KEY("Ctrl+x", "shortcuts")],
} as const;

export type GrokFooter = keyof typeof FOOTERS;

export interface GrokFrame {
  readonly footer?: GrokFooter;
  /** What sits in the input box, as grok draws it (`[Pasted: 81 lines]` for a chip). */
  readonly box?: string;
  readonly spinner?: string;
  readonly queue?: string;
  readonly history?: readonly string[];
}

export function grokFrame(frame: GrokFrame = {}): string {
  const unfocused = frame.footer === "unfocused";
  const box = frame.box ?? (unfocused ? "Build anything" : "");
  return [
    ...(frame.history ?? [
      "     \u001b[48;5;235m   \u001b[38;5;251m❯ \u001b[38;5;254mrespondé solo: hola                          5:10 PM",
      "     ◆ Thought for 3.4s",
      "     hola                                                          5:10 PM",
      "     Worked for 5.6s",
    ]),
    ...(frame.queue === undefined ? [] : [`  #1 ${frame.queue}`]),
    ...(frame.spinner === undefined ? [] : [`    \u001b[38;5;251m${frame.spinner}${RESET}`]),
    "  \u001b[38;5;254mHelp improve Grok\u001b[39m                                   \u001b[38;5;243m[Opt out]\u001b[39m [Opt in]",
    "  \u001b[38;5;243mOff by default. Opt-in to allow SpaceXAI to retain coding data.\u001b[39m",
    "",
    `  ${BORDER}╭${"─".repeat(60)}╮${RESET}`,
    unfocused // Colors exactly as captured: plain 256-color grey, no SGR 2, so it is not «dim».
      ? `  \u001b[38;5;236m│\u001b[38;5;247m \u001b[38;5;238m❯ \u001b[38;5;239m${box.padEnd(56)}\u001b[38;5;236m│${RESET}`
      : `  ${BORDER}│\u001b[38;5;254m \u001b[38;5;251m❯ \u001b[38;5;254m${box.padEnd(56)}${BORDER}│${RESET}`,
    `  ${BORDER}╰${"─".repeat(20)} \u001b[38;5;244mGrok 4.7 (xhigh)\u001b[38;5;240m · \u001b[38;5;242malways-approve${BORDER} ─╯${RESET}`,
    "",
    `  \u001b[1m${FOOTERS[frame.footer ?? "idle"].join(SEPARATOR)}                    ${RESET}`,
    "",
  ].join("\n");
}

/** The folder-trust dialog grok opens in an untrusted cwd, even with `--always-approve`. */
export const GROK_TRUST_DIALOG = [
  "                    Do you trust the contents of this directory?",
  "                                  /tmp/grok-probe",
  "         Grok Build may run or modify contents in this directory,",
  "                              posing security risks.",
  "                      Yes, proceed                 y",
  "                      No, quit                     n",
  "                                                 Grok Build  1.0.41 [stable]",
].join("\n");

export const THINKING = "⠸ Thinking… 0.7s                                  2.6s ⇣2.42k [stop]";
export const TOOL_RUNNING = "⠼ Sleep 6 seconds then print ZP-010… 3.1s       9.0s ⇣24k [↓][stop]";

/** Writes `updates.jsonl` lines shaped exactly like grok 1.0.41 (see the measurement report). */
export class GrokLog {
  private event = 0;
  private promptIndex = 0;

  constructor(readonly file: string, readonly sessionId: string) {}

  private line(method: string, update: Record<string, unknown>, meta: Record<string, unknown> = {}): string {
    this.event += 1;
    const value: GrokUpdateLine = {
      timestamp: 1_790_183_421 + this.event,
      method,
      params: {
        sessionId: this.sessionId,
        update,
        _meta: { eventId: `${this.sessionId}-${String(this.event)}`, ...meta },
      },
    };
    return JSON.stringify(value);
  }

  user(text: string): string {
    const index = this.promptIndex;
    this.promptIndex += 1;
    return this.line("session/update", {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
      _meta: { modelId: "grok-4.7", promptIndex: index },
    }, { agentTimestampMs: 1_790_183_421_807 });
  }

  thought(promptId: string, text = "pensando"): string {
    return this.line("session/update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
      { promptId, updateType: "AgentThoughtChunk" });
  }

  message(promptId: string, text: string): string {
    return this.line("session/update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      { promptId, updateType: "AgentMessageChunk" });
  }

  tool(promptId: string, callId: string, title: string, rawInput: Record<string, unknown>): string {
    return this.line("session/update", { sessionUpdate: "tool_call", toolCallId: callId, title, rawInput },
      { promptId });
  }

  toolDone(promptId: string, callId: string): string {
    return this.line("session/update", { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed" },
      { promptId });
  }

  /** `spawn_subagent` with `background: true`, as the parent's log records it (hades DM, line 142-157). */
  spawned(promptId: string, subagentId: string): string {
    return this.line("_x.ai/session/update", {
      sessionUpdate: "subagent_spawned", subagent_id: subagentId, child_session_id: subagentId,
      parent_session_id: this.sessionId, parent_prompt_id: promptId, subagent_type: "general-purpose",
      description: "[reviewer] tarea larga", effective_context_source: "new", model: "grok-4.7",
    });
  }

  subagentFinished(subagentId: string, willWake: boolean): string {
    return this.line("_x.ai/session/update", {
      sessionUpdate: "subagent_finished", subagent_id: subagentId, child_session_id: subagentId,
      status: "completed", tool_calls: 58, turns: 1, duration_ms: 617_667, output: "resultado del subagente",
      will_wake: willWake,
    });
  }

  /** A command the model sent to the background from the tool call `callId` of turn `promptId`. */
  backgrounded(callId: string, taskId: string): string {
    return this.line("_x.ai/session/update", {
      sessionUpdate: "task_backgrounded", tool_call_id: callId, task_id: taskId,
      command: "sleep 900 && make", cwd: "/home/claw", output_file: "/tmp/out", description: "compila",
    });
  }

  taskCompleted(taskId: string, willWake: boolean): string {
    return this.line("_x.ai/session/update", {
      sessionUpdate: "task_completed",
      task_snapshot: { task_id: taskId, completed: true, exit_code: 0, kind: "bash", is_backgrounded: true },
      will_wake: willWake,
    });
  }

  completed(promptId: string, stopReason = "end_turn"): string {
    return this.line("_x.ai/session/update", {
      sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: stopReason,
      usage: { numTurns: 1 }, elapsed_ms: 5_643,
    });
  }

  async append(...lines: readonly string[]): Promise<void> {
    await appendFile(this.file, `${lines.join("\n")}\n`);
  }
}

/** A grok home with the hades layout: sessions grouped by url-encoded cwd. */
export async function grokWorkspace(name: string, options: { history?: boolean } = {}): Promise<{
  state: string;
  grokHome: string;
  log: GrokLog;
  sessionLog: (sessionId: string, group?: string) => Promise<GrokLog>;
}> {
  const { state, home } = await freshState(name);
  const grokHome = join(home, ".grok");
  const sessionLog = async (sessionId: string, group = "%2Fhome%2Fclaw"): Promise<GrokLog> => {
    const directory = join(grokHome, "sessions", group, sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "updates.jsonl");
    return new GrokLog(file, sessionId);
  };
  await mkdir(join(grokHome, "sessions"), { recursive: true, mode: 0o700 });
  const log = await sessionLog(newGrokSessionId());
  if (options.history !== false) {
    await log.append(log.user("respondé solo: hola"), log.message("p-previo", "hola"), log.completed("p-previo"));
  } else {
    await writeFile(log.file, "");
  }
  return { state, grokHome, log, sessionLog };
}

const immediate = (): Promise<void> => Promise.resolve();

export function grokRunner(options: {
  alias?: string;
  grokHome: string;
  tmux: FakeTmux;
  sleep?: (ms: number) => Promise<void>;
  acquireTimeoutMs?: number;
  cancelDrainTimeoutMs?: number;
  quarantineFile?: string;
  resume?: ResumeSpec;
  nativePointer?: NativePointerAttestor;
  correlationTimeoutMs?: number;
  generatingWaitMs?: number;
  backgroundWaitMs?: number;
  turnTimeoutMs?: number;
  workspace?: string;
  dispatchGraceMs?: number;
}): PasteSessionRunner<GrokUpdateLine> {
  const alias = options.alias ?? "hades";
  options.tmux.sessionName = `cauce-${alias}`;
  if (options.tmux.sessionOptions.size === 0) options.tmux.paneStartCommand = "exec grok --always-approve";
  return new PasteSessionRunner({
    alias,
    harness: "grok",
    workspace: options.workspace ?? "/workspace",
    transcript: grokTranscript(options.grokHome),
    ...(options.dispatchGraceMs === undefined ? {} : { dispatchGraceMs: options.dispatchGraceMs }),
    tmux: options.tmux,
    sleep: options.sleep ?? immediate,
    acquireTimeoutMs: options.acquireTimeoutMs ?? 30,
    generatingWaitMs: options.generatingWaitMs ?? 40,
    backgroundWaitMs: options.backgroundWaitMs ?? 1_500,
    turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
    // Tiny on purpose: grok must NOT be judged "never started" by the 30 s inject deadline.
    injectTimeoutMs: 20,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    ...(options.cancelDrainTimeoutMs === undefined ? {} : { cancelDrainTimeoutMs: options.cancelDrainTimeoutMs }),
    ...(options.quarantineFile === undefined ? {} : { quarantineFile: options.quarantineFile }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.nativePointer === undefined ? {} : { nativePointer: options.nativePointer }),
    ...(options.correlationTimeoutMs === undefined ? {} : { correlationTimeoutMs: options.correlationTimeoutMs }),
  });
}

/** FakeTmux whose C-c reaches a grok turn: the test decides what the transcript records. */
export class GrokTmux extends FakeTmux {
  onInterrupt: ((key: string) => Promise<void> | void) | undefined;
  /** Frame grok draws once Space gives the box its focus; undefined = the box already had it. */
  focusedFrame: string | undefined;
  focusKeys = 0;
  /** Spaces that reached a box that already had focus: a typed character, never acceptable. */
  strayFocusKeys = 0;
  /** Spaces sent without the input barrier held: they could race the owner's keys. */
  unbarrieredFocusKeys = 0;
  /** C-u sent with the input barrier held (the only way the runner may clear grok's box). */
  clearedBoxes = 0;
  /** Captures that still show the old frame after the Space: grok redrawing late on a busy host. */
  focusRedrawAfterCaptures = 0;
  private pendingFocus: { frame: string; captures: number } | undefined;
  /** `calls.length` when each Space arrived (the barrier's mutation is not itself a recorded call). */
  readonly focusAt: number[] = [];

  constructor() {
    super();
    this.paneContent = grokFrame();
    this.interruptStopsTurn = false;
  }

  private handledInterrupts = 0;

  override async run(args: readonly string[], stdin?: string, control?: TmuxRunControl): Promise<TmuxResult> {
    if (args[0] === "send-keys" && args.at(-1) === "Space" && !this.inputOff) {
      this.focusKeys += 1;
      this.focusAt.push(this.calls.length);
      if (!this.paneOptions.has("@cauce_input_barrier")) this.unbarrieredFocusKeys += 1;
      else if (this.focusedFrame === undefined || this.pendingFocus !== undefined) this.strayFocusKeys += 1;
      else if (this.focusRedrawAfterCaptures > 0) this.pendingFocus = { frame: this.focusedFrame, captures: this.focusRedrawAfterCaptures };
      else this.paneContent = this.focusedFrame;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "send-keys" && args.at(-1) === "C-u" && !this.inputOff && this.paneOptions.has("@cauce_input_barrier")) {
      this.clearedBoxes += 1;
      this.paneContent = grokFrame({ footer: "idle" });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const result = await super.run(args, stdin, control);
    if (args[0] === "capture-pane" && this.pendingFocus !== undefined && --this.pendingFocus.captures <= 0) {
      this.paneContent = this.pendingFocus.frame; // Redrawn only now: the screen lagged the focus it already had.
      this.pendingFocus = undefined;
    }
    while (this.handledInterrupts < this.interruptKeys.length) {
      const key = this.interruptKeys[this.handledInterrupts] ?? "";
      this.handledInterrupts += 1;
      await this.onInterrupt?.(key);
    }
    return result;
  }
}
