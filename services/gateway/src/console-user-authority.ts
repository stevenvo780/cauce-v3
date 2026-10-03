import { AuthError, validatePrincipal, type Principal, type PrincipalPermission, type PrincipalRole } from './auth.js';
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

export function consoleUserPrincipal(user: ConsoleUser, sessionId: string, channel: 'console' | 'mcp'): Principal {
  if (!user.active) throw new AuthError('la cuenta de consola no está habilitada');
  const authority = consoleRoleAuthority(user.role);
  return validatePrincipal({
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
}
