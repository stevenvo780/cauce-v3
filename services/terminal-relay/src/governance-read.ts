import { createHash, randomUUID } from 'node:crypto';
import {
  hasGovernanceSensitivePathSegment, hasUnsafeTextCodePoint, isStrictUtcIso8601, logEvent
} from '@cauce/protocol';
import type { AgentConnection } from './agent-leg.js';
import { hasControlCharacter, integerField, stringField } from './validation.js';

/**
 * Reading of a governance file inside an alias's container.
 *
 * The relay transports the read in a bounded way in memory and time,
 * validating that the response matches the requested alias and path.
 */

/** Cap on what is accumulated in memory. Matches `MAX_DOCUMENT_BYTES` in the pty-agent. */
export const MAX_GOVERNANCE_BYTES = 256 * 1024;
/**
 * At 65,500 B per frame, 256 KB fit in 5. We allow 8 for slack: more announced frames than
 * that isn't a large document, it's an agent saying something that doesn't match its own cap.
 */
const MAX_GOVERNANCE_CHUNKS = 8;

export type GovernanceReadCode =
  | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
  | 'too_large' | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown';

const READ_CODES: readonly GovernanceReadCode[] = [
  'not_found', 'permission_denied', 'invalid_path', 'symlink_detected',
  'too_large', 'timeout', 'cancelled', 'busy', 'unavailable', 'unknown'
];

interface GovernanceFileRead {
  readonly path: string;
  /** REAL size of the file, even when `content` is truncated. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly modified_at: string;
  /** SHA-256 of the actual bytes; in older agents it is derived from the untruncated content. */
  readonly sha: string;
  readonly content: string;
}

interface GovernanceReadFailure {
  readonly error: GovernanceReadCode;
  readonly reason: string;
}

export type FileReadOutcome = GovernanceFileRead | GovernanceReadFailure;

/** The directory index only transports metadata; never the bytes of the files. */
interface GovernanceDirectoryEntry {
  readonly path: string;
  readonly bytes: number;
  readonly modified_at: string;
}

interface GovernanceDirectoryRead {
  /** Absolute path the agent authenticated as the root of the sweep. */
  readonly path: string;
  /** Exact total only if the sweep finished; null when the cap left a lower bound. */
  readonly total: number | null;
  /** Amount actually observed, even when the exact total is unknown. */
  readonly observed_at_least: number;
  readonly truncated: boolean;
  readonly entries: readonly GovernanceDirectoryEntry[];
}

export type DirectoryReadOutcome = GovernanceDirectoryRead | GovernanceReadFailure;

/** It's the same ceiling the pty-agent uses when building its index. */
const MAX_GOVERNANCE_DIRECTORY_ENTRIES = 200;
const MAX_GOVERNANCE_PATH_BYTES = 4_096;
const MAX_GOVERNANCE_DATE_BYTES = 64;
const MAX_GOVERNANCE_REASON_BYTES = 2_048;

