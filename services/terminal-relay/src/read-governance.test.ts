import { createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_READ_GOVERNANCE_DONE,
  parseAgentHello,
} from './agent-leg.js';
import {
  FRAME_TAGS, FrameDecoder, SESSION_ID_BYTES, encodeFrame, encodeJsonFrame,
  type Frame
} from './framing.js';
import { requestFileRead } from './gateway-client.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

/**
 * Lectura de ficheros de gobierno por el cable del pty-agent.
 *
 * Se prueba contra la `AgentConnection` de verdad, no contra un doble: lo que hay que verificar es
 * justamente el decodificado de tramas y el reensamblado, que es donde un doble mentiría.
 */

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

  it('transporta contexto canónico y descarta el trío completo si root/cwd no encajan', () => {
    const base = {
      v: 1, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus', generation: 'a'.repeat(32),
      image_id: 'sha256:beef', runtime_user: 'dev', runtime_uid: 1000, harness: 'claude',
      agent_version: '0.5.0', modes: ['shell'], runtime_facts_observed: true,
      home: '/home/dev', claude_config_dir: '/home/dev/.claude', cwd: '/workspace/repo/sub',
      workspace_root: '/workspace', project_root: '/workspace/repo',
    };
    expect(parseAgentHello(Buffer.from(JSON.stringify(base)))).toMatchObject({
      cwd: '/workspace/repo/sub', workspace_root: '/workspace', project_root: '/workspace/repo',
    });
    const mismatched = parseAgentHello(Buffer.from(JSON.stringify({
      ...base, workspace_root: '/workspace/sibling',
    })));
    expect(mismatched).toBeDefined();
    expect(mismatched?.cwd).toBeUndefined();
    expect(mismatched?.workspace_root).toBeUndefined();
    expect(mismatched?.project_root).toBeUndefined();
    expect(mismatched?.runtime_facts_observed).toBe(false);
    expect(mismatched?.home).toBeUndefined();
  });

  it('acepta la proyección Codex sólo como par estricto y no rompe el hello si es inválida', () => {
    const base = {
      v: 1, tenant_id: 'Steven', alias: 'kant', container_id: 'ws-kant', generation: 'a'.repeat(32),
      image_id: 'sha256:beef', runtime_user: 'stev', runtime_uid: 1000, harness: 'codex',
      agent_version: '0.6.0', modes: ['harness'], runtime_facts_observed: true,
      home: '/home/stev', codex_home: '/home/stev/.codex',
      project_doc_max_bytes: 65_536,
      project_doc_fallback_filenames: ['TEAM.md', 'LOCAL.md'],
    };
    expect(parseAgentHello(Buffer.from(JSON.stringify(base)))).toMatchObject({
      runtime_facts_observed: true,
      project_doc_max_bytes: 65_536,
      project_doc_fallback_filenames: ['TEAM.md', 'LOCAL.md'],
    });

    for (const invalid of [
      { ...base, project_doc_max_bytes: true },
      { ...base, project_doc_fallback_filenames: ['TEAM.md', 'TEAM.md'] },
      { ...base, project_doc_fallback_filenames: ['../auth.json'] },
      { ...base, project_doc_fallback_filenames: ['secreto.key'] },
      { ...base, project_doc_fallback_filenames: ['SECRET.PEM'] },
      { ...base, project_doc_fallback_filenames: ['Auth.Json'] },
      { ...base, project_doc_fallback_filenames: ['private.KEY'] },
      { ...base, project_doc_fallback_filenames: undefined },
      { ...base, harness: 'claude' },
    ]) {
      const parsed = parseAgentHello(Buffer.from(JSON.stringify(invalid)));
      expect(parsed).toBeDefined();
      expect(parsed?.project_doc_max_bytes).toBeUndefined();
      expect(parsed?.project_doc_fallback_filenames).toBeUndefined();
    }

    expect(parseAgentHello(Buffer.from(JSON.stringify({
      ...base, runtime_facts_observed: false,
    })))?.runtime_facts_observed).toBe(false);
    expect(parseAgentHello(Buffer.from(JSON.stringify({
      ...base, runtime_facts_observed: 'true',
    })))?.runtime_facts_observed).toBe(false);

    const partial = { ...base, codex_home: undefined };
    const parsedPartial = parseAgentHello(Buffer.from(JSON.stringify(partial)));
    expect(parsedPartial?.runtime_facts_observed).toBe(false);
    expect(parsedPartial?.home).toBeUndefined();
    expect(parsedPartial?.project_doc_max_bytes).toBeUndefined();
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
