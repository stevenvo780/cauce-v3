import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest, createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_READ_GOVERNANCE_DONE,
} from './agent-leg.js';
import {
  FRAME_TAGS, FrameDecoder, decodeJsonFrame, encodeFrame, encodeJsonFrame, type Frame,
} from './framing.js';
import {
  GOVERNANCE_LIST_PATH, GOVERNANCE_READ_PATH,
  setupGovernanceRelay,
} from './governance-relay.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

/**
 * `POST /v3/terminal/relay/read` against a real HTTPS server and a real `AgentConnection`. No
 * doubles in the path: we check what goes on the wire and what enters the socket, which is
 * exactly what a double would claim to do well without actually doing it.
 *
 * What is NOT set up here is mutual TLS. That is not owned by this module: it is owned by
 * `createBrowserHttpsServer`, with `requestCert`/`rejectUnauthorized`, and wiring it here would
 * only prove `node:tls` knows how to verify certificates. The server in these tests uses the same
 * `node:https` and the same `request` listener, which is the surface this file DOES write.
 */

const TOKEN = 'token-compartido-con-el-gateway-0123456789';

const HELLO = agentHello({
  alias: 'zeus',
  container_id: 'claw-zeus',
  runtime_user: 'dev',
  home: '/home/dev',
  harness: 'claude',
  agent_version: '0.4.0',
  features: ['read_governance', FEATURE_READ_GOVERNANCE_DONE],
});

const RUTA = '/home/dev/.claude/CLAUDE.md';
const MEMORY_ROOT = '/home/dev/.claude/projects';
/** Intentionally short: the expiry test only costs this much clock time and nothing else. */
const TIEMPO_LIMITE_MS = 300;

/** Records what the relay puts on the wire, so we can read the `request_id` it generated. */
class FakeAgentSocket {
  readonly written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  pause(): void { /* noop */ }
  resume(): void { /* noop */ }
  destroy(): void { /* noop */ }

  asSocket(): TLSSocket {
    return this as unknown as TLSSocket;
  }

  frames(): Frame[] {
    return new FrameDecoder().push(Buffer.concat(this.written));
  }
}

interface Agente {
  readonly socket: FakeAgentSocket;
  readonly connection: AgentConnection;
}

let tls: { cert: Buffer; key: Buffer; directory: string };
let servidor: HttpsServer;
let puerto: number;
let conexiones: Map<string, AgentConnection>;
let token: () => Promise<string>;
const vivos: AgentConnection[] = [];

/** Throwaway TLS material, using the same system openssl as the interop harness. */
function certificadoEfimero(): { cert: Buffer; key: Buffer; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-gov-relay-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'pipe' });
  return { cert: readFileSync(certPath), key: readFileSync(keyPath), directory };
}

function conectar(hello: Partial<AgentHello> = {}): Agente {
  const socket = new FakeAgentSocket();
  const connection = new AgentConnection(socket.asSocket(), { ...HELLO, ...hello }, 'AA:BB', () => Date.now());
  vivos.push(connection);
  conexiones.set(`${connection.hello.tenant_id}:${connection.hello.alias}`, connection);
  return { socket, connection };
}

interface Respuesta {
  readonly status: number;
  readonly body: string;
}

/**
 * A real HTTPS call against the listener. Passes the CA rather than disabling verification: a
 * test that accepts any certificate does not prove the server is presenting its own.
 */
async function pedir(opciones: {
  cuerpo?: string;
  metodo?: string;
  ruta?: string;
  autorizacion?: string | null;
} = {}): Promise<Respuesta> {
  const payload = opciones.cuerpo === undefined
    ? Buffer.from(JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: RUTA }), 'utf8')
    : Buffer.from(opciones.cuerpo, 'utf8');
  const autorizacion = opciones.autorizacion === undefined ? `Bearer ${TOKEN}` : opciones.autorizacion;
  return new Promise<Respuesta>((resolve, reject) => {
    const peticion = httpsRequest(
      new URL(opciones.ruta ?? GOVERNANCE_READ_PATH, `https://127.0.0.1:${String(puerto)}`),
      {
        method: opciones.metodo ?? 'POST',
        ca: tls.cert,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.byteLength,
          ...(autorizacion === null ? {} : { authorization: autorizacion })
        }
      },
      (respuesta) => {
        const trozos: Buffer[] = [];
        respuesta.on('data', (trozo: Buffer) => trozos.push(trozo));
        respuesta.on('end', () => {
          resolve({ status: respuesta.statusCode ?? 500, body: Buffer.concat(trozos).toString('utf8') });
        });
      }
    );
    peticion.on('error', reject);
    peticion.end(payload);
  });
}

function cuerpo(respuesta: Respuesta): Record<string, unknown> {
  return JSON.parse(respuesta.body) as Record<string, unknown>;
}

