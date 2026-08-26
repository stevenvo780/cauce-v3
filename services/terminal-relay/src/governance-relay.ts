import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AgentLookup } from './agent-leg.js';
import {
  MAX_GOVERNANCE_BYTES, requestDirectoryRead, requestFileRead, requestFileWrite,
  requestFileWriteBatch, type DirectoryReadOutcome, type FileReadOutcome, type FileWriteOutcome,
  type GovernanceWriteBatchEntry,
  type GovernanceWriteBatchOutcome, type GovernanceWritePrecondition,
} from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';

/**
 * `POST /v3/terminal/relay/read|write` — puertas mTLS del gateway hacia el disco gobernado.
 *
 * Es el eslabón que faltaba entre el gateway y el pty-agent: `requestFileRead` ya sabía hablar con
 * el agente, pero nadie desde fuera del proceso podía llamarla. Esto la expone, y nada más.
 *
 * Lo que este módulo NO decide:
 *  - QUÉ se puede leer. La ruta la resuelve el gateway desde hechos medidos (`verifyReadablePath`)
 *    y el pty-agent la vuelve a validar contra su propia lista blanca antes de abrir nada. El relay
 *    no tiene los hechos del alias, así que no tiene con qué opinar; si opinara con menos
 *    información que los otros dos, sería una tercera regla que se contradice con las buenas.
 *  - QUIÉN puede pedirlo. Eso lo resolvió el gateway con el principal de la consola. Aquí sólo se
 *    comprueba que quien llama ES el gateway.
 *
 * Lo que sí decide, y por eso está aquí: que la llamada no pueda hacerle daño al resto. Cuerpo
 * acotado, alias con forma de alias, y la lectura delegada a `requestFileRead`, que ya corta por
 * tiempo, por bytes y por agente que no anuncia la capacidad.
 *
 * SOBRE EL TRANSPORTE: esto se engancha al servidor HTTPS del lado navegador, que
 * `createBrowserHttpsServer` levanta con `requestCert`/`rejectUnauthorized`. O sea que antes de
 * llegar a este código el par ya presentó un certificado de cliente firmado por la CA de la
 * consola. El token es la SEGUNDA barrera, no la única.
 */

/** Ruta de la lectura. Vive fuera de `/v3/console/` por lo mismo que las del gateway: no es un navegador. */
export const GOVERNANCE_READ_PATH = '/v3/terminal/relay/read';
export const GOVERNANCE_LIST_PATH = '/v3/terminal/relay/list';
export const GOVERNANCE_WRITE_PATH = '/v3/terminal/relay/write';
export const GOVERNANCE_WRITE_BATCH_PATH = '/v3/terminal/relay/write-batch';

/** Base64 de 256 KiB más JSON. No se acumula nada por encima de este techo. */
const MAX_REQUEST_BYTES = 512 * 1024;

/** Misma forma de alias que exige el gateway al pedir una sesión de terminal. */
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;

const MAX_TENANT_LENGTH = 64;
const MAX_PATH_LENGTH = 4096;

export interface GovernanceRelayOptions {
  /** El mismo servidor del lado navegador; se le añade un oyente de `request`, no se crea otro. */
  readonly server: HttpsServer;
  readonly agents: AgentLookup;
  /**
   * El token compartido con el gateway. Es una función y no una cadena a propósito: el relay ya lee
   * su token del disco en cada llamada saliente, y así rotarlo tampoco obliga a reiniciar aquí.
   */
  readonly token: () => Promise<string>;
  /** Se propaga a `requestFileRead`; su default (5 s) es el que manda si no se pasa nada. */
  readonly timeoutMs?: number;
}

interface ReadRequest {
  readonly tenantId: string;
  readonly alias: string;
  readonly path: string;
}

type DirectoryRequest = ReadRequest;

interface WriteRequest extends ReadRequest {
  readonly content: Buffer;
  readonly precondition: GovernanceWritePrecondition;
}

