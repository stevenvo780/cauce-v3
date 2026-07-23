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

function request(headers: Record<string, string>, socket: object = {}): AuthRequest {
  return { headers, raw: { socket } } as AuthRequest;
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
        version: 1, identities: [{ token_sha256: digest, principal }]
      }), { mode: 0o600 });
      const provider = new HashedTokenFileAuthProvider({ path });
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}`
      }))).resolves.toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}`,
        authorization: `Bearer ${pilotToken}`
      }))).rejects.toThrow('exactly one');

      await writeFile(path, JSON.stringify({
        version: 1,
        identities: [{ token_sha256: createHash('sha256').update('rotated-test-token-value-that-is-long-enough').digest('hex'), principal }]
      }), { mode: 0o600 });
      await expect(provider.authenticateHttp(request({
        cookie: `__Host-cauce_session=${encodeURIComponent(pilotToken)}`
      }))).rejects.toThrow('not recognized');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