async function esperarRequestId(socket: FakeAgentSocket): Promise<string> {
  for (let intento = 0; intento < 50; intento += 1) {
    for (const frame of socket.frames()) {
      if (frame.tag === FRAME_TAGS.READ) {
        const decoded = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
        return decoded.request_id as string;
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error('el relay no mandó ninguna trama READ');
}

function readOk(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  const frame = new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.READ_OK, {
    request_id: requestId,
    kind: 'file',
    path: RUTA,
    bytes: 9,
    truncated: false,
    modified_at: '2026-08-24T10:00:00Z',
    chunks: 1,
    ...overrides
  }))[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

function directoryOk(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  const frame = new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.READ_OK, {
    request_id: requestId,
    kind: 'dir',
    path: MEMORY_ROOT,
    total: 1,
    observed_at_least: 1,
    truncated: false,
    entries: [{
      path: `${MEMORY_ROOT}/sesion.md`, bytes: 12, modified_at: '2026-08-24T10:00:00Z',
    }],
    ...overrides,
  }))[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

function readDone(requestId: string): Frame {
  const frame = new FrameDecoder().push(
    encodeJsonFrame(FRAME_TAGS.READ_DONE, { request_id: requestId }),
  )[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

/** READ_DATA carries the `request_id` as a 36-byte ASCII prefix. */
function readData(requestId: string, data: Buffer): Frame {
  const frame = new FrameDecoder().push(
    encodeFrame(FRAME_TAGS.READ_DATA, Buffer.concat([Buffer.from(requestId, 'ascii'), data]))
  )[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeAll(async () => {
  tls = certificadoEfimero();
  servidor = createServer({ cert: tls.cert, key: tls.key });
  setupGovernanceRelay({
    server: servidor,
    agents: { lookup: (tenantId, alias) => conexiones.get(`${tenantId}:${alias}`) },
    token: async () => token(),
    timeoutMs: TIEMPO_LIMITE_MS
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  puerto = (servidor.address() as AddressInfo).port;
});

beforeEach(() => {
  conexiones = new Map();
  token = async () => TOKEN;
});

afterEach(() => {
  // The ping is a setInterval: without this, each test leaves a live timer behind.
  while (vivos.length > 0) vivos.pop()?.destroy('test_over');
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => { resolve(); }));
  rmSync(tls.directory, { recursive: true, force: true });
});

describe('la lectura llega al agente y vuelve', () => {
  it('sirve el contenido que el pty-agent contesta', async () => {
    const { socket, connection } = conectar();
    const pendiente = pedir();

    const id = await esperarRequestId(socket);
    connection.handleFrame(readOk(id), Date.now);
    connection.handleFrame(readData(id, Buffer.from('# Manual\n')), Date.now);

    const respuesta = await pendiente;
    expect(respuesta.status).toBe(200);
    expect(cuerpo(respuesta)).toEqual({
      path: RUTA,
      bytes: 9,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
      sha: sha(Buffer.from('# Manual\n')),
      content: '# Manual\n'
    });
  });
});

describe('el índice de memoria tiene un endpoint y contrato propios', () => {
  function pedirIndice(overrides: Parameters<typeof pedir>[0] = {}): Promise<Respuesta> {
    return pedir({
      ruta: GOVERNANCE_LIST_PATH,
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: MEMORY_ROOT }),
      ...overrides,
    });
  }

  it('transporta kind=dir y devuelve sólo metadata validada', async () => {
    const { socket, connection } = conectar();
    const pending = pedirIndice();
    const id = await esperarRequestId(socket);
    const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ);
    if (!read) throw new Error('READ frame not found');
    expect(decodeJsonFrame(read.payload)).toMatchObject({ kind: 'dir', path: MEMORY_ROOT });
    connection.handleFrame(directoryOk(id), Date.now);
    connection.handleFrame(readDone(id), Date.now);

    expect(cuerpo(await pending)).toEqual({
      path: MEMORY_ROOT,
      total: 1,
      observed_at_least: 1,
      truncated: false,
      entries: [{
        path: `${MEMORY_ROOT}/sesion.md`, bytes: 12, modified_at: '2026-08-24T10:00:00Z',
      }],
    });
  });

  it('exige autenticación y una raíz canónica antes de tocar al agente', async () => {
    const unauthenticated = conectar();
    expect((await pedirIndice({ autorizacion: null })).status).toBe(401);
    expect(unauthenticated.socket.frames()).toEqual([]);

    const invalid = conectar();
    const response = await pedirIndice({
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: `${MEMORY_ROOT}/../secrets` }),
    });
    expect(response.status).toBe(400);
    expect(invalid.socket.frames()).toEqual([]);
  });
});

describe('la puerta se cierra antes de tocar al agente', () => {
  it('rechaza sin token y no mueve al pty-agent', async () => {
    const { socket } = conectar();

    const respuesta = await pedir({ autorizacion: null });

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toBe('');
    // Negative control: the same agent in the test above DOES receive a frame. Without this,
    // a 401 that also broke connection lookup would pass.
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza una ruta relativa o con un byte nulo', async () => {
    const relativa = await pedir({
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: 'CLAUDE.md' })
    });
    const nula = await pedir({
      // The NUL byte is written this way and not inside the literal: a raw NUL in source is
      // invisible when reading, and anyone would delete it without realizing it was the test.
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: `/home/dev/${String.fromCharCode(0)}CLAUDE.md` })
    });

    expect(relativa.status).toBe(400);
    expect(nula.status).toBe(400);
  });
});
