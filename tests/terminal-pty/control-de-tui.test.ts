// The whole sequence of taking control of a TUI, end to end against the REAL terminal-relay as a
// process: browser socket, relay, pty-agent double and gateway double. Six numbered steps and,
// above all, the failure paths an operator meets at 3 a.m.
//
// Nothing here reaches PostgreSQL and nothing here needs to. The store predicate that decides who
// may hold a writable TUI is proved in `packages/store/test/control-de-tui-postgres.test.ts`; the
// endpoint gates (authority, typed reason, attribution) in
// `services/gateway/src/terminal.authority.test.ts` and `services/gateway/src/terminal.plugin.test.ts`.
// The gateway on this circuit is `./fake-gateway.mjs`, so there is no lease row to assert here:
// what is under test is the relay's behaviour on the wire and on disk.
//
// The relay always runs as a child and, when the suite runs as root, is dropped to uid 65534 with
// setpriv exactly as `relay-contract-lifecycle.test.ts` does — it refuses euid 0, so there is no
// root skip. The agent double runs in process with `simulate_euid`, because `refuse_input_while`
// and `geometry` reach it only through the option object: `./fake-agent-child.mjs` never reads them.
// Each block gets a gateway of its own: the double refuses a second boot of the same
// `relay_instance_id` inside its presence window, so two relays cannot share one.
//
// Run: npx vitest run tests/terminal-pty/control-de-tui.test.ts --testTimeout=120000

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { createSelfSignedCert, type SelfSignedCert } from './certs.mjs';
import { startFakeGateway, type FakeGatewayHandle } from './fake-gateway.mjs';
import { startFakeAgent, type FakeAgentHandle, type FakeAgentOptions } from './fake-pty-agent.mjs';
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
const MODES = ['shell', 'harness', 'harness_rw'];
/** xterm's primary DA answer: what an emulator owes a TUI, never a keystroke. */
const PRIMARY_DA = '[?1;2c';

const aliasKey = deriveAliasKey(MASTER_KEY_B64, TENANT, ALIAS);
const repoRoot = new URL('../../', import.meta.url);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const UNPRIVILEGED_UID = 65_534;
const ROOT_REFUSAL_EXIT = 78;
const BUNDLE_BANNER =
  "--banner:js=import{createRequire as cauceRequire}from'node:module';const require=cauceRequire(import.meta.url);";

const ticketPayload = (overrides: TicketOverrides = {}): TicketPayload =>
  protocolTicketPayload({
    tenant: TENANT, alias: ALIAS, container: CONTAINER, generation: GENERATION, image: IMAGE,
    ...overrides,
  });

interface ChildLaunch {
  command: string;
  args: string[];
}

interface RelayLocation extends ChildLaunch {
  entry: string;
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

function bundleRelay(entry: string, directory: string): string | null {
  const output = path.join(directory, 'relay-bundle.mjs');
  const build = spawnSync('pnpm', [
    'exec', 'esbuild', entry, '--bundle', '--platform=node', '--format=esm', '--target=node22',
    BUNDLE_BANNER, `--outfile=${output}`,
  ], { cwd: fileURLToPath(repoRoot), encoding: 'utf8' });
  if (build.status !== 0 || !existsSync(output)) return null;
  chmodSync(output, 0o644);
  return output;
}

function relayLaunch(location: RelayLocation, directory: string): ChildLaunch {
  if (!isRoot) return { command: location.command, args: location.args };
  if (!location.entry.endsWith('.ts')) return dropPrivileges(process.execPath, [location.entry]);
  const bundled = bundleRelay(location.entry, directory);
  return bundled === null
    ? dropPrivileges(process.execPath, ['--import', 'tsx', location.entry])
    : dropPrivileges(process.execPath, [bundled]);
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

function consoleClientOptions(material: SelfSignedCert, port: number): Record<string, unknown> {
  return {
    cert: material.cert, key: material.key, ca: material.cert, servername: 'localhost',
    origin: `https://127.0.0.1:${String(port)}`,
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => { resolve(); });
    socket.once('error', reject);
  });
}

interface ClosedSocket {
  code: number;
  reason: string;
}

/** Never rejects: one of these is often created before an assertion that fails, and a rejected
 * orphan would surface as an unhandled error that buries the real failure. */
