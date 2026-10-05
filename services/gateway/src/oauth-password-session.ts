import type { FastifyRequest } from 'fastify';
import { isAnyUuid } from '@cauce/protocol';
import { PasswordAuthProvider } from './password-auth.js';
import { OAuthError, type OAuthPasswordSession } from './oauth-authorization-types.js';

export function createOAuthPasswordSession(options: {
  provider: PasswordAuthProvider;
}): (request: FastifyRequest) => Promise<OAuthPasswordSession> {
  return async (request) => {
    try {
      const session = await options.provider.verifiedConsoleSession(request);
      const auth = await options.provider.authState(request);
      if (!session || !isAnyUuid(session.humanId) || !session.credentialStamp || !auth.csrf_token) {
        throw new OAuthError('access_denied');
      }
      return Object.freeze({ userId: session.humanId, issuedAt: session.issuedAtMs / 1000,
        expiresAt: session.expiresAtMs / 1000, csrf: auth.csrf_token, credentialStamp: session.credentialStamp });
    } catch { throw new OAuthError('access_denied'); }
  };
}
