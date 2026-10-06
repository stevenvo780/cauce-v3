import { SYSTEM_PRINCIPAL_ALIASES, type PublishMessage, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import type { PublishOptions } from './repository/messages/contracts.js';
import { StoreError } from './repository/errors.js';

export function authenticatedGateProbe(input: PublishMessage, options: PublishOptions): boolean {
  const rawAuthority: unknown = options.systemGateProbeAuthority;
  if (typeof rawAuthority !== 'object' || rawAuthority === null) return false;
  const authority = rawAuthority as Record<string, unknown>;
  const context = input.authenticated_context;
  return Object.keys(authority).length === 4 && authority.tenant_id === input.tenant_id
    && authority.alias === 'gate-probe' && authority.session_id === 'gate-probe'
    && authority.channel === 'gate' && context?.session_id === authority.session_id
    && context.channel === authority.channel && context.origin === undefined && input.origin === undefined;
}

export async function gateProbeRuntimeActor(
  client: DatabaseClient, tenant: Tenant, room: string | undefined, alias?: string,
): Promise<string> {
  const result = await client.query<{ alias: string }>(
    `SELECT member.alias FROM memberships member
     JOIN tenants tenant ON tenant.id=member.tenant_id
     JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
     JOIN role_policies role ON role.role=member.role
     JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
     WHERE member.tenant_id=$1 AND ($2::text IS NULL OR member.room_id=$2)
       AND ($3::text IS NULL OR member.alias=$3) AND NOT (member.alias=ANY($4::text[]))
       AND member.enabled AND tenant.enabled AND room.enabled AND role.allow_route AND agent.enabled
     ORDER BY member.alias,member.room_id LIMIT 1 FOR SHARE OF member,tenant,room,role,agent`,
    [tenant, room ?? null, alias ?? null, SYSTEM_PRINCIPAL_ALIASES],
  );
  const actor = result.rows[0]?.alias;
  if (actor === undefined) throw new StoreError('forbidden', 'gate probe requires an enabled routable runtime in its authorized scope');
  return actor;
}
