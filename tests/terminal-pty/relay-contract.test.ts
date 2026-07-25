// Interoperability suite for the PTY channel.
//
// Two halves:
//   1. The harness itself — fake gateway and fake pty-agent — is exercised on every run.
//      These are the pieces that let anyone drive the relay without kratos, without
//      containers and without PostgreSQL, so they must be trustworthy on their own.
//   2. The end-to-end circuit against the REAL terminal-relay, which only runs once that
//      service is merged. Until then it skips with an explicit reason instead of pretending
//      to pass.
//
// Run: pnpm vitest run tests/terminal-pty/relay-contract.test.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer, type TLSSocket, type Server as TlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import { startFakeGateway, type FakeGatewayHandle } from './fake-gateway.mjs';
import { startFakeAgent, type FakeAgentHandle } from './fake-pty-agent.mjs';
import {
  CLOSE_CODE, FrameDecoder, TAG, TAG_NAME, decodeDataPayload, decodeJsonPayload,
  deriveAliasKey, encodeDataFrame, encodeFrame, encodeJsonFrame, mintTicket,
  type DecodedFrame, type TicketPayload,
} from './protocol.mjs';

const MASTER_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const RELAY_TOKEN = 'harness-relay-token';
const TENANT = 'Steven';
const ALIAS = 'jarvis';
const CONTAINER = 'claw';
const GENERATION = 'gen-1';
const IMAGE = 'sha256:deadbeef';

const aliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, ALIAS);
const otherAliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, 'kant');
const repoRoot = new URL('../../', import.meta.url);

let tls: SelfSignedCert;

interface TicketOverrides {
  sid?: string;
  op?: string;
  sub?: string;
  mode?: string;
  tenant?: string;
  alias?: string;
  container?: string;
  generation?: string;
  uid?: number;
  user?: string;
  iat?: number;
  exp?: number;
}

function ticketPayload(overrides: TicketOverrides = {}): TicketPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    sid: overrides.sid ?? randomUUID(),
    op: overrides.op ?? 'unattributed:console-basic-auth',
    sub: overrides.sub ?? 'Steven:kant',
    tgt: {
      tenant: overrides.tenant ?? TENANT,
      alias: overrides.alias ?? ALIAS,
      container: overrides.container ?? CONTAINER,
      generation: overrides.generation ?? GENERATION,
      image: IMAGE,
      uid: overrides.uid ?? 1000,
      user: overrides.user ?? 'claw',
    },
    mode: overrides.mode ?? 'shell',
    iat: overrides.iat ?? now - 1,
    exp: overrides.exp ?? now + 30,
  };
}

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

/**
 * Stands in for the relay's agent-facing TLS listener while we exercise the fake agent on
 * its own. It only frames and unframes: no multiplexing, no policy — that is the relay's job.
 */
class AgentLeg {
  private constructor(
    private readonly server: TlsServer,
    readonly port: number,
  ) {}

  private socket: TLSSocket | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly queued: DecodedFrame[] = [];
  private readonly waiting: ((frame: DecodedFrame) => void)[] = [];
  private connected: (() => void) | null = null;
  readonly connection = new Promise<void>((resolve) => { this.connected = resolve; });

  static async start(): Promise<AgentLeg> {
    const server = createServer({ key: tls.key, cert: tls.cert });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const leg = new AgentLeg(server, port);
    server.on('secureConnection', (socket) => leg.accept(socket));
    return leg;
  }

