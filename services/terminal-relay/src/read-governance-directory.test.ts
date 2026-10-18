import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_READ_GOVERNANCE_DONE
  ,
} from './agent-leg.js';
import {
  FRAME_TAGS, FrameDecoder, MAX_DATA_BYTES, encodeFrame, encodeJsonFrame,
  type Frame
} from './framing.js';
import { requestDirectoryRead, requestFileRead } from './gateway-client.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

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

class FakeAgentSocket {
  destroyed = false;
  readonly written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  pause(): void { /* noop */ }
  resume(): void { /* noop */ }

  destroy(): void {
    this.destroyed = true;
  }

  asSocket(): TLSSocket {
    return this as unknown as TLSSocket;
  }

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
  while (vivos.length > 0) vivos.pop()?.destroy('test_over');
});

function requestIdEnviado(socket: FakeAgentSocket): string {
  const read = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ);
  expect(read, 'el relay no mandó ninguna trama READ').toBeDefined();
  if (!read) throw new Error('READ frame not found');
  const body = JSON.parse(read.payload.toString('utf8')) as Record<string, unknown>;
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
  const frame = new FrameDecoder().push(payload)[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

function directoryOk(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  const payload = encodeJsonFrame(FRAME_TAGS.READ_OK, {
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
  });
  const frame = new FrameDecoder().push(payload)[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

function readDone(requestId: string, overrides: Record<string, unknown> = {}): Frame {
  const frame = new FrameDecoder().push(
    encodeJsonFrame(FRAME_TAGS.READ_DONE, { request_id: requestId, ...overrides })
  )[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

function readData(requestId: string, data: Buffer): Frame {
  const payload = Buffer.concat([Buffer.from(requestId, 'ascii'), data]);
  const frame = new FrameDecoder().push(encodeFrame(FRAME_TAGS.READ_DATA, payload))[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

describe('requestFileRead falla cerrado', () => {

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

  it('corta al agente que se pasa del tope de bytes aunque prometiera pocas tramas', async () => {
    const { socket, connection } = conectar();
    const pendiente = requestFileRead(connection, 'Steven', 'zeus', RUTA);
    const id = requestIdEnviado(socket);

    connection.handleFrame(readOk(id, { chunks: 8 }), Date.now);
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
});

describe('requestDirectoryRead transporta sólo un índice acotado', () => {
  it('manda kind=dir y acepta metadata absoluta estrictamente contenida', async () => {
    const { socket, connection } = conectar();
    const pending = requestDirectoryRead(connection, 'Steven', 'zeus', MEMORY_ROOT);
    const id = requestIdEnviado(socket);
    const request = socket.frames().find((frame) => frame.tag === FRAME_TAGS.READ);
    if (!request) throw new Error('READ frame not found');
    expect(JSON.parse(request.payload.toString('utf8'))).toMatchObject({
      request_id: id, kind: 'dir', path: MEMORY_ROOT,
    });

    connection.handleFrame(directoryOk(id), Date.now);
    connection.handleFrame(readDone(id), Date.now);

    expect(await pending).toEqual({
      path: MEMORY_ROOT,
      total: 1,
      observed_at_least: 1,
      truncated: false,
      entries: [{
        path: `${MEMORY_ROOT}/sesion.md`, bytes: 12, modified_at: '2026-08-24T10:00:00Z',
      }],
    });
  });

  it('no acepta éxito en una microtarea: exige DONE y cierra si llega DATA después', async () => {
    const { socket, connection } = conectar();
    const pending = requestDirectoryRead(connection, 'Steven', 'zeus', MEMORY_ROOT);
    const id = requestIdEnviado(socket);
    let settled = false;
    void pending.then(() => { settled = true; });

    connection.handleFrame(directoryOk(id), Date.now);
    await Promise.resolve();
    expect(settled).toBe(false);

    connection.handleFrame(readData(id, Buffer.from('contenido prohibido')), Date.now);
    expect(await pending).toMatchObject({
      error: 'unknown', reason: 'el agente mandó contenido en un índice de directorio',
    });
    expect(connection.alive).toBe(false);
  });

  it('aplica el límite de 200 y la coherencia entre total, truncated y entries', async () => {
    const cases: Record<string, unknown>[] = [
      {
        total: 201,
        observed_at_least: 201,
        truncated: true,
        entries: Array.from({ length: 201 }, (_, index) => ({
          path: `${MEMORY_ROOT}/${String(index)}.md`, bytes: index, modified_at: '2026-08-24T10:00:00Z',
        })),
      },
      { total: 0, observed_at_least: 0 },
      { total: 2, observed_at_least: 2, truncated: false },
      { total: -1, observed_at_least: 0, entries: [] },
      { total: null, observed_at_least: 5_000, truncated: false },
    ];
    for (const overrides of cases) {
      const { socket, connection } = conectar();
      const pending = requestDirectoryRead(connection, 'Steven', 'zeus', MEMORY_ROOT);
      connection.handleFrame(directoryOk(requestIdEnviado(socket), overrides), Date.now);
      expect(await pending).toMatchObject({ error: 'unknown' });
    }
  });

  it('exige la raíz exacta derivada del HELLO, no cualquier directorio bajo HOME', async () => {
    const { socket, connection } = conectar();
    expect(await requestDirectoryRead(connection, 'Steven', 'zeus', '/home/dev')).toMatchObject({
      error: 'invalid_path',
    });
    expect(socket.frames()).toEqual([]);
  });
});
