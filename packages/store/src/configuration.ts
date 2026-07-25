import type { ConfigMutation, Tenant } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';

export type ConfigurationErrorCode = 'forbidden' | 'conflict' | 'not_found';

export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface ConfigurationChangeResult {
  applied: boolean;
  dry_run: boolean;
  revision: number;
  summary: string;
  mutation: ConfigMutation;
  inverse_mutation: ConfigMutation;
}

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

const activeDeliveryStates = "('pending','retry','leased','accepted','started')";

interface DestinationRow {
  adapter: string;
  channel: string;
  conversation_id: string;
  conversation_kind: 'dm' | 'group';
  display_label: string | null;
  allow_kinds: string[];
  require_prior_contact: boolean;
  contact_ttl_days: number;
  min_interval_seconds: number;
  max_per_hour: number;
  max_per_day: number;
  max_per_root: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  quiet_hours_tz: string;
  enabled: boolean;
}

const destinationColumns = `adapter,channel,conversation_id,conversation_kind,display_label,allow_kinds,
  require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,max_per_day,max_per_root,
  quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled`;

/** The exact prior state, so a rollback restores every limit rather than a default. */
function destinationValue(row: DestinationRow): Record<string, unknown> {
  return {
    adapter: row.adapter, channel: row.channel, conversation_id: row.conversation_id,
    conversation_kind: row.conversation_kind, display_label: row.display_label,
    allow_kinds: row.allow_kinds, require_prior_contact: row.require_prior_contact,
    contact_ttl_days: row.contact_ttl_days, min_interval_seconds: row.min_interval_seconds,
    max_per_hour: row.max_per_hour, max_per_day: row.max_per_day, max_per_root: row.max_per_root,
    quiet_hours_start: row.quiet_hours_start, quiet_hours_end: row.quiet_hours_end,
    quiet_hours_tz: row.quiet_hours_tz, enabled: row.enabled
  };
}

class RollbackResult<T> extends Error {
  constructor(readonly result: T) {
    super('configuration preview rollback');
  }
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function valueRequired(mutation: ConfigMutation): Record<string, unknown> {
  if (mutation.action === 'delete') return {};
  if (!mutation.value) throw new ConfigurationError('conflict', `${mutation.resource} ${mutation.action} requires value`);
  return mutation.value;
}

function databaseError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['23503', '23505', '23514', '23P01'].includes(code)) {
    throw new ConfigurationError('conflict', 'configuration change violates a durable constraint');
  }
  throw error;
}

export class ConfigurationRepository {
  constructor(private readonly pool: DatabasePool) {}

