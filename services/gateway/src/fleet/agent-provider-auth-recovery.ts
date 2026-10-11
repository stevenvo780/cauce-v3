import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { loadProviderAuthRoutingScope } from '../console/provider-auth-binding.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthSnapshot } from '../console/provider-auth.types.js';
import { AgentAuthBindingSchema, type AgentAuthBinding } from './agent-provider-auth-contracts.js';
import { HostAuthSnapshotSchema } from './auth-bridge-contracts.js';

export async function recoverAgentAuthSession(pool: DatabasePool, actor: ProviderAuthActor, id: string,
  cleanup: (binding: AgentAuthBinding, client: DatabaseClient) => Promise<boolean>, cancel = false): Promise<ProviderAuthSnapshot> {
  return withTransaction(pool, async client => {
    const stored = (await client.query<{ binding: unknown }>(`SELECT metadata->'agent_provider_auth_scope' AS binding FROM fleet_operation_events
      WHERE metadata->'agent_provider_auth_scope'->'fence'->>'session_id'=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    if (!stored) throw new ProviderAuthError('AUTHORITY_REVOKED');
    const binding = AgentAuthBindingSchema.parse(stored.binding);
    if (binding.actor.subject !== actor.subject || binding.actor.tenant_id !== actor.tenant_id || binding.actor.alias !== actor.alias
        || actor.requestedCompany !== undefined && actor.requestedCompany !== binding.actor.requestedCompany) throw new ProviderAuthError('AUTHORITY_REVOKED');
    const value = await loadProviderAuthRoutingScope(client, actor, binding.fence.operation_id);
    if (value.agent.company_id !== binding.actor.requestedCompany || value.sealed.target_sha256 !== binding.fence.scope_sha256
        || Number(value.operation.epoch) !== binding.fence.operation_epoch) throw new ProviderAuthError('AUTHORITY_REVOKED');
    const cohort = JSON.stringify([binding.physical.host_id, binding.physical.runtime_user, binding.physical.profile_id]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,783003005))', [cohort]);
    await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE', [value.operation.id]);
    const current = (await client.query<{ reservation: { session_id: string; state: string } }>(`SELECT metadata->'provider_auth' AS reservation
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata->'provider_auth'->>'session_id'=$2 ORDER BY id DESC LIMIT 1`, [value.operation.id, id])).rows[0];
    if (current?.reservation.session_id !== id) throw new ProviderAuthError('AUTHORITY_REVOKED');
    let audit = (await client.query<{ status: { status: ProviderAuthSnapshot['status']; error: ProviderAuthSnapshot['error'] } }>(`SELECT metadata->'provider_auth_status' AS status
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata->'provider_auth_status'->>'session_id'=$2 ORDER BY id DESC LIMIT 1`, [value.operation.id, id])).rows[0]?.status;
    const expired = Date.parse(binding.fence.expires_at) <= Date.now();
    let cleanupPending = current.reservation.state !== 'released';
    if (cleanupPending) {
      const latest = (await client.query<{ id: string }>(`SELECT metadata->'provider_auth'->>'session_id' AS id FROM fleet_operation_events
        WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [value.operation.id])).rows[0];
      if (latest?.id !== id) throw new ProviderAuthError('AUTHORITY_REVOKED');
      const stopped = await cleanup(binding, client); cleanupPending = !stopped;
      audit = { status: !stopped ? 'failed' : expired ? 'expired' : cancel ? 'cancelled' : 'failed',
        error: !stopped ? 'STOP_UNCONFIRMED' : expired ? 'SESSION_EXPIRED' : cancel ? null : 'HOST_UNAVAILABLE' };
      const next = (await client.query<{ version: string }>('UPDATE fleet_operations SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version', [value.operation.id])).rows[0];
      await client.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,'step_completed',$3::jsonb)`,
      [value.operation.id, next?.version, JSON.stringify({ step: 'authenticate',
        ...(stopped ? { provider_auth: { ...current.reservation, state: 'released' } } : {}), provider_auth_status: {
          ...audit, actor_subject: actor.subject, session_id: id, operation_id: value.operation.id } })]);
    }
    const method = (await client.query<{ method: ProviderAuthSnapshot['method'] }>(`SELECT metadata->'agent_provider_auth_method'->>'method' AS method
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata->'agent_provider_auth_method'->>'session_id'=$2 ORDER BY id DESC LIMIT 1`, [value.operation.id, id])).rows[0]?.method ?? 'device';
    return HostAuthSnapshotSchema.parse({ session_id: id, operation_id: value.operation.id, provider_id: binding.physical.provider_id, account_id: binding.physical.account_id,
      profile_id: binding.physical.profile_id, harness_id: binding.physical.harness_id, host_id: binding.physical.host_id,
      runtime_user: binding.physical.runtime_user, expires_at: binding.fence.expires_at, method, status: audit?.status ?? 'failed',
      error: audit ? audit.error : 'HOST_UNAVAILABLE', cleanup_pending: cleanupPending });
  });
}