  private accept(socket: TLSSocket): void {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        const resolve = this.waiting.shift();
        if (resolve) resolve(frame);
        else this.queued.push(frame);
      }
    });
    socket.on('error', () => undefined);
    this.connected?.();
  }

  send(frame: Buffer): void {
    if (!this.socket) throw new Error('no agent connected yet');
    this.socket.write(frame);
  }

  async next(timeoutMs = 5_000): Promise<DecodedFrame> {
    const queued = this.queued.shift();
    if (queued) return queued;
    return new Promise<DecodedFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
      this.waiting.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  async expect(tag: number, timeoutMs = 5_000): Promise<DecodedFrame> {
    const frame = await this.next(timeoutMs);
    expect(TAG_NAME[frame.tag] ?? frame.tag, `expected ${TAG_NAME[tag]}`).toBe(TAG_NAME[tag]);
    return frame;
  }

  /** Drains STDOUT frames for a session until `done` accepts the accumulated text. */
  async readUntil(sessionId: string, done: (text: string) => boolean, timeoutMs = 5_000): Promise<string> {
    let accumulated = '';
    const deadline = Date.now() + timeoutMs;
    while (!done(accumulated)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out; collected ${JSON.stringify(accumulated)}`);
      const frame = await this.next(remaining);
      if (frame.tag !== TAG.STDOUT) continue;
      const data = decodeDataPayload(frame.payload);
      if (data.session_id !== sessionId) continue;
      accumulated += data.data.toString('utf8');
    }
    return accumulated;
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

beforeAll(() => {
  tls = createSelfSignedCert();
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
    const gateway = await startFakeGateway({ master_key_b64: MASTER_KEY_B64, relay_token: RELAY_TOKEN, ...options });
    gateways.push(gateway);
    return gateway;
  }

  it('rejects every endpoint without the relay bearer token', async () => {
    const gateway = await gatewayWith();
    const registration = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', { body: {}, token: null });
    expect(registration.status).toBe(401);
    const authz = await callGateway(gateway, 'GET', `/v3/terminal/relay/sessions/${randomUUID()}/authz`, { token: 'wrong' });
    expect(authz.status).toBe(401);
  });

  it('registers a granted agent and refuses one that is not in grants.json', async () => {
    const gateway = await gatewayWith({ grants: [`${TENANT}:${ALIAS}`] });
    const granted = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: { tenant_id: TENANT, alias: ALIAS, container_id: CONTAINER, generation: GENERATION, image_id: IMAGE, runtime_user: 'claw', runtime_uid: 1000, modes: ['shell'] },
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ ok: true });

    const denied = await callGateway(gateway, 'POST', '/v3/terminal/relay/agents', {
      body: { tenant_id: 'Miguel', alias: 'kratos', container_id: 'kratos-ctr' },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'not_granted' });
  });

  it('consumes a ticket exactly once: 200 then 409 on replay', async () => {
    const gateway = await gatewayWith();
    const payload = ticketPayload();
    const ticket = mintTicket(aliasKey, payload);
    const first = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: { ticket, cols: 120, rows: 32, reason: 'revisar el despliegue atrasado' },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true });
    expect(first.body.session).toMatchObject({ alias: ALIAS, container_id: CONTAINER, runtime_user: 'claw', runtime_uid: 1000 });

    const replay = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, { body: { ticket } });
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ error: 'ticket_already_consumed' });
  });

  it('refuses a forged, expired or foreign-alias ticket at consume time', async () => {
    const gateway = await gatewayWith();
    const forged = ticketPayload();
    const forgedTicket = mintTicket(otherAliasKey, forged);
    const forgedResponse = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${forged.sid}/consume`, { body: { ticket: forgedTicket } });
    expect(forgedResponse.status).toBe(401);
    expect(forgedResponse.body).toMatchObject({ error: 'ticket_invalid', reason: 'bad_signature' });

    const stale = ticketPayload({ iat: 1_750_000_000, exp: 1_750_000_030 });
    const staleResponse = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${stale.sid}/consume`, { body: { ticket: mintTicket(aliasKey, stale) } });
    expect(staleResponse.status).toBe(401);
    expect(staleResponse.body).toMatchObject({ reason: 'ticket_expired' });

    const mismatched = ticketPayload();
    const mismatchedResponse = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${randomUUID()}/consume`, { body: { ticket: mintTicket(aliasKey, mismatched) } });
    expect(mismatchedResponse.status).toBe(401);
    expect(mismatchedResponse.body).toMatchObject({ reason: 'sid_mismatch' });
  });

  it('answers 403 attribution_required for another tenant while identity is unattributed', async () => {
    const gateway = await gatewayWith({ grants: ['Miguel:kratos'] });
    const payload = ticketPayload({ tenant: 'Miguel', alias: 'kratos', container: 'kratos-ctr' });
    const foreignKey = deriveAliasKey(MASTER_KEY_B64, 'Miguel', 'kratos');
    const response = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: { ticket: mintTicket(foreignKey, payload) },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'attribution_required' });
  });

  it('flips authz to 403 revoked in flight and when grants.json is emptied', async () => {
    const gateway = await gatewayWith({ revoke_after_ms: 150 });
    const payload = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, { body: { ticket: mintTicket(aliasKey, payload) } });
    const live = await callGateway(gateway, 'GET', `/v3/terminal/relay/sessions/${payload.sid}/authz`);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ ok: true });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterRevoke = await callGateway(gateway, 'GET', `/v3/terminal/relay/sessions/${payload.sid}/authz`);
    expect(afterRevoke.status).toBe(403);
    expect(afterRevoke.body).toMatchObject({ reason: 'revoked' });

    const other = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${other.sid}/consume`, { body: { ticket: mintTicket(aliasKey, other) } });
    gateway.setGrants([]); // this is what emptying grants.json looks like from the relay's side
    const afterEmptyGrants = await callGateway(gateway, 'GET', `/v3/terminal/relay/sessions/${other.sid}/authz`);
    expect(afterEmptyGrants.status).toBe(403);
    expect(afterEmptyGrants.body).toMatchObject({ reason: 'revoked' });
  });

  it('answers 403 for an unknown session so a relay restart cannot resurrect a shell', async () => {
    const gateway = await gatewayWith();
    const response = await callGateway(gateway, 'GET', `/v3/terminal/relay/sessions/${randomUUID()}/authz`);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ reason: 'unknown_session' });
  });

  it('records the audit trail the console has to show: request, consume and close', async () => {
    const gateway = await gatewayWith();
    const payload = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, {
      body: { ticket: mintTicket(aliasKey, payload), reason: 'reiniciar el adaptador colgado' },
    });
    const closed = await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/close`, {
      body: { reason: 'operator_closed', exit_code: 0 },
    });
    expect(closed.status).toBe(200);

    expect(gateway.auditOf('terminal.session.request')[0]).toMatchObject({ decision: 'allow', reason: 'reiniciar el adaptador colgado' });
    expect(gateway.auditOf('terminal.session.consume')[0]).toMatchObject({
      alias: ALIAS, container_id: CONTAINER, image_id: IMAGE, generation: GENERATION,
    });
    expect(gateway.auditOf('terminal.session.close')[0]).toMatchObject({ alias: ALIAS, reason: 'operator_closed' });
    // The ticket itself never lands in the audit trail, only a truncated fingerprint.
    expect(JSON.stringify(gateway.audit)).not.toContain(mintTicket(aliasKey, payload));
  });

  it('becomes unreachable on demand so the relay can be tested fail-closed', async () => {
    const gateway = await gatewayWith();
    const payload = ticketPayload();
    await callGateway(gateway, 'POST', `/v3/terminal/relay/sessions/${payload.sid}/consume`, { body: { ticket: mintTicket(aliasKey, payload) } });
    gateway.goDown();
    await expect(callGateway(gateway, 'GET', `/v3/terminal/relay/sessions/${payload.sid}/authz`)).rejects.toThrow();
  });
});

