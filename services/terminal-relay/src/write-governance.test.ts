import { createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_WRITE_GOVERNANCE,
} from './agent-leg.js';
import {
  decodeDataFrame, decodeJsonFrame, encodeJsonFrame, FrameDecoder, FRAME_TAGS, type Frame,
} from './framing.js';
import { MAX_GOVERNANCE_BYTES, requestFileWrite } from './gateway-client.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

const RUTA = '/home/dev/.claude/CLAUDE.md';
const HELLO = agentHello({
  alias: 'zeus', container_id: 'claw-zeus', runtime_user: 'dev', harness: 'claude',
  agent_version: '0.5.0', features: [FEATURE_WRITE_GOVERNANCE],
});

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

class FakeAgentSocket {
  destroyed = false;
  readonly written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  destroy(): void { this.destroyed = true; }
  asSocket(): TLSSocket { return this as unknown as TLSSocket; }
  frames(): Frame[] { return new FrameDecoder().push(Buffer.concat(this.written)); }
}

const vivos: AgentConnection[] = [];

function conectar(overrides: Partial<AgentHello> = {}) {
  const socket = new FakeAgentSocket();
  const connection = new AgentConnection(socket.asSocket(), { ...HELLO, ...overrides }, 'AA:BB', () => Date.now());
  vivos.push(connection);
  return { socket, connection };
}

afterEach(() => {
  while (vivos.length > 0) vivos.pop()?.destroy('test_over');
});

function writeFrame(socket: FakeAgentSocket): Frame {
  const frame = socket.frames().find((candidate) => candidate.tag === FRAME_TAGS.WRITE);
  expect(frame, 'el relay no mandó WRITE').toBeDefined();
  if (!frame) throw new Error('el relay no mandó WRITE');
  return frame;
}

function requestId(socket: FakeAgentSocket): string {
  return String(decodeJsonFrame(writeFrame(socket).payload).request_id);
}

function response(tag: typeof FRAME_TAGS.WRITE_OK | typeof FRAME_TAGS.WRITE_ERR, body: Record<string, unknown>): Frame {
  const frame = new FrameDecoder().push(encodeJsonFrame(tag, body))[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

describe('requestFileWrite negocia y encuadra', () => {
  it('no manda tags nuevos a un agente que no anunció write_governance_v1', async () => {
    const { socket, connection } = conectar({ features: ['read_governance'] });

    expect(await requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, Buffer.from('x'), { state: 'absent' },
    )).toEqual({
      error: 'unavailable', reason: 'el pty-agent de ese alias no sabe escribir ficheros de gobierno',
    });
    expect(socket.frames()).toEqual([]);
  });

  it('manda precondición replace, digest y contenido binario correlacionado', async () => {
    const { socket, connection } = conectar();
    const content = Buffer.from('# Manual\nacción\n'.repeat(5_000), 'utf8');
    const oldSha = 'b'.repeat(64);
    const pending = requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, content, { state: 'present', sha256: oldSha }, 60_000,
    );

    const begin = decodeJsonFrame(writeFrame(socket).payload);
    expect(begin).toMatchObject({
      path: RUTA, operation: 'replace', expected_sha: oldSha,
      content_sha: sha(content), bytes: content.byteLength,
    });
    const data = socket.frames().filter((frame) => frame.tag === FRAME_TAGS.WRITE_DATA);
    expect(data).toHaveLength(Number(begin.chunks));
    expect(Buffer.concat(data.map((frame) => {
      const decoded = decodeDataFrame(frame.payload);
      expect(decoded.sessionId).toBe(begin.request_id);
      return decoded.data;
    }))).toEqual(content);

    connection.handleFrame(response(FRAME_TAGS.WRITE_ERR, {
      request_id: begin.request_id, error: 'conflict', reason: 'test cleanup',
    }), Date.now);
    await pending;
  });
});

