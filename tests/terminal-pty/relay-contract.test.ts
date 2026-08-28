// Interoperability suite for the PTY channel: fake gateway / relay contract.
//
// Run: pnpm vitest run tests/terminal-pty/relay-contract.test.ts

import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import { startFakeGateway, type FakeGatewayHandle } from './fake-gateway.mjs';
import {
  deriveAliasKey, mintTicket, ticketPayload as protocolTicketPayload,
  type TicketOverrides, type TicketPayload,
} from './protocol.mjs';

const MASTER_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const RELAY_TOKEN = 'harness-relay-token';
const TENANT = 'Steven';
const ALIAS = 'jarvis';
const CONTAINER = 'claw';
const GENERATION = 'gen-1';
const IMAGE = 'sha256:deadbeef';
const RELAY_BOOT_ID = '11111111-1111-4111-8111-111111111111';
const RELAY_BOOT_ID_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '12345678-1234-4234-8234-123456789abc';

const aliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, ALIAS);
const otherAliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, 'kant');

let tls: SelfSignedCert;
let relayInstanceId = '';

function identified(
  body: Record<string, unknown> = {},
  instanceId = relayInstanceId,
  bootId = RELAY_BOOT_ID,
): Record<string, unknown> {
  return {
    ...body,
    relay_instance_id: instanceId,
    relay_boot_id: bootId,
  };
}

function claimed(ticket: string, claimToken = CLAIM_TOKEN, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return identified({ ticket, claim_token: claimToken, ...extra });
}

function authorized(claimToken = CLAIM_TOKEN, claimEpoch = '1'): Record<string, unknown> {
  return identified({ claim_token: claimToken, claim_epoch: claimEpoch });
}

