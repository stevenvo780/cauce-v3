import { clientConnectionReference, withAbortableTransaction, type DatabasePool } from '@cauce/store';
import { scopes } from './oauth-authorization-types.js';
import { lockOAuthAccess } from './oauth-grant-authority.js';
import type { VerifiedOAuthIdentity } from '@cauce/mcp-fleet-monitor/gateway-http';
import { AuthError } from './auth.js';
import { createHumanReadAuthority, type HumanMcpAuthorityOptions, type PinnedHumanIdentity } from './human-mcp-authority.js';

export async function readMcpConnectionIdentity(pool: DatabasePool | undefined, options: HumanMcpAuthorityOptions,
  identity: VerifiedOAuthIdentity, owner: PinnedHumanIdentity, signal: AbortSignal) {
  if (!pool) throw new AuthError('durable human MCP authority is unavailable');
  return withAbortableTransaction(pool, signal, async (client) => {
    await createHumanReadAuthority(identity, owner, signal, options.identityStore)(client);
    if (identity.authorizationServer !== 'local') return { client: { kind: 'unknown' as const },
      connection_ref: null, expires_at: null };
    const verifyCredentialStamp = options.identityStore?.verifyCredentialStamp;
    if (!identity.grantId || !identity.tokenId || !verifyCredentialStamp) throw new AuthError();
    const proof = await lockOAuthAccess(client, { ...identity, authorizationServer: 'local',
      grantId: identity.grantId, tokenId: identity.tokenId, scopes: scopes(identity.scopes.join(' ')) },
    identity.issuer, identity.audience, verifyCredentialStamp);
    if (proof.kind !== 'oauth_client') throw new AuthError();
    const grant = (await client.query<{ expires_at: Date }>('SELECT expires_at FROM cauce_oauth_grants WHERE id=$1',
      [proof.grantId])).rows[0];
    if (!grant) throw new AuthError();
    return { client: { kind: proof.kind, verification: proof.verification, issuer: proof.issuer,
      client_id: proof.clientId, instance: proof.instance }, expires_at: grant.expires_at.toISOString(),
      connection_ref: clientConnectionReference(proof.issuer, identity.audience, owner.humanId,
        owner.tenantId, proof.grantId) };
  });
}
