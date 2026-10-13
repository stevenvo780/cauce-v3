import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentQuotaClaimSchema, AgentQuotaExecutionSchema, AgentQuotaFailureCodeSchema, AgentQuotaQuerySchema,
  type AgentQuotaClaim, type AgentQuotaFailureCode, type QuotaProviderReportSchema } from '@cauce/protocol';
import type { z } from 'zod';
import { companyRevision } from './company-authority.js';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { assertQuotaAuthority } from './quota-accounts.js';
import { assertAgentQuotaAuthority, bindAgentQuotaSample, type AgentQuotaSnapshot } from './agent-quota-bindings.js';
import { agentQuotaHost, agentQuotaReceipt } from './agent-quota-receipts.js';
import { persistAgentQuotaObservation, quotaClaimValues, quotaOperationAuthority,
  readAgentQuotaPlacement, sameQuotaPlacement, type AgentQuotaOperationRow, type AgentQuotaPlacement } from './agent-quota-operations-model.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { lockFleetRevision } from './repository/fleet-operation-authority.js';
import { FleetOperationError } from './repository/fleet-operation-contracts.js';
import { StoreError } from './repository/errors.js';

type QuotaReport = z.infer<typeof QuotaProviderReportSchema>;
interface Observation { agent_snapshot: AgentQuotaPlacement; reader_available: boolean; status: 'unsupported' | 'ok' | 'error';
  captured_at: Date | null; account_id: string | null; sample: QuotaReport | null }
