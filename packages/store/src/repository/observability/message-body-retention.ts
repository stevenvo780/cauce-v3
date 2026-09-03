import { StoreError } from '../errors.js';
import { positiveMs } from './policy.js';

/** Retention of the attachment BYTES carried inside `messages.body`: 30 days. Whoever needed the file already got it in its delivery envelope; what anyone reads weeks later is the conversation, not the PDF. */
const DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS = 30 * 24 * 60 * 60_000;

/**
 * Its OWN bound, deliberately two orders of magnitude below `DEFAULT_RETENTION_BATCH` (5 000) and never derived from it. The retention batch sizes DELETEs of narrow ack and audit rows; this one sizes rewrites of `messages` bodies that each carry up to `MAX_ATTACHMENTS_TOTAL_BYTES` (10 MB of files, ~13,3 MB of base64) in one transaction. At 5 000 a single tick would push tens of GB of WAL and bloat the hottest table in the base; at 50 the worst case is bounded to a few hundred MB, and the pace is set by the cadence knob instead of by the batch.
 */
export const DEFAULT_MESSAGE_ATTACHMENT_PRUNE_BATCH = 50;

export interface MessageAttachmentRetentionPolicy {
  readonly messageAttachmentsMs?: number;
  /**
   * REQUIRED, with no local default on purpose: a mirrored constant would validate the window against 48 h while the deployment runs a longer `CHAIN_MAX_AGE_MS`, which is exactly the hole this guard exists to close. The caller that configures the sweep is the one that knows its own horizon.
   */
  readonly chainMaxAgeMs: number;
  readonly batch?: number;
}

export interface MessageAttachmentRetentionResult {
  readonly message_attachments: number;
}

/**
 * KEY-LEVEL strip of `attachments_v1`; never a row delete and never a NULL body, and neither one is even available: `messages.body` is `jsonb NOT NULL CHECK (jsonb_typeof(body)='object')`, and it stays load-bearing long past delivery — the chain sweep reads `body->'correlation'->>'root_message_id'` and `body->>'type'`, the fan-in reads `body->>'text'`, the lease ceiling reads `body->>'timeout_ms'`. Dropping one key leaves every one of those readers intact by construction, and the row itself is never removed.
 * `attachments_pruned` keeps how many files were there, so a reader is told "cuerpo purgado por retención" instead of being shown a body that looks corrupt; `body ? 'attachments_v1'` makes the sweep idempotent and keeps a second pass from overwriting that count with 0. The count sits inside a CASE so the shape guard runs BEFORE `jsonb_array_length`: with a bare AND the operand order is undefined, and one row whose `attachments_v1` is not an array would abort the entire batch.
 * There is NO index for the predicate yet: the only `messages(created_at)` index is partial on `origin IS NOT NULL` and there is no GIN on `body`, so the steady state — nothing left to prune, so the LIMIT never short-circuits — is one sequential scan of `messages` per run. That is why the caller drives this with its own slow cadence instead of the retention tick, and why the partial index on `created_at WHERE body ? 'attachments_v1'` is the pending follow-up.
 * It SHORTENS exposure, it does not end it: the nightly `pg_dump` is synced to an append-only NAS that never deletes remotely, so no sweep over the live base can reach the off-site copies.
 */
export const MESSAGE_ATTACHMENT_PRUNE_SQL = `
  UPDATE messages
     SET body=(body-'attachments_v1'::text)||jsonb_build_object(
           'attachments_pruned',
           CASE WHEN jsonb_typeof(body->'attachments_v1')='array'
                THEN jsonb_array_length(body->'attachments_v1') ELSE 0 END)
   WHERE id IN (
     SELECT id FROM messages
      WHERE created_at < now()-$1*interval '1 millisecond'
        AND body ? 'attachments_v1' LIMIT $2)`;

/**
 * The one strip every `dead_letters` writer shares. There are three of them — terminal ACK, reaper and operator cancel — and a copy of the bytes escaping through any one of them makes the other two pointless: nothing prunes `dead_letters`, and its rows are readable from the console DLQ view forever.
 * `attachments_omitted` says "this COPY does not carry the files", which is not what `attachments_pruned` says ("the files no longer exist in the live base"). Both keys can appear in the same payload, and a reader that finds `attachments_omitted` can still fetch the message; one that finds `attachments_pruned` cannot. Two facts, two names, decided here so no writer invents a third.
 * The guard is `jsonb_typeof(...)='array'` and not key presence: `jsonb_array_length` over a non-array raises 22023, and inside `ackDelivery`'s transaction that aborts the terminal ACK itself, leaving the delivery retrying forever over a row that will never change.
 */
export function deadLetterBodySql(body: string): string {
  return `CASE WHEN jsonb_typeof(${body}->'attachments_v1')='array'
               THEN (${body}-'attachments_v1'::text)||jsonb_build_object(
                      'attachments_omitted',jsonb_array_length(${body}->'attachments_v1'))
               ELSE ${body} END`;
}

/** The window MUST outlive the chain sweep horizon: equal or shorter and a chain the watchdog can still reopen loses the files of its branches while it is being worked on, weeks later and with nothing tying the two events together. Rejected here, where it is configured. */
export function resolvedMessageAttachmentRetention(
  policy: MessageAttachmentRetentionPolicy
): { retentionMs: number; batch: number } {
  const retentionMs = positiveMs(
    policy.messageAttachmentsMs,
    DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS,
    'message attachment retention'
  );
  if (!Number.isSafeInteger(policy.chainMaxAgeMs) || policy.chainMaxAgeMs <= 0) {
    throw new StoreError('conflict', 'chain max age must be a positive integer');
  }
  if (retentionMs <= policy.chainMaxAgeMs) {
    throw new StoreError(
      'conflict',
      'message attachment retention window must exceed the chain sweep horizon'
    );
  }
  return {
    retentionMs,
    batch: positiveMs(policy.batch, DEFAULT_MESSAGE_ATTACHMENT_PRUNE_BATCH, 'retention batch')
  };
}
