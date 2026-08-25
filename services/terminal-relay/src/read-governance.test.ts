import { createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection, type AgentHello, parseAgentHello } from './agent-leg.js';
import {
  FRAME_TAGS, FrameDecoder, MAX_DATA_BYTES, SESSION_ID_BYTES, encodeFrame, encodeJsonFrame,
  type Frame
} from './framing.js';
import { requestFileRead } from './gateway-client.js';

/**
 * Lectura de ficheros de gobierno por el cable del pty-agent.
 *
 * Se prueba contra la `AgentConnection` de verdad, no contra un doble: lo que hay que verificar es
 * justamente el decodificado de tramas y el reensamblado, que es donde un doble mentiría.
 */

const HELLO: AgentHello = {
  tenant_id: 'Steven',
  alias: 'zeus',
  container_id: 'claw-zeus',
  generation: 'a'.repeat(32),
  image_id: 'sha256:beef',
  runtime_user: 'dev',
  runtime_uid: 1000,
  harness: 'claude',
  agent_version: '0.4.0',
  modes: ['shell', 'harness'],
  features: ['read_governance']
};

const RUTA = '/home/dev/.claude/CLAUDE.md';

/** Registra lo que el relay pone en el cable, para poder leer el `request_id` que generó. */
class FakeAgentSocket {
  destroyed = false;
  readonly written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  pause(): void {}
  resume(): void {}

  destroy(): void {
    this.destroyed = true;
  }

  asSocket(): TLSSocket {
    return this as unknown as TLSSocket;
  }

  /** Las tramas que el relay mandó, ya decodificadas. */
  frames(): Frame[] {
    return new FrameDecoder().push(Buffer.concat(this.written));
  }
}

interface Harness {
  readonly socket: FakeAgentSocket;
  readonly connection: AgentConnection;
}

const vivos: AgentConnection[] = [];

function conectar(hello: Partial<AgentHello> = {}): Harness {
  const socket = new FakeAgentSocket();
  const connection = new AgentConnection(socket.asSocket(), { ...HELLO, ...hello }, 'AA:BB', () => Date.now());
  vivos.push(connection);
  return { socket, connection };
}

afterEach(() => {
  // El ping es un `setInterval`: sin esto cada test se deja un temporizador vivo detrás.
  while (vivos.length > 0) vivos.pop()?.destroy('test_over');
});

/** El `request_id` que el relay puso en la trama READ. Falla si no mandó ninguna. */
function requestIdEnviado(socket: FakeAgentSocket): string {
  const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ);
  expect(read, 'el relay no mandó ninguna trama READ').toBeDefined();
  const body = JSON.parse(read!.payload.toString('utf8')) as Record<string, unknown>;
  return body.request_id as string;
}

function readOk(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  const payload = encodeJsonFrame(FRAME_TAGS.READ_OK, {
    request_id: requestId,
    kind: 'file',
    path: RUTA,
    bytes: 12,
    truncated: false,
    modified_at: '2026-08-24T10:00:00Z',
    chunks: 1,
    ...overrides
  });
  return new FrameDecoder().push(payload)[0]!;
}

/** READ_DATA lleva el `request_id` como prefijo de 36 bytes ASCII, igual que STDOUT la sesión. */
function readData(requestId: string, data: Buffer): Frame {
  const payload = Buffer.concat([Buffer.from(requestId, 'ascii'), data]);
  return new FrameDecoder().push(encodeFrame(FRAME_TAGS.READ_DATA, payload))[0]!;
}

function readErr(requestId: string, error: string, reason = 'motivo'): Frame {
  return new FrameDecoder().push(
    encodeJsonFrame(FRAME_TAGS.READ_ERR, { request_id: requestId, error, reason })
  )[0]!;
}

