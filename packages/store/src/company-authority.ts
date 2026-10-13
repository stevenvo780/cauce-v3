import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { lockConsolePerson, type ConsolePersonSnapshot } from './human-identity.js';
import { StoreError } from './repository/errors.js';
import { QUALIFIED_PEOPLE_SQL } from './configuration/control-holders.js';
import { boundAuthorityTimeouts } from './configuration/timeouts.js';

export { boundAuthorityTimeouts };

export const COMPANY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type CompanyRole = 'platform_admin' | 'company_owner' | 'company_admin' | 'tenant_operator' | 'reader' | 'none';
/** The resolver yields platform, company, tenant or none; `outgoing_acl` only narrows one resource capability. */
export type CompanyAuthorityScope = 'platform' | 'company' | 'tenant' | 'outgoing_acl' | 'none';

export interface CompanyAuthority {
  readonly humanId: string | null;
  readonly homeTenant: string;
  readonly alias: string;
  readonly homeCompany: string;
  readonly actingCompany: string;
  readonly role: CompanyRole;
  readonly scope: CompanyAuthorityScope;
  readonly platformOverride: boolean;
}

export interface CompanyAuthorityRequest {
  readonly tenant: string;
  readonly alias: string;
  /** Only a verified console person reaches company or platform authority; an agent never does. */
  readonly humanId?: string;
  /** A signed company switch, honoured only while the person stays a platform administrator; it never falls back home. */
  readonly requestedCompany?: string;
}

interface CompanyFacts {
  home_company: string | null;
  platform_admin: boolean;
  company_role: 'owner' | 'admin' | null;
  company_enabled: boolean;
}

const CONFIGURATION_LOCK = 783_003_004;
const SQL_COLUMN = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/u;
const SQL_PARAMETER = /^\$[1-9][0-9]{0,2}$/u;

function unavailable(): never {
  throw new StoreError('forbidden', 'company authority is unavailable');
}

/** The signed company switch names a company that is no longer usable; only a new switch leaves it. */
export class RequestedCompanyUnavailableError extends StoreError {
  constructor(readonly company: string) {
    super('forbidden', 'the requested company is unavailable; choose a company again');
    this.name = 'RequestedCompanyUnavailableError';
  }
}

/** Platform tables grant the runtime no UPDATE, so their rows are share-locked by the DEFINER function. */
async function companyFacts(client: DatabaseClient, humanId: string, company: string | null): Promise<CompanyFacts> {
  const facts = (await client.query<CompanyFacts>(
    'SELECT home_company,platform_admin,company_role,company_enabled FROM cauce_company_authority($1,$2)', [humanId, company],
  )).rows[0];
  if (!facts) unavailable();
  return facts;
}

async function tenantReach(client: DatabaseClient, tenant: string, alias: string): Promise<{ control: boolean; read: boolean }> {
  const rows = (await client.query<{ allow_control: boolean; allow_read: boolean }>(
    `SELECT policy.allow_control,policy.allow_read FROM memberships member
     JOIN role_policies policy ON policy.role=member.role
     JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
     JOIN tenants tenant ON tenant.id=member.tenant_id
     JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
     WHERE member.tenant_id=$1 AND member.alias=$2 AND member.enabled AND member.retired_at IS NULL
       AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
       AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
       AND agent.retired_at IS NULL AND agent.purged_at IS NULL
     FOR SHARE OF member,room,policy,tenant,agent`, [tenant, alias],
  )).rows;
  return { control: rows.some(row => row.allow_control), read: rows.some(row => row.allow_read) };
}

/** Besides its row, a company or platform role needs an active operator whose home membership controls. */
function qualifies(person: ConsolePersonSnapshot | undefined): boolean {
  return person?.account.active === true && person.account.role === 'operator'
    && person.membership?.actorAlias === person.account.actorAlias && person.membership.role === 'operator'
    && person.membership.permissions.includes('control');
}

function resolved(
  base: Pick<CompanyAuthority, 'humanId' | 'homeTenant' | 'alias' | 'homeCompany'>,
  actingCompany: string, role: CompanyRole, scope: CompanyAuthorityScope,
): CompanyAuthority {
  return Object.freeze({ ...base, actingCompany, role, scope, platformOverride: actingCompany !== base.homeCompany });
}

/**
 * The single decision of company and platform roles, evaluated inside the caller transaction and
 * share-locked until it ends. `is_hub` grants nothing here.
 */
