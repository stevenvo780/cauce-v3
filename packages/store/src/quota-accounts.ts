import { randomUUID } from 'node:crypto';
import { QuotaAccountCreateSchema, QuotaAccountUpdateSchema } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { quotaObservationStatus, quotaRemaining, type QuotaObservationStatus } from './quota-state.js';

export function assertQuotaAuthority(authority: CompanyAuthority, write: boolean): void {
  if (authority.humanId === null || authority.role === 'none' || (write && !['company','platform'].includes(authority.scope))) {
    throw new StoreError('forbidden', 'company quota authority is required');
  }
}

function assertQuotaAccountWriter(authority: CompanyAuthority): void {
  assertQuotaAuthority(authority, true);
  if (!['company_owner','platform_admin'].includes(authority.role)) throw new StoreError('forbidden', 'company quota authority is required');
}

interface AccountRow {
  id: string; provider: string; label: string | null; enabled: boolean; payer_tenant_id: string;
  paused_until: Date | null; paused_reason: string | null; quota_version: string;
  agents: { tenant_id: string; alias: string; enabled: boolean }[]; agent_count: string;
}
interface WindowRow {
  account_id: string; provider: string; host: string; group_key: string; window_key: string;
  model: string | null; label: string | null; window_minutes: number | null;
  used_percent: string | null; remaining_percent: string | null; status: string | null;
  captured_at: Date; received_at: Date; reset_at: Date | null; provider_ok: boolean | null;
}
interface ReportRow { account_id: string; ok: boolean; captured_at: Date; received_at: Date; note: string | null }
export interface QuotaAccountWindow {
  group_key: string; window_key: string; model: string | null; label: string | null; host: string;
  used_percent: number | null; remaining_percent: number | null; window_minutes: number | null;
  captured_at: string; received_at: string; reset_at: string | null; observation_status: QuotaObservationStatus;
}
export interface QuotaAccountCard {
  id: string; provider: string; label: string | null; enabled: boolean; version: number; payer_tenant_id: string;
  shared: boolean; agent_count: number; agents: { tenant_id: string; alias: string; enabled: boolean }[];
  paused_until: string | null; paused_reason: string | null; observation_status: QuotaObservationStatus;
  remaining_percent: number | null; note: string | null; windows: QuotaAccountWindow[];
}

