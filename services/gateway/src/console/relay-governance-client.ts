import { request as httpsRequest, type RequestOptions } from 'node:https';
import { hasUnsafeTextCodePoint, isStrictUtcIso8601 } from '@cauce/protocol';
import type {
  GovernanceRelayClient, GovernanceWriteError, RelayDirectoryRead, RelayFileRead, RelayFileWrite,
  RelayFileWriteBatch,
} from './agent-documents.js';
import type {
  GovernanceBatchWrite, GovernanceReadError, GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import { hasNeverServePathSegment } from './agent-documents/catalog.js';

/**
 * HTTP client for communication with the terminal-relay governance read/write endpoint.
 * Transmits requests authenticated via shared token and mutual TLS.
 */

/** Limit on accumulated bytes of the HTTP response. */
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Default timeout for requests to the terminal-relay. */
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
export interface HttpGovernanceRelayClientOptions {
  /** Browser-side HTTPS origin of the relay, e.g. `https://terminal-relay:8446`. */
  readonly relayUrl: string;
  /** The shared token, already in memory: it is the same `relayToken` from `TerminalConfig`. */
  readonly token: string;
  readonly timeoutMs?: number;
  /** CA of the relay's server certificate, if it is signed by a private CA. */
  readonly ca?: Buffer;
  /** Client certificate and key for mTLS authentication against the relay. */
  readonly clientCert?: Buffer;
  readonly clientKey?: Buffer;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
  /** The relay exceeded the cap and the response was cut off mid-stream. */
  readonly overflowed: boolean;
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
}

function exactKeys(source: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(source).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/')
      || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES || hasUnsafeTextCodePoint(value)) return false;
  return !value.split('/').slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function strictDescendant(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}/`);
}

type ParsedRelayObject =
  | { readonly ok: true; readonly source: Record<string, unknown> }
  | { readonly ok: false; readonly error: GovernanceReadError };

function parseRelayObject(
  body: string,
  invalidJsonReason: string,
  invalidObjectReason: string,
): ParsedRelayObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: { error: 'unknown', reason: invalidJsonReason } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: { error: 'unknown', reason: invalidObjectReason } };
  }
  return { ok: true, source: parsed as Record<string, unknown> };
}

/** A code we do not recognize is `unknown`, it is never propagated as-is. */
function normalizeCode(value: string): GovernanceReadError['error'] {
  return READ_CODES.includes(value as GovernanceReadError['error'])
    ? (value as GovernanceReadError['error'])
    : 'unknown';
}

/**
 * What the relay replied, already understood. A response that is not fully understood is NOT
 * completed with defaults: it is returned as a failure. Filling gaps here would be inventing the
 * content or the size of a file that nobody read.
 */
export function parseReadOutcome(body: string): RelayFileRead | GovernanceReadError {
  const parsed = parseRelayObject(
    body,
    'el terminal-relay contestó algo que no es JSON',
    'el terminal-relay contestó algo que no es un objeto',
  );
  if (!parsed.ok) return parsed.error;
  const { source } = parsed;
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

/** Re-validates the index even though the relay already did: two processes, two boundaries. */
export function parseDirectoryOutcome(body: string): RelayDirectoryRead | GovernanceReadError {
  const parsed = parseRelayObject(
    body,
    'el terminal-relay contestó un índice que no es JSON',
    'el terminal-relay contestó un índice que no es un objeto',
  );
  if (!parsed.ok) return parsed.error;
  const { source } = parsed;
  if ('error' in source) {
    if (!exactKeys(source, ['error', 'reason']) || typeof source.error !== 'string'
        || typeof source.reason !== 'string' || source.reason.length === 0
        || Buffer.byteLength(source.reason, 'utf8') > MAX_REASON_BYTES
        || hasUnsafeTextCodePoint(source.reason)) {
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
  const entries: RelayDirectoryRead['entries'][number][] = [];
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
        || !isStrictUtcIso8601(entry.modified_at, MAX_DATE_BYTES)) {
      return { error: 'unknown', reason: 'el índice contiene una ruta, fecha o tamaño inválidos' };
    }
    if (hasNeverServePathSegment(entry.path)) {
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
 * A write ACK is not completed with values from the request. The relay must return the four
 * pieces of evidence it received from the agent: path, operation, SHA, and bytes.
 * `TerminalRelayFactsProbe` re-checks them against the requested content; this first gate keeps
 * an empty 200 or a legacy shape from looking like an ACK.
 */
export function parseWriteOutcome(body: string): RelayFileWrite | GovernanceWriteError {
  const parsed = parseRelayObject(
    body,
    'el terminal-relay contestó algo que no es JSON',
    'el terminal-relay contestó algo que no es un objeto',
  );
  if (!parsed.ok) return parsed.error;
  const { source } = parsed;
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

/** The batch only exists if ALL its individual ACKs have complete shape and unique paths. */
export function parseWriteBatchOutcome(body: string): RelayFileWriteBatch | GovernanceWriteError {
  const parsed = parseRelayObject(
    body,
    'el terminal-relay contestó un lote que no es JSON',
    'el terminal-relay contestó un lote que no es un objeto',
  );
  if (!parsed.ok) return parsed.error;
  const { source } = parsed;
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

function relayCommunicationError(error: unknown): GovernanceReadError {
  const message = error instanceof Error ? error.message : 'sin detalle';
  return {
    error: message.includes('timed out') ? 'timeout' : 'unavailable',
    reason: `no se pudo hablar con el terminal-relay: ${message}`,
  };
}

function parseHttpResult<T>(result: HttpResult, parser: (body: string) => T): T | GovernanceReadError {
  if (result.overflowed) {
    return { error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta' };
  }
  if (result.status === 401 || result.status === 403) {
    return { error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway' };
  }
  if (result.status !== 200) {
    return { error: 'unavailable', reason: `el terminal-relay contestó ${String(result.status)}` };
  }
  return parser(result.body);
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
      // Expiry is distinguished from the rest because it means something different to whoever
      // is looking at the modal: the relay may be alive and it is the agent that is not responding.
      if (signal?.aborted) {
        return { error: 'cancelled', reason: 'se cerró la petición antes de terminar la lectura' };
      }
      return relayCommunicationError(error);
    }
    return parseHttpResult(result, parseReadOutcome);
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
      return relayCommunicationError(error);
    }
    return parseHttpResult(result, parseDirectoryOutcome);
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
      return relayCommunicationError(error);
    }
    return parseHttpResult(result, parseWriteOutcome);
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
      return relayCommunicationError(error);
    }
    return parseHttpResult(result, parseWriteBatchOutcome);
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
            // The download is cut off as soon as it crosses the cap: accumulating the rest would
            // only waste the gateway's memory on something that will be rejected anyway.
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
