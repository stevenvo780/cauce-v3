import type { FileHandle } from "node:fs/promises";
import type {
  DelegationMaterializationNotice,
  DelegationRejectionNotice,
  ProfileRuntimeAdoptionEvidence,
} from "@cauce/protocol";
import type { Delivery, DeliveryEvent, StructuredOutput } from "../types.js";

export type InboxState = "accepted" | "started" | "done" | "failed";

export interface InboxRecord {
  readonly delivery_id: string;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly attempt: number;
  readonly claim_token: string;
  readonly previous_claim_tokens?: readonly string[];
  readonly state: InboxState;
  /**
   * Recovery contract for executions created after the durable pre-invocation gate shipped.
   * Legacy `started` records have no value and therefore remain conservatively ambiguous.
   */
  readonly execution_intent_protocol?: "preinvoke-v1";
  /** Exact execution-intent event durably confirmed by the remote store for this attempt. */
  readonly execution_intent_receipt_event_id?: string;
  readonly origin: Delivery["origin"];
  readonly request?: Delivery;
  readonly output?: StructuredOutput;
  readonly profile_adoption?: ProfileRuntimeAdoptionEvidence;
  /** Exact store-side outcome of this turn's StructuredOutput.messages. */
  readonly delegation_rejections?: readonly DelegationRejectionNotice[];
  readonly delegation_materializations?: readonly DelegationMaterializationNotice[];
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  /**
   * Stable evidence that the state-changing lifecycle event was created for this attempt.
   *
   * The event may no longer be in the outbox because the relay acknowledged it. Keeping the
   * identifier prevents a later duplicate delivery from manufacturing an endless stream of new
   * terminal ACKs after the exact original event was already confirmed.
   */
  readonly lifecycle_event_ids?: {
    readonly accepted?: string;
    readonly started?: string;
    readonly execution_started?: string;
    readonly terminal?: string;
  };
  readonly updated_at: string;
}

export interface InboxFile {
  readonly version: 1;
  readonly deliveries: Record<string, InboxRecord>;
  readonly last_transaction_id?: string;
}

export interface OutboxFile {
  readonly version: 1;
  readonly pending: readonly DeliveryEvent[];
  readonly last_transaction_id?: string;
}

export interface DeliveryTransactionFile {
  readonly version: 1;
  readonly transaction_id: string;
  readonly inbox_updates?: Readonly<Record<string, InboxRecord>>;
  readonly outbox_pending?: readonly DeliveryEvent[];
}

export interface SessionOrigin {
  readonly adapter: string;
  readonly channel: string;
  readonly conversation_id: string;
}

export interface SessionRecord {
  readonly native_id: string;
  readonly initialized: boolean;
  /** Origen de la conversación, opcional si la entrega no declaró conversación de origen. */
  readonly origin?: SessionOrigin;
}

export interface ProcessedFaninReply {
  readonly tenantId: string;
  readonly alias: string;
  readonly reply: string;
  /** Local terminal transition time; the newest one is this coordinator's own synthesis. */
  readonly updatedAt: string;
  /**
   * Delegated branch this reply closed, as the store wrote it into the agent.response
   * correlation. Two branches delegated to the same alias are distinct here, which a
   * tenant/alias key cannot express.
   */
  readonly childDeliveryId?: string;
  readonly outputIndex?: number;
  readonly targetTenant?: string;
}

export interface DelegationBranchIdentity {
  readonly outputIndex: number;
  readonly targetTenant?: string;
  readonly alias: string;
  readonly childDeliveryId?: string;
}

/** Ramas hermanas de un mismo abanico, tal como este adaptador las tiene registradas. */
export interface DelegationBranchProgress {
  /** Destinos materializados, preserving duplicates and output order. */
  readonly delegated: readonly string[];
  readonly branches: readonly DelegationBranchIdentity[];
  readonly rejected: readonly Pick<DelegationRejectionNotice, "output_index" | "target" | "code">[];
  /** Ramas hermanas ya cerradas localmente, más nuevas primero. El texto es de este adaptador. */
  readonly returned: readonly ProcessedFaninReply[];
  /** Destinos delegados sin respuesta terminal local todavía, sin la rama que llega ahora. */
  readonly pending: readonly string[];
  readonly pendingBranches: readonly DelegationBranchIdentity[];
}

