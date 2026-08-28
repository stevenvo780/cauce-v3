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
import { requestDirectoryRead } from './gateway-client.js';
import {
  GOVERNANCE_LIST_PATH, GOVERNANCE_READ_PATH,
  parseDirectoryRequest, setupGovernanceRelay,
} from './governance-relay.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

/**
 * `POST /v3/terminal/relay/read` sobre un servidor HTTPS de verdad y una `AgentConnection` de
 * verdad. No hay dobles en el camino: lo que se comprueba es lo que sale por el cable y lo que
 * entra por el socket, que es justo lo que un doble diría bien sin que lo estuviera.
 *
 * Lo único que no se levanta aquí es el TLS **mutuo**. Eso no lo pone este módulo: lo pone
 * `createBrowserHttpsServer`, con `requestCert`/`rejectUnauthorized`, y montarlo aquí sólo probaría
 * que `node:tls` sabe verificar certificados. El servidor de estos tests usa el mismo `node:https`
 * y el mismo oyente `request`, que es la superficie que este fichero SÍ escribe.
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
/** Corto a propósito: el test de vencimiento cuesta este tiempo de reloj y nada más. */
const TIEMPO_LIMITE_MS = 300;

/** Registra lo que el relay pone en el cable, para poder leer el `request_id` que generó. */
class FakeAgentSocket {
  readonly written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {}

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

/** Material TLS de usar y tirar, con el mismo openssl del sistema que usa el arnés de interop. */
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
 * Una llamada HTTPS real contra el listener. Se pasa la CA en vez de desactivar la verificación:
 * un test que acepte cualquier certificado no comprueba que el servidor presenta el suyo.
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
      new URL(opciones.ruta ?? GOVERNANCE_READ_PATH, `https://127.0.0.1:${puerto}`),
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
        respuesta.on('end', () => resolve({
          status: respuesta.statusCode ?? 0,
          body: Buffer.concat(trozos).toString('utf8')
        }));
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

/** Espera a que el relay ponga el READ en el cable y devuelve su `request_id`. */
async function esperarRequestId(socket: FakeAgentSocket): Promise<string> {
  for (let intento = 0; intento < 300; intento += 1) {
    const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ);
    if (read) {
      return (JSON.parse(read.payload.toString('utf8')) as { request_id: string }).request_id;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('el relay no mandó ninguna trama READ');
}

function readOk(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  return new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.READ_OK, {
    request_id: requestId,
    kind: 'file',
    path: RUTA,
    bytes: 9,
    truncated: false,
    modified_at: '2026-08-24T10:00:00Z',
    chunks: 1,
    ...overrides
  }))[0]!;
}

function directoryOk(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  return new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.READ_OK, {
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
  }))[0]!;
}

function readDone(requestId: string): Frame {
  return new FrameDecoder().push(
    encodeJsonFrame(FRAME_TAGS.READ_DONE, { request_id: requestId }),
  )[0]!;
}

/** READ_DATA lleva el `request_id` como prefijo de 36 bytes ASCII. */
function readData(requestId: string, data: Buffer): Frame {
  return new FrameDecoder().push(
    encodeFrame(FRAME_TAGS.READ_DATA, Buffer.concat([Buffer.from(requestId, 'ascii'), data]))
  )[0]!;
}

