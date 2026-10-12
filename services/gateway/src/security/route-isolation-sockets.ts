import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { HelloSchema, PROTOCOL_VERSION } from '@cauce/protocol';
import { WebSocket, type RawData } from 'ws';
import type { AuthProvider } from '../auth.js';
import { registerTerminalControlPlane } from '../terminal/plugin.js';
import { AgentRegistry } from '../terminal/registry.js';

export interface IsolationSocketCompany {
  tenant: string;
  alias: string;
  ownerAlias?: string;
}

interface IsolationSocketTarget {
  a: IsolationSocketCompany;
  b: IsolationSocketCompany;
  foreignSentinels?: readonly string[];
  providerAuth?: { sessionId: string; ticket: string };
}

export interface SocketIsolationEvidence {
  route: string;
  attack: string;
  outcome: string;
}

interface TerminalPlacement {
  tenant_id: string;
  alias: string;
  container_name: string | null;
  runtime_user: string | null;
  harness_id: string | null;
}

export async function mountIsolationTerminal(
  app: FastifyInstance,
  pool: DatabasePool,
  provider: AuthProvider,
  origin: string,
  options: { a: IsolationSocketCompany; b: IsolationSocketCompany },
): Promise<{ cleanup: () => Promise<void>; registry: AgentRegistry; relayInstanceId: string }> {
  if (new URL(origin).origin !== origin) throw new Error('isolation terminal requires an exact console origin');
  const directory = await mkdtemp(join(tmpdir(), 'cauce-route-isolation-terminal-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const grantsFile = join(directory, 'grants.json');
    const relayInstanceId = randomBytes(32).toString('hex');
    const registry = new AgentRegistry();
    const placements = (await pool.query<TerminalPlacement>(
      'SELECT tenant_id,alias,container_name,runtime_user,harness_id FROM agents WHERE enabled AND tenant_id=ANY($1::text[])',
      [[options.a.tenant, options.b.tenant]],
    )).rows;
    for (const target of [options.a, options.b]) {
      if (!placements.some(row => row.tenant_id === target.tenant && row.alias === target.alias)) {
        throw new Error(`terminal isolation fixture is missing ${target.tenant}:${target.alias}`);
      }
    }
    registry.observe({ relay_instance_id: relayInstanceId, relay_boot_id: randomUUID() }, placements.map(row => {
      if (!row.container_name || !row.runtime_user || !row.harness_id) throw new Error('terminal fixture has incomplete placement');
      return {
        tenant_id: row.tenant_id, alias: row.alias, container_id: row.container_name,
        generation: 'isolation-fixture', image_id: `sha256:${randomBytes(32).toString('hex')}`,
        runtime_user: row.runtime_user, runtime_uid: 1000, harness: row.harness_id,
        modes: ['shell', 'harness', 'harness_rw'], connected_since: new Date().toISOString(),
      };
    }));
    const operators = (await pool.query<{ email: string }>(
      'SELECT email FROM console_users WHERE tenant_id=ANY($1::text[]) AND active', [[options.a.tenant, options.b.tenant]],
    )).rows.map(row => row.email);
    if (!operators.length) throw new Error('terminal isolation requires authenticated fixture owners');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: operators.flatMap(operator =>
      placements.map(row => ({ operator, tenant_id: row.tenant_id, alias: row.alias, modes: ['shell', 'harness', 'harness_rw'] })),
    ) }));
    await registerTerminalControlPlane(app, {
      pool, authProvider: provider, registry,
      config: {
        wsPath: '/v3/console/terminal/ws', ticketKey: randomBytes(32), relayToken: randomBytes(32).toString('base64url'),
        relayInstanceIds: new Set([relayInstanceId]), grantsFile, ticketTtlSeconds: 30, sessionTtlSeconds: 900,
        sessionMaxTotalSeconds: 3600, claimLeaseSeconds: 150, writableTuiEnabled: true, controlHoldSeconds: 900,
        maxSessionsPerOperator: 10, operatorHeader: 'x-cauce-operator', operators: new Set(operators),
      },
    });
    app.addHook('onClose', cleanup);
    return { cleanup, registry, relayInstanceId };
  } catch (error) { await cleanup(); throw error; }
}

type Frame = Record<string, unknown>;
interface SocketInbox {
  socket: WebSocket;
  next: () => Promise<Frame>;
  close: () => Promise<void>;
}

function rawBytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

