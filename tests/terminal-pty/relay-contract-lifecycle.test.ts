// End-to-end circuit against the real terminal-relay (browser, relay, agent, gateway).
//
// Run: pnpm vitest run tests/terminal-pty/relay-contract-lifecycle.test.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import { startFakeGateway, type FakeGatewayHandle } from './fake-gateway.mjs';
import { startFakeAgent, type FakeAgentHandle } from './fake-pty-agent.mjs';
import {
  CLOSE_CODE, deriveAliasKey, mintTicket, ticketPayload as protocolTicketPayload,
  type TicketOverrides, type TicketPayload,
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
let relayInstanceId = '';

const ticketPayload = (overrides: TicketOverrides = {}): TicketPayload =>
  protocolTicketPayload({
    tenant: TENANT,
    alias: ALIAS,
    container: CONTAINER,
    generation: GENERATION,
    image: IMAGE,
    ...overrides,
  });

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
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const relaySkipReason = relay === null
  ? 'services/terminal-relay is not merged yet (no dist/main.js nor src/main.ts); set CAUCE_TERMINAL_RELAY_ENTRY to point at it'
  : (isRoot ? 'services/terminal-relay refuses to run as root (euid 0)' : '');

describe('terminal-relay availability', () => {
  it('states whether the end-to-end circuit can run at all', () => {
    if (relay === null || isRoot) {
      console.warn(`[terminal-pty] end-to-end suite skipped: ${relaySkipReason}`);
      expect(relaySkipReason).not.toBe('');
      return;
    }
    expect(existsSync(relay.entry)).toBe(true);
  });
});

describe.skipIf(relay === null || isRoot)('terminal-relay end to end: browser, relay, agent, gateway', () => {
  let gateway: FakeGatewayHandle;
  let agent: FakeAgentHandle | null = null;
  let process_: ChildProcess | null = null;
  let wsPort = 0;
  let agentPort = 0;
  let healthPort = 0;
  let relayDirectory = '';
  let tokenFile = '';
  let registryFile = '';
  let agentFingerprint = '';
  const sockets: WebSocket[] = [];

  async function startRelay(overrides: Record<string, string> = {}): Promise<void> {
    if (!relay) return;
    wsPort = 18_700 + Math.floor(Math.random() * 200);
    agentPort = wsPort + 1_000;
    healthPort = agentPort + 1_000;
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
        CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(healthPort),
        CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: tls.cert_path,
        CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: tls.key_path,
        CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: tls.cert_path,
        CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: tls.cert_path,
        CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'localhost',
        CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: registryFile,
        CAUCE_TERMINAL_GATEWAY_URL: gateway.url,
        CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile,
        CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: tls.cert_path,
        CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: tls.key_path,
        CAUCE_TERMINAL_RELAY_INSTANCE_ID: relayInstanceId,
        CAUCE_TERMINAL_CLOSE_SPOOL_FILE: path.join(relayDirectory, 'close-reports.json'),
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
      cert: tls.cert, key: tls.key,
      tenant: TENANT, alias: ALIAS, alias_key: aliasKey, container_id: CONTAINER,
      generation: GENERATION, image_id: IMAGE, runtime_user: 'claw', runtime_uid: 1000,
      modes: ['shell'],
      flood_bytes: 2 * 1024 * 1024,
    });
    await handle.ready;
    agent = handle;
    return handle;
  }

  function openBrowserSocket(): WebSocket {
    const socket = new WebSocket(
      `wss://127.0.0.1:${wsPort}/v3/console/terminal/relays/${relayInstanceId}/ws`,
      consoleClientOptions(tls, wsPort));
    sockets.push(socket);
    return socket;
  }

  beforeAll(async () => {
    tls = createSelfSignedCert();
    relayInstanceId = createHash('sha256').update(new X509Certificate(tls.cert).raw).digest('hex');
    relayDirectory = mkdtempSync(path.join(tmpdir(), 'cauce-pty-relay-'));
    tokenFile = path.join(relayDirectory, 'relay_token');
    registryFile = path.join(relayDirectory, 'pty_agent_identities.json');
    agentFingerprint = new X509Certificate(tls.cert).fingerprint256;
    gateway = await startFakeGateway({
      master_key_b64: MASTER_KEY_B64,
      relay_token: RELAY_TOKEN,
      relay_instance_id: relayInstanceId,
    });
    await startRelay();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === socket.OPEN) socket.close(1000, 'console terminal closed');
      else if (socket.readyState !== socket.CLOSED) socket.terminate();
    }
    const deadline = Date.now() + 2_000;
    while (agent !== null && agent.sessions > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    agent?.destroy();
    const child = process_;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    await gateway.close();
    if (relayDirectory) rmSync(relayDirectory, { recursive: true, force: true });
    if (tls) rmSync(tls.directory, { recursive: true, force: true });
  });

  it('attaches with a valid ticket, says ready and echoes bytes back', async () => {
    await attachAgent();
    const payload = ticketPayload();
    const socket = openBrowserSocket();
    const stream = collect(socket);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 120, rows: 32 }));
    expect(await stream.nextControl()).toMatchObject({ type: 'ready', relay_instance_id: relayInstanceId });
    socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    expect(await stream.nextBinaryUntil((text) => text.includes('pong-1'))).toContain('pong-1');
    expect(stream.controlFramesWereAllText()).toBe(true);
    expect(stream.outputFramesWereAllBinary()).toBe(true);
  });

  it('returns HTTP 404 for another relay instance path before any ticket can be consumed', async () => {
    const before = gateway.auditOf('terminal.session.consume').length;
    const socket = new WebSocket(
      `wss://127.0.0.1:${wsPort}/v3/console/terminal/relays/${'c'.repeat(64)}/ws`,
      consoleClientOptions(tls, wsPort),
    );
    sockets.push(socket);
    const status = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wrong relay path did not answer')), 5_000);
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once('open', () => {
        clearTimeout(timer);
        reject(new Error('wrong relay path unexpectedly upgraded'));
      });
      socket.on('error', () => undefined);
    });
    expect(status).toBe(404);
    expect(gateway.auditOf('terminal.session.consume')).toHaveLength(before);
  });

  it('reconnects publicly to the same PTY, replays scrollback and gives one socket ownership', async () => {
    const handle = agent ?? await attachAgent();
    const payload = ticketPayload();
    const first = openBrowserSocket();
    const firstStream = collect(first);
    await once(first, 'open');
    first.send(JSON.stringify({
      type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload), cols: 120, rows: 32,
    }));
    const ready = await firstStream.nextControl();
    expect(ready).toMatchObject({ type: 'ready', resumed: false, stream_offset: 0 });
    const resumeToken = ready.resume_token;
    const priorClaimToken = ready.claim_token;
    const priorClaimEpoch = ready.claim_epoch;
    expect(typeof resumeToken).toBe('string');
    expect(String(resumeToken).length).toBeGreaterThanOrEqual(80);
    expect(String(priorClaimToken)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(priorClaimEpoch).toBe('1');
    first.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    expect(await firstStream.nextBinaryUntil((text) => text.includes('pong-1'))).toContain('pong-1');

    const transportClosed = closeCode(first);
    first.terminate();
    expect(await transportClosed).toBe(1006);

    const resumed = openBrowserSocket();
    const replay = openBrowserSocket();
    const resumedStream = collect(resumed);
    await Promise.all([once(resumed, 'open'), once(replay, 'open')]);
    const resumeFrame = JSON.stringify({
      type: 'resume', session_id: payload.sid, resume_token: resumeToken,
      prior_claim_token: priorClaimToken, prior_claim_epoch: priorClaimEpoch,
      after_bytes: 0, cols: 100, rows: 30,
    });
    const replayClosed = closeCode(replay);
    resumed.send(resumeFrame);
    replay.send(resumeFrame);
    const [resumedReady, replayCode] = await Promise.all([
      resumedStream.nextControl(),
      replayClosed,
    ]);
    expect(replayCode).toBe(CLOSE_CODE.session_conflict);
    expect(resumedReady).toMatchObject({
      type: 'ready', resumed: true, stream_offset: 0, resume_token: resumeToken,
    });
    expect(await resumedStream.nextBinaryUntil((text) => text.includes('pong-1'))).toContain('pong-1');
    resumed.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    expect(await resumedStream.nextBinaryUntil((text) => text.includes('pong-2'))).toContain('pong-2');

    expect(handle.events.filter((event) => event.event === 'open_ok' && event.session_id === payload.sid))
      .toHaveLength(1);
    expect(handle.events.filter((event) => event.event === 'open_ok' && event.session_id === payload.sid))
      .toHaveLength(1);
  });

  it('closes with 4400 when the attach frame carries no ticket at all', async () => {
    const socket = openBrowserSocket();
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', session_id: randomUUID(), cols: 80, rows: 24 }));
    expect(await closeCode(socket)).toBe(CLOSE_CODE.protocol_error);
  });

  it('closes with 4401 when a ticket is presented and the gateway refuses it', async () => {
    const socket = openBrowserSocket();
    await once(socket, 'open');
    const payload = ticketPayload();
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
    gateway.setGrants([]);
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

function consoleClientOptions(material: SelfSignedCert, port: number): Record<string, unknown> {
  return {
    cert: material.cert, key: material.key, ca: material.cert, servername: 'localhost',
    origin: `https://127.0.0.1:${port}`,
  };
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

async function waitForPort(port: number, material: SelfSignedCert, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(
        `wss://127.0.0.1:${port}/v3/console/terminal/relays/${relayInstanceId}/ws`,
        consoleClientOptions(material, port));
      probe.once('open', () => { probe.close(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (reachable) return;
    if (Date.now() > deadline) throw new Error(`terminal-relay never listened on ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