interface WriteBatchRequest {
  readonly tenantId: string;
  readonly alias: string;
  readonly entries: readonly GovernanceWriteBatchEntry[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Digerir antes de comparar: tiempo constante, y una longitud distinta no revienta ni se filtra. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function authorized(header: unknown, expected: string): boolean {
  const authorization = typeof header === 'string' ? header : undefined;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(authorization.slice(7)), digest(expected));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * El cuerpo, o `undefined` si se pasó del tope. Quien mande un volcado no consigue que el relay lo
 * guarde entero antes de rechazarlo.
 */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        // Se deja de ACUMULAR, pero se sigue drenando. Cortar el socket a media petición le llega
        // al que llama como una conexión caída, y entonces el 413 —que es la explicación de por qué
        // no se le contestó— no lo lee nadie. Lo que queda acotado aquí es la MEMORIA, no la
        // transferencia: de quién puede siquiera abrir esta conexión ya se ocupa el TLS mutuo.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      if (!overflowed) chunks.push(chunk);
    });
    request.on('end', () => resolve(overflowed ? undefined : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** El pedido, o el motivo del rechazo. Falla cerrado: un campo que no cuadra no se corrige, se rechaza. */
export function parseReadRequest(raw: string): ReadRequest | { readonly rejected: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: 'el cuerpo no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rejected: 'el cuerpo tiene que ser un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const tenantId = source.tenant_id;
  const alias = source.alias;
  const path = source.path;
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > MAX_TENANT_LENGTH) {
    return { rejected: 'tenant_id es obligatorio' };
  }
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    return { rejected: 'alias no tiene forma de alias' };
  }
  // La ruta se valida sólo en lo que hace falta para no romper el cable; QUÉ ruta es aceptable lo
  // deciden el gateway y el pty-agent, cada uno con su lista y sus hechos.
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LENGTH || path.includes('\0')) {
    return { rejected: 'path tiene que ser una ruta absoluta sin bytes nulos' };
  }
  return { tenantId, alias, path };
}

/** El endpoint de índice usa la misma identidad, pero exige un objeto y una ruta canónicos. */
export function parseDirectoryRequest(raw: string): DirectoryRequest | { readonly rejected: string } {
  const common = parseReadRequest(raw);
  if ('rejected' in common) return common;
  const source = JSON.parse(raw) as Record<string, unknown>;
  const expected = ['alias', 'path', 'tenant_id'];
  const actual = Object.keys(source).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return { rejected: 'el cuerpo trae campos que este protocolo no conoce' };
  }
  const segments = common.path.split('/');
  if (common.path === '/' || hasControlCharacter(common.path)
      || segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { rejected: 'path tiene que ser una ruta absoluta canónica' };
  }
  return common;
}

/** Escritura cerrada: no hay una forma implícita que pueda significar create o replace según el disco. */
export function parseWriteRequest(raw: string): WriteRequest | { readonly rejected: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: 'el cuerpo no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rejected: 'el cuerpo tiene que ser un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const allowed = new Set(['tenant_id', 'alias', 'path', 'content_base64', 'precondition']);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    return { rejected: 'el cuerpo trae campos que este protocolo no conoce' };
  }
  const common = parseReadRequest(JSON.stringify({
    tenant_id: source.tenant_id, alias: source.alias, path: source.path,
  }));
  if ('rejected' in common) return common;

  const encoded = source.content_base64;
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return { rejected: 'content_base64 no es base64 canónico' };
  }
  const content = Buffer.from(encoded, 'base64');
  if (content.toString('base64') !== encoded) return { rejected: 'content_base64 no es base64 canónico' };
  if (content.byteLength > MAX_GOVERNANCE_BYTES) return { rejected: 'el contenido se pasa del tope' };

  const precondition = source.precondition;
  if (precondition === null || typeof precondition !== 'object' || Array.isArray(precondition)) {
    return { rejected: 'precondition es obligatoria' };
  }
  const record = precondition as Record<string, unknown>;
  if (record.state === 'absent' && Object.keys(record).length === 1) {
    return { ...common, content, precondition: { state: 'absent' } };
  }
  if (record.state === 'present' && Object.keys(record).length === 2
    && typeof record.sha256 === 'string' && SHA256_PATTERN.test(record.sha256)) {
    return { ...common, content, precondition: { state: 'present', sha256: record.sha256 } };
  }
  return { rejected: 'precondition debe ser absent o present con SHA-256 minúscula' };
}