function closedWith(socket: WebSocket, timeoutMs = 15_000): Promise<ClosedSocket> {
  return new Promise<ClosedSocket>((resolve) => {
    const timer = setTimeout(() => { resolve({ code: -1, reason: 'the socket never closed' }); }, timeoutMs);
    socket.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

interface BrowserStream {
  readonly binaryBytes: number;
  nextControl(timeoutMs?: number): Promise<Record<string, unknown>>;
  nextRawControl(timeoutMs?: number): Promise<string>;
  binaryUntil(done: (text: string) => boolean, timeoutMs?: number): Promise<string>;
}

/** Keeps the RAW text of every control frame: key ORDER is part of the notice contract. */
function collect(socket: WebSocket): BrowserStream {
  const queued: string[] = [];
  const seen: string[] = [];
  const waiting: ((value: string) => void)[] = [];
  let output = '';
  let binaryBytes = 0;

  socket.on('message', (data: RawData, isBinary: boolean) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (isBinary) {
      binaryBytes += bytes.byteLength;
      output += bytes.toString('utf8');
      return;
    }
    const text = bytes.toString('utf8');
    seen.push(text);
    const resolve = waiting.shift();
    if (resolve) resolve(text);
    else queued.push(text);
  });

  async function nextRawControl(timeoutMs = 15_000): Promise<string> {
    const ready = queued.shift();
    if (ready !== undefined) return ready;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no control frame arrived; saw ${JSON.stringify(seen)}`));
      }, timeoutMs);
      waiting.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }

  return {
    nextRawControl,
    get binaryBytes() { return binaryBytes; },
    async nextControl(timeoutMs = 15_000) {
      return JSON.parse(await nextRawControl(timeoutMs)) as Record<string, unknown>;
    },
    async binaryUntil(done, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!done(output)) {
        if (Date.now() > deadline) throw new Error(`timed out; collected ${JSON.stringify(output.slice(-160))}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return output;
    },
  };
}

async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface SpooledReport {
  session_id: string;
  reason: string;
  bytes_in: number;
  bytes_out: number;
  input_batches?: number;
  recording_sha256?: string;
  recording_capped?: boolean;
}

function readSpool(file: string): Map<string, SpooledReport> {
  const reports = new Map<string, SpooledReport>();
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return reports;
  }
  if (raw.trim().length === 0) return reports;
  const parsed = JSON.parse(raw) as { reports?: SpooledReport[] };
  for (const report of parsed.reports ?? []) reports.set(report.session_id, report);
  return reports;
}

