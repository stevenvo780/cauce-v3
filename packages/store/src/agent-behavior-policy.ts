import {
  AgentBehaviorPolicyV1Schema, AgentBehaviorPolicyValueV1Schema,
  type AgentBehaviorPolicyV1, type ConfigMutation, type Tenant,
} from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { ConfigurationError } from './configuration/contracts.js';

type PolicyMutation = Extract<ConfigMutation, { resource: 'agent_behavior_policy' }>;
interface PolicyScope { tenant_id: Tenant; room_id: string; alias: string }

export async function latestBehaviorPolicyOperation(client: DatabaseClient, scope: PolicyScope) {
  const result = await client.query<{ id: string; operation: PolicyMutation }>(
    `SELECT id::text,operation FROM config_revisions
     WHERE operation->>'resource'='agent_behavior_policy'
       AND operation->>'tenant_id'=$1 AND operation->>'room_id'=$2 AND operation->>'alias'=$3
     ORDER BY config_revisions.id DESC LIMIT 1`, [scope.tenant_id, scope.room_id, scope.alias],
  );
  return result.rows[0];
}

export async function assertBehaviorPolicyDestinations(
  client: DatabaseClient, scope: PolicyScope, value: PolicyMutation['value'],
): Promise<void> {
  const consumer = await client.query(
    `SELECT 1 FROM memberships member
     JOIN tenants tenant ON tenant.id=member.tenant_id
     JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
     JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
     JOIN role_policies role ON role.role=member.role
     WHERE member.tenant_id=$1 AND member.room_id=$2 AND member.alias=$3
       AND member.enabled AND tenant.enabled AND room.enabled AND agent.enabled AND role.allow_route
     FOR SHARE OF member,tenant,room,agent,role`,
    [scope.tenant_id, scope.room_id, scope.alias],
  );
  if (consumer.rows.length === 0) throw new ConfigurationError('forbidden', 'policy consumer requires an enabled room and route role');
  const targets = [value?.escalation?.infrastructure, value?.escalation?.coordinator];
  for (const target of targets) {
    if (target === undefined) continue;
    const permitted = await client.query(
      `SELECT 1 FROM memberships member
       JOIN tenants target ON target.id=member.tenant_id
       JOIN tenants source ON source.id=$1
       JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
       JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
       JOIN role_policies role ON role.role=member.role
       WHERE member.tenant_id=$2 AND member.alias=$3 AND member.enabled AND target.enabled
         AND source.enabled AND room.enabled AND agent.enabled AND role.allow_route
         AND (member.tenant_id<>$1 OR member.room_id=$4)
         AND (member.tenant_id=$1 OR ((source.is_hub OR target.is_hub) AND EXISTS (
           SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
             AND edge.enabled AND edge.allow_route))) LIMIT 1`,
      [scope.tenant_id, target.tenant_id, target.alias, scope.room_id],
    );
    if (permitted.rows.length === 0) throw new ConfigurationError('forbidden', 'policy escalation destination is not currently routable');
  }
  if (value?.supervision_notice === undefined) return;
  const issuer = await client.query(
    `SELECT 1 FROM memberships member
     JOIN tenants tenant ON tenant.id=member.tenant_id
     JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
     JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
     JOIN role_policies role ON role.role=member.role
     WHERE member.tenant_id=$1 AND member.room_id=$2 AND member.alias=$3
       AND member.enabled AND tenant.enabled AND room.enabled AND agent.enabled AND role.allow_route
     FOR SHARE OF member,tenant,room,agent,role`,
    [scope.tenant_id, scope.room_id, value.supervision_notice.issuer_alias],
  );
  if (issuer.rows.length === 0) throw new ConfigurationError('forbidden', 'supervision issuer is not an enabled member of the consumer room');
  const destination = await client.query(
    `SELECT 1 FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3
       AND enabled AND allow_kinds && ARRAY['decision_request','digest','alert']::text[]`,
    [scope.tenant_id, scope.alias, value.supervision_notice.egress_handle],
  );
  if (destination.rows.length === 0) throw new ConfigurationError('forbidden', 'supervision egress is not enabled for the consumer');
}

export async function behaviorPolicyMutation(client: DatabaseClient, mutation: PolicyMutation) {
  const previous = await latestBehaviorPolicyOperation(client, mutation);
  const old = previous?.operation.action === 'delete' ? undefined : previous?.operation.value;
  if (mutation.action === 'create' && old !== undefined) throw new ConfigurationError('conflict', 'behavior policy already exists');
  if (mutation.action !== 'create' && old === undefined) throw new ConfigurationError('not_found', 'behavior policy was not found');
  if (mutation.action !== 'delete') {
    const parsed = AgentBehaviorPolicyValueV1Schema.safeParse(mutation.value);
    if (!parsed.success) throw new ConfigurationError('invalid_input', 'behavior policy requires a complete strict value');
    await assertBehaviorPolicyDestinations(client, mutation, parsed.data);
  } else if (mutation.value !== undefined) {
    throw new ConfigurationError('invalid_input', 'deleting a behavior policy does not accept a value');
  }
  const inverse: PolicyMutation = old === undefined
    ? { resource: mutation.resource, action: 'delete', tenant_id: mutation.tenant_id, room_id: mutation.room_id, alias: mutation.alias }
    : { resource: mutation.resource, action: mutation.action === 'delete' ? 'create' : 'update', tenant_id: mutation.tenant_id, room_id: mutation.room_id, alias: mutation.alias, value: old };
  return { inverse, summary: `${mutation.action} behavior policy ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
}

export async function readAgentBehaviorPolicy(
  client: DatabaseClient, scope: PolicyScope,
): Promise<AgentBehaviorPolicyV1 | undefined> {
  const latest = await latestBehaviorPolicyOperation(client, scope);
  if (latest === undefined || latest.operation.action === 'delete') return undefined;
  const parsed = AgentBehaviorPolicyV1Schema.safeParse({ ...latest.operation.value, revision: latest.id, scope });
  if (!parsed.success) return undefined;
  try {
    await assertBehaviorPolicyDestinations(client, scope, parsed.data);
  } catch (error) {
    if (error instanceof ConfigurationError) return undefined;
    throw error;
  }
  return parsed.data;
}

export async function desiredBehaviorPolicies(client: Pick<DatabaseClient, 'query'>, tenant: Tenant | null) {
  const result = await client.query<{ id: string; operation: ConfigMutation }>(
    `SELECT id::text,operation FROM (
       SELECT DISTINCT ON (operation->>'tenant_id',operation->>'room_id',operation->>'alias') id,operation
       FROM config_revisions WHERE operation->>'resource'='agent_behavior_policy'
         AND ($1::text IS NULL OR operation->>'tenant_id'=$1)
       ORDER BY operation->>'tenant_id',operation->>'room_id',operation->>'alias',id DESC
     ) latest`, [tenant],
  );
  return result.rows.flatMap(({ id, operation }) => {
    if (operation.resource !== 'agent_behavior_policy' || operation.action === 'delete') return [];
    return [AgentBehaviorPolicyV1Schema.parse({
      ...operation.value, revision: id,
      scope: { tenant_id: operation.tenant_id, room_id: operation.room_id, alias: operation.alias },
    })];
  });
}