/** Lote cerrado: cada entrada declara si escribe o sólo verifica, nunca se infiere por su forma. */
export function parseWriteBatchRequest(raw: string): WriteBatchRequest | { readonly rejected: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: 'el cuerpo no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rejected: 'el cuerpo tiene que ser un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const allowed = new Set(['tenant_id', 'alias', 'files']);
  if (Object.keys(source).some((key) => !allowed.has(key))
    || !Array.isArray(source.files) || source.files.length < 1 || source.files.length > 7) {
    return { rejected: 'el lote debe traer entre uno y siete ficheros y ningún campo desconocido' };
  }

  const entries: GovernanceWriteBatchEntry[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const rawEntry of source.files) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { rejected: 'cada fichero del lote tiene que ser un objeto' };
    }
    const entry = rawEntry as Record<string, unknown>;
    const mode = entry.mode;
    const entryAllowed = mode === 'write'
      ? new Set(['mode', 'path', 'content_base64', 'precondition'])
      : mode === 'verify'
        ? new Set(['mode', 'path', 'precondition'])
        : undefined;
    if (entryAllowed === undefined || Object.keys(entry).some((key) => !entryAllowed.has(key))) {
      return { rejected: 'cada fichero debe declarar mode write o verify y su forma exacta' };
    }
    const common = parseReadRequest(JSON.stringify({
      tenant_id: source.tenant_id, alias: source.alias, path: entry.path,
    }));
    if ('rejected' in common) return common;
    if (paths.has(common.path)) return { rejected: 'el lote repite una ruta' };
    paths.add(common.path);

    const precondition = entry.precondition;
    if (precondition === null || typeof precondition !== 'object' || Array.isArray(precondition)) {
      return { rejected: 'precondition es obligatoria en cada fichero' };
    }
    const record = precondition as Record<string, unknown>;
    const parsedPrecondition: GovernanceWritePrecondition | undefined =
      record.state === 'absent' && Object.keys(record).length === 1
        ? { state: 'absent' }
        : record.state === 'present' && Object.keys(record).length === 2
          && typeof record.sha256 === 'string' && SHA256_PATTERN.test(record.sha256)
          ? { state: 'present', sha256: record.sha256 }
          : undefined;
    if (parsedPrecondition === undefined) {
      return { rejected: 'precondition debe ser absent o present con SHA-256 minúscula' };
    }
    if (mode === 'verify') {
      entries.push({ mode, path: common.path, precondition: parsedPrecondition });
      continue;
    }

    const encoded = entry.content_base64;
    if (typeof encoded !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return { rejected: 'content_base64 no es base64 canónico' };
    }
    const content = Buffer.from(encoded, 'base64');
    if (content.toString('base64') !== encoded) return { rejected: 'content_base64 no es base64 canónico' };
    totalBytes += content.byteLength;
    if (totalBytes > MAX_GOVERNANCE_BYTES) return { rejected: 'el contenido total se pasa del tope' };
    entries.push({ mode: 'write', path: common.path, content, precondition: parsedPrecondition });
  }

  const first = entries[0];
  if (first === undefined) return { rejected: 'el lote está vacío' };
  const common = parseReadRequest(JSON.stringify({
    tenant_id: source.tenant_id, alias: source.alias, path: first.path,
  }));
  if ('rejected' in common) return common;
  return { tenantId: common.tenantId, alias: common.alias, entries };
}

/** `body` es `unknown` y no un registro: lo que se sirve son tipos cerrados (`FileReadOutcome`). */
function send(response: ServerResponse, status: number, body?: unknown): void {
  if (response.writableEnded) return;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-length': payload?.byteLength ?? 0,
    'cache-control': 'no-store',
    ...(payload === undefined ? {} : { 'content-type': 'application/json' })
  });
  response.end(payload);
}

