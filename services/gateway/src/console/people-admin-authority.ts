import type { DatabaseClient } from '@cauce/store';
import { PeopleAdminError, type PeopleAdminActor, type PeopleAdminPerson } from './people-admin-schema.js';

export function peopleCompanyScopeSql(target: string, actorParameter = '$1'): string {
  return `${target} IN (SELECT owner.id FROM tenants owner JOIN tenants actor ON actor.company_id=owner.company_id
    WHERE actor.id=${actorParameter})`;
}
export async function assertPeopleCompany(client: DatabaseClient, targetTenant: string, actorTenant: string): Promise<void> {
  const result = await client.query(`SELECT id FROM tenants WHERE id=$1 AND ${peopleCompanyScopeSql('id', '$2')} FOR SHARE`, [targetTenant, actorTenant]);
  if (!result.rowCount) throw new PeopleAdminError('forbidden');
}

export async function assertPeopleAuthority(client: DatabaseClient, actor: PeopleAdminActor): Promise<void> {
  actor.signal?.throwIfAborted();
  let verified: { humanId: string; tenantId: string; actorAlias: string };
  try { verified = await actor.humanAuthority(client); } catch { throw new PeopleAdminError('forbidden'); }
  if (`console:${verified.humanId}` !== actor.subject || verified.tenantId !== actor.tenant_id || verified.actorAlias !== actor.alias) {
    throw new PeopleAdminError('forbidden');
  }
  const administrators = await effectivePeopleAdministrators(client, actor.tenant_id);
  if (!administrators.has(verified.humanId)) throw new PeopleAdminError('forbidden');
  actor.signal?.throwIfAborted();
}
export async function effectivePeopleAdministrators(client: DatabaseClient, actorTenant: string): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(`SELECT person.id FROM console_users person
    JOIN human_tenant_memberships human ON human.human_id=person.id AND human.tenant_id=person.tenant_id AND human.actor_alias=person.alias
    JOIN agents agent ON agent.tenant_id=person.tenant_id AND agent.alias=person.alias
    JOIN tenants tenant ON tenant.id=person.tenant_id JOIN memberships member ON member.tenant_id=person.tenant_id AND member.alias=person.alias
    JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id JOIN role_policies policy ON policy.role=member.role
    WHERE ${peopleCompanyScopeSql('person.tenant_id')} AND person.active AND person.role='operator' AND human.enabled AND human.revoked_at IS NULL AND human.role='operator'
      AND 'control'=ANY(human.permissions) AND agent.retired_at IS NULL AND tenant.enabled AND tenant.is_hub
      AND member.enabled AND room.enabled AND policy.allow_control
    FOR SHARE OF person,human,agent,tenant,member,room,policy`, [actorTenant]);
  return new Set(result.rows.map(row => row.id));
}
export async function peopleAliasAuthority(client: DatabaseClient, value: Pick<PeopleAdminPerson, 'tenant_id' | 'alias' | 'role'>): Promise<{ hub: boolean; control: boolean }> {
  const result = await client.query<{ hub: boolean; read: boolean; control: boolean }>(`SELECT tenant.is_hub AS hub,policy.allow_read AS read,policy.allow_control AS control
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    JOIN memberships member ON member.tenant_id=agent.tenant_id AND member.alias=agent.alias
    JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id JOIN role_policies policy ON policy.role=member.role
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.retired_at IS NULL AND tenant.enabled AND member.enabled AND room.enabled
    FOR SHARE OF agent,tenant,member,room,policy`, [value.tenant_id, value.alias]);
  const readable = result.rows.some(row => row.read);
  const control = result.rows.some(row => row.control);
  if (!readable || (value.role === 'operator' && !control)) throw new PeopleAdminError('conflict');
  return { hub: result.rows.some(row => row.hub), control };
}
export async function protectLastPeopleAdministrator(client: DatabaseClient, previous: PeopleAdminPerson, next: PeopleAdminPerson): Promise<void> {
  const administrators = await effectivePeopleAdministrators(client, previous.tenant_id);
  if (!administrators.has(previous.id)) return;
  const authority = await peopleAliasAuthority(client, next);
  if (administrators.size === 1 && (!next.active || next.role !== 'operator' || !authority.hub || !authority.control)) throw new PeopleAdminError('conflict');
}
