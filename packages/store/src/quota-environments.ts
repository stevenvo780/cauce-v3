import { randomUUID } from 'node:crypto';
import { QuotaEnvironmentActionSchema, QuotaEnvironmentCreateSchema, QuotaEnvironmentUpdateSchema } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { assertQuotaAuthority } from './quota-accounts.js';
import { expireQuotaAuthentication } from './quota-auth-expiry.js';

type QuotaProvider = 'claude' | 'codex' | 'gemini' | 'grok';
type QuotaAction = 'create' | 'authenticate' | 'query' | 'update_cli' | 'delete';
export interface QuotaEnvironmentHostCapability {
  readonly host_id: string;
  readonly providers: readonly QuotaProvider[];
  readonly provider_actions: Partial<Record<QuotaProvider, readonly QuotaAction[]>>;
}
export interface QuotaEnvironmentOptions {
  readonly approvedHostIds: readonly string[];
  readonly providers: readonly QuotaProvider[];
  readonly resolveCapabilities?: (companyId: string, client: DatabaseClient) => Promise<readonly QuotaEnvironmentHostCapability[]>;
  readonly now?: () => Date;
}
export const QUOTA_ENVIRONMENT_ACTIONS: readonly QuotaAction[] = ['create','authenticate','query','update_cli','delete'];
export type QuotaEnvironmentRefreshStatus = 'fresh' | 'updating' | 'not_authenticated' | 'executor_unavailable' | 'deleted' | 'busy' | 'read_only' | 'failed' | 'stale';
export interface QuotaEnvironmentRefresh {
  environment_id: string; account_id: string; status: QuotaEnvironmentRefreshStatus;
  captured_at: string | null; operation_id: string | null;
}
interface RefreshFilter { environmentId?: string; accountIds?: readonly string[] }
export interface QuotaEnvironment {
  id: string; company_id: string; account_id: string; host_id: string; provider: string; label: string;
  status: string; version: number; created_at: string; updated_at: string;
}
export interface QuotaEnvironmentOperation {
  id: string; environment_id: string; action: string; status: string; error_code: string | null;
  result: Record<string, unknown> | null; created_at: string; updated_at: string;
}
interface EnvironmentRow extends Omit<QuotaEnvironment, 'version' | 'created_at' | 'updated_at'> {
  version: string; created_at: Date; updated_at: Date; container_name: string;
}
interface OperationRow extends Omit<QuotaEnvironmentOperation, 'created_at' | 'updated_at'> { created_at: Date; updated_at: Date }
function view(row: EnvironmentRow): QuotaEnvironment {
  return { id: row.id, company_id: row.company_id, account_id: row.account_id, host_id: row.host_id,
    provider: row.provider, label: row.label, status: row.status, version: Number(row.version),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}
function operationView(row: OperationRow): QuotaEnvironmentOperation {
  return { id: row.id, environment_id: row.environment_id, action: row.action, status: row.status, error_code: row.error_code,
    result: row.result, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}
async function owned(client: DatabaseClient, authority: CompanyAuthority, id: string): Promise<EnvironmentRow> {
  const row = (await client.query<EnvironmentRow>(`SELECT * FROM quota_environments WHERE id=$1 AND company_id=$2 FOR UPDATE`,
    [id, authority.actingCompany])).rows[0];
  if (!row) throw new StoreError('not_found', 'quota environment was not found');
  return row;
}
function withoutGemini(capabilities: readonly QuotaEnvironmentHostCapability[]): readonly QuotaEnvironmentHostCapability[] {
  return capabilities.map(host => {
    const providers = host.providers.filter(provider => provider !== 'gemini');
    if (providers.length === host.providers.length && host.provider_actions.gemini === undefined) return host;
    const provider_actions = { ...host.provider_actions };
    delete provider_actions.gemini;
    return { ...host, providers, provider_actions };
  });
}
function available(capabilities: readonly QuotaEnvironmentHostCapability[], host: string, provider: string, action: QuotaAction): void {
  if (provider === 'gemini') throw new StoreError('invalid_input', 'quota provider has no executor');
  const match = capabilities.find(value => value.host_id === host);
  if (!match?.providers.some(value => value === provider)
    || !match.provider_actions[provider as QuotaProvider]?.includes(action)) {
    throw new StoreError('conflict', 'quota executor is unavailable for this host and provider');
  }
}
async function enqueue(client: DatabaseClient, authority: CompanyAuthority, environment: EnvironmentRow,
  action: string, key: string, consent: boolean): Promise<QuotaEnvironmentOperation> {
  const existing = (await client.query<OperationRow>(`SELECT * FROM quota_environment_operations WHERE company_id=$1 AND idempotency_key=$2`,
    [authority.actingCompany, key])).rows[0];
  if (existing) {
    if (existing.environment_id !== environment.id || existing.action !== action) throw new StoreError('conflict', 'quota operation idempotency key was reused');
    return operationView(existing);
  }
  const active = await client.query(`SELECT 1 FROM quota_environment_operations WHERE environment_id=$1
    AND status IN ('pending','running','awaiting_auth')`, [environment.id]);
  if (active.rowCount) throw new StoreError('conflict', 'quota environment already has an active operation');
  const row = (await client.query<OperationRow>(`INSERT INTO quota_environment_operations(environment_id,company_id,action,idempotency_key,requested_by,consent)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [environment.id, authority.actingCompany, action, key, authority.humanId, consent])).rows[0];
  if (!row) throw new StoreError('conflict', 'quota operation could not be queued');
  return operationView(row);
}

export class QuotaEnvironmentRepository {
  constructor(private readonly pool: DatabasePool, private readonly options: QuotaEnvironmentOptions = { approvedHostIds: [], providers: [] }) {}
  private capabilities(client: DatabaseClient, companyId: string): Promise<readonly QuotaEnvironmentHostCapability[]> {
    if (!this.options.resolveCapabilities) {
      const providers = this.options.providers.filter(provider => provider !== 'gemini');
      return Promise.resolve(this.options.approvedHostIds.map(host_id => ({ host_id, providers,
        provider_actions: Object.fromEntries(providers.map(provider => [provider, QUOTA_ENVIRONMENT_ACTIONS])) })));
    }
    return this.options.resolveCapabilities(companyId, client).then(withoutGemini);
  }
  private async refreshInTransaction(client: DatabaseClient, authority: CompanyAuthority, filter: RefreshFilter): Promise<QuotaEnvironmentRefresh[]> {
    const environments = await client.query<EnvironmentRow>(`SELECT e.* FROM quota_environments e JOIN provider_accounts p ON p.id=e.account_id AND p.company_id=e.company_id
      WHERE e.company_id=$1 AND ($2::uuid IS NULL OR e.id=$2) AND ($3::text[] IS NULL OR e.account_id=ANY($3))
        AND ($4::text IS NULL OR p.payer_tenant_id=$4) ORDER BY e.id FOR UPDATE OF e`,
    [authority.actingCompany, filter.environmentId ?? null, filter.accountIds ?? null, authority.scope === 'tenant' ? authority.homeTenant : null]);
    if (filter.environmentId !== undefined && environments.rows.length === 0) throw new StoreError('not_found', 'quota environment was not found');
    if (environments.rows.length === 0) return [];
    const captures = await client.query<{ account_id: string; captured_at: Date }>(`SELECT account_id,max(captured_at) AS captured_at FROM (
      SELECT account_id,captured_at FROM quota_window_state WHERE company_id=$1 AND account_id=ANY($2::text[])
      UNION ALL SELECT pr.account_id,COALESCE((SELECT max(s.captured_at) FROM quota_window_samples s
        WHERE s.collection_id=pr.collection_id AND s.provider=pr.provider AND s.account_id=pr.account_id),pr.observed_at,qc.captured_at)
      FROM quota_provider_reports pr JOIN quota_collections qc ON qc.id=pr.collection_id JOIN tenants t ON t.id=qc.collector_tenant
      WHERE t.company_id=$1 AND pr.account_id=ANY($2::text[])) observation GROUP BY account_id`,
    [authority.actingCompany, [...new Set(environments.rows.map(row => row.account_id))]]);
    const accountCaptures = new Map(captures.rows.map(row => [row.account_id, row.captured_at]));
    const capabilities = await this.capabilities(client, authority.actingCompany);
    const now = this.options.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new StoreError('invalid_input', 'quota refresh clock is invalid');
    const refreshes: QuotaEnvironmentRefresh[] = [];
    for (const environment of environments.rows) {
      const captured = accountCaptures.get(environment.account_id) ?? null;
      const refresh: QuotaEnvironmentRefresh = { environment_id: environment.id, account_id: environment.account_id,
        status: 'failed', captured_at: captured?.toISOString() ?? null, operation_id: null };
      refreshes.push(refresh);
      if (environment.status === 'deleted' || environment.status === 'deleting') { refresh.status = 'deleted'; continue; }
      const authentication = (await client.query<OperationRow>(`SELECT * FROM quota_environment_operations
        WHERE company_id=$1 AND environment_id=$2 AND action='authenticate' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [authority.actingCompany, environment.id])).rows[0];
      if (authentication?.status !== 'done' || authentication.result?.authenticated_verified !== true
        || authentication.result.account_id !== environment.account_id) { refresh.status = 'not_authenticated'; continue; }
      const active = (await client.query<OperationRow>(`SELECT * FROM quota_environment_operations
        WHERE company_id=$1 AND environment_id=$2 AND status IN ('pending','running','awaiting_auth')`,
      [authority.actingCompany, environment.id])).rows[0];
      if (active) { refresh.status = active.action === 'query' ? 'updating' : 'busy'; refresh.operation_id = active.id; continue; }
      if (captured !== null && now.getTime() - captured.getTime() <= 600_000 && captured.getTime() <= now.getTime() + 60_000) {
        refresh.status = 'fresh'; continue;
      }
      if (!['company','platform'].includes(authority.scope)) { refresh.status = 'read_only'; continue; }
      const host = await client.query('SELECT 1 FROM fleet_hosts WHERE host_id=$1 AND company_id=$2 AND enabled FOR SHARE',
        [environment.host_id, authority.actingCompany]);
      const capability = capabilities.find(value => value.host_id === environment.host_id);
      if (!host.rowCount || !capability?.providers.includes(environment.provider as QuotaProvider)
        || !capability.provider_actions[environment.provider as QuotaProvider]?.includes('query')) {
        refresh.status = 'executor_unavailable'; continue;
      }
      const operation = await enqueue(client, authority, environment, 'query',
        `auto-query:${environment.id}:${String(Math.floor(now.getTime() / 600_000))}`, false);
      refresh.operation_id = operation.id;
      refresh.status = operation.status === 'pending' || operation.status === 'running' ? 'updating' : operation.status === 'done' ? 'stale' : 'failed';
    }
    return refreshes;
  }
  async refreshStale(source: CompanyAuthoritySource, filter: RefreshFilter = {}) {
    return withTransaction(this.pool, async client => {
      const authority = await source(client); assertQuotaAuthority(authority, false);
      await expireQuotaAuthentication(client, { companyId: authority.actingCompany });
      return { company_id: authority.actingCompany, refreshes: await this.refreshInTransaction(client, authority, filter) };
    });
  }
  async list(source: CompanyAuthoritySource, options: { refresh?: boolean } = {}) {
    return withTransaction(this.pool, async client => {
      const authority = await source(client); assertQuotaAuthority(authority, false);
      await expireQuotaAuthentication(client, { companyId: authority.actingCompany });
      const refreshes = options.refresh === true ? await this.refreshInTransaction(client, authority, {}) : [];
      const environments = await client.query<EnvironmentRow>(`SELECT e.* FROM quota_environments e JOIN provider_accounts p ON p.id=e.account_id
        WHERE e.company_id=$1 AND ($2::text IS NULL OR p.payer_tenant_id=$2) ORDER BY e.created_at,e.id`,
      [authority.actingCompany, authority.scope === 'tenant' ? authority.homeTenant : null]);
      const ids = environments.rows.map(row => row.id);
      const operations = await client.query<OperationRow>(`SELECT DISTINCT ON (environment_id) * FROM quota_environment_operations
        WHERE company_id=$1 AND environment_id=ANY($2::uuid[]) ORDER BY environment_id,created_at DESC,id DESC`, [authority.actingCompany, ids]);
      const capabilities = await this.capabilities(client, authority.actingCompany);
      const hosts = await client.query<{ host_id: string; display_name: string }>(`SELECT host_id,display_name FROM fleet_hosts
        WHERE company_id=$1 AND host_id=ANY($2::text[]) AND enabled ORDER BY host_id`, [authority.actingCompany, capabilities.map(host => host.host_id)]);
      const availableHosts = hosts.rows.flatMap(host => {
        const capability = capabilities.find(value => value.host_id === host.host_id);
        return capability && capability.providers.length > 0 ? [{ ...host, providers: capability.providers, provider_actions: capability.provider_actions }] : [];
      });
      return { company_id: authority.actingCompany, environments: environments.rows.map(row => ({ ...view(row),
        refresh_status: refreshes.find(refresh => refresh.environment_id === row.id)?.status })), operations: operations.rows.map(operationView), refreshes,
        capabilities: { available: availableHosts.length > 0, providers: [...new Set(availableHosts.flatMap(host => host.providers))],
          hosts: availableHosts, actions: [...new Set(availableHosts.flatMap(host => Object.values(host.provider_actions).flat()))] } };
    });
  }
  async create(source: CompanyAuthoritySource, value: unknown) {
    const input = QuotaEnvironmentCreateSchema.parse(value);
    return withTransaction(this.pool, async client => {
      const authority = await source(client); assertQuotaAuthority(authority, true);
      await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_057, authority.actingCompany]);
      const previous = (await client.query<EnvironmentRow>('SELECT * FROM quota_environments WHERE company_id=$1 AND idempotency_key=$2',
        [authority.actingCompany, input.idempotency_key])).rows[0];
      if (previous) {
        if (previous.account_id !== input.account_id || previous.host_id !== input.host_id || previous.label !== input.label) {
          throw new StoreError('conflict', 'quota environment idempotency key was reused');
        }
        return { environment: view(previous), operation: await enqueue(client, authority, previous, 'create', `create:${input.idempotency_key}`, false), duplicate: true };
      }
      const account = (await client.query<{ provider: string }>('SELECT provider FROM provider_accounts WHERE id=$1 AND company_id=$2 FOR SHARE',
        [input.account_id, authority.actingCompany])).rows[0];
      const host = (await client.query<{ host_id: string }>('SELECT host_id FROM fleet_hosts WHERE host_id=$1 AND company_id=$2 AND enabled FOR SHARE',
        [input.host_id, authority.actingCompany])).rows[0];
      if (!account || !host) throw new StoreError('forbidden', 'quota account or host is unavailable in the acting company');
      available(await this.capabilities(client, authority.actingCompany), input.host_id, account.provider, 'create');
      const id = randomUUID();
      const environment = (await client.query<EnvironmentRow>(`INSERT INTO quota_environments(id,company_id,account_id,host_id,provider,label,container_name,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, authority.actingCompany, input.account_id, input.host_id,
        account.provider, input.label, `cauce-quota-${id.replaceAll('-','')}`, input.idempotency_key, authority.humanId])).rows[0];
      if (!environment) throw new StoreError('conflict', 'quota environment could not be created');
      return { environment: view(environment), operation: await enqueue(client, authority, environment, 'create', `create:${input.idempotency_key}`, false), duplicate: false };
    });
  }
  async update(source: CompanyAuthoritySource, id: string, value: unknown) {
    const input = QuotaEnvironmentUpdateSchema.parse(value);
    return withTransaction(this.pool, async client => {
      const authority = await source(client); assertQuotaAuthority(authority, true);
      await expireQuotaAuthentication(client, { companyId: authority.actingCompany });
      const environment = await owned(client, authority, id);
      if (Number(environment.version) !== input.expected_version || environment.status === 'deleted') throw new StoreError('conflict', 'quota environment version changed');
      const updated = (await client.query<EnvironmentRow>(`UPDATE quota_environments SET label=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.label])).rows[0];
      if (!updated) throw new StoreError('conflict', 'quota environment changed');
      return { environment: view(updated) };
    });
  }
  async action(source: CompanyAuthoritySource, id: string, value: unknown) {
    const input = QuotaEnvironmentActionSchema.parse(value);
    if (input.idempotency_key.startsWith('auto-query:')) throw new StoreError('invalid_input', 'automatic quota refresh keys are reserved');
    return withTransaction(this.pool, async client => {
      const authority = await source(client); assertQuotaAuthority(authority, true);
      await expireQuotaAuthentication(client, { companyId: authority.actingCompany });
      const environment = await owned(client, authority, id);
      const previous = (await client.query<OperationRow>('SELECT * FROM quota_environment_operations WHERE company_id=$1 AND idempotency_key=$2',
        [authority.actingCompany, input.idempotency_key])).rows[0];
      if (previous) return { environment: view(environment), operation: await enqueue(client, authority, environment, input.action, input.idempotency_key, input.consent === true) };
      if (Number(environment.version) !== input.expected_version || environment.status === 'deleted') throw new StoreError('conflict', 'quota environment version changed');
      available(await this.capabilities(client, authority.actingCompany), environment.host_id, environment.provider, input.action);
      const operation = await enqueue(client, authority, environment, input.action, input.idempotency_key, input.consent === true);
      return { environment: view(environment), operation };
    });
  }
}
