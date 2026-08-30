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
  ) {}

  protected path(name: string): string {
    return join(this.directory, name);
  }

  protected atomicWrite(name: string, value: unknown): Promise<void> {
    return atomicWrite(this.path(name), value, this.directoryFsync);
  }

  /**
   * Write-ahead transaction over the historical inbox/outbox files.
   *
   * The intent is durable before either target changes. A crash at any later instruction leaves
   * enough information to idempotently finish both writes on reopen. Keeping the patch small
   * avoids rewriting the unbounded inbox for renewals and ACKs, while preserving the existing
   * files for old diagnostics and rollback tooling.
   */
  protected async commitDeliveryState(
    inbox: InboxFile,
    outbox: OutboxFile,
    targets: { readonly inbox: boolean; readonly outbox: boolean },
  ): Promise<void> {
    if (!targets.inbox && !targets.outbox) return;
    const transactionId = randomUUID();
    const inboxUpdates = targets.inbox
      ? Object.fromEntries(Object.entries(inbox.deliveries).filter(
          ([deliveryId, record]) => this.inbox.deliveries[deliveryId] !== record,
        ))
      : undefined;
    const transaction: DeliveryTransactionFile = {
      version: 1,
      transaction_id: transactionId,
      ...(inboxUpdates === undefined ? {} : { inbox_updates: inboxUpdates }),
      ...(targets.outbox ? { outbox_pending: outbox.pending } : {}),
    };
    await this.atomicWrite("delivery-transaction.json", transaction);
    try {
      const committedInbox: InboxFile = targets.inbox
        ? { version: 1, deliveries: inbox.deliveries, last_transaction_id: transactionId }
        : this.inbox;
      const committedOutbox: OutboxFile = targets.outbox
        ? { version: 1, pending: outbox.pending, last_transaction_id: transactionId }
        : this.outbox;
      if (targets.inbox) await this.atomicWrite("inbox.json", committedInbox);
      if (targets.outbox) await this.atomicWrite("outbox.json", committedOutbox);
      this.inbox = committedInbox;
      this.outbox = committedOutbox;
      this.recoveryRequired = false;
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
    if (pending.inbox_updates !== undefined
      && this.inbox.last_transaction_id !== pending.transaction_id) {
      const recoveredInbox: InboxFile = {
        version: 1,
        deliveries: { ...this.inbox.deliveries, ...pending.inbox_updates },
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
