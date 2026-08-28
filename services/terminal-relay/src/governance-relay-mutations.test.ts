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
  AgentConnection, FEATURE_WRITE_GOVERNANCE,
  FEATURE_WRITE_GOVERNANCE_BATCH,
} from './agent-leg.js';
import {
  FRAME_TAGS, FrameDecoder, decodeDataFrame, decodeJsonFrame, encodeJsonFrame, type Frame,
} from './framing.js';
import {
  GOVERNANCE_WRITE_BATCH_PATH, GOVERNANCE_WRITE_PATH,
  parseWriteBatchRequest, parseWriteRequest, setupGovernanceRelay,
} from './governance-relay.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

const TOKEN = 'token-compartido-con-el-gateway-0123456789';

const HELLO = agentHello({
  alias: 'zeus',
  container_id: 'claw-zeus',
  runtime_user: 'dev',
  home: '/home/dev',
  harness: 'claude',
  agent_version: '0.4.0',
  features: ['read_governance'],
});

const RUTA = '/home/dev/.claude/CLAUDE.md';
const TIEMPO_LIMITE_MS = 300;

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

function certificadoEfimero(): { cert: Buffer; key: Buffer; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-gov-relay-mut-'));
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
      new URL(opciones.ruta ?? GOVERNANCE_WRITE_PATH, `https://127.0.0.1:${String(puerto)}`),
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
        respuesta.on('end', () => { resolve({
          status: respuesta.statusCode ?? 0,
          body: Buffer.concat(trozos).toString('utf8')
        }); });
        respuesta.on('error', reject);
      }
    );
    peticion.on('error', reject);
    peticion.write(payload);
    peticion.end();
  });
}

function cuerpo(respuesta: Respuesta): Record<string, unknown> {
  return JSON.parse(respuesta.body) as Record<string, unknown>;
}

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function esperarWrite(socket: FakeAgentSocket): Promise<Record<string, unknown>> {
  for (let intento = 0; intento < 300; intento += 1) {
    const frame = socket.frames().find((candidate) => candidate.tag === FRAME_TAGS.WRITE);
    if (frame) return decodeJsonFrame(frame.payload);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('el relay no mandó ninguna trama WRITE');
}

async function esperarWriteBatch(socket: FakeAgentSocket): Promise<Record<string, unknown>> {
  for (let intento = 0; intento < 300; intento += 1) {
    const frame = socket.frames().find((candidate) => candidate.tag === FRAME_TAGS.WRITE_BATCH);
    if (frame) return decodeJsonFrame(frame.payload);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('el relay no mandó ninguna trama WRITE_BATCH');
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
  while (vivos.length > 0) vivos.pop()?.destroy('test_over');
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => { resolve(); }));
  rmSync(tls.directory, { recursive: true, force: true });
});

describe('la escritura llega al agente y sólo vuelve aplicada con su ACK', () => {
  it('transporta contenido binario y precondición present sin interpretarlos', async () => {
    const { socket, connection } = conectar({ features: ['read_governance', FEATURE_WRITE_GOVERNANCE] });
    const content = Buffer.from('# nuevo\nacción\n', 'utf8');
    const oldSha = 'a'.repeat(64);
    const pendiente = pedir({
      ruta: GOVERNANCE_WRITE_PATH,
      cuerpo: JSON.stringify({
        tenant_id: 'Steven', alias: 'zeus', path: RUTA,
        content_base64: content.toString('base64'),
        precondition: { state: 'present', sha256: oldSha },
      }),
    });

    const begin = await esperarWrite(socket);
    expect(begin).toMatchObject({
      path: RUTA, operation: 'replace', expected_sha: oldSha,
      content_sha: sha(content), bytes: content.byteLength,
    });
    const chunks = socket.frames().filter((frame) => frame.tag === FRAME_TAGS.WRITE_DATA);
    expect(Buffer.concat(chunks.map((frame) => decodeDataFrame(frame.payload).data))).toEqual(content);

    const okFrame = new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.WRITE_OK, {
      request_id: begin.request_id, path: RUTA, operation: 'replace', sha: sha(content), bytes: content.byteLength,
    }))[0];
    if (!okFrame) throw new Error('Frame not found');
    connection.handleFrame(okFrame, Date.now);

    expect(await pendiente).toMatchObject({ status: 200 });
    expect(cuerpo(await pendiente)).toEqual({
      path: RUTA, operation: 'replace', sha: sha(content), bytes: content.byteLength,
    });
  });

  it('no manda WRITE a un agente que sólo sabe leer', async () => {
    const { socket } = conectar();
    const content = Buffer.from('nuevo');
    const respuesta = await pedir({
      ruta: GOVERNANCE_WRITE_PATH,
      cuerpo: JSON.stringify({
        tenant_id: 'Steven', alias: 'zeus', path: RUTA,
        content_base64: content.toString('base64'), precondition: { state: 'absent' },
      }),
    });
    expect(cuerpo(respuesta)).toMatchObject({ error: 'unavailable' });
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza una precondición ambigua antes de tocar el agente', async () => {
    const { socket } = conectar({ features: [FEATURE_WRITE_GOVERNANCE] });
    const respuesta = await pedir({
      ruta: GOVERNANCE_WRITE_PATH,
      cuerpo: JSON.stringify({
        tenant_id: 'Steven', alias: 'zeus', path: RUTA,
        content_base64: Buffer.from('nuevo').toString('base64'), precondition: { state: 'present' },
      }),
    });
    expect(respuesta.status).toBe(400);
    expect(cuerpo(respuesta)).toMatchObject({ error: 'invalid_request' });
    expect(socket.frames()).toEqual([]);
  });

  it('el parser exige base64 canónico, objeto cerrado y creación absent explícita', () => {
    const base = {
      tenant_id: 'Steven', alias: 'zeus', path: RUTA,
      content_base64: Buffer.from('x').toString('base64'), precondition: { state: 'absent' },
    };
    expect(parseWriteRequest(JSON.stringify(base))).toMatchObject({
      content: Buffer.from('x'), precondition: { state: 'absent' },
    });
    expect(parseWriteRequest(JSON.stringify({ ...base, content_base64: 'eA' }))).toHaveProperty('rejected');
    expect(parseWriteRequest(JSON.stringify({ ...base, surprise: true }))).toHaveProperty('rejected');
  });
});

