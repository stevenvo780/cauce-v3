import type { ConfigMutation, Tenant } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';
import {
  ConfigurationError,
  type ConfigurationChangeResult,
  type ConfigurationErrorCode,
} from './configuration/contracts.js';
import { ConfigurationMutations } from './configuration/mutations.js';
import { assertRuntimeSynchronizedMutation, databaseError } from './configuration/shared.js';

export { ConfigurationError };
export type { ConfigurationChangeResult, ConfigurationErrorCode };

interface RevisionRow {
  id: string;
  actor_tenant: string;
  actor_alias: string;
  operation: ConfigMutation;
  inverse_operation: ConfigMutation;
  summary: string;
  rolled_back_revision_id: string | null;
  created_at: Date;
}

class RollbackResult<T> extends Error {
  constructor(readonly result: T) {
    super('configuration preview rollback');
  }
}

export class ConfigurationRepository extends ConfigurationMutations {
  constructor(private readonly pool: DatabasePool) { super(); }

  async get(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    const hub = await withTransaction(this.pool, (client) => this.assertRead(client, actorTenant, actorAlias));
    const scope = hub ? null : actorTenant;
    const [
      revision, tenants, rooms, memberships, edges, harnesses, policies, destinations, chainPolicies,
      agents, providerAccounts, routingCeiling, agentAccountBindings, revisions, agentProfiles
    ] = await Promise.all([
        this.pool.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions'),
        this.pool.query<Record<string, unknown>>(
          `SELECT id,display_name,is_hub,enabled,created_at FROM tenants
           WHERE $1::text IS NULL OR id=$1 ORDER BY id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT id,tenant_id,display_name,enabled,created_at FROM rooms
           WHERE $1::text IS NULL OR tenant_id=$1 ORDER BY tenant_id,id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,room_id,alias,role,enabled,created_at FROM memberships
           WHERE $1::text IS NULL OR tenant_id=$1 ORDER BY tenant_id,room_id,alias`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control,created_at FROM acl_edges
           WHERE $1::text IS NULL OR from_tenant=$1 OR to_tenant=$1 ORDER BY from_tenant,to_tenant`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT id,display_name,command,capabilities,enabled,created_at,updated_at
           FROM harness_definitions ORDER BY id`
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT role,allow_route,allow_read,allow_control,allow_notify,created_at FROM role_policies ORDER BY role`
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,alias,handle,adapter,channel,conversation_id,conversation_kind,display_label,
                  allow_kinds,require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,
                  max_per_day,max_per_root,quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled,
                  created_at,updated_at
           FROM egress_destinations WHERE $1::text IS NULL OR tenant_id=$1
           ORDER BY tenant_id,alias,handle`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          /*
           * Snapshot every enforced chain limit so rollback restores exact prior values.
           */
          `SELECT id,progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
                  failure_coalesce_enabled,failure_coalesce_window_seconds,
                  delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,
                  max_delegations_per_root,human_gate_enabled,updated_at
           FROM agent_chain_policies ORDER BY id`
        ),
        this.pool.query<Record<string, unknown>>(
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
                  max_concurrent_deliveries,created_at,updated_at
           FROM agents WHERE $1::text IS NULL OR tenant_id=$1 ORDER BY tenant_id,alias`, [scope]
        ),
        // credential_ref never leaves the database, not even for its payer: it is a locator, not a
        // secret, but rendering a listing has never needed it. A borrowing tenant additionally
        // sees only the shape of a pooled account (who pays, which provider, its label);
        // external_account_id and credential_ref_kind describe the payer's own credential
        // material and stay behind the payer scope.
        this.pool.query<Record<string, unknown>>(
          `SELECT id,provider,payer_tenant_id,label,shared_with_pool,enabled,created_at,updated_at,
                  CASE WHEN $1::text IS NULL OR payer_tenant_id=$1 THEN external_account_id END AS external_account_id,
                  CASE WHEN $1::text IS NULL OR payer_tenant_id=$1 THEN credential_ref_kind END AS credential_ref_kind
           FROM provider_accounts
           WHERE $1::text IS NULL OR payer_tenant_id=$1 OR shared_with_pool
           ORDER BY id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,alias,account_id,account_payer_tenant,created_by_tenant,created_at
           FROM alias_routing_ceiling
           WHERE $1::text IS NULL OR tenant_id=$1 OR account_payer_tenant=$1
           ORDER BY tenant_id,alias,account_id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,agent_alias,account_id,priority,enabled,created_at,updated_at
           FROM agent_account_bindings WHERE $1::text IS NULL OR tenant_id=$1
           ORDER BY tenant_id,agent_alias,priority,account_id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          // Orders explicitly by the numeric column config_revisions.id to avoid lexicographic ordering over id::text.
          `SELECT id::text,actor_tenant,actor_alias,operation,summary,rolled_back_revision_id::text,created_at
           FROM config_revisions WHERE $1::text IS NULL OR actor_tenant=$1
           ORDER BY config_revisions.id DESC LIMIT 100`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          // The profile travels in the snapshot for diagnostics, diff and read compatibility.
          // Its writes do not go through the generic editor: they use the canonical endpoint,
          // which validates the full document, syncs the runtime, and records its ACK.
          `SELECT tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,
                  tools,operating_rules,created_at,updated_at
           FROM agent_profiles WHERE $1::text IS NULL OR tenant_id=$1
           ORDER BY tenant_id,alias`, [scope]
        )
    ]);
    return {
      revision: Number(revision.rows[0]?.revision ?? 0), observed_at: new Date().toISOString(),
      tenants: tenants.rows, rooms: rooms.rows, memberships: memberships.rows,
      acl_edges: edges.rows, harness_definitions: harnesses.rows, role_policies: policies.rows,
      chain_policies: chainPolicies.rows,
      egress_destinations: destinations.rows,
      agents: agents.rows, provider_accounts: providerAccounts.rows,
      alias_routing_ceiling: routingCeiling.rows, agent_account_bindings: agentAccountBindings.rows,
      agent_profiles: agentProfiles.rows,
      revisions: revisions.rows
    };
  }

