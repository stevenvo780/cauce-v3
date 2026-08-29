import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpGovernanceRelayClient, parseDirectoryOutcome } from './relay-governance-client.js';

/**
 * The client against a fake terminal-relay but real HTTPS: own certificate, verification on,
 * and a real trip through the socket. What is tested is what this client PUTS on the wire and
 * what it does with what comes back — including what comes back broken, which is the case that
 * decides whether the modal shows an honest error or an invented file.
 */

const TOKEN = 'token-compartido-con-el-relay-0123456789';
const RUTA = '/home/dev/.claude/CLAUDE.md';
const MEMORY_ROOT = '/home/dev/.claude/projects';
const CONTENIDO = '# Manual\n';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface PeticionRecibida {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

let tls: { cert: Buffer; key: Buffer; directory: string };
let servidor: HttpsServer;
let puerto: number;
let recibidas: PeticionRecibida[];
let responder: (peticion: PeticionRecibida, response: ServerResponse) => void;

function certificadoEfimero(): { cert: Buffer; key: Buffer; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-gov-client-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'pipe' });
  return { cert: readFileSync(certPath), key: readFileSync(keyPath), directory };
}

/** A client pointing at this file's server, with its CA so verification really happens. */
function cliente(overrides: { timeoutMs?: number; puerto?: number } = {}): HttpGovernanceRelayClient {
  return new HttpGovernanceRelayClient({
    relayUrl: `https://127.0.0.1:${overrides.puerto ?? puerto}`,
    token: TOKEN,
    ca: tls.cert,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs })
  });
}

/** Replies with this JSON (or with this raw string) and this code. */
function contestar(status: number, body: unknown): void {
  responder = (_peticion, response) => {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.byteLength });
    response.end(payload);
  };
}

