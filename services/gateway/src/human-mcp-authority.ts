import { randomUUID } from 'node:crypto';
import { isAnyUuid, TenantSchema, type Tenant } from '@cauce/protocol';
import { lockHumanIdentity, resolveHumanIdentity, StoreError,
  type DatabaseClient, type DatabasePool, type HumanIdentityKey, type HumanIdentitySnapshot } from '@cauce/store';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import { AuthError, AuthorizationError, validatePrincipal, type Principal } from './auth.js';
import type { ConsoleUserStore } from './console-users.js';
import { consoleRoleAuthority, consoleUserPrincipal } from './console-user-authority.js';

export interface ExternalSubjectResolver {
  resolve(identity: VerifiedOAuthIdentity, signal: AbortSignal): Promise<Readonly<{
    userId: string;
    status: 'active' | 'inactive' | 'revoked';
  }> | undefined>;
}

export interface HumanMcpAuthorityOptions {
  readonly users?: Pick<ConsoleUserStore, 'findById'>;
  readonly identityStore?: HumanIdentityStore;
  readonly pool?: DatabasePool;
  readonly resolver?: ExternalSubjectResolver;
}

export type HumanMcpAuthority = Readonly<{
  userId: string;
  principal: Principal;
  scopes: readonly string[];
}>;

