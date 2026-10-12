import { createHash } from 'node:crypto';
import type { DatabasePool } from '@cauce/store';
import { ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import { decodeTerminalSubject } from '../terminal/authority-continuity.js';
import { relayClaimEpoch } from '../terminal/relay-proxy/claim-transition.js';
import type { IsolationCompany } from './route-isolation-fixtures.js';

export interface CanaryValidation { checkedFields: string[]; unverifiableFields: string[] }
interface CanaryOptions { requireCanaryNames?: boolean }
type Check = (field: string, sql: string, values: unknown[]) => Promise<void>;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function validateShape(value: unknown, side: string): asserts value is IsolationCompany {
  if (value === null || typeof value !== 'object') throw new Error(`canary ${side} fixture must be an object`);
  const record = value as Record<string, unknown>;
  for (const field of ['company', 'tenant', 'alias', 'ownerAlias', 'human', 'email', 'password', 'room', 'host', 'invitation',
    'account', 'environment', 'quotaOperation', 'backup', 'message', 'delivery', 'blob', 'operation', 'session', 'trace',
    'gate', 'homeDirectory', 'stateDirectory', 'contextRepositoryPath', 'contextCommit', 'nativePiece', 'nativeOperation',
    'dlq', 'dlqEvidence', 'egressDestination']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) throw new Error(`canary ${side}.${field} must be a nonempty string`);
  }
  for (const field of ['contextVersion', 'revision']) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 1) throw new Error(`canary ${side}.${field} must be a positive safe integer`);
  }
  if (!Array.isArray(record.privateSentinels) || record.privateSentinels.length === 0
    || record.privateSentinels.some((sentinel: unknown) => typeof sentinel !== 'string' || sentinel.length <= 12)) {
    throw new Error(`canary ${side}.privateSentinels must contain private strings longer than twelve characters`);
  }
}