describe('fake pty agent: the agent leg without kratos', () => {
  let leg: AgentLeg;
  const agents: FakeAgentHandle[] = [];

  beforeAll(async () => {
    leg = await AgentLeg.start();
  });

  afterAll(async () => {
    await leg.close();
  });

  afterEach(() => {
    for (const agent of agents.splice(0)) agent.destroy();
  });

  async function connectAgent(overrides: Record<string, unknown> = {}): Promise<FakeAgentHandle> {
    const agent = startFakeAgent({
      host: '127.0.0.1', port: leg.port, ca: tls.cert, servername: 'localhost',
      tenant: TENANT, alias: ALIAS, alias_key: aliasKey, container_id: CONTAINER,
      generation: GENERATION, image_id: IMAGE, runtime_user: 'claw', runtime_uid: 1000,
      ...overrides,
    });
    agents.push(agent);
    await leg.connection;
    const hello = await leg.expect(TAG.AGENT_HELLO);
    const body = decodeJsonPayload(hello.payload);
    expect(body).toMatchObject({ v: 1, tenant_id: TENANT, alias: ALIAS, container_id: CONTAINER, runtime_user: 'claw', runtime_uid: 1000 });
    leg.send(encodeJsonFrame(TAG.HELLO_ACK, { ok: true }));
    await agent.ready;
    return agent;
  }

  it('announces itself, answers PING with PONG and opens a session for a valid ticket', async () => {
    await connectAgent();
    leg.send(encodeFrame(TAG.PING));
    await leg.expect(TAG.PONG);

    const payload = ticketPayload();
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket: mintTicket(aliasKey, payload), mode: 'shell', cols: 120, rows: 32 }));
    const openOk = await leg.expect(TAG.OPEN_OK);
    expect(decodeJsonPayload(openOk.payload)).toMatchObject({ session_id: payload.sid });
  });

  it('echoes stdin byte for byte and answers the ping line with pong-<n>', async () => {
    await connectAgent();
    const payload = ticketPayload();
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket: mintTicket(aliasKey, payload), mode: 'shell', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);

    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, 'ping\r'));
    const first = await leg.readUntil(payload.sid, (text) => text.includes('pong-1'));
    expect(first).toContain('ping'); // the echo comes back verbatim, as a PTY would
    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, 'ping\r'));
    const second = await leg.readUntil(payload.sid, (text) => text.includes('pong-2'));
    expect(second).toContain('pong-2');

    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, Buffer.from([0x03])));
    expect(await leg.readUntil(payload.sid, (text) => text.includes('^C'))).toContain('^C');
  });

  it('reports the container identity the console banner promises', async () => {
    await connectAgent();
    const payload = ticketPayload();
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket: mintTicket(aliasKey, payload), mode: 'shell', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);
    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, 'id -un\r'));
    expect(await leg.readUntil(payload.sid, (text) => text.includes('claw\r\n'))).toContain('claw');
    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, 'hostname\r'));
    expect(await leg.readUntil(payload.sid, (text) => text.includes(CONTAINER))).toContain(CONTAINER);
  });

  it('tracks RESIZE and reports the new geometry', async () => {
    await connectAgent();
    const payload = ticketPayload();
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket: mintTicket(aliasKey, payload), mode: 'shell', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);
    leg.send(encodeJsonFrame(TAG.RESIZE, { session_id: payload.sid, cols: 200, rows: 50 }));
    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, 'size\r'));
    expect(await leg.readUntil(payload.sid, (text) => text.includes('size:'))).toContain('size:200x50');
  });

  it('refuses a ticket signed for another alias, an expired one and a replayed session id', async () => {
    await connectAgent();
    const foreign = ticketPayload({ alias: 'kant' });
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: foreign.sid, ticket: mintTicket(otherAliasKey, foreign), mode: 'shell', cols: 80, rows: 24 }));
    const wrongAlias = await leg.expect(TAG.OPEN_ERR);
    // The agent is the second lock: even if the relay let it through, the alias binding fails here.
    expect(decodeJsonPayload(wrongAlias.payload)).toMatchObject({ session_id: foreign.sid, reason: 'bad_signature' });

    const stale = ticketPayload({ iat: 1_750_000_000, exp: 1_750_000_030 });
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: stale.sid, ticket: mintTicket(aliasKey, stale), mode: 'shell', cols: 80, rows: 24 }));
    expect(decodeJsonPayload((await leg.expect(TAG.OPEN_ERR)).payload)).toMatchObject({ reason: 'ticket_expired' });

    const live = ticketPayload();
    const liveTicket = mintTicket(aliasKey, live);
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: live.sid, ticket: liveTicket, mode: 'shell', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: live.sid, ticket: liveTicket, mode: 'shell', cols: 80, rows: 24 }));
    expect(decodeJsonPayload((await leg.expect(TAG.OPEN_ERR)).payload)).toMatchObject({ reason: 'session_conflict' });
  });

  it('refuses a signed ticket whose target is uid 0: the PTY never runs as root', async () => {
    await connectAgent();
    const rootTicket = ticketPayload({ uid: 0, user: 'root' });
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: rootTicket.sid, ticket: mintTicket(aliasKey, rootTicket), mode: 'shell', cols: 80, rows: 24 }));
    expect(decodeJsonPayload((await leg.expect(TAG.OPEN_ERR)).payload)).toMatchObject({ reason: 'refuses_root' });
  });

  it('drops stdin in readonly mode but still streams output', async () => {
    await connectAgent();
    const payload = ticketPayload({ mode: 'readonly' });
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket: mintTicket(aliasKey, payload), mode: 'readonly', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);
    leg.send(encodeDataFrame(TAG.STDIN, payload.sid, 'ping\r'));
    leg.send(encodeFrame(TAG.PING));
    await leg.expect(TAG.PONG); // nothing was echoed in between
  });

  it('closes a session on CLOSE and reports the exit code', async () => {
    const agent = await connectAgent();
    const payload = ticketPayload();
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket: mintTicket(aliasKey, payload), mode: 'shell', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);
    leg.send(encodeJsonFrame(TAG.CLOSE, { session_id: payload.sid, reason: 'operator_closed' }));
    const closed = await leg.expect(TAG.CLOSED);
    expect(decodeJsonPayload(closed.payload)).toMatchObject({ session_id: payload.sid, exit_code: 0, reason: 'operator_closed' });
    expect(agent.sessions).toBe(0);
  });

  it('aborts the connection on an unknown tag instead of guessing', async () => {
    const agent = await connectAgent();
    leg.send(encodeFrame(0x7f, Buffer.from('{}', 'utf8')));
    await expect(agent.closed).resolves.toBe(4);
  });

  it('never logs a ticket, only a truncated fingerprint', async () => {
    const agent = await connectAgent();
    const payload = ticketPayload();
    const ticket = mintTicket(aliasKey, payload);
    leg.send(encodeJsonFrame(TAG.OPEN, { session_id: payload.sid, ticket, mode: 'shell', cols: 80, rows: 24 }));
    await leg.expect(TAG.OPEN_OK);
    const serialised = JSON.stringify(agent.events);
    expect(serialised).not.toContain(ticket);
    expect(serialised).not.toContain(aliasKey.toString('hex'));
    expect(serialised).toContain('ticket_fp');
  });

  it('exits 78 when it would run as root and 2 without an alias key', async () => {
    const script = fileURLToPath(new URL('./fake-pty-agent.mjs', import.meta.url));
    const asRoot = await runAgentProcess(script, {
      RELAY_PORT: String(leg.port), ALIAS_KEY_HEX: aliasKey.toString('hex'), AGENT_SIMULATE_EUID: '0', AGENT_QUIET: '1',
    });
    expect(asRoot).toBe(78);

    const misconfigured = await runAgentProcess(script, { RELAY_PORT: String(leg.port), ALIAS_KEY_HEX: '', AGENT_QUIET: '1' });
    expect(misconfigured).toBe(2);
  });
});