async function spooledReport(file: string, sessionId: string, timeoutMs = 10_000): Promise<SpooledReport> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = readSpool(file).get(sessionId);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`no close report was spooled for ${sessionId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Circuit {
  readonly gateway: FakeGatewayHandle;
  readonly wsPort: number;
  readonly agentPort: number;
  readonly spoolFile: string;
  readonly recordingDir: string;
  stop(): Promise<void>;
}

/** Every circuit ever started, so the work tree is never removed under a relay still spooling. */
const live: Circuit[] = [];

let tls: SelfSignedCert;
let relayInstanceId = '';
let workDirectory = '';
let launch: ChildLaunch | null = null;

async function waitForPort(port: number, child: ChildProcess, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(child.exitCode === ROOT_REFUSAL_EXIT
        ? `terminal-relay exited ${String(ROOT_REFUSAL_EXIT)}: it ran as euid 0, so the privilege drop never took effect`
        : `terminal-relay exited ${String(child.exitCode)} before listening on ${String(port)}`);
    }
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(
        `wss://127.0.0.1:${String(port)}/v3/console/terminal/relays/${relayInstanceId}/ws`,
        consoleClientOptions(tls, port));
      probe.once('open', () => { probe.close(); resolve(true); });
      probe.once('error', () => { resolve(false); });
    });
    if (reachable) return;
    if (Date.now() > deadline) throw new Error(`terminal-relay never listened on ${String(port)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** One gateway plus one relay process, with their own ports, spool and recording directory. */
async function startCircuit(label: string, recordingConfigured: boolean): Promise<Circuit> {
  if (launch === null) throw new Error(relaySkipReason);
  const gateway = await startFakeGateway({
    master_key_b64: MASTER_KEY_B64, relay_token: RELAY_TOKEN, relay_instance_id: relayInstanceId,
  });
  let stopped = false;
  const gatewayCa = gateway.ca_path;
  if (isRoot && gatewayCa !== undefined) {
    chmodSync(path.dirname(gatewayCa), 0o755);
    chmodSync(gatewayCa, 0o644);
  }
  const directory = mkdtempSync(path.join(workDirectory, `${label}-`));
  chmodSync(directory, 0o777);
  const tokenFile = path.join(directory, 'relay_token');
  const registryFile = path.join(directory, 'pty_agent_identities.json');
  const spoolFile = path.join(directory, 'close-reports.json');
  const recordingDir = path.join(directory, 'recordings');
  writeFileSync(tokenFile, `${gateway.token}\n`);
  writeFileSync(registryFile, JSON.stringify({
    version: 1,
    agents: [{
      fingerprint_sha256: new X509Certificate(tls.cert).fingerprint256,
      tenant_id: TENANT,
      alias: ALIAS,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }],
  }));
  writeFileSync(spoolFile, '');
  chmodSync(tokenFile, 0o644);
  chmodSync(registryFile, 0o644);
  chmodSync(spoolFile, 0o666);
  // Browser 18100-18199, agent 18300-18399, health 18600-18699: three blocks this file owns.
  // relay-contract-lifecycle.test.ts takes 18700-18899 for its browser leg, and sharing that
  // block is a flake waiting for the day vitest.config.ts stops serializing these files.
  const wsPort = 18_100 + Math.floor(Math.random() * 100);
  const agentPort = wsPort + 200;
  const child = spawn(launch.command, launch.args, {
    cwd: fileURLToPath(repoRoot),
    env: {
      ...process.env,
      CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(wsPort),
      CAUCE_TERMINAL_RELAY_AGENT_PORT: String(agentPort),
      CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(wsPort + 500),
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
      ...(gatewayCa === undefined ? {} : { NODE_EXTRA_CA_CERTS: gatewayCa }),
      ...(recordingConfigured ? { CAUCE_TERMINAL_RECORDING_DIR: recordingDir } : {}),
      CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC: '65536',
      CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '5',
      CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '5',
      CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '150',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForPort(wsPort, child);
  const circuit: Circuit = {
    gateway, wsPort, agentPort, spoolFile, recordingDir,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopChild(child);
      await gateway.close();
    },
  };
  live.push(circuit);
  return circuit;
}

/** Everything a block needs to drive one circuit; the sockets and agents it opens are its own. */
function driver(circuit: () => Circuit): {
  sockets: WebSocket[];
  agents: FakeAgentHandle[];
  attachAgent(extra?: Partial<FakeAgentOptions>): Promise<FakeAgentHandle>;
  attach(payload: TicketPayload): Promise<{ socket: WebSocket; stream: BrowserStream }>;
  readyFrame(socket: WebSocket, stream: BrowserStream, sessionId: string): Promise<Record<string, unknown>>;
  castPath(sessionId: string): string;
  castLines(sessionId: string): [number, string, string][];
  cleanup(): Promise<void>;
} {
  const sockets: WebSocket[] = [];
  const agents: FakeAgentHandle[] = [];
  return {
    sockets,
    agents,
    async attachAgent(extra: Partial<FakeAgentOptions> = {}) {
      const handle = startFakeAgent({
        host: '127.0.0.1', port: circuit().agentPort, cert: tls.cert, key: tls.key, ca: tls.cert,
        servername: 'localhost', tenant: TENANT, alias: ALIAS, alias_key: aliasKey,
        container_id: CONTAINER, generation: GENERATION, image_id: IMAGE, runtime_user: 'claw',
        runtime_uid: 1000, modes: MODES, simulate_euid: 1000, ...extra,
      });
      agents.push(handle);
      await handle.ready;
      return handle;
    },
    async attach(payload: TicketPayload) {
      const port = circuit().wsPort;
      const socket = new WebSocket(
        `wss://127.0.0.1:${String(port)}/v3/console/terminal/relays/${relayInstanceId}/ws`,
        consoleClientOptions(tls, port));
      sockets.push(socket);
      const stream = collect(socket);
      await opened(socket);
      socket.send(JSON.stringify({
        type: 'attach', session_id: payload.sid, ticket: mintTicket(aliasKey, payload),
        cols: 120, rows: 40,
      }));
      return { socket, stream };
    },
    /** Races the first control frame against the close, and on failure says whether the gateway
     * ever granted the session: that is what separates a refused ticket from a relay that threw
     * away a grant it was handed. A bare timeout hides both. */
    async readyFrame(socket: WebSocket, stream: BrowserStream, sessionId: string) {
      const refused = new Promise<Record<string, unknown>>((_resolve, reject) => {
        socket.once('close', (code: number, reason: Buffer) => {
          reject(new Error(
            `the relay closed the attach with ${String(code)} "${reason.toString('utf8')}" instead of sending ready`));
        });
      });
      try {
        const frame = await Promise.race([stream.nextControl(), refused]);
        expect(frame.type).toBe('ready');
        return frame;
      } catch (error) {
        const granted = circuit().gateway.auditOf('terminal.session.consume')
          .some((row) => row.session_id === sessionId);
        const verdict = granted
          ? 'DID grant this session, so the relay refused its own grant'
          : 'never granted this session';
        throw new Error(`${error instanceof Error ? error.message : String(error)}; the gateway ${verdict}`);
      }
    },
    castPath: (sessionId: string) => path.join(circuit().recordingDir, `${sessionId}.cast`),
    castLines(sessionId: string) {
      return readFileSync(path.join(circuit().recordingDir, `${sessionId}.cast`), 'utf8')
        .split('\n').slice(1).filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as [number, string, string]);
    },
    async cleanup() {
      for (const socket of sockets.splice(0)) {
        if (socket.readyState === socket.OPEN) socket.close(1000, 'console terminal closed');
        else if (socket.readyState !== socket.CLOSED) socket.terminate();
      }
      for (const handle of agents.splice(0)) handle.destroy();
      await settle();
    },
  };
}

