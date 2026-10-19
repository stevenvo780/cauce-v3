import { StoreError, assertFleetRelocationSourceBarrier, bindProviderAccountIdentity, enableProviderAccountAfterAgentAuth, loadFleetHostScope, lockCompanyAuthority, planFleetHostSlices, preparedState, selectFleetHostSlices, providerAccountConsentSql, withTransaction,
  type CompanyAuthority, type DatabaseClient, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { randomUUID } from 'node:crypto';
import { ProviderAuthError, ProviderAuthRequestSchema } from './provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthDependencies, ProviderAuthLogin, ProviderAuthRequest } from './provider-auth.types.js';
import { latestProviderAuthReservation as latest, recordProviderAuthReservation as event, releaseProviderAuthReservation,
  type ProviderAuthReservation as Reservation } from './provider-auth-reservation.js';

type ProviderAuthPolicyScope = Pick<ProviderAuthRequest, 'provider_id' | 'account_id' | 'harness_id' | 'host_id' | 'runtime_user' | 'profile_id'>;
interface Agent extends Record<string, unknown> { tenant_id: string; alias: string; runtime_key: string; harness_id: string; host_id: string;
  runtime_user: string; primary_account_id: string; retired_at: Date | null; purged_at: Date | null; company_id: string }
interface Account { id: string; provider: string; external_account_id: string; payer_tenant_id: string; shared_with_pool: boolean; enabled: boolean }
type SelectedAccount = Account & { quota_registration_key: string | null; quota_identity_hash: string | null };
interface ProviderAuthPolicyContext { actor: ProviderAuthActor; operation: FleetOperationRow; agent: Agent; account: Account }
export type ProviderAuthPolicyResolver = (client: DatabaseClient, context: ProviderAuthPolicyContext) => Promise<ProviderAuthPolicyScope>;
export interface ProviderAuthPhysicalScope extends ProviderAuthPolicyScope {
  operation_id: string; tenant_id: string; alias: string; runtime_key: string; host_scope_sha256: string; expected_external_account_id: string;
}
export interface ProviderAuthPhysicalHooks {
  stopAdapter(scope: ProviderAuthPhysicalScope, signal: AbortSignal): Promise<{ stopped: boolean }>;
  openLogin(scope: ProviderAuthPhysicalScope, signal: AbortSignal): Promise<ProviderAuthLogin>;
  verify(scope: ProviderAuthPhysicalScope, signal: AbortSignal): Promise<{ identity_matches: boolean; functional_call_verified: boolean; account_identity?: string }>;
  cleanup(scope: ProviderAuthPhysicalScope, sessionId: string, signal: AbortSignal): Promise<{ stopped: boolean }>;
}
const denied = () => new ProviderAuthError('AUTHORITY_REVOKED');

/** Provider login belongs to the fleet plane: only an owner, an administrator or the platform of the agent's company. */
async function human(client: DatabaseClient, actor: ProviderAuthActor): Promise<CompanyAuthority> {
  const match = /^console:([0-9a-f-]{36})$/u.exec(actor.subject);
  if (!match?.[1]) throw denied();
  let authority: CompanyAuthority;
  try { authority = await lockCompanyAuthority(client, { tenant: actor.tenant_id, alias: actor.alias, humanId: match[1],
    ...(actor.requestedCompany === undefined ? {} : { requestedCompany: actor.requestedCompany }) }); }
  catch (error) { if (error instanceof StoreError) throw denied(); throw error; }
  if (authority.scope !== 'company' && authority.scope !== 'platform') throw denied();
  return authority;
}
async function context(client: DatabaseClient, actor: ProviderAuthActor, request: ProviderAuthRequest, lock = false): Promise<ProviderAuthPolicyContext> {
  const authority = await human(client, actor);
  const operation = (await client.query<FleetOperationRow>(`SELECT *
    FROM fleet_operations WHERE id=$1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [request.operation_id])).rows[0];
  if (operation?.status !== 'awaiting_auth' || operation.cancel_requested || operation.target.resource !== 'agent'
      || !['create', 'update', 'start', 'restore'].includes(operation.kind)
      || operation.actor_tenant !== actor.tenant_id || operation.actor_alias !== actor.alias) throw denied();
  const initiator = (await client.query<{ subject: string | null }>(`SELECT metadata->>'actor_subject' AS subject
    FROM fleet_operation_events WHERE operation_id=$1 AND event='queued' ORDER BY id LIMIT 1`, [operation.id])).rows[0];
  if (initiator?.subject !== actor.subject) throw denied();
  const agent = (await client.query<Agent>(`SELECT * FROM agents WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 FOR SHARE`,
    [operation.target.tenant_id, operation.target.alias, authority.actingCompany])).rows[0];
  if (agent?.retired_at !== null || agent.purged_at !== null) throw denied();
  const selected = (await client.query<SelectedAccount & { consent: boolean }>(`SELECT id,provider,external_account_id,payer_tenant_id,shared_with_pool,enabled,
    quota_registration_key,quota_identity_hash,
    ${providerAccountConsentSql('provider_accounts', '$2')} AS consent FROM provider_accounts WHERE id=$1 FOR ${lock ? 'UPDATE' : 'SHARE'}`,
  [agent.primary_account_id, agent.tenant_id])).rows[0];
  const pending = selected?.quota_registration_key != null && selected.quota_identity_hash == null;
  if (!selected || !(selected.enabled || pending) || !selected.consent) throw denied();
  const { consent: _consent, quota_registration_key: _key, quota_identity_hash: _hash, ...account } = selected;
  return { actor, operation, agent, account };
}
export async function assertProviderAuthSealedScope(client: DatabaseClient, operation: FleetOperationRow,
  agent: Record<string, unknown>) {
  try {
    if (operation.target.resource !== 'agent' || operation.target.tenant_id !== agent.tenant_id || operation.target.alias !== agent.alias
        || typeof agent.host_id !== 'string' || typeof agent.runtime_key !== 'string' || operation.desired_revision === null) throw denied();
    const sealed = await loadFleetHostScope(client, operation, agent.host_id);
    const prepared = await preparedState(client, operation.id);
    const exact = selectFleetHostSlices(planFleetHostSlices(operation, sealed.agents, prepared.previous_agents), 'authenticate');
    if (sealed.placement_role === 'source') throw denied();
    await assertFleetRelocationSourceBarrier(client, operation);
    if (exact.length !== 1 || exact[0]?.target_sha256 !== sealed.target_sha256 || sealed.targets.length !== 1
        || sealed.targets[0]?.runtime_key !== agent.runtime_key) throw denied();
    const selected = sealed.agents.find(value => value.tenant_id === agent.tenant_id && value.alias === agent.alias);
    if (!selected) throw denied();
    for (const field of ['runtime_key', 'harness_id', 'host_id', 'runtime_mode', 'container_name', 'runtime_user',
      'home_directory', 'state_directory', 'systemd_user', 'primary_account_id'] as const) if (selected[field] !== agent[field]) throw denied();
    const identity = await client.query(`SELECT 1 FROM fleet_runtime_identities
      WHERE tenant_id=$1 AND alias=$2 AND runtime_key=$3 FOR SHARE`, [agent.tenant_id, agent.alias, agent.runtime_key]);
    if (identity.rowCount !== 1) throw denied();
    return sealed;
  } catch { throw denied(); }
}
export async function loadProviderAuthRoutingScope(client: DatabaseClient, actor: ProviderAuthActor, operationId: string) {
  const value = await context(client, actor, { operation_id: operationId } as ProviderAuthRequest);
  const sealed = await assertProviderAuthSealedScope(client, value.operation, value.agent);
  return { ...value, sealed };
}
async function scope(client: DatabaseClient, value: ProviderAuthPolicyContext, request: ProviderAuthRequest,
  resolve: ProviderAuthPolicyResolver): Promise<ProviderAuthPhysicalScope> {
  const policy = await resolve(client, value);
  for (const key of ['provider_id', 'account_id', 'harness_id', 'host_id', 'runtime_user', 'profile_id'] as const) {
    if (policy[key] !== request[key]) throw denied();
  }
  if (policy.account_id !== value.account.id || policy.harness_id !== value.agent.harness_id || policy.host_id !== value.agent.host_id
      || policy.runtime_user !== value.agent.runtime_user) throw denied();
  const sealed = await assertProviderAuthSealedScope(client, value.operation, value.agent);
  if (value.operation.kind === 'create' || value.operation.kind === 'update') {
    const operation = value.operation.request as { parameters?: { primary_account_id?: string; harness_id?: string; placement?: { host_id?: string; runtime_user?: string } } } | null;
    const desired = operation?.parameters;
    if (desired?.primary_account_id !== policy.account_id || desired.harness_id !== policy.harness_id
        || desired.placement?.host_id !== policy.host_id || desired.placement.runtime_user !== policy.runtime_user) throw denied();
  }
  return { ...policy, operation_id: value.operation.id, tenant_id: value.agent.tenant_id, alias: value.agent.alias,
    runtime_key: value.agent.runtime_key, host_scope_sha256: sealed.target_sha256, expected_external_account_id: value.account.external_account_id };
}
export async function resolveProviderAuthRequest(pool: DatabasePool, actor: ProviderAuthActor, operationId: string,
  resolve: ProviderAuthPolicyResolver): Promise<ProviderAuthRequest> {
  return withTransaction(pool, async client => {
    const value = await context(client, actor, { operation_id: operationId } as ProviderAuthRequest);
    const policy = await resolve(client, value);
    const request = ProviderAuthRequestSchema.parse({ ...policy, operation_id: operationId,
      expected_operation_version: Number(value.operation.version), request_id: randomUUID() });
    await scope(client, value, request, resolve);
    return request;
  });
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
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 900_000) throw new ProviderAuthError('SESSION_EXPIRED');
      const cohort = JSON.stringify([request.host_id, request.runtime_user, request.profile_id]);
      let expectedVersion = request.expected_operation_version;
      const inspect = async (client: DatabaseClient) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,783003005))', [cohort]);
        const value = await context(client, actor, request, true);
        if (Number(value.operation.version) !== expectedVersion) throw new ProviderAuthError('SESSION_CONFLICT');
        const trusted = await scope(client, value, request, resolve);
        const reservations = await client.query<{ operation_id: string; reservation: Reservation }>(`SELECT DISTINCT ON (event.operation_id)
          event.operation_id,event.metadata->'provider_auth' AS reservation FROM fleet_operation_events event
          JOIN fleet_operations operation ON operation.id=event.operation_id AND operation.company_id=$2
          WHERE event.metadata->'provider_auth'->>'cohort'=$1 ORDER BY event.operation_id,event.id DESC`, [cohort, value.agent.company_id]);
        const pending = reservations.rows.filter(prior => prior.reservation.state !== 'released');
        if (pending.some(prior => prior.reservation.state === 'releasing'
          && Date.parse(prior.reservation.release_until ?? '') > Date.now()
          || prior.reservation.state === 'reserved' && Date.parse(prior.reservation.expires_at) > Date.now())) {
          throw new ProviderAuthError('SESSION_CONFLICT');
        }
        return { trusted, pending };
      };
      const previous = await withTransaction(pool, inspect);
      for (const prior of previous.pending) {
        const released = await releaseProviderAuthReservation(pool, prior.operation_id, cohort, prior.reservation.session_id,
          () => hooks.cleanup({ ...previous.trusted, operation_id: prior.operation_id }, prior.reservation.session_id, new AbortController().signal));
        if (released && prior.operation_id === request.operation_id) expectedVersion += 1;
      }
      const physical = await withTransaction(pool, async client => {
        const { trusted, pending } = await inspect(client);
        if (pending.length > 0) throw new ProviderAuthError('SESSION_CONFLICT');
        if (expires <= Date.now()) throw new ProviderAuthError('SESSION_EXPIRED');
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
        verify: async signal => {
          await active(signal);
          const evidence = await hooks.verify(physical, signal);
          if (evidence.identity_matches && evidence.functional_call_verified) {
            if (physical.expected_external_account_id.startsWith('unverified:') && evidence.account_identity === undefined) {
              throw new ProviderAuthError('IDENTITY_MISMATCH');
            }
            await active(signal);
            await withTransaction(pool, async client => {
              const value = await context(client, actor, request, true);
              await scope(client, value, request, resolve);
              const reservation = await latest(client, request.operation_id);
              if (reservation?.session_id !== sessionId || reservation.state !== 'reserved' || Date.parse(reservation.expires_at) <= Date.now()) {
                throw new ProviderAuthError('SESSION_EXPIRED');
              }
              signal.throwIfAborted();
              if (evidence.account_identity !== undefined) {
                try { await bindProviderAccountIdentity(client, value.agent.company_id, physical.account_id, evidence.account_identity,
                  { operation_id: request.operation_id }); }
                catch (error) { if (error instanceof StoreError) throw new ProviderAuthError('IDENTITY_MISMATCH'); throw error; }
              }
              await enableProviderAccountAfterAgentAuth(pool, physical.account_id, client);
            });
          }
          return evidence;
        },
        release: async () => {
          await releaseProviderAuthReservation(pool, request.operation_id, cohort, sessionId,
            () => hooks.cleanup(physical, sessionId, new AbortController().signal));
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