async function runAgentProcess(script: string, environment: Record<string, string>): Promise<number> {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
}

// --- End to end against the real terminal-relay -----------------------------------------
//
// This block drives the REAL services/terminal-relay process. It was written before that
// module existed, against a guessed environment contract; the integration reconciled it with
// what the relay actually reads (services/terminal-relay/src/config.ts) and with the mutual
// TLS both of its listeners demand:
//
//   * ONE env prefix, `CAUCE_TERMINAL_RELAY_*` for transport and `CAUCE_TERMINAL_*` for the
//     bounds, with the browser port named BROWSER_PORT (not WS_PORT) and the gateway bearer
//     read from a FILE, never from the environment.
//   * The authz interval and grace are expressed in SECONDS and floor at 1, so the revocation
//     and fail-closed cases are given seconds, not milliseconds, to land.
//   * Both legs require a client certificate. The console leg additionally pins the CN and the
//     agent leg pins the certificate fingerprint against a registry file. The self-signed
//     fixture doubles as its own CA, as the console client cert and as the agent client cert,
//     which is what makes a single throwaway PEM enough here.

interface RelayLocation {
  entry: string;
  command: string;
  args: string[];
}

function locateRelay(): RelayLocation | null {
  const override = process.env.CAUCE_TERMINAL_RELAY_ENTRY;
  const candidates = override ? [override] : [
    fileURLToPath(new URL('services/terminal-relay/dist/main.js', repoRoot)),
    fileURLToPath(new URL('services/terminal-relay/src/main.ts', repoRoot)),
  ];
  for (const entry of candidates) {
    if (!existsSync(entry)) continue;
    return entry.endsWith('.ts')
      ? { entry, command: 'pnpm', args: ['exec', 'tsx', entry] }
      : { entry, command: process.execPath, args: [entry] };
  }
  return null;
}

