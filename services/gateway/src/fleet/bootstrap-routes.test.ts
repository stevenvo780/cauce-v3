import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, MtlsAuthProvider } from '../auth.js';
import { registerBootstrapRoutes } from './bootstrap-routes.js';
import { bootstrapPrompt, type BootstrapAck, type BootstrapIdentity, type BootstrapReceipt, type BootstrapDescriptor } from './bootstrap-contracts.js';
import { BootstrapClient, type BootstrapProof } from '../../../../packages/adapter-sdk/src/sdk/bootstrap-client.js';

const execute = promisify(execFile);
let directory: string; let app: FastifyInstance; let origin: string;
const operationId = '00000000-0000-4000-8000-000000000001';
const probe: BootstrapDescriptor = { operation_id: operationId, phase: 'bootstrap', action: 'verify', nonce: 'a'.repeat(64),
  account_id: 'boot-account', profile_revision: 1, probe_id: '00000000-0000-4000-8000-000000000002', tenant_id: 'Steven', alias: 'boot-agent',
  runtime_key: 'boot-agent', harness_id: 'codex', model_id: 'test-model', deadline: new Date(Date.now() + 120_000).toISOString(),
  prompt: bootstrapPrompt('a'.repeat(64)), documents: [{ name: 'AGENTS.md', sha256: 'b'.repeat(64), native_revision: null }] };
const claim = { ...probe, claim_token: 'c'.repeat(64) };
const repository = {
  create: vi.fn(async () => ({ probe, state: 'pending' as const, proof: null })),
  read: vi.fn(async () => ({ probe, state: 'pending' as const, proof: null })),
  claim: vi.fn(async () => claim),
  ack: vi.fn(async (_identity: BootstrapIdentity, _id: string, input: BootstrapAck): Promise<BootstrapReceipt> => { const { claim_token: _token, ...proof } = input; return { probe, state: 'succeeded' as const, proof }; }),
  profile: vi.fn(), state: vi.fn(),
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-bootstrap-mtls-'));
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Bootstrap Test CA',
    '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.crt')]);
  await writeFile(join(directory, 'extensions'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  for (const name of ['server', 'bootstrap', 'normal']) {
    await execute('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.csr`)]);
    await execute('openssl', ['x509', '-req', '-in', join(directory, `${name}.csr`), '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'ca.key'),
      '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'extensions'), '-out', join(directory, `${name}.crt`)]);
  }
  const provider = (phase: 'bootstrap' | 'normal') => new MtlsAuthProvider({ resolve: async certificate => {
    if (certificate.subject !== `CN=${phase}`) throw new AuthError();
    return { tenant_id: 'Steven', alias: 'boot-agent', channel: phase === 'bootstrap' ? 'bootstrap' : 'adapter', session_id: `certificate-${phase}`,
      roles: phase === 'bootstrap' ? [] : ['adapter'], permissions: phase === 'bootstrap' ? [] : ['read', 'route'] };
  } });
  app = Fastify({ https: { key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.crt')),
    ca: await readFile(join(directory, 'ca.crt')), requestCert: true, rejectUnauthorized: true } });
  registerBootstrapRoutes(app, provider('bootstrap'), provider('normal'), repository);
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => { await app.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function call(path: string, phase: 'bootstrap' | 'normal', certificate: 'bootstrap' | 'normal', payload?: unknown, headers: Record<string, string> = {}) {
  const tls = { cert: await readFile(join(directory, `${certificate}.crt`)), key: await readFile(join(directory, `${certificate}.key`)), ca: await readFile(join(directory, 'ca.crt')) };
  return new Promise<{ status: number | undefined; body: string; cache: string | undefined }>((resolve, reject) => {
    const req = request(new URL(path, origin), { ...tls, method: payload === undefined ? 'GET' : 'POST', headers: {
      'x-cauce-bootstrap-phase': phase, 'content-type': 'application/json', ...headers,
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), cache: response.headers['cache-control'] }); });
    });
    req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}
describe('bootstrap routes with actual TLS client certificates', () => {
  it('isolates bootstrap and normal certificates and binds all calls to the certificate identity', async () => {
    const payload = { operation_id: operationId, phase: 'bootstrap', runtime_key: 'boot-agent' };
    expect((await call('/v3/bootstrap/claim', 'bootstrap', 'bootstrap', payload)).status).toBe(200);
    expect(repository.claim).toHaveBeenCalledWith({ tenant_id: 'Steven', alias: 'boot-agent' }, operationId, 'bootstrap', 'boot-agent');
    const invalid = await call('/v3/bootstrap/claim', 'bootstrap', 'normal', payload);
    expect(invalid.status).toBe(403); expect(invalid.body).toBe('{"error":"forbidden"}');
    expect((await call('/v3/bootstrap/claim', 'normal', 'bootstrap', { ...payload, phase: 'normal' })).status).toBe(403);
    expect(repository.claim).toHaveBeenCalledTimes(1);
  });
  it('rejects forwarded certificate headers, bearer, cookies and arbitrary fields without leaking request data', async () => {
    const payload = { operation_id: operationId, phase: 'bootstrap', runtime_key: 'boot-agent' };
    expect((await call('/v3/bootstrap/claim', 'bootstrap', 'bootstrap', payload, { authorization: 'Bearer synthetic-private' })).status).toBe(403);
    expect((await call('/v3/bootstrap/claim', 'bootstrap', 'bootstrap', payload, { cookie: 'synthetic=private' })).status).toBe(403);
    const invalid = await call('/v3/bootstrap/claim', 'bootstrap', 'bootstrap', { ...payload, prompt: 'synthetic-private' });
    expect(invalid.status).toBe(400); expect(invalid.body).not.toContain('synthetic-private'); expect(repository.claim).not.toHaveBeenCalled();
    const injected = await app.inject({ method: 'POST', url: '/v3/bootstrap/claim', payload, headers: { 'x-forwarded-client-cert': 'synthetic' } });
    expect(injected.statusCode).toBe(403);
  });
  it('uses an actual mTLS SDK client, keeps the claim out of GET receipts and rejects false ACK receipts', async () => {
    const client = new BootstrapClient({ origin, operation_id: operationId, phase: 'bootstrap', runtime_key: 'boot-agent', tls: {
      certFile: join(directory, 'bootstrap.crt'), keyFile: join(directory, 'bootstrap.key'), caFile: join(directory, 'ca.crt'),
    } });
    try {
      expect(await client.claim(new AbortController().signal)).toEqual(claim);
      const publicReceipt = await call(`/v3/bootstrap/probes/${probe.probe_id}`, 'bootstrap', 'bootstrap');
      expect(publicReceipt.cache).toBe('no-store'); expect(publicReceipt.body).not.toContain(claim.claim_token);
      const proof: BootstrapProof = { operation_id: operationId, phase: 'bootstrap', runtime_key: probe.runtime_key, nonce: probe.nonce,
        claim_token: claim.claim_token, account_id: probe.account_id, profile_revision: 1, harness_id: probe.harness_id, model_id: probe.model_id,
        documents: probe.documents, reply: `CAUCE_BOOTSTRAP_${probe.nonce}`, harness_started: true };
      await client.ack(claim, proof, new AbortController().signal);
      repository.ack.mockResolvedValueOnce({ probe, state: 'succeeded', proof: null });
      await expect(client.ack(claim, proof, new AbortController().signal)).rejects.toThrow('invalid bootstrap acknowledgment');
    } finally { client.close(); }
  });
});
