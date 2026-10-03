import { randomUUID } from 'node:crypto';
import { isAnyUuid } from '@cauce/protocol';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import { AuthError, type Principal } from './auth.js';
import type { ConsoleUserStore } from './console-users.js';
import { consoleUserPrincipal } from './console-user-authority.js';

export interface ExternalSubjectResolver {
  resolve(identity: VerifiedOAuthIdentity, signal: AbortSignal): Promise<Readonly<{
    userId: string;
    status: 'active' | 'inactive' | 'revoked';
  }> | undefined>;
}

export interface HumanMcpAuthorityOptions {
  readonly users: Pick<ConsoleUserStore, 'findById'>;
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
  { users, resolver }: HumanMcpAuthorityOptions,
  identity: VerifiedOAuthIdentity,
  signal: AbortSignal,
): Promise<HumanMcpAuthority> {
  signal.throwIfAborted();
  try {
    requireUnexpiredIdentity(identity);
    if (!resolver) throw new AuthError(AUTHORITY_REQUIRED);
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
