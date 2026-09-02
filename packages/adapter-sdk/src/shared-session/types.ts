import type { CommandRunner, HarnessId } from "../sdk/types.js";

/** Harnesses compatible with the shared session mechanism. */
export type SharedSessionHarness = Extract<HarnessId, "claude" | "codex">;

export function isSharedSessionHarness(harness: HarnessId): harness is SharedSessionHarness {
  return harness === "claude" || harness === "codex";
}

/**
 * Reasons a turn could not be served via the shared session.
 */
export type DegradationReason =
  /** The tmux session does not exist, or could not be created. */
  | "session_absent"
  /** The session exists but no live harness TUI is inside it. */
  | "tui_absent"
  /** The exact session declares another alias; never reused nor auto-destroyed. */
  | "session_alias_mismatch"
  /** The exact session belongs to another harness (e.g. claude after migrating to codex). */
  | "session_harness_mismatch"
  /** A legacy session gave insufficient evidence to credit alias+harness. */
  | "session_identity_unverified"
  /** tmux started the freshly created pane outside `spec.workspace`; that generation was killed. */
  | "workspace_mismatch"
  /** The owner had half-typed text in the box and never let it go within the deadline. */
  | "input_busy"
  /** The TUI is blocked waiting for an answer in a modal dialog. */
  | "modal_blocking"
  /** The paste could not be sent or the TUI did not register the turn. */
  | "handshake_failed"
  /** The TUI restarted between turns and the conversation started blank. */
  | "context_reset"
  /** There was no prior shared session and a new one was created for this turn. */
  | "session_created"
  /** The conversation context was deliberately cleared (/clear or /new). */
  | "context_cleared"
  /** The terminal compacted its conversation context. */
  | "context_compacted"
  /** The turn merged with an execution already in progress in the TUI. */
  | "turn_merged";

/**
 * Portion of the transcript with historical and current-turn entries.
 */
export interface TranscriptSlice<E> {
  /** What is needed to correlate. May be the whole file if the harness requires it. */
  readonly entries: readonly E[];
  /** Only what was written after the cut, which is what could have happened this turn. */
  readonly appended: readonly E[];
}

/** The turn our paste created, already identified inside the log. */
export interface InjectedTurn {
  /** What tracks the turn: the entry uuid in claude, the `turn_id` in codex. */
  readonly key: string;
  /** Conversation identity, to detect a clear and for the result's `session_id`. */
  readonly sessionId?: string;
}

/**
 * How the turn ended, when it can be asserted that it ended.
 *
 * `failed` exists so an owner interruption (Esc in the codex TUI) doesn't cost half an hour of
 * silence: without it the turn exhausts the budget and comes out `timedOut`, which the adapter
 * treats as AMBIGUOUS and does not retry. With it, what happened is stated.
 */
export type TurnOutcome =
  | { readonly kind: "answer"; readonly text: string; readonly sessionId?: string }
  | { readonly kind: "failed"; readonly detail: string };

/** A compaction that happened during the turn, with a stable id so the notice isn't repeated. */
export interface CompactionNotice {
  readonly id: string;
  readonly detail: string;
}

export interface TranscriptReader<E> {
  /** The log's files. Recursive if the harness splits them into folders. */
  files(): Promise<readonly string[]>;
  /** Reads from `offset`; `entries` is what is needed to correlate, `appended` only the new. */
  read(file: string, offset: number): Promise<TranscriptSlice<E>>;
  /** The entry that created THIS turn, identified by the exact pasted text. */
  findInjected(file: string, entries: readonly E[], promptText: string): InjectedTurn | undefined;
  /** The outcome of that turn, or `undefined` while it is still running. */
  findAnswer(entries: readonly E[], key: string): TurnOutcome | undefined;
  /**
   * Searches the transcript entries for a correlated structured envelope.
   */
  findEnvelope?(
    entries: readonly E[],
    correlationId: string,
    desde?: string,
  ): TurnOutcome | undefined;
  compactions(appended: readonly E[]): readonly CompactionNotice[];
  /** Whether the start of any turn was registered in the appended entries. */
  startedTurn?(appended: readonly E[]): boolean;
  /** The output in the harness's native form, to be processed by the standard parser. */
  stdout(text: string, sessionId: string | undefined): string;
}

export interface SharedSessionDegradation {
  readonly reason: DegradationReason;
  /** Descriptive text of the degradation reason. */
  readonly detail: string;
  readonly occurredAt: string;
  /** `true` when the turn was served by the alternative executor instead of the shared session. */
  readonly fellBack: boolean;
}

/**
 * Runner that exposes shared-session degradation information.
 */
export interface SharedSessionRunner extends CommandRunner {
  takeDegradation(): SharedSessionDegradation | undefined;
}

export function isSharedSessionRunner(runner: CommandRunner): runner is SharedSessionRunner {
  return typeof (runner as Partial<SharedSessionRunner>).takeDegradation === "function";
}

/** Canonical name of the tmux session for a given alias. */
export function sessionName(alias: string): string {
  return `cauce-${alias}`;
}

/**
 * Conversation resume specification for a harness.
 */
export interface ResumeSpec {
  /** Resume args: `resume --last` in codex, `--continue` in claude. */
  readonly args: readonly string[];
  /** Does that `args` actually have anything to resume? */
  hasPreviousConversation(): Promise<boolean>;
}

/**
 * Dedicated tmux socket for Cauce.
 */
export const TMUX_SOCKET = "cauce";

/** Window where the harness TUI lives. */
export const TUI_WINDOW = "agente";

/** Legacy window name used in previous versions. */
export const LEGACY_DEGRADED_WINDOW = "⚠ CAUCE-DEGRADADO";

