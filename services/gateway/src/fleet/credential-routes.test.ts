import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MtlsAuthProvider } from '../auth.js';
import { registerFleetCredentialRoutes } from './credential-routes.js';
import { FleetMtlsIdentityProvider, FleetTokenProbeAuthProvider } from './mtls-identities.js';

const execute = promisify(execFile);
let directory: string; let app: FastifyInstance; let origin: string; let fingerprint: string;
const token = 'a'.repeat(64);
const ownerUid = process.geteuid?.() ?? 0;
const principal = { tenant_id: 'Steven', alias: 'credential-fixture', channel: 'bootstrap', session_id: 'bootstrap-fixture', roles: [], permissions: [] };
const expires = () => new Date(Date.now() + 60_000).toISOString();
async function registry(name: string, identities: unknown[]) {
  await writeFile(join(directory, name), JSON.stringify({ version: 1, identities }), { mode: 0o600 });
}
beforeAll(async () => {
  directory = await mkdtemp('/var/tmp/cauce-credential-tls-');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Credential Test CA',
    '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.crt')]);
  await writeFile(join(directory, 'extensions'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  for (const name of ['server', 'client']) {
    await execute('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.csr`)]);
    await execute('openssl', ['x509', '-req', '-in', join(directory, `${name}.csr`), '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'ca.key'),
      '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'extensions'), '-out', join(directory, `${name}.crt`)]);
  }
  fingerprint = new X509Certificate(await readFile(join(directory, 'client.crt'))).fingerprint256.replaceAll(':', '').toLowerCase();
  await registry('base.json', []);
  const provider = (namespace: 'bootstrap' | 'normal') => new MtlsAuthProvider(new FleetMtlsIdentityProvider(
    join(directory, 'base.json'), join(directory, 'fleet.json'), namespace, ownerUid));
  app = Fastify({ https: { key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.crt')),
    ca: await readFile(join(directory, 'ca.crt')), requestCert: true, rejectUnauthorized: true } });
  registerFleetCredentialRoutes(app, { bootstrap: provider('bootstrap'), normal: provider('normal'),
    token: new FleetTokenProbeAuthProvider(join(directory, 'token.json'), ownerUid) });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(async () => {
  await registry('fleet.json', [{ certificate_sha256: fingerprint, principal, expires_at: expires() }]);
  await registry('token.json', [{ token_sha256: createHash('sha256').update(token).digest('hex'), principal, expires_at: expires() }]);
});
afterAll(async () => { await app.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function call(kind: 'mtls' | 'token', phase = 'bootstrap') {
  const tls = { cert: await readFile(join(directory, 'client.crt')), key: await readFile(join(directory, 'client.key')), ca: await readFile(join(directory, 'ca.crt')) };
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request(new URL(`/v3/bootstrap/credentials/${kind}`, origin), { ...tls, headers: {
      'x-cauce-bootstrap-phase': phase, ...(kind === 'token' ? { authorization: `Bearer ${token}` } : {}),
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
    });
    req.on('error', reject); req.end();
  });
}
describe('credential rejection with actual TLS and live registries', () => {
  it('accepts restricted credentials without route permissions and reports their exact removal', async () => {
    expect(await call('mtls')).toEqual({ status: 200, body: { credential_accepted: true, phase: 'bootstrap',
      tenant_id: principal.tenant_id, alias: principal.alias, session_id: principal.session_id } });
    await registry('fleet.json', []);
    expect(await call('mtls')).toEqual({ status: 401, body: { error: 'CREDENTIAL_REJECTED' } });
  });
  it('tests bearer revocation independently of the certificate mapping on the authorized TLS transport', async () => {
    await registry('fleet.json', []);
    expect((await call('token')).status).toBe(200);
    await registry('token.json', []);
    expect(await call('token')).toEqual({ status: 401, body: { error: 'CREDENTIAL_REJECTED' } });
  });
  it('does not credit an unreadable registry, duplicate mapping or wrong namespace as revocation', async () => {
    expect((await call('mtls', 'normal')).status).toBe(503);
    await registry('fleet.json', Array.from({ length: 2 }, () => ({ certificate_sha256: fingerprint, principal, expires_at: expires() })));
    expect((await call('mtls')).status).toBe(503);
    await rm(join(directory, 'fleet.json'));
    expect((await call('mtls')).status).toBe(503);
    expect((await app.inject({ url: '/v3/bootstrap/credentials/mtls', headers: { 'x-cauce-bootstrap-phase': 'bootstrap' } })).statusCode).toBe(403);
  });
});
