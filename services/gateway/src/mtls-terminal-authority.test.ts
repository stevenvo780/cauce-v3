import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider, type MtlsIdentityProvider, type Principal } from './auth.js';
import { machineAuthorityOrigin, type MachineAuthorityOrigin, type VerifiedTerminalMachine } from './terminal/authority-continuity.js';

const key = await readFile(new URL('./test-fixtures/mtls-server-private.pem', import.meta.url));
const cert = await readFile(new URL('./test-fixtures/mtls-server-certificate.pem', import.meta.url));
const leaf = new X509Certificate(cert);
const fingerprint = createHash('sha256').update(leaf.raw).digest('hex');
const principal: Principal = { tenant_id: 'Steven', alias: 'kant', channel: 'adapter', session_id: 'mtls-kant',
  roles: ['operator'], permissions: ['control', 'read'] };
const applications: FastifyInstance[] = [];
let directory: string; let path: string; let rogueKey: Buffer; let rogueCert: Buffer;
let provider: MtlsAuthProvider; let app: FastifyInstance; let observed: VerifiedTerminalMachine | undefined;
let liveExpiry: number;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-mtls-'));
  path = join(directory, 'identities.json');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=cauce-test-untrusted', '-keyout', join(directory, 'rogue.key'), '-out', join(directory, 'rogue.crt')]);
  rogueKey = await readFile(join(directory, 'rogue.key')); rogueCert = await readFile(join(directory, 'rogue.crt'));
  provider = new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(path));
  app = await server(provider);
  console.info(`terminal-mtls fixture ${directory}`);
});

beforeEach(async () => {
  liveExpiry = Date.now() + 3_600_000;
  observed = undefined;
  await registry([{ certificate_sha256: fingerprint, expires_at: new Date(liveExpiry).toISOString(), principal }]);
});

afterAll(async () => {
  const results = await Promise.allSettled(applications.map((application) => application.close()));
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    console.info(`terminal-mtls fixture cleanup ${directory}`);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'mTLS fixture cleanup failed');
});

async function registry(identities: Record<string, unknown>[]): Promise<void> {
  const next = `${path}.next`;
  await writeFile(next, JSON.stringify({ version: 1, identities }), { mode: 0o600 });
  await rename(next, path);
}

async function server(auth: MtlsAuthProvider): Promise<FastifyInstance> {
  const application = Fastify({ https: { key, cert, ca: cert, requestCert: true, rejectUnauthorized: false } });
  applications.push(application);
  application.get('/verified', async (request) => {
    const result = await auth.verifiedTerminalMachine(request); observed = result;
    return { principal: result.principal, issuedAtMs: result.issuedAtMs, expiresAtMs: result.expiresAtMs,
      fingerprintMatches: result.certificateSha256 === fingerprint,
      frozen: Object.isFrozen(result) && Object.isFrozen(result.principal) };
  });
  application.get('/http', (request) => auth.authenticateHttp(request));
  await application.listen({ host: '127.0.0.1', port: 0 });
  return application;
}

function get(application = app, route = '/verified', client: 'trusted' | 'none' | 'untrusted' = 'trusted') {
  const address = application.server.address() as AddressInfo;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port: address.port, path: route, agent: false,
      ca: cert, rejectUnauthorized: true,
      ...(client === 'none' ? {} : client === 'trusted' ? { key, cert } : { key: rogueKey, cert: rogueCert }),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    request.once('error', reject); request.end();
  });
}

async function origin(): Promise<MachineAuthorityOrigin> {
  expect((await get()).status).toBe(200);
  if (observed === undefined) throw new Error('verified socket observation missing');
  return machineAuthorityOrigin(observed);
}

async function replacePrincipal(value: Principal, expiry = liveExpiry): Promise<void> {
  await registry([{ certificate_sha256: fingerprint, expires_at: new Date(expiry).toISOString(), principal: value }]);
}

