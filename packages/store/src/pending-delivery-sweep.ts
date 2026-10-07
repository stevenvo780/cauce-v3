import type { DatabasePool } from './db.js';

export interface SweepRecipient {
  readonly tenant_id: string;
  readonly alias: string;
}

export interface PendingSweepOptions {
  /** Only deliveries this old: the publish's own wake is still draining the fresh ones. */
  readonly minAgeMs: number;
  /** Gateway admission headroom reserved to humans on top of `agents.max_concurrent_deliveries`. */
  readonly humanReservedCapacity: number;
}

/**
 * Connected recipients that have claimable work and nothing to drain it: a pending delivery past
 * `minAgeMs`, no live control hold and in-flight below the durable cap. A claim that found the row
 * locked, a hold that expired or a NOTIFY that got lost leaves no wake behind; this is the net.
 * Read-only: `claimDeliveries` re-checks every condition under its locks. The gateway runs it every
 * `pendingSweepMs` (default 2 s, 0 disables) over its open sessions, so such work waits at most one
 * tick plus one drain instead of an unrelated publish to the same alias.
 */
export async function claimableIdleRecipients(
  pool: DatabasePool, recipients: readonly SweepRecipient[], options: PendingSweepOptions,
): Promise<SweepRecipient[]> {
  if (recipients.length === 0) return [];
  const result = await pool.query<SweepRecipient>(
    `SELECT k.tenant_id,k.alias FROM unnest($1::text[],$2::text[]) AS k(tenant_id,alias)
      WHERE EXISTS (
              SELECT 1 FROM deliveries d
               WHERE d.recipient_tenant=k.tenant_id AND d.recipient_alias=k.alias
                 AND d.status IN ('pending','retry') AND d.last_ack_rank=0 AND d.terminal_at IS NULL
                 AND d.available_at<=now()-$3*interval '1 millisecond')
        AND NOT EXISTS (
              SELECT 1 FROM terminal_control_holds h
               WHERE h.tenant_id=k.tenant_id AND h.alias=k.alias
                 AND h.released_at IS NULL AND h.expires_at>now())
        AND (SELECT count(*) FROM deliveries d
               WHERE d.recipient_tenant=k.tenant_id AND d.recipient_alias=k.alias
                 AND d.status IN ('leased','accepted','started') AND d.claim_token IS NOT NULL
                 AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now())
            < COALESCE((SELECT a.max_concurrent_deliveries FROM agents a
                         WHERE a.tenant_id=k.tenant_id AND a.alias=k.alias), 2147483647)::bigint + $4`,
    [recipients.map((recipient) => recipient.tenant_id), recipients.map((recipient) => recipient.alias),
      options.minAgeMs, options.humanReservedCapacity],
  );
  return result.rows;
}
