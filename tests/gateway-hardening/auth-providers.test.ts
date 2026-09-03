import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DevOnlyAuthProvider, HashedTokenFileAuthProvider, JwksJwtAuthProvider, MtlsAuthProvider
} from '../../services/gateway/src/index.js';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

type AuthRequest = Parameters<JwksJwtAuthProvider['authenticateHttp']>[0];

const live = new Date(Date.now() + 3_600_000).toISOString();
const lapsed = new Date(Date.now() - 3_600_000).toISOString();

function request(headers: Record<string, string>, socket: object = {}): AuthRequest {
  return { headers, raw: { socket } } as AuthRequest;
}

function cookieRequest(secret: string): AuthRequest {
  return request({ cookie: `__Host-cauce_session=${encodeURIComponent(secret)}` });
}

function token(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('production authentication providers', () => {
  it('accepts only a verified JWKS token and ignores spoof headers', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new JwksJwtAuthProvider({
      issuer: 'https://issuer.test',
      audience: 'cauce-gateway',
      jwksUrl: 'https://issuer.test/.well-known/jwks.json',
      fetcher
    });
    const now = Math.floor(Date.now() / 1_000);
    const valid = token(pair.privateKey, {
      iss: 'https://issuer.test', aud: 'cauce-gateway', sub: 'subject-1', exp: now + 300,
      tenant_id: 'Pablo', alias: 'midas', sid: 'signed-session', channel: 'signed-channel',
      roles: ['agent'], permissions: ['route', 'read']
    });

    const principal = await provider.authenticateHttp(request({
      authorization: `Bearer ${valid}`,
      'x-cauce-tenant': 'Steven',
      'x-cauce-session': 'spoofed'
    }));

    expect(principal).toMatchObject({ tenant_id: 'Pablo', alias: 'midas', session_id: 'signed-session' });
    expect(fetcher).toHaveBeenCalledOnce();

    const tampered = `${valid.slice(0, valid.lastIndexOf('.') + 1)}invalid`;
    await expect(provider.authenticateHttp(request({ authorization: `Bearer ${tampered}` })))
      .rejects.toThrow('signature is invalid');
  });

  it('rejects dev headers in production even when explicitly requested', async () => {
    process.env.NODE_ENV = 'production';
    const provider = new DevOnlyAuthProvider({ enabled: true, environment: 'development' });
    await expect(provider.authenticateHttp(request({
      'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas'
    }))).rejects.toThrow('disabled');
  });

  it('rejects unverified mTLS and never trusts forwarded certificate headers', async () => {
    const resolver = { resolve: vi.fn() };
    const provider = new MtlsAuthProvider(resolver);
    await expect(provider.authenticateHttp(request({
      'x-forwarded-client-cert': 'forged-certificate'
    }))).rejects.toThrow('verified client certificate is required');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('authenticates a pilot cookie only through a file-held hash and fails closed on rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-auth-'));
    const path = join(directory, 'identities.json');
    const pilotToken = 'test-only-pilot-token-with-sufficient-entropy';
    const digest = createHash('sha256').update(pilotToken).digest('hex');
    const principal = {
      tenant_id: 'Steven', alias: 'kant', session_id: 'pilot-session', channel: 'console',
      roles: ['operator'], permissions: ['route', 'read', 'control']
    };
    try {
      await writeFile(path, JSON.stringify({
        version: 1, identities: [{ token_sha256: digest, expires_at: live, principal }]
      }), { mode: 0o600 });
      const provider = new HashedTokenFileAuthProvider({ path });
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}`
      }))).resolves.toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}`,
        authorization: `Bearer ${pilotToken}`
      }))).rejects.toThrow('exactly one');
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}; __Host-cauce_session=attacker-value`
      }))).rejects.toThrow('exactly one pilot token credential is required');
      await expect(provider.authenticateHttp(request({
        cookie: '__Host-cauce_session=%E0%A4%A'
      }))).rejects.toThrow('exactly one pilot token credential is required');

      await writeFile(path, JSON.stringify({
        version: 1,
        identities: [{
          token_sha256: createHash('sha256').update('rotated-test-token-value-that-is-long-enough').digest('hex'),
          expires_at: live,
          principal
        }]
      }), { mode: 0o600 });
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}`
      }))).rejects.toThrow('not recognized');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('overlaps two distinct live records for one principal and fails closed on expiry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-auth-overlap-'));
    const path = join(directory, 'identities.json');
    const outgoing = 'test-only-outgoing-token-with-sufficient-entropy';
    const incoming = 'test-only-incoming-token-with-sufficient-entropy';
    const principal = {
      tenant_id: 'Steven', alias: 'kant', session_id: 'pilot-session', channel: 'console',
      roles: ['operator'], permissions: ['route', 'read', 'control']
    };
    const record = (secret: string, expires_at: string): Record<string, unknown> => ({
      token_sha256: createHash('sha256').update(secret).digest('hex'), expires_at, principal
    });
    const provider = new HashedTokenFileAuthProvider({ path });
    try {
      await writeFile(path, JSON.stringify({
        version: 1, identities: [record(outgoing, live), record(incoming, live)]
      }), { mode: 0o600 });
      await expect(provider.authenticateHttp(cookieRequest(outgoing)))
        .resolves.toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
      await expect(provider.authenticateHttp(cookieRequest(incoming)))
        .resolves.toMatchObject({ tenant_id: 'Steven', alias: 'kant' });

      await writeFile(path, JSON.stringify({
        version: 1, identities: [record(outgoing, lapsed), record(incoming, live)]
      }), { mode: 0o600 });
      await expect(provider.authenticateHttp(cookieRequest(outgoing))).rejects.toThrow('expired');
      await expect(provider.authenticateHttp(cookieRequest(incoming)))
        .resolves.toMatchObject({ alias: 'kant' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails only the immortal record and leaves the rest of the file live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-auth-partial-'));
    const path = join(directory, 'identities.json');
    const immortal = 'test-only-immortal-token-with-sufficient-entropy';
    const rotated = 'test-only-rotated-token-with-sufficient-entropy';
    const principal = {
      tenant_id: 'Steven', alias: 'kant', session_id: 'pilot-session', channel: 'console',
      roles: ['operator'], permissions: ['route', 'read', 'control']
    };
    const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        identities: [
          { token_sha256: digest(immortal), principal },
          { token_sha256: digest(rotated), expires_at: live, principal },
        ]
      }), { mode: 0o600 });
      const provider = new HashedTokenFileAuthProvider({ path });
      // A single legacy record used to revoke mTLS and pilot auth for the whole fleet at once.
      await expect(provider.authenticateHttp(cookieRequest(rotated)))
        .resolves.toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
      await expect(provider.authenticateHttp(cookieRequest(immortal)))
        .rejects.toThrow('identity expiry is missing');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an identity record that carries no expiry at all', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-auth-immortal-'));
    const path = join(directory, 'identities.json');
    const immortalToken = 'test-only-immortal-token-with-sufficient-entropy';
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        identities: [{
          token_sha256: createHash('sha256').update(immortalToken).digest('hex'),
          principal: {
            tenant_id: 'Steven', alias: 'kant', session_id: 'pilot-session', channel: 'console',
            roles: ['operator'], permissions: ['route', 'read', 'control']
          }
        }]
      }), { mode: 0o600 });
      const provider = new HashedTokenFileAuthProvider({ path });
      await expect(provider.authenticateHttp(cookieRequest(immortalToken)))
        .rejects.toThrow('identity expiry is missing');

      await writeFile(path, JSON.stringify({
        version: 1,
        identities: [{
          token_sha256: createHash('sha256').update(immortalToken).digest('hex'),
          expires_at: 'no es una fecha',
          principal: {
            tenant_id: 'Steven', alias: 'kant', session_id: 'pilot-session', channel: 'console',
            roles: ['operator'], permissions: ['route', 'read', 'control']
          }
        }]
      }), { mode: 0o600 });
      await expect(provider.authenticateHttp(cookieRequest(immortalToken)))
        .rejects.toThrow('identity expiry is invalid');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
