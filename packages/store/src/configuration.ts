import type { ConfigMutation, Tenant } from '@cauce/protocol';
import { configurationMutationHashInput, publicConfigurationMutation, sha256Hex } from '@cauce/protocol';
import {
  companyRevision, lockCompanyAuthority, lockCompanyConfiguration, lockPlatformConfiguration, type CompanyAuthority,
} from './company-authority.js';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withBoundConfigurationTransaction } from './configuration/transaction.js';
import {
  ConfigurationError,
  type ConfigurationAuthorityResolver,
  type ConfigurationChangeResult,
  type ConfigurationErrorCode,
  type ConfigurationDependencyPreview,
  type ConfigurationLeafMutation,
} from './configuration/contracts.js';
import { ConfigurationMutations } from './configuration/mutations.js';
import {
  assertCompanyMutation, authorizeConfigurationMutation, companyWide, configurationCapabilities, configurationScopeSql, isPlatformMutation,
} from './configuration/company-scope.js';
import { assertRuntimeSynchronizedMutation, configurationDependencies, configurationIdentity, databaseError } from './configuration/shared.js';

export { ConfigurationError };
export type {
  ConfigurationAuthorityResolver, ConfigurationChangeResult, ConfigurationErrorCode, ConfigurationDependencyPreview, ConfigurationLeafMutation,
};
export type { ConfigurationCapabilities, ConfigurationDependency, ConfigurationResourceCapability } from './configuration/contracts.js';

interface RevisionRow {
  id: string;
  actor_tenant: string;
  actor_alias: string;
  operation: ConfigMutation;
  inverse_operation: ConfigMutation;
  summary: string;
  rolled_back_revision_id: string | null;
  created_at: Date;
  scope: 'company' | 'platform';
  company_id: string | null;
}

interface ConfigurationActor {
  readonly tenant: Tenant;
  readonly alias: string;
  readonly resolve: ConfigurationAuthorityResolver;
}

function configurationActor(tenant: Tenant, alias: string, resolve?: ConfigurationAuthorityResolver): ConfigurationActor {
  return { tenant, alias, resolve: resolve ?? (client => lockCompanyAuthority(client, { tenant, alias })) };
}

/** An actor outside the revision's company or tenant learns nothing about it, not even that it exists. */
function revisionVisible(revision: Pick<RevisionRow, 'scope' | 'company_id' | 'actor_tenant'>, authority: CompanyAuthority): boolean {
  if (revision.scope === 'platform') return authority.role === 'platform_admin';
  return revision.company_id === authority.actingCompany && (companyWide(authority) || revision.actor_tenant === authority.homeTenant);
}

function operationForRead(operation: unknown): unknown {
  if (!isRecord(operation)) return operation;
  if (operation.resource === 'batch' && Array.isArray(operation.mutations)) {
    return { ...operation, mutations: operation.mutations.map(operationForRead) };
  }
  if (operation.resource !== 'provider_account' || !isRecord(operation.value)) return operation;
  const value = Object.fromEntries(Object.entries(operation.value).filter(([key]) => key !== 'credential_ref'));
  return { ...operation, value };
}

function mutationForRead(mutation: ConfigMutation): ConfigMutation {
  return publicConfigurationMutation(mutation);
}

function revisionForSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, operation: operationForRead(row.operation) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RollbackResult<T> extends Error {
  constructor(readonly result: T) {
    super('configuration preview rollback');
  }
}