const relay = locateRelay();
const relaySkipReason = relay === null
  ? 'services/terminal-relay is not merged yet (no dist/main.js nor src/main.ts); set CAUCE_TERMINAL_RELAY_ENTRY to point at it'
  : '';

describe('terminal-relay availability', () => {
  it('states whether the end-to-end circuit can run at all', () => {
    if (relay === null) {
      console.warn(`[terminal-pty] end-to-end suite skipped: ${relaySkipReason}`);
      expect(relaySkipReason).not.toBe('');
      return;
    }
    expect(existsSync(relay.entry)).toBe(true);
  });
});

describe.skipIf(relay === null)('terminal-relay end to end: browser, relay, agent, gateway', () => {
  let gateway: FakeGatewayHandle;
  let agent: FakeAgentHandle | null = null;
  let process_: ChildProcess | null = null;
  let wsPort = 0;
  let agentPort = 0;
  let relayDirectory = '';
  let tokenFile = '';
  let registryFile = '';
  let agentFingerprint = '';
  const sockets: WebSocket[] = [];

  /**
   * Environment contract of services/terminal-relay/src/config.ts, verbatim. The token and the
   * agent registry are FILES because the relay re-reads both on every use: that is what makes a
   * rotated token and a revoked agent take effect without a restart.
   */
  async function startRelay(overrides: Record<string, string> = {}): Promise<void> {
    if (!relay) return;
    wsPort = 18_700 + Math.floor(Math.random() * 200);
    agentPort = wsPort + 1_000;
    writeFileSync(tokenFile, `${gateway.token}\n`);
    writeFileSync(registryFile, JSON.stringify({
      version: 1,
      agents: [{
        fingerprint_sha256: agentFingerprint,
        tenant_id: TENANT,
        alias: ALIAS,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }],
    }));
    process_ = spawn(relay.command, relay.args, {
      cwd: fileURLToPath(repoRoot),
      env: {
        ...process.env,
        CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(wsPort),
        CAUCE_TERMINAL_RELAY_AGENT_PORT: String(agentPort),
        CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: tls.cert_path,
        CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: tls.key_path,
        // The fixture is self-signed, so it is simultaneously the server cert, the trust
        // anchor for the console client cert and the trust anchor for the agent client cert.
        CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: tls.cert_path,
        CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: tls.cert_path,
        CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'localhost',
        CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: registryFile,
        CAUCE_TERMINAL_GATEWAY_URL: gateway.url,
        CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile,
        // Node verifies the fake gateway's self-signed cert through the process trust store.
        ...(gateway.ca_path ? { NODE_EXTRA_CA_CERTS: gateway.ca_path } : {}),
        CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC: '65536',
        CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1',
        CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1',
        ...overrides,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForPort(wsPort, tls);
  }

  async function attachAgent(): Promise<FakeAgentHandle> {
    const handle = startFakeAgent({
      host: '127.0.0.1', port: agentPort, ca: tls.cert, servername: 'localhost',
      // The agent leg is mutual TLS: without a client certificate the handshake never completes.
      cert: tls.cert, key: tls.key,
      tenant: TENANT, alias: ALIAS, alias_key: aliasKey, container_id: CONTAINER,
      generation: GENERATION, image_id: IMAGE, runtime_user: 'claw', runtime_uid: 1000,
      // `shell`/`harness` is the whole mode vocabulary of the gateway, the relay and the Python
      // agent; announcing anything else makes the relay reject the hello outright.
      modes: ['shell'],
      flood_bytes: 2 * 1024 * 1024,
    });
    await handle.ready;
    agent = handle;
    return handle;
  }

  function openBrowserSocket(): WebSocket {
    const socket = new WebSocket(`wss://127.0.0.1:${wsPort}/v3/console/terminal/ws`,
      consoleClientOptions(tls));
    sockets.push(socket);
    return socket;
  }

  beforeAll(async () => {
    relayDirectory = mkdtempSync(path.join(tmpdir(), 'cauce-pty-relay-'));
    tokenFile = path.join(relayDirectory, 'relay_token');
    registryFile = path.join(relayDirectory, 'pty_agent_identities.json');
    // The relay admits an agent by certificate fingerprint, so the registry has to name the
    // exact certificate the fake agent will present.
    agentFingerprint = new X509Certificate(tls.cert).fingerprint256;
    gateway = await startFakeGateway({ master_key_b64: MASTER_KEY_B64, relay_token: RELAY_TOKEN });
    await startRelay();
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    agent?.destroy();
    process_?.kill('SIGTERM');
    await gateway.close();
    if (relayDirectory) rmSync(relayDirectory, { recursive: true, force: true });
  });

  it('attaches with a valid ticket, says ready and echoes bytes back', async () => {
    await attachAgent();
    const payload = ticketPayload();
    const socket = openBrowserSocket();
    const stream = collect(socket);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 120, rows: 32 }));
    expect(await stream.nextControl()).toMatchObject({ type: 'ready' });
    socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    expect(await stream.nextBinaryUntil((text) => text.includes('pong-1'))).toContain('pong-1');
    // Output is binary, control is text: the console relies on this separation.
    expect(stream.controlFramesWereAllText()).toBe(true);
    expect(stream.outputFramesWereAllBinary()).toBe(true);
  });

  it('closes with 4400 when the attach frame carries no ticket at all', async () => {
    const socket = openBrowserSocket();
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: randomUUID(), cols: 80, rows: 24 }));
    // An attach WITHOUT a ticket field is a malformed frame, not a bad credential: the relay
    // never gets as far as asking the gateway, so it is 4400 and not 4401. 4401 is reserved for
    // a ticket that was actually presented and refused at consume time, which the next case
    // covers; conflating the two would tell an operator "your permission expired" when what
    // really happened is that the console spoke the protocol wrong.
    expect(await closeCode(socket)).toBe(CLOSE_CODE.protocol_error);
  });

  it('closes with 4401 when a ticket is presented and the gateway refuses it', async () => {
    const socket = openBrowserSocket();
    await once(socket, 'open');
    const payload = ticketPayload();
    // Signed with the wrong alias key: well-formed frame, refused credential.
    socket.send(JSON.stringify({
      type: 'attach', session_id: payload.sid, ticket: mintTicket(otherAliasKey, payload), cols: 80, rows: 24,
    }));
    expect(await closeCode(socket)).toBe(CLOSE_CODE.ticket_invalid);
  });

  it('closes with 4400 when the first frame is not an attach', async () => {
    const socket = openBrowserSocket();
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
    expect(await closeCode(socket)).toBe(CLOSE_CODE.protocol_error);
  });

  it('closes with 4404 when no agent is connected for the alias', async () => {
    agent?.destroy();
    agent = null;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const payload = ticketPayload();
    const socket = openBrowserSocket();
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 80, rows: 24 }));
    expect(await closeCode(socket)).toBe(CLOSE_CODE.agent_offline);
  });

  it('closes an established session with 4403 when authorisation is revoked in flight', async () => {
    await attachAgent();
    const payload = ticketPayload();
    const socket = openBrowserSocket();
    const stream = collect(socket);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 80, rows: 24 }));
    await stream.nextControl();
    gateway.setGrants([]); // emptying grants.json must reach an already open shell
    expect(await closeCode(socket, 30_000)).toBe(CLOSE_CODE.revoked);
    gateway.restore();
    gateway.setGrants([`${TENANT}:${ALIAS}`]);
  });

  it('fails closed when the gateway becomes unreachable beyond the grace window', async () => {
    await attachAgent();
    const payload = ticketPayload();
    const socket = openBrowserSocket();
    const stream = collect(socket);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 80, rows: 24 }));
    await stream.nextControl();
    gateway.goDown();
    expect([CLOSE_CODE.revoked, CLOSE_CODE.internal_error]).toContain(await closeCode(socket, 30_000));
    gateway.restore();
  });

  it('closes with 4413 when the agent floods the browser with output', async () => {
    await attachAgent();
    const payload = ticketPayload();
    const socket = openBrowserSocket();
    const stream = collect(socket);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 80, rows: 24 }));
    await stream.nextControl();
    // The guard is deliberately about a SUSTAINED storm, not a single burst: `ls -R` of a big
    // directory has to survive with at most a warning, so the relay only closes after five
    // consecutive one-second windows over the limit. Driving it therefore means flooding
    // repeatedly, not once — a single burst here used to hang the test for its whole timeout.
    const storm = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'input', data: 'flood\r' }));
    }, 250);
    try {
      expect(await closeCode(socket, 30_000)).toBe(CLOSE_CODE.output_flood);
    } finally {
      clearInterval(storm);
    }
  });
});

