import { lockHumanIdentity, lockConsoleHuman, StoreError, type ConsoleCredentialStampVerifier, type DatabaseClient, type HumanIdentitySnapshot } from '@cauce/store';
import { isAnyUuid } from '@cauce/protocol';
import { consoleRoleAuthority } from './console-user-authority.js';
import { OAuthError, OAUTH_SCOPES, type OAuthAccessIdentity, type OAuthScope, type OAuthStore } from './oauth-authorization-types.js';
import type { OAuthTokens } from './oauth-tokens.js';

export interface OAuthGrantRow {
  id: string;
  human_id: string;
  client_id: string;
  redirect_uri: string;
  scopes: OAuthScope[];
  expires_at: Date;
  binding_id: string;
  binding_revision: string;
  membership_revision: string;
  tenant_id: string;
  actor_alias: string;
  credential_stamp: string;
}

function oauthIdentityKind(value: unknown): boolean {
  return value === 'oauth';
}

export function currentOAuthScopes(snapshot: HumanIdentitySnapshot): readonly OAuthScope[] {
  const account = consoleRoleAuthority(snapshot.account.role);
  const membership = consoleRoleAuthority(snapshot.membership.role);
  const permissions = account.permissions.filter((permission) => membership.permissions.includes(permission)
    && snapshot.membership.permissions.includes(permission));
  return Object.freeze(OAUTH_SCOPES.filter((scope) => scope === 'cauce.read' ? permissions.includes('read')
    : account.roles.includes('operator') && membership.roles.includes('operator') && permissions.includes('route')));
}

export async function lockOAuthGrant(
  client: DatabaseClient, grantId: string, issuer: string, resource: string, userId: string,
  verifyCredentialStamp: ConsoleCredentialStampVerifier,
): Promise<OAuthGrantRow> {
  const original = (await client.query<{ credential_stamp: string }>(
    `SELECT credential_stamp FROM cauce_oauth_grants WHERE id=$1 AND human_id=$2 AND issuer=$3 AND resource=$4`,
    [grantId, userId, issuer, resource],
  )).rows[0];
  if (!original) throw new OAuthError('invalid_grant');
  let snapshot: HumanIdentitySnapshot;
  try {
    snapshot = await lockHumanIdentity(client, { provider: 'oauth', namespace: issuer, subject: userId }, userId);
    await lockConsoleHuman(client, userId, { credentialStamp: original.credential_stamp, verifyCredentialStamp });
  } catch (error) { if (error instanceof StoreError) throw new OAuthError('invalid_grant'); throw error; }
  const grant = (await client.query<OAuthGrantRow>(
    `SELECT g.id, g.human_id, g.client_id, g.redirect_uri, g.scopes, g.expires_at,
      g.binding_id, g.binding_revision::text, g.membership_revision::text, g.tenant_id, g.actor_alias, g.credential_stamp
     FROM cauce_oauth_grants g
     WHERE g.id=$1 AND g.human_id=$2 AND g.issuer=$3 AND g.resource=$4
       AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
       AND g.credential_stamp=$5
     FOR SHARE OF g`, [grantId, userId, issuer, resource, original.credential_stamp],
  )).rows[0];
  const available = currentOAuthScopes(snapshot);
  if (grant?.binding_id !== snapshot.bindingId || grant.binding_revision !== snapshot.bindingRevision
      || grant.membership_revision !== snapshot.membership.revision || grant.tenant_id !== snapshot.membership.tenantId
      || grant.actor_alias !== snapshot.membership.actorAlias || !grant.scopes.length
      || grant.scopes.some((scope) => !available.includes(scope))) throw new OAuthError('invalid_grant');
  await requireOAuthExpiry(client, grant.expires_at);
  return grant;
}

export async function requireOAuthExpiry(client: DatabaseClient, expiresAt: Date): Promise<void> {
  const checked = (await client.query<{ valid: boolean }>(
    'SELECT clock_timestamp() < $1::timestamptz AS valid', [expiresAt],
  )).rows[0];
  if (checked?.valid !== true) throw new OAuthError('invalid_grant');
}

// The caller retains these locks until its read or durable publication commits.
export async function lockOAuthAccess(
  client: DatabaseClient, identity: OAuthAccessIdentity, issuer: string, resource: string,
  verifyCredentialStamp: ConsoleCredentialStampVerifier,
): Promise<void> {
  if (!oauthIdentityKind(identity.kind) || identity.issuer !== issuer || identity.audience !== resource
      || !isAnyUuid(identity.subject) || !isAnyUuid(identity.grantId) || !isAnyUuid(identity.tokenId)) {
    throw new OAuthError('invalid_grant');
  }
  const grant = await lockOAuthGrant(client, identity.grantId, issuer, resource, identity.subject, verifyCredentialStamp);
  const token = (await client.query<{ expires_at: Date }>(
    `SELECT expires_at FROM cauce_oauth_tokens WHERE id=$1 AND grant_id=$2
       AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
    [identity.tokenId, identity.grantId],
  )).rows[0];
  if (token?.expires_at.getTime() !== identity.expiresAt * 1000
      || grant.scopes.length !== identity.scopes.length
      || grant.scopes.some((scope) => !identity.scopes.includes(scope))) throw new OAuthError('invalid_grant');
  await requireOAuthExpiry(client, new Date(Math.min(grant.expires_at.getTime(), token.expires_at.getTime())));
}

export function createLocalOAuthAuthorization(tokens: OAuthTokens, store: Pick<OAuthStore, 'validate'>) {
  return {
    mode: 'oauth' as const,
    challenge: `Bearer resource_metadata="${tokens.issuer}/.well-known/oauth-protected-resource/mcp"`,
    metadata: { resource: tokens.resource, authorization_servers: [tokens.issuer],
      scopes_supported: [...OAUTH_SCOPES], bearer_methods_supported: ['header'], resource_name: 'Cauce MCP' },
    authenticateIdentity: async (authorization: string): Promise<OAuthAccessIdentity | undefined> => {
      if (!authorization.startsWith('Bearer ') || authorization.length > 8192) return undefined;
      const verified = tokens.verify(authorization.slice(7));
      if (!verified) return undefined;
      const identity = Object.freeze({ ...verified, authorizationServer: 'local' as const });
      return await store.validate(identity) ? identity : undefined;
    },
  };
}