  async apply(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    assertRuntimeSynchronizedMutation(mutation);
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const hub = await this.assertControl(client, actorTenant, actorAlias);
      this.authorizeMutation(mutation, actorTenant, hub);
      const revision = await this.lockRevision(client, expectedRevision);
      const { inverse, summary } = await this.execute(client, mutation);
      await this.assertControl(client, actorTenant, actorAlias);
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision, rolled_back_revision_id: null,
          summary, mutation, inverse_mutation: inverse
        }, rollback: true };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
         VALUES($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING id::text`,
        [actorTenant, actorAlias, JSON.stringify(mutation), JSON.stringify(inverse), summary]
      );
      const nextRevision = Number(inserted.rows[0]!.id);
      await this.audit(client, actorTenant, actorAlias, 'config.change', {
        revision: nextRevision, mutation, summary
      });
      return { result: {
        applied: true, dry_run: false, revision: nextRevision, rolled_back_revision_id: null,
        summary, mutation, inverse_mutation: inverse
      }, rollback: false };
    });
  }

  async rollback(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
      throw new ConfigurationError('not_found', 'configuration revision is invalid');
    }
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const hub = await this.assertControl(client, actorTenant, actorAlias);
      const currentRevision = await this.lockRevision(client, expectedRevision);
      const selected = await client.query<RevisionRow>(
        `SELECT id::text,actor_tenant,actor_alias,operation,inverse_operation,summary,
                rolled_back_revision_id::text,created_at
         FROM config_revisions WHERE id=$1 FOR UPDATE`, [revisionId]
      );
      const original = selected.rows[0];
      if (!original) throw new ConfigurationError('not_found', 'configuration revision was not found');
      if (!hub && original.actor_tenant !== actorTenant) {
        throw new ConfigurationError('forbidden', 'configuration revision is outside the actor tenant');
      }
      assertRuntimeSynchronizedMutation(original.inverse_operation);
      this.authorizeMutation(original.inverse_operation, actorTenant, hub);
      const { inverse: redo, summary } = await this.execute(client, original.inverse_operation);
      await this.assertControl(client, actorTenant, actorAlias);
      const rollbackSummary = `rollback ${revisionId}: ${summary}`;
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision: currentRevision,
          rolled_back_revision_id: Number(original.id), summary: rollbackSummary,
          mutation: original.inverse_operation, inverse_mutation: redo
        }, rollback: true };
      }
      const inserted = await client.query<{ id: string; rolled_back_revision_id: string }>(
        `INSERT INTO config_revisions(
           actor_tenant,actor_alias,operation,inverse_operation,summary,rolled_back_revision_id
         ) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)
         RETURNING id::text,rolled_back_revision_id::text`,
        [actorTenant, actorAlias, JSON.stringify(original.inverse_operation), JSON.stringify(redo),
          rollbackSummary, revisionId]
      );
      const nextRevision = Number(inserted.rows[0]!.id);
      const rolledBackRevisionId = Number(inserted.rows[0]!.rolled_back_revision_id);
      await this.audit(client, actorTenant, actorAlias, 'config.rollback', {
        revision: nextRevision, rolled_back_revision: revisionId, mutation: original.inverse_operation
      });
      return { result: {
        applied: true, dry_run: false, revision: nextRevision,
        rolled_back_revision_id: rolledBackRevisionId, summary: rollbackSummary,
        mutation: original.inverse_operation, inverse_mutation: redo
      }, rollback: false };
    });
  }

  private async transaction<T>(
    work: (client: DatabaseClient) => Promise<{ result: T; rollback: boolean }>
  ): Promise<T> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const output = await work(client);
        if (output.rollback) throw new RollbackResult(output.result);
        return output.result;
      });
    } catch (error) {
      if (error instanceof RollbackResult) return error.result as T;
      databaseError(error);
    }
  }

  private async assertControl(client: DatabaseClient, tenant: Tenant, alias: string): Promise<boolean> {
    const result = await client.query<{ is_hub: boolean }>(
      `SELECT tenant.is_hub FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND role.allow_control LIMIT 1`, [tenant, alias]
    );
    const row = result.rows[0];
    if (!row) throw new ConfigurationError('forbidden', 'control permission is required for configuration');
    return row.is_hub;
  }

  private async assertRead(client: DatabaseClient, tenant: Tenant, alias: string): Promise<boolean> {
    const result = await client.query<{ is_hub: boolean }>(
      `SELECT tenant.is_hub FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND role.allow_read LIMIT 1`, [tenant, alias]
    );
    const row = result.rows[0];
    if (!row) throw new ConfigurationError('forbidden', 'read permission is required for configuration');
    return row.is_hub;
  }

  private authorizeMutation(mutation: ConfigMutation, actorTenant: Tenant, hub: boolean): void {
    // Waiving prior contact means writing to a group nobody in it ever addressed.
    // That is a hub-only decision even for a destination inside the actor tenant.
    if (mutation.resource === 'egress_destination' && !hub && mutation.value?.require_prior_contact === false) {
      throw new ConfigurationError('forbidden', 'waiving prior contact on an egress destination requires the hub');
    }
    if (hub) return;
    // The registry resources (agent, provider_account, alias_routing_ceiling,
    // agent_account_binding) are absent from this list on purpose: lending a subscription is a
    // decision about somebody else's money, so it stays hub-only by the default-deny fall-through
    // below rather than by a rule a future edit could soften.
    //
    if (mutation.resource === 'room' || mutation.resource === 'membership'
      || mutation.resource === 'egress_destination') {
      if (mutation.tenant_id === actorTenant) return;
    } else if (mutation.resource === 'acl_edge') {
      if (mutation.from_tenant === actorTenant) return;
    }
    throw new ConfigurationError('forbidden', 'configuration resource is outside the actor tenant');
  }

  private async lockRevision(client: DatabaseClient, expected?: number): Promise<number> {
    await client.query(`SELECT pg_advisory_xact_lock(783_003_004)`);
    const selected = await client.query<{ revision: string }>(
      'SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions'
    );
    const revision = Number(selected.rows[0]?.revision ?? 0);
    if (expected !== undefined && revision !== expected) {
      throw new ConfigurationError('conflict', `configuration revision changed: expected ${expected}, current ${revision}`);
    }
    return revision;
  }

  private async audit(
    client: DatabaseClient,
    tenant: Tenant,
    alias: string,
    action: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
       VALUES($1,$2,$3,'allow',$4::jsonb)`, [tenant, alias, action, JSON.stringify(metadata)]
    );
  }
}
