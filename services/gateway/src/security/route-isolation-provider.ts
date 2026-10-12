import { createHash, randomUUID } from 'node:crypto';
import { planFleetHostSlices, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import {
  createProviderAuthDependencies, resolveProviderAuthRequest,
  type ProviderAuthPhysicalHooks, type ProviderAuthPolicyResolver,
} from '../console/provider-auth-binding.js';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthActor, ProviderAuthService } from '../console/provider-auth.types.js';
import { createFleetProviderAuthRouter } from '../fleet/auth-router.js';
import type { IsolationCompany } from './route-isolation-fixtures.js';

const services = new WeakMap<DatabasePool, ProviderAuthService>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resolvePolicy: ProviderAuthPolicyResolver = async (_client, { account, agent }) => {
  if (account.provider !== 'codex') throw new Error('isolation provider fixture requires a Codex account');
  return { provider_id: 'codex', account_id: account.id, profile_id: account.id,
    harness_id: agent.harness_id, host_id: agent.host_id, runtime_user: agent.runtime_user };
};

export function providerAuthService(pool: DatabasePool): ProviderAuthService {
  const existing = services.get(pool);
  if (existing) return existing;
  const hooks: ProviderAuthPhysicalHooks = {
    stopAdapter: async () => ({ stopped: true }),
    openLogin: async () => ({
      method: 'terminal', subscribeOutput: () => () => undefined, start: async () => undefined,
      write: async () => undefined, resize: async () => undefined, close: async () => ({ stopped: true }),
    }),
    verify: async () => { throw new Error('physical provider verification is outside the isolation suite'); },
    cleanup: async () => ({ stopped: true }),
  };
  const manager = new ProviderAuthManager(createProviderAuthDependencies(pool, resolvePolicy, hooks), { ttlMs: 600_000 });
  const enrolled = Object.assign(manager, { resolve: (actor: ProviderAuthActor, id: string) =>
    resolveProviderAuthRequest(pool, actor, id, resolvePolicy) });
  const service = createFleetProviderAuthRouter(pool, { hosts: [], enrolled });
  services.set(pool, service);
  return service;
}

export async function seedProviderSession(pool: DatabasePool, company: IsolationCompany) {
  const target = { resource: 'agent', tenant_id: company.tenant, alias: company.alias };
  const id = randomUUID();
  const actor = { tenant_id: company.tenant, alias: company.ownerAlias, subject: `console:${company.human}` };
  const request = { kind: 'start', target, parameters: {}, expected_revision: company.revision,
    idempotency_key: `isolation-provider-${id}` };
  await pool.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,
    kind,request,request_hash,idempotency_key,expected_revision,desired_revision,status,company_id)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,'start',$8::jsonb,$9,$10,$11,$11,'awaiting_auth',$12)`,
  [id, company.tenant, company.ownerAlias, JSON.stringify(target), `agent:${company.tenant}:${company.alias}`,
    `${company.host}:dev`, company.host, JSON.stringify(request), digest(request), request.idempotency_key,
    company.revision, company.company]);
  const operation = (await pool.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [id])).rows[0];
  const agent = (await pool.query<{ agent: Record<string, unknown> }>(
    'SELECT to_jsonb(agent) AS agent FROM agents agent WHERE tenant_id=$1 AND alias=$2 AND company_id=$3',
    [company.tenant, company.alias, company.company],
  )).rows[0]?.agent;
  if (!operation || !agent) throw new Error('provider isolation fixture requires an existing company agent');
  await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)`,
    [id, JSON.stringify({ actor_subject: actor.subject, acting_company: company.company })]);
  await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_completed',$2::jsonb)`,
    [id, JSON.stringify({ step: 'prepare', prepared_revision: company.revision, fenced_targets: [target], previous_agents: [agent],
      host_slices: planFleetHostSlices(operation, [agent], [agent]), desired_memberships: [] })]);
  const service = providerAuthService(pool);
  if (!service.resolve) throw new Error('provider isolation service requires the real scope resolver');
  const providerRequest = await service.resolve(actor, id);
  const snapshot = await service.start(actor, providerRequest);
  if (snapshot.status !== 'awaiting_login') throw new Error(`provider isolation session did not open (${snapshot.status})`);
  const ticket = await service.issueSocketTicket(actor, snapshot.session_id);
  return { providerSession: snapshot.session_id, providerOperation: id, providerRequest, providerTicket: ticket.ticket,
    providerAuth: { sessionId: snapshot.session_id, ticket: ticket.ticket }, snapshot };
}
