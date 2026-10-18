import { isReservedAlias } from '@cauce/protocol';
import { lockCompanyAuthority, StoreError, type CompanyAuthority, type DatabaseClient } from '@cauce/store';
import { normalizeEmail } from '../console-users.js';
import { PeopleAdminError, type PeopleAdminActor, type PeopleAdminPerson } from './people-admin-schema.js';

/** Platform administrators, company owners and company administrators; the hub grants nothing here. */
const ADMINISTRATOR_ROLES: ReadonlySet<string> = new Set(['platform_admin', 'company_owner', 'company_admin']);
const PROTECTED_FIELDS = ['email', 'role', 'tenant_id', 'alias', 'active'] as const;

export async function assertPeopleCompany(client: DatabaseClient, targetTenant: string, company: string): Promise<void> {
  const result = await client.query('SELECT id FROM tenants WHERE id=$1 AND company_id=$2 FOR SHARE', [targetTenant, company]);
  if (!result.rowCount) throw new PeopleAdminError('forbidden');
}

/** The verified person must hold a company or platform role; the resolver decides it, never the hub flag. */
export async function assertPeopleAuthority(client: DatabaseClient, actor: PeopleAdminActor): Promise<CompanyAuthority> {
  actor.signal?.throwIfAborted();
  let verified: { humanId: string; tenantId: string; actorAlias: string };
  try { verified = await actor.humanAuthority(client); } catch { throw new PeopleAdminError('forbidden'); }
  if (`console:${verified.humanId}` !== actor.subject || verified.tenantId !== actor.tenant_id || verified.actorAlias !== actor.alias) {
    throw new PeopleAdminError('forbidden');
  }
  let authority: CompanyAuthority;
  try {
    authority = actor.companyAuthority === undefined
      ? await lockCompanyAuthority(client, { tenant: verified.tenantId, alias: verified.actorAlias, humanId: verified.humanId })
      : await actor.companyAuthority(client);
  } catch (error) {
    if (error instanceof StoreError && error.code === 'forbidden') throw new PeopleAdminError('forbidden');
    throw error;
  }
  if (!ADMINISTRATOR_ROLES.has(authority.role) || authority.humanId !== verified.humanId
      || authority.homeTenant !== verified.tenantId || authority.alias !== verified.actorAlias) throw new PeopleAdminError('forbidden');
  actor.signal?.throwIfAborted();
  return authority;
}

/**
 * Who may be changed by whom. Nobody changes their own role, state or placement; a company owner
 * leaves owners and platform administrators alone, and a company administrator also leaves the
 * other administrators alone. Returns whether the target holds an owner or platform role, whose
 * continuity the caller must re-check after changing its membership.
 */
export async function assertMayAdminister(
  client: DatabaseClient, authority: CompanyAuthority, previous: PeopleAdminPerson, next: PeopleAdminPerson | undefined,
): Promise<boolean> {
  if (previous.id === authority.humanId) {
    const changed = next === undefined || PROTECTED_FIELDS.some(field => field === 'email'
      ? normalizeEmail(previous.email) !== normalizeEmail(next.email) : previous[field] !== next[field]);
    if (changed) throw new PeopleAdminError('forbidden');
    return false;
  }
  const facts = (await client.query<{ platform_admin: boolean; company_role: string | null }>(
    'SELECT platform_admin,company_role FROM cauce_company_authority($1,$2)', [previous.id, authority.actingCompany])).rows[0];
  if (!facts) throw new PeopleAdminError('not_found');
  const holder = facts.platform_admin || facts.company_role === 'owner';
  if (authority.role !== 'platform_admin' && (holder || (authority.role === 'company_admin' && facts.company_role === 'admin'))) {
    throw new PeopleAdminError('forbidden');
  }
  return holder;
}

/** The alias of an active person must be a live agent with read access, and control for an operator. */
export async function assertPeopleAlias(client: DatabaseClient, value: Pick<PeopleAdminPerson, 'tenant_id' | 'alias' | 'role'>): Promise<void> {
  const result = await client.query<{ read: boolean; control: boolean }>(`SELECT policy.allow_read AS read,policy.allow_control AS control
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    JOIN memberships member ON member.tenant_id=agent.tenant_id AND member.alias=agent.alias
    JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id JOIN role_policies policy ON policy.role=member.role
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.retired_at IS NULL AND tenant.enabled AND member.enabled AND room.enabled
    FOR SHARE OF agent,tenant,member,room,policy`, [value.tenant_id, value.alias]);
  if (!result.rows.some(row => row.read) || (value.role === 'operator' && !result.rows.some(row => row.control))) throw new PeopleAdminError('conflict');
}

const LIVE_ROOM = `SELECT room.id FROM rooms room JOIN tenants tenant ON tenant.id=room.tenant_id
  WHERE room.tenant_id=$1 AND room.enabled AND tenant.enabled
    AND room.retired_at IS NULL AND tenant.retired_at IS NULL
    AND room.purged_at IS NULL AND tenant.purged_at IS NULL
  ORDER BY (room.id='office') DESC, room.id LIMIT 1 FOR SHARE OF room, tenant`;

/**
 * A person must reference an agent that already has a live membership. A new company has no enabled
 * agent, so a missing alias may be provisioned. An alias that already exists and does not qualify is not repaired.
 */
export async function peopleIdentityDisposition(
  client: DatabaseClient, value: Pick<PeopleAdminPerson, 'tenant_id' | 'alias' | 'role'>,
): Promise<'ready' | 'provision'> {
  try {
    await assertPeopleAlias(client, value);
    return 'ready';
  } catch (error) {
    if (!(error instanceof PeopleAdminError) || error.code !== 'conflict') throw error;
  }
  if (isReservedAlias(value.alias)) throw new PeopleAdminError('invalid_request');
  const existing = await client.query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [value.tenant_id, value.alias]);
  if ((existing.rowCount ?? 0) > 0) throw new PeopleAdminError('conflict');
  const room = await client.query(LIVE_ROOM, [value.tenant_id]);
  if ((room.rowCount ?? 0) === 0) throw new PeopleAdminError('conflict');
  const policy = await client.query<{ allow_read: boolean; allow_control: boolean }>(
    "SELECT allow_read, allow_control FROM role_policies WHERE role='operator' FOR SHARE");
  const operator = policy.rows[0];
  if (!operator?.allow_read || !operator.allow_control) throw new PeopleAdminError('conflict');
  return 'provision';
}

/** Inserts a disabled draft and an operator membership only when no agent row exists for the alias. */
export async function ensurePeopleIdentity(
  client: DatabaseClient, value: Pick<PeopleAdminPerson, 'tenant_id' | 'alias' | 'role' | 'display_name'>,
): Promise<void> {
  if (await peopleIdentityDisposition(client, value) === 'ready') return;
  await client.query('INSERT INTO agents(tenant_id, alias, display_name, enabled) VALUES ($1,$2,$3,false)',
    [value.tenant_id, value.alias, value.display_name]);
  const room = await client.query<{ id: string }>(LIVE_ROOM, [value.tenant_id]);
  const roomId = room.rows[0]?.id;
  if (!roomId) throw new PeopleAdminError('conflict');
  await client.query("INSERT INTO memberships(tenant_id, room_id, alias, role, enabled) VALUES ($1,$2,$3,'operator',true)",
    [value.tenant_id, roomId, value.alias]);
  await assertPeopleAlias(client, value);
}
