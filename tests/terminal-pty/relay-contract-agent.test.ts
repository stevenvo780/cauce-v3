// Interoperability suite for the PTY channel: fake pty-agent harness.
//
// Run: pnpm vitest run tests/terminal-pty/relay-contract-agent.test.ts

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer, type TLSSocket, type Server as TlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import { startFakeAgent, type FakeAgentHandle } from './fake-pty-agent.mjs';
import {
  FrameDecoder, TAG, TAG_NAME, decodeDataPayload, decodeJsonPayload,
  deriveAliasKey, encodeDataFrame, encodeFrame, encodeJsonFrame, mintTicket,
  type DecodedFrame, type TicketPayload,
} from './protocol.mjs';

const MASTER_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TENANT = 'Steven';
const ALIAS = 'jarvis';
const CONTAINER = 'claw';
const GENERATION = 'gen-1';
const IMAGE = 'sha256:deadbeef';

const aliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, ALIAS);
const otherAliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, 'kant');

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
  waitForConnection(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => { this.connected = resolve; });
  }

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
    const cb = this.connected;
    this.connected = null;
    cb?.();
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
      simulate_euid: 1000,
      ...overrides,
    });
    agents.push(agent);
    await leg.waitForConnection();
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
    expect(first).toContain('ping');
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
    await leg.expect(TAG.PONG);
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