beforeAll(async () => {
  tls = certificadoEfimero();
  servidor = createServer({ cert: tls.cert, key: tls.key }, (request: IncomingMessage, response) => {
    const trozos: Buffer[] = [];
    request.on('data', (trozo: Buffer) => trozos.push(trozo));
    request.on('end', () => {
      const peticion: PeticionRecibida = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: Buffer.concat(trozos).toString('utf8')
      };
      recibidas.push(peticion);
      responder(peticion, response);
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  puerto = (servidor.address() as AddressInfo).port;
});

beforeEach(() => {
  recibidas = [];
  contestar(200, {
    path: RUTA, bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z',
    sha: sha(CONTENIDO), content: CONTENIDO,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  rmSync(tls.directory, { recursive: true, force: true });
});

describe('lo que el cliente pone en el cable', () => {
  it('hace POST a /v3/terminal/relay/read con el alias y la ruta', async () => {
    await cliente().readFile('Steven', 'zeus', RUTA);

    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]?.method).toBe('POST');
    expect(recibidas[0]?.url).toBe('/v3/terminal/relay/read');
    expect(recibidas[0]?.contentType).toBe('application/json');
    expect(JSON.parse(recibidas[0]?.body ?? '')).toEqual({ tenant_id: 'Steven', alias: 'zeus', path: RUTA });
  });

  it('se presenta con el token compartido como Bearer', async () => {
    await cliente().readFile('Steven', 'zeus', RUTA);

    expect(recibidas[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('usa el endpoint explícito /list para índices de directorio', async () => {
    contestar(200, {
      path: MEMORY_ROOT, total: 0, observed_at_least: 0, truncated: false, entries: [],
    });

    await cliente().listDirectory('Steven', 'zeus', MEMORY_ROOT);

    expect(recibidas[0]?.url).toBe('/v3/terminal/relay/list');
    expect(recibidas[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(recibidas[0]?.body ?? '')).toEqual({
      tenant_id: 'Steven', alias: 'zeus', path: MEMORY_ROOT,
    });
  });
});

describe('índice de directorio', () => {
  function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      path: MEMORY_ROOT,
      total: 1,
      observed_at_least: 1,
      truncated: false,
      entries: [{
        path: `${MEMORY_ROOT}/sesion.md`, bytes: 12, modified_at: '2026-08-24T10:00:00Z',
      }],
      ...overrides,
    };
  }

  it('acepta metadata absoluta, acotada y coherente', async () => {
    contestar(200, listing());
    expect(await cliente().listDirectory('Steven', 'zeus', MEMORY_ROOT)).toEqual(listing());
  });

  it('conserva un límite inferior cuando el cap impide conocer el total', async () => {
    const lowerBound = listing({ total: null, observed_at_least: 5_000, truncated: true });
    contestar(200, lowerBound);
    expect(await cliente().listDirectory('Steven', 'zeus', MEMORY_ROOT)).toEqual(lowerBound);
  });

  it.each([
    ['escape ..', listing({ entries: [{
      path: `${MEMORY_ROOT}/../auth.json`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] })],
    ['prefix collision', listing({ entries: [{
      path: `${MEMORY_ROOT}-otra/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] })],
    ['absolute outside', listing({ entries: [{
      path: '/etc/passwd', bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] })],
    ['duplicate', listing({ total: 2, entries: [
      { path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' },
      { path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' },
    ] })],
    ['credential', listing({ entries: [{
      path: `${MEMORY_ROOT}/id_ed25519`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] })],
    ['invalid date', listing({ entries: [{
      path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-02-30T10:00:00Z',
    }] })],
    ['symlink marker', listing({ entries: [{
      path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z', symlink: true,
    }] })],
  ])('rechaza %s', (_label, body) => {
    expect(parseDirectoryOutcome(JSON.stringify(body))).toHaveProperty('error');
  });

  it('rechaza más de 200 entradas y totales incoherentes', () => {
    expect(parseDirectoryOutcome(JSON.stringify(listing({
      total: 201,
      truncated: true,
      entries: Array.from({ length: 201 }, (_, index) => ({
        path: `${MEMORY_ROOT}/${index}.md`, bytes: index, modified_at: '2026-08-24T10:00:00Z',
      })),
    })))).toHaveProperty('error');
    expect(parseDirectoryOutcome(JSON.stringify(listing({ total: 0 })))).toHaveProperty('error');
    expect(parseDirectoryOutcome(JSON.stringify(listing({ total: 2, truncated: false })))).toHaveProperty('error');
    expect(parseDirectoryOutcome(JSON.stringify(listing({ total: -1, entries: [] })))).toHaveProperty('error');
  });

  it('rechaza cuerpos no JSON, campos extra y fallos deformes', () => {
    expect(parseDirectoryOutcome('<html>')).toHaveProperty('error');
    expect(parseDirectoryOutcome(JSON.stringify(listing({ extra: true })))).toHaveProperty('error');
    expect(parseDirectoryOutcome(JSON.stringify({ error: 'timeout', reason: 'tarde', extra: true }))).toEqual({
      error: 'unknown', reason: 'el terminal-relay contestó un fallo de índice inválido',
    });
  });

  it('propaga auth, timeout y relay offline sin inventar vacío', async () => {
    contestar(401, '');
    expect(await cliente().listDirectory('Steven', 'zeus', MEMORY_ROOT)).toMatchObject({
      error: 'permission_denied',
    });

    responder = () => { /* relay vivo pero mudo */ };
    expect(await cliente({ timeoutMs: 150 }).listDirectory('Steven', 'zeus', MEMORY_ROOT)).toMatchObject({
      error: 'timeout',
    });

    expect(await cliente({ puerto: 1, timeoutMs: 500 }).listDirectory('Steven', 'zeus', MEMORY_ROOT)).toMatchObject({
      error: 'unavailable',
    });
  });

  it('aborta el socket saliente y devuelve cancelled cuando cierra el HTTP de la consola', async () => {
    let received!: () => void;
    const reachedRelay = new Promise<void>((resolve) => { received = resolve; });
    responder = () => { received(); };
    const abort = new AbortController();

    const pending = cliente({ timeoutMs: 60_000 }).listDirectory(
      'Steven', 'zeus', MEMORY_ROOT, abort.signal,
    );
    await reachedRelay;
    abort.abort();

    await expect(pending).resolves.toEqual({
      error: 'cancelled', reason: 'se cerró la petición antes de terminar el índice',
    });
  });
});

describe('lo que el cliente entiende de la respuesta', () => {
  it('devuelve la lectura tal cual cuando el relay la sirve', async () => {
    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      path: RUTA,
      bytes: 9,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
      sha: sha(CONTENIDO),
      content: CONTENIDO,
    });
  });

  it('conserva `truncated` y el tamaño REAL del fichero', async () => {
    contestar(200, {
      path: RUTA, bytes: 900_000, truncated: true, modified_at: '2026-08-24T10:00:00Z',
      sha: 'a'.repeat(64), content: 'recortado',
    });

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toMatchObject({ truncated: true, bytes: 900_000 });
  });

  it('propaga el fallo de lectura que declara el relay', async () => {
    contestar(200, { error: 'symlink_detected', reason: 'apunta a otro sitio' });

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'symlink_detected', reason: 'apunta a otro sitio'
    });
  });

  it('convierte en `unknown` un código de error que no reconoce', async () => {
    contestar(200, { error: 'te_lo_invento', reason: 'lo que sea' });

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({ error: 'unknown', reason: 'lo que sea' });
  });

  it('no inventa el contenido de una lectura que vino sin metadatos', async () => {
    contestar(200, {
      path: RUTA, modified_at: '2026-08-24T10:00:00Z', sha: sha(CONTENIDO), content: CONTENIDO,
    });

    // Filling `bytes` or `modified_at` with a zero and today's date would be showing a credible
    // file nobody measured. Fail closed.
    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'unknown', reason: 'la lectura vino sin un tamaño creíble'
    });
  });

  it('rechaza una lectura que no dice si viene recortada', async () => {
    contestar(200, {
      path: RUTA, bytes: 9, modified_at: '2026-08-24T10:00:00Z',
      sha: sha(CONTENIDO), content: CONTENIDO,
    });

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'unknown', reason: 'la lectura no dice si viene recortada'
    });
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    contestar(200, '<html>vaya</html>');

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'unknown', reason: 'el terminal-relay contestó algo que no es JSON'
    });
  });
});

describe('lo que el cliente hace cuando el transporte falla', () => {
  it('trata el 401 del relay como credencial rechazada, no como fichero ausente', async () => {
    contestar(401, '');

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway'
    });
  });

  it('dice qué código contestó el relay cuando no es 200', async () => {
    contestar(503, { error: 'unavailable' });

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'unavailable', reason: 'el terminal-relay contestó 503'
    });
  });

  it('vence sin lanzar si el relay no contesta', async () => {
    responder = () => { /* se traga la petición: el relay está vivo pero mudo */ };

    const resultado = await cliente({ timeoutMs: 150 }).readFile('Steven', 'zeus', RUTA);

    // `timeout` and not `unavailable`: the relay may be healthy and the pty-agent the silent one.
    expect(resultado).toMatchObject({ error: 'timeout' });
    expect(String((resultado as { reason: string }).reason)).toContain('timed out');
  });

  it('no lanza si el relay no está escuchando', async () => {
    // Port with nobody listening: a `throw` here would take down the entire Directiva screen.
    const resultado = await cliente({ puerto: 1, timeoutMs: 500 }).readFile('Steven', 'zeus', RUTA);

    expect(resultado).toMatchObject({ error: 'unavailable' });
    expect(String((resultado as { reason: string }).reason)).toContain('no se pudo hablar con el terminal-relay');
  });

  it('corta una respuesta que se pasa del tope en vez de acumularla', async () => {
    contestar(200, {
      path: RUTA, bytes: 9, truncated: false, modified_at: '2026-08-24T10:00:00Z',
      sha: 'a'.repeat(64), content: 'a'.repeat(600 * 1024)
    });

    expect(await cliente().readFile('Steven', 'zeus', RUTA)).toEqual({
      error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta'
    });
  });
});

describe('escritura gobernada', () => {
  it('manda contenido base64 y la precondición exacta a /write', async () => {
    const nuevo = '# nuevo\nacción\n';
    contestar(200, {
      path: RUTA, operation: 'replace', sha: sha(nuevo), bytes: Buffer.byteLength(nuevo),
    });

    const resultado = await cliente().writeFile(
      'Steven', 'zeus', RUTA, nuevo, { state: 'present', sha256: 'a'.repeat(64) },
    );

    expect(resultado).toEqual({
      path: RUTA, operation: 'replace', sha: sha(nuevo), bytes: Buffer.byteLength(nuevo),
    });
    expect(recibidas[0]?.url).toBe('/v3/terminal/relay/write');
    expect(JSON.parse(recibidas[0]?.body ?? '')).toEqual({
      tenant_id: 'Steven', alias: 'zeus', path: RUTA,
      content_base64: Buffer.from(nuevo, 'utf8').toString('base64'),
      precondition: { state: 'present', sha256: 'a'.repeat(64) },
    });
  });

  it('propaga conflicto y rechaza un 2xx que no trae el ACK completo', async () => {
    contestar(200, { error: 'conflict', reason: 'la huella cambió' });
    expect(await cliente().writeFile(
      'Steven', 'zeus', RUTA, 'x', { state: 'present', sha256: 'b'.repeat(64) },
    )).toEqual({ error: 'conflict', reason: 'la huella cambió' });

    contestar(200, { ok: true });
    expect(await cliente().writeFile(
      'Steven', 'zeus', RUTA, 'x', { state: 'absent' },
    )).toMatchObject({ error: 'unknown' });
  });

  it('una creación viaja como absent y sólo acepta operation=create', async () => {
    contestar(200, { path: RUTA, operation: 'create', sha: sha('x'), bytes: 1 });
    expect(await cliente().writeFile(
      'Steven', 'zeus', RUTA, 'x', { state: 'absent' },
    )).toMatchObject({ operation: 'create', sha: sha('x'), bytes: 1 });
  });

  it('manda un lote ordenado a /write-batch y exige ACK por cada fichero', async () => {
    const soul = '/home/claw/workspace/SOUL.md';
    const agents = '/home/claw/workspace/AGENTS.md';
    contestar(200, { files: [
      { path: soul, operation: 'create', sha: sha('alma'), bytes: 4 },
      { path: agents, operation: 'replace', sha: sha('reglas'), bytes: 6 },
    ] });

    const resultado = await cliente().writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: soul, content: 'alma', precondition: { state: 'absent' } },
      {
        mode: 'write', path: agents, content: 'reglas',
        precondition: { state: 'present', sha256: 'c'.repeat(64) },
      },
    ]);

    expect(resultado).toEqual({ files: [
      { path: soul, operation: 'create', sha: sha('alma'), bytes: 4 },
      { path: agents, operation: 'replace', sha: sha('reglas'), bytes: 6 },
    ] });
    expect(recibidas[0]?.url).toBe('/v3/terminal/relay/write-batch');
    expect(JSON.parse(recibidas[0]?.body ?? '')).toEqual({
      tenant_id: 'Steven', alias: 'jarvis', files: [
        {
          mode: 'write', path: soul, content_base64: Buffer.from('alma').toString('base64'),
          precondition: { state: 'absent' },
        },
        {
          mode: 'write', path: agents, content_base64: Buffer.from('reglas').toString('base64'),
          precondition: { state: 'present', sha256: 'c'.repeat(64) },
        },
      ],
    });
  });

  it('rechaza un 2xx batch parcial, repetido o con ACK inválido', async () => {
    const soul = '/home/claw/workspace/SOUL.md';
    contestar(200, { files: [] });
    expect(await cliente().writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: soul, content: 'alma', precondition: { state: 'absent' } },
    ])).toMatchObject({ error: 'unknown' });

    contestar(200, { files: [
      { path: soul, operation: 'create', sha: sha('alma'), bytes: 4 },
      { path: soul, operation: 'create', sha: sha('alma'), bytes: 4 },
    ] });
    expect(await cliente().writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: soul, content: 'alma', precondition: { state: 'absent' } },
    ])).toMatchObject({ error: 'unknown' });
  });

  it('manda verify sin contenido y acepta unchanged con la huella preservada', async () => {
    const memory = '/home/claw/workspace/MEMORY.md';
    const before = 'd'.repeat(64);
    contestar(200, { files: [
      { path: memory, operation: 'unchanged', sha: before, bytes: 123 },
    ] });

    expect(await cliente().writeFiles('Steven', 'jarvis', [{
      mode: 'verify', path: memory, precondition: { state: 'present', sha256: before },
    }])).toEqual({ files: [
      { path: memory, operation: 'unchanged', sha: before, bytes: 123 },
    ] });
    const enviado = JSON.parse(recibidas[0]?.body ?? '') as {
      files: Array<Record<string, unknown>>;
    };
    expect(enviado).toMatchObject({ files: [{
      mode: 'verify', path: memory, precondition: { state: 'present', sha256: before },
    }] });
    expect(enviado.files[0]).not.toHaveProperty('content_base64');
  });
});