export async function quotaAccountSnapshot(client: DatabaseClient, authority: CompanyAuthority) {
  const now = new Date();
  const rows = await client.query<AccountRow>(`SELECT p.id,p.provider,p.label,p.enabled,p.payer_tenant_id,
    p.paused_until,p.paused_reason,p.quota_version::text,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('tenant_id',b.tenant_id,'alias',b.agent_alias,'enabled',b.enabled)
      ORDER BY b.tenant_id,b.agent_alias) FROM agent_account_bindings b WHERE b.account_id=p.id AND b.company_id=p.company_id
      AND ($2::text IS NULL OR b.tenant_id=$2)),'[]'::jsonb) AS agents,
    (SELECT count(*) FROM agent_account_bindings b WHERE b.account_id=p.id AND b.company_id=p.company_id)::text AS agent_count
    FROM provider_accounts p WHERE p.company_id=$1 AND p.canonical_account_id IS NULL AND ($2::text IS NULL OR p.payer_tenant_id=$2
      OR EXISTS (SELECT 1 FROM agent_account_bindings b WHERE b.account_id=p.id AND b.tenant_id=$2)) ORDER BY p.provider,p.id`,
  [authority.actingCompany, authority.scope === 'tenant' ? authority.homeTenant : null]);
  const ids = rows.rows.map(row => row.id);
  const windows = await client.query<WindowRow>(`SELECT DISTINCT ON (s.account_id,s.group_key,s.window_key,s.model_key)
    s.account_id,s.provider,s.host,s.group_key,s.window_key,s.model,s.label,s.window_minutes,s.used_percent::text,
    s.remaining_percent::text,s.status,s.captured_at,s.received_at,s.reset_at,report.ok AS provider_ok
    FROM quota_window_state s LEFT JOIN LATERAL (
      SELECT pr.ok FROM quota_provider_reports pr JOIN quota_collections qc ON qc.id=pr.collection_id
      WHERE qc.collector_tenant=s.collector_tenant AND qc.host=s.host AND pr.provider=s.provider
        AND (pr.account_id IS NULL OR pr.account_id=s.account_id)
      ORDER BY qc.captured_at DESC,qc.received_at DESC LIMIT 1) report ON true
    WHERE s.company_id=$1 AND s.account_id=ANY($2::text[])
      AND s.received_at=(SELECT latest.received_at FROM quota_window_state latest
        WHERE latest.company_id=s.company_id AND latest.account_id=s.account_id
        ORDER BY latest.captured_at DESC,latest.received_at DESC LIMIT 1)
    ORDER BY s.account_id,s.group_key,s.window_key,s.model_key,s.captured_at DESC,s.received_at DESC`, [authority.actingCompany, ids]);
  const reports = await client.query<ReportRow>(`SELECT DISTINCT ON (pr.account_id) pr.account_id,pr.ok,
    COALESCE(pr.observed_at,qc.captured_at) AS captured_at,qc.received_at,pr.note
    FROM quota_provider_reports pr JOIN quota_collections qc ON qc.id=pr.collection_id JOIN tenants t ON t.id=qc.collector_tenant
    WHERE t.company_id=$1 AND pr.account_id=ANY($2::text[]) ORDER BY pr.account_id,qc.captured_at DESC,qc.received_at DESC`,
  [authority.actingCompany, ids]);
  const accounts: QuotaAccountCard[] = rows.rows.map(row => {
    const accountWindows = windows.rows.filter(window => window.account_id === row.id).map(window => {
      const used = window.used_percent === null ? null : Number(window.used_percent);
      const remaining = quotaRemaining(window.remaining_percent === null ? null : Number(window.remaining_percent), used);
      const status = quotaObservationStatus({ receivedAt: window.received_at, capturedAt: window.captured_at, resetAt: window.reset_at, status: window.status,
        providerOk: window.provider_ok, hasValue: remaining !== null, now });
      return { group_key: window.group_key, window_key: window.window_key, model: window.model, label: window.label, host: window.host,
        window_minutes: window.window_minutes, used_percent: used, remaining_percent: status === 'ok' ? remaining : null,
        captured_at: window.captured_at.toISOString(), received_at: window.received_at.toISOString(), reset_at: window.reset_at?.toISOString() ?? null,
        observation_status: status };
    });
    const report = reports.rows.find(report => report.account_id === row.id);
    const statuses = accountWindows.map(window => window.observation_status);
    if (report !== undefined) statuses.push(quotaObservationStatus({ receivedAt: report.received_at, capturedAt: report.captured_at, resetAt: null, status: null,
      providerOk: report.ok, hasValue: accountWindows.length > 0, now }));
    const status = (['error','stale','unknown'] as const).find(candidate => statuses.includes(candidate))
      ?? (statuses.length > 0 ? 'ok' : 'unknown');
    const remaining = accountWindows.flatMap(window => window.remaining_percent === null ? [] : [window.remaining_percent]);
    return { id: row.id, provider: row.provider, label: row.label, enabled: row.enabled, version: Number(row.quota_version),
      payer_tenant_id: row.payer_tenant_id, shared: Number(row.agent_count) > 1, agent_count: Number(row.agent_count), agents: row.agents,
      paused_until: row.paused_until?.toISOString() ?? null, paused_reason: row.paused_reason,
      observation_status: status, remaining_percent: status === 'ok' && remaining.length > 0 ? Math.min(...remaining) : null,
      note: report?.note ?? null, windows: accountWindows };
  });
  return { company_id: authority.actingCompany, observed_at: now.toISOString(), accounts };
}