async function handle(
  options: GovernanceRelayOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const path = (request.url ?? '/').split('?', 1)[0];
  const operation = path === GOVERNANCE_READ_PATH
    ? 'read'
    : path === GOVERNANCE_LIST_PATH
      ? 'list'
    : path === GOVERNANCE_WRITE_PATH
      ? 'write'
      : path === GOVERNANCE_WRITE_BATCH_PATH
        ? 'write_batch'
        : undefined;
  if (operation === undefined) {
    request.resume();
    send(response, 404, { error: 'not_found' });
    return;
  }
  if (request.method !== 'POST') {
    request.resume();
    response.setHeader('allow', 'POST');
    send(response, 405, { error: 'method_not_allowed' });
    return;
  }

  let expected: string;
  try {
    expected = await options.token();
  } catch (error) {
    // Sin token no se puede autenticar a nadie, y dejar pasar sería justo lo contrario de fallar
    // cerrado. Es un fallo del relay, no del que llama: 503, no 401.
    logEvent('terminal_relay_governance_token_unreadable', { operation, error: errorLabel(error) });
    request.resume();
    send(response, 503, { error: 'unavailable' });
    return;
  }
  if (!authorized(request.headers.authorization, expected)) {
    // Cuerpo vacío a propósito, igual que en las rutas de relay del gateway: quien no se autentica
    // no aprende nada del plano. Y el cuerpo ni se lee: un no autenticado no mueve al pty-agent.
    logEvent('terminal_relay_governance_rejected', { operation, reason: 'bad_token' });
    request.resume();
    send(response, 401);
    return;
  }

  let raw: string | undefined;
  try {
    raw = await readBody(request);
  } catch (error) {
    logEvent('terminal_relay_governance_rejected', { operation, reason: 'body_error', error: errorLabel(error) });
    send(response, 400, { error: 'invalid_request', reason: 'no se pudo leer el cuerpo' });
    return;
  }
  if (raw === undefined) {
    send(response, 413, { error: 'invalid_request', reason: 'el cuerpo se pasa del tope' });
    return;
  }
  if (operation === 'read') {
    const parsed = parseReadRequest(raw);
    if ('rejected' in parsed) {
      logEvent('terminal_relay_governance_rejected', { operation, reason: 'invalid_request' });
      send(response, 400, { error: 'invalid_request', reason: parsed.rejected });
      return;
    }
    await serveRead(options, parsed, request, response);
    return;
  }

  if (operation === 'list') {
    const parsed = parseDirectoryRequest(raw);
    if ('rejected' in parsed) {
      logEvent('terminal_relay_governance_rejected', { operation, reason: 'invalid_request' });
      send(response, 400, { error: 'invalid_request', reason: parsed.rejected });
      return;
    }
    await serveDirectory(options, parsed, request, response);
    return;
  }

  if (operation === 'write') {
    const parsed = parseWriteRequest(raw);
    if ('rejected' in parsed) {
      logEvent('terminal_relay_governance_rejected', { operation, reason: 'invalid_request' });
      send(response, 400, { error: 'invalid_request', reason: parsed.rejected });
      return;
    }
    await serveWrite(options, parsed, response);
    return;
  }

  const parsed = parseWriteBatchRequest(raw);
  if ('rejected' in parsed) {
    logEvent('terminal_relay_governance_rejected', { operation, reason: 'invalid_request' });
    send(response, 400, { error: 'invalid_request', reason: parsed.rejected });
    return;
  }
  await serveWriteBatch(options, parsed, response);
}

function logOutcome(
  operation: 'read' | 'write',
  parsed: ReadRequest,
  outcome: FileReadOutcome | FileWriteOutcome,
): void {
  const failed = 'error' in outcome;
  // Nunca el contenido: el tamaño y el veredicto bastan para diagnosticar, y el manual de un alias
  // es suyo. Lo mismo vale para el resto de este fichero.
  logEvent('terminal_relay_governance_served', {
    operation,
    tenant_id: parsed.tenantId,
    alias: parsed.alias,
    path: parsed.path,
    error: failed ? outcome.error : null,
    bytes: 'bytes' in outcome ? outcome.bytes : null,
  });
}

function offlineOutcome(operation: 'read' | 'write', parsed: ReadRequest, response: ServerResponse): void {
  // 200 con un fallo de DOMINIO, no 404: la llamada llegó y se contestó. Que el alias no tenga
  // pty-agent conectado es un hecho del alias y no un fallo del transporte HTTP.
  const outcome: FileReadOutcome | FileWriteOutcome = {
    error: 'unavailable',
    reason: 'no hay ningún pty-agent conectado para ese alias',
  };
  logOutcome(operation, parsed, outcome);
  send(response, 200, outcome);
}

async function serveRead(
  options: GovernanceRelayOptions,
  parsed: ReadRequest,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const connection = options.agents.lookup(parsed.tenantId, parsed.alias);
  if (!connection) {
    offlineOutcome('read', parsed, response);
    return;
  }
  const abort = new AbortController();
  const abortOnClose = (): void => {
    if (!response.writableEnded) abort.abort();
  };
  request.once('aborted', abortOnClose);
  response.once('close', abortOnClose);
  const outcome = await requestFileRead(
    connection, parsed.tenantId, parsed.alias, parsed.path, options.timeoutMs, abort.signal,
  );
  request.off('aborted', abortOnClose);
  response.off('close', abortOnClose);
  logOutcome('read', parsed, outcome);
  send(response, 200, outcome);
}

