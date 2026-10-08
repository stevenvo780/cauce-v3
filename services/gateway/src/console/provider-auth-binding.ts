import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { ProviderAuthError } from './provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthDependencies, ProviderAuthLogin, ProviderAuthRequest } from './provider-auth.types.js';

export type ProviderAuthPolicyScope = Pick<ProviderAuthRequest, 'provider_id' | 'account_id' | 'harness_id' | 'host_id' | 'runtime_user' | 'profile_id'>;
interface Agent { tenant_id: string; alias: string; harness_id: string; host_id: string; runtime_user: string; primary_account_id: string; retired_at: Date | null }
interface Account { id: string; provider: string; external_account_id: string; payer_tenant_id: string; shared_with_pool: boolean; enabled: boolean }
interface Operation { id: string; actor_tenant: string; actor_alias: string; target: { resource: string; tenant_id: string; alias?: string };
  executor_host: string; status: string; version: string; cancel_requested: boolean; kind: string; request: unknown }
export interface ProviderAuthPolicyContext { actor: ProviderAuthActor; operation: Operation; agent: Agent; account: Account }
export type ProviderAuthPolicyResolver = (client: DatabaseClient, context: ProviderAuthPolicyContext) => Promise<ProviderAuthPolicyScope>;
export interface ProviderAuthPhysicalScope extends ProviderAuthPolicyScope {
  operation_id: string; tenant_id: string; alias: string; expected_external_account_id: string;
}
export interface ProviderAuthPhysicalHooks {
  stopAdapter(scope: ProviderAuthPhysicalScope, signal: AbortSignal): Promise<{ stopped: boolean }>;
  openLogin(scope: ProviderAuthPhysicalScope, signal: AbortSignal): Promise<ProviderAuthLogin>;
  verify(scope: ProviderAuthPhysicalScope, signal: AbortSignal): Promise<{ identity_matches: boolean; functional_call_verified: boolean }>;
  cleanup(scope: ProviderAuthPhysicalScope, sessionId: string, signal: AbortSignal): Promise<{ stopped: boolean }>;
}
interface Reservation {
  session_id: string; actor_subject: string; cohort: string; expires_at: string; state: 'reserved' | 'released';
}
const denied = () => new ProviderAuthError('AUTHORITY_REVOKED');

