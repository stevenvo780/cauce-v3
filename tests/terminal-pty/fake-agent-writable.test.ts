// Behavioural suite for the writable-TUI branches of the fake pty-agent.
//
// vectors.json freezes the bytes of INPUT_REFUSED and GEOMETRY; this file exercises the double
// that emits them, both through startFakeAgent() and through the standalone CLI's own
// fromEnvironment() parsing, against a scratch TLS listener that only frames and unframes.
//
// Run: pnpm vitest run tests/terminal-pty/fake-agent-writable.test.ts

import { rmSync } from 'node:fs';
import { createServer, type TLSSocket, type Server as TlsServer } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import {
  EXIT, fromEnvironment, startFakeAgent,
  type FakeAgentHandle, type FakeAgentOptions,
} from './fake-pty-agent.mjs';
import {
  FrameDecoder, TAG, TAG_NAME, decodeJsonPayload, deriveAliasKey, encodeDataFrame, encodeFrame,
  encodeJsonFrame, mintTicket, ticketPayload as protocolTicketPayload,
  type DecodedFrame, type TicketOverrides, type TicketPayload,
} from './protocol.mjs';

const MASTER_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TENANT = 'Steven';
const ALIAS = 'jarvis';
const CONTAINER = 'claw';
const GENERATION = 'gen-1';
const IMAGE = 'sha256:deadbeef';
const MODES = ['shell', 'harness_rw'];

const aliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, ALIAS);

let tls: SelfSignedCert;

const ticketPayload = (overrides: TicketOverrides = {}): TicketPayload =>
  protocolTicketPayload({
    tenant: TENANT, alias: ALIAS, container: CONTAINER, generation: GENERATION, image: IMAGE,
    mode: 'harness_rw', ...overrides,
  });

/** The relay's agent port, reduced to framing: no multiplexing, no policy, no hello validation. */
class ScratchRelay {
  private constructor(private readonly server: TlsServer, readonly port: number) {}

  private socket: TLSSocket | null = null;
  private queued: DecodedFrame[] = [];
  private readonly waiting: ((frame: DecodedFrame) => void)[] = [];
  private connected: (() => void) | null = null;

  static async start(): Promise<ScratchRelay> {
    const server = createServer({ key: tls.key, cert: tls.cert });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const relay = new ScratchRelay(server, port);
    server.on('secureConnection', (socket) => { relay.accept(socket); });
    return relay;
  }

  private accept(socket: TLSSocket): void {
    const decoder = new FrameDecoder();
    this.socket = socket;
    this.queued = [];
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      for (const frame of decoder.push(chunk)) {
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

  waitForConnection(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => { this.connected = resolve; });
  }

  send(frame: Buffer): void {
    if (!this.socket) throw new Error('no agent connected yet');
    this.socket.write(frame);
  }

  async next(timeoutMs = 5_000): Promise<DecodedFrame> {
    const queued = this.queued.shift();
    if (queued) return queued;
    return new Promise<DecodedFrame>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('timed out waiting for a frame')); }, timeoutMs);
      this.waiting.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  async expect(tag: number, timeoutMs = 5_000): Promise<DecodedFrame> {
    const frame = await this.next(timeoutMs);
    expect(TAG_NAME[frame.tag] ?? frame.tag, `expected ${String(TAG_NAME[tag])}`).toBe(TAG_NAME[tag]);
    return frame;
  }

  dropAgent(): void {
    this.socket?.destroy();
    this.socket = null;
    this.queued = [];
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    await new Promise<void>((resolve) => this.server.close(() => { resolve(); }));
  }
}

beforeAll(() => {
  tls = createSelfSignedCert();
});

afterAll(() => {
  rmSync(tls.directory, { recursive: true, force: true });
});

