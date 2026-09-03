import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  atomicWrite,
  clone,
  readJson,
} from "./atomic-state.js";
import {
  DELEGATION_CONTEXT_PRUNE_RETRY_MS,
  EMPTY_FENCING,
  EMPTY_INBOX,
  EMPTY_OUTBOX,
  EMPTY_SESSIONS,
  MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS,
  MAX_TIMER_DELAY_MS,
  type DeliveryTransactionFile,
  type DirectoryFsync,
  type FencingFile,
  type InboxFile,
  type InboxRecord,
  type OutboxFile,
  type SessionsFile,
} from "./contracts.js";
import { TerminalHistory } from "./terminal-history.js";

export class DurableStoreBase {
  protected inbox: InboxFile = clone(EMPTY_INBOX);
  protected outbox: OutboxFile = clone(EMPTY_OUTBOX);
  protected sessions: SessionsFile = clone(EMPTY_SESSIONS);
  protected fencing: FencingFile = clone(EMPTY_FENCING);
  protected tail: Promise<void> = Promise.resolve();
  protected canonicalOpenCodeScopeKey: string | undefined;
  protected canonicalOpenCodeReconciled = false;
  protected delegationContextPruneTimer: ReturnType<typeof setTimeout> | undefined;
  protected recoveryRequired = false;

  protected constructor(
    protected readonly directory: string,
    protected readonly directoryFsync: DirectoryFsync,
    protected readonly terminalHistory: TerminalHistory,
    private readonly maxInlineTerminalRecords: number,
  ) {}

  protected path(name: string): string {
    return join(this.directory, name);
  }

  protected atomicWrite(name: string, value: unknown): Promise<void> {
    return atomicWrite(this.path(name), value, this.directoryFsync);
  }