function readErr(requestId: string, error: string, reason: string): Frame {
  return new FrameDecoder().push(
    encodeJsonFrame(FRAME_TAGS.READ_ERR, { request_id: requestId, error, reason })
  )[0]!;
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
  // El ping es un `setInterval`: sin esto cada test se deja un temporizador vivo detrás.
  while (vivos.length > 0) vivos.pop()?.destroy('test_over');
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
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

  it('pide al agente exactamente la ruta que le llegó por HTTP', async () => {
    const { socket, connection } = conectar();
    const pendiente = pedir({
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: '/home/dev/AGENTS.md' })
    });

    const id = await esperarRequestId(socket);
    const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ)!;
    const enviado = JSON.parse(read.payload.toString('utf8')) as Record<string, unknown>;
    expect(enviado.path).toBe('/home/dev/AGENTS.md');
    expect(enviado.kind).toBe('file');

    connection.handleFrame(readErr(id, 'not_found', 'no existe'), Date.now);
    await pendiente;
  });

  it('propaga el fallo que declara el agente, sin traducirlo a otra cosa', async () => {
    const { socket, connection } = conectar();
    const pendiente = pedir();

    connection.handleFrame(readErr(await esperarRequestId(socket), 'symlink_detected', 'apunta a otro sitio'), Date.now);

    const respuesta = await pendiente;
    // 200 con un fallo de LECTURA: la llamada llegó y se contestó. El modal necesita el motivo,
    // no un código de transporte que no dice nada de lo que pasó dentro del contenedor.
    expect(respuesta.status).toBe(200);
    expect(cuerpo(respuesta)).toEqual({ error: 'symlink_detected', reason: 'apunta a otro sitio' });
  });
});

