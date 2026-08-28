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
 * `POST /v3/terminal/relay/read|write` — mTLS gates from the gateway to the governed disk.
 *
 * The missing link between the gateway and the pty-agent: `requestFileRead` could already talk
 * to the agent, but no one outside the process could call it. This exposes it, nothing more.
 *
 * What this module does NOT decide:
 *  - WHAT can be read. The path is resolved by the gateway from measured facts (`verifyReadablePath`)
 *    and the pty-agent re-validates it against its own whitelist before opening anything. The
 *    relay has none of the alias's facts, so it has nothing to opine on; if it opined with less
 *    information than the other two, it would be a third rule that contradicts the good ones.
 *  - WHO can request it. The gateway already settled that with the console principal. Here it is
 *    only checked that the caller IS the gateway.
 *
 * What it does decide, and why it lives here: that the call cannot harm the rest. Bounded body,
 * alias-shaped alias, and the read delegated to `requestFileRead`, which already cuts by time,
 * by bytes, and by an agent that does not advertise the capability.
 *
 * ABOUT THE TRANSPORT: this hooks into the browser-side HTTPS server that `createBrowserHttpsServer`
 * brings up with `requestCert`/`rejectUnauthorized` — so the peer has already presented a client
 * certificate signed by the console CA. The token is the SECOND barrier, not the only one.
 */

/** Read path. Lives outside `/v3/console/` for the same reason as the gateway's: it is not a browser. */
export const GOVERNANCE_READ_PATH = '/v3/terminal/relay/read';
export const GOVERNANCE_LIST_PATH = '/v3/terminal/relay/list';
export const GOVERNANCE_WRITE_PATH = '/v3/terminal/relay/write';
export const GOVERNANCE_WRITE_BATCH_PATH = '/v3/terminal/relay/write-batch';

/** 256 KiB base64 plus JSON. Nothing above this ceiling is accumulated. */
const MAX_REQUEST_BYTES = 512 * 1024;

/** Same alias shape the gateway requires when requesting a terminal session. */
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;

const MAX_TENANT_LENGTH = 64;
const MAX_PATH_LENGTH = 4096;

export interface GovernanceRelayOptions {
  /** The same browser-side server; a `request` listener is added to it, not a new one. */
  readonly server: HttpsServer;
  readonly agents: AgentLookup;
  /**
   * The token shared with the gateway. It is a function and not a string on purpose: the relay
   * already reads its token from disk on every outgoing call, so rotating it does not force a
   * restart here either.
   */
  readonly token: () => Promise<string>;
  /** Propagated to `requestFileRead`; its default (5 s) wins if nothing is passed. */
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

/** Digest before comparing: constant time, and a different length neither crashes nor leaks. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function authorized(header: unknown, expected: string): boolean {
  const authorization = typeof header === 'string' ? header : undefined;
  if (!authorization?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(authorization.slice(7)), digest(expected));
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * The body, or `undefined` if it overshot the ceiling. Whoever sends a dump will not get the
 * relay to store it whole before rejecting it.
 */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        // Stop ACCUMULATING, but keep draining. Cutting the socket mid-request shows up to the
        // caller as a dropped connection, and then the 413 —which is the explanation of why nobody
        // replied— is read by no one. What is bounded here is MEMORY, not the transfer: who can
        // even open this connection is already handled by mutual TLS.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      if (!overflowed) chunks.push(chunk);
    });
    request.on('end', () => { resolve(overflowed ? undefined : Buffer.concat(chunks).toString('utf8')); });
    request.on('error', reject);
  });
}

/** The request, or the rejection reason. Fail-closed: a field that does not match is not corrected, it is rejected. */
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
  // The path is validated only insofar as it is needed to keep the wire intact; WHICH path is
  // acceptable is decided by the gateway and the pty-agent, each with its own list and facts.
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LENGTH || path.includes('\0')) {
    return { rejected: 'path tiene que ser una ruta absoluta sin bytes nulos' };
  }
  return { tenantId, alias, path };
}

/** The index endpoint uses the same identity, but requires a canonical object and path. */
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

/** Closed write: there is no implicit shape that can mean create or replace depending on the disk. */
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

/** Closed batch: each entry declares whether it writes or only verifies, never inferred from its shape. */
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

/** `body` is `unknown` and not a record: what is served are closed types (`FileReadOutcome`). */
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
    // Without a token no one can be authenticated, and letting it through would be the opposite
    // of failing closed. This is a relay failure, not the caller's: 503, not 401.
    logEvent('terminal_relay_governance_token_unreadable', { operation, error: errorLabel(error) });
    request.resume();
    send(response, 503, { error: 'unavailable' });
    return;
  }
  if (!authorized(request.headers.authorization, expected)) {
    // Empty body on purpose, as in the gateway's relay routes: whoever does not authenticate learns
    // nothing from the wire, and the body is not even read (no auth → no pty-agent moved).
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
  // Never the content: size and verdict are enough to diagnose, and an alias's manual is its own.
  // The same applies to the rest of this file.
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
  // 200 with a DOMAIN failure, not 404: the call arrived and was answered. The alias not having
  // a pty-agent connected is a fact of the alias, not an HTTP transport failure.
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
  // Only counts: memory names can also be sensitive and do not belong in the log.
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
 * Hooks governance read and write onto the browser-side mTLS server.
 *
 * The gateway client is not received on purpose: that decision was already made before the call,
 * so asking back would be a no-op round trip. The only thing that needs to be known is that the
 * caller is the gateway, and that is the token.
 */
export function setupGovernanceRelay(options: GovernanceRelayOptions): void {
  options.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    handle(options, request, response).catch((error: unknown) => {
      // A broken operation must not take down the process and, with it, every open terminal.
      logEvent('terminal_relay_governance_failed', { error: errorLabel(error) });
      send(response, 500, { error: 'unknown', reason: 'la operación de gobierno falló en el relay' });
    });
  });
}