async function connectSocket(
  baseUrl: string, path: string, headers: Record<string, string>, sentinels: readonly string[],
): Promise<SocketInbox> {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 5000 });
  const queued: Frame[] = [];
  let waiting: { resolve: (frame: Frame) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  let closing = false;
  const fail = (error: Error) => { failure = error; waiting?.reject(error); waiting = undefined; };
  socket.on('message', (raw, binary) => {
    const bytes = rawBytes(raw);
    if (binary || bytes.byteLength > 1_048_576) { fail(new Error('unexpected socket data before admission')); return; }
    const encoded = bytes.toString('utf8');
    if (sentinels.some(sentinel => encoded.includes(sentinel))) { fail(new Error('foreign data appeared on isolation socket')); return; }
    let decoded: unknown;
    try { decoded = JSON.parse(encoded); } catch { fail(new Error('socket returned invalid JSON')); return; }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      fail(new Error('socket returned a non-object frame')); return;
    }
    const frame = decoded as Frame;
    if (waiting) { waiting.resolve(frame); waiting = undefined; } else queued.push(frame);
  });
  socket.on('error', fail);
  socket.on('close', (code) => {
    if (!closing) fail(new Error(`socket closed before the expected explicit response (${String(code)})`));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => {
        response.resume(); reject(new Error(`socket upgrade rejected with HTTP ${String(response.statusCode)}`));
      });
    });
  } catch (error) { socket.terminate(); throw error; }
  return {
    socket,
    next: async () => {
      if (failure) throw failure;
      const buffered = queued.shift();
      if (buffered) return buffered;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Frame>((resolve, reject) => {
          waiting = { resolve, reject };
          timer = setTimeout(() => { fail(new Error('socket did not return an explicit response within 5 seconds')); }, 5000);
        });
      } finally { clearTimeout(timer); waiting = undefined; }
    },
    close: async () => {
      closing = true;
      if (socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
          socket.once('close', () => { clearTimeout(timer); resolve(); });
          socket.close();
        });
      }
      if (failure) throw failure;
    },
  };
}

function hello(company: IsolationSocketCompany, alias: string): Frame {
  return HelloSchema.parse({ type: 'hello', version: PROTOCOL_VERSION, tenant_id: company.tenant,
    alias, instance_id: randomUUID(), capabilities: [] });
}

function requireFrame(frame: Frame, type: string, code?: string): void {
  if (frame.type !== type || (code !== undefined && frame.code !== code)) {
    throw new Error(`expected socket ${type}${code === undefined ? '' : `/${code}`}; received ${String(frame.type)}/${String(frame.code)}`);
  }
}

export async function assertForeignWebSockets(
  baseUrl: string, headers: Record<string, string>, target: IsolationSocketTarget,
): Promise<SocketIsolationEvidence[]> {
  const evidence: SocketIsolationEvidence[] = [];
  const sentinels = [target.b.tenant, ...(target.foreignSentinels ?? [])];
  const own = await connectSocket(baseUrl, '/v3/ws', headers, sentinels);
  try {
    own.socket.send(JSON.stringify(hello(target.a, target.a.ownerAlias ?? 'owner')));
    requireFrame(await own.next(), 'hello_ack');
    evidence.push({ route: '/v3/ws', attack: 'own hello control', outcome: 'hello_ack' });
    own.socket.send(JSON.stringify({ type: 'subscribe', tenant_id: target.b.tenant, alias: target.b.alias }));
    requireFrame(await own.next(), 'error', 'invalid_frame');
    evidence.push({ route: '/v3/ws', attack: 'foreign subscribe after own hello', outcome: 'invalid_frame (subscription is unsupported)' });
  } finally { await own.close(); }
  const foreign = await connectSocket(baseUrl, '/v3/ws', headers, sentinels);
  try {
    foreign.socket.send(JSON.stringify(hello(target.b, target.b.alias)));
    requireFrame(await foreign.next(), 'error', 'forbidden');
    evidence.push({ route: '/v3/ws', attack: 'foreign hello under owner A session', outcome: 'forbidden' });
  } finally { await foreign.close(); }
  if (target.providerAuth !== undefined) {
    const path = `/v3/console/provider-auth/sessions/${target.providerAuth.sessionId}/stream`;
    const socket = new WebSocket(new URL(path, baseUrl.replace(/^http/u, 'ws')), { headers, perMessageDeflate: false });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('provider auth socket did not explicitly deny the foreign session')); }, 5000);
        const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
        socket.once('open', () => { socket.send(JSON.stringify({ type: 'auth', ticket: target.providerAuth?.ticket })); });
        socket.once('message', () => { finish(new Error('foreign provider auth socket emitted data')); });
        socket.once('error', error => { finish(error); });
        socket.once('unexpected-response', (_request, response) => {
          response.resume(); finish(new Error(`foreign provider auth socket rejected before session validation (${String(response.statusCode)})`));
        });
        socket.once('close', code => { finish(code === 1008 ? undefined : new Error(`unexpected provider auth close code ${String(code)}`)); });
      });
      evidence.push({ route: '/v3/console/provider-auth/sessions/:id/stream', attack: 'foreign session and its valid ticket under owner A', outcome: '1008 provider_auth_closed' });
    } finally { socket.terminate(); }
  }
  return evidence;
}