beforeAll(() => {
  tls = createSelfSignedCert(isRoot ? { mode: 0o755 } : {});
  relayInstanceId = createHash('sha256').update(new X509Certificate(tls.cert).raw).digest('hex');
  workDirectory = mkdtempSync(path.join(tmpdir(), 'cauce-control-tui-'));
  chmodSync(workDirectory, 0o777);
  if (relay !== null) launch = relayLaunch(relay, workDirectory);
});

afterAll(async () => {
  while (live.length > 0) await live.pop()?.stop();
  rmSync(workDirectory, { recursive: true, force: true });
  rmSync(tls.directory, { recursive: true, force: true });
});

describe('terminal-relay writable TUI: the circuit can run at all', () => {
  it('finds the relay entry point and, as root, a working privilege drop', () => {
    expect(relaySkipReason).toBe('');
    expect(existsSync(relay?.entry ?? '')).toBe(true);
    if (!isRoot) return;
    const probe = dropPrivileges('id', ['-u']);
    const run = spawnSync(probe.command, probe.args, { encoding: 'utf8' });
    expect(run.stdout.trim()).toBe(String(UNPRIVILEGED_UID));
  });
});

describe.skipIf(relay === null)('taking control of a TUI, with a recording directory configured', () => {
  let circuit: Circuit;
  const drive = driver(() => circuit);

  beforeAll(async () => { circuit = await startCircuit('recorded', true); });
  afterEach(() => drive.cleanup());
  afterAll(() => circuit.stop());

  it('1. opens harness_rw, answers ready, then geometry, and types into the pane', async () => {
    await drive.attachAgent({ geometry: { cols: 120, rows: 40 } });
    const payload = ticketPayload({ mode: 'harness_rw' });
    const { socket, stream } = await drive.attach(payload);

    expect(await drive.readyFrame(socket, stream, payload.sid))
      .toMatchObject({ mode: 'harness_rw', session_id: payload.sid });

    // On the wire a notice always follows `ready`; whether it is held behind it or simply arrives
    // later is decided in services/terminal-relay/src/sessions-writable.test.ts.
    const rawGeometry = await stream.nextRawControl();
    expect(JSON.parse(rawGeometry)).toStrictEqual({
      session_id: payload.sid, cols: 120, rows: 40, type: 'geometry',
    });
    // Stamped LAST and verbatim: a hostile agent cannot rename the frame the console dispatches on.
    expect(rawGeometry.endsWith('"type":"geometry"}')).toBe(true);

    socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    expect(await stream.binaryUntil((text) => text.includes('pong-1'))).toContain('pong-1');

    const events = drive.castLines(payload.sid);
    expect(events.filter(([, kind]) => kind === 'i').map(([, , text]) => text)).toStrictEqual(['ping\r']);
    expect(events.filter(([, kind]) => kind === 'o').map(([, , text]) => text).join('')).toContain('pong-1');
  });

  it('2. forwards INPUT_REFUSED, keeps the session open and lets no byte reach the PTY', async () => {
    const agent = await drive.attachAgent({ refuse_input_while: 'pane_input_barrier' });
    const payload = ticketPayload({ mode: 'harness_rw' });
    const { socket, stream } = await drive.attach(payload);
    await drive.readyFrame(socket, stream, payload.sid);

    socket.send(JSON.stringify({ type: 'input', data: 'rm -rf /\r' }));
    const rawRefusal = await stream.nextRawControl();
    expect(JSON.parse(rawRefusal)).toStrictEqual({
      session_id: payload.sid, reason: 'pane_input_barrier', type: 'input_refused',
    });
    expect(rawRefusal.endsWith('"type":"input_refused"}')).toBe(true);

    // The agent's fake shell echoes byte for byte, so one echoed byte would prove the paste landed.
    await settle();
    expect(socket.readyState).toBe(socket.OPEN);
    expect(stream.binaryBytes).toBe(0);
    expect(agent.events.filter((event) => event.event === 'input_refused')).toHaveLength(1);
    // The refusal is still recorded: what the operator typed is evidence even when it is rejected.
    const events = drive.castLines(payload.sid);
    expect(events.filter(([, kind]) => kind === 'i')).toHaveLength(1);
    expect(events.filter(([, kind]) => kind === 'o')).toHaveLength(0);
  });

  it('3. accepts terminal_response in harness_rw and refuses it in shell', async () => {
    await drive.attachAgent();
    const writable = ticketPayload({ mode: 'harness_rw' });
    const first = await drive.attach(writable);
    await drive.readyFrame(first.socket, first.stream, writable.sid);
    const writableClosed = closedWith(first.socket);
    first.socket.send(JSON.stringify({ type: 'terminal_response', data: PRIMARY_DA }));
    // The double treats TERMINAL_RESPONSE as an unexpected tag and drops its socket, so the session
    // dies as `agent_offline` — never as the 4400 the mode gate would have produced on its own.
    expect((await writableClosed).code).toBe(CLOSE_CODE.agent_offline);
    const forwarded = await spooledReport(circuit.spoolFile, writable.sid);
    expect(forwarded.reason).not.toBe('terminal_response_forbidden');
    expect(forwarded.bytes_in).toBe(Buffer.byteLength(PRIMARY_DA));

    await settle();
    await drive.attachAgent();
    const shell = ticketPayload({ mode: 'shell' });
    const second = await drive.attach(shell);
    expect(await drive.readyFrame(second.socket, second.stream, shell.sid)).toMatchObject({ mode: 'shell' });
    const shellClosed = closedWith(second.socket);
    second.socket.send(JSON.stringify({ type: 'terminal_response', data: PRIMARY_DA }));
    expect((await shellClosed).code).toBe(CLOSE_CODE.protocol_error);
    const refused = await spooledReport(circuit.spoolFile, shell.sid);
    expect(refused.reason).toBe('terminal_response_forbidden');
    expect(refused.bytes_in).toBe(0);
  });

  it('4. still closes a read-only harness session with input_forbidden on the first byte', async () => {
    await drive.attachAgent();
    const payload = ticketPayload({ mode: 'harness' });
    const { socket, stream } = await drive.attach(payload);
    expect(await drive.readyFrame(socket, stream, payload.sid)).toMatchObject({ mode: 'harness' });

    const closed = closedWith(socket);
    socket.send(JSON.stringify({ type: 'input', data: 'x' }));
    expect(await stream.nextControl()).toMatchObject({ type: 'closed', reason: 'input_forbidden' });
    expect((await closed).code).toBe(CLOSE_CODE.protocol_error);
    const report = await spooledReport(circuit.spoolFile, payload.sid);
    expect(report.reason).toBe('input_forbidden');
    // A mode with no keyboard is never recorded, so the refusal leaves no file behind.
    expect(report.recording_sha256).toBeUndefined();
    expect(existsSync(drive.castPath(payload.sid))).toBe(false);
  });

  it('5. dies when the tab closes without releasing and reports batches and recording digest', async () => {
    const agent = await drive.attachAgent();
    const payload = ticketPayload({ mode: 'harness_rw' });
    const { socket, stream } = await drive.attach(payload);
    await drive.readyFrame(socket, stream, payload.sid);
    socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    await stream.binaryUntil((text) => text.includes('pong-1'));
    socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    await stream.binaryUntil((text) => text.includes('pong-2'));
    expect(agent.sessions).toBe(1);

    // The gateway is knocked out first so the close report stays in the spool long enough to read.
    circuit.gateway.goDown();
    socket.close(1000, 'operator closed the tab');
    const report = await spooledReport(circuit.spoolFile, payload.sid);
    circuit.gateway.restore();

    expect(report.reason).toBe('browser_closed');
    expect(report.input_batches).toBe(2);
    expect(report.recording_capped).toBe(false);
    const digest = createHash('sha256').update(readFileSync(drive.castPath(payload.sid))).digest('hex');
    expect(report.recording_sha256).toBe(digest);

    // Nothing is left holding the alias: the relay told the agent to close the PTY.
    const deadline = Date.now() + 5_000;
    while (agent.sessions > 0 && Date.now() < deadline) await settle(20);
    expect(agent.sessions).toBe(0);
    expect(agent.events.filter((event) => event.event === 'closed')).toHaveLength(1);
  });

  it('7. closes with 4410 when the periodic authz says the control hold was released', async () => {
    const agent = await drive.attachAgent();
    const payload = ticketPayload({ mode: 'harness_rw' });
    const { socket, stream } = await drive.attach(payload);
    await drive.readyFrame(socket, stream, payload.sid);
    socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    await stream.binaryUntil((text) => text.includes('pong-1'));

    // The hold goes while the session itself stays perfectly alive: nothing is revoked, nothing
    // expired, the claim still matches. Only /authz changes its answer.
    const closed = closedWith(socket);
    circuit.gateway.releaseControl(payload.sid);
    const end = await closed;
    expect(end.code).toBe(CLOSE_CODE.control_released);
    expect(end.reason).toBe('control_released');
    const report = await spooledReport(circuit.spoolFile, payload.sid);
    circuit.gateway.restore();

    expect(report.reason).toBe('control_released');
    expect(report.input_batches).toBe(1);
    expect(report.bytes_in).toBe(Buffer.byteLength('ping\r'));
    expect(report.recording_capped).toBe(false);
    const digest = createHash('sha256').update(readFileSync(drive.castPath(payload.sid))).digest('hex');
    expect(report.recording_sha256).toBe(digest);

    const deadline = Date.now() + 5_000;
    while (agent.sessions > 0 && Date.now() < deadline) await settle(20);
    expect(agent.sessions).toBe(0);
  });
});