const AUTHORITY_REQUIRED = 'human MCP authority is unavailable';

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(new DOMException('Operation aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function requireUnexpiredIdentity(identity: VerifiedOAuthIdentity): void {
  if (!Number.isFinite(identity.expiresAt) || identity.expiresAt * 1000 <= Date.now()) {
    throw new AuthError(AUTHORITY_REQUIRED);
  }
}

// Only a trusted OAuth verifier may supply identity; this function does not verify tokens.
export async function resolveHumanMcpAuthority(
  options: HumanMcpAuthorityOptions,
  identity: VerifiedOAuthIdentity,
  signal: AbortSignal,
): Promise<HumanMcpAuthority> {
  signal.throwIfAborted();
  try {
    requireUnexpiredIdentity(identity);
    const { users, resolver, identityStore, pool } = options;
    if (identityStore || pool) {
      const key = externalKey(identity);
      const remaining = Math.max(1, Math.min(5000, Math.floor(identity.expiresAt * 1000 - Date.now())));
      const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      const snapshot = identityStore
        ? await identityStore.resolve(key, lookupSignal)
        : pool ? await resolveHumanIdentity(pool, key, lookupSignal) : undefined;
      lookupSignal.throwIfAborted();
      requireUnexpiredIdentity(identity);
      return durableAuthority(snapshot, identity);
    }
    if (!resolver || !users) throw new AuthError(AUTHORITY_REQUIRED);
    const binding = await abortable(() => resolver.resolve(identity, signal), signal);
    signal.throwIfAborted();
    if (binding?.status !== 'active' || !isAnyUuid(binding.userId)) throw new AuthError(AUTHORITY_REQUIRED);
    const user = await abortable(() => users.findById(binding.userId), signal);
    signal.throwIfAborted();
    requireUnexpiredIdentity(identity);
    if (!user?.active || user.id !== binding.userId) throw new AuthError(AUTHORITY_REQUIRED);
    const account = consoleUserPrincipal(user, `human-mcp:${randomUUID()}`, 'mcp');
    const principal: Principal = Object.freeze({
      ...account,
      channel: 'human-mcp',
      roles: Object.freeze([...account.roles]),
      permissions: Object.freeze([...account.permissions]),
      ...(account.operator_profile === undefined ? {} : { operator_profile: Object.freeze(account.operator_profile) }),
    });
    const scopes = Object.freeze(identity.scopes.filter((scope, index, all) => all.indexOf(scope) === index && (
      (scope === 'cauce.read' && principal.permissions.includes('read')) ||
      (scope === 'cauce.publish' && principal.roles.includes('operator') && principal.permissions.includes('route'))
    )));
    // userId identifies the account; legacy operator scope and alias visibility are unchanged.
    return Object.freeze({ userId: user.id, principal, scopes });
  } catch {
    signal.throwIfAborted();
    throw new AuthError(AUTHORITY_REQUIRED);
  }
}


export interface HumanIdentityStore {
  resolve(key: HumanIdentityKey, signal: AbortSignal): Promise<HumanIdentitySnapshot | undefined>;
  lock(client: DatabaseClient, key: HumanIdentityKey, expectedHumanId: string): Promise<HumanIdentitySnapshot>;
}

export interface PinnedHumanIdentity {
  readonly humanId: string;
  readonly tenantId: Tenant;
  readonly actorAlias: string;
}

function requireOAuthKind(kind: unknown): void {
  if (kind !== 'oauth') throw new AuthError(AUTHORITY_REQUIRED);
}

function externalKey(identity: VerifiedOAuthIdentity): HumanIdentityKey {
  requireOAuthKind(identity.kind);
  return Object.freeze({ provider: 'oauth', namespace: identity.issuer, subject: identity.subject });
}

function durableAuthority(snapshot: HumanIdentitySnapshot | undefined, identity: VerifiedOAuthIdentity): HumanMcpAuthority {
  if (!snapshot?.account.active || !snapshot.membership.enabled || !isAnyUuid(snapshot.humanId)
      || snapshot.namespace !== identity.issuer || snapshot.subject !== identity.subject
      || snapshot.membership.tenantId !== snapshot.account.defaultTenant) throw new AuthError(AUTHORITY_REQUIRED);
  requireOAuthKind(snapshot.provider);
  const account = consoleRoleAuthority(snapshot.account.role);
  const membership = consoleRoleAuthority(snapshot.membership.role);
  const roles = account.roles.filter((role) => membership.roles.includes(role));
  const permissions = account.permissions.filter((permission) => membership.permissions.includes(permission)
    && snapshot.membership.permissions.includes(permission)
    && ((permission === 'read' && identity.scopes.includes('cauce.read'))
      || (permission === 'route' && identity.scopes.includes('cauce.publish'))));
  const principal = validatePrincipal({
    tenant_id: TenantSchema.parse(snapshot.membership.tenantId), alias: snapshot.membership.actorAlias,
    session_id: `human-mcp:${randomUUID()}`, channel: 'human-mcp', roles, permissions,
    operator_id: `console:${snapshot.humanId}`,
    operator_profile: { id: `console:${snapshot.humanId}`, display_name: snapshot.account.displayName },
  });
  const scopes = identity.scopes.filter((scope, index, all) => all.indexOf(scope) === index
    && ((scope === 'cauce.read' && permissions.includes('read'))
      || (scope === 'cauce.publish' && roles.includes('operator') && permissions.includes('route'))));
  return Object.freeze({ userId: snapshot.humanId, scopes: Object.freeze(scopes), principal: Object.freeze({
    ...principal, roles: Object.freeze(roles), permissions: Object.freeze(permissions),
    ...(principal.operator_profile === undefined ? {} : { operator_profile: Object.freeze(principal.operator_profile) }),
  }) });
}

// The caller owns the transaction and retains the locks through the authorized operation.
function createHumanMessageAuthority(
  access: 'publish' | 'read',
  identity: VerifiedOAuthIdentity,
  pinnedIdentity: PinnedHumanIdentity,
  signal: AbortSignal,
  identityStore: Pick<HumanIdentityStore, 'lock'> = { lock: lockHumanIdentity },
): (client: DatabaseClient) => Promise<Readonly<PinnedHumanIdentity>> {
  const verified = Object.freeze({ ...identity, scopes: Object.freeze([...identity.scopes]) });
  const key = externalKey(verified);
  const pinned = Object.freeze({ ...pinnedIdentity });
  const lock = identityStore.lock.bind(identityStore);
  return async (client) => {
    signal.throwIfAborted();
    requireUnexpiredIdentity(verified);
    const timeout = String(Math.max(1, Math.min(5000, Math.floor(verified.expiresAt * 1000 - Date.now()))));
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [timeout]);
    const snapshot = await lock(client, key, pinned.humanId);
    signal.throwIfAborted();
    requireUnexpiredIdentity(verified);
    const authority = durableAuthority(snapshot, verified);
    if (authority.userId !== pinned.humanId || authority.principal.tenant_id !== pinned.tenantId
        || authority.principal.alias !== pinned.actorAlias) {
      throw new StoreError('conflict', access === 'publish' ? 'human publication identity changed' : 'human read identity changed');
    }
    const allowed = access === 'publish'
      ? authority.scopes.includes('cauce.publish') && authority.principal.roles.includes('operator')
        && authority.principal.permissions.includes('route')
      : authority.scopes.includes('cauce.read') && authority.principal.permissions.includes('read');
    if (!allowed) throw new AuthorizationError();
    return Object.freeze({ humanId: authority.userId, tenantId: authority.principal.tenant_id,
      actorAlias: authority.principal.alias });
  };
}

export function createHumanPublishAuthority(
  identity: VerifiedOAuthIdentity,
  pinnedIdentity: PinnedHumanIdentity,
  signal: AbortSignal,
  identityStore?: Pick<HumanIdentityStore, 'lock'>,
): (client: DatabaseClient) => Promise<Readonly<PinnedHumanIdentity>> {
  return createHumanMessageAuthority('publish', identity, pinnedIdentity, signal, identityStore);
}

export function createHumanReadAuthority(
  identity: VerifiedOAuthIdentity,
  pinnedIdentity: PinnedHumanIdentity,
  signal: AbortSignal,
  identityStore?: Pick<HumanIdentityStore, 'lock'>,
): (client: DatabaseClient) => Promise<Readonly<PinnedHumanIdentity>> {
  return createHumanMessageAuthority('read', identity, pinnedIdentity, signal, identityStore);
}