async function human(client: DatabaseClient, actor: ProviderAuthActor): Promise<void> {
  const match = /^console:([0-9a-f-]{36})$/u.exec(actor.subject);
  if (!match) throw denied();
  const account = (await client.query<{ active: boolean; role: string; tenant_id: string; alias: string }>(
    'SELECT active,role,tenant_id,alias FROM console_users WHERE id=$1::uuid FOR SHARE', [match[1]])).rows[0];
  if (!account?.active || account.role !== 'operator' || account.tenant_id !== actor.tenant_id || account.alias !== actor.alias) throw denied();
  const membership = (await client.query<{ enabled: boolean; revoked_at: Date | null; role: string; actor_alias: string; permissions: string[] }>(
    `SELECT enabled,revoked_at,role,actor_alias,permissions FROM human_tenant_memberships
      WHERE human_id=$1::uuid AND tenant_id=$2 FOR SHARE`, [match[1], actor.tenant_id])).rows[0];
  if (membership && (!membership.enabled || membership.revoked_at !== null || membership.role !== 'operator'
      || membership.actor_alias !== actor.alias || !membership.permissions.includes('control'))) throw denied();
  const authority = (await client.query<{ allowed: boolean }>(`SELECT bool_or(policy.allow_control AND tenant.is_hub) AS allowed
    FROM memberships member JOIN tenants tenant ON tenant.id=member.tenant_id
    JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
    JOIN role_policies policy ON policy.role=member.role
    WHERE member.tenant_id=$1 AND member.alias=$2 AND member.enabled AND tenant.enabled AND room.enabled`,
  [actor.tenant_id, actor.alias])).rows[0];
  if (authority?.allowed !== true) throw denied();
}
async function context(client: DatabaseClient, actor: ProviderAuthActor, request: ProviderAuthRequest, lock = false): Promise<ProviderAuthPolicyContext> {
  await human(client, actor);
  const operation = (await client.query<Operation>(`SELECT id,actor_tenant,actor_alias,target,executor_host,status,version,cancel_requested,kind,request
    FROM fleet_operations WHERE id=$1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [request.operation_id])).rows[0];
  if (!operation || operation.status !== 'awaiting_auth' || operation.cancel_requested || operation.target.resource !== 'agent'
      || operation.actor_tenant !== actor.tenant_id || operation.actor_alias !== actor.alias) throw denied();
  const initiator = (await client.query<{ subject: string | null }>(`SELECT metadata->>'actor_subject' AS subject
    FROM fleet_operation_events WHERE operation_id=$1 AND event='queued' ORDER BY id LIMIT 1`, [operation.id])).rows[0];
  if (initiator?.subject !== actor.subject) throw denied();
  const agent = (await client.query<Agent>(`SELECT tenant_id,alias,harness_id,host_id,runtime_user,primary_account_id,retired_at
    FROM agents WHERE tenant_id=$1 AND alias=$2 FOR SHARE`, [operation.target.tenant_id, operation.target.alias])).rows[0];
  if (!agent || agent.retired_at !== null) throw denied();
  const account = (await client.query<Account>(`SELECT id,provider,external_account_id,payer_tenant_id,shared_with_pool,enabled
    FROM provider_accounts WHERE id=$1 FOR SHARE`, [agent.primary_account_id])).rows[0];
  if (!account?.enabled || (account.payer_tenant_id !== agent.tenant_id && !account.shared_with_pool)) throw denied();
  return { actor, operation, agent, account };
}
async function scope(client: DatabaseClient, value: ProviderAuthPolicyContext, request: ProviderAuthRequest,
  resolve: ProviderAuthPolicyResolver): Promise<ProviderAuthPhysicalScope> {
  const policy = await resolve(client, value);
  for (const key of ['provider_id', 'account_id', 'harness_id', 'host_id', 'runtime_user', 'profile_id'] as const) {
    if (policy[key] !== request[key]) throw denied();
  }
  if (policy.account_id !== value.account.id || policy.harness_id !== value.agent.harness_id || policy.host_id !== value.agent.host_id
      || policy.host_id !== value.operation.executor_host || policy.runtime_user !== value.agent.runtime_user) throw denied();
  if (value.operation.kind === 'create' || value.operation.kind === 'update') {
    const operation = value.operation.request as { parameters?: { primary_account_id?: string; harness_id?: string; placement?: { host_id?: string; runtime_user?: string } } } | null;
    const desired = operation?.parameters;
    if (desired?.primary_account_id !== policy.account_id || desired.harness_id !== policy.harness_id
        || desired.placement?.host_id !== policy.host_id || desired.placement.runtime_user !== policy.runtime_user) throw denied();
  }
  return { ...policy, operation_id: value.operation.id, tenant_id: value.agent.tenant_id, alias: value.agent.alias,
    expected_external_account_id: value.account.external_account_id };
}
async function event(client: DatabaseClient, operationId: string, name: 'step_started' | 'step_completed', reservation: Reservation): Promise<void> {
  const next = (await client.query<{ version: string }>(`UPDATE fleet_operations SET version=version+1,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING version`, [operationId])).rows[0];
  if (!next) throw new ProviderAuthError('SESSION_CONFLICT');
  await client.query('INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,$3,$4::jsonb)',
    [operationId, next.version, name, JSON.stringify({ step: 'authenticate', provider_auth: reservation })]);
}
async function latest(client: DatabaseClient, operationId: string): Promise<Reservation | undefined> {
  return (await client.query<{ reservation: Reservation }>(`SELECT metadata->'provider_auth' AS reservation FROM fleet_operation_events
    WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [operationId])).rows[0]?.reservation;
}