  async get(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    const hub = await withTransaction(this.pool, (client) => this.assertControl(client, actorTenant, actorAlias));
    const scope = hub ? null : actorTenant;
    const [
      revision, tenants, rooms, memberships, edges, harnesses, policies, chainPolicies, destinations, revisions
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
          `SELECT id,progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,updated_at
           FROM agent_chain_policies ORDER BY id`
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT id::text,actor_tenant,actor_alias,operation,summary,rolled_back_revision_id::text,created_at
           FROM config_revisions WHERE $1::text IS NULL OR actor_tenant=$1 ORDER BY id DESC LIMIT 100`, [scope]
        )
    ]);
    return {
      revision: Number(revision.rows[0]?.revision ?? 0), observed_at: new Date().toISOString(),
      tenants: tenants.rows, rooms: rooms.rows, memberships: memberships.rows,
      acl_edges: edges.rows, harness_definitions: harnesses.rows, role_policies: policies.rows,
      chain_policies: chainPolicies.rows,
      egress_destinations: destinations.rows,
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
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const hub = await this.assertControl(client, actorTenant, actorAlias);
      this.authorizeMutation(mutation, actorTenant, hub);
      const revision = await this.lockRevision(client, expectedRevision);
      const { inverse, summary } = await this.execute(client, mutation);
      await this.assertControl(client, actorTenant, actorAlias);
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision, summary, mutation, inverse_mutation: inverse
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
        applied: true, dry_run: false, revision: nextRevision, summary, mutation, inverse_mutation: inverse
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
      this.authorizeMutation(original.inverse_operation, actorTenant, hub);
      const { inverse: redo, summary } = await this.execute(client, original.inverse_operation);
      await this.assertControl(client, actorTenant, actorAlias);
      const rollbackSummary = `rollback ${revisionId}: ${summary}`;
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision: currentRevision, summary: rollbackSummary,
          mutation: original.inverse_operation, inverse_mutation: redo
        }, rollback: true };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO config_revisions(
           actor_tenant,actor_alias,operation,inverse_operation,summary,rolled_back_revision_id
         ) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6) RETURNING id::text`,
        [actorTenant, actorAlias, JSON.stringify(original.inverse_operation), JSON.stringify(redo),
          rollbackSummary, revisionId]
      );
      const nextRevision = Number(inserted.rows[0]!.id);
      await this.audit(client, actorTenant, actorAlias, 'config.rollback', {
        revision: nextRevision, rolled_back_revision: revisionId, mutation: original.inverse_operation
      });
      return { result: {
        applied: true, dry_run: false, revision: nextRevision, summary: rollbackSummary,
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

  private authorizeMutation(mutation: ConfigMutation, actorTenant: Tenant, hub: boolean): void {
    // Waiving prior contact means writing to a group nobody in it ever addressed.
    // That is a hub-only decision even for a destination inside the actor tenant.
    if (mutation.resource === 'egress_destination' && !hub && mutation.value?.require_prior_contact === false) {
      throw new ConfigurationError('forbidden', 'waiving prior contact on an egress destination requires the hub');
    }
    if (hub) return;
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

  private async execute(
    client: DatabaseClient,
    mutation: ConfigMutation
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    if (mutation.resource === 'tenant') return this.tenant(client, mutation);
    if (mutation.resource === 'room') return this.room(client, mutation);
    if (mutation.resource === 'membership') return this.membership(client, mutation);
    if (mutation.resource === 'acl_edge') return this.edge(client, mutation);
    if (mutation.resource === 'harness') return this.harness(client, mutation);
    if (mutation.resource === 'chain_policy') return this.chainPolicy(client, mutation);
    if (mutation.resource === 'egress_destination') return this.destination(client, mutation);
    return this.policy(client, mutation);
  }

  private async chainPolicy(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'chain_policy' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      progress_relay_enabled: boolean; progress_relay_max_events: number; cycle_cut_enabled: boolean;
    }>(
      `SELECT progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled
       FROM agent_chain_policies WHERE id=$1 FOR UPDATE`, [mutation.id]
    );
    const old = selected.rows[0];
    if (!old) throw new ConfigurationError('not_found', 'chain policy was not found');
    const value = valueRequired(mutation);
    const next = {
      progress_relay_enabled: has(value, 'progress_relay_enabled')
        ? value.progress_relay_enabled as boolean : old.progress_relay_enabled,
      progress_relay_max_events: has(value, 'progress_relay_max_events')
        ? value.progress_relay_max_events as number : old.progress_relay_max_events,
      cycle_cut_enabled: has(value, 'cycle_cut_enabled')
        ? value.cycle_cut_enabled as boolean : old.cycle_cut_enabled
    };
    await client.query(
      `UPDATE agent_chain_policies
       SET progress_relay_enabled=$2,progress_relay_max_events=$3,cycle_cut_enabled=$4,updated_at=now()
       WHERE id=$1`,
      [mutation.id, next.progress_relay_enabled, next.progress_relay_max_events, next.cycle_cut_enabled]
    );
    return {
      inverse: {
        resource: 'chain_policy', action: 'update', id: mutation.id,
        value: {
          progress_relay_enabled: old.progress_relay_enabled,
          progress_relay_max_events: old.progress_relay_max_events,
          cycle_cut_enabled: old.cycle_cut_enabled
        }
      },
      summary: `update chain policy ${mutation.id}`
    };
  }

  private async tenant(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'tenant' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      id: string; display_name: string | null; is_hub: boolean; enabled: boolean;
    }>('SELECT id,display_name,is_hub,enabled FROM tenants WHERE id=$1 FOR UPDATE', [mutation.id]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'tenant already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO tenants(id,display_name,is_hub,enabled) VALUES($1,$2,$3,$4)`,
        [mutation.id, value.display_name ?? null, value.is_hub ?? false, value.enabled ?? true]
      );
      return { inverse: { resource: 'tenant', action: 'delete', id: mutation.id }, summary: `create tenant ${mutation.id}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'tenant was not found');
    const oldValue = { display_name: old.display_name, is_hub: old.is_hub, enabled: old.enabled };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (m.tenant_id=$1 OR d.recipient_tenant=$1) LIMIT 1`, [mutation.id]
      );
      if (active.rowCount) throw new ConfigurationError('conflict', 'tenant has active deliveries');
      await client.query('DELETE FROM tenants WHERE id=$1', [mutation.id]);
      return { inverse: { resource: 'tenant', action: 'create', id: mutation.id, value: oldValue }, summary: `delete tenant ${mutation.id}` };
    }
    const value = valueRequired(mutation);
    const next = {
      display_name: has(value, 'display_name') ? value.display_name as string | null : old.display_name,
      is_hub: has(value, 'is_hub') ? value.is_hub as boolean : old.is_hub,
      enabled: has(value, 'enabled') ? value.enabled as boolean : old.enabled
    };
    await client.query('UPDATE tenants SET display_name=$2,is_hub=$3,enabled=$4 WHERE id=$1',
      [mutation.id, next.display_name, next.is_hub, next.enabled]);
    return { inverse: { resource: 'tenant', action: 'update', id: mutation.id, value: oldValue }, summary: `update tenant ${mutation.id}` };
  }

  private async room(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'room' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      id: string; tenant_id: string; display_name: string | null; enabled: boolean;
    }>('SELECT id,tenant_id,display_name,enabled FROM rooms WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [mutation.id, mutation.tenant_id]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'room already exists');
      const value = valueRequired(mutation);
      await client.query('INSERT INTO rooms(id,tenant_id,display_name,enabled) VALUES($1,$2,$3,$4)',
        [mutation.id, mutation.tenant_id, value.display_name ?? null, value.enabled ?? true]);
      return { inverse: { resource: 'room', action: 'delete', tenant_id: mutation.tenant_id, id: mutation.id }, summary: `create room ${mutation.id}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'room was not found');
    const oldValue = { display_name: old.display_name, enabled: old.enabled };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id
         WHERE m.tenant_id=$1 AND m.room_id=$2 AND d.status IN ${activeDeliveryStates} LIMIT 1`,
        [mutation.tenant_id, mutation.id]
      );
      if (active.rowCount) throw new ConfigurationError('conflict', 'room has active deliveries');
      await client.query('DELETE FROM rooms WHERE id=$1 AND tenant_id=$2', [mutation.id, mutation.tenant_id]);
      return { inverse: { resource: 'room', action: 'create', tenant_id: mutation.tenant_id, id: mutation.id, value: oldValue }, summary: `delete room ${mutation.id}` };
    }
    const value = valueRequired(mutation);
    await client.query('UPDATE rooms SET display_name=$3,enabled=$4 WHERE id=$1 AND tenant_id=$2', [
      mutation.id, mutation.tenant_id,
      has(value, 'display_name') ? value.display_name : old.display_name,
      has(value, 'enabled') ? value.enabled : old.enabled
    ]);
    return { inverse: { resource: 'room', action: 'update', tenant_id: mutation.tenant_id, id: mutation.id, value: oldValue }, summary: `update room ${mutation.id}` };
  }