const ticketPayload = (overrides: TicketOverrides = {}): TicketPayload =>
  protocolTicketPayload({
    tenant: TENANT,
    alias: ALIAS,
    container: CONTAINER,
    generation: GENERATION,
    image: IMAGE,
    ...overrides,
  });

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Minimal JSON client that trusts only the harness CA — global fetch cannot be given one. */
async function callGateway(
  gateway: FakeGatewayHandle,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<JsonResponse> {
  const url = new URL(path, gateway.url);
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8');
  const token = options.token === undefined ? gateway.token : options.token;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<JsonResponse>((resolve, reject) => {
    const clientRequest = send(url, { method, headers, ca: gateway.ca, servername: 'localhost' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        if (raw.length > 0) body = JSON.parse(raw) as Record<string, unknown>;
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    clientRequest.on('error', reject);
    if (payload) clientRequest.write(payload);
    clientRequest.end();
  });
}

beforeAll(() => {
  tls = createSelfSignedCert();
  relayInstanceId = createHash('sha256').update(new X509Certificate(tls.cert).raw).digest('hex');
});

afterAll(() => {
  if (tls) rmSync(tls.directory, { recursive: true, force: true });
});

describe('fake gateway: the /v3/terminal/relay contract', () => {
  const gateways: FakeGatewayHandle[] = [];

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  });

  async function gatewayWith(options: Parameters<typeof startFakeGateway>[0] = {}): Promise<FakeGatewayHandle> {
    const gateway = await startFakeGateway({
      master_key_b64: MASTER_KEY_B64,
      relay_token: RELAY_TOKEN,
      relay_instance_id: relayInstanceId,
      ...options,
    });
    gateways.push(gateway);
    const presence = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [] }),
    });
    expect(presence).toEqual({
      status: 200,
      body: { ok: true, relay_instance_id: relayInstanceId, relay_boot_id: RELAY_BOOT_ID },
    });
    return gateway;
  }

  it('rejects every endpoint without the relay bearer token', async () => {
    const gateway = await gatewayWith();
    const registration = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [] }), token: null,
    });
    expect(registration.status).toBe(401);
    const authz = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${randomUUID()}/authz`, {
      body: authorized(), token: 'wrong',
    });
    expect(authz.status).toBe(401);
  });

  it('registers a granted agent and refuses one that is not in grants.json', async () => {
    const gateway = await gatewayWith({ grants: [`${TENANT}:${ALIAS}`] });
    const granted = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [{ tenant_id: TENANT, alias: ALIAS, container_id: CONTAINER, generation: GENERATION, image_id: IMAGE, runtime_user: 'claw', runtime_uid: 1000, modes: ['shell'] }] }),
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ ok: true });

    const denied = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [{ tenant_id: 'Miguel', alias: 'kratos', container_id: 'kratos-ctr' }] }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'not_granted' });
  });

  it('recovers an exact claim idempotently and rejects a competing live claim', async () => {
    const gateway = await gatewayWith();
    const payload = ticketPayload();
    const ticket = mintTicket(aliasKey, payload);
    const first = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: claimed(ticket, CLAIM_TOKEN, { cols: 120, rows: 32, reason: 'revisar el despliegue atrasado' }),
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      alias: ALIAS,
      container: CONTAINER,
      runtime_user: 'claw',
      receipt_recovered: false,
      claim_taken_over: false,
      relay_instance_id: relayInstanceId,
      relay_boot_id: RELAY_BOOT_ID,
    });

    const recovered = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: claimed(ticket),
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      claim_token: CLAIM_TOKEN,
      claim_epoch: '1',
      receipt_recovered: true,
      claim_taken_over: false,
    });

    const replay = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: claimed(ticket, randomUUID()),
    });
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ error: 'claim_conflict' });
  });

  it('refuses a forged, expired or foreign-alias ticket at consume time', async () => {
    const gateway = await gatewayWith();
    const forged = ticketPayload();
    const forgedTicket = mintTicket(otherAliasKey, forged);
    const forgedResponse = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${forged.sid}/consume`, { body: claimed(forgedTicket) });
    expect(forgedResponse.status).toBe(401);
    expect(forgedResponse.body).toMatchObject({ error: 'ticket_invalid', reason: 'bad_signature' });

    const stale = ticketPayload({ iat: 1_750_000_000, exp: 1_750_000_030 });
    const staleResponse = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${stale.sid}/consume`, { body: claimed(mintTicket(aliasKey, stale)) });
    expect(staleResponse.status).toBe(401);
    expect(staleResponse.body).toMatchObject({ reason: 'ticket_expired' });

    const mismatched = ticketPayload();
    const mismatchedResponse = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${randomUUID()}/consume`, { body: claimed(mintTicket(aliasKey, mismatched)) });
    expect(mismatchedResponse.status).toBe(401);
    expect(mismatchedResponse.body).toMatchObject({ reason: 'sid_mismatch' });
  });

  it('answers 403 attribution_required for another tenant while identity is unattributed', async () => {
    const gateway = await gatewayWith({ grants: ['Miguel:kratos'] });
    const payload = ticketPayload({ tenant: 'Miguel', alias: 'kratos', container: 'kratos-ctr' });
    const foreignKey = deriveAliasKey(MASTER_KEY_B64, 'Miguel', 'kratos');
    const response = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: claimed(mintTicket(foreignKey, payload)),
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'attribution_required' });
  });

  it('flips authz to 403 revoked in flight and when grants.json is emptied', async () => {
    const gateway = await gatewayWith({ revoke_after_ms: 150 });
    const payload = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, { body: claimed(mintTicket(aliasKey, payload)) });
    const live = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/authz`, { body: authorized() });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ ok: true });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterRevoke = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/authz`, { body: authorized() });
    expect(afterRevoke.status).toBe(403);
    expect(afterRevoke.body).toMatchObject({ reason: 'revoked' });

    const other = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${other.sid}/consume`, { body: claimed(mintTicket(aliasKey, other)) });
    gateway.setGrants([]);
    const afterEmptyGrants = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${other.sid}/authz`, { body: authorized() });
    expect(afterEmptyGrants.status).toBe(403);
    expect(afterEmptyGrants.body).toMatchObject({ reason: 'revoked' });
  });

  it('answers 403 for an unknown session so a relay restart cannot resurrect a shell', async () => {
    const gateway = await gatewayWith();
    const response = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${randomUUID()}/authz`, { body: authorized() });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ reason: 'unknown_session' });
  });

  it('records the audit trail the console has to show: request, consume and close', async () => {
    const gateway = await gatewayWith();
    const payload = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: claimed(mintTicket(aliasKey, payload), CLAIM_TOKEN, { reason: 'reiniciar el adaptador colgado' }),
    });
    const closed = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/close`, {
      body: identified({ reason: 'operator_closed', exit_code: 0, claim_token: CLAIM_TOKEN, claim_epoch: '1' }),
    });
    expect(closed.status).toBe(200);

    expect(gateway.auditOf('terminal.session.request')[0]).toMatchObject({ decision: 'allow', reason: 'reiniciar el adaptador colgado' });
    expect(gateway.auditOf('terminal.session.consume')[0]).toMatchObject({
      alias: ALIAS, container_id: CONTAINER, image_id: IMAGE, generation: GENERATION,
    });
    expect(gateway.auditOf('terminal.session.close')[0]).toMatchObject({ alias: ALIAS, reason: 'operator_closed' });
    expect(JSON.stringify(gateway.audit)).not.toContain(mintTicket(aliasKey, payload));
  });

  it('becomes unreachable on demand so the relay can be tested fail-closed', async () => {
    const gateway = await gatewayWith();
    const payload = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, { body: claimed(mintTicket(aliasKey, payload)) });
    gateway.goDown();
    await expect(callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/authz`, { body: authorized() })).rejects.toThrow();
  });

  it('fences relay A, then lets relay B take over only after the database claim lease expires', async () => {
    const relayB = 'b'.repeat(64);
    const gateway = await gatewayWith({
      relay_instance_ids: [relayInstanceId, relayB],
      claim_lease_ms: 80,
    });
    const presenceB = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [] }, relayB, RELAY_BOOT_ID_B),
    });
    expect(presenceB.status).toBe(200);

    const payload = ticketPayload();
    const ticket = mintTicket(aliasKey, payload);
    const admitted = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: claimed(ticket),
    });
    expect(admitted).toMatchObject({
      status: 200,
      body: { relay_instance_id: relayInstanceId, relay_boot_id: RELAY_BOOT_ID, claim_epoch: '1' },
    });
    const resumeToken = String(admitted.body.resume_token);
    const claimB = randomUUID();
    const premature = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/resume`, {
      body: identified({ resume_token: resumeToken, claim_token: claimB }, relayB, RELAY_BOOT_ID_B),
    });
    expect(premature).toMatchObject({ status: 409, body: { error: 'claim_conflict' } });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const takeover = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/resume`, {
      body: identified({ resume_token: resumeToken, claim_token: claimB }, relayB, RELAY_BOOT_ID_B),
    });
    expect(takeover).toMatchObject({
      status: 200,
      body: { relay_instance_id: relayB, relay_boot_id: RELAY_BOOT_ID_B, claim_epoch: '2' },
    });

    const staleA = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/authz`, {
      body: authorized(),
    });
    expect(staleA).toMatchObject({ status: 403, body: { reason: 'claim_fenced' } });
    const delayedCloseA = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/close`, {
      body: identified({ reason: 'late A', exit_code: null, claim_token: CLAIM_TOKEN, claim_epoch: '1' }),
    });
    expect(delayedCloseA).toMatchObject({ status: 409, body: { error: 'claim_fenced' } });
    const liveB = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/authz`, {
      body: identified({ claim_token: claimB, claim_epoch: '2' }, relayB, RELAY_BOOT_ID_B),
    });
    expect(liveB).toMatchObject({
      status: 200,
      body: { relay_instance_id: relayB, relay_boot_id: RELAY_BOOT_ID_B, claim_epoch: '2' },
    });
  });

  it('rejects two live boot generations sharing one relay certificate and accepts restart only after staleness', async () => {
    const gateway = await gatewayWith({ relay_presence_stale_ms: 250 });
    const collision = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [] }, relayInstanceId, RELAY_BOOT_ID_B),
    });
    expect(collision).toMatchObject({ status: 409, body: { error: 'relay_boot_collision' } });

    await new Promise((resolve) => setTimeout(resolve, 275));
    const restart = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: identified({ agents: [] }, relayInstanceId, RELAY_BOOT_ID_B),
    });
    expect(restart).toEqual({
      status: 200,
      body: { ok: true, relay_instance_id: relayInstanceId, relay_boot_id: RELAY_BOOT_ID_B },
    });
  });
});