describe('el lote de perfil es una sola operación gobernada', () => {
  const SOUL = '/home/dev/.openclaw/workspace/SOUL.md';
  const MEMORY = '/home/dev/.openclaw/workspace/MEMORY.md';

  function lote(): string {
    return JSON.stringify({
      tenant_id: 'Steven',
      alias: 'zeus',
      files: [
        {
          mode: 'write', path: SOUL,
          content_base64: Buffer.from('alma').toString('base64'),
          precondition: { state: 'absent' },
        },
        {
          mode: 'verify', path: MEMORY,
          precondition: { state: 'present', sha256: 'd'.repeat(64) },
        },
      ],
    });
  }

  it('conserva orden y modos, y sólo devuelve los ACK completos del agente', async () => {
    const { socket, connection } = conectar({
      features: ['read_governance', FEATURE_WRITE_GOVERNANCE_BATCH],
    });
    const pending = pedir({ ruta: GOVERNANCE_WRITE_BATCH_PATH, cuerpo: lote() });
    const begin = await esperarWriteBatch(socket);
    expect(begin.entries).toEqual([
      {
        mode: 'write', path: SOUL, operation: 'create',
        content_sha: sha(Buffer.from('alma')), bytes: 4, chunks: 1,
      },
      {
        mode: 'verify', path: MEMORY, operation: 'present', expected_sha: 'd'.repeat(64),
        bytes: 0, chunks: 0,
      },
    ]);
    const data = socket.frames().filter((frame) => frame.tag === FRAME_TAGS.WRITE_BATCH_DATA);
    expect(Buffer.concat(data.map((frame) => decodeDataFrame(frame.payload).data))).toEqual(Buffer.from('alma'));

    const batchOkFrame = new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.WRITE_BATCH_OK, {
      request_id: begin.request_id,
      files: [
        { path: SOUL, operation: 'create', sha: sha(Buffer.from('alma')), bytes: 4 },
        { path: MEMORY, operation: 'unchanged', sha: 'd'.repeat(64), bytes: 123 },
      ],
    }))[0];
    if (!batchOkFrame) throw new Error('Frame not found');
    connection.handleFrame(batchOkFrame, Date.now);

    const response = await pending;
    expect(response.status).toBe(200);
    expect(cuerpo(response)).toEqual({ files: [
      { path: SOUL, operation: 'create', sha: sha(Buffer.from('alma')), bytes: 4 },
      { path: MEMORY, operation: 'unchanged', sha: 'd'.repeat(64), bytes: 123 },
    ] });
  });

  it('un ACK parcial del agente nunca se convierte en éxito HTTP', async () => {
    const { socket, connection } = conectar({ features: [FEATURE_WRITE_GOVERNANCE_BATCH] });
    const pending = pedir({ ruta: GOVERNANCE_WRITE_BATCH_PATH, cuerpo: lote() });
    const begin = await esperarWriteBatch(socket);
    const partialBatchOkFrame = new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.WRITE_BATCH_OK, {
      request_id: begin.request_id,
      files: [{ path: SOUL, operation: 'create', sha: sha(Buffer.from('alma')), bytes: 4 }],
    }))[0];
    if (!partialBatchOkFrame) throw new Error('Frame not found');
    connection.handleFrame(partialBatchOkFrame, Date.now);
    expect(cuerpo(await pending)).toMatchObject({ error: 'unknown' });
  });

  it('rechaza modo implícito, verify con contenido y rutas repetidas antes del agente', async () => {
    const { socket } = conectar({ features: [FEATURE_WRITE_GOVERNANCE_BATCH] });
    const base = JSON.parse(lote()) as { files: Record<string, unknown>[] };
    const sinModo = { ...base, files: base.files.map((file) => ({ ...file })) };
    delete sinModo.files[0]?.mode;
    const verifyConContenido = {
      ...base,
      files: [{ ...base.files[1], content_base64: Buffer.from('x').toString('base64') }],
    };
    const repetido = { ...base, files: [base.files[0], { ...base.files[0] }] };

    expect((await pedir({ ruta: GOVERNANCE_WRITE_BATCH_PATH, cuerpo: JSON.stringify(sinModo) })).status).toBe(400);
    expect((await pedir({ ruta: GOVERNANCE_WRITE_BATCH_PATH, cuerpo: JSON.stringify(verifyConContenido) })).status).toBe(400);
    expect((await pedir({ ruta: GOVERNANCE_WRITE_BATCH_PATH, cuerpo: JSON.stringify(repetido) })).status).toBe(400);
    expect(socket.frames()).toEqual([]);
  });

  it('el parser permite verify absent sin inventar bytes ni contenido', () => {
    expect(parseWriteBatchRequest(JSON.stringify({
      tenant_id: 'Steven', alias: 'zeus', files: [{
        mode: 'verify', path: MEMORY, precondition: { state: 'absent' },
      }],
    }))).toMatchObject({ entries: [{
      mode: 'verify', path: MEMORY, precondition: { state: 'absent' },
    }] });
  });
});
