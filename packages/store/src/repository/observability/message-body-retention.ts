import { StoreError } from '../errors.js';
import { positiveMs } from './policy.js';

/** Retention of the attachment BYTES carried inside `messages.body`: 30 days. Whoever needed the file already got it in its delivery envelope; what anyone reads weeks later is the conversation, not the PDF. */
const DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS = 30 * 24 * 60 * 60_000;

/** Its OWN bound, two orders below `DEFAULT_RETENTION_BATCH` and never derived from it: that batch sizes DELETEs of narrow rows, this one sizes rewrites of bodies carrying up to `MAX_ATTACHMENTS_TOTAL_BYTES` each (~13,3 MB of base64) in one transaction; at 5 000 one tick pushes tens of GB of WAL, at 50 a few hundred MB, and the cadence knob sets the pace. */
export const DEFAULT_MESSAGE_ATTACHMENT_PRUNE_BATCH = 50;

export interface MessageAttachmentRetentionPolicy {
  readonly messageAttachmentsMs?: number;
  /** REQUIRED, no local default: a mirrored constant would validate the window against 48 h while the deployment runs a longer `CHAIN_MAX_AGE_MS`, the exact hole this guard closes; the caller configuring the sweep knows its horizon. */
  readonly chainMaxAgeMs: number;
  readonly batch?: number;
}

export interface MessageAttachmentRetentionResult {
  readonly message_attachments: number;
}

/**
 * KEY-LEVEL strip of `attachments_v1`, never a row delete nor a NULL body: `messages.body` is `jsonb NOT NULL` and stays load-bearing past delivery (chain sweep, fan-in and lease ceiling read other keys of it), so dropping one key leaves every reader intact. `attachments_pruned` keeps the file count so a reader sees "cuerpo purgado por retención" and not a corrupt body; `body ? 'attachments_v1'` keeps the sweep idempotent. The count sits inside a CASE so the shape guard runs BEFORE `jsonb_array_length`: with a bare AND one non-array row would abort the whole batch.
 * No index serves the predicate yet (the only `messages(created_at)` index is partial on `origin IS NOT NULL`), so the steady state is one sequential scan per run: the caller drives it on its own slow cadence, and the partial index on `created_at WHERE body ? 'attachments_v1'` is the pending follow-up. It SHORTENS exposure, it does not end it: the nightly `pg_dump` goes to an append-only NAS no sweep can reach.
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

/** The one strip every `dead_letters` writer shares (terminal ACK, reaper, operator cancel): bytes escaping through any of the three make the other two pointless, since nothing prunes `dead_letters` and the console DLQ view reads it forever. `attachments_omitted` means "this COPY does not carry the files" (the message can still be fetched); `attachments_pruned` means "the files no longer exist" (it cannot). Two facts, two names, decided here so no writer invents a third.
 *  The guard is `jsonb_typeof(...)='array'`, not key presence: `jsonb_array_length` over a non-array raises 22023 and, inside `ackDelivery`'s transaction, aborts the terminal ACK itself, leaving the delivery retrying forever. */
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
