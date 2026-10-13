import { isDeepStrictEqual } from 'node:util';
import { AliasSchema, TenantSchema, type AgentQuotaClaim, type AgentQuotaReceipt } from '@cauce/protocol';
import { lockCompanyAuthority, type CompanyAuthority } from './company-authority.js';
import type { DatabaseClient } from './db.js';
import { assertAgentQuotaAuthority, assertAgentQuotaSnapshot, type AgentQuotaSnapshot } from './agent-quota-bindings.js';
import { canonicalAgentQuotaReport } from './agent-quota-receipts.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { lockFleetRevision } from './repository/fleet-operation-authority.js';
import { StoreError } from './repository/errors.js';

export interface AgentQuotaOperationRow {
  id: string; tenant_id: string; alias: string; company_id: string; requested_by: string;
  expected_revision: string; agent_snapshot: AgentQuotaSnapshot; status: 'pending' | 'running' | 'done' | 'failed';
  receipt: AgentQuotaReceipt | null; result: { status: string; account_id?: string } | null; error_code: string | null;
  created_at: Date; updated_at: Date; claim_token: string | null; claim_epoch: number; worker_id: string | null; live: boolean;
}
export type AgentQuotaPlacement = Omit<AgentQuotaSnapshot, 'operation_id' | 'expected_revision'>;
export type AgentQuotaUnavailableReason = 'quota_reader_unavailable' | 'quota_target_unplaced';
export async function readAgentQuotaPlacement(client: DatabaseClient, authority: CompanyAuthority,
  target: { tenant_id: string; alias: string }): Promise<{ placement: AgentQuotaPlacement; reader: boolean; reason: AgentQuotaUnavailableReason | null }> {
  const tenant = TenantSchema.parse(target.tenant_id); const alias = AliasSchema.parse(target.alias);
  const row = (await client.query<AgentQuotaPlacement & { reader: boolean; harness_reader: boolean }>(`SELECT agent.company_id,agent.tenant_id,agent.alias,
    agent.harness_id,agent.host_id,agent.runtime_mode,agent.container_name,agent.runtime_user,agent.home_directory,
    agent.state_directory,agent.runtime_key,agent.systemd_user,agent.primary_account_id,
    COALESCE(agent.harness_id IN ('codex','claude','grok'),false) AS harness_reader,
    COALESCE(agent.runtime_mode='container' AND agent.harness_id IN ('codex','claude','grok') AND harness.enabled
      AND host.enabled AND agent.enabled AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
      AND agent.retired_at IS NULL AND agent.purged_at IS NULL,false) AS reader
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    LEFT JOIN harness_definitions harness ON harness.id=agent.harness_id
    LEFT JOIN fleet_hosts host ON host.host_id=agent.host_id AND host.company_id=agent.company_id
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.company_id=$3
      AND ($4::text IS NULL OR agent.tenant_id=$4) FOR SHARE OF agent,tenant`,
  [tenant, alias, authority.actingCompany, authority.scope === 'tenant' ? authority.homeTenant : null])).rows[0];
  if (!row) throw new StoreError('not_found', 'agent quota target was not found');
  const { reader, harness_reader: harnessReader, ...placement } = row;
  return { placement, reader, reason: !harnessReader ? 'quota_reader_unavailable' : !reader ? 'quota_target_unplaced' : null };
}
export async function quotaOperationAuthority(client: DatabaseClient, operation: AgentQuotaOperationRow, checkRevision = true) {
  if (checkRevision) await lockFleetRevision(client, Number(operation.expected_revision), operation.company_id);
  const person = (await client.query<{ tenant_id: string; alias: string }>('SELECT tenant_id,alias FROM console_users WHERE id=$1',
    [operation.requested_by])).rows[0];
  if (!person) throw new StoreError('forbidden', 'agent quota authority is unavailable');
  const source: CompanyAuthoritySource = db => lockCompanyAuthority(db, { tenant: person.tenant_id, alias: person.alias,
    humanId: operation.requested_by, requestedCompany: operation.company_id });
  const authority = await assertAgentQuotaAuthority(client, source);
  await assertAgentQuotaSnapshot(client, authority, operation.agent_snapshot);
  return source;
}
export function quotaClaimValues(claim: AgentQuotaClaim): (string | number)[] {
  return [claim.id, claim.claim_token, claim.claim_epoch, claim.worker_id, claim.tenant_id, claim.alias];
}
export function sameQuotaPlacement(left: AgentQuotaPlacement, right: AgentQuotaSnapshot): boolean {
  const { operation_id: _operation, expected_revision: _revision, ...placement } = right;
  return isDeepStrictEqual(left, placement);
}
export async function persistAgentQuotaObservation(client: DatabaseClient, snapshot: AgentQuotaSnapshot | AgentQuotaPlacement,
  receipt: AgentQuotaReceipt | null, accountId?: string): Promise<void> {
  const unsupported = receipt === null || receipt.status === 'unsupported';
  const sample = receipt?.status === 'measured' && accountId !== undefined ? canonicalAgentQuotaReport(receipt, accountId) : null;
  const { operation_id: _operation, expected_revision: _revision, ...placement } = snapshot as AgentQuotaSnapshot;
  await client.query(`INSERT INTO agent_quota_observations(company_id,tenant_id,alias,agent_snapshot,reader_available,status,captured_at,account_id,sample)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(tenant_id,alias) DO UPDATE
    SET agent_snapshot=EXCLUDED.agent_snapshot,reader_available=EXCLUDED.reader_available,status=EXCLUDED.status,
      captured_at=EXCLUDED.captured_at,account_id=EXCLUDED.account_id,sample=EXCLUDED.sample,updated_at=now()
    WHERE (agent_quota_observations.agent_snapshot,agent_quota_observations.reader_available,agent_quota_observations.status,
      agent_quota_observations.captured_at,agent_quota_observations.account_id,agent_quota_observations.sample)
      IS DISTINCT FROM (EXCLUDED.agent_snapshot,EXCLUDED.reader_available,EXCLUDED.status,
        EXCLUDED.captured_at,EXCLUDED.account_id,EXCLUDED.sample)`,
  [snapshot.company_id, snapshot.tenant_id, snapshot.alias, JSON.stringify(placement), !unsupported,
    unsupported ? 'unsupported' : receipt.observation_status, receipt?.captured_at ?? null, accountId ?? null, sample === null ? null : JSON.stringify(sample)]);
}
