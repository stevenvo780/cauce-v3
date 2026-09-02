// End-to-end circuit against the real terminal-relay as a process (browser, relay, agent, gateway).
// Relay and agent run as children; as root both drop to uid 65534 with setpriv (each refuses euid 0)
// and the temp TLS/spool material opens for that uid, signals included: root has no CAP_KILL here.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import { startFakeGateway, type FakeGatewayHandle } from './fake-gateway.mjs';
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
  : '';

const UNPRIVILEGED_UID = 65_534;
const ROOT_REFUSAL_EXIT = 78;
const BUNDLE_BANNER =
  "--banner:js=import{createRequire as cauceRequire}from'node:module';const require=cauceRequire(import.meta.url);";

interface ChildLaunch {
  command: string;
  args: string[];
}

let relayExitCode: number | null = null;
let relayLaunchFailure = '';

function dropPrivileges(command: string, args: string[]): ChildLaunch {
  const uid = String(UNPRIVILEGED_UID);
  return {
    command: 'setpriv',
    args: [
      `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups',
      'env', 'HOME=/tmp', 'XDG_CACHE_HOME=/tmp', command, ...args,
    ],
  };
}

function privilegeDropReport(): string {
  const probe = dropPrivileges('id', ['-u']);
  const run = spawnSync(probe.command, probe.args, { encoding: 'utf8' });
  if (run.error) return `setpriv is unusable: ${run.error.message}`;
  if (run.status !== 0) return `setpriv exited ${String(run.status)}: ${run.stderr.trim()}`;
  return `uid=${run.stdout.trim()}`;
}

function bundleRelay(entry: string, workDirectory: string): string | null {
  const output = path.join(workDirectory, 'relay-bundle.mjs');
  const build = spawnSync('pnpm', [
    'exec', 'esbuild', entry, '--bundle', '--platform=node', '--format=esm', '--target=node22',
    BUNDLE_BANNER, `--outfile=${output}`,
  ], { cwd: fileURLToPath(repoRoot), encoding: 'utf8' });
  if (build.status !== 0 || !existsSync(output)) return null;
  chmodSync(output, 0o644);
  return output;
}

function relayLaunch(location: RelayLocation, workDirectory: string): ChildLaunch {
  if (!isRoot) return { command: location.command, args: location.args };
  if (!location.entry.endsWith('.ts')) return dropPrivileges(process.execPath, [location.entry]);
  const bundled = bundleRelay(location.entry, workDirectory);
  return bundled === null
    ? dropPrivileges(process.execPath, ['--import', 'tsx', location.entry])
    : dropPrivileges(process.execPath, [bundled]);
}

function unprivilegedLaunch(command: string, args: string[]): ChildLaunch {
  return isRoot ? dropPrivileges(command, args) : { command, args };
}

function signalChild(child: ChildProcess, signal: 'TERM' | 'KILL'): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (!isRoot) {
    child.kill(`SIG${signal}`);
    return;
  }
  const sender = dropPrivileges('kill', ['-s', signal, String(pid)]);
  spawnSync(sender.command, sender.args, { encoding: 'utf8' });
}

async function childExited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  signalChild(child, 'TERM');
  if (await childExited(child, 5_000)) return;
  signalChild(child, 'KILL');
  await childExited(child, 5_000);
}

const FAKE_AGENT_ENTRY = fileURLToPath(new URL('fake-agent-child.mjs', import.meta.url));
const AGENT_FAILED_BEFORE_READY = new Set([
  'refuses_root', 'hello_rejected', 'agent_abort', 'transport_error',
]);
const RELATIVE_IMPORT = /from '(\.[^']+)'/g;

let agentEntry = FAKE_AGENT_ENTRY;

function copyAgentWhereTheDroppedUidCanRead(destination: string): string {
  mkdirSync(destination, { recursive: true });
  chmodSync(destination, 0o755);
  const pending = [FAKE_AGENT_ENTRY];
  const copied = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (copied.has(file)) continue;
    copied.add(file);
    const source = readFileSync(file, 'utf8');
    const copy = path.join(destination, path.basename(file));
    writeFileSync(copy, source);
    chmodSync(copy, 0o644);
    for (const reference of source.matchAll(RELATIVE_IMPORT)) {
      const target = reference[1];
      if (target !== undefined) pending.push(path.resolve(path.dirname(file), target));
    }
  }
  return path.join(destination, path.basename(FAKE_AGENT_ENTRY));
}

interface AgentEvent {
  event: string;
  session_id?: string;
  [field: string]: unknown;
}

interface AgentProcess {
  readonly events: AgentEvent[];
  readonly ready: Promise<void>;
  readonly sessions: number;
  destroy(): void;
  stop(): Promise<void>;
}

function agentEnvironment(port: number): Record<string, string> {
  return {
    RELAY_HOST: '127.0.0.1',
    RELAY_PORT: String(port),
    RELAY_SERVERNAME: 'localhost',
    AGENT_CERT: tls.cert_path,
    AGENT_KEY: tls.key_path,
    AGENT_CA: tls.cert_path,
    TENANT,
    ALIAS,
    ALIAS_KEY_HEX: aliasKey.toString('hex'),
    CONTAINER_ID: CONTAINER,
    GENERATION,
    IMAGE_ID: IMAGE,
    RUNTIME_USER: 'claw',
    RUNTIME_UID: '1000',
    AGENT_MODES: 'shell',
    AGENT_FLOOD_BYTES: String(2 * 1024 * 1024),
  };
}

function startAgentProcess(port: number): AgentProcess {
  const plan = unprivilegedLaunch(process.execPath, [agentEntry]);
  const child = spawn(plan.command, plan.args, {
    cwd: fileURLToPath(repoRoot),
    env: { ...process.env, ...agentEnvironment(port) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events: AgentEvent[] = [];
  let sessions = 0;
  let settled = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (reason: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyDeadline = setTimeout(() => { finish('it never sent HELLO_ACK'); }, 30_000);
  readyDeadline.unref();

  function finish(failure: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(readyDeadline);
    if (failure === '') resolveReady();
    else rejectReady(new Error(`fake pty agent (pid ${String(child.pid)}): ${failure}`));
  }

  function consume(line: string): void {
    let parsed: { sessions?: number; event?: AgentEvent };
    try {
      parsed = JSON.parse(line) as { sessions?: number; event?: AgentEvent };
    } catch {
      return;
    }
    const event = parsed.event;
    if (event === undefined) return;
    sessions = parsed.sessions ?? sessions;
    events.push(event);
    if (event.event === 'hello_ack') finish('');
    else if (AGENT_FAILED_BEFORE_READY.has(event.event)) finish(JSON.stringify(event));
  }

  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line !== '') consume(line);
  });
  child.once('error', (error) => { finish(`it could not be spawned: ${error.message}`); });
  child.once('exit', (code, signal) => {
    sessions = 0;
    finish(`it exited (code ${String(code)}, signal ${String(signal)}) before HELLO_ACK`);
  });

  return {
    events,
    ready,
    get sessions() { return sessions; },
    destroy: () => { signalChild(child, 'KILL'); },
    stop: () => stopChild(child),
  };
}

describe('terminal-relay availability', () => {
  it('states whether the end-to-end circuit can run at all', () => {
    if (relay === null) {
      console.warn(`[terminal-pty] end-to-end suite skipped: ${relaySkipReason}`);
      expect(relaySkipReason).not.toBe('');
      return;
    }
    expect(existsSync(relay.entry)).toBe(true);
    if (isRoot) expect(privilegeDropReport()).toBe(`uid=${String(UNPRIVILEGED_UID)}`);
  });
});

describe.skipIf(relay === null)('terminal-relay end to end: browser, relay, agent, gateway', () => {
  let gateway: FakeGatewayHandle;
  let agent: AgentProcess | null = null;
  let process_: ChildProcess | null = null;
  let wsPort = 0;
  let agentPort = 0;
  let healthPort = 0;
  let relayDirectory = '';
  let tokenFile = '';
  let registryFile = '';
  let spoolFile = '';
  let agentFingerprint = '';
  let launch: ChildLaunch | null = null;
  const sockets: WebSocket[] = [];
  const agents: AgentProcess[] = [];

  function openMaterialToTheChild(): void {
    chmodSync(relayDirectory, 0o777);
    writeFileSync(spoolFile, '');
    chmodSync(spoolFile, 0o666);
    const gatewayCa = gateway.ca_path;
    if (gatewayCa !== undefined) {
      chmodSync(path.dirname(gatewayCa), 0o755);
      chmodSync(gatewayCa, 0o644);
    }
  }

  async function startRelay(overrides: Record<string, string> = {}): Promise<void> {
    if (!relay || launch === null) return;
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
    if (isRoot) {
      chmodSync(tokenFile, 0o644);
      chmodSync(registryFile, 0o644);
    }
    relayExitCode = null;
    relayLaunchFailure = '';
    process_ = spawn(launch.command, launch.args, {
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
        CAUCE_TERMINAL_CLOSE_SPOOL_FILE: spoolFile,
        ...(gateway.ca_path ? { NODE_EXTRA_CA_CERTS: gateway.ca_path } : {}),
        CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC: '65536',
        CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1',
        CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1',
        ...overrides,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process_.once('exit', (code) => { relayExitCode = code; });
    process_.once('error', (error) => {
      relayLaunchFailure = `${launch?.command ?? 'terminal-relay'} could not be spawned: ${error.message}`;
    });
    await waitForPort(wsPort, tls);
  }

  async function attachAgent(): Promise<AgentProcess> {
    const handle = startAgentProcess(agentPort);
    agents.push(handle);
    await handle.ready;
    agent = handle;
    return handle;
  }

  function openBrowserSocket(): WebSocket {
    const socket = new WebSocket(
      `wss://127.0.0.1:${String(wsPort)}/v3/console/terminal/relays/${relayInstanceId}/ws`,
      consoleClientOptions(tls, wsPort));
    sockets.push(socket);
    return socket;
  }

  beforeAll(async () => {
    tls = createSelfSignedCert(isRoot ? { mode: 0o755 } : {});
    relayInstanceId = createHash('sha256').update(new X509Certificate(tls.cert).raw).digest('hex');
    relayDirectory = mkdtempSync(path.join(tmpdir(), 'cauce-pty-relay-'));
    tokenFile = path.join(relayDirectory, 'relay_token');
    registryFile = path.join(relayDirectory, 'pty_agent_identities.json');
    spoolFile = path.join(relayDirectory, 'close-reports.json');
    agentFingerprint = new X509Certificate(tls.cert).fingerprint256;
    gateway = await startFakeGateway({
      master_key_b64: MASTER_KEY_B64,
      relay_token: RELAY_TOKEN,
      relay_instance_id: relayInstanceId,
    });
    if (isRoot) {
      openMaterialToTheChild();
      agentEntry = copyAgentWhereTheDroppedUidCanRead(path.join(relayDirectory, 'agent'));
    }
    if (relay !== null) launch = relayLaunch(relay, relayDirectory);
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
    agent = null;
    await Promise.all(agents.splice(0).map((spawned) => spawned.stop()));
    if (process_ !== null) await stopChild(process_);
    if (relayLaunchFailure !== '') console.warn(`[terminal-pty] ${relayLaunchFailure}`);
    await gateway.close();
    if (relayDirectory) rmSync(relayDirectory, { recursive: true, force: true });
    rmSync(tls.directory, { recursive: true, force: true });
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
      `wss://127.0.0.1:${String(wsPort)}/v3/console/terminal/relays/${'c'.repeat(64)}/ws`,
      consoleClientOptions(tls, wsPort),
    );
    sockets.push(socket);
    const status = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('wrong relay path did not answer')); }, 5_000);
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

  it('reconnects publicly to the same PTY, replays scrollback and rejects a second socket', async () => {
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
    resumed.send(resumeFrame);
    const resumedReady = await resumedStream.nextControl();
    const replayClosed = closeCode(replay);
    replay.send(resumeFrame);
    const replayCode = await replayClosed;
    expect(replayCode).toBe(CLOSE_CODE.session_conflict);
    expect(resumedReady).toMatchObject({
      type: 'ready', resumed: true, stream_offset: 0, resume_token: resumeToken,
    });
    expect(await resumedStream.nextBinaryUntil((text) => text.includes('pong-1'))).toContain('pong-1');
    resumed.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    expect(await resumedStream.nextBinaryUntil((text) => text.includes('pong-2'))).toContain('pong-2');

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
    origin: `https://127.0.0.1:${String(port)}`,
  };
}

function once(socket: WebSocket, event: 'open'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => { resolve(); });
    socket.once('error', reject);
  });
}

async function closeCode(socket: WebSocket, timeoutMs = 10_000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('socket never closed')); }, timeoutMs);
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
        const timer = setTimeout(() => { reject(new Error('no control frame arrived')); }, timeoutMs);
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
    if (relayLaunchFailure !== '') throw new Error(relayLaunchFailure);
    if (relayExitCode !== null) {
      throw new Error(relayExitCode === ROOT_REFUSAL_EXIT
        ? `terminal-relay exited ${String(ROOT_REFUSAL_EXIT)}: it ran as euid 0, so the privilege drop never took effect`
        : `terminal-relay exited ${String(relayExitCode)} before listening on ${String(port)}`);
    }
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(
        `wss://127.0.0.1:${String(port)}/v3/console/terminal/relays/${relayInstanceId}/ws`,
        consoleClientOptions(material, port));
      probe.once('open', () => { probe.close(); resolve(true); });
      probe.once('error', () => { resolve(false); });
    });
    if (reachable) return;
    if (Date.now() > deadline) throw new Error(`terminal-relay never listened on ${String(port)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