export class ConfigurationRepository extends ConfigurationMutations {
  constructor(private readonly pool: DatabasePool, private readonly transactionClient?: DatabaseClient) { super(); }
  forTransaction(client: DatabaseClient): ConfigurationRepository { return new ConfigurationRepository(this.pool, client); }
  private get queryable(): Pick<DatabaseClient, 'query'> { return this.transactionClient ?? this.pool; }
  private transact<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return withBoundConfigurationTransaction(this.pool, this.transactionClient, work);
  }
  protected authorizeMutation(mutation: ConfigMutation, authority: CompanyAuthority): void {
    authorizeConfigurationMutation(mutation, configurationCapabilities(authority));
  }

  async get(actorTenant: Tenant, actorAlias: string, authority?: ConfigurationAuthorityResolver): Promise<Record<string, unknown>> {
    const actor = configurationActor(actorTenant, actorAlias, authority);
    const { current, revision } = await this.transact(async (client) => {
      const resolved = await this.authority(client, actor);
      if (resolved.role === 'none') throw new ConfigurationError('forbidden', 'read permission is required for configuration');
      return { current: resolved, revision: await companyRevision(client, resolved.actingCompany) };
    });
    const scope = [current.actingCompany, companyWide(current) ? null : actorTenant];
    const owned = configurationScopeSql;
    const companyOwned = (owner: string): string => `${owner} IN (SELECT id FROM tenants WHERE company_id=$1)`;
    const [
      tenants, rooms, memberships, edges, harnesses, policies, destinations, chainPolicies,
      agents, providerAccounts, routingCeiling, agentAccountBindings, revisions, agentProfiles
    ] = await Promise.all([
        this.queryable.query<Record<string, unknown>>(
          `SELECT id,display_name,is_hub,enabled,created_at,to_jsonb(tenants)->>'retired_at' AS retired_at FROM tenants
           WHERE ${owned('tenants.id')} AND to_jsonb(tenants)->>'purged_at' IS NULL ORDER BY id`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT id,tenant_id,display_name,enabled,created_at,to_jsonb(rooms)->>'retired_at' AS retired_at FROM rooms
           WHERE ${owned('rooms.tenant_id')} AND to_jsonb(rooms)->>'purged_at' IS NULL
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=rooms.tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,id`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT tenant_id,room_id,alias,role,enabled,created_at,to_jsonb(memberships)->>'retired_at' AS retired_at FROM memberships
           WHERE ${owned('memberships.tenant_id')}
             AND NOT EXISTS(SELECT 1 FROM agents WHERE agents.tenant_id=memberships.tenant_id AND agents.alias=memberships.alias AND to_jsonb(agents)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM rooms WHERE rooms.tenant_id=memberships.tenant_id AND rooms.id=memberships.room_id AND to_jsonb(rooms)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=memberships.tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,room_id,alias`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control,created_at FROM acl_edges
           WHERE (${companyOwned('acl_edges.from_tenant')} OR ${companyOwned('acl_edges.to_tenant')})
             AND ($2::text IS NULL OR from_tenant=$2 OR to_tenant=$2)
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id IN (acl_edges.from_tenant,acl_edges.to_tenant) AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
           ORDER BY from_tenant,to_tenant`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT id,display_name,command,capabilities,enabled,created_at,updated_at
           FROM harness_definitions ORDER BY id`
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT role,allow_route,allow_read,allow_control,allow_notify,created_at FROM role_policies ORDER BY role`
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT tenant_id,alias,handle,adapter,channel,conversation_id,conversation_kind,display_label,
                  allow_kinds,require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,
                  max_per_day,max_per_root,quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled,
                  created_at,updated_at
           FROM egress_destinations WHERE ${owned('egress_destinations.tenant_id')}
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=egress_destinations.tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM agents WHERE agents.tenant_id=egress_destinations.tenant_id AND agents.alias=egress_destinations.alias AND to_jsonb(agents)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,alias,handle`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          /*
           * Snapshot every enforced chain limit so rollback restores exact prior values.
           */
          `SELECT id,progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
                  failure_coalesce_enabled,failure_coalesce_window_seconds,
                  delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,
                  max_delegations_per_root,human_gate_enabled,updated_at
           FROM agent_chain_policies ORDER BY id`
        ),
        this.queryable.query<Record<string, unknown>>(
          // `role_brief` still travels only as a legacy read-only projection. The canonical write
          // happens in `agent_profiles` and is published to the runtime with ACK; the generic
          // editor rejects any attempt to mutate this column.
          /*
           * `max_concurrent_deliveries` (migration 015) is the REAL ceiling of in-flight
           * deliveries for an agent: `repository.ts` enforces it when distributing quota. It was
           * not in the snapshot or in the mutation, so it could only be changed via SQL — and
           * 015 itself documents the `UPDATE ... = NULL` as the emergency exit when the ceiling
           * strangles an agent that can actually parallelise. That exit now has a screen.
           */
          `SELECT tenant_id,alias,harness_id,display_name,enabled,
                  container_name,runtime_user,home_directory,state_directory,role_brief,
                  max_concurrent_deliveries,created_at,updated_at,to_jsonb(agents)->>'retired_at' AS retired_at,
                  to_jsonb(agents)->>'runtime_key' AS runtime_key,to_jsonb(agents)->>'lifecycle_state' AS lifecycle_state,
                  to_jsonb(agents)->>'primary_room_id' AS primary_room_id,to_jsonb(agents)->>'host_id' AS host_id,
                  to_jsonb(agents)->>'runtime_mode' AS runtime_mode,to_jsonb(agents)->>'systemd_user' AS systemd_user,
                  to_jsonb(agents)->>'primary_account_id' AS primary_account_id,to_jsonb(agents)->>'model_id' AS model_id,
                  to_jsonb(agents)->>'reasoning_effort' AS reasoning_effort
           FROM agents WHERE ${owned('agents.tenant_id')} AND to_jsonb(agents)->>'purged_at' IS NULL
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=agents.tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,alias`, scope
        ),
        // credential_ref never leaves the database, not even for its payer: it is a locator, not a
        // secret, but rendering a listing has never needed it. A borrowing tenant additionally
        // sees only the shape of a pooled account (who pays, which provider, its label);
        // external_account_id and credential_ref_kind describe the payer's own credential
        // material and stay behind the payer scope.
        this.queryable.query<Record<string, unknown>>(
          `SELECT id,provider,payer_tenant_id,label,shared_with_pool,enabled,created_at,updated_at,
                  CASE WHEN $2::text IS NULL OR payer_tenant_id=$2 THEN external_account_id END AS external_account_id,
                  CASE WHEN $2::text IS NULL OR payer_tenant_id=$2 THEN credential_ref_kind END AS credential_ref_kind
           FROM provider_accounts
           WHERE ${companyOwned('provider_accounts.payer_tenant_id')}
             AND ($2::text IS NULL OR payer_tenant_id=$2 OR shared_with_pool)
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=provider_accounts.payer_tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
           ORDER BY id`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT tenant_id,alias,account_id,account_payer_tenant,created_by_tenant,created_at
           FROM alias_routing_ceiling
           WHERE ${companyOwned('alias_routing_ceiling.tenant_id')} AND ${companyOwned('alias_routing_ceiling.account_payer_tenant')}
             AND ($2::text IS NULL OR tenant_id=$2 OR account_payer_tenant=$2)
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id IN (alias_routing_ceiling.tenant_id,alias_routing_ceiling.account_payer_tenant) AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM agents WHERE agents.tenant_id=alias_routing_ceiling.tenant_id AND agents.alias=alias_routing_ceiling.alias AND to_jsonb(agents)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,alias,account_id`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          `SELECT tenant_id,agent_alias,account_id,priority,enabled,created_at,updated_at
           FROM agent_account_bindings WHERE ${owned('agent_account_bindings.tenant_id')}
             AND EXISTS(SELECT 1 FROM provider_accounts account WHERE account.id=agent_account_bindings.account_id
               AND ${companyOwned('account.payer_tenant_id')})
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=agent_account_bindings.tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM agents WHERE agents.tenant_id=agent_account_bindings.tenant_id AND agents.alias=agent_account_bindings.agent_alias AND to_jsonb(agents)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM provider_accounts account JOIN tenants tenant ON tenant.id=account.payer_tenant_id
               WHERE account.id=agent_account_bindings.account_id AND to_jsonb(tenant)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,agent_alias,priority,account_id`, scope
        ),
        this.queryable.query<Record<string, unknown>>(
          // Orders explicitly by the numeric column config_revisions.id to avoid lexicographic ordering over id::text.
          `SELECT id::text,actor_tenant,actor_alias,operation,summary,rolled_back_revision_id::text,created_at,
                  scope,company_id,platform_override
           FROM config_revisions
           WHERE (company_id=$1 AND ($2::text IS NULL OR actor_tenant=$2)) OR (scope='platform' AND $3::boolean)
           ORDER BY config_revisions.id DESC LIMIT 100`, [...scope, current.role === 'platform_admin']
        ),
        this.queryable.query<Record<string, unknown>>(
          // The profile travels in the snapshot for diagnostics, diff and read compatibility.
          // Its writes do not go through the generic editor: they use the canonical endpoint,
          // which validates the full document, syncs the runtime, and records its ACK.
          `SELECT tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,
                  tools,operating_rules,created_at,updated_at
           FROM agent_profiles WHERE ${owned('agent_profiles.tenant_id')}
             AND NOT EXISTS(SELECT 1 FROM tenants WHERE tenants.id=agent_profiles.tenant_id AND to_jsonb(tenants)->>'purged_at' IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM agents WHERE agents.tenant_id=agent_profiles.tenant_id AND agents.alias=agent_profiles.alias AND to_jsonb(agents)->>'purged_at' IS NOT NULL)
           ORDER BY tenant_id,alias`, scope
        )
    ]);
    return {
      revision, observed_at: new Date().toISOString(),
      capabilities: configurationCapabilities(current),
      tenants: tenants.rows.filter((row) => !row.retired_at), rooms: rooms.rows.filter((row) => !row.retired_at),
      memberships: memberships.rows.filter((row) => !row.retired_at),
      retired: { tenants: tenants.rows.filter((row) => row.retired_at), rooms: rooms.rows.filter((row) => row.retired_at),
        memberships: memberships.rows.filter((row) => row.retired_at), agents: agents.rows.filter((row) => row.retired_at) },
      acl_edges: edges.rows, harness_definitions: harnesses.rows, role_policies: policies.rows,
      chain_policies: chainPolicies.rows,
      egress_destinations: destinations.rows,
      agents: agents.rows.filter((row) => !row.retired_at), provider_accounts: providerAccounts.rows,
      alias_routing_ceiling: routingCeiling.rows, agent_account_bindings: agentAccountBindings.rows,
      agent_profiles: agentProfiles.rows,
      revisions: revisions.rows.map(revisionForSnapshot)
    };
  }

  async getDependencies(
    actorTenant: Tenant, actorAlias: string, mutation: ConfigurationLeafMutation, expectedRevision?: number,
    authority?: ConfigurationAuthorityResolver,
  ): Promise<ConfigurationDependencyPreview> {
    const actor = configurationActor(actorTenant, actorAlias, authority);
    return this.transact(async (client) => {
      const { current, revision } = await this.lockForWrite(client, actor, mutation, expectedRevision);
      if (!isPlatformMutation(mutation)) await assertCompanyMutation(client, mutation, current.actingCompany);
      const dependencies = await configurationDependencies(client, mutation);
      return { revision, resource: mutation.resource, identity: configurationIdentity(mutation),
        dependencies, can_delete: dependencies.every((dependency) => !dependency.blocking) };
    });
  }

  async apply(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number,
    authority?: ConfigurationAuthorityResolver,
  ): Promise<ConfigurationChangeResult> {
    assertRuntimeSynchronizedMutation(mutation);
    const actor = configurationActor(actorTenant, actorAlias, authority);
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const { current, revision } = await this.lockForWrite(client, actor, mutation, expectedRevision);
      const { inverse, summary } = await this.change(client, actor, current, mutation);
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision, rolled_back_revision_id: null,
          summary, mutation: mutationForRead(mutation), inverse_mutation: mutationForRead(inverse),
          mutation_sha256: sha256Hex(configurationMutationHashInput(mutation)),
        }, rollback: true };
      }
      const nextRevision = await this.record(client, current, mutation, inverse, summary, null);
      await this.audit(client, current, 'config.change', { revision: nextRevision, mutation, summary }, isPlatformMutation(mutation));
      return { result: {
        applied: true, dry_run: false, revision: nextRevision, rolled_back_revision_id: null,
        summary, mutation: mutationForRead(mutation), inverse_mutation: mutationForRead(inverse),
        mutation_sha256: sha256Hex(configurationMutationHashInput(mutation)),
      }, rollback: false };
    });
  }

  async rollback(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number,
    authority?: ConfigurationAuthorityResolver,
  ): Promise<ConfigurationChangeResult> {
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
      throw new ConfigurationError('not_found', 'configuration revision is invalid');
    }
    const actor = configurationActor(actorTenant, actorAlias, authority);
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const selected = await client.query<RevisionRow>(
        `SELECT id::text,actor_tenant,actor_alias,operation,inverse_operation,summary,
                rolled_back_revision_id::text,created_at,scope,company_id
         FROM config_revisions WHERE id=$1`, [revisionId]
      );
      const original = selected.rows[0];
      const peeked = await this.peek(client, actor);
      if (!original || !revisionVisible(original, peeked)) throw new ConfigurationError('not_found', 'configuration revision was not found');
      assertRuntimeSynchronizedMutation(original.inverse_operation);
      const { current, revision: currentRevision } = await this.lockForWrite(
        client, actor, original.inverse_operation, expectedRevision, peeked);
      if (!revisionVisible(original, current)) throw new ConfigurationError('not_found', 'configuration revision was not found');
      const { inverse: redo, summary } = await this.change(client, actor, current, original.inverse_operation);
      const rollbackSummary = `rollback ${String(revisionId)}: ${summary}`;
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision: currentRevision,
          rolled_back_revision_id: Number(original.id), summary: rollbackSummary,
          mutation: mutationForRead(original.inverse_operation), inverse_mutation: mutationForRead(redo),
          mutation_sha256: sha256Hex(configurationMutationHashInput(original.inverse_operation)),
        }, rollback: true };
      }
      const nextRevision = await this.record(client, current, original.inverse_operation, redo, rollbackSummary, revisionId);
      await this.audit(client, current, 'config.rollback', {
        revision: nextRevision, rolled_back_revision: revisionId, mutation: original.inverse_operation
      }, original.scope === 'platform');
      return { result: {
        applied: true, dry_run: false, revision: nextRevision,
        rolled_back_revision_id: revisionId, summary: rollbackSummary,
        mutation: mutationForRead(original.inverse_operation), inverse_mutation: mutationForRead(redo),
        mutation_sha256: sha256Hex(configurationMutationHashInput(original.inverse_operation)),
      }, rollback: false };
    });
  }

  private async transaction<T>(
    work: (client: DatabaseClient) => Promise<{ result: T; rollback: boolean }>
  ): Promise<T> {
    try {
      return await this.transact(async (client) => {
        const output = await work(client);
        if (output.rollback) throw new RollbackResult(output.result);
        return output.result;
      });
    } catch (error) {
      if (error instanceof RollbackResult) return error.result as T;
      databaseError(error);
    }
  }

  private async authority(client: DatabaseClient, actor: ConfigurationActor): Promise<CompanyAuthority> {
    const resolved = await actor.resolve(client);
    if (resolved.homeTenant !== actor.tenant || resolved.alias !== actor.alias) {
      throw new ConfigurationError('forbidden', 'configuration authority does not belong to the actor');
    }
    return resolved;
  }

  /** Resolves without keeping its row locks, so the configuration lock is always taken before any of them. */
  private async peek(client: DatabaseClient, actor: ConfigurationActor): Promise<CompanyAuthority> {
    await client.query('SAVEPOINT configuration_authority');
    try {
      return await this.authority(client, actor);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT configuration_authority');
    }
  }

  private async lockForWrite(
    client: DatabaseClient, actor: ConfigurationActor, mutation: ConfigMutation, expected?: number,
    peeked: CompanyAuthority | undefined = undefined,
  ): Promise<{ current: CompanyAuthority; revision: number }> {
    peeked ??= await this.peek(client, actor);
    this.authorizeMutation(mutation, peeked);
    if (isPlatformMutation(mutation)) await lockPlatformConfiguration(client);
    else await lockCompanyConfiguration(client, peeked.actingCompany);
    const current = await this.authority(client, actor);
    if (current.actingCompany !== peeked.actingCompany) throw new ConfigurationError('conflict', 'the acting company changed');
    this.authorizeMutation(mutation, current);
    const revision = await companyRevision(client, current.actingCompany);
    if (expected !== undefined && revision !== expected) {
      throw new ConfigurationError(
        'conflict',
        `configuration revision changed: expected ${String(expected)}, current ${String(revision)}`,
      );
    }
    return { current, revision };
  }

  private async change(
    client: DatabaseClient, actor: ConfigurationActor, current: CompanyAuthority, mutation: ConfigMutation,
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const company = current.actingCompany;
    if (isPlatformMutation(mutation)) return this.execute(client, mutation, company);
    await assertCompanyMutation(client, mutation, company);
    const controlBefore = await this.controlState(client, company);
    const changed = await this.execute(client, mutation, company);
    await this.assertRecoverableControl(client, controlBefore, company);
    if (!configurationCapabilities(await this.authority(client, actor)).actor.can_control) {
      throw new ConfigurationError('forbidden', 'control permission is required for configuration');
    }
    return changed;
  }

  private async record(
    client: DatabaseClient, current: CompanyAuthority, operation: ConfigMutation, inverse: ConfigMutation,
    summary: string, rolledBack: number | null,
  ): Promise<number> {
    const platform = isPlatformMutation(operation);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary,rolled_back_revision_id,
         scope,company_id,actor_human_id,platform_override)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
      [current.homeTenant, current.alias, JSON.stringify(operation), JSON.stringify(inverse), summary, rolledBack,
        platform ? 'platform' : 'company', platform ? null : current.actingCompany, current.humanId,
        !platform && current.platformOverride]
    );
    const insertedRevision = inserted.rows[0];
    if (insertedRevision === undefined) throw new Error('configuration revision insert returned no row');
    return Number(insertedRevision.id);
  }

  /** Company and owner counts: a change may not leave the company without hub control or a qualified owner. */
  protected async controlState(client: DatabaseClient, company: string): Promise<{ hub_control_count: number; owner_count: number }> {
    const selected = await client.query<{ hub_control_count: string | number; owner_count: string | number }>(
      `SELECT (SELECT count(*) FROM tenants tenant WHERE tenant.company_id=$1 AND tenant.is_hub AND tenant.enabled
         AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL AND EXISTS(
           SELECT 1 FROM memberships membership
           JOIN role_policies role ON role.role=membership.role
           JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
           JOIN agents agent ON agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias
           WHERE membership.tenant_id=tenant.id AND membership.enabled AND room.enabled AND role.allow_control
             AND membership.retired_at IS NULL AND room.retired_at IS NULL AND room.purged_at IS NULL
             AND agent.retired_at IS NULL AND agent.purged_at IS NULL)) AS hub_control_count,
       (SELECT count(*) FROM company_admins owner
         JOIN console_users person ON person.id=owner.human_id
         JOIN human_tenant_memberships home ON home.human_id=person.id AND home.tenant_id=person.tenant_id
         JOIN tenants tenant ON tenant.id=person.tenant_id AND tenant.company_id=owner.company_id
         WHERE owner.company_id=$1 AND owner.role='owner' AND person.active AND person.role='operator'
           AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
           AND home.enabled AND home.revoked_at IS NULL AND home.role='operator' AND home.actor_alias=person.alias
           AND 'control'=ANY(home.permissions) AND EXISTS(
             SELECT 1 FROM memberships membership
             JOIN role_policies role ON role.role=membership.role
             JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
             JOIN agents agent ON agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias
             WHERE membership.tenant_id=person.tenant_id AND membership.alias=person.alias
               AND membership.enabled AND membership.retired_at IS NULL AND role.allow_control
               AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
               AND agent.retired_at IS NULL AND agent.purged_at IS NULL)) AS owner_count`, [company],
    );
    const row = selected.rows[0];
    return { hub_control_count: Number(row?.hub_control_count ?? 0), owner_count: Number(row?.owner_count ?? 0) };
  }

  private async assertRecoverableControl(
    client: DatabaseClient, before: { hub_control_count: number; owner_count: number }, company: string,
  ): Promise<void> {
    const after = await this.controlState(client, company);
    if ((before.hub_control_count > 0 && after.hub_control_count === 0)
      || (before.owner_count > 0 && after.owner_count === 0)) {
      throw new ConfigurationError('conflict', 'configuration cannot remove the last HUB control or qualified company owner');
    }
  }

  private async audit(
    client: DatabaseClient, current: CompanyAuthority, action: string, metadata: Record<string, unknown>, platform: boolean,
  ): Promise<void> {
    const publicMetadata = { ...metadata,
      ...('mutation' in metadata ? { mutation: operationForRead(metadata.mutation) } : {}),
      ...(current.platformOverride && !platform ? { platform_override: true } : {}),
    };
    await client.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata,company_id,actor_human_id)
       VALUES($1,$2,$3,'allow',$4::jsonb,$5,$6)`,
      [current.homeTenant, current.alias, action, JSON.stringify(publicMetadata), platform ? null : current.actingCompany, current.humanId]
    );
  }
}
