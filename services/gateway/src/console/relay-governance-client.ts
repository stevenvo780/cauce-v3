import { request as httpsRequest, type RequestOptions } from 'node:https';
import type {
  GovernanceRelayClient, GovernanceWriteError, RelayDirectoryRead, RelayFileRead, RelayFileWrite,
  RelayFileWriteBatch,
} from './agent-documents.js';
import type {
  GovernanceBatchWrite, GovernanceReadError, GovernanceWritePrecondition,
} from './agent-documents.routes.js';

/**
 * `GovernanceRelayClient` de verdad: habla con `POST /v3/terminal/relay/read` del terminal-relay.
 *
 * Copia el patrón de `HttpsTerminalGatewayClient` (el cliente que el relay usa contra el gateway)
 * porque es el mismo problema en el sentido contrario: dos procesos en dos máquinas, unidos por un
 * token compartido, con TLS mutuo por debajo. Aquí el que presenta el token es el gateway.
 *
 * NUNCA lanza por un fallo de red. Un relay caído tiene que verse en el modal como «no se pudo
 * leer», con el motivo, y no como una pantalla en blanco ni como un 500 del gateway.
 */

/**
 * Tope de lo que se acumula de la respuesta. El relay sirve hasta 256 KB de contenido, y el JSON
 * que lo envuelve lo infla (`\n` y los acentos van escapados), así que el doble es el margen que
 * hace falta para no cortar una lectura legítima.
 */
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * Por encima de lo que el relay tarda en rendirse. El relay corta su propia lectura a los 5 s: si
 * el gateway cortara antes, se perdería la respuesta HONESTA (`timeout` con su motivo) y se
 * cambiaría por un fallo de transporte que no dice nada de qué pasó dentro del contenedor.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