export async function listQuotaAccounts(pool: DatabasePool, source: CompanyAuthoritySource) {
  return withTransaction(pool, async client => {
    const authority = await source(client); assertQuotaAuthority(authority, false); return quotaAccountSnapshot(client, authority);
  });
}
export async function createQuotaAccount(pool: DatabasePool, source: CompanyAuthoritySource, value: unknown) {
  const input = QuotaAccountCreateSchema.parse(value);
  return withTransaction(pool, async client => {
    const authority = await source(client); assertQuotaAccountWriter(authority);
    await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_057, authority.actingCompany]);
    const existing = (await client.query<{ id: string; provider: string; label: string; canonical_account_id: string | null }>(
      'SELECT id,provider,label,canonical_account_id FROM provider_accounts WHERE company_id=$1 AND quota_registration_key=$2',
      [authority.actingCompany, input.idempotency_key])).rows[0];
    if (existing && (existing.provider !== input.provider || existing.label !== input.label)) throw new StoreError('conflict', 'quota account idempotency key was reused');
    const id = existing?.canonical_account_id ?? existing?.id ?? `qa_${randomUUID().replaceAll('-','')}`;
    if (!existing) await client.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
      credential_ref_kind,credential_ref,enabled,company_id,quota_registration_key)
      SELECT $1,$2,$3,tenant.id,$5,'secret_manager',$6,false,$7,$8 FROM tenants tenant
      WHERE tenant.company_id=$7 AND tenant.enabled AND tenant.retired_at IS NULL
      ORDER BY (tenant.id=$4) DESC,tenant.is_hub DESC,tenant.id LIMIT 1`,
    [id, input.provider, `unverified:${id}`, authority.homeTenant, input.label, `op:quota/${id}`, authority.actingCompany, input.idempotency_key]);
    return { account_id: id, duplicate: existing !== undefined };
  });
}
/** Authority before CAS: an account outside the acting company is absent, whatever its version. */
async function lockCompanyQuotaAccount(client: DatabaseClient, authority: CompanyAuthority, id: string): Promise<number> {
  const account = (await client.query<{ version: string }>('SELECT quota_version::text AS version FROM provider_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE',
    [id, authority.actingCompany])).rows[0];
  if (!account) throw new StoreError('not_found', 'quota account was not found');
  return Number(account.version);
}
export async function updateQuotaAccount(pool: DatabasePool, source: CompanyAuthoritySource, id: string, value: unknown) {
  const input = QuotaAccountUpdateSchema.parse(value);
  return withTransaction(pool, async client => {
    const authority = await source(client); assertQuotaAccountWriter(authority);
    await lockCompanyQuotaAccount(client, authority, id);
    if (input.enabled === true) {
      const flags = (await client.query<{ quota_registration_key: string | null; quota_identity_hash: string | null }>(
        'SELECT quota_registration_key,quota_identity_hash FROM provider_accounts WHERE id=$1 AND company_id=$2',
        [id, authority.actingCompany])).rows[0];
      if (flags?.quota_registration_key != null && flags.quota_identity_hash == null) {
        throw new StoreError('conflict', 'quota account must be authenticated before it can be enabled');
      }
    }
    if (input.paused_reason?.startsWith('quota_exhausted:')) throw new StoreError('invalid_input', 'automatic pause reasons are reserved');
    const result = await client.query(`UPDATE provider_accounts SET label=CASE WHEN $3 THEN $4 ELSE label END,
      enabled=COALESCE($5,enabled),paused_until=CASE WHEN $6 THEN $7::timestamptz ELSE paused_until END,
      paused_reason=CASE WHEN $8 THEN $9 ELSE paused_reason END,quota_version=quota_version+1,updated_at=now()
      WHERE id=$1 AND company_id=$2 AND quota_version=$10 AND canonical_account_id IS NULL
        AND ($5::boolean IS DISTINCT FROM true OR quota_registration_key IS NULL OR quota_identity_hash IS NOT NULL)
      RETURNING id`, [id, authority.actingCompany,
      input.label !== undefined, input.label ?? null, input.enabled ?? null, input.paused_until !== undefined,
      input.paused_until ?? null, input.paused_reason !== undefined, input.paused_reason ?? null, input.expected_version]);
    if (!result.rowCount) throw new StoreError('conflict', 'quota account version changed or the change is not allowed');
    return { account_id: id, version: input.expected_version + 1 };
  });
}
export async function deleteQuotaAccount(pool: DatabasePool, source: CompanyAuthoritySource, id: string, version: number) {
  return withTransaction(pool, async client => {
    const authority = await source(client); assertQuotaAccountWriter(authority);
    if (await lockCompanyQuotaAccount(client, authority, id) !== version) throw new StoreError('conflict', 'quota account version changed');
    const aliases = await client.query<{ id: string }>('SELECT id FROM provider_accounts WHERE canonical_account_id=$1 AND company_id=$2 FOR UPDATE',
      [id, authority.actingCompany]);
    const ids = [id, ...aliases.rows.map(row => row.id)];
    const dependencies = await client.query(`SELECT 1 FROM agent_account_bindings WHERE account_id=ANY($1::text[])
      UNION ALL SELECT 1 FROM alias_routing_ceiling WHERE account_id=ANY($1::text[])
      UNION ALL SELECT 1 FROM quota_environments WHERE account_id=ANY($1::text[]) AND status<>'deleted'
      UNION ALL SELECT 1 FROM agents WHERE primary_account_id=ANY($1::text[]) AND purged_at IS NULL LIMIT 1`, [ids]);
    if (dependencies.rowCount) throw new StoreError('conflict', 'remove account assignments and environments first');
    await client.query('DELETE FROM quota_window_state WHERE account_id=ANY($1::text[])', [ids]);
    await client.query('DELETE FROM quota_window_samples WHERE account_id=ANY($1::text[])', [ids]);
    await client.query('UPDATE quota_provider_reports SET account_id=NULL WHERE account_id=ANY($1::text[])', [ids]);
    await client.query('DELETE FROM quota_environment_operations WHERE environment_id IN (SELECT id FROM quota_environments WHERE account_id=ANY($1::text[]))', [ids]);
    await client.query("DELETE FROM quota_environments WHERE account_id=ANY($1::text[]) AND status='deleted'", [ids]);
    await client.query('DELETE FROM provider_accounts WHERE canonical_account_id=$1 AND company_id=$2', [id, authority.actingCompany]);
    await client.query('DELETE FROM provider_accounts WHERE id=$1 AND company_id=$2', [id, authority.actingCompany]);
    return { account_id: id, deleted: true };
  });
}
