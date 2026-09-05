import type { CommandRunResult, CommandRunner } from "../../sdk/types.js";
import type { PaneIdentity, TmuxController } from "../tmux.js";
import type {
  ResumeSpec,
  SharedSessionDegradation,
  SharedSessionHarness,
  TranscriptReader,
} from "../types.js";

export interface PasteSessionOptions<E> {
  readonly alias: string;
  /** Which TUI runs in the pane. It determines the shared session binary. */
  readonly harness: SharedSessionHarness;
  /** Working directory of the TUI. */
  readonly workspace: string;
  /** Harness transcript reader to obtain the structured envelopes. */
  readonly transcript: TranscriptReader<E>;
  /** Environment variables set when creating the pane. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly harnessArguments?: readonly string[];
  readonly tmux: TmuxController;
  /** Backup runner used when the shared session degrades. */
  readonly fallback: CommandRunner;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to wait for the input box to free up before degrading. */
  readonly acquireTimeoutMs?: number;
  /**
   * Optional trimming of the turn injected below `request.timeoutMs`.
   * If the deadline passes, the execution state is reported as ambiguous without automatic retry.
   */
  readonly turnTimeoutMs?: number;
  /** Maximum terminal wait after interrupting a cancelled turn before quarantining the pane. */
  readonly cancelDrainTimeoutMs?: number;
  /** Durable quarantine marker; production places it inside the alias's state directory. */
  readonly quarantineFile?: string;
  /** Bounded budget for each quarantine operation. */
  readonly quarantineOperationTimeoutMs?: number;
  /** Injectable persistence to attest failures and disk locks in tests. */
  readonly quarantinePersistence?: QuarantinePersistence;
  /** Wait time between the paste and the Enter submission. */
  readonly settleMs?: number;
  /** Wait time for the TUI to register the pasted turn. */
  readonly injectTimeoutMs?: number;
  /** Deadline for correlating the paste. */
  readonly correlationTimeoutMs?: number;
  /** Idle time to consider a paste lost without correlation. */
  readonly quietTimeoutMs?: number;
  readonly pollMs?: number;
  readonly readyTimeoutMs?: number;
  readonly command?: string;
  /** How to resume the conversation if the pane needs to be recreated. See `ResumeSpec`. */
  readonly resume?: ResumeSpec;
  readonly onDegradation?: (degradation: SharedSessionDegradation) => void;
  /** Notification of incidents during initialization or resume. */
  readonly onNotice?: (detail: string) => void;
}

export interface CommittedRunResult {
  readonly result: CommandRunResult;
  /** Correlated transcript or exact disappearance/change: it's already safe to withdraw pending. */
  readonly terminalBoundary: boolean;
}

export type FileQuarantineState = "current" | "stale" | "absent" | "unreadable";

/** Minimal operations of the durable barrier, split apart to be able to test hung I/O. */
export interface QuarantinePersistence {
  readonly inspect: (path: string, identity: PaneIdentity) => Promise<FileQuarantineState>;
  readonly persist: (path: string, identity: PaneIdentity) => Promise<boolean>;
  /**
   * Publishes a pre-paste preparation via name CAS: it never replaces an existing pending. The
   * caller does not leave this atomic boundary; pasting only happens after `true`.
   */
  readonly commitPrepared: (
    preparedPath: string,
    pendingPath: string,
    identity: PaneIdentity,
  ) => Promise<boolean>;
  readonly clear: (path: string) => Promise<boolean>;
}

export interface PendingQuarantine {
  readonly identity: PaneIdentity;
  readonly correlationId: string;
  readonly file?: string;
}