const READ_CODES: readonly GovernanceReadError['error'][] = [
  'not_found', 'permission_denied', 'invalid_path', 'symlink_detected',
  'too_large', 'timeout', 'cancelled', 'busy', 'unavailable', 'unknown'
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_PATH_BYTES = 4_096;
const MAX_DATE_BYTES = 64;
const MAX_REASON_BYTES = 2_048;
const DIRECTORY_KEYS = ['entries', 'observed_at_least', 'path', 'total', 'truncated'];
const DIRECTORY_ENTRY_KEYS = ['bytes', 'modified_at', 'path'];
const SENSITIVE_BASENAMES = new Set([
  '.credentials.json', 'auth.json', '.claude.json', 'openclaw.json', '.env', '.netrc',
  'id_ed25519', 'id_rsa', 'known_hosts', 'authorized_keys',
]);
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

export interface HttpGovernanceRelayClientOptions {
  /** Origen HTTPS del lado navegador del relay, p. ej. `https://terminal-relay:8446`. */
  readonly relayUrl: string;
  /** El token compartido, ya en memoria: es el mismo `relayToken` de `TerminalConfig`. */
  readonly token: string;
  readonly timeoutMs?: number;
  /** CA del certificado de servidor del relay, si lo firma una CA privada. */
  readonly ca?: Buffer;
  /**
   * Identidad de cliente. NO es opcional en la práctica: el listener del relay se levanta con
   * `requestCert`/`rejectUnauthorized`, así que sin certificado firmado por la CA de la consola el
   * handshake muere antes de que el token llegue a leerse. Se deja opcional en el tipo para que un
   * despliegue mal configurado dé un fallo de lectura explicado, y no un fallo al arrancar.
   */
  readonly clientCert?: Buffer;
  readonly clientKey?: Buffer;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
  /** El relay se pasó del tope y se cortó la respuesta a medias. */
  readonly overflowed: boolean;
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function exactKeys(source: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(source).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/')
      || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES || hasControlCharacter(value)) return false;
  return !value.split('/').slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function strictDescendant(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}/`);
}

function sensitivePath(path: string): boolean {
  return path.split('/').some((segment) => SENSITIVE_BASENAMES.has(segment)
    || SENSITIVE_SUFFIXES.some((suffix) => segment.endsWith(suffix)));
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DATE_BYTES) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const date = new Date(value);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

/** Un código que no reconocemos es `unknown`, nunca se propaga tal cual. */
function normalizeCode(value: string): GovernanceReadError['error'] {
  return READ_CODES.includes(value as GovernanceReadError['error'])
    ? (value as GovernanceReadError['error'])
    : 'unknown';
}

/**
 * Lo que el relay contestó, ya entendido. Una respuesta que no se entiende del todo NO se completa
 * con valores por defecto: se devuelve como fallo. Rellenar huecos aquí sería inventar el contenido
 * o el tamaño de un fichero que nadie leyó.
 */
export function parseReadOutcome(body: string): RelayFileRead | GovernanceReadError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'unknown', reason: 'el terminal-relay contestó algo que no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unknown', reason: 'el terminal-relay contestó algo que no es un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const failure = stringField(source, 'error');
  if (failure !== undefined) {
    return {
      error: normalizeCode(failure),
      reason: stringField(source, 'reason') ?? 'el terminal-relay no explicó el fallo'
    };
  }

  const path = stringField(source, 'path');
  const modifiedAt = stringField(source, 'modified_at');
  const content = stringField(source, 'content');
  const sha = stringField(source, 'sha');
  const bytes = source.bytes;
  const truncated = source.truncated;
  if (path === undefined || modifiedAt === undefined || content === undefined || sha === undefined) {
    return { error: 'unknown', reason: 'la lectura vino sin ruta, fecha, contenido o huella SHA-256' };
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return { error: 'unknown', reason: 'la lectura vino sin un tamaño creíble' };
  }
  if (typeof truncated !== 'boolean') {
    return { error: 'unknown', reason: 'la lectura no dice si viene recortada' };
  }
  if (!SHA256_PATTERN.test(sha)) {
    return { error: 'unknown', reason: 'la lectura no trae una huella SHA-256 válida' };
  }
  return { path, bytes, truncated, modified_at: modifiedAt, sha, content };
}

/** Valida de nuevo el índice aunque el relay ya lo validó: son dos procesos y dos fronteras. */
export function parseDirectoryOutcome(body: string): RelayDirectoryRead | GovernanceReadError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'unknown', reason: 'el terminal-relay contestó un índice que no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unknown', reason: 'el terminal-relay contestó un índice que no es un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  if ('error' in source) {
    if (!exactKeys(source, ['error', 'reason']) || typeof source.error !== 'string'
        || typeof source.reason !== 'string' || source.reason.length === 0
        || Buffer.byteLength(source.reason, 'utf8') > MAX_REASON_BYTES
        || hasControlCharacter(source.reason)) {
      return { error: 'unknown', reason: 'el terminal-relay contestó un fallo de índice inválido' };
    }
    return { error: normalizeCode(source.error), reason: source.reason };
  }
  if (!exactKeys(source, DIRECTORY_KEYS) || !canonicalAbsolutePath(source.path)
      || (source.total !== null && (!Number.isSafeInteger(source.total) || (source.total as number) < 0))
      || !Number.isSafeInteger(source.observed_at_least) || (source.observed_at_least as number) < 0
      || typeof source.truncated !== 'boolean' || !Array.isArray(source.entries)
      || source.entries.length > MAX_DIRECTORY_ENTRIES
      || (source.observed_at_least as number) < source.entries.length
      || (source.total !== null && source.total !== source.observed_at_least)
      || (source.total === null && !source.truncated)
      || (!source.truncated && (source.total !== source.entries.length
        || source.observed_at_least !== source.entries.length))) {
    return { error: 'unknown', reason: 'el terminal-relay contestó un índice con raíz, límites o conteos inválidos' };
  }

  const root = source.path;
  const paths = new Set<string>();
  const entries: Array<RelayDirectoryRead['entries'][number]> = [];
  for (const rawEntry of source.entries) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { error: 'unknown', reason: 'el índice contiene una entrada inválida' };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry.symlink === true || entry.type === 'symlink') {
      return { error: 'symlink_detected', reason: 'el índice intentó publicar un enlace simbólico' };
    }
    if (!exactKeys(entry, DIRECTORY_ENTRY_KEYS) || !canonicalAbsolutePath(entry.path)
        || !strictDescendant(root, entry.path) || paths.has(entry.path)
        || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0
        || !validIsoDate(entry.modified_at)) {
      return { error: 'unknown', reason: 'el índice contiene una ruta, fecha o tamaño inválidos' };
    }
    if (sensitivePath(entry.path)) {
      return { error: 'permission_denied', reason: 'el índice intentó publicar metadata de credenciales' };
    }
    paths.add(entry.path);
    entries.push({
      path: entry.path,
      bytes: entry.bytes as number,
      modified_at: entry.modified_at,
    });
  }
  return {
    path: root,
    total: source.total as number | null,
    observed_at_least: source.observed_at_least as number,
    truncated: source.truncated,
    entries,
  };
}

/**
 * Un ACK de escritura no se completa con valores del pedido. El relay tiene que devolver las
 * cuatro pruebas que recibió del agente: ruta, operación, SHA y bytes. `TerminalRelayFactsProbe`
 * las vuelve a contrastar con el contenido solicitado; esta primera puerta impide que un 200
 * vacío o una forma legacy parezcan un ACK.
 */
export function parseWriteOutcome(body: string): RelayFileWrite | GovernanceWriteError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'unknown', reason: 'el terminal-relay contestó algo que no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unknown', reason: 'el terminal-relay contestó algo que no es un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const failure = stringField(source, 'error');
  if (failure !== undefined) {
    if (failure === 'conflict') {
      return { error: 'conflict', reason: stringField(source, 'reason') ?? 'la precondición no se cumplió' };
    }
    return {
      error: normalizeCode(failure),
      reason: stringField(source, 'reason') ?? 'el terminal-relay no explicó el fallo',
    };
  }

  const path = stringField(source, 'path');
  const operation = stringField(source, 'operation');
  const sha = stringField(source, 'sha');
  const bytes = source.bytes;
  if (path === undefined || (operation !== 'replace' && operation !== 'create')) {
    return { error: 'unknown', reason: 'el ACK de escritura vino sin ruta u operación válida' };
  }
  if (sha === undefined || !SHA256_PATTERN.test(sha)) {
    return { error: 'unknown', reason: 'el ACK de escritura vino sin una huella SHA-256 válida' };
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return { error: 'unknown', reason: 'el ACK de escritura vino sin un tamaño creíble' };
  }
  return { path, operation, sha, bytes };
}

/** El lote sólo existe si TODOS sus ACK individuales tienen forma completa y rutas únicas. */
export function parseWriteBatchOutcome(body: string): RelayFileWriteBatch | GovernanceWriteError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'unknown', reason: 'el terminal-relay contestó un lote que no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unknown', reason: 'el terminal-relay contestó un lote que no es un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const failure = stringField(source, 'error');
  if (failure !== undefined) {
    if (failure === 'conflict') {
      return { error: 'conflict', reason: stringField(source, 'reason') ?? 'el lote entró en conflicto' };
    }
    return {
      error: normalizeCode(failure),
      reason: stringField(source, 'reason') ?? 'el terminal-relay no explicó el fallo del lote',
    };
  }
  if (!Array.isArray(source.files) || source.files.length === 0 || source.files.length > 7) {
    return { error: 'unknown', reason: 'el ACK del lote no trae una lista acotada de ficheros' };
  }
  const files: RelayFileWriteBatch['files'][number][] = [];
  const paths = new Set<string>();
  for (const raw of source.files) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'unknown', reason: 'el ACK del lote contiene un fichero inválido o repetido' };
    }
    const record = raw as Record<string, unknown>;
    const path = stringField(record, 'path');
    const operation = stringField(record, 'operation');
    const bytes = record.bytes;
    const rawSha: unknown = record.sha;
    const sha = rawSha === null ? null : typeof rawSha === 'string' ? rawSha : undefined;
    if (path === undefined || paths.has(path)
      || (operation !== 'create' && operation !== 'replace'
        && operation !== 'unchanged' && operation !== 'absent')
      || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0
      || sha === undefined || (sha !== null && !SHA256_PATTERN.test(sha))
      || (operation === 'absent' && (sha !== null || bytes !== 0))
      || (operation !== 'absent' && sha === null)) {
      return { error: 'unknown', reason: 'el ACK del lote contiene un fichero inválido o repetido' };
    }
    paths.add(path);
    files.push({ path, operation, sha, bytes });
  }
  return { files };
}

export class HttpGovernanceRelayClient implements GovernanceRelayClient {
  private readonly relayUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly ca: Buffer | undefined;
  private readonly clientCert: Buffer | undefined;
  private readonly clientKey: Buffer | undefined;

  constructor(options: HttpGovernanceRelayClientOptions) {
    this.relayUrl = options.relayUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ca = options.ca;
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
  }

  async readFile(
    tenantId: string,
    alias: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RelayFileRead | GovernanceReadError> {
    let result: HttpResult;
    try {
      result = await this.send('/v3/terminal/relay/read', { tenant_id: tenantId, alias, path }, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sin detalle';
      // El vencimiento se distingue del resto porque significa otra cosa para quien mira el modal:
      // el relay puede estar vivo y ser el agente el que no contesta.
      if (signal?.aborted) {
        return { error: 'cancelled', reason: 'se cerró la petición antes de terminar la lectura' };
      }
      const timedOut = message.includes('timed out');
      return {
        error: timedOut ? 'timeout' : 'unavailable',
        reason: `no se pudo hablar con el terminal-relay: ${message}`
      };
    }
    if (result.overflowed) {
      return { error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta' };
    }
    if (result.status === 401 || result.status === 403) {
      return { error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway' };
    }
    if (result.status !== 200) {
      return { error: 'unavailable', reason: `el terminal-relay contestó ${result.status}` };
    }
    return parseReadOutcome(result.body);
  }

  async listDirectory(
    tenantId: string,
    alias: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RelayDirectoryRead | GovernanceReadError> {
    let result: HttpResult;
    try {
      result = await this.send('/v3/terminal/relay/list', { tenant_id: tenantId, alias, path }, signal);
    } catch (error) {
      if (signal?.aborted) {
        return { error: 'cancelled', reason: 'se cerró la petición antes de terminar el índice' };
      }
      const message = error instanceof Error ? error.message : 'sin detalle';
      return {
        error: message.includes('timed out') ? 'timeout' : 'unavailable',
        reason: `no se pudo hablar con el terminal-relay: ${message}`,
      };
    }
    if (result.overflowed) {
      return { error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta' };
    }
    if (result.status === 401 || result.status === 403) {
      return { error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway' };
    }
    if (result.status !== 200) {
      return { error: 'unavailable', reason: `el terminal-relay contestó ${result.status}` };
    }
    return parseDirectoryOutcome(result.body);
  }

  async writeFile(
    tenantId: string,
    alias: string,
    path: string,
    content: string,
    precondition: GovernanceWritePrecondition,
  ): Promise<RelayFileWrite | GovernanceWriteError> {
    let result: HttpResult;
    try {
      result = await this.send('/v3/terminal/relay/write', {
        tenant_id: tenantId,
        alias,
        path,
        content_base64: Buffer.from(content, 'utf8').toString('base64'),
        precondition,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sin detalle';
      return {
        error: message.includes('timed out') ? 'timeout' : 'unavailable',
        reason: `no se pudo hablar con el terminal-relay: ${message}`,
      };
    }
    if (result.overflowed) {
      return { error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta' };
    }
    if (result.status === 401 || result.status === 403) {
      return { error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway' };
    }
    if (result.status !== 200) {
      return { error: 'unavailable', reason: `el terminal-relay contestó ${result.status}` };
    }
    return parseWriteOutcome(result.body);
  }

  async writeFiles(
    tenantId: string,
    alias: string,
    writes: readonly GovernanceBatchWrite[],
  ): Promise<RelayFileWriteBatch | GovernanceWriteError> {
    let result: HttpResult;
    try {
      result = await this.send('/v3/terminal/relay/write-batch', {
        tenant_id: tenantId,
        alias,
        files: writes.map((write) => ({
          mode: write.mode,
          path: write.path,
          ...(write.mode === 'write'
            ? { content_base64: Buffer.from(write.content, 'utf8').toString('base64') }
            : {}),
          precondition: write.precondition,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sin detalle';
      return {
        error: message.includes('timed out') ? 'timeout' : 'unavailable',
        reason: `no se pudo hablar con el terminal-relay: ${message}`,
      };
    }
    if (result.overflowed) {
      return { error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta' };
    }
    if (result.status === 401 || result.status === 403) {
      return { error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway' };
    }
    if (result.status !== 200) {
      return { error: 'unavailable', reason: `el terminal-relay contestó ${result.status}` };
    }
    return parseWriteBatchOutcome(result.body);
  }

  private async send(
    route: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const url = new URL(route, this.relayUrl);
    const options: RequestOptions = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': payload.byteLength
      },
      ...(this.ca === undefined ? {} : { ca: this.ca }),
      ...(this.clientCert === undefined || this.clientKey === undefined
        ? {}
        : { cert: this.clientCert, key: this.clientKey }),
      ...(signal === undefined ? {} : { signal }),
    };
    return new Promise<HttpResult>((resolve, reject) => {
      const request = httpsRequest(url, options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflowed = false;
        response.on('data', (chunk: Buffer) => {
          if (overflowed) return;
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            // Se corta la descarga en cuanto se pasa: acumular el resto sólo serviría para gastar
            // la memoria del gateway en algo que ya se va a rechazar.
            overflowed = true;
            response.destroy();
            resolve({ status: response.statusCode ?? 0, body: '', overflowed: true });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (overflowed) return;
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), overflowed: false });
        });
        response.on('error', reject);
      });
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('terminal relay request timed out'));
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
  }
}