describe('terminal authority from verified mTLS and current identity mapping', () => {
  it('uses a real authorized TLS leaf, stable certificate issuance and immutable DTOs on retries', async () => {
    const first = await origin(); const firstView = observed;
    const reply = await get();
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body) as unknown).toMatchObject({ issuedAtMs: Date.parse(leaf.validFrom),
      expiresAtMs: Math.min(Date.parse(leaf.validTo), liveExpiry), fingerprintMatches: true, frozen: true,
      principal: { tenant_id: 'Steven', alias: 'kant', channel: 'adapter', session_id: 'mtls-kant' } });
    expect(observed?.issuedAtMs).toBe(firstView?.issuedAtMs);
    expect(observed?.expiresAtMs).toBe(firstView?.expiresAtMs);
    if (observed === undefined) throw new Error('retry socket observation missing');
    expect(machineAuthorityOrigin(observed)).toEqual(first);
    const mapping = await new HashedMtlsIdentityFileProvider(path).resolveAuthority(leaf);
    expect(Object.isFrozen(mapping) && Object.isFrozen(mapping.principal)
      && Object.isFrozen(mapping.principal.roles) && Object.isFrozen(mapping.principal.permissions)).toBe(true);
  });

  it('caps the original deadline by certificate expiry even when the registry lasts longer', async () => {
    await replacePrincipal(principal, Date.parse(leaf.validTo) + 86_400_000);
    const value = await origin();
    expect(observed?.expiresAtMs).toBe(Date.parse(leaf.validTo));
    expect((await provider.revalidateTerminalMachine(value)).getTime()).toBe(value.expiresAtSeconds * 1000);
  });

  it('rejects plain HTTP, missing or untrusted client certificates before consulting any mapper', async () => {
    const resolve = vi.fn(async () => principal);
    const resolveAuthority = vi.fn(async () => ({ principal, expiresAtMs: liveExpiry }));
    const guarded = await server(new MtlsAuthProvider({ resolve, resolveAuthority }));
    expect((await guarded.inject({ method: 'GET', url: '/verified', headers: {
      'x-forwarded-client-cert': 'forged', 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant',
      cookie: '__Host-cauce_session=untrusted-test-input', authorization: 'Bearer untrusted-test-input',
    } })).statusCode).toBe(401);
    expect((await get(guarded, '/verified', 'none')).status).toBe(401);
    expect((await get(guarded, '/verified', 'untrusted')).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled(); expect(resolveAuthority).not.toHaveBeenCalled();
  });

  it('keeps generic mTLS HTTP authentication compatible while Terminal fails without metadata', async () => {
    const resolve = vi.fn(async () => principal); const generic = new MtlsAuthProvider({ resolve });
    const application = await server(generic);
    expect((await get(application)).status).toBe(401); expect(resolve).not.toHaveBeenCalled();
    expect((await get(application, '/http')).status).toBe(200); expect(resolve).toHaveBeenCalledTimes(1);
    await expect(generic.revalidateTerminalMachine(await origin())).rejects.toThrow('metadata is unavailable');
  });

  it('requires current fingerprint metadata even if admission metadata is available', async () => {
    const admissionOnly = new MtlsAuthProvider({ resolve: async () => principal,
      resolveAuthority: async () => ({ principal, expiresAtMs: liveExpiry }) });
    const application = await server(admissionOnly);
    expect((await get(application)).status).toBe(200);
    if (observed === undefined) throw new Error('admission observation missing');
    await expect(admissionOnly.revalidateTerminalMachine(machineAuthorityOrigin(observed)))
      .rejects.toThrow('metadata is unavailable');
  });

  it('rejects metadata that expired while the real TLS request awaited mapping', async () => {
    const slow = new MtlsAuthProvider({ resolve: async () => principal, resolveAuthority: async () => {
      const expiresAtMs = Date.now() + 10;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { principal, expiresAtMs };
    } });
    expect((await get(await server(slow))).status).toBe(401);
  });

  it('reloads registry expiry and cannot extend the original admitted deadline', async () => {
    const value = await origin();
    await replacePrincipal(principal, liveExpiry + 3_600_000);
    expect((await provider.revalidateTerminalMachine(value)).getTime()).toBe(value.expiresAtSeconds * 1000);
    const shorter = Date.now() + 60_000;
    await replacePrincipal(principal, shorter);
    expect((await provider.revalidateTerminalMachine(value)).getTime()).toBe(shorter);
  });

  it('revokes a removed or rotated fingerprint immediately after atomic registry replacement', async () => {
    const value = await origin();
    await registry([]);
    await expect(provider.revalidateTerminalMachine(value)).rejects.toThrow('identity file is invalid');
    await registry([{ certificate_sha256: 'a'.repeat(64), expires_at: new Date(liveExpiry).toISOString(), principal }]);
    await expect(provider.revalidateTerminalMachine(value)).rejects.toThrow('not provisioned');
    expect((await get()).status).toBe(401);
  });

  it('rejects expired mapping and an ambiguous fingerprint on admission and revalidation', async () => {
    const value = await origin();
    await replacePrincipal(principal, Date.now() - 1);
    await expect(provider.revalidateTerminalMachine(value)).rejects.toThrow('expired');
    expect((await get()).status).toBe(401);
    const record = { certificate_sha256: fingerprint, expires_at: new Date(liveExpiry).toISOString(), principal };
    await registry([record, record]);
    await expect(provider.revalidateTerminalMachine(value)).rejects.toThrow('ambiguous');
    expect((await get()).status).toBe(401);
  });

  it('fences every current principal identity coordinate against the original admission', async () => {
    const value = await origin();
    for (const changed of [{ tenant_id: 'Miguel' as const }, { alias: 'argos' }, { channel: 'changed' }, { session_id: 'changed' }]) {
      await replacePrincipal({ ...principal, ...changed });
      await expect(provider.revalidateTerminalMachine(value)).rejects.toThrow('identity changed');
    }
  });

  it('requires current operator role and CONTROL on admission and on renewal', async () => {
    const value = await origin();
    for (const changed of [{ roles: ['agent'] as const }, { permissions: ['read'] as const }]) {
      await replacePrincipal({ ...principal, ...changed });
      await expect(provider.revalidateTerminalMachine(value)).rejects.toMatchObject({ statusCode: 403 });
      expect((await get()).status).toBe(403);
    }
  });

  it('rejects malformed principal and expiry metadata instead of using generic resolve as fallback', async () => {
    for (const invalid of [{ principal, expiresAtMs: NaN }, { principal, expiresAtMs: 9_000_000_000_000_000 },
      { principal, expiresAtMs: Date.now() - 1 },
      { principal: { ...principal, roles: ['unknown'] as unknown as Principal['roles'] }, expiresAtMs: liveExpiry },
      { principal: { ...principal, permissions: ['unknown'] as unknown as Principal['permissions'] }, expiresAtMs: liveExpiry },
      { principal: { ...principal, channel: 'invalid channel' }, expiresAtMs: liveExpiry }]) {
      const resolve = vi.fn(async () => principal);
      const mapping: MtlsIdentityProvider = { resolve, resolveAuthority: async () => invalid };
      const application = await server(new MtlsAuthProvider(mapping));
      expect((await get(application)).status).toBe(401); expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid or non-live origin clocks before mapper lookup', async () => {
    const value = await origin(); const resolveFingerprintAuthority = vi.fn(async () => ({ principal, expiresAtMs: liveExpiry }));
    const guarded = new MtlsAuthProvider({ resolve: async () => principal, resolveFingerprintAuthority });
    for (const invalid of [{ ...value, expiresAtSeconds: Math.floor(Date.now() / 1000) },
      { ...value, issuedAtSeconds: Math.floor(Date.now() / 1000) + 60 },
      { ...value, issuedAtSeconds: value.issuedAtSeconds + 0.5 },
      { ...value, expiresAtSeconds: NaN },
      { ...value, certificateSha256: 'invalid' }]) {
      await expect(guarded.revalidateTerminalMachine(invalid)).rejects.toMatchObject({ statusCode: 401 });
    }
    expect(resolveFingerprintAuthority).not.toHaveBeenCalled();
  });
});