export async function lockCompanyAuthority(client: DatabaseClient, request: CompanyAuthorityRequest): Promise<CompanyAuthority> {
  const { tenant, alias, humanId, requestedCompany } = request;
  if (typeof tenant !== 'string' || typeof alias !== 'string'
    || (requestedCompany !== undefined && !COMPANY_ID_PATTERN.test(requestedCompany))) unavailable();
  await boundAuthorityTimeouts(client);
  const home = (await client.query<{ company_id: string; active: boolean }>(
    `SELECT tenant.company_id,tenant.enabled AND tenant.retired_at IS NULL AND company.enabled
       AND company.retired_at IS NULL AS active FROM tenants tenant JOIN companies company ON company.id=tenant.company_id
     WHERE tenant.id=$1 FOR SHARE OF tenant`, [tenant],
  )).rows[0];
  if (!home) unavailable();
  const person = humanId === undefined ? undefined : await lockConsolePerson(client, humanId);
  if (humanId !== undefined && (!person?.account.active || person.account.defaultTenant !== tenant
    || person.account.actorAlias !== alias || person.account.company !== home.company_id)) unavailable();
  const membership = person?.membership?.actorAlias === alias ? person.membership : undefined;
  const reach = home.active ? await tenantReach(client, tenant, alias) : { control: false, read: false };
  const qualified = qualifies(person) && reach.control;
  const base = { humanId: person?.humanId ?? null, homeTenant: tenant, alias, homeCompany: home.company_id };
  if (person !== undefined && qualified && home.active) {
    const facts = await companyFacts(client, person.humanId, null);
    if (facts.home_company !== home.company_id) unavailable();
    if (facts.platform_admin) {
      if (requestedCompany === undefined || requestedCompany === home.company_id) {
        return resolved(base, home.company_id, 'platform_admin', 'platform');
      }
      if (!(await companyFacts(client, person.humanId, requestedCompany)).company_enabled) {
        throw new RequestedCompanyUnavailableError(requestedCompany);
      }
      return resolved(base, requestedCompany, 'platform_admin', 'platform');
    }
    if (facts.company_role !== null && facts.company_enabled) {
      return resolved(base, home.company_id, facts.company_role === 'owner' ? 'company_owner' : 'company_admin', 'company');
    }
  }
  const control = reach.control && (person === undefined || qualified);
  const read = reach.read && (person === undefined || membership?.permissions.includes('read') === true);
  return resolved(base, home.company_id, control ? 'tenant_operator' : read ? 'reader' : 'none', control || read ? 'tenant' : 'none');
}

/**
 * G3 and G4 guard only the person, so every writer of a home membership calls this after the write,
 * in its transaction: an owner or platform administrator who stops qualifying must leave another
 * qualified holder of that role. The snapshot is read after the writer guard, without locking
 * another writer's person or membership rows.
 */
export async function assertKeepsCompanyAuthority(client: DatabaseClient, humanId: string): Promise<void> {
  await boundAuthorityTimeouts(client);
  const holder = async () => (await client.query<{ id: string; company_id: string; owner: boolean; platform: boolean }>(
    `SELECT id::text,company_id,
       EXISTS(SELECT 1 FROM company_admins WHERE company_id=person.company_id AND human_id=person.id AND role='owner') AS owner,
       EXISTS(SELECT 1 FROM platform_admins WHERE human_id=person.id) AS platform
     FROM console_users person WHERE id=$1`, [humanId])).rows[0];
  const person = await holder();
  if (person === undefined) return;
  const company = person.company_id;
  if (person.platform) await client.query('SELECT cauce_lock_platform_owner_guard()');
  await client.query('SELECT cauce_lock_owner_guard($1)', [company]);
  const current = await holder();
  if (current === undefined) return;
  if (!person.platform && current.platform) throw new StoreError('conflict', 'platform authority changed; reload and retry');
  if (!current.owner && !current.platform) return;
  const kept = (await client.query<{ owner: boolean; platform: boolean }>(
    `WITH qualified AS (${QUALIFIED_PEOPLE_SQL})
     SELECT EXISTS(SELECT 1 FROM company_admins holder JOIN qualified person ON person.id=holder.human_id
       WHERE holder.company_id=$1 AND holder.role='owner') AS owner,
       EXISTS(SELECT 1 FROM platform_admins holder JOIN qualified person ON person.id=holder.human_id) AS platform`, [company],
  )).rows[0];
  if (current.owner && kept?.owner !== true) {
    throw new StoreError('conflict', `company ${company} must keep a qualified owner`);
  }
  if (current.platform && kept?.platform !== true) {
    throw new StoreError('conflict', 'the platform must keep a qualified administrator');
  }
}

export function assertPlatformAdmin(authority: CompanyAuthority): void {
  if (authority.role !== 'platform_admin' || authority.humanId === null) {
    throw new StoreError('forbidden', 'platform administrator authority is required');
  }
}

/** Predicate for a tenant column inside the company bound to a query parameter. */
export function companyScopeSql(tenantColumn: string, companyParameter: string): string {
  if (!SQL_COLUMN.test(tenantColumn) || !SQL_PARAMETER.test(companyParameter)) {
    throw new Error('company scope needs a column reference and a positional parameter');
  }
  return `${tenantColumn} IN (SELECT company_scope.id FROM tenants company_scope WHERE company_scope.company_id=${companyParameter})`;
}

/**
 * Company writers share the installation lock and exclude each other per company; a platform
 * catalog writer, like every pre-company writer, holds the installation lock exclusively.
 */
export async function lockCompanyConfiguration(client: DatabaseClient, company: string): Promise<void> {
  if (!COMPANY_ID_PATTERN.test(company)) unavailable();
  await boundAuthorityTimeouts(client);
  await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [CONFIGURATION_LOCK]);
  await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [CONFIGURATION_LOCK, company]);
}

export async function lockPlatformConfiguration(client: DatabaseClient): Promise<void> {
  await boundAuthorityTimeouts(client);
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [CONFIGURATION_LOCK]);
}

/** A platform catalog revision invalidates the previews of every company. */
export async function companyRevision(client: DatabaseClient, company: string): Promise<number> {
  const revision = (await client.query<{ revision: string }>(
    `SELECT GREATEST(COALESCE((SELECT max(id) FROM config_revisions WHERE company_id=$1),0),
       COALESCE((SELECT max(id) FROM config_revisions WHERE scope='platform'),0))::text AS revision`, [company],
  )).rows[0]?.revision;
  return Number(revision ?? 0);
}

/** Names the acting company in `cauce.company_id` for the whole transaction, as row-level policies will read it. */
export async function withCompanyContext<T>(
  pool: DatabasePool, company: string, work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  if (!COMPANY_ID_PATTERN.test(company)) throw new StoreError('invalid_input', 'company id is invalid');
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('cauce.company_id',$1,true)", [company]);
    return work(client);
  });
}