describe('la lectura falla explicando por qué', () => {
  it('dice que no hay agente cuando ese alias no tiene ninguno conectado', async () => {
    const respuesta = await pedir();

    expect(respuesta.status).toBe(200);
    expect(cuerpo(respuesta)).toEqual({
      error: 'unavailable',
      reason: 'no hay ningún pty-agent conectado para ese alias'
    });
  });

  it('no le manda NADA a un pty-agent viejo que no anuncia la capacidad', async () => {
    const { socket } = conectar({ features: [] });

    const respuesta = await pedir();

    expect(cuerpo(respuesta)).toEqual({
      error: 'unavailable',
      reason: 'el pty-agent de ese alias no sabe leer ficheros de gobierno'
    });
    // Lo que de verdad se comprueba: no salió una sola trama. Un READ a un agente anterior a esta
    // versión es una violación de protocolo para él, y se lleva por delante sus terminales abiertas.
    expect(socket.frames()).toEqual([]);
  });

  it('vence si el agente no contesta, en vez de dejar la petición colgada', async () => {
    conectar();

    const respuesta = await pedir();

    expect(respuesta.status).toBe(200);
    expect(cuerpo(respuesta)).toEqual({
      error: 'timeout',
      reason: `el pty-agent no contestó en ${TIEMPO_LIMITE_MS} ms`
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
    const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ)!;
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

  it('distingue alias offline y timeout sin inventar una lista vacía', async () => {
    expect(cuerpo(await pedirIndice())).toEqual({
      error: 'unavailable', reason: 'no hay ningún pty-agent conectado para ese alias',
    });

    conectar();
    expect(cuerpo(await pedirIndice())).toEqual({
      error: 'timeout', reason: `el pty-agent no contestó en ${TIEMPO_LIMITE_MS} ms`,
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

  it('propaga el cierre HTTP y libera el cupo en vuelo del alias', async () => {
    const { socket, connection } = conectar();
    const payload = Buffer.from(JSON.stringify({
      tenant_id: 'Steven', alias: 'zeus', path: MEMORY_ROOT,
    }), 'utf8');
    const request = httpsRequest(
      new URL(GOVERNANCE_LIST_PATH, `https://127.0.0.1:${puerto}`),
      {
        method: 'POST',
        ca: tls.cert,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': payload.byteLength,
        },
      },
    );
    request.on('error', () => { /* ECONNRESET esperado por la cancelación del cliente. */ });
    request.end(payload);
    await esperarRequestId(socket);

    const closed = new Promise<void>((resolve) => request.once('close', resolve));
    request.destroy();
    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const before = socket.frames().filter((frame) => frame.tag === FRAME_TAGS.READ).length;
    const reads = Array.from({ length: 4 }, () => requestDirectoryRead(
      connection, 'Steven', 'zeus', MEMORY_ROOT, 60_000,
    ));
    const after = socket.frames().filter((frame) => frame.tag === FRAME_TAGS.READ).length;
    expect(after - before).toBe(4);

    connection.destroy('test_cleanup');
    const outcomes = await Promise.all(reads);
    expect(outcomes.some((outcome) => 'error' in outcome && outcome.error === 'busy')).toBe(false);
  });

  it('el parser del endpoint es de objeto cerrado', () => {
    expect(parseDirectoryRequest(JSON.stringify({
      tenant_id: 'Steven', alias: 'zeus', path: MEMORY_ROOT,
    }))).toEqual({ tenantId: 'Steven', alias: 'zeus', path: MEMORY_ROOT });
    expect(parseDirectoryRequest(JSON.stringify({
      tenant_id: 'Steven', alias: 'zeus', path: MEMORY_ROOT, extra: true,
    }))).toHaveProperty('rejected');
  });
});

describe('la puerta se cierra antes de tocar al agente', () => {
  it('rechaza sin token y no mueve al pty-agent', async () => {
    const { socket } = conectar();

    const respuesta = await pedir({ autorizacion: null });

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toBe('');
    // Control negativo: el mismo agente que en el test de arriba SÍ recibe una trama. Sin esto,
    // un 401 que además rompiera la búsqueda de conexiones pasaría por bueno.
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza un token que no es el compartido', async () => {
    const { socket } = conectar();

    const respuesta = await pedir({ autorizacion: 'Bearer token-de-otro-que-mide-lo-mismo-01234' });

    expect(respuesta.status).toBe(401);
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza una autorización que no es Bearer', async () => {
    conectar();

    expect((await pedir({ autorizacion: `Basic ${TOKEN}` })).status).toBe(401);
  });

  it('contesta 503, no 401, si el propio relay no puede leer su token', async () => {
    conectar();
    token = async () => { throw new Error('token file is empty'); };

    const respuesta = await pedir();

    // Un fallo del relay no se puede disfrazar de credencial mala del que llama: el gateway
    // reintentaría con otra credencial toda la noche buscando un problema que no es suyo.
    expect(respuesta.status).toBe(503);
    expect(cuerpo(respuesta)).toEqual({ error: 'unavailable' });
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const { socket } = conectar();

    const respuesta = await pedir({ cuerpo: 'esto no es json' });

    expect(respuesta.status).toBe(400);
    expect(cuerpo(respuesta)).toMatchObject({ error: 'invalid_request', reason: 'el cuerpo no es JSON' });
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza un alias que no tiene forma de alias', async () => {
    const respuesta = await pedir({
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: '../../etc', path: RUTA })
    });

    expect(respuesta.status).toBe(400);
    expect(cuerpo(respuesta)).toMatchObject({ reason: 'alias no tiene forma de alias' });
  });

  it('rechaza una ruta relativa o con un byte nulo', async () => {
    const relativa = await pedir({
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: 'CLAUDE.md' })
    });
    const nula = await pedir({
      // El byte nulo se escribe así y no dentro del literal: un NUL crudo en el fuente es
      // invisible al leerlo y cualquiera lo borra sin darse cuenta de que era el test.
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: `/home/dev/${String.fromCharCode(0)}CLAUDE.md` })
    });

    expect(relativa.status).toBe(400);
    expect(nula.status).toBe(400);
  });

  it('rechaza un cuerpo que se pasa del tope, y contesta la explicación', async () => {
    const respuesta = await pedir({
      cuerpo: JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: `/${'a'.repeat(600_000)}` })
    });

    // 413 y no una conexión cortada: si el relay tira el socket, el gateway ve «conexión caída» y
    // nunca se entera de por qué le rechazaron la llamada.
    expect(respuesta.status).toBe(413);
    expect(cuerpo(respuesta)).toMatchObject({ error: 'invalid_request' });
  });

  it('no atiende otras rutas del mismo listener', async () => {
    expect((await pedir({ ruta: '/v3/terminal/relay/otra-cosa' })).status).toBe(404);
  });

  it('no atiende otros métodos', async () => {
    expect((await pedir({ metodo: 'GET' })).status).toBe(405);
  });
});
