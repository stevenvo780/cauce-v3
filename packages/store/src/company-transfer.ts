import type { FleetOperation, FleetOperationRequest } from '@cauce/protocol';
import { companyRevision, lockCompanyConfiguration } from './company-authority.js';
import { ConfigurationRepository } from './configuration.js';
import { ConfigurationError } from './configuration/contracts.js';
import { withBoundConfigurationTransaction } from './configuration/transaction.js';
import { lockPlatformActor, type PlatformActor } from './configuration-platform.js';
import type { DatabaseClient, DatabasePool } from './db.js';
import type { FleetOperationsRepository } from './repository/fleet-operations.js';
import { parseCompanyTransferBundle, parseCompanyTransferPlan, type CompanyTransferBundle, type CompanyTransferPlan } from './company-transfer-model.js';
import { buildCompanyTransferPlan } from './company-transfer-plan.js';
import { readCompanyTransferSnapshot } from './company-transfer-snapshot.js';

export interface CompanyTransferOptions { fleetRepository?: FleetOperationsRepository; transactionClient?: DatabaseClient }
export interface CompanyTransferReceipt {
  company_id: string; bundle_sha256: string; plan_sha256: string; revision: number; revisions: number[];
  applied: boolean; dry_run: boolean; replayed: boolean; physical_effect_verified: false;
  fleet_operations: { id: string; status: FleetOperation['status']; target: FleetOperation['target'] }[];
}
class TransferPreview<T> extends Error { constructor(readonly result: T) { super('company transfer preview'); } }