async function validateResources(check: Check, company: IsolationCompany): Promise<void> {
  const { company: id, tenant, alias, human } = company;
  await check('company', 'SELECT 1 FROM companies WHERE id=$1 AND enabled AND retired_at IS NULL', [id]);
  await check('tenant', 'SELECT 1 FROM tenants WHERE id=$1 AND company_id=$2 AND enabled', [tenant, id]);
  await check('human', `SELECT 1 FROM console_users person JOIN company_admins admin ON admin.human_id=person.id
    WHERE person.id::text=$1 AND person.company_id=$2 AND admin.company_id=$2 AND admin.role='owner'
      AND person.active AND person.role='operator' AND person.tenant_id=$3 AND person.alias=$4 AND person.email=$5`,
  [human, id, tenant, company.ownerAlias, company.email]);
  await check('ownerAlias', `SELECT 1 FROM human_tenant_memberships WHERE human_id::text=$1 AND company_id=$2
    AND tenant_id=$3 AND actor_alias=$4 AND role='operator' AND enabled AND revoked_at IS NULL AND 'control'=ANY(permissions)`,
  [human, id, tenant, company.ownerAlias]);
  await check('alias', `SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 AND retired_at IS NULL
    AND host_id=$4 AND home_directory=$5 AND state_directory=$6`,
  [tenant, alias, id, company.host, company.homeDirectory, company.stateDirectory]);
  await check('room', 'SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2 AND company_id=$3 AND enabled', [tenant, company.room, id]);
  await check('host', 'SELECT 1 FROM fleet_hosts WHERE host_id=$1 AND company_id=$2 AND enabled', [company.host, id]);
  await check('invitation', `SELECT 1 FROM fleet_host_enrollments WHERE id::text=$1 AND company_id=$2
    AND invited_by::text=$3 AND state='pending' AND expires_at>now()`, [company.invitation, id, human]);
  await check('account', `SELECT 1 FROM provider_accounts WHERE id=$1 AND company_id=$2 AND payer_tenant_id=$3 AND enabled`,
    [company.account, id, tenant]);
  await check('environment', `SELECT 1 FROM quota_environments WHERE id::text=$1 AND company_id=$2
    AND account_id=$3 AND host_id=$4 AND status<>'deleted'`, [company.environment, id, company.account, company.host]);
  await check('quotaOperation', `SELECT 1 FROM quota_environment_operations WHERE id::text=$1 AND company_id=$2
    AND environment_id::text=$3 AND requested_by::text=$4`, [company.quotaOperation, id, company.environment, human]);
  await check('backup', `SELECT 1 FROM space_backups WHERE id::text=$1 AND company_id=$2 AND tenant_id=$3 AND alias=$4
    AND host_id=$5 AND requested_by::text=$6 AND status='ready' AND expires_at>now() AND bytes>0 AND received_bytes=bytes`,
  [company.backup, id, tenant, alias, company.host, human]);
  await check('contextVersion', `SELECT 1 FROM agent_context_versions WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`,
    [id, tenant, alias, company.contextVersion]);
  await check('message', `SELECT 1 FROM messages WHERE id::text=$1 AND tenant_id=$2 AND room_id=$3 AND trace_id=$4`,
    [company.message, tenant, company.room, company.trace]);
  await check('delivery', `SELECT 1 FROM deliveries WHERE id::text=$1 AND message_id::text=$2 AND recipient_tenant=$3 AND recipient_alias=$4`,
    [company.delivery, company.message, tenant, alias]);
  await check('blob', `SELECT 1 FROM blobs WHERE sha256=$1 AND tenant_id=$2 AND bytes>0`, [company.blob, tenant]);
  await check('gate', `SELECT 1 FROM agent_chain_gates WHERE id::text=$1 AND tenant_id=$2 AND root_message_id::text=$3
    AND source_delivery_id::text=$4 AND trace_id=$5 AND asked_by_alias=$6`,
  [company.gate, tenant, company.message, company.delivery, company.trace, alias]);
  await check('operation', `SELECT 1 FROM fleet_operations WHERE id::text=$1 AND company_id=$2
    AND target->>'tenant_id'=$3 AND target->>'alias'=$4 AND executor_host=$5`, [company.operation, id, tenant, alias, company.host]);
  await check('revision', `SELECT 1 FROM config_revisions WHERE id=$1 AND company_id=$2 AND scope='company' AND actor_human_id::text=$3`,
    [company.revision, id, human]);
  await check('nativeOperation', `SELECT 1 FROM jobs WHERE id::text=$1 AND tenant_id=$2
    AND kind='system.context.write.quarantine.v1' AND payload->>'alias'=$3`, [company.nativeOperation, tenant, alias]);
  await check('dlq', `SELECT 1 FROM dead_letters WHERE id::text=$1 AND tenant_id=$2 AND delivery_id::text=$3 AND evidence_sha256=$4`,
    [company.dlq, tenant, company.delivery, company.dlqEvidence]);
  await check('egressDestination', `SELECT 1 FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3 AND enabled`,
    [tenant, company.ownerAlias, company.egressDestination]);
  for (const [index, sentinel] of company.privateSentinels.entries()) {
    await check(`privateSentinels[${String(index)}]`, `SELECT 1 WHERE
      EXISTS(SELECT 1 FROM messages message JOIN tenants tenant ON tenant.id=message.tenant_id
        WHERE tenant.company_id=$1 AND position($2 in message.body::text)>0)
      OR EXISTS(SELECT 1 FROM agent_context_versions WHERE company_id=$1 AND position($2 in files::text)>0)
      OR EXISTS(SELECT 1 FROM agent_chain_gates gate JOIN tenants tenant ON tenant.id=gate.tenant_id
        WHERE tenant.company_id=$1 AND position($2 in gate.question)>0)
      OR EXISTS(SELECT 1 FROM blobs blob JOIN tenants tenant ON tenant.id=blob.tenant_id
        WHERE tenant.company_id=$1 AND blob.sha256=$3)`, [id, sentinel, digest(sentinel)]);
  }
}