  private async membership(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'membership' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{ role: string; enabled: boolean }>(
      `SELECT role,enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.room_id, mutation.alias]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'membership already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES($1,$2,$3,$4,$5)`,
        [mutation.tenant_id, mutation.room_id, mutation.alias, value.role ?? 'agent', value.enabled ?? true]
      );
      return { inverse: {
        resource: 'membership', action: 'delete', tenant_id: mutation.tenant_id,
        room_id: mutation.room_id, alias: mutation.alias
      }, summary: `create membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'membership was not found');
    const oldValue = { role: old.role, enabled: old.enabled };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (
           (d.recipient_tenant=$1 AND d.recipient_alias=$3) OR
           (m.tenant_id=$1 AND m.room_id=$2 AND m.actor_alias=$3)
         ) LIMIT 1`, [mutation.tenant_id, mutation.room_id, mutation.alias]
      );
      const liveLease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now() LIMIT 1`,
        [mutation.tenant_id, mutation.alias]
      );
      if (active.rowCount || liveLease.rowCount) throw new ConfigurationError('conflict', 'membership has active deliveries or a live lease');
      await client.query('DELETE FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
        [mutation.tenant_id, mutation.room_id, mutation.alias]);
      return { inverse: {
        resource: 'membership', action: 'create', tenant_id: mutation.tenant_id,
        room_id: mutation.room_id, alias: mutation.alias, value: oldValue
      }, summary: `delete membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE memberships SET role=$4,enabled=$5 WHERE tenant_id=$1 AND room_id=$2 AND alias=$3`,
      [mutation.tenant_id, mutation.room_id, mutation.alias,
        has(value, 'role') ? value.role : old.role, has(value, 'enabled') ? value.enabled : old.enabled]
    );
    return { inverse: {
      resource: 'membership', action: 'update', tenant_id: mutation.tenant_id,
      room_id: mutation.room_id, alias: mutation.alias, value: oldValue
    }, summary: `update membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
  }