/**
 * `ws` forwards unknown options straight to tls.connect but does not type `servername`, so the
 * cast is the whole reason this helper exists. Keeping it in one place means the console leg and
 * the readiness probe cannot drift apart in how they authenticate.
 */
function consoleClientOptions(material: SelfSignedCert): Record<string, unknown> {
  return { cert: material.cert, key: material.key, ca: material.cert, servername: 'localhost' };
}

function once(socket: WebSocket, event: 'open'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once('error', reject);
  });
}

async function closeCode(socket: WebSocket, timeoutMs = 10_000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket never closed')), timeoutMs);
    socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

interface BrowserStream {
  nextControl(timeoutMs?: number): Promise<Record<string, unknown>>;
  nextBinaryUntil(done: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  controlFramesWereAllText(): boolean;
  outputFramesWereAllBinary(): boolean;
}

/** Records how the relay talks to the browser: control must be text, PTY output binary. */
function collect(socket: WebSocket): BrowserStream {
  const control: Record<string, unknown>[] = [];
  const waiting: ((value: Record<string, unknown>) => void)[] = [];
  let output = '';
  let controlAllText = true;
  let outputAllBinary = true;

  socket.on('message', (data: RawData, isBinary: boolean) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (isBinary) {
      output += bytes.toString('utf8');
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      controlAllText = false;
      outputAllBinary = false;
      return;
    }
    const resolve = waiting.shift();
    if (resolve) resolve(parsed);
    else control.push(parsed);
  });

  return {
    async nextControl(timeoutMs = 10_000) {
      const queued = control.shift();
      if (queued) return queued;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no control frame arrived')), timeoutMs);
        waiting.push((value) => { clearTimeout(timer); resolve(value); });
      });
    },
    async nextBinaryUntil(done, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!done(output)) {
        if (Date.now() > deadline) throw new Error(`timed out; collected ${JSON.stringify(output.slice(-120))}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return output;
    },
    controlFramesWereAllText: () => controlAllText,
    outputFramesWereAllBinary: () => outputAllBinary,
  };
}

/**
 * Probes the browser leg the way the console nginx does: TLS with a client certificate. A plain
 * TCP probe would report the port up before the mutual-TLS listener could actually admit anyone.
 */
async function waitForPort(port: number, material: SelfSignedCert, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(`wss://127.0.0.1:${port}/v3/console/terminal/ws`,
        consoleClientOptions(material));
      probe.once('open', () => { probe.close(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (reachable) return;
    if (Date.now() > deadline) throw new Error(`terminal-relay never listened on ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