async function validateTerminal(pool: DatabasePool, check: Check, company: IsolationCompany, side: string,
  result: CanaryValidation): Promise<void> {
  await check('session', `SELECT 1 FROM terminal_sessions WHERE id::text=$1 AND tenant_id=$2 AND alias=$3 AND operator_id=$4`,
    [company.session, company.tenant, company.alias, company.email]);
  const row = (await pool.query<{ console_subject: string }>('SELECT console_subject FROM terminal_sessions WHERE id::text=$1',
    [company.session])).rows[0];
  if (!row) throw new Error(`canary ${side}.session must exist`);
  if (row.console_subject !== `console:${company.human}`) {
    const subject = decodeTerminalSubject(row.console_subject);
    if (subject.kind !== 'human' || subject.humanId !== company.human || subject.actor.tenantId !== company.tenant
      || subject.actor.alias !== company.ownerAlias) throw new Error(`canary ${side}.session has a foreign subject`);
  }
  result.checkedFields.push(`${side}.session.subject`);
  if (company.ownerToken !== undefined || company.requestId !== undefined || company.ownerGeneration !== undefined) {
    if (typeof company.ownerToken !== 'string' || company.ownerToken.length === 0 || typeof company.requestId !== 'string'
      || !uuid.test(company.requestId) || typeof company.ownerGeneration !== 'string'
      || relayClaimEpoch(company.ownerGeneration) === undefined) {
      throw new Error(`canary ${side}.session requires a real request and browser owner`);
    }
    await check('requestId/ownerToken/ownerGeneration', `SELECT 1 FROM terminal_sessions WHERE id::text=$1 AND request_id::text=$2
      AND encode(browser_owner_sha256,'hex')=$3 AND browser_owner_generation=$4 AND expires_at>now()
      AND closed_at IS NULL AND revoked_at IS NULL`,
    [company.session, company.requestId, digest(company.ownerToken), company.ownerGeneration]);
  }
  if (company.authorityProof !== undefined) result.unverifiableFields.push(`${side}.authorityProof signature requires the gateway key`);
}

async function validateEphemeral(check: Check, company: IsolationCompany, side: string, result: CanaryValidation): Promise<void> {
  if (company.connectionInstance !== undefined || company.connectionEpoch !== undefined || company.connectionToken !== undefined) {
    if (typeof company.connectionInstance !== 'string' || !uuid.test(company.connectionInstance)
      || typeof company.connectionToken !== 'string' || !uuid.test(company.connectionToken)
      || !Number.isSafeInteger(company.connectionEpoch) || Number(company.connectionEpoch) < 1) {
      throw new Error(`canary ${side}.connection requires a complete live lease`);
    }
    await check('connectionInstance/connectionEpoch/connectionToken', `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2
      AND instance_id=$3 AND epoch=$4 AND connection_token::text=$5 AND lease_until>now()`,
    [company.tenant, company.ownerAlias, company.connectionInstance, company.connectionEpoch, company.connectionToken]);
  }
  if (company.providerSession !== undefined || company.providerOperation !== undefined) {
    if (typeof company.providerSession !== 'string' || !uuid.test(company.providerSession)
      || typeof company.providerOperation !== 'string' || !uuid.test(company.providerOperation)) {
      throw new Error(`canary ${side}.providerSession requires a real operation and UUID`);
    }
    await check('providerOperation', `SELECT 1 FROM fleet_operations WHERE id::text=$1 AND company_id=$2
      AND target->>'tenant_id'=$3 AND target->>'alias'=$4 AND executor_host=$5 AND status='awaiting_auth'`,
    [company.providerOperation, company.company, company.tenant, company.alias, company.host]);
    result.unverifiableFields.push(`${side}.providerSession exists only in gateway memory; PostgreSQL proves its operation scope`);
  }
  const optional = company as unknown as Record<string, unknown>;
  if (optional.providerRequest !== undefined) {
    const parsed = ProviderAuthRequestSchema.safeParse(optional.providerRequest);
    if (!parsed.success || parsed.data.operation_id !== company.providerOperation || parsed.data.account_id !== company.account
      || parsed.data.host_id !== company.host) throw new Error(`canary ${side}.providerRequest has an invalid operation scope`);
    const request = parsed.data;
    await check('providerRequest', `SELECT 1 FROM agents agent JOIN provider_accounts account ON account.id=agent.primary_account_id
      JOIN fleet_operations operation ON operation.id::text=$1 AND operation.company_id=agent.company_id
      WHERE agent.company_id=$2 AND agent.tenant_id=$3 AND agent.alias=$4 AND agent.primary_account_id=$5
        AND agent.harness_id=$6 AND agent.runtime_user=$7 AND account.provider=$8 AND operation.version>=$9`,
    [request.operation_id, company.company, company.tenant, company.alias, request.account_id,
      request.harness_id, request.runtime_user, request.provider_id, request.expected_operation_version]);
    result.unverifiableFields.push(`${side}.providerRequest.request_id/profile_id are checked by the gateway policy and live session`);
  }
  for (const [field, sql] of [
    ['binding', 'SELECT 1 FROM human_oauth_client_delegations WHERE id::text=$1 AND human_id::text=$2 AND tenant_id=$3 AND revoked_at IS NULL'],
    ['grant', 'SELECT 1 FROM cauce_oauth_grants WHERE id::text=$1 AND human_id::text=$2 AND tenant_id=$3 AND expires_at>now()'],
  ]) {
    if (field === undefined || sql === undefined || optional[field] === undefined) continue;
    if (typeof optional[field] !== 'string' || !uuid.test(optional[field])) throw new Error(`canary ${side}.${field} requires a real UUID`);
    await check(field, sql, [optional[field], company.human, company.tenant]);
  }
  if (optional.bootstrapProbe !== undefined) result.unverifiableFields.push(`${side}.bootstrapProbe is not persisted in PostgreSQL`);
}