describe.skipIf(relay === null)('taking control of a TUI with no recording directory configured', () => {
  let circuit: Circuit;
  const drive = driver(() => circuit);

  beforeAll(async () => {
    circuit = await startCircuit('unrecorded', false);
    await drive.attachAgent();
  });
  afterEach(async () => {
    for (const socket of drive.sockets.splice(0)) {
      if (socket.readyState === socket.OPEN) socket.close(1000, 'console terminal closed');
      else if (socket.readyState !== socket.CLOSED) socket.terminate();
    }
    await settle();
  });
  afterAll(async () => {
    for (const handle of drive.agents.splice(0)) handle.destroy();
    await circuit.stop();
  });

  it('6. refuses to open harness_rw and says why, while a plain shell still opens', async () => {
    const payload = ticketPayload({ mode: 'harness_rw' });
    const { socket, stream } = await drive.attach(payload);
    const closed = closedWith(socket);
    expect(await stream.nextControl()).toMatchObject({ type: 'closed', reason: 'recording_unavailable' });
    const end = await closed;
    expect(end.code).toBe(CLOSE_CODE.internal_error);
    expect(end.reason).toBe('recording_unavailable');
    expect((await spooledReport(circuit.spoolFile, payload.sid)).reason).toBe('recording_unavailable');
    expect(existsSync(circuit.recordingDir)).toBe(false);

    // Failing closed is about the writable TUI, not about the relay: a plain shell is untouched.
    await settle();
    const shell = ticketPayload({ mode: 'shell' });
    const second = await drive.attach(shell);
    expect(await drive.readyFrame(second.socket, second.stream, shell.sid)).toMatchObject({ mode: 'shell' });
  });
});