function logDirectoryOutcome(parsed: DirectoryRequest, outcome: DirectoryReadOutcome): void {
  const failed = 'error' in outcome;
  // Sólo conteos: los nombres de memoria también pueden ser sensibles y no pertenecen al log.
  logEvent('terminal_relay_governance_served', {
    operation: 'list',
    tenant_id: parsed.tenantId,
    alias: parsed.alias,
    error: failed ? outcome.error : null,
    entries: failed ? null : outcome.entries.length,
    total: failed ? null : outcome.total,
    observed_at_least: failed ? null : outcome.observed_at_least,
    truncated: failed ? null : outcome.truncated,
  });
}

async function serveDirectory(
  options: GovernanceRelayOptions,
  parsed: DirectoryRequest,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const connection = options.agents.lookup(parsed.tenantId, parsed.alias);
  if (!connection) {
    const outcome: DirectoryReadOutcome = {
      error: 'unavailable', reason: 'no hay ningún pty-agent conectado para ese alias',
    };
    logDirectoryOutcome(parsed, outcome);
    send(response, 200, outcome);
    return;
  }
  const abort = new AbortController();
  const abortOnClose = (): void => {
    if (!response.writableEnded) abort.abort();
  };
  request.once('aborted', abortOnClose);
  response.once('close', abortOnClose);
  const outcome = await requestDirectoryRead(
    connection, parsed.tenantId, parsed.alias, parsed.path, options.timeoutMs, abort.signal,
  );
  request.off('aborted', abortOnClose);
  response.off('close', abortOnClose);
  logDirectoryOutcome(parsed, outcome);
  send(response, 200, outcome);
}

async function serveWrite(
  options: GovernanceRelayOptions,
  parsed: WriteRequest,
  response: ServerResponse,
): Promise<void> {
  const connection = options.agents.lookup(parsed.tenantId, parsed.alias);
  if (!connection) {
    offlineOutcome('write', parsed, response);
    return;
  }
  const abort = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) abort.abort();
  });
  const outcome = await requestFileWrite(
    connection,
    parsed.tenantId,
    parsed.alias,
    parsed.path,
    parsed.content,
    parsed.precondition,
    options.timeoutMs,
    abort.signal,
  );
  logOutcome('write', parsed, outcome);
  send(response, 200, outcome);
}

function logBatchOutcome(parsed: WriteBatchRequest, outcome: GovernanceWriteBatchOutcome): void {
  const failed = 'error' in outcome;
  logEvent('terminal_relay_governance_served', {
    operation: 'write_batch',
    tenant_id: parsed.tenantId,
    alias: parsed.alias,
    files: parsed.entries.length,
    error: failed ? outcome.error : null,
    bytes: failed ? null : outcome.files.reduce((total, file) => total + file.bytes, 0),
  });
}

async function serveWriteBatch(
  options: GovernanceRelayOptions,
  parsed: WriteBatchRequest,
  response: ServerResponse,
): Promise<void> {
  const connection = options.agents.lookup(parsed.tenantId, parsed.alias);
  if (!connection) {
    const outcome: GovernanceWriteBatchOutcome = {
      error: 'unavailable', reason: 'no hay ningún pty-agent conectado para ese alias',
    };
    logBatchOutcome(parsed, outcome);
    send(response, 200, outcome);
    return;
  }
  const abort = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) abort.abort();
  });
  const outcome = await requestFileWriteBatch(
    connection, parsed.tenantId, parsed.alias, parsed.entries, options.timeoutMs, abort.signal,
  );
  logBatchOutcome(parsed, outcome);
  send(response, 200, outcome);
}

/**
 * Engancha lectura y escritura de gobierno al servidor mTLS del lado navegador.
 *
 * No recibe el cliente del gateway a propósito: la decisión de si esta lectura vale ya la tomó el
 * gateway antes de llamar, así que preguntársela de vuelta sería un viaje de ida y vuelta que no
 * cambia ningún resultado. Lo único que hace falta saber es que quien llama es él, y eso es el token.
 */
export function setupGovernanceRelay(options: GovernanceRelayOptions): void {
  options.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    handle(options, request, response).catch((error: unknown) => {
      // Una operación rota no puede tumbar el proceso y con él todas las terminales abiertas.
      logEvent('terminal_relay_governance_failed', { error: errorLabel(error) });
      send(response, 500, { error: 'unknown', reason: 'la operación de gobierno falló en el relay' });
    });
  });
}