export async function validateCanaryFixtures(pool: DatabasePool, fixtures: { a: IsolationCompany; b: IsolationCompany },
  options: CanaryOptions = {}): Promise<CanaryValidation> {
  validateShape(fixtures.a, 'a');
  validateShape(fixtures.b, 'b');
  if (options.requireCanaryNames ?? true) {
    const b = fixtures.b as unknown as Record<string, unknown>;
    for (const field of ['authorityProof', 'requestId', 'ownerToken', 'ownerGeneration', 'connectionInstance', 'connectionEpoch',
      'connectionToken', 'providerSession', 'providerOperation', 'providerRequest']) {
      if (b[field] === undefined || b[field] === null || b[field] === '') throw new Error(`canary b.${field} requires a real live fixture`);
    }
  }
  for (const field of ['company', 'tenant', 'human', 'email', 'alias', 'host', 'account', 'environment', 'backup', 'message',
    'delivery', 'operation', 'session', 'gate', 'nativeOperation', 'dlq'] as const) {
    if (fixtures.a[field] === fixtures.b[field]) throw new Error(`canary A/B require distinct ${field}`);
  }
  if (fixtures.a.privateSentinels.some(value => fixtures.b.privateSentinels.includes(value))) {
    throw new Error('canary A/B private sentinels must be distinct');
  }
  const result: CanaryValidation = { checkedFields: [], unverifiableFields: [] };
  for (const [side, company] of [['a', fixtures.a], ['b', fixtures.b]] as const) {
    if ((options.requireCanaryNames ?? true) && !company.company.startsWith('zz-canary-')) {
      throw new Error(`canary ${side}.company requires the zz-canary- prefix`);
    }
    const check: Check = async (field, sql, values) => {
      const exists = (await pool.query<{ valid: boolean }>(`SELECT EXISTS(${sql}) AS valid`, values)).rows[0]?.valid;
      if (exists !== true) throw new Error(`canary ${side}.${field} is missing, expired or belongs to another scope`);
      result.checkedFields.push(`${side}.${field}`);
    };
    if ((options.requireCanaryNames ?? true) && side === 'a') {
      await check('ownerAlias.noRunnableDeliveries', `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM deliveries
        WHERE recipient_tenant=$1 AND recipient_alias=$2 AND status IN ('pending','retry','leased','accepted','started'))`,
      [company.tenant, company.ownerAlias]);
    }
    await validateResources(check, company);
    await validateTerminal(pool, check, company, side, result);
    await validateEphemeral(check, company, side, result);
    result.unverifiableFields.push(`${side}.password is verified by HTTP login, not by PostgreSQL fixture inspection`,
      `${side}.contextRepositoryPath/contextCommit/nativePiece and physical file availability require gateway/runtime checks`);
  }
  return result;
}