const DIRECTORY_OK_KEYS = [
  'entries', 'kind', 'observed_at_least', 'path', 'request_id', 'total', 'truncated',
];
const DIRECTORY_ENTRY_KEYS = ['bytes', 'modified_at', 'path'];
function hasExactKeys(source: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(source).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/')
      || Buffer.byteLength(value, 'utf8') > MAX_GOVERNANCE_PATH_BYTES
      || hasUnsafeTextCodePoint(value)) return false;
  const segments = value.split('/');
  return !segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function strictDescendant(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}/`);
}

function sensitiveDirectoryPath(path: string): boolean {
  return hasGovernanceSensitivePathSegment(path);
}

/** A code we don't recognize is `unknown`, never propagated as-is. */
function normalizeCode(value: string): GovernanceReadCode {
  return READ_CODES.includes(value as GovernanceReadCode) ? (value as GovernanceReadCode) : 'unknown';
}

/** The same closed derivation gateway and pty-agent make, but from the measured HELLO. */
function memoryRootForAgent(connection: AgentConnection): string | undefined {
  const home = connection.hello.home?.replace(/\/+$/u, '');
  let candidate: string | undefined;
  if (connection.hello.harness === 'claude' && home !== undefined) {
    const base = (connection.hello.claude_config_dir ?? `${home}/.claude`).replace(/\/+$/u, '');
    candidate = `${base}/projects`;
  } else if (connection.hello.harness === 'codex' && home !== undefined) {
    const base = (connection.hello.codex_home ?? `${home}/.codex`).replace(/\/+$/u, '');
    candidate = `${base}/memories`;
  } else if (connection.hello.harness === 'openclaw') {
    const workspace = connection.hello.openclaw_workspace?.replace(/\/+$/u, '');
    if (workspace !== undefined) candidate = `${workspace}/memory`;
  }
  return candidate !== undefined && canonicalAbsolutePath(candidate) ? candidate : undefined;
}

export async function requestFileRead(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  path: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<FileReadOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
// The connection is looked up by the caller. If what comes back is not from the requested
    // alias, this is a leak between tenants, not a read failure: cut it off here without asking anything.
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceRead) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no sabe leer ficheros de gobierno' };
  }
  if (signal?.aborted) {
    return { error: 'cancelled', reason: 'la petición de lectura ya estaba cancelada' };
  }

  const requestId = randomUUID();
  return new Promise<FileReadOutcome>((resolve) => {
    const chunks: Buffer[] = [];
    let metadata: Omit<GovernanceFileRead, 'content'> | undefined;
    let expected: number | undefined;
    let received = 0;
    let accumulated = 0;
    let settled = false;
    const onAbort = (): void => {
      finish({ error: 'cancelled', reason: 'el cliente cerró la petición de lectura' });
    };

    const finish = (outcome: FileReadOutcome, terminal = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      connection.detachRead(requestId, terminal);
      resolve(outcome);
    };

    const complete = (): void => {
      if (metadata === undefined || expected === undefined || received < expected) return;
      const raw = Buffer.concat(chunks);
      if (!metadata.truncated && metadata.bytes !== raw.byteLength) {
        finish({ error: 'unknown', reason: 'el tamaño real no coincide con los datos recibidos' });
        return;
      }
      const receivedSha = createHash('sha256').update(raw).digest('hex');
      // If not truncated, the declared digest must describe exactly what arrived.
      if (!metadata.truncated && metadata.sha !== '' && metadata.sha !== receivedSha) {
        finish({ error: 'unknown', reason: 'la huella de lectura no coincide con los datos recibidos' });
        return;
      }
      finish({ ...metadata, sha: metadata.sha || receivedSha, content: raw.toString('utf8') }, true);
    };

    const timer = setTimeout(() => {
      logEvent('terminal_relay_read_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no contestó en ${String(timeoutMs)} ms` });
    }, timeoutMs);
    timer.unref();

    const attached = connection.attachRead(requestId, {
      onReadOk(body) {
        if (body.kind !== 'file') {
          finish({ error: 'unknown', reason: 'el agente contestó una lectura que no es de fichero' });
          return;
        }
        const answered = stringField(body, 'path');
        const modifiedAt = stringField(body, 'modified_at');
        const bytes = integerField(body, 'bytes');
        const count = integerField(body, 'chunks');
        const declaredSha = stringField(body, 'sha');
        if (answered === undefined || modifiedAt === undefined || bytes === undefined || count === undefined) {
          finish({ error: 'unknown', reason: 'el agente contestó sin los metadatos de la lectura' });
          return;
        }
        // Answering for a different path would mean serving a file nobody asked for.
        if (answered !== path) {
          finish({ error: 'unknown', reason: 'el agente contestó por una ruta distinta de la pedida' });
          return;
        }
        if (count < 0 || count > MAX_GOVERNANCE_CHUNKS) {
          finish({ error: 'too_large', reason: 'el agente anuncia más tramas de las que cabe un documento' });
          return;
        }
        const fallbackSha = declaredSha;
        if (fallbackSha !== undefined && !/^[0-9a-f]{64}$/.test(fallbackSha)) {
          finish({ error: 'unknown', reason: 'el agente contestó con una huella inválida' });
          return;
        }
        // Read compatibility: a pre-write agent didn't send `sha`. For a non-truncated document
        // it is completed at the end from its bytes; the temporary marker is replaced there.
        metadata = {
          path: answered,
          bytes,
          truncated: body.truncated === true,
          modified_at: modifiedAt,
          sha: fallbackSha ?? ''
        };
        expected = count;
        complete();
      },
      onReadData(chunk) {
        accumulated += chunk.byteLength;
        // The cap is checked BEFORE storing: otherwise, an agent that ignores its own limit
        // fills the relay's memory before anyone counts the frames.
        if (accumulated > MAX_GOVERNANCE_BYTES) {
          finish({ error: 'too_large', reason: 'el agente mandó más bytes de los que esta vía sirve' });
          return;
        }
        chunks.push(chunk);
        received += 1;
        complete();
      },
      onReadDone() {
        // A file ends by the exact count announced in READ_OK. If DONE still finds the handler
        // alive, frames are missing and the connection contradicted its own contract.
        finish({ error: 'unknown', reason: 'el agente cerró la lectura antes de mandar todos los datos' }, true);
        connection.destroy('read_done_before_file_complete');
      },
      onReadErr(failure) {
        finish({ error: normalizeCode(failure.code), reason: failure.reason }, true);
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      }
    });

    if (!attached) {
      finish({ error: 'busy', reason: 'ese alias ya tiene demasiadas lecturas en vuelo' });
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    connection.sendRead(requestId, 'file', path);
  });
}

/**
 * Requests a memory index. Unlike `requestFileRead`, a READ_DATA is always a violation: the
 * complete index must live in the single bounded READ_OK of the protocol.
 */
