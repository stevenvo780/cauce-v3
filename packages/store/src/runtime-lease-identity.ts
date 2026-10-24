import type { Tenant } from '@cauce/protocol';
import { logEvent } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

/** Taken from the authenticated principal and the issuer's verified provenance, never from hello. */
export interface RuntimeLeaseIdentity {
  readonly channel: string;
  readonly sessionId: string;
  readonly hostId?: string;
  readonly expiresAt?: string;
  readonly legacyHostId?: string;
}

export async function assertRuntimeLeaseIdentity(
  client: DatabaseClient, tenantId: Tenant, alias: string, identity: RuntimeLeaseIdentity | undefined,
): Promise<void> {
  if (identity === undefined) return;
  const row = (await client.query<{ allowed: boolean }>(`SELECT (
      $3='adapter' AND (
        (agent.runtime_mode IS NULL AND EXISTS (
          SELECT 1 FROM fleet_runtime_identities original WHERE original.tenant_id=agent.tenant_id
            AND original.alias=agent.alias AND original.runtime_key=agent.runtime_key AND original.baseline
            AND original.baseline_state->>'runtime_mode' IS NULL
            AND (agent.host_id IS NULL OR agent.host_id=COALESCE(original.baseline_state->>'host_id',$7))))
        OR (agent.runtime_mode IS NOT NULL AND $5='adapter-' || agent.runtime_key
          AND agent.host_id=$4 AND $6::timestamptz>clock_timestamp())
      )) AS allowed FROM agents agent WHERE agent.tenant_id=$1 AND agent.alias=$2 FOR SHARE OF agent`,
  [tenantId, alias, identity.channel, identity.hostId ?? null, identity.sessionId, identity.expiresAt ?? null,
    identity.legacyHostId ?? null])).rows[0];
  if (row?.allowed !== true) {
    throw new StoreError('forbidden', 'consumer identity does not match durable placement', 'consumer_placement_mismatch');
  }
}

export async function auditRuntimeLease<T>(
  pool: DatabasePool, tenantId: Tenant, alias: string, phase: 'hello' | 'heartbeat', work: () => Promise<T>,
): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof StoreError && error.recoveryReason === 'consumer_placement_mismatch') {
      const metadata = { reason: error.recoveryReason, phase };
      logEvent('connection_lease_identity_rejected', { tenant_id: tenantId, alias, ...metadata }, { level: 'warn' });
      try {
        await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
          VALUES($1,$2,'connection.lease.rejected','deny',$3::jsonb)`, [tenantId, alias, JSON.stringify(metadata)]);
      } catch {
        logEvent('connection_lease_rejection_audit_failed', { tenant_id: tenantId, alias, phase }, { level: 'error' });
      }
    }
    throw error;
  }
}