async function lockTransfer(client: DatabaseClient, actor: PlatformActor): Promise<void> {
  await lockCompanyConfiguration(client, actor.companyId);
  await lockPlatformActor(client, actor);
}
async function assertOwnedTenants(client: DatabaseClient, company: string, bundle: CompanyTransferBundle): Promise<void> {
  const rows = (await client.query<{ company_id: string }>('SELECT company_id FROM tenants WHERE id=ANY($1::text[]) FOR SHARE',
    [bundle.records.tenants.map(row => row.id)])).rows;
  if (rows.some(row => row.company_id !== company)) throw new ConfigurationError('forbidden', 'a bundle tenant identity belongs to another company');
}
async function preserveLocalProviderSelection(client: DatabaseClient, actor: PlatformActor, input: FleetOperationRequest): Promise<FleetOperationRequest> {
  if (input.kind !== 'update') return input;
  const current = (await client.query<{ primary_account_id: string | null; model_id: string | null;
    reasoning_effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null }>(`SELECT primary_account_id,model_id,reasoning_effort
    FROM agents WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 FOR SHARE`,
  [actor.companyId, input.target.tenant_id, input.target.alias])).rows[0];
  if (current === undefined) throw new ConfigurationError('conflict', 'physical import update target is unavailable');
  return { ...input, parameters: { ...input.parameters, ...current } };
}
async function executePlan(pool: DatabasePool, client: DatabaseClient, actor: PlatformActor, plan: CompanyTransferPlan,
  options: CompanyTransferOptions, dryRun: boolean): Promise<CompanyTransferReceipt> {
  const repository = new ConfigurationRepository(pool, client);
  const revisions: number[] = [];
  let revision = plan.expected_revision;
  for (let offset = 0; offset < plan.mutations.length; offset += 100) {
    const result = await repository.apply(actor.tenant, actor.alias,
      { resource: 'batch', action: 'apply', mutations: plan.mutations.slice(offset, offset + 100) }, false, revision,
      bound => lockPlatformActor(bound, actor));
    revision = result.revision; revisions.push(revision);
  }
  const operations: CompanyTransferReceipt['fleet_operations'] = [];
  if (plan.fleet_requests.length > 0) {
    if (!options.fleetRepository) throw new ConfigurationError('conflict', 'physical import requires the configured fleet coordinator');
    const fleet = options.fleetRepository.forCompany(actor.companyId).forTransaction(client);
    const global = Number((await client.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions')).rows[0]?.revision ?? 0);
    for (const input of plan.fleet_requests) {
      const request = await preserveLocalProviderSelection(client, actor, input);
      const operation = await fleet.enqueue(actor.tenant, actor.alias, { ...request, expected_revision: global }, `console:${actor.humanId}`);
      operations.push({ id: operation.id, status: operation.status, target: operation.target });
    }
  }
  return { company_id: actor.companyId, bundle_sha256: plan.bundle_sha256, plan_sha256: plan.plan_sha256,
    revision: await companyRevision(client, actor.companyId), revisions, applied: !dryRun, dry_run: dryRun,
    replayed: false, physical_effect_verified: false, fleet_operations: operations };
}

export async function exportCompanyConfiguration(pool: DatabasePool, actor: PlatformActor, bound?: DatabaseClient): Promise<CompanyTransferBundle> {
  return withBoundConfigurationTransaction(pool, bound, async client => {
    await lockTransfer(client, actor);
    return readCompanyTransferSnapshot(client, actor.companyId);
  });
}
export async function planCompanyConfigurationImport(pool: DatabasePool, actor: PlatformActor, input: unknown, expectedRevision: number,
  options: CompanyTransferOptions = {}): Promise<CompanyTransferPlan> {
  const bundle = parseCompanyTransferBundle(input);
  try {
    return await withBoundConfigurationTransaction(pool, options.transactionClient, async client => {
      await lockTransfer(client, actor); await assertOwnedTenants(client, actor.companyId, bundle);
      const current = await readCompanyTransferSnapshot(client, actor.companyId);
      const plan = buildCompanyTransferPlan(bundle, current, expectedRevision);
      await executePlan(pool, client, actor, plan, options, true);
      throw new TransferPreview(plan);
    });
  } catch (error) { if (error instanceof TransferPreview) return error.result as CompanyTransferPlan; throw error; }
}
export async function importCompanyConfiguration(pool: DatabasePool, actor: PlatformActor, input: unknown, acceptedPlan: unknown,
  dryRun: boolean, options: CompanyTransferOptions = {}): Promise<CompanyTransferReceipt> {
  const bundle = parseCompanyTransferBundle(input); const plan = parseCompanyTransferPlan(acceptedPlan);
  if (bundle.company_id !== actor.companyId || plan.company_id !== actor.companyId || plan.bundle_sha256 !== bundle.bundle_sha256) {
    throw new ConfigurationError('forbidden', 'company import identities differ');
  }
  try {
    return await withBoundConfigurationTransaction(pool, options.transactionClient, async client => {
      await lockTransfer(client, actor);
      const prior = (await client.query<{ metadata: { receipt: CompanyTransferReceipt } }>(`SELECT metadata FROM audit_events
        WHERE action='company.configuration.import' AND company_id=$1
          AND metadata->>'bundle_sha256'=$2 AND metadata->>'plan_sha256'=$3 ORDER BY id DESC LIMIT 1`,
      [actor.companyId, bundle.bundle_sha256, plan.plan_sha256])).rows[0];
      if (prior !== undefined) return { ...prior.metadata.receipt, replayed: true, ...(dryRun ? { applied: false, dry_run: true } : {}) };
      await assertOwnedTenants(client, actor.companyId, bundle);
      const current = await readCompanyTransferSnapshot(client, actor.companyId);
      const recomputed = buildCompanyTransferPlan(bundle, current, plan.expected_revision);
      if (recomputed.plan_sha256 !== plan.plan_sha256) throw new ConfigurationError('conflict', 'company import plan differs from current configuration');
      const receipt = await executePlan(pool, client, actor, recomputed, options, dryRun);
      if (dryRun) throw new TransferPreview({ ...receipt, revision: current.source_revision, revisions: [], fleet_operations: [] });
      await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,actor_human_id,company_id,action,decision,metadata)
        VALUES($1,$2,$3,$4,'company.configuration.import','allow',$5::jsonb)`,
      [actor.tenant, actor.alias, actor.humanId, actor.companyId, JSON.stringify({ bundle_sha256: bundle.bundle_sha256,
        plan_sha256: plan.plan_sha256, platform_override: actor.companyId !== (await lockPlatformActor(client, actor)).homeCompany, receipt })]);
      return receipt;
    });
  } catch (error) { if (error instanceof TransferPreview) return error.result as CompanyTransferReceipt; throw error; }
}
