import type { ConfigMutation } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { ConfigurationError, type ConfigurationLeafMutation } from '../contracts.js';
import { assertConfigurationDeleteAllowed, has, valueRequired } from '../shared.js';

export const activeDeliveryStates = "('pending','retry','leased','accepted','started')";

export async function tenantMutation(
  client: DatabaseClient, mutation: Extract<ConfigurationLeafMutation, { resource: 'tenant' }>
): Promise<{ inverse: ConfigMutation; summary: string }> {
  const selected = await client.query<{
    id: string; display_name: string | null; is_hub: boolean; enabled: boolean;
    retired_at: string | null; retired_enabled: boolean | null;
  }>(`SELECT id,display_name,is_hub,enabled,to_jsonb(tenants)->>'retired_at' AS retired_at,
    (to_jsonb(tenants)->>'retired_enabled')::boolean AS retired_enabled FROM tenants WHERE id=$1 FOR UPDATE`, [mutation.id]);
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
  const retirement = await retirementMutation(client, mutation, old);
  if (retirement) return retirement;
  const oldValue = { display_name: old.display_name, is_hub: old.is_hub, enabled: old.enabled };
  if (mutation.action === 'delete') {
    await assertConfigurationDeleteAllowed(client, mutation);
    const active = await client.query(
      `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (m.tenant_id=$1 OR d.recipient_tenant=$1) LIMIT 1`, [mutation.id]
    );
    if (active.rowCount) throw new ConfigurationError('conflict', 'tenant has active deliveries');
    await client.query('DELETE FROM tenants WHERE id=$1', [mutation.id]);
    return { inverse: deletionInverse(mutation, oldValue, old), summary: `delete tenant ${mutation.id}` };
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

export async function roomMutation(
  client: DatabaseClient, mutation: Extract<ConfigurationLeafMutation, { resource: 'room' }>
): Promise<{ inverse: ConfigMutation; summary: string }> {
  const selected = await client.query<{
    id: string; tenant_id: string; display_name: string | null; enabled: boolean;
    retired_at: string | null; retired_enabled: boolean | null;
  }>(`SELECT id,tenant_id,display_name,enabled,to_jsonb(rooms)->>'retired_at' AS retired_at,
    (to_jsonb(rooms)->>'retired_enabled')::boolean AS retired_enabled FROM rooms WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [mutation.id, mutation.tenant_id]);
  const old = selected.rows[0];
  if (mutation.action === 'create') {
    if (old) throw new ConfigurationError('conflict', 'room already exists');
    const value = valueRequired(mutation);
    await client.query('INSERT INTO rooms(id,tenant_id,display_name,enabled) VALUES($1,$2,$3,$4)',
      [mutation.id, mutation.tenant_id, value.display_name ?? null, value.enabled ?? true]);
    return { inverse: { resource: 'room', action: 'delete', tenant_id: mutation.tenant_id, id: mutation.id }, summary: `create room ${mutation.id}` };
  }
  if (!old) throw new ConfigurationError('not_found', 'room was not found');
  const retirement = await retirementMutation(client, mutation, old);
  if (retirement) return retirement;
  const oldValue = { display_name: old.display_name, enabled: old.enabled };
  if (mutation.action === 'delete') {
    await assertConfigurationDeleteAllowed(client, mutation);
    const active = await client.query(
      `SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id
         WHERE m.tenant_id=$1 AND m.room_id=$2 AND d.status IN ${activeDeliveryStates} LIMIT 1`,
      [mutation.tenant_id, mutation.id]
    );
    if (active.rowCount) throw new ConfigurationError('conflict', 'room has active deliveries');
    await client.query('DELETE FROM rooms WHERE id=$1 AND tenant_id=$2', [mutation.id, mutation.tenant_id]);
    return { inverse: deletionInverse(mutation, oldValue, old), summary: `delete room ${mutation.id}` };
  }
  const value = valueRequired(mutation);
  await client.query('UPDATE rooms SET display_name=$3,enabled=$4 WHERE id=$1 AND tenant_id=$2', [
    mutation.id, mutation.tenant_id,
    has(value, 'display_name') ? value.display_name : old.display_name,
    has(value, 'enabled') ? value.enabled : old.enabled
  ]);
  return { inverse: { resource: 'room', action: 'update', tenant_id: mutation.tenant_id, id: mutation.id, value: oldValue }, summary: `update room ${mutation.id}` };
}

export async function membershipMutation(
  client: DatabaseClient, mutation: Extract<ConfigurationLeafMutation, { resource: 'membership' }>
): Promise<{ inverse: ConfigMutation; summary: string }> {
  const selected = await client.query<{ role: string; enabled: boolean; retired_at: string | null; retired_enabled: boolean | null }>(
    `SELECT role,enabled,to_jsonb(memberships)->>'retired_at' AS retired_at,
      (to_jsonb(memberships)->>'retired_enabled')::boolean AS retired_enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3 FOR UPDATE`,
    [mutation.tenant_id, mutation.room_id, mutation.alias]
  );
  const old = selected.rows[0];
  const physical = (await client.query<{ runtime_key: string | null }>(
    "SELECT to_jsonb(agents)->>'runtime_key' AS runtime_key FROM agents WHERE tenant_id=$1 AND alias=$2 FOR SHARE",
    [mutation.tenant_id, mutation.alias])).rows[0];
  if (physical?.runtime_key && !(mutation.action === 'update' && old && mutation.value?.enabled === false
      && (mutation.value.role === undefined || mutation.value.role === old.role))) {
    throw new ConfigurationError('conflict', 'physical agent membership changes require a verified fleet operation');
  }
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
  const retirement = await retirementMutation(client, mutation, old);
  if (retirement) return retirement;
  const oldValue = { role: old.role, enabled: old.enabled };
  if (mutation.action === 'delete') {
    await assertConfigurationDeleteAllowed(client, mutation);
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
    return { inverse: deletionInverse(mutation, oldValue, old), summary: `delete membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
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

export async function aclEdgeMutation(
  client: DatabaseClient, mutation: Extract<ConfigurationLeafMutation, { resource: 'acl_edge' }>
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
    await assertConfigurationDeleteAllowed(client, mutation);
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

type RetirableMutation = Extract<ConfigurationLeafMutation, { resource: 'tenant' | 'room' | 'membership' }>;

async function retirementMutation(
  client: DatabaseClient, mutation: RetirableMutation,
  old: { enabled: boolean; retired_at: string | null; retired_enabled: boolean | null },
): Promise<{ inverse: ConfigMutation; summary: string } | null> {
  if (mutation.action !== 'retire' && mutation.action !== 'restore') {
    if (old.retired_at && mutation.action !== 'delete') {
      throw new ConfigurationError('conflict', 'retired configuration must be restored before updating');
    }
    return null;
  }
  const retiring = mutation.action === 'retire';
  if (retiring === Boolean(old.retired_at)) throw new ConfigurationError('conflict', retiring ? 'configuration is already retired' : 'configuration is not retired');
  const keys = mutation.resource === 'tenant' ? [mutation.id]
    : mutation.resource === 'room' ? [mutation.id, mutation.tenant_id]
      : [mutation.tenant_id, mutation.room_id, mutation.alias];
  const predicate = mutation.resource === 'tenant' ? 'id=$1'
    : mutation.resource === 'room' ? 'id=$1 AND tenant_id=$2'
      : 'tenant_id=$1 AND room_id=$2 AND alias=$3';
  const table = mutation.resource === 'tenant' ? 'tenants' : mutation.resource === 'room' ? 'rooms' : 'memberships';
  const offset = keys.length;
  if (!retiring && old.retired_enabled === null) throw new ConfigurationError('conflict', 'configuration retirement state is incomplete');
  await client.query(
    `UPDATE ${table} SET enabled=$${String(offset + 1)},retired_at=$${String(offset + 2)}::timestamptz,retired_enabled=$${String(offset + 3)} WHERE ${predicate}`,
    [...keys, retiring ? false : old.retired_enabled, retiring ? new Date().toISOString() : null, retiring ? old.enabled : null],
  );
  return { inverse: { ...mutation, action: retiring ? 'restore' : 'retire' }, summary: `${mutation.action} ${mutation.resource} ${keys.join('/')}` };
}

function deletionInverse(
  mutation: RetirableMutation, value: Record<string, unknown>,
  old: { enabled: boolean; retired_at: string | null; retired_enabled: boolean | null },
): ConfigMutation {
  const { value: discardedValue, ...identity } = mutation;
  void discardedValue;
  const create = { ...identity, action: 'create', value: { ...value, enabled: old.retired_at ? old.retired_enabled : old.enabled } } as ConfigurationLeafMutation;
  if (!old.retired_at) return create;
  return { resource: 'batch', action: 'apply', mutations: [create, { ...identity, action: 'retire' }] };
}
