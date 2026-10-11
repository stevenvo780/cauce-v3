import { ConfigMutationSchema, type ConfigMutation } from '@cauce/protocol';
import {
  assertKeepsCompanyAuthority, assertPlatformAdmin, companyRevision, lockCompanyAuthority, type CompanyAuthority,
} from './company-authority.js';
import { ConfigurationRepository } from './configuration.js';
import { ConfigurationError, type ConfigurationChangeResult } from './configuration/contracts.js';
import { type DatabaseClient, type DatabasePool } from './db.js';
import { withBoundConfigurationTransaction } from './configuration/transaction.js';

export interface PlatformActor {
  readonly humanId: string;
  readonly tenant: string;
  readonly alias: string;
  readonly companyId: string;
}

export async function lockPlatformActor(client: DatabaseClient, actor: PlatformActor): Promise<CompanyAuthority> {
  const authority = await lockCompanyAuthority(client, {
    tenant: actor.tenant, alias: actor.alias, humanId: actor.humanId, requestedCompany: actor.companyId,
  });
  assertPlatformAdmin(authority);
  if (authority.actingCompany !== actor.companyId) throw new ConfigurationError('forbidden', 'the acting company is unavailable');
  return authority;
}

class PlatformConfigurationRepository extends ConfigurationRepository {
  protected override authorizeMutation(mutation: ConfigMutation, authority: CompanyAuthority): void {
    assertPlatformAdmin(authority);
    const leaves = mutation.resource === 'batch' ? mutation.mutations : [mutation];
    if (leaves.length === 0 || leaves.some(leaf => leaf.resource !== 'harness' && leaf.resource !== 'role_policy')) {
      throw new ConfigurationError('forbidden', 'the platform CLI only manages harnesses and role policies');
    }
  }
  protected override async execute(client: DatabaseClient, mutation: ConfigMutation, company: string): Promise<{ inverse: ConfigMutation; summary: string }> {
    const result = await super.execute(client, mutation, company);
    if (mutation.resource === 'role_policy') {
      const holders = await client.query<{ human_id: string }>(`SELECT human_id::text FROM platform_admins
        UNION SELECT human_id::text FROM company_admins WHERE role='owner' ORDER BY human_id`);
      for (const holder of holders.rows) await assertKeepsCompanyAuthority(client, holder.human_id);
    }
    return result;
  }
}

export async function readPlatformConfiguration(pool: DatabasePool, actor: PlatformActor, bound?: DatabaseClient): Promise<Record<string, unknown>> {
  return withBoundConfigurationTransaction(pool, bound, async client => {
    await lockPlatformActor(client, actor);
    const harnesses = await client.query('SELECT id,display_name,command,capabilities,enabled FROM harness_definitions ORDER BY id');
    const policies = await client.query('SELECT role,allow_route,allow_read,allow_control,allow_notify FROM role_policies ORDER BY role');
    const revisions = await client.query(`SELECT id::text,actor_tenant,actor_alias,actor_human_id::text,summary,created_at,
      rolled_back_revision_id::text FROM config_revisions WHERE scope='platform' ORDER BY id DESC LIMIT 100`);
    return { company_id: actor.companyId, revision: await companyRevision(client, actor.companyId),
      harness_definitions: harnesses.rows, role_policies: policies.rows, revisions: revisions.rows };
  });
}

export async function applyPlatformConfiguration(
  pool: DatabasePool, actor: PlatformActor, input: unknown, dryRun: boolean, expectedRevision: number, bound?: DatabaseClient,
): Promise<ConfigurationChangeResult> {
  const mutation = ConfigMutationSchema.parse(input);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ConfigurationError('invalid_input', 'expected revision is required');
  return new PlatformConfigurationRepository(pool, bound).apply(actor.tenant, actor.alias, mutation, dryRun, expectedRevision,
    client => lockPlatformActor(client, actor));
}

export async function rollbackPlatformConfiguration(
  pool: DatabasePool, actor: PlatformActor, revision: number, dryRun: boolean, expectedRevision: number, bound?: DatabaseClient,
): Promise<ConfigurationChangeResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ConfigurationError('invalid_input', 'expected revision is required');
  return new PlatformConfigurationRepository(pool, bound).rollback(actor.tenant, actor.alias, revision, dryRun, expectedRevision,
    client => lockPlatformActor(client, actor));
}