export async function requestDirectoryRead(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  root: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<DirectoryReadOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceRead) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no sabe leer ficheros de gobierno' };
  }
  if (!connection.supportsGovernanceReadDone) {
    return { error: 'unavailable', reason: 'el pty-agent no acredita el cierre ordenado del índice' };
  }
  if (!canonicalAbsolutePath(root)) {
    return { error: 'invalid_path', reason: 'la raíz del índice no es una ruta absoluta canónica' };
  }
  const expectedRoot = memoryRootForAgent(connection);
  if (expectedRoot === undefined || root !== expectedRoot) {
    return { error: 'invalid_path', reason: 'la raíz pedida no es la memoria medida de ese agente' };
  }
  if (signal?.aborted) {
    return { error: 'cancelled', reason: 'la petición del índice ya estaba cancelada' };
  }

  const requestId = randomUUID();
  return new Promise<DirectoryReadOutcome>((resolve) => {
    let settled = false;
    let pendingSuccess: GovernanceDirectoryRead | undefined;
    let timer: NodeJS.Timeout | undefined = undefined;

    const onAbort = (): void => {
      finish({ error: 'cancelled', reason: 'el cliente cerró la petición del índice' });
    };
    const finish = (outcome: DirectoryReadOutcome, terminal = false): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      connection.detachRead(requestId, terminal);
      resolve(outcome);
    };
    const protocolFailure = (reason: string): void => {
      finish({ error: 'unknown', reason }, true);
      connection.destroy('directory_read_protocol_violation');
    };

    const attached = connection.attachRead(requestId, {
      onReadOk(body) {
        if (pendingSuccess !== undefined) {
          protocolFailure('el agente contestó dos veces el mismo índice');
          return;
        }
        if (!hasExactKeys(body, DIRECTORY_OK_KEYS) || body.kind !== 'dir') {
          protocolFailure('el agente contestó una lectura que no es un índice válido');
          return;
        }
        const answered = body.path;
        const total = body.total;
        const observedAtLeast = body.observed_at_least;
        const truncated = body.truncated;
        const rawEntries = body.entries;
        if (answered !== root) {
          protocolFailure('el agente contestó por una raíz distinta de la pedida');
          return;
        }
        if ((total !== null && (!Number.isSafeInteger(total) || (total as number) < 0))
            || !Number.isSafeInteger(observedAtLeast) || (observedAtLeast as number) < 0
            || typeof truncated !== 'boolean' || !Array.isArray(rawEntries)
            || rawEntries.length > MAX_GOVERNANCE_DIRECTORY_ENTRIES) {
          protocolFailure('el agente contestó un índice con límites o conteos inválidos');
          return;
        }
        if ((observedAtLeast as number) < rawEntries.length
            || (total !== null && total !== observedAtLeast)
            || (total === null && !truncated)
            || (!truncated && (total !== rawEntries.length || observedAtLeast !== rawEntries.length))) {
          protocolFailure('el total del índice no coincide con su límite observado');
          return;
        }

        const entries: GovernanceDirectoryEntry[] = [];
        const paths = new Set<string>();
        for (const rawEntry of rawEntries) {
          if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)
              || !hasExactKeys(rawEntry as Record<string, unknown>, DIRECTORY_ENTRY_KEYS)) {
            protocolFailure('el índice contiene una entrada desconocida');
            return;
          }
          const entry = rawEntry as Record<string, unknown>;
          const entryPath = entry.path;
          const bytes = entry.bytes;
          const modifiedAt = entry.modified_at;
          if (!canonicalAbsolutePath(entryPath) || !strictDescendant(root, entryPath)
              || paths.has(entryPath) || !Number.isSafeInteger(bytes) || (bytes as number) < 0
              || !isStrictUtcIso8601(modifiedAt, MAX_GOVERNANCE_DATE_BYTES)) {
            protocolFailure('el índice contiene una ruta, fecha o tamaño inválidos');
            return;
          }
          if (sensitiveDirectoryPath(entryPath)) {
            finish({ error: 'permission_denied', reason: 'el índice intentó publicar metadata de credenciales' }, true);
            connection.destroy('directory_read_sensitive_metadata');
            return;
          }
          paths.add(entryPath);
          entries.push({ path: entryPath, bytes: bytes as number, modified_at: modifiedAt });
        }

        pendingSuccess = {
          path: root,
          total: total as number | null,
          observed_at_least: observedAtLeast as number,
          truncated,
          entries,
        };
      },
      onReadData() {
        pendingSuccess = undefined;
        protocolFailure('el agente mandó contenido en un índice de directorio');
      },
      onReadDone(body) {
        if (!hasExactKeys(body, ['request_id']) || pendingSuccess === undefined) {
          protocolFailure('el agente cerró un índice sin un READ_OK válido');
          return;
        }
        finish(pendingSuccess, true);
      },
      onReadErr(failure) {
        if (failure.reason.length === 0
            || Buffer.byteLength(failure.reason, 'utf8') > MAX_GOVERNANCE_REASON_BYTES
            || hasControlCharacter(failure.reason)) {
          protocolFailure('el agente contestó un fallo de índice inválido');
          return;
        }
        finish({ error: normalizeCode(failure.code), reason: failure.reason }, true);
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      },
    });

    if (!attached) {
      finish({ error: 'busy', reason: 'ese alias ya tiene demasiadas lecturas en vuelo' });
      return;
    }
    timer = setTimeout(() => {
      logEvent('terminal_relay_directory_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no contestó en ${String(timeoutMs)} ms` });
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    connection.sendRead(requestId, 'dir', root);
  });
}
