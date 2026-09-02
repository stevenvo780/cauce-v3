import { join } from "node:path";
import {
  clone,
  defaultDirectoryFsync,
  prepareStateDirectory,
  readJson,
  recoverAtomicArtifacts,
} from "./durable-store/atomic-state.js";
import {
  ATOMIC_STATE_FILES,
  DEFAULT_MAX_INLINE_TERMINAL_RECORDS,
  EMPTY_FENCING,
  EMPTY_INBOX,
  EMPTY_OUTBOX,
  EMPTY_SESSIONS,
  MAX_INLINE_TERMINAL_RECORDS,
  TERMINAL_HISTORY_DIRECTORY,
  type AtomicStateFile,
  type DeliveryTransactionFile,
  type DirectoryFsync,
  type DurableStoreOpenOptions,
} from "./durable-store/contracts.js";
import { DurableStoreSessions } from "./durable-store/sessions.js";
import { readSessionsSecure } from "./durable-store/session-file.js";
import { TerminalHistory } from "./durable-store/terminal-history.js";

export {
  ATOMIC_STATE_FILES,
  CANONICAL_OPEN_CODE_SESSION_FILE,
  MAX_INLINE_TERMINAL_RECORDS,
  MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS,
  MAX_SESSIONS_FILE_BYTES,
  TERMINAL_HISTORY_DIRECTORY,
  UNSUPPORTED_DIRECTORY_FSYNC_CODES,
} from "./durable-store/contracts.js";
export type {
  CanonicalOpenCodeSessionPointer,
  DelegationBranchIdentity,
  DelegationBranchProgress,
  DeliveryAcceptance,
  DeliveryTransitionDetails,
  DirectoryFsync,
  EventCorrelation,
  EventDeliveryFeedback,
  InboxRecord,
  InboxState,
  LifecycleAcceptance,
  LifecycleTransition,
  ProcessedFaninReply,
  SessionOrigin,
  SessionRecord,
} from "./durable-store/contracts.js";
export {
  isCanonicalOpenCodeScopeKey,
  isCanonicalOpenCodeSessionId,
  sanitizeSessionOrigin,
} from "./durable-store/session-file.js";
export { ConsumerLease } from "./durable-store/consumer-lease.js";

export class DurableStore extends DurableStoreSessions {
  private constructor(
    directory: string,
    directoryFsync: DirectoryFsync,
    terminalHistory: TerminalHistory,
    maxInlineTerminalRecords: number,
  ) {
    super(directory, directoryFsync, terminalHistory, maxInlineTerminalRecords);
  }

  static async open(directory: string, options: DurableStoreOpenOptions = {}): Promise<DurableStore> {
    const maxInlineTerminalRecords = options.maxInlineTerminalRecords
      ?? DEFAULT_MAX_INLINE_TERMINAL_RECORDS;
    if (!Number.isSafeInteger(maxInlineTerminalRecords)
        || maxInlineTerminalRecords < 0
        || maxInlineTerminalRecords > MAX_INLINE_TERMINAL_RECORDS) {
      throw new RangeError(
        `maxInlineTerminalRecords must be an integer between 0 and ${String(MAX_INLINE_TERMINAL_RECORDS)}`,
      );
    }
    await prepareStateDirectory(directory);
    const directoryFsync = options.directoryFsync ?? defaultDirectoryFsync;
    const startupRecoveryTargets: readonly AtomicStateFile[] = options.deferSessions === true
      ? ["delivery-transaction.json", "inbox.json", "outbox.json", "fencing.json"]
      : ATOMIC_STATE_FILES;
    await recoverAtomicArtifacts(directory, startupRecoveryTargets, directoryFsync);
    const terminalHistory = await TerminalHistory.open(
      join(directory, TERMINAL_HISTORY_DIRECTORY),
      directoryFsync,
    );
    const store = new DurableStore(
      directory,
      directoryFsync,
      terminalHistory,
      maxInlineTerminalRecords,
    );
    const [loadedInbox, loadedOutbox, transaction, sessions, fencing] = await Promise.all([
      readJson(store.path("inbox.json"), EMPTY_INBOX),
      readJson(store.path("outbox.json"), EMPTY_OUTBOX),
      readJson<DeliveryTransactionFile | undefined>(
        store.path("delivery-transaction.json"),
        undefined,
      ),
      options.deferSessions === true
        ? Promise.resolve(clone(EMPTY_SESSIONS))
        : readSessionsSecure(store.path("sessions.json")),
      readJson(store.path("fencing.json"), EMPTY_FENCING),
    ]);
    store.inbox = loadedInbox;
    store.outbox = loadedOutbox;
    store.sessions = sessions;
    store.fencing = fencing;
    if (transaction !== undefined) await store.recoverDeliveryTransaction(transaction);
    await store.pruneExpiredDelegationContexts();
    await store.compactTerminalRecords();
    return store;
  }

}
