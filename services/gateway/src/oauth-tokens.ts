import { randomUUID, sign, verify, createPublicKey, type KeyObject } from 'node:crypto';
import { isAnyUuid } from '@cauce/protocol';
import { oauthOrigin, scopes, type OAuthAccessIdentity, type OAuthIssuedToken, type OAuthTokenInput } from './oauth-authorization-types.js';

export class OAuthTokens {
  readonly issuer: string;
  readonly resource: string;
  private readonly header: string;
  private readonly publicKey: KeyObject;
  private readonly now: () => number;
  private readonly ttlSeconds: number;

  constructor(private readonly options: {
    issuer: string;
    resource: string;
    signingKey: KeyObject;
    kid: string;
    ttlSeconds?: number;
    now?: () => number;
  }) {
    this.issuer = oauthOrigin(options.issuer);
    this.resource = `${this.issuer}/mcp`;
    this.ttlSeconds = options.ttlSeconds ?? 300;
    if (options.resource !== this.resource || options.signingKey.type !== 'private'
        || options.signingKey.asymmetricKeyType !== 'ec'
        || options.signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(options.kid)
        || !Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds < 1 || this.ttlSeconds > 300) {
      throw new Error('OAuth signing configuration is invalid');
    }
    this.now = options.now ?? Date.now;
    this.publicKey = createPublicKey(options.signingKey);
    this.header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: options.kid })).toString('base64url');
  }

  jwks() {
    return { keys: [{ ...this.publicKey.export({ format: 'jwk' }), kid: this.options.kid, alg: 'ES256', use: 'sig' }] };
  }

  issue(input: OAuthTokenInput): OAuthIssuedToken {
    const now = Math.floor(this.now() / 1000);
    const expiresAt = Math.min(now + this.ttlSeconds, Math.floor(input.expiresAt));
    if (!isAnyUuid(input.userId) || !isAnyUuid(input.grantId) || !Number.isFinite(input.expiresAt) || expiresAt <= now) {
      throw new Error('OAuth token input is invalid');
    }
    const granted = scopes(input.scopes.join(' '));
    const identity: OAuthAccessIdentity = Object.freeze({ kind: 'oauth', authorizationServer: 'local', issuer: this.issuer,
      subject: input.userId, audience: this.resource, expiresAt, scopes: granted,
      grantId: input.grantId, tokenId: randomUUID() });
    const payload = Buffer.from(JSON.stringify({ iss: this.issuer, aud: this.resource, sub: input.userId,
      iat: now, exp: expiresAt, scope: granted.join(' '), gid: input.grantId, jti: identity.tokenId })).toString('base64url');
    const body = `${this.header}.${payload}`;
    const signature = sign('sha256', Buffer.from(body), {
      key: this.options.signingKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return { token: `${body}.${signature}`, identity };
  }

  verify(token: string): OAuthAccessIdentity | undefined {
    if (token.length > 4096) return undefined;
    try {
      const parts = token.split('.');
      const [header, payload, signature] = parts;
      if (parts.length !== 3 || header !== this.header || !payload || !signature
          || !/^[A-Za-z0-9_-]+$/u.test(payload) || !/^[A-Za-z0-9_-]+$/u.test(signature)
          || !verify('sha256', Buffer.from(`${header}.${payload}`),
            { key: this.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) return undefined;
      const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const p = value as Record<string, unknown>;
      const now = this.now() / 1000;
      if (p.iss !== this.issuer || p.aud !== this.resource || !isAnyUuid(p.sub) || !isAnyUuid(p.gid)
          || !isAnyUuid(p.jti) || typeof p.exp !== 'number' || typeof p.iat !== 'number'
          || !Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat)
          || p.iat > now || p.exp <= now || p.exp - p.iat > this.ttlSeconds) return undefined;
      return Object.freeze({ kind: 'oauth', authorizationServer: 'local', issuer: this.issuer, subject: p.sub, audience: this.resource,
        expiresAt: p.exp, scopes: scopes(p.scope), grantId: p.gid, tokenId: p.jti });
    } catch { return undefined; }
  }
}