  /**
   * Write-ahead transaction over the mutable inbox/outbox files.
   *
   * The intent is durable before either target changes. A crash at any later instruction leaves
   * enough information to idempotently finish both writes on reopen. The patch avoids rewriting
   * unchanged inbox records for renewals and ACKs, while confirmed terminals move to exact
   * immutable history for old diagnostics and fencing.
   */
  protected async commitDeliveryState(
    inbox: InboxFile,
    outbox: OutboxFile,
    targets: { readonly inbox: boolean; readonly outbox: boolean },
  ): Promise<number> {
    const compacted = await this.withCompactedTerminalHistory(inbox, outbox);
    const committedInboxCandidate = compacted.inbox;
    const archivedByDelivery = new Map(compacted.archived.map((record) => (
      [record.delivery_id, record] as const
    )));
    const writeInbox = targets.inbox || compacted.count > 0;
    if (!writeInbox && !targets.outbox) return 0;
    const transactionId = randomUUID();
    const inboxUpdates = writeInbox
      ? Object.fromEntries(Object.entries(committedInboxCandidate.deliveries).filter(
          ([deliveryId, record]) => this.inbox.deliveries[deliveryId] !== record,
        ))
      : undefined;
    const inboxDeletes = writeInbox
      ? Object.entries(this.inbox.deliveries).flatMap(([deliveryId, record]) => {
          if (Object.hasOwn(committedInboxCandidate.deliveries, deliveryId)) return [];
          const archived = archivedByDelivery.get(deliveryId);
          if (archived === undefined) {
            throw new Error(`Inbox deletion has no archived candidate for ${deliveryId}`);
          }
          return [{
            delivery_id: deliveryId,
            fingerprint: record.fingerprint,
            attempt: record.attempt,
            claim_token: record.claim_token,
            record_digest: this.terminalHistory.digest(archived),
          }];
        })
      : [];
    const transaction: DeliveryTransactionFile = {
      version: 1,
      transaction_id: transactionId,
      ...(inboxUpdates === undefined ? {} : { inbox_updates: inboxUpdates }),
      ...(inboxDeletes.length === 0 ? {} : { inbox_deletes: inboxDeletes }),
      ...(targets.outbox ? { outbox_pending: outbox.pending } : {}),
    };
    await this.atomicWrite("delivery-transaction.json", transaction);
    try {
      const committedInbox: InboxFile = writeInbox
        ? {
            version: 1,
            deliveries: committedInboxCandidate.deliveries,
            last_transaction_id: transactionId,
          }
        : this.inbox;
      const committedOutbox: OutboxFile = targets.outbox
        ? { version: 1, pending: outbox.pending, last_transaction_id: transactionId }
        : this.outbox;
      if (writeInbox) await this.atomicWrite("inbox.json", committedInbox);
      if (targets.outbox) await this.atomicWrite("outbox.json", committedOutbox);
      this.inbox = committedInbox;
      this.outbox = committedOutbox;
      this.recoveryRequired = false;
      return compacted.count;
    } catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  protected async recoverDeliveryTransaction(transaction?: DeliveryTransactionFile): Promise<void> {
    const pending = transaction ?? await readJson<DeliveryTransactionFile | undefined>(
      this.path("delivery-transaction.json"),
      undefined,
    );
    if (pending === undefined) {
      this.recoveryRequired = false;
      return;
    }
    if ((pending.inbox_updates !== undefined || pending.inbox_deletes !== undefined)
      && this.inbox.last_transaction_id !== pending.transaction_id) {
      const deliveries: Record<string, InboxRecord> = {
        ...this.inbox.deliveries,
        ...pending.inbox_updates,
      };
      for (const deletion of pending.inbox_deletes ?? []) {
        const current = deliveries[deletion.delivery_id];
        if (current !== undefined && (current.fingerprint !== deletion.fingerprint
            || current.attempt !== deletion.attempt
            || current.claim_token !== deletion.claim_token)) {
          throw new Error(`Stale inbox deletion fence for ${deletion.delivery_id}`);
        }
        const archived = this.terminalHistory.get(deletion.delivery_id);
        if (archived?.fingerprint !== deletion.fingerprint
            || archived.attempt !== deletion.attempt
            || archived.claim_token !== deletion.claim_token
            || !this.terminalHistory.hasExact(deletion.delivery_id, deletion.record_digest)) {
          throw new Error(`Inbox deletion has no exact terminal history for ${deletion.delivery_id}`);
        }
        Reflect.deleteProperty(deliveries, deletion.delivery_id);
      }
      const recoveredInbox: InboxFile = {
        version: 1,
        deliveries,
        last_transaction_id: pending.transaction_id,
      };
      await this.atomicWrite("inbox.json", recoveredInbox);
      this.inbox = recoveredInbox;
    }
    if (pending.outbox_pending !== undefined
      && this.outbox.last_transaction_id !== pending.transaction_id) {
      const recoveredOutbox: OutboxFile = {
        version: 1,
        pending: pending.outbox_pending,
        last_transaction_id: pending.transaction_id,
      };
      await this.atomicWrite("outbox.json", recoveredOutbox);
      this.outbox = recoveredOutbox;
    }
    this.recoveryRequired = false;
  }

  private async withCompactedTerminalHistory(
    inbox: InboxFile,
    outbox: OutboxFile,
  ): Promise<{
    readonly inbox: InboxFile;
    readonly archived: readonly InboxRecord[];
    readonly count: number;
  }> {
    const pendingDeliveries = new Set(outbox.pending.map((event) => event.delivery_id));
    const eligible = Object.values(inbox.deliveries)
      .filter((record) => (
        (record.state === "done" || record.state === "failed")
        && record.request === undefined
        && record.lifecycle_event_ids?.terminal !== undefined
        && !pendingDeliveries.has(record.delivery_id)
      ))
      .sort((left, right) => (
        left.updated_at.localeCompare(right.updated_at)
        || left.delivery_id.localeCompare(right.delivery_id)
      ));
    if (eligible.length <= this.maxInlineTerminalRecords) {
      return { inbox, archived: [], count: 0 };
    }
    const retained = this.maxInlineTerminalRecords === 0
      ? 0
      : Math.floor(this.maxInlineTerminalRecords / 2);
    const archived = eligible.slice(0, eligible.length - retained);
    await this.terminalHistory.archive(archived);
    const deliveries = { ...inbox.deliveries };
    for (const record of archived) Reflect.deleteProperty(deliveries, record.delivery_id);
    return { inbox: { version: 1, deliveries }, archived, count: archived.length };
  }

  async compactTerminalRecords(): Promise<number> {
    return this.serialized(async () => this.commitDeliveryState(
      this.inbox,
      this.outbox,
      { inbox: false, outbox: false },
    ));
  }

  protected withoutExpiredDelegationContexts(nowMs: number): InboxFile {
    let changed = false;
    const deliveries: Record<string, InboxRecord> = { ...this.inbox.deliveries };
    for (const [deliveryId, record] of Object.entries(deliveries)) {
      if (record.request === undefined || (record.state !== "done" && record.state !== "failed")) continue;
      const updatedAtMs = Date.parse(record.updated_at);
      if (Number.isFinite(updatedAtMs)
        && nowMs - updatedAtMs < MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS) continue;
      const withoutRequest = { ...record };
      delete withoutRequest.request;
      deliveries[deliveryId] = withoutRequest;
      changed = true;
    }
    return changed ? { version: 1, deliveries } : this.inbox;
  }

  protected scheduleDelegationContextPrune(
    nowMs = Date.now(),
    minimumDelayMs = 0,
  ): void {
    if (this.delegationContextPruneTimer !== undefined) {
      clearTimeout(this.delegationContextPruneTimer);
      this.delegationContextPruneTimer = undefined;
    }
    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const record of Object.values(this.inbox.deliveries)) {
      if (record.request === undefined || (record.state !== "done" && record.state !== "failed")) continue;
      const updatedAtMs = Date.parse(record.updated_at);
      nextExpiryMs = Math.min(
        nextExpiryMs,
        Number.isFinite(updatedAtMs)
          ? updatedAtMs + MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS
          : nowMs,
      );
    }
    if (!Number.isFinite(nextExpiryMs)) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, minimumDelayMs, Math.ceil(nextExpiryMs - nowMs)),
    );
    this.delegationContextPruneTimer = setTimeout(() => {
      this.delegationContextPruneTimer = undefined;
      void this.pruneExpiredDelegationContexts().catch(() => {
        this.scheduleDelegationContextPrune(Date.now(), DELEGATION_CONTEXT_PRUNE_RETRY_MS);
      });
    }, delayMs);
    this.delegationContextPruneTimer.unref();
  }

  close(): void {
    if (this.delegationContextPruneTimer === undefined) return;
    clearTimeout(this.delegationContextPruneTimer);
    this.delegationContextPruneTimer = undefined;
  }

  async pruneExpiredDelegationContexts(nowMs = Date.now()): Promise<number> {
    if (!Number.isFinite(nowMs)) throw new RangeError("Delegation context prune time must be finite");
    return this.serialized(async () => {
      const nextInbox = this.withoutExpiredDelegationContexts(nowMs);
      if (nextInbox === this.inbox) {
        this.scheduleDelegationContextPrune();
        return 0;
      }
      const removed = Object.keys(this.inbox.deliveries)
        .filter((deliveryId) =>
          this.inbox.deliveries[deliveryId]?.request !== undefined
          && nextInbox.deliveries[deliveryId]?.request === undefined)
        .length;
      await this.commitDeliveryState(nextInbox, this.outbox, { inbox: true, outbox: false });
      this.scheduleDelegationContextPrune();
      return removed;
    });
  }

  protected async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.recoveryRequired) await this.recoverDeliveryTransaction();
      return await operation();
    } finally {
      release();
    }
  }

  get epoch(): number {
    return this.fencing.epoch;
  }

  async activateEpoch(epoch: number): Promise<"same" | "advanced"> {
    return this.serialized(async () => {
      if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new RangeError("Epoch must be positive");
      if (epoch < this.fencing.epoch) {
        throw new RangeError(
          `Cannot lower fencing epoch from ${String(this.fencing.epoch)} to ${String(epoch)}`,
        );
      }
      if (epoch === this.fencing.epoch) return "same";
      this.fencing = { version: 1, epoch };
      await this.atomicWrite("fencing.json", this.fencing);
      return "advanced";
    });
  }

}
