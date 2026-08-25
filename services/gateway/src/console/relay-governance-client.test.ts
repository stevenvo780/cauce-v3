import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpGovernanceRelayClient } from './relay-governance-client.js';

/**
 * El cliente contra un terminal-relay de mentira pero un HTTPS de verdad: certificado propio,
 * verificación activada y un viaje real por el socket. Lo que se prueba es lo que este cliente
 * PONE en el cable y lo que hace con lo que le devuelven — incluido lo que le devuelven roto, que
 * es el caso que decide si el modal enseña un error honesto o un fichero inventado.
 */

const TOKEN = 'token-compartido-con-el-relay-0123456789';
const RUTA = '/home/dev/.claude/CLAUDE.md';
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

/** Un cliente apuntando al servidor de este fichero, con su CA para que verifique de verdad. */
function cliente(overrides: { timeoutMs?: number; puerto?: number } = {}): HttpGovernanceRelayClient {
  return new HttpGovernanceRelayClient({
    relayUrl: `https://127.0.0.1:${overrides.puerto ?? puerto}`,
    token: TOKEN,
    ca: tls.cert,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs })
  });
}

/** Contesta con este JSON (o con esta cadena cruda) y este código. */
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

    // Rellenar `bytes` o `modified_at` con un cero y una fecha de hoy sería enseñar un fichero
    // creíble que nadie midió. Falla cerrado.
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

    // `timeout` y no `unavailable`: el relay puede estar sano y ser el pty-agent el que calla.
    expect(resultado).toMatchObject({ error: 'timeout' });
    expect(String((resultado as { reason: string }).reason)).toContain('timed out');
  });

  it('no lanza si el relay no está escuchando', async () => {
    // Puerto sin nadie detrás: un `throw` aquí tumbaría la pantalla entera de Directiva.
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