describe('requestFileWrite sólo acepta un ACK verificable', () => {
  it('resuelve éxito cuando path, operación, SHA y bytes coinciden', async () => {
    const { socket, connection } = conectar();
    const content = Buffer.from('nuevo');
    const pending = requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, content, { state: 'absent' }, 60_000,
    );
    const id = requestId(socket);

    connection.handleFrame(response(FRAME_TAGS.WRITE_OK, {
      request_id: id, path: RUTA, operation: 'create', sha: sha(content), bytes: content.byteLength,
    }), Date.now);

    expect(await pending).toEqual({
      path: RUTA, operation: 'create', sha: sha(content), bytes: content.byteLength,
    });
  });

  it.each([
    { path: '/otra/ruta' },
    { operation: 'replace' },
    { sha: '0'.repeat(64) },
    { bytes: 999 },
  ])('rechaza un ACK que no acredita la petición: %o', async (override) => {
    const { socket, connection } = conectar();
    const content = Buffer.from('nuevo');
    const pending = requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, content, { state: 'absent' }, 60_000,
    );
    connection.handleFrame(response(FRAME_TAGS.WRITE_OK, {
      request_id: requestId(socket), path: RUTA, operation: 'create', sha: sha(content),
      bytes: content.byteLength, ...override,
    }), Date.now);

    expect(await pending).toEqual({
      error: 'unknown', reason: 'el ACK del agente no acredita la escritura solicitada',
    });
  });

  it('propaga el conflicto del CAS sin transformarlo en éxito', async () => {
    const { socket, connection } = conectar();
    const pending = requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, Buffer.from('nuevo'),
      { state: 'present', sha256: 'a'.repeat(64) }, 60_000,
    );
    connection.handleFrame(response(FRAME_TAGS.WRITE_ERR, {
      request_id: requestId(socket), error: 'conflict', reason: 'la huella cambió',
    }), Date.now);
    expect(await pending).toEqual({ error: 'conflict', reason: 'la huella cambió' });
  });
});

describe('requestFileWrite timeout, cancelación y desconexión', () => {
  it('vence, desengancha y manda WRITE_CANCEL', async () => {
    const { socket, connection } = conectar();
    const outcome = await requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, Buffer.from('nuevo'), { state: 'absent' }, 20,
    );
    expect(outcome).toMatchObject({ error: 'timeout' });
    expect(socket.frames().map((frame) => frame.tag)).toContain(FRAME_TAGS.WRITE_CANCEL);
    const id = requestId(socket);
    expect(() => { connection.handleFrame(response(FRAME_TAGS.WRITE_OK, {
      request_id: id, path: RUTA, operation: 'create', sha: sha(Buffer.from('nuevo')), bytes: 5,
    }), Date.now); }).not.toThrow();
    expect(connection.alive).toBe(true);
  });

  it('un AbortSignal cancela la transacción incompleta', async () => {
    const { socket, connection } = conectar();
    const abort = new AbortController();
    const pending = requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, Buffer.from('nuevo'), { state: 'absent' }, 60_000, abort.signal,
    );
    abort.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ error: 'unavailable' });
    expect('reason' in outcome && outcome.reason.includes('cancelada')).toBe(true);
    expect(socket.frames().map((frame) => frame.tag)).toContain(FRAME_TAGS.WRITE_CANCEL);
  });

  it('resuelve al caer el agente sin esperar el timeout', async () => {
    const { connection } = conectar();
    const pending = requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, Buffer.from('nuevo'), { state: 'absent' }, 60_000,
    );
    connection.destroy('network_lost');
    expect(await pending).toEqual({
      error: 'unavailable', reason: 'el pty-agent se desconectó: network_lost',
    });
  });

  it('rechaza contenido por encima del tope antes de tocar el socket', async () => {
    const { socket, connection } = conectar();
    expect(await requestFileWrite(
      connection, 'Steven', 'zeus', RUTA, Buffer.alloc(MAX_GOVERNANCE_BYTES + 1), { state: 'absent' },
    )).toMatchObject({ error: 'too_large' });
    expect(socket.frames()).toEqual([]);
  });
});
