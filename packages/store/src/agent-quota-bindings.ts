import { randomUUID } from 'node:crypto';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import { lockConsoleHuman } from './human-identity.js';
import { assertQuotaAuthority } from './quota-accounts.js';
import { CauceRepository } from './repository.js';
import { lockFleetRevision } from './repository/fleet-operation-authority.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { agentQuotaReceipt, agentQuotaHost, findAgentQuotaAccount, assertAgentQuotaReplay, canonicalAgentQuotaReport } from './agent-quota-receipts.js';

export interface AgentQuotaSnapshot {
  operation_id: string; expected_revision: number; company_id: string; tenant_id: string; alias: string;
  harness_id: string; host_id: string; runtime_mode: 'container' | 'native'; container_name: string;
  runtime_user: string; home_directory: string; state_directory: string;
  runtime_key: string; systemd_user: string | null; primary_account_id: string | null;
}
export type AgentQuotaBindingResult =
  | { status: 'measured'; account_id: string; duplicate: boolean; captured_at: string }
  | { status: 'unsupported'; reason: 'quota_reader_unavailable' };
export async function assertAgentQuotaAuthority(client: DatabaseClient, source: CompanyAuthoritySource): Promise<CompanyAuthority> {
  const authority = await source(client); assertQuotaAuthority(authority, true);
  if (authority.humanId === null) throw new StoreError('forbidden', 'agent quota human authority is required');
  const person = await lockConsoleHuman(client, authority.humanId);
  if (person.account.defaultTenant !== authority.homeTenant || person.account.actorAlias !== authority.alias
    || person.membership.actorAlias !== authority.alias || person.membership.role !== 'operator'
    || !person.membership.permissions.includes('read') || !person.membership.permissions.includes('control')) {
    throw new StoreError('forbidden', 'agent quota human authority is unavailable');
  }
  return authority;
}
export async function assertAgentQuotaSnapshot(client: DatabaseClient, authority: CompanyAuthority, snapshot: AgentQuotaSnapshot): Promise<void> {
  const agent = (await client.query<Omit<AgentQuotaSnapshot, 'operation_id' | 'expected_revision'> & { active: boolean }>(
    `SELECT agent.company_id,agent.tenant_id,agent.alias,agent.harness_id,agent.host_id,agent.runtime_mode,
      agent.container_name,agent.runtime_user,agent.home_directory,agent.state_directory,agent.runtime_key,
      agent.systemd_user,agent.primary_account_id,tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
        AND agent.retired_at IS NULL AND agent.purged_at IS NULL AND host.enabled AS active
     FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
     JOIN fleet_hosts host ON host.host_id=agent.host_id AND host.company_id=agent.company_id
     WHERE agent.tenant_id=$1 AND agent.alias=$2 FOR SHARE OF agent,tenant,host`, [snapshot.tenant_id, snapshot.alias])).rows[0];
  if (snapshot.company_id !== authority.actingCompany || agent?.company_id !== authority.actingCompany) {
    throw new StoreError('forbidden', 'agent quota target is outside the acting company');
  }
  const placementFields = ['company_id', 'tenant_id', 'alias', 'harness_id', 'host_id', 'runtime_mode', 'container_name',
    'runtime_user', 'home_directory', 'state_directory', 'runtime_key', 'systemd_user', 'primary_account_id'] as const;
  if (!agent.active || placementFields.some(key => agent[key] !== snapshot[key])) {
    throw new StoreError('conflict', 'agent quota placement changed');
  }
}
/** The caller owns the transaction, verified host channel and fenced execution receipt. */
export async function bindAgentQuotaSample(client: DatabaseClient, pool: DatabasePool, source: CompanyAuthoritySource,
  snapshot: AgentQuotaSnapshot, receiptValue: unknown): Promise<AgentQuotaBindingResult> {
  if (!Number.isSafeInteger(snapshot.expected_revision) || snapshot.expected_revision < 0 || snapshot.runtime_mode !== 'container'
    || typeof snapshot.runtime_key !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(snapshot.runtime_key)) {
    throw new StoreError('invalid_input', 'agent quota snapshot is invalid');
  }
  await lockFleetRevision(client, snapshot.expected_revision, snapshot.company_id);
  const authority = await assertAgentQuotaAuthority(client, source);
  await assertAgentQuotaSnapshot(client, authority, snapshot);
  const receipt = agentQuotaReceipt(snapshot, receiptValue);
  if (receipt.status === 'unsupported') return { status: 'unsupported', reason: receipt.reason };
  const host = agentQuotaHost(snapshot);
  await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_057, `${authority.actingCompany}/${receipt.identity_hash}`]);
  const account = await findAgentQuotaAccount(client, authority.actingCompany, receipt);
  if (snapshot.primary_account_id !== null && account?.id !== snapshot.primary_account_id) {
    throw new StoreError('conflict', 'measured quota identity does not match the agent credential');
  }
  const duplicate = await assertAgentQuotaReplay(client, snapshot, host, receipt, account?.id);
  const id = account?.id ?? `qa_${randomUUID().replaceAll('-', '')}`;
  const report = canonicalAgentQuotaReport(receipt, id);
  if (account && account.payer_tenant_id !== snapshot.tenant_id && !account.shared_with_pool) {
    throw new StoreError('conflict', 'agent quota account has no payer pool consent');
  }
  if (!account) await client.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
    credential_ref_kind,credential_ref,shared_with_pool,enabled,company_id,quota_identity_hash)
    VALUES($1,$2,$3,$4,$5,'secret_manager',$6,false,false,$7,$8)`,
  [id, receipt.provider, `unverified:${id}`, snapshot.tenant_id, snapshot.alias, `op:quota/${id}`, authority.actingCompany, receipt.identity_hash]);
  else if (account.quota_identity_hash === null) await client.query(`UPDATE provider_accounts SET quota_identity_hash=$2,
    quota_version=quota_version+1,updated_at=now() WHERE id=$1`, [id, receipt.identity_hash]);
  await client.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant,company_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,alias,account_id) DO NOTHING`,
  [snapshot.tenant_id, snapshot.alias, id, account?.payer_tenant_id ?? snapshot.tenant_id, authority.homeTenant, authority.actingCompany]);
  const credential = account !== undefined && (account.id === snapshot.primary_account_id
    || !account.external_account_id.startsWith('unverified:'));
  await client.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,enabled,company_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,agent_alias,account_id) DO NOTHING`,
  [snapshot.tenant_id, snapshot.alias, id, credential, authority.actingCompany]);
  if (!duplicate) await new CauceRepository(pool).recordQuotaSample(TenantSchema.parse(snapshot.tenant_id), AliasSchema.parse(snapshot.alias), {
    host, captured_at: receipt.captured_at, schema_version: 2, providers: [report],
  }, client);
  return { status: 'measured', account_id: id, duplicate, captured_at: receipt.captured_at };
}