describe('fake pty agent: the writable TUI branches', () => {
  let relay: ScratchRelay;
  const agents: FakeAgentHandle[] = [];

  beforeAll(async () => {
    relay = await ScratchRelay.start();
  });

  afterAll(async () => {
    await relay.close();
  });

  afterEach(() => {
    for (const agent of agents.splice(0)) agent.destroy();
    relay.dropAgent();
  });

  function baseOptions(): FakeAgentOptions {
    return {
      host: '127.0.0.1', port: relay.port, ca: tls.cert, servername: 'localhost',
      tenant: TENANT, alias: ALIAS, alias_key: aliasKey, container_id: CONTAINER,
      generation: GENERATION, image_id: IMAGE, runtime_user: 'claw', runtime_uid: 1000,
      modes: MODES, simulate_euid: 1000,
    };
  }

  function environmentOptions(overrides: Record<string, string>): FakeAgentOptions {
    const names = [
      'RELAY_HOST', 'RELAY_PORT', 'RELAY_SERVERNAME', 'AGENT_CA', 'TENANT', 'ALIAS',
      'ALIAS_KEY_HEX', 'CONTAINER_ID', 'GENERATION', 'IMAGE_ID', 'RUNTIME_USER', 'RUNTIME_UID',
      'AGENT_MODES', 'AGENT_REFUSE_INPUT', 'AGENT_GEOMETRY', 'AGENT_QUIET', 'AGENT_SIMULATE_EUID',
    ];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      RELAY_HOST: '127.0.0.1', RELAY_PORT: String(relay.port), RELAY_SERVERNAME: 'localhost',
      AGENT_CA: tls.cert_path, TENANT, ALIAS, ALIAS_KEY_HEX: aliasKey.toString('hex'),
      CONTAINER_ID: CONTAINER, GENERATION, IMAGE_ID: IMAGE, RUNTIME_USER: 'claw',
      RUNTIME_UID: '1000', AGENT_MODES: MODES.join(','), AGENT_QUIET: '1',
      AGENT_SIMULATE_EUID: '1000', ...overrides,
    });
    try {
      return fromEnvironment();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  }

  async function connectAgent(options: FakeAgentOptions): Promise<FakeAgentHandle> {
    const agent = startFakeAgent(options);
    agents.push(agent);
    await relay.waitForConnection();
    const hello = await relay.expect(TAG.AGENT_HELLO);
    expect(decodeJsonPayload(hello.payload)).toMatchObject({ alias: ALIAS, modes: MODES });
    relay.send(encodeJsonFrame(TAG.HELLO_ACK, { ok: true }));
    await agent.ready;
    return agent;
  }

  async function openSession(payload: TicketPayload): Promise<void> {
    relay.send(encodeJsonFrame(TAG.OPEN, {
      session_id: payload.sid, ticket: mintTicket(aliasKey, payload),
      mode: payload.mode, cols: 80, rows: 24,
    }));
    const openOk = await relay.expect(TAG.OPEN_OK);
    expect(decodeJsonPayload(openOk.payload)).toMatchObject({ session_id: payload.sid });
  }

  it('sends GEOMETRY right after OPEN_OK and INPUT_REFUSED instead of echoing STDIN', async () => {
    await connectAgent({
      ...baseOptions(),
      geometry: { cols: 120, rows: 40 },
      refuse_input_while: 'pane_input_barrier',
    });
    const payload = ticketPayload();
    await openSession(payload);

    const geometry = await relay.expect(TAG.GEOMETRY);
    expect(decodeJsonPayload(geometry.payload)).toStrictEqual({ session_id: payload.sid, cols: 120, rows: 40 });

    relay.send(encodeDataFrame(TAG.STDIN, payload.sid, 'ping\r'));
    const refused = await relay.expect(TAG.INPUT_REFUSED);
    expect(decodeJsonPayload(refused.payload)).toStrictEqual({ session_id: payload.sid, reason: 'pane_input_barrier' });

    relay.send(encodeFrame(TAG.PING));
    await relay.expect(TAG.PONG);
  });

  it('opens a plain session without either frame when neither option is set', async () => {
    await connectAgent(baseOptions());
    const payload = ticketPayload({ mode: 'shell' });
    await openSession(payload);

    relay.send(encodeDataFrame(TAG.STDIN, payload.sid, 'ping\r'));
    const echoed = await relay.expect(TAG.STDOUT);
    expect(echoed.payload.subarray(36).toString('utf8')).toBe('ping\r');
  });

  it('reaches the same two frames through the environment the standalone CLI reads', async () => {
    const options = environmentOptions({
      AGENT_REFUSE_INPUT: 'governance_write_in_flight',
      AGENT_GEOMETRY: '200x50',
    });
    expect(options).toMatchObject({
      modes: MODES,
      refuse_input_while: 'governance_write_in_flight',
      geometry: { cols: 200, rows: 50 },
    });
    await connectAgent(options);
    const payload = ticketPayload();
    await openSession(payload);

    const geometry = await relay.expect(TAG.GEOMETRY);
    expect(decodeJsonPayload(geometry.payload)).toStrictEqual({ session_id: payload.sid, cols: 200, rows: 50 });

    relay.send(encodeDataFrame(TAG.STDIN, payload.sid, 'x'));
    const refused = await relay.expect(TAG.INPUT_REFUSED);
    expect(decodeJsonPayload(refused.payload)).toStrictEqual({ session_id: payload.sid, reason: 'governance_write_in_flight' });
  });

  it('leaves geometry unset when the environment does not name it', () => {
    expect(environmentOptions({})).toMatchObject({ geometry: null, refuse_input_while: null });
  });

  it('refuses a malformed geometry and an unknown refusal reason with bad_config', () => {
    const rejected = (options: FakeAgentOptions): number => {
      try {
        startFakeAgent(options);
      } catch (error) {
        const code: unknown = (error as { exit_code?: unknown }).exit_code;
        return typeof code === 'number' ? code : -1;
      }
      throw new Error('the double accepted a configuration it must reject');
    };

    const fromRaw = (raw: string): { cols: number; rows: number } | null =>
      environmentOptions({ AGENT_GEOMETRY: raw }).geometry ?? null;

    expect(rejected({ ...baseOptions(), geometry: fromRaw('abc') })).toBe(EXIT.bad_config);
    expect(rejected({ ...baseOptions(), geometry: fromRaw('120') })).toBe(EXIT.bad_config);
    expect(rejected({ ...baseOptions(), geometry: { cols: 4000, rows: 40 } })).toBe(EXIT.bad_config);
    expect(rejected({ ...baseOptions(), geometry: { cols: 120, rows: 40.5 } })).toBe(EXIT.bad_config);
    expect(rejected({ ...baseOptions(), refuse_input_while: 'nope' as 'pane_input_barrier' }))
      .toBe(EXIT.bad_config);
  });
});