export function createProviderAuthDependencies(
  pool: DatabasePool, resolve: ProviderAuthPolicyResolver, hooks: ProviderAuthPhysicalHooks,
): ProviderAuthDependencies {
  const authorize = async (actor: ProviderAuthActor, request: ProviderAuthRequest) => {
    await withTransaction(pool, async client => { await scope(client, await context(client, actor, request), request, resolve); });
  };
  return {
    authorize,
    reserve: async (actor, request, sessionId, expiresAt) => {
      const expires = Date.parse(expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 600_000) throw new ProviderAuthError('SESSION_EXPIRED');
      const cohort = JSON.stringify([request.host_id, request.runtime_user, request.profile_id]);
      const physical = await withTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,783003005))', [cohort]);
        const value = await context(client, actor, request, true);
        if (Number(value.operation.version) !== request.expected_operation_version) throw new ProviderAuthError('SESSION_CONFLICT');
        const trusted = await scope(client, value, request, resolve);
        const reservations = await client.query<{ operation_id: string; reservation: Reservation }>(`SELECT DISTINCT ON (operation_id)
          operation_id,metadata->'provider_auth' AS reservation FROM fleet_operation_events
          WHERE metadata->'provider_auth'->>'cohort'=$1 ORDER BY operation_id,id DESC`, [cohort]);
        for (const prior of reservations.rows) {
          if (prior.reservation.state !== 'reserved') continue;
          if (Date.parse(prior.reservation.expires_at) > Date.now()) throw new ProviderAuthError('SESSION_CONFLICT');
          await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE', [prior.operation_id]);
          const stopped = await hooks.cleanup({ ...trusted, operation_id: prior.operation_id }, prior.reservation.session_id, new AbortController().signal);
          if (stopped.stopped !== true) throw new ProviderAuthError('STOP_UNCONFIRMED');
          await event(client, prior.operation_id, 'step_completed', { ...prior.reservation, state: 'released' });
        }
        await event(client, request.operation_id, 'step_started', { session_id: sessionId, actor_subject: actor.subject,
          cohort, expires_at: expiresAt, state: 'reserved' });
        return trusted;
      });
      const active = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        await withTransaction(pool, async client => {
          const value = await context(client, actor, request);
          await scope(client, value, request, resolve);
          const current = await latest(client, request.operation_id);
          if (current?.session_id !== sessionId || current.state !== 'reserved' || Date.parse(current.expires_at) <= Date.now()) {
            throw new ProviderAuthError('SESSION_EXPIRED');
          }
        });
        signal.throwIfAborted();
      };
      return {
        stopAdapter: async signal => { await active(signal); return hooks.stopAdapter(physical, signal); },
        openLogin: async signal => { await active(signal); return hooks.openLogin(physical, signal); },
        verify: async signal => { await active(signal); return hooks.verify(physical, signal); },
        release: async () => {
          await withTransaction(pool, async client => {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,783003005))', [cohort]);
            await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE', [request.operation_id]);
            const current = await latest(client, request.operation_id);
            if (current?.session_id !== sessionId) throw new ProviderAuthError('SESSION_CONFLICT');
            if (current.state === 'released') return;
            if ((await hooks.cleanup(physical, sessionId, new AbortController().signal)).stopped !== true) throw new ProviderAuthError('STOP_UNCONFIRMED');
            await event(client, request.operation_id, 'step_completed', { ...current, state: 'released' });
          });
        },
      };
    },
    audit: async metadata => {
      await withTransaction(pool, async client => {
        const operation = (await client.query<{ version: string }>('SELECT version FROM fleet_operations WHERE id=$1 FOR SHARE', [metadata.operation_id])).rows[0];
        if (!operation) throw new ProviderAuthError('SESSION_CONFLICT');
        await client.query('INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,$3,$4::jsonb)',
          [metadata.operation_id, operation.version, 'step_completed', JSON.stringify({ step: 'authenticate', provider_auth_status: metadata })]);
      });
    },
  };
}