describe('el hello declara qué sabe hacer el agente', () => {
  it('lee `features` cuando el agente las anuncia', () => {
    const hello = parseAgentHello(Buffer.from(JSON.stringify({
      v: 1, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus', generation: 'a'.repeat(32),
      image_id: 'sha256:beef', runtime_user: 'dev', runtime_uid: 1000, harness: 'claude',
      agent_version: '0.4.0', modes: ['shell'], features: ['read_governance']
    })));
    expect(hello?.features).toEqual(['read_governance']);
  });

  it('admite igual a un agente viejo que no manda `features`, y lo deja sin capacidades', () => {
    const hello = parseAgentHello(Buffer.from(JSON.stringify({
      v: 1, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus', generation: 'a'.repeat(32),
      image_id: 'sha256:beef', runtime_user: 'dev', runtime_uid: 1000, harness: 'claude',
      agent_version: '0.3.0', modes: ['shell']
    })));
    // Que entre es lo importante: si `features` fuese obligatorio, desplegar el relay antes que
    // el agente dejaría a la flota entera sin terminales.
    expect(hello).toBeDefined();
    expect(hello?.features).toEqual([]);
  });

  it('descarta entradas que no son texto en vez de invalidar el hello', () => {
    const hello = parseAgentHello(Buffer.from(JSON.stringify({
      v: 1, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus', generation: 'a'.repeat(32),
      image_id: 'sha256:beef', runtime_user: 'dev', runtime_uid: 1000, harness: 'claude',
      agent_version: '0.4.0', modes: ['shell'], features: ['read_governance', 7, null]
    })));
    expect(hello?.features).toEqual(['read_governance']);
  });
});

describe('requestFileRead no pregunta cuando no debe', () => {
  it('no manda NADA a un agente que no anuncia la capacidad', async () => {
    const { socket, connection } = conectar({ features: [] });

    const outcome = await requestFileRead(connection, 'Steven', 'zeus', RUTA);

    expect(outcome).toEqual({
      error: 'unavailable',
      reason: 'el pty-agent de ese alias no sabe leer ficheros de gobierno'
    });
    // Lo que de verdad se comprueba: no salió una sola trama. Un READ a un agente viejo es una
    // violación de protocolo para él, y se lleva por delante todas sus terminales abiertas.
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza sin preguntar si la conexión es de otro alias', async () => {
    const { socket, connection } = conectar();

    const outcome = await requestFileRead(connection, 'Steven', 'kant', RUTA);

    expect(outcome).toEqual({ error: 'permission_denied', reason: 'la conexión no es la de ese alias' });
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza sin preguntar si la conexión es de otro inquilino', async () => {
    const { socket, connection } = conectar();

    const outcome = await requestFileRead(connection, 'Miguel', 'zeus', RUTA);

    expect(outcome).toEqual({ error: 'permission_denied', reason: 'la conexión no es la de ese alias' });
    expect(socket.frames()).toEqual([]);
  });

  it('rechaza si la conexión ya está muerta', async () => {
    const { connection } = conectar();
    connection.destroy('agent_disconnected');

    const outcome = await requestFileRead(connection, 'Steven', 'zeus', RUTA);

    expect(outcome).toEqual({ error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' });
  });
});

describe('requestFileRead decodifica y acumula la respuesta', () => {
  it('manda un READ con la ruta y un request_id con forma de UUID', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);

    const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ);
    const body = JSON.parse(read!.payload.toString('utf8')) as Record<string, unknown>;
    expect(body.kind).toBe('file');
    expect(body.path).toBe(RUTA);
    // Tiene que ser un UUID en minúsculas con guiones: viaja como prefijo de 36 bytes de los
    // READ_DATA, y el agente no puede codificarlos con otra cosa.
    expect(body.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(String(body.request_id)).toHaveLength(SESSION_ID_BYTES);

    connection.handleFrame(readErr(String(body.request_id), 'not_found'), Date.now);
    await pendiente;
  });

  it('junta varias tramas DATA en el orden en que llegan', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { chunks: 3, bytes: 20 }), Date.now);
    connection.handleFrame(readData(id, Buffer.from('# Manual\n')), Date.now);
    connection.handleFrame(readData(id, Buffer.from('linea 2\n')), Date.now);
    connection.handleFrame(readData(id, Buffer.from('fin')), Date.now);

    expect(await pendiente).toEqual({
      path: RUTA,
      bytes: 20,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
      sha: createHash('sha256').update('# Manual\nlinea 2\nfin').digest('hex'),
      content: '# Manual\nlinea 2\nfin'
    });
  });

  it('reensambla un carácter multibyte partido entre dos tramas', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    // El pty-agent corta por BYTES, así que una «ó» puede quedar a caballo entre dos tramas. Si
    // se decodificara trama a trama saldrían dos caracteres de reemplazo en vez de la letra.
    const texto = Buffer.from('dirección', 'utf8');
    const corte = texto.indexOf(0xc3) + 1;
    connection.handleFrame(readOk(id, { chunks: 2, bytes: texto.byteLength }), Date.now);
    connection.handleFrame(readData(id, texto.subarray(0, corte)), Date.now);
    connection.handleFrame(readData(id, texto.subarray(corte)), Date.now);

    const outcome = await pendiente;
    expect('content' in outcome && outcome.content).toBe('dirección');
  });

  it('resuelve en el propio READ_OK cuando el fichero está vacío', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { chunks: 0, bytes: 0 }), Date.now);

    const outcome = await pendiente;
    expect('content' in outcome && outcome.content).toBe('');
  });

  it('conserva `truncated` y el tamaño REAL del fichero', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { chunks: 1, bytes: 900_000, truncated: true }), Date.now);
    connection.handleFrame(readData(id, Buffer.from('recortado')), Date.now);

    const outcome = await pendiente;
    expect(outcome).toMatchObject({ truncated: true, bytes: 900_000, content: 'recortado' });
  });

  it('aguanta que los DATA se adelanten al READ_OK', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readData(id, Buffer.from('antes')), Date.now);
    connection.handleFrame(readOk(id, { chunks: 1, bytes: 5 }), Date.now);

    const outcome = await pendiente;
    expect('content' in outcome && outcome.content).toBe('antes');
  });
});

