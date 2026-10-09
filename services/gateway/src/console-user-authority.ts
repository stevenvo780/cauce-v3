import {
  assertPlatformAdmin, lockCompanyAuthority, withTransaction,
  type CompanyAuthority, type CompanyAuthorityScope, type CompanyRole, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { AuthError, AuthorizationError, bindHumanPrincipal, validatePrincipal, type Principal, type PrincipalPermission, type PrincipalRole } from './auth.js';
import type { ConsoleUser, ConsoleUserRole } from './console-users.js';

interface ConsoleRoleAuthority {
  readonly roles: readonly PrincipalRole[];
  readonly permissions: readonly PrincipalPermission[];
}

// Durable memberships and role policies further narrow this role ceiling.
const ROLE_AUTHORITY: Readonly<Record<ConsoleUserRole, ConsoleRoleAuthority>> = Object.freeze({
  operator: { roles: ['operator'], permissions: ['route', 'read', 'control', 'notify'] },
  reader: { roles: [], permissions: ['read'] }
});

export function consoleRoleAuthority(role: unknown): ConsoleRoleAuthority {
  if (role !== 'operator' && role !== 'reader') throw new AuthError('console account role is invalid');
  return ROLE_AUTHORITY[role];
}

/** Only the console session binds its person; delegated MCP channels stay at tenant authority. */
export function consoleUserPrincipal(user: ConsoleUser, sessionId: string, channel: 'console' | 'mcp'): Principal {
  if (!user.active) throw new AuthError('la cuenta de consola no está habilitada');
  const authority = consoleRoleAuthority(user.role);
  const principal = validatePrincipal({
    tenant_id: user.tenant_id,
    alias: user.alias,
    session_id: sessionId,
    channel,
    roles: authority.roles,
    permissions: authority.permissions,
    // Keep the existing operator scope; a profile UUID does not isolate a shared alias.
    operator_id: user.email,
    operator_profile: { id: `console:${user.id}`, display_name: user.display_name },
  });
  return channel === 'console' ? bindHumanPrincipal(principal, user.id) : principal;
}

export interface ConsoleSessionAuthority {
  readonly role: CompanyRole;
  readonly scope: CompanyAuthorityScope;
  readonly home_company: string;
  readonly acting_company: string;
  readonly platform_override: boolean;
}

export interface ConsoleCompanyAuthority {
  /** `requested` is the signed `cmp` claim; the store ignores it unless the person is a platform administrator. */
  resolve(user: ConsoleUser, requested: string | undefined): Promise<ConsoleSessionAuthority>;
  /** `company=null` returns to the home company; the switch is audited in every foreign company it enters or leaves. */
  switchCompany(user: ConsoleUser, company: string | null, previous: string | undefined): Promise<ConsoleSessionAuthority>;
}

export function sessionAuthority(authority: CompanyAuthority): ConsoleSessionAuthority {
  return Object.freeze({ role: authority.role, scope: authority.scope, home_company: authority.homeCompany,
    acting_company: authority.actingCompany, platform_override: authority.platformOverride });
}

function lockConsoleUserAuthority(client: DatabaseClient, user: ConsoleUser, requested: string | undefined): Promise<CompanyAuthority> {
  return lockCompanyAuthority(client, { tenant: user.tenant_id, alias: user.alias, humanId: user.id,
    ...(requested === undefined ? {} : { requestedCompany: requested }) });
}

// Platform functions lock the company row for update; a session read gives up instead of holding a connection.
const SESSION_AUTHORITY_TIMEOUT_MS = 2_000;

export class PostgresConsoleCompanyAuthority implements ConsoleCompanyAuthority {
  constructor(private readonly pool: DatabasePool) {}

  private bounded<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT set_config('statement_timeout',$1,true)", [String(SESSION_AUTHORITY_TIMEOUT_MS)]);
      return work(client);
    }, { schemaLockTimeoutMs: SESSION_AUTHORITY_TIMEOUT_MS });
  }

  resolve(user: ConsoleUser, requested: string | undefined): Promise<ConsoleSessionAuthority> {
    return this.bounded(async (client) => sessionAuthority(await lockConsoleUserAuthority(client, user, requested)));
  }

  switchCompany(user: ConsoleUser, company: string | null, previous: string | undefined): Promise<ConsoleSessionAuthority> {
    return this.bounded(async (client) => {
      const authority = await lockConsoleUserAuthority(client, user, company ?? undefined);
      assertPlatformAdmin(authority);
      if (company !== null && authority.actingCompany !== company) throw new AuthorizationError('the company is unavailable');
      const left = previous !== undefined && previous !== authority.actingCompany ? previous : undefined;
      const touched = new Set(authority.platformOverride ? [authority.actingCompany] : []);
      if (left !== undefined) touched.add(left);
      await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
        SELECT $1,$2,'platform.session.company','allow',company,$4,$5::jsonb FROM unnest($3::text[]) company`,
      [user.tenant_id, user.alias, touched.size === 0 ? [authority.homeCompany] : [...touched], user.id,
        JSON.stringify({ home_company: authority.homeCompany, acting_company: authority.actingCompany,
          ...(left === undefined ? {} : { previous_company: left }) })]);
      return sessionAuthority(authority);
    });
  }
}