export const CANONICAL_OPEN_CODE_SESSION_FILE = "canonical-opencode-session.json";
export const MAX_SESSIONS_FILE_BYTES = 1024 * 1024;
export const MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS = 24 * 60 * 60 * 1_000;
export const DELEGATION_CONTEXT_PRUNE_RETRY_MS = 60_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Directory fsync is optional only when the filesystem explicitly reports it unsupported. */
export const UNSUPPORTED_DIRECTORY_FSYNC_CODES = ["EINVAL", "ENOTSUP", "EOPNOTSUPP"] as const;
export type UnsupportedDirectoryFsyncCode = typeof UNSUPPORTED_DIRECTORY_FSYNC_CODES[number];
export type DirectoryFsync = (directory: FileHandle) => Promise<void>;

export interface DurableStoreOpenOptions {
  /** Kant/OpenCode reloads sessions under its acquired stable-alias lease. */
  readonly deferSessions?: boolean;
  /** Deterministic fault injection for durability tests; production omits it. */
  readonly directoryFsync?: DirectoryFsync;
}

export type CanonicalOpenCodeSessionPointer =
  | {
      readonly version: 1;
      readonly state: "active";
      readonly alias: "kant";
      readonly harness: "opencode";
      readonly scope_key: string;
      readonly session_id: string;
    }
  | {
      readonly version: 1;
      readonly state: "unavailable";
      readonly alias: "kant";
      readonly harness: "opencode";
      readonly scope_key: null;
      readonly session_id: null;
      readonly reason: "missing" | "ambiguous" | "invalid";
    };

export interface SessionsFile {
  readonly version: 1;
  readonly sessions: Record<string, SessionRecord>;
}

export interface FencingFile {
  readonly version: 1;
  readonly epoch: number;
}

export type DeliveryAcceptance = "created" | "retry" | "duplicate" | "stale" | "blocked";

export interface EventCorrelation {
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
}

export interface EventDeliveryFeedback {
  readonly delegation_rejections?: readonly DelegationRejectionNotice[];
  readonly delegation_materializations?: readonly DelegationMaterializationNotice[];
  /** Sólo receipts terminales concluyentes; `superseded`/ausencia conservan el evento para replay. */
  readonly terminal_receipt?: "applied" | "duplicate" | "ownership_lost";
  /** Applied/duplicate receipt for the exact `execution_started` barrier event. */
  readonly execution_intent_receipt?: "applied" | "duplicate";
}

export interface DeliveryTransitionDetails {
  readonly output?: StructuredOutput;
  readonly profileAdoption?: ProfileRuntimeAdoptionEvidence;
  readonly error?: InboxRecord["error"];
  readonly retainRequest?: boolean;
  readonly attempt?: number;
  readonly claimToken?: string;
  readonly executionIntentProtocol?: "preinvoke-v1";
}

export interface LifecycleAcceptance {
  readonly acceptance: DeliveryAcceptance;
  readonly record: InboxRecord;
  /** Present only when this call created a new accepted lifecycle event. */
  readonly event?: DeliveryEvent;
}

export interface LifecycleTransition {
  readonly record: InboxRecord;
  readonly event: DeliveryEvent;
}

export type LifecycleEventSlot = "accepted" | "started" | "execution_started" | "terminal";

export const EMPTY_INBOX: InboxFile = { version: 1, deliveries: {} };
export const EMPTY_OUTBOX: OutboxFile = { version: 1, pending: [] };
export const EMPTY_SESSIONS: SessionsFile = { version: 1, sessions: {} };
export const EMPTY_FENCING: FencingFile = { version: 1, epoch: 0 };

export const ATOMIC_STATE_FILES = [
  "delivery-transaction.json",
  "inbox.json",
  "outbox.json",
  "sessions.json",
  "fencing.json",
  CANONICAL_OPEN_CODE_SESSION_FILE,
] as const;
export type AtomicStateFile = typeof ATOMIC_STATE_FILES[number];
export type AtomicArtifactKind = "tmp" | "backup-tmp" | "backup" | "committed";