describe('requestFileRead falla cerrado', () => {
  it('propaga el código de error del agente', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readErr(id, 'symlink_detected', 'path resolves somewhere else'), Date.now);

    expect(await pendiente).toEqual({ error: 'symlink_detected', reason: 'path resolves somewhere else' });
  });

  it('convierte en `unknown` un código que no reconoce', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readErr(id, 'te_lo_invento', 'lo que sea'), Date.now);

    expect(await pendiente).toEqual({ error: 'unknown', reason: 'lo que sea' });
  });

  it('rechaza una respuesta que viene por otra ruta', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { path: '/home/dev/.ssh/id_ed25519', chunks: 0 }), Date.now);

    expect(await pendiente).toEqual({
      error: 'unknown',
      reason: 'el agente contestó por una ruta distinta de la pedida'
    });
  });

  it('rechaza un READ_OK sin metadatos', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(
      new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.READ_OK, {
        request_id: id, kind: 'file', path: RUTA
      }))[0]!,
      Date.now
    );

    expect(await pendiente).toEqual({
      error: 'unknown',
      reason: 'el agente contestó sin los metadatos de la lectura'
    });
  });

  it('rechaza un agente que anuncia más tramas de las que cabe un documento', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { chunks: 4096 }), Date.now);

    expect(await pendiente).toEqual({
      error: 'too_large',
      reason: 'el agente anuncia más tramas de las que cabe un documento'
    });
  });

  it('corta al agente que se pasa del tope de bytes aunque prometiera pocas tramas', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { chunks: 8 }), Date.now);
    // 5 tramas al máximo del cable ya pasan de 256 KB: el corte tiene que saltar antes de la 5.ª.
    for (let enviadas = 0; enviadas < 5; enviadas += 1) {
      connection.handleFrame(readData(id, Buffer.alloc(MAX_DATA_BYTES, 0x61)), Date.now);
    }

    expect(await pendiente).toEqual({
      error: 'too_large',
      reason: 'el agente mandó más bytes de los que esta vía sirve'
    });
  });

  it('devuelve `timeout` si el agente no contesta', async () => {
    const { connection } = conectar();

    expect(await requestFileRead(connection, 'Steven', 'zeus', RUTA, 20)).toEqual({
      error: 'timeout',
      reason: 'el pty-agent no contestó en 20 ms'
    });
  });

  it('avisa en cuanto la conexión muere, sin esperar al temporizador', async () => {
    const { connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA, 60_000);

    connection.destroy('agent_disconnected');

    expect(await pendiente).toEqual({
      error: 'unavailable',
      reason: 'el pty-agent se desconectó: agent_disconnected'
    });
  });

  it('tira las tramas de una lectura que ya venció, sin matar la conexión', async () => {
    const { socket, connection } = conectar();
    const outcome = await requestFileRead(connection, 'Steven', 'zeus', RUTA, 20);
    expect(outcome).toMatchObject({ error: 'timeout' });
    const id = requestIdEnviado(socket);

    // Lo que llega tarde, o con un request_id inventado, se descarta: no revienta.
    expect(() => connection.handleFrame(readOk(id, { chunks: 0 }), Date.now)).not.toThrow();
    expect(() => connection.handleFrame(
      readData('ffffffff-ffff-4fff-8fff-ffffffffffff', Buffer.from('x')), Date.now
    )).not.toThrow();
    expect(connection.alive).toBe(true);
  });

  it('trata como violación un READ_OK sin request_id', () => {
    const { connection } = conectar();

    expect(() => connection.handleFrame(
      new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.READ_OK, { kind: 'file' }))[0]!,
      Date.now
    )).toThrow(/request id/u);
  });
});