  private async edge(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'acl_edge' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    if (mutation.from_tenant === mutation.to_tenant) throw new ConfigurationError('conflict', 'self ACL edges are forbidden');
    const selected = await client.query<{
      enabled: boolean; allow_route: boolean; allow_read: boolean; allow_control: boolean;
    }>('SELECT enabled,allow_route,allow_read,allow_control FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2 FOR UPDATE',
      [mutation.from_tenant, mutation.to_tenant]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'ACL edge already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [mutation.from_tenant, mutation.to_tenant, value.enabled ?? true,
          value.allow_route ?? false, value.allow_read ?? false, value.allow_control ?? false]
      );
      return { inverse: { resource: 'acl_edge', action: 'delete', from_tenant: mutation.from_tenant, to_tenant: mutation.to_tenant }, summary: `create ACL ${mutation.from_tenant}->${mutation.to_tenant} default-deny` };
    }
    if (!old) throw new ConfigurationError('not_found', 'ACL edge was not found');
    const oldValue = { enabled: old.enabled, allow_route: old.allow_route, allow_read: old.allow_read, allow_control: old.allow_control };
    if (mutation.action === 'delete') {
      await client.query('DELETE FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [mutation.from_tenant, mutation.to_tenant]);
      return { inverse: {
        resource: 'acl_edge', action: 'create', from_tenant: mutation.from_tenant,
        to_tenant: mutation.to_tenant, value: oldValue
      }, summary: `delete ACL ${mutation.from_tenant}->${mutation.to_tenant}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE acl_edges SET enabled=$3,allow_route=$4,allow_read=$5,allow_control=$6
       WHERE from_tenant=$1 AND to_tenant=$2`,
      [mutation.from_tenant, mutation.to_tenant,
        has(value, 'enabled') ? value.enabled : old.enabled,
        has(value, 'allow_route') ? value.allow_route : old.allow_route,
        has(value, 'allow_read') ? value.allow_read : old.allow_read,
        has(value, 'allow_control') ? value.allow_control : old.allow_control]
    );
    return { inverse: {
      resource: 'acl_edge', action: 'update', from_tenant: mutation.from_tenant,
      to_tenant: mutation.to_tenant, value: oldValue
    }, summary: `update ACL ${mutation.from_tenant}->${mutation.to_tenant}` };
  }

  private async harness(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'harness' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      display_name: string; command: string | null; capabilities: string[]; enabled: boolean;
    }>('SELECT display_name,command,capabilities,enabled FROM harness_definitions WHERE id=$1 FOR UPDATE', [mutation.id]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'harness definition already exists');
      const value = valueRequired(mutation);
      if (typeof value.display_name !== 'string') throw new ConfigurationError('conflict', 'harness display_name is required');
      await client.query(
        `INSERT INTO harness_definitions(id,display_name,command,capabilities,enabled)
         VALUES($1,$2,$3,$4::jsonb,$5)`,
        [mutation.id, value.display_name, value.command ?? null, JSON.stringify(value.capabilities ?? []), value.enabled ?? true]
      );
      return { inverse: { resource: 'harness', action: 'delete', id: mutation.id }, summary: `create harness ${mutation.id}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'harness definition was not found');
    const oldValue = { display_name: old.display_name, command: old.command, capabilities: old.capabilities, enabled: old.enabled };
    if (mutation.action === 'delete') {
      await client.query('DELETE FROM harness_definitions WHERE id=$1', [mutation.id]);
      return { inverse: { resource: 'harness', action: 'create', id: mutation.id, value: oldValue }, summary: `delete harness ${mutation.id}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE harness_definitions SET display_name=$2,command=$3,capabilities=$4::jsonb,enabled=$5,updated_at=now()
       WHERE id=$1`, [mutation.id,
        has(value, 'display_name') ? value.display_name : old.display_name,
        has(value, 'command') ? value.command : old.command,
        JSON.stringify(has(value, 'capabilities') ? value.capabilities : old.capabilities),
        has(value, 'enabled') ? value.enabled : old.enabled]
    );
    return { inverse: { resource: 'harness', action: 'update', id: mutation.id, value: oldValue }, summary: `update harness ${mutation.id}` };
  }

  private async policy(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'role_policy' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      allow_route: boolean; allow_read: boolean; allow_control: boolean; allow_notify: boolean;
    }>('SELECT allow_route,allow_read,allow_control,allow_notify FROM role_policies WHERE role=$1 FOR UPDATE', [mutation.role]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'role policy already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify) VALUES($1,$2,$3,$4,$5)`,
        [mutation.role, value.allow_route ?? false, value.allow_read ?? false, value.allow_control ?? false,
          value.allow_notify ?? false]
      );
      return { inverse: { resource: 'role_policy', action: 'delete', role: mutation.role }, summary: `create role policy ${mutation.role} default-deny` };
    }
    if (!old) throw new ConfigurationError('not_found', 'role policy was not found');
    const oldValue = {
      allow_route: old.allow_route, allow_read: old.allow_read,
      allow_control: old.allow_control, allow_notify: old.allow_notify
    };
    if (mutation.action === 'delete') {
      await client.query('DELETE FROM role_policies WHERE role=$1', [mutation.role]);
      return { inverse: { resource: 'role_policy', action: 'create', role: mutation.role, value: oldValue }, summary: `delete role policy ${mutation.role}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE role_policies SET allow_route=$2,allow_read=$3,allow_control=$4,allow_notify=$5 WHERE role=$1`,
      [mutation.role,
        has(value, 'allow_route') ? value.allow_route : old.allow_route,
        has(value, 'allow_read') ? value.allow_read : old.allow_read,
        has(value, 'allow_control') ? value.allow_control : old.allow_control,
        has(value, 'allow_notify') ? value.allow_notify : old.allow_notify]
    );
    return { inverse: { resource: 'role_policy', action: 'update', role: mutation.role, value: oldValue }, summary: `update role policy ${mutation.role}` };
  }

  /**
   * The proactive-egress allowlist. It lives in config_revisions like every other
   * ACL surface, so creating a destination has a preview, optimistic concurrency,
   * an audit event and an exact inverse operation for rollback.
   */
  private async destination(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'egress_destination' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const key = `${mutation.tenant_id}/${mutation.alias}/${mutation.handle}`;
    const selected = await client.query<DestinationRow>(
      `SELECT ${destinationColumns} FROM egress_destinations
       WHERE tenant_id=$1 AND alias=$2 AND handle=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.alias, mutation.handle]
    );
    const old = selected.rows[0];
    const identity = {
      resource: 'egress_destination' as const, tenant_id: mutation.tenant_id,
      alias: mutation.alias, handle: mutation.handle
    };
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'egress destination already exists');
      const value = valueRequired(mutation);
      if (typeof value.conversation_id !== 'string') {
        throw new ConfigurationError('conflict', 'egress destination conversation_id is required');
      }
      if (value.conversation_kind !== 'dm' && value.conversation_kind !== 'group') {
        throw new ConfigurationError('conflict', 'egress destination conversation_kind is required');
      }
      if (!Array.isArray(value.allow_kinds) || value.allow_kinds.length === 0) {
        throw new ConfigurationError('conflict', 'egress destination allow_kinds is required');
      }
      await client.query(
        `INSERT INTO egress_destinations(
           tenant_id,alias,handle,adapter,channel,conversation_id,conversation_kind,display_label,
           allow_kinds,require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,
           max_per_day,max_per_root,quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [mutation.tenant_id, mutation.alias, mutation.handle,
          value.adapter ?? 'telegram', value.channel ?? 'telegram',
          value.conversation_id, value.conversation_kind, value.display_label ?? null,
          value.allow_kinds, value.require_prior_contact ?? true,
          value.contact_ttl_days ?? 30, value.min_interval_seconds ?? 300,
          value.max_per_hour ?? 2, value.max_per_day ?? 8, value.max_per_root ?? 1,
          value.quiet_hours_start ?? null, value.quiet_hours_end ?? null,
          value.quiet_hours_tz ?? 'UTC', value.enabled ?? true]
      );
      return {
        inverse: { ...identity, action: 'delete' },
        summary: `create egress destination ${key}`
      };
    }
    if (!old) throw new ConfigurationError('not_found', 'egress destination was not found');
    const oldValue = destinationValue(old);
    if (mutation.action === 'delete') {
      await client.query(
        'DELETE FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3',
        [mutation.tenant_id, mutation.alias, mutation.handle]
      );
      return {
        inverse: { ...identity, action: 'create', value: oldValue },
        summary: `delete egress destination ${key}`
      };
    }
    const value = valueRequired(mutation);
    const next = (field: keyof DestinationRow): unknown => has(value, field) ? value[field] : old[field];
    await client.query(
      `UPDATE egress_destinations SET adapter=$4,channel=$5,conversation_id=$6,conversation_kind=$7,
         display_label=$8,allow_kinds=$9,require_prior_contact=$10,contact_ttl_days=$11,
         min_interval_seconds=$12,max_per_hour=$13,max_per_day=$14,max_per_root=$15,
         quiet_hours_start=$16,quiet_hours_end=$17,quiet_hours_tz=$18,enabled=$19
       WHERE tenant_id=$1 AND alias=$2 AND handle=$3`,
      [mutation.tenant_id, mutation.alias, mutation.handle,
        next('adapter'), next('channel'), next('conversation_id'), next('conversation_kind'),
        next('display_label'), next('allow_kinds'), next('require_prior_contact'),
        next('contact_ttl_days'), next('min_interval_seconds'), next('max_per_hour'),
        next('max_per_day'), next('max_per_root'), next('quiet_hours_start'),
        next('quiet_hours_end'), next('quiet_hours_tz'), next('enabled')]
    );
    return {
      inverse: { ...identity, action: 'update', value: oldValue },
      summary: `update egress destination ${key}`
    };
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
