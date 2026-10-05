import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { TLSSocket } from 'node:tls';
import { createSelfSignedCert } from '../../../tests/terminal-pty/certs.mjs';
import { parseAttachRequest } from './browser-leg.js';
import { HttpsTerminalGatewayClient, parseSessionGrant } from './gateway-client.js';
import { relayInstanceIdFromCertificate } from './relay-identity.js';
import { openSession, FakeBrowserSocket, cleanScratchDirectories } from './relay-session-fakes.js';
import {
  CLAIM_TOKEN, SESSION_ID, grant, harnesses, startHarness, connectConsole, attach,
  FakePtyAgent, TEST_AGENT_CERTIFICATE, TEST_AGENT_PRIVATE_KEY, waitFor,
} from './relay-test-fixtures.js';

const proof = `ac2.YQ.${'A'.repeat(43)}`;
const resumeToken = `r2.${Buffer.from(JSON.stringify(['r1.' + 'a'.repeat(100), proof])).toString('base64url')}`;
const parse = (body: Record<string, unknown>) => parseAttachRequest(Buffer.from(JSON.stringify(body)), false);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close();
  await cleanScratchDirectories();
});

describe('terminal authority carrier', () => {
  it('requires a bounded opaque ac2 proof for initial attach without trusting body identity', () => {
    const body = { type: 'attach', session_id: SESSION_ID, ticket: 'opaque', cols: 80, rows: 24, authority_proof: proof };
    expect(parse(body)).toMatchObject({ authority_proof: proof });
    for (const invalid of [undefined, null, 1, '', 'r1.a.b', `ac2.${'a'.repeat(4090)}.${'A'.repeat(43)}`]) {
      expect(parse({ ...body, authority_proof: invalid })).toBeUndefined();
    }
  });

  it('accepts r2 above the old1024 bound and rejects r1, oversized or missing proof', () => {
    const largeProof = `ac2.${'a'.repeat(4048)}.${'A'.repeat(43)}`;
    expect(largeProof.length).toBe(4096);
    const largeResume = `r2.${Buffer.from(JSON.stringify(['r1.' + 'a'.repeat(100), largeProof])).toString('base64url')}`;
    const body = { type: 'resume', session_id: SESSION_ID, resume_token: largeResume, authority_proof: largeProof,
      prior_claim_token: CLAIM_TOKEN, prior_claim_epoch: '1', after_bytes: 0, cols: 80, rows: 24 };
    expect(largeResume.length).toBeGreaterThan(1024);
    expect(parse(body)).toMatchObject({ resume_token: largeResume, authority_proof: largeProof });
    for (const invalid of ['r1.' + 'a'.repeat(100), `r2.${'a'.repeat(8190)}`, 'r2.$$$']) {
      expect(parse({ ...body, resume_token: invalid })).toBeUndefined();
    }
    expect(parse({ ...body, authority_proof: undefined })).toBeUndefined();
  });

  it('rejects grants missing or changing the credential wire shape', () => {
    const valid = { ...grant(), authority_proof: proof, resume_token: resumeToken,
      ok: true, claim_taken_over: false, expires_at: new Date(Date.now() + 30000).toISOString() };
    expect(parseSessionGrant(JSON.stringify(valid))).toMatchObject({ authority_proof: proof });
    for (const invalid of [{ authority_proof: undefined }, { authority_proof: 'not-ac2' },
      { authority_proof: proof + 'a'.repeat(4096) }, { resume_token: 'r1.' + 'a'.repeat(100) }, { extra: true }]) {
      expect(parseSessionGrant(JSON.stringify({ ...valid, ...invalid }))).toBeUndefined();
    }
  });

  it('rejects a real TLS browser attach without proof before consume or OPEN', async () => {
    const harness = await startHarness();
    const browser = await connectConsole(harness.browserPort);
    attach(browser, { authority_proof: undefined });
    await waitFor(() => browser.closes.length > 0);
    expect(harness.gateway.consumeCalls).toBe(0);
  });

  it('carries proof over real TLS attach and periodic authz without giving it to the PTY agent', async () => {
    const harness = await startHarness({ authzIntervalMs: 20 });
    const agent = await FakePtyAgent.connect(harness.agentPort,
      { cert: TEST_AGENT_CERTIFICATE, key: TEST_AGENT_PRIVATE_KEY },
      { v: 1, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'a'.repeat(32),
        image_id: 'sha256:fixture', runtime_user: 'claw', runtime_uid: 1000, harness: 'openclaw', agent_version: '2', modes: ['shell'] });
    await waitFor(() => harness.leg.presence().length === 1);
    const browser = await connectConsole(harness.browserPort);
    attach(browser, { authority_proof: proof });
    await waitFor(() => browser.text.some((frame) => frame.type === 'ready'));
    await waitFor(() => harness.gateway.authzProofs.length > 0);
    expect(harness.gateway.consumeProofs).toEqual([proof]);
    expect(harness.gateway.authzProofs.every((value) => value === proof)).toBe(true);
    expect(agent.opens).toHaveLength(1);
    expect(Object.keys(agent.opens[0] ?? {}).sort()).toEqual(['cols', 'mode', 'rows', 'session_id', 'ticket']);
    agent.destroy(); browser.socket.close();
  });

  it('never reattaches a live PTY to a replacement proof or new admission', async () => {
    const admitted = grant();
    const opened = await openSession({ reconnectGraceMs: 1000 }, admitted);
    try {
      opened.socket.close(1006, 'network_lost');
      const browser = new FakeBrowserSocket();
      const input = { socket: browser.asWebSocket(), sessionId: SESSION_ID, grant: admitted,
        cols: 80, rows: 24, afterBytes: 0 };
      expect(opened.manager.reattach({ ...input, grant: { ...admitted, authority_proof: proof.replace('YQ', 'Yg') } })).toBe(false);
      expect(opened.manager.reattach(input)).toBe(true);
      expect(opened.agent.opens).toHaveLength(1);
    } finally {
      opened.manager.closeAll(1000, 'test_teardown');
      await opened.manager.flush();
    }
  });

  it('forwards exact proofs over authenticated HTTPS and rejects altered successful replies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-authority-wire-'));
    const material = createSelfSignedCert({ directory });
    const identity = { relayInstanceId: relayInstanceIdFromCertificate(material.cert),
      relayBootId: '11111111-1111-4111-8111-111111111111' };
    const bodies: Record<string, unknown>[] = [];
    const tlsAuthorized: boolean[] = [];
    let responseProof: unknown = proof;
    let extra = false;
    const server = createServer({ cert: material.cert, key: material.key, ca: material.cert,
      requestCert: true, rejectUnauthorized: true }, (request, reply) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        tlsAuthorized.push(request.socket instanceof TLSSocket && request.socket.authorized);
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        const common = { ok: true, authority_proof: responseProof, expires_at: new Date(Date.now() + 30000).toISOString(),
          claim_epoch: '1', claim_lease_ms: 150000, claim_lease_ttl_ms: 150000,
          relay_instance_id: identity.relayInstanceId, relay_boot_id: identity.relayBootId };
        const response = request.url?.endsWith('/authz') ? common
          : { ...grant(), ...common, resume_token: resumeToken, claim_taken_over: false };
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ ...response, ...(extra ? { extra: true } : {}) }));
      });
    });
    try {
      const tokenFile = join(directory, 'relay-token');
      await writeFile(tokenFile, 'fixture-transport-only', { mode: 0o600 });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const client = new HttpsTerminalGatewayClient({ gatewayUrl: `https://localhost:${String((server.address() as AddressInfo).port)}`,
        tokenFile, ca: material.cert, clientCert: material.cert, clientKey: material.key, identity });
      expect((await client.consumeTicket(SESSION_ID, 'opaque-v1', CLAIM_TOKEN, proof)).status).toBe('granted');
      expect((await client.resumeSession(SESSION_ID, resumeToken, CLAIM_TOKEN, proof, '1')).status).toBe('granted');
      expect((await client.authorizeSession(SESSION_ID, CLAIM_TOKEN, '1', proof)).status).toBe('allow');
      expect(bodies).toHaveLength(3);
      expect(tlsAuthorized).toEqual([true, true, true]);
      expect(bodies.every((body) => body.authority_proof === proof && body.claim_token === CLAIM_TOKEN
        && body.relay_instance_id === identity.relayInstanceId && body.relay_boot_id === identity.relayBootId)).toBe(true);
      expect(bodies[1]).toMatchObject({ resume_token: resumeToken, claim_epoch: '1' });
      for (const changed of [undefined, proof.replace('YQ', 'Yg')]) {
        responseProof = changed;
        expect((await client.consumeTicket(SESSION_ID, 'opaque-v1', CLAIM_TOKEN, proof)).status).toBe('unavailable');
        expect((await client.resumeSession(SESSION_ID, resumeToken, CLAIM_TOKEN, proof, '1')).status).toBe('unavailable');
        expect((await client.authorizeSession(SESSION_ID, CLAIM_TOKEN, '1', proof)).status).toBe('unreachable');
      }
      responseProof = proof; extra = true;
      expect((await client.authorizeSession(SESSION_ID, CLAIM_TOKEN, '1', proof)).status).toBe('unreachable');
      const calls = bodies.length;
      expect((await client.authorizeSession(SESSION_ID, CLAIM_TOKEN, '1', '')).status).toBe('revoked');
      expect((await client.resumeSession(SESSION_ID, 'r1.legacy', CLAIM_TOKEN, proof, '1')).status).toBe('resume_invalid');
      expect(bodies).toHaveLength(calls);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
