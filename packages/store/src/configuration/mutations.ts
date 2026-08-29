import type { ConfigMutation, Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { egressDestinationColumns, type EgressDestinationRow } from '../repository/egress-destinations.js';
import { ConfigurationError } from './contracts.js';
import { has, valueRequired } from './shared.js';

const activeDeliveryStates = "('pending','retry','leased','accepted','started')";

/** The exact prior state, so a rollback restores every limit rather than a default. */
function destinationValue(row: EgressDestinationRow): Record<string, unknown> {
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

export abstract class ConfigurationMutations {
  protected async execute(
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
    if (mutation.resource === 'agent') return this.agent(client, mutation);
    if (mutation.resource === 'provider_account') return this.providerAccount(client, mutation);
    if (mutation.resource === 'alias_routing_ceiling') return this.routingCeiling(client, mutation);
    if (mutation.resource === 'agent_account_binding') return this.agentAccountBinding(client, mutation);
    return this.policy(client, mutation);
  }

  private async chainPolicy(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'chain_policy' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      progress_relay_enabled: boolean; progress_relay_max_events: number; cycle_cut_enabled: boolean;
      failure_coalesce_enabled: boolean; failure_coalesce_window_seconds: number;
      delegation_caps_enabled: boolean; max_fanout_per_turn: number;
      max_edge_repeats_per_root: number; max_delegations_per_root: number;
      human_gate_enabled: boolean;
    }>(
      // All five ceilings go in this SELECT or ROLLBACK drops them: `oldValue` is literally the
      // body of the inverse mutation, so a column not read here comes back absent and the
      // rollback `update` leaves it at its default. Rolling back a threshold change and moving
      // the OTHER four is worse than not having the button at all.
      `SELECT progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
              failure_coalesce_enabled,failure_coalesce_window_seconds,
              delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,
              max_delegations_per_root,human_gate_enabled
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
        ? value.cycle_cut_enabled as boolean : old.cycle_cut_enabled,
      failure_coalesce_enabled: has(value, 'failure_coalesce_enabled')
        ? value.failure_coalesce_enabled as boolean : old.failure_coalesce_enabled,
      failure_coalesce_window_seconds: has(value, 'failure_coalesce_window_seconds')
        ? value.failure_coalesce_window_seconds as number : old.failure_coalesce_window_seconds,
      delegation_caps_enabled: has(value, 'delegation_caps_enabled')
        ? value.delegation_caps_enabled as boolean : old.delegation_caps_enabled,
      max_fanout_per_turn: has(value, 'max_fanout_per_turn')
        ? value.max_fanout_per_turn as number : old.max_fanout_per_turn,
      max_edge_repeats_per_root: has(value, 'max_edge_repeats_per_root')
        ? value.max_edge_repeats_per_root as number : old.max_edge_repeats_per_root,
      max_delegations_per_root: has(value, 'max_delegations_per_root')
        ? value.max_delegations_per_root as number : old.max_delegations_per_root,
      human_gate_enabled: has(value, 'human_gate_enabled')
        ? value.human_gate_enabled as boolean : old.human_gate_enabled
    };
    await client.query(
      `UPDATE agent_chain_policies
       SET progress_relay_enabled=$2,progress_relay_max_events=$3,cycle_cut_enabled=$4,
           failure_coalesce_enabled=$5,failure_coalesce_window_seconds=$6,
           delegation_caps_enabled=$7,max_fanout_per_turn=$8,max_edge_repeats_per_root=$9,
           max_delegations_per_root=$10,human_gate_enabled=$11,updated_at=now()
       WHERE id=$1`,
      [mutation.id, next.progress_relay_enabled, next.progress_relay_max_events,
        next.cycle_cut_enabled, next.failure_coalesce_enabled, next.failure_coalesce_window_seconds,
        next.delegation_caps_enabled, next.max_fanout_per_turn, next.max_edge_repeats_per_root,
        next.max_delegations_per_root, next.human_gate_enabled]
    );
    return {
      inverse: {
        resource: 'chain_policy', action: 'update', id: mutation.id,
        value: {
          progress_relay_enabled: old.progress_relay_enabled,
          progress_relay_max_events: old.progress_relay_max_events,
          cycle_cut_enabled: old.cycle_cut_enabled,
          failure_coalesce_enabled: old.failure_coalesce_enabled,
          failure_coalesce_window_seconds: old.failure_coalesce_window_seconds,
          delegation_caps_enabled: old.delegation_caps_enabled,
          max_fanout_per_turn: old.max_fanout_per_turn,
          max_edge_repeats_per_root: old.max_edge_repeats_per_root,
          max_delegations_per_root: old.max_delegations_per_root,
          human_gate_enabled: old.human_gate_enabled
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
    const selected = await client.query<EgressDestinationRow>(
      `SELECT ${egressDestinationColumns} FROM egress_destinations
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
    const next = (field: keyof EgressDestinationRow): unknown => has(value, field) ? value[field] : old[field];
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

  private async agent(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'agent' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const key = `${mutation.tenant_id}/${mutation.alias}`;
    const selected = await client.query<{
      harness_id: string | null; display_name: string | null; enabled: boolean;
      container_name: string | null; runtime_user: string | null;
      home_directory: string | null; state_directory: string | null; role_brief: string | null;
      max_concurrent_deliveries: number | null;
    }>(
      // Goes in this SELECT or ROLLBACK drops it: `oldValue` is the body of the inverse, and an
      // absent column comes back as undeclared. `NULL` here MEANS something — "no ceiling", the
      // emergency exit of migration 015 — so losing it on rollback does not leave the default
      // value: it puts a ceiling on an agent someone had deliberately uncapped.
      `SELECT harness_id,display_name,enabled,container_name,runtime_user,home_directory,
              state_directory,role_brief,max_concurrent_deliveries
       FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [mutation.tenant_id, mutation.alias]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'agent already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,role_brief,max_concurrent_deliveries)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [mutation.tenant_id, mutation.alias, value.harness_id ?? null, value.display_name ?? null,
          value.enabled ?? false, value.container_name ?? null, value.runtime_user ?? null,
          value.home_directory ?? null, value.state_directory ?? null, null,
          /*
           * `undefined` (undeclared) falls back to the column DEFAULT 2, which is what the fifteen
           * live aliases receive today. A DECLARED `null` is something else: it means "no ceiling",
           * the emergency exit of migration 015. Distinguishing them matters — collapsing them
           * would leave uncapped every agent created without naming the field.
           */
          has(value, 'max_concurrent_deliveries')
            ? value.max_concurrent_deliveries as number | null
            : 2]
      );
      return {
        inverse: { resource: 'agent', action: 'delete', tenant_id: mutation.tenant_id, alias: mutation.alias },
        summary: `create agent ${key}`
      };
    }
    if (!old) throw new ConfigurationError('not_found', 'agent was not found');
    const oldValue = {
      harness_id: old.harness_id,
      display_name: old.display_name,
      enabled: old.enabled,
      container_name: old.container_name,
      runtime_user: old.runtime_user,
      home_directory: old.home_directory,
      state_directory: old.state_directory,
      max_concurrent_deliveries: old.max_concurrent_deliveries,
    };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (
           (d.recipient_tenant=$1 AND d.recipient_alias=$2) OR (m.tenant_id=$1 AND m.actor_alias=$2)
         ) LIMIT 1`, [mutation.tenant_id, mutation.alias]
      );
      const liveLease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now() LIMIT 1`,
        [mutation.tenant_id, mutation.alias]
      );
      const profile = await client.query(
        `SELECT 1 FROM agent_profiles WHERE tenant_id=$1 AND alias=$2 LIMIT 1`,
        [mutation.tenant_id, mutation.alias],
      );
      if (active.rowCount || liveLease.rowCount || profile.rowCount || old.role_brief !== null) {
        throw new ConfigurationError(
          'conflict',
          'agent has active work, a live lease, or canonical profile state; disable it instead',
        );
      }
      await client.query('DELETE FROM agents WHERE tenant_id=$1 AND alias=$2', [mutation.tenant_id, mutation.alias]);
      return {
        inverse: { resource: 'agent', action: 'create', tenant_id: mutation.tenant_id, alias: mutation.alias, value: oldValue },
        summary: `delete agent ${key}`
      };
    }
    const value = valueRequired(mutation);
    const next = {
      harness_id: has(value, 'harness_id') ? value.harness_id as string | null : old.harness_id,
      display_name: has(value, 'display_name') ? value.display_name as string | null : old.display_name,
      enabled: has(value, 'enabled') ? value.enabled as boolean : old.enabled,
      container_name: has(value, 'container_name') ? value.container_name as string | null : old.container_name,
      runtime_user: has(value, 'runtime_user') ? value.runtime_user as string | null : old.runtime_user,
      home_directory: has(value, 'home_directory') ? value.home_directory as string | null : old.home_directory,
      state_directory: has(value, 'state_directory') ? value.state_directory as string | null : old.state_directory,
      max_concurrent_deliveries: has(value, 'max_concurrent_deliveries')
        ? value.max_concurrent_deliveries as number | null
        : old.max_concurrent_deliveries
    };
    await client.query(
      `UPDATE agents SET harness_id=$3,display_name=$4,enabled=$5,container_name=$6,runtime_user=$7,
         home_directory=$8,state_directory=$9,max_concurrent_deliveries=$10,
         updated_at=now()
       WHERE tenant_id=$1 AND alias=$2`,
      [mutation.tenant_id, mutation.alias, next.harness_id, next.display_name, next.enabled,
        next.container_name, next.runtime_user, next.home_directory, next.state_directory,
        next.max_concurrent_deliveries]
    );
    return {
      inverse: { resource: 'agent', action: 'update', tenant_id: mutation.tenant_id, alias: mutation.alias, value: oldValue },
      summary: `update agent ${key}`
    };
  }

  /**
   * A provider subscription. Identity, payer and credential locator are immutable: an account id
   * is referenced from alias_routing_ceiling, so silently repointing it at another subscription
   * would retroactively change what every existing loan means. Only the label, the pool
   * publication and the enabled flag can move.
   */
  private async providerAccount(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'provider_account' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      provider: string; external_account_id: string; payer_tenant_id: Tenant; label: string | null;
      credential_ref_kind: 'env_path' | 'file' | 'secret_manager'; credential_ref: string;
      shared_with_pool: boolean; enabled: boolean;
    }>(
      `SELECT provider,external_account_id,payer_tenant_id,label,credential_ref_kind,credential_ref,
              shared_with_pool,enabled
       FROM provider_accounts WHERE id=$1 FOR UPDATE`, [mutation.id]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'provider account already exists');
      const value = valueRequired(mutation);
      if (typeof value.provider !== 'string' || typeof value.external_account_id !== 'string' ||
          typeof value.payer_tenant_id !== 'string' || typeof value.credential_ref_kind !== 'string' ||
          typeof value.credential_ref !== 'string') {
        throw new ConfigurationError(
          'conflict',
          'provider_account create requires provider, external_account_id, payer_tenant_id, credential_ref_kind and credential_ref'
        );
      }
      await client.query(
        `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
           credential_ref_kind,credential_ref,shared_with_pool,enabled)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [mutation.id, value.provider, value.external_account_id, value.payer_tenant_id,
          value.label ?? null, value.credential_ref_kind, value.credential_ref,
          value.shared_with_pool ?? false, value.enabled ?? false]
      );
      return {
        inverse: { resource: 'provider_account', action: 'delete', id: mutation.id },
        summary: `create provider account ${mutation.id} paid by ${String(value.payer_tenant_id)}`
      };
    }
    if (!old) throw new ConfigurationError('not_found', 'provider account was not found');
    const oldValue = { ...old };
    if (mutation.action === 'delete') {
      // No explicit guard: alias_routing_ceiling holds a plain foreign key into this table, so
      // Postgres already refuses (23503) to delete an account any alias may still be routed to.
      await client.query('DELETE FROM provider_accounts WHERE id=$1', [mutation.id]);
      return {
        inverse: { resource: 'provider_account', action: 'create', id: mutation.id, value: oldValue },
        summary: `delete provider account ${mutation.id}`
      };
    }
    const value = valueRequired(mutation);
    if (has(value, 'provider') || has(value, 'external_account_id') || has(value, 'payer_tenant_id') ||
        has(value, 'credential_ref_kind') || has(value, 'credential_ref')) {
      throw new ConfigurationError(
        'conflict', 'provider_account identity and credential rotation require delete and create, not update'
      );
    }
    const next = {
      label: has(value, 'label') ? value.label as string | null : old.label,
      // Withdrawing an account from the pool while another tenant is still routed to it raises
      // 23503 from alias_routing_ceiling_borrow_requires_pool; databaseError() maps it to conflict.
      shared_with_pool: has(value, 'shared_with_pool') ? value.shared_with_pool as boolean : old.shared_with_pool,
      enabled: has(value, 'enabled') ? value.enabled as boolean : old.enabled
    };
    await client.query(
      `UPDATE provider_accounts SET label=$2,shared_with_pool=$3,enabled=$4,updated_at=now() WHERE id=$1`,
      [mutation.id, next.label, next.shared_with_pool, next.enabled]
    );
    return {
      inverse: {
        resource: 'provider_account', action: 'update', id: mutation.id,
        value: {
          label: oldValue.label, shared_with_pool: oldValue.shared_with_pool, enabled: oldValue.enabled
        }
      },
      summary: `update provider account ${mutation.id}`
    };
  }

  /** Granting or revoking an account for one alias. The payer mirror is read from
   *  provider_accounts here rather than accepted from the caller, so the row Postgres validates
   *  against the borrow guard is always the real payer. */
  private async routingCeiling(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'alias_routing_ceiling' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const identity = {
      resource: 'alias_routing_ceiling', tenant_id: mutation.tenant_id,
      alias: mutation.alias, account_id: mutation.account_id
    } as const;
    const key = `${mutation.tenant_id}/${mutation.alias} -> ${mutation.account_id}`;
    const selected = await client.query(
      `SELECT 1 FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.alias, mutation.account_id]
    );
    if (mutation.action === 'create') {
      if (selected.rowCount) throw new ConfigurationError('conflict', 'routing ceiling entry already exists');
      const account = await client.query<{ payer_tenant_id: Tenant }>(
        'SELECT payer_tenant_id FROM provider_accounts WHERE id=$1 FOR SHARE', [mutation.account_id]
      );
      const payer = account.rows[0]?.payer_tenant_id;
      if (!payer) throw new ConfigurationError('not_found', 'provider account was not found');
      await client.query(
        `INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
         VALUES($1,$2,$3,$4,$5)`,
        [mutation.tenant_id, mutation.alias, mutation.account_id, payer, mutation.tenant_id]
      );
      return { inverse: { ...identity, action: 'delete' }, summary: `grant routing ceiling ${key}` };
    }
    if (!selected.rowCount) throw new ConfigurationError('not_found', 'routing ceiling entry was not found');
    // agent_account_bindings cascades: revoking the ceiling withdraws the routing in one step.
    await client.query(
      'DELETE FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3',
      [mutation.tenant_id, mutation.alias, mutation.account_id]
    );
    return { inverse: { ...identity, action: 'create' }, summary: `revoke routing ceiling ${key}` };
  }

  private async agentAccountBinding(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'agent_account_binding' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const identity = {
      resource: 'agent_account_binding', tenant_id: mutation.tenant_id,
      agent_alias: mutation.agent_alias, account_id: mutation.account_id
    } as const;
    const key = `${mutation.tenant_id}/${mutation.agent_alias} -> ${mutation.account_id}`;
    const selected = await client.query<{ priority: number; enabled: boolean }>(
      `SELECT priority,enabled FROM agent_account_bindings
       WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.agent_alias, mutation.account_id]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'agent account binding already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
         VALUES($1,$2,$3,$4,$5)`,
        [mutation.tenant_id, mutation.agent_alias, mutation.account_id,
          value.priority ?? 100, value.enabled ?? false]
      );
      return { inverse: { ...identity, action: 'delete' }, summary: `create agent account binding ${key}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'agent account binding was not found');
    const oldValue = { priority: old.priority, enabled: old.enabled };
    if (mutation.action === 'delete') {
      await client.query(
        'DELETE FROM agent_account_bindings WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3',
        [mutation.tenant_id, mutation.agent_alias, mutation.account_id]
      );
      return {
        inverse: { ...identity, action: 'create', value: oldValue },
        summary: `delete agent account binding ${key}`
      };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE agent_account_bindings SET priority=$4,enabled=$5,updated_at=now()
       WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3`,
      [mutation.tenant_id, mutation.agent_alias, mutation.account_id,
        has(value, 'priority') ? value.priority as number : old.priority,
        has(value, 'enabled') ? value.enabled as boolean : old.enabled]
    );
    return {
      inverse: { ...identity, action: 'update', value: oldValue },
      summary: `update agent account binding ${key}`
    };
  }
}