function leaseValid(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new StoreError('invalid_input', 'agent quota lease is invalid');
}
function operationCard(operation: AgentQuotaOperationRow) {
  return { id: operation.id, status: operation.status, error_code: operation.error_code,
    created_at: operation.created_at.toISOString(), updated_at: operation.updated_at.toISOString() };
}
export class AgentQuotaInvalidatedError extends StoreError {
  constructor() { super('conflict', 'agent quota execution authority or placement changed'); }
}
export class AgentQuotaHostUnavailableError extends StoreError {
  constructor() { super('conflict', 'agent quota host executor is unavailable'); }
}
export class AgentQuotaOperationsRepository {
  constructor(private readonly pool: DatabasePool, private readonly transactionClient?: DatabaseClient) {}
  forTransaction(client: DatabaseClient): AgentQuotaOperationsRepository { return new AgentQuotaOperationsRepository(this.pool, client); }
  private transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return this.transactionClient === undefined ? withTransaction(this.pool, work) : work(this.transactionClient);
  }
  private async hostAvailable(client: DatabaseClient, placement: AgentQuotaPlacement): Promise<boolean> {
    const capability = await client.query(`SELECT 1 FROM fleet_host_identities identity JOIN fleet_hosts host
      ON host.host_id=identity.host_id AND host.company_id=identity.company_id
      WHERE identity.host_id=$1 AND identity.company_id=$2 AND identity.enabled AND host.enabled
        AND identity.capabilities_seen_at>now()-interval '120 seconds'
        AND identity.capabilities->>'fleet_executor'='true'`, [placement.host_id, placement.company_id]);
    return Boolean(capability.rowCount);
  }
  async snapshot(source: CompanyAuthoritySource, target: { tenant_id: string; alias: string }) {
    return this.transaction(async client => {
      const authority = await source(client); assertQuotaAuthority(authority, false);
      const { placement, reader, reason } = await readAgentQuotaPlacement(client, authority, target);
      const revision = await companyRevision(client, authority.actingCompany);
      if (!reader) await persistAgentQuotaObservation(client, placement, null);
      const stored = (await client.query<Observation>('SELECT * FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2 AND company_id=$3',
        [target.tenant_id, target.alias, authority.actingCompany])).rows[0];
      const observation = stored && isDeepStrictEqual(stored.agent_snapshot, placement)
        && !(reader && stored.status === 'unsupported' && stored.captured_at === null) ? stored : undefined;
      const operation = (await client.query<AgentQuotaOperationRow & { expired: boolean }>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM agent_quota_operations WHERE tenant_id=$1 AND alias=$2
        AND company_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1`, [target.tenant_id, target.alias, authority.actingCompany])).rows[0];
      const legacy = observation === undefined && reader ? await this.lastSample(client, placement) : null;
      const sample = observation?.sample ?? legacy?.sample ?? null;
      const accountId = observation?.account_id ?? legacy?.account_id ?? null;
      const binding = (await client.query<{ account_id: string; enabled: boolean; shared: boolean; agent_count: number }>(
        `SELECT binding.account_id,binding.enabled,(SELECT count(*)>1 FROM agent_account_bindings peer
          WHERE peer.account_id=binding.account_id AND peer.company_id=binding.company_id) AS shared,
          (SELECT count(*)::int FROM agent_account_bindings peer WHERE peer.account_id=binding.account_id
            AND peer.company_id=binding.company_id) AS agent_count
         FROM agent_account_bindings binding WHERE binding.tenant_id=$1 AND binding.agent_alias=$2
           AND binding.company_id=$3 AND binding.account_id=$4`, [target.tenant_id, target.alias, authority.actingCompany, accountId])).rows[0] ?? null;
      const available = reader;
      const hostAvailable = !available || await this.hostAvailable(client, placement);
      let canQuery = available && hostAvailable;
      if (canQuery) {
        try { await assertAgentQuotaAuthority(client, async () => authority); }
        catch (error) { if (!(error instanceof StoreError)) throw error; canQuery = false; }
      }
      let activeOperation = operation && sameQuotaPlacement(placement, operation.agent_snapshot) ? operation : undefined;
      if (activeOperation?.expired && (activeOperation.status === 'pending' || activeOperation.status === 'running')) {
        activeOperation = { ...activeOperation, status: 'failed', error_code: 'EXPIRED' };
      }
      const status = !available ? 'unsupported' as const
        : activeOperation?.status === 'pending' || activeOperation?.status === 'running' ? activeOperation.status
        : activeOperation?.status === 'failed' ? 'failed' as const : observation?.status ?? (sample ? sample.ok ? 'ok' as const : 'error' as const : 'unknown' as const);
      return { tenant_id: target.tenant_id, alias: target.alias, revision, configuration_revision: revision,
        reader_available: available, can_query: canQuery,
        reason: available && !hostAvailable ? 'quota_host_unavailable' as const : reason, status,
        captured_at: observation?.captured_at?.toISOString() ?? legacy?.captured_at.toISOString() ?? null,
        binding, sample, operation: activeOperation ? operationCard(activeOperation) : null };
    });
  }
  private async lastSample(client: DatabaseClient, placement: AgentQuotaPlacement) {
    return (await client.query<{ account_id: string; captured_at: Date; sample: QuotaReport }>(`SELECT report.account_id,collection.captured_at,
      jsonb_build_object('provider',report.provider,'ok',report.ok,'available',report.available,
        'note',report.note,'effective_remaining_percent',report.effective_remaining_percent,'account_id',report.account_id,
        'observed_at',report.observed_at,'available_groups',report.available_groups,'limiting_groups',report.limiting_groups,
        'windows',COALESCE((SELECT jsonb_agg(jsonb_build_object('group_key',sample_window.group_key,'window_key',sample_window.window_key,
          'used_percent',sample_window.used_percent,'remaining_percent',sample_window.remaining_percent,'used_units',sample_window.used_units,
          'limit_units',sample_window.limit_units,'window_minutes',sample_window.window_minutes,'reset_at',sample_window.reset_at,'status',sample_window.status,
          'account_id',sample_window.account_id)) FROM quota_window_samples sample_window WHERE sample_window.collection_id=collection.id
            AND sample_window.provider=report.provider),'[]'::jsonb)) AS sample
      FROM quota_collections collection JOIN quota_provider_reports report ON report.collection_id=collection.id
      JOIN provider_accounts account ON account.id=report.account_id AND account.company_id=$4
      WHERE collection.collector_tenant=$1 AND collection.collector_alias=$2 AND collection.host=$3 AND report.provider=$5
      ORDER BY collection.captured_at DESC,collection.received_at DESC LIMIT 1`,
    [placement.tenant_id, placement.alias, agentQuotaHost(placement as AgentQuotaSnapshot), placement.company_id, placement.harness_id])).rows[0] ?? null;
  }
  async enqueue(source: CompanyAuthoritySource, value: { tenant_id: string; alias: string; expected_revision: number; idempotency_key: string }) {
    const input = AgentQuotaQuerySchema.parse({ expected_revision: value.expected_revision, idempotency_key: value.idempotency_key });
    return this.transaction(async client => {
      await lockFleetRevision(client);
      const authority = await assertAgentQuotaAuthority(client, source);
      const { placement, reader } = await readAgentQuotaPlacement(client, authority, value);
      await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_070, authority.actingCompany]);
      const operations = (await client.query<AgentQuotaOperationRow & { expired: boolean }>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM agent_quota_operations
        WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 AND status IN ('pending','running') FOR UPDATE`,
      [value.tenant_id, value.alias, authority.actingCompany])).rows;
      for (const operation of operations) {
        const code = !sameQuotaPlacement(placement, operation.agent_snapshot) ? 'SCOPE_CHANGED' : operation.expired ? 'EXPIRED' : null;
        if (code !== null) {
          await client.query("UPDATE agent_quota_operations SET status='failed',error_code=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [operation.id, code]);
        }
      }
      const previous = (await client.query<AgentQuotaOperationRow>('SELECT * FROM agent_quota_operations WHERE company_id=$1 AND idempotency_key=$2',
        [authority.actingCompany, input.idempotency_key])).rows[0];
      if (previous) {
        if (previous.tenant_id !== value.tenant_id || previous.alias !== value.alias || Number(previous.expected_revision) !== input.expected_revision
          || previous.requested_by !== authority.humanId) throw new StoreError('conflict', 'agent quota idempotency key was reused');
        return { operation_id: previous.id, id: previous.id, status: previous.status, duplicate: true };
      }
      await lockFleetRevision(client, input.expected_revision, authority.actingCompany);
      if (!reader) { await persistAgentQuotaObservation(client, placement, null); return { operation_id: null, id: null, status: 'unsupported' as const, duplicate: false }; }
      if (!await this.hostAvailable(client, placement)) throw new AgentQuotaHostUnavailableError();
      const active = await client.query("SELECT 1 FROM agent_quota_operations WHERE tenant_id=$1 AND alias=$2 AND status IN ('pending','running')",
        [value.tenant_id, value.alias]);
      if (active.rowCount) throw new StoreError('conflict', 'an agent quota operation is already active');
      const id = randomUUID(); const snapshot = { ...placement, operation_id: id, expected_revision: input.expected_revision };
      AgentQuotaExecutionSchema.parse({ operation_id: id, action: 'query', agent: snapshot });
      await client.query(`INSERT INTO agent_quota_operations(id,company_id,tenant_id,alias,host_id,requested_by,expected_revision,idempotency_key,agent_snapshot,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,clock_timestamp()+interval '5 minutes')`, [id, authority.actingCompany, value.tenant_id, value.alias, placement.host_id,
      authority.humanId, input.expected_revision, input.idempotency_key, JSON.stringify(snapshot)]);
      return { operation_id: id, id, status: 'pending' as const, duplicate: false };
    });
  }
  async assertHostScopeInTransaction(client: DatabaseClient, claim: AgentQuotaClaim,
    scope: { host_id: string; company_id: string; allowTerminal?: boolean }): Promise<void> {
    AgentQuotaClaimSchema.parse(claim);
    await lockFleetRevision(client);
    const result = await client.query(`SELECT 1 FROM agent_quota_operations WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3
      AND worker_id=$4 AND tenant_id=$5 AND alias=$6 AND host_id=$7 AND company_id=$8
      AND (status='running' AND lease_until>now() AND expires_at>clock_timestamp() OR $9 AND status IN ('done','failed')) FOR SHARE`,
    [...quotaClaimValues(claim), scope.host_id, scope.company_id, scope.allowTerminal === true]);
    if (!result.rowCount) throw new StoreError('forbidden', 'agent quota operation is outside the authenticated host scope');
  }
  private async retainAuthority(client: DatabaseClient, operation: AgentQuotaOperationRow, terminal = false) {
    try { return await quotaOperationAuthority(client, operation, !terminal); } catch (error) {
      if (!(error instanceof StoreError) && !(error instanceof FleetOperationError)) throw error;
      if (terminal) throw error;
      await client.query("UPDATE agent_quota_operations SET status='failed',error_code=$2,lease_until=NULL,updated_at=now() WHERE id=$1",
        [operation.id, error.code === 'forbidden' ? 'AUTHORITY_REVOKED' : 'SCOPE_CHANGED']);
      return null;
    }
  }
  async claim(worker: string, host: string, leaseMs = 30_000, company?: string): Promise<AgentQuotaClaim | null> {
    leaseValid(leaseMs);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(worker) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(host)) throw new StoreError('invalid_input', 'agent quota worker is invalid');
    return this.transaction(async client => {
      const candidate = await client.query(`SELECT 1 FROM agent_quota_operations WHERE host_id=$1
        AND ($2::text IS NULL OR company_id=$2) AND expires_at>clock_timestamp() AND (status='pending' OR status='running' AND lease_until<now()) LIMIT 1`, [host, company ?? null]);
      if (!candidate.rowCount) return null;
      await lockFleetRevision(client);
      const row = (await client.query<AgentQuotaOperationRow>(`SELECT * FROM agent_quota_operations WHERE host_id=$1
        AND ($2::text IS NULL OR company_id=$2) AND expires_at>clock_timestamp() AND (status='pending' OR status='running' AND lease_until<now())
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [host, company ?? null])).rows[0];
      if (!row || await this.retainAuthority(client, row) === null) return null;
      return (await client.query<AgentQuotaClaim>(`UPDATE agent_quota_operations SET status='running',claim_token=gen_random_uuid(),
        claim_epoch=claim_epoch+1,worker_id=$2,lease_until=now()+($3::double precision*interval '1 millisecond'),updated_at=now()
        WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id,tenant_id,alias,claim_token,claim_epoch::int,worker_id`, [row.id, worker, leaseMs])).rows[0] ?? null;
    });
  }
  private async lockClaim(client: DatabaseClient, claim: AgentQuotaClaim, terminal = false): Promise<AgentQuotaOperationRow> {
    AgentQuotaClaimSchema.parse(claim);
    await lockFleetRevision(client);
    const row = (await client.query<AgentQuotaOperationRow>(`SELECT *,lease_until>now() AS live FROM agent_quota_operations
      WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3 AND worker_id=$4 AND tenant_id=$5 AND alias=$6
        AND (status='running' AND lease_until>now() AND expires_at>clock_timestamp() OR $7 AND status IN ('done','failed')) FOR UPDATE`,
    [...quotaClaimValues(claim), terminal])).rows[0];
    if (!row) throw new StoreError('conflict', 'agent quota execution lease was replaced');
    return row;
  }
  async renew(claim: AgentQuotaClaim, leaseMs = 30_000): Promise<boolean> {
    leaseValid(leaseMs);
    return this.transaction(async client => {
      let row: AgentQuotaOperationRow;
      try { row = await this.lockClaim(client, claim); } catch (error) { if (error instanceof StoreError) return false; throw error; }
      if (await this.retainAuthority(client, row) === null) return false;
      const renewed = await client.query("UPDATE agent_quota_operations SET lease_until=now()+($2::double precision*interval '1 millisecond'),updated_at=now() WHERE id=$1 AND expires_at>clock_timestamp()",
        [claim.id, leaseMs]); return renewed.rowCount === 1;
    });
  }
  async execution(claim: AgentQuotaClaim) {
    const result = await this.transaction(async client => {
      const operation = await this.lockClaim(client, claim);
      if (await this.retainAuthority(client, operation) === null) return null;
      return AgentQuotaExecutionSchema.parse({ operation_id: operation.id, action: 'query', agent: operation.agent_snapshot });
    });
    if (result === null) throw new AgentQuotaInvalidatedError();
    return result;
  }
  async finish(claim: AgentQuotaClaim, value: unknown) {
    const result = await this.transaction(async client => {
      const operation = await this.lockClaim(client, claim, true);
      const receipt = agentQuotaReceipt(operation.agent_snapshot, value);
      if (operation.status === 'done') {
        await this.retainAuthority(client, operation, true);
        if (!isDeepStrictEqual(operation.receipt, receipt)) throw new StoreError('conflict', 'agent quota terminal receipt differs');
        return { operation_id: claim.id, status: 'done' as const, result: operation.result };
      }
      if (operation.status !== 'running') throw new StoreError('conflict', 'agent quota operation failed');
      const source = await this.retainAuthority(client, operation);
      if (source === null) return null;
      const binding = await bindAgentQuotaSample(client, this.pool, source, operation.agent_snapshot, receipt);
      await persistAgentQuotaObservation(client, operation.agent_snapshot, receipt, binding.status === 'measured' ? binding.account_id : undefined);
      const finished = await client.query("UPDATE agent_quota_operations SET status='done',receipt=$2::jsonb,result=$3::jsonb,lease_until=NULL,updated_at=now() WHERE id=$1 AND expires_at>clock_timestamp()",
        [claim.id, JSON.stringify(receipt), JSON.stringify(binding)]);
      if (finished.rowCount !== 1) throw new StoreError('conflict', 'agent quota operation expired');
      return { operation_id: claim.id, status: 'done' as const, result: binding };
    });
    if (result === null) throw new AgentQuotaInvalidatedError();
    return result;
  }
  async fail(claim: AgentQuotaClaim, code: AgentQuotaFailureCode): Promise<void> {
    AgentQuotaFailureCodeSchema.parse(code);
    const result = await this.transaction(async client => {
      const operation = await this.lockClaim(client, claim, true);
      if (operation.status === 'failed' && operation.error_code === code) { await this.retainAuthority(client, operation, true); return true; }
      if (operation.status !== 'running') throw new StoreError('conflict', 'agent quota terminal failure differs');
      if (await this.retainAuthority(client, operation) === null) return false;
      const failed = await client.query("UPDATE agent_quota_operations SET status='failed',error_code=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND expires_at>clock_timestamp()", [claim.id, code]);
      if (failed.rowCount !== 1) throw new StoreError('conflict', 'agent quota operation expired');
      return true;
    });
    if (!result) throw new AgentQuotaInvalidatedError();
  }
}
