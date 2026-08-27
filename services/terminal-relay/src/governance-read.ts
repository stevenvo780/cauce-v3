import { createHash, randomUUID } from 'node:crypto';
import type { AgentConnection } from './agent-leg.js';
import { logEvent } from './log.js';

/**
 * Lectura de un fichero de gobierno dentro del contenedor de un alias.
 *
 * El relay transporta la lectura de forma acotada en memoria y tiempo,
 * validando que la respuesta corresponda al alias y ruta solicitados.
 */

/** Tope de lo que se acumula en memoria. Coincide con `MAX_DOCUMENT_BYTES` del pty-agent. */
export const MAX_GOVERNANCE_BYTES = 256 * 1024;
/**
 * A 65.500 B por trama, 256 KB entran en 5. Se admiten 8 por holgura: más tramas anunciadas que
 * eso no es un documento grande, es un agente diciendo algo que no cuadra con su propio tope.
 */
const MAX_GOVERNANCE_CHUNKS = 8;

export type GovernanceReadCode =
  | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
  | 'too_large' | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown';

const READ_CODES: readonly GovernanceReadCode[] = [
  'not_found', 'permission_denied', 'invalid_path', 'symlink_detected',
  'too_large', 'timeout', 'cancelled', 'busy', 'unavailable', 'unknown'
];

export interface GovernanceFileRead {
  readonly path: string;
  /** Tamaño REAL del fichero, aunque `content` venga recortado. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly modified_at: string;
  /** SHA-256 de los bytes reales; en agentes viejos se deriva del contenido no truncado. */
  readonly sha: string;
  readonly content: string;
}

export interface GovernanceReadFailure {
  readonly error: GovernanceReadCode;
  readonly reason: string;
}

export type FileReadOutcome = GovernanceFileRead | GovernanceReadFailure;

/** El índice de directorio sólo transporta metadata; nunca bytes de los ficheros. */
export interface GovernanceDirectoryEntry {
  readonly path: string;
  readonly bytes: number;
  readonly modified_at: string;
}

export interface GovernanceDirectoryRead {
  /** Ruta absoluta que el agente acreditó como raíz del barrido. */
  readonly path: string;
  /** Total exacto sólo si el barrido acabó; null cuando el cap dejó un límite inferior. */
  readonly total: number | null;
  /** Cantidad realmente observada, incluso cuando no se conoce el total exacto. */
  readonly observed_at_least: number;
  readonly truncated: boolean;
  readonly entries: readonly GovernanceDirectoryEntry[];
}

export type DirectoryReadOutcome = GovernanceDirectoryRead | GovernanceReadFailure;

/** Es el mismo techo que usa el pty-agent al construir su índice. */
export const MAX_GOVERNANCE_DIRECTORY_ENTRIES = 200;
const MAX_GOVERNANCE_PATH_BYTES = 4_096;
const MAX_GOVERNANCE_DATE_BYTES = 64;
const MAX_GOVERNANCE_REASON_BYTES = 2_048;

const DIRECTORY_OK_KEYS = [
  'entries', 'kind', 'observed_at_least', 'path', 'request_id', 'total', 'truncated',
];
const DIRECTORY_ENTRY_KEYS = ['bytes', 'modified_at', 'path'];
const DIRECTORY_SENSITIVE_BASENAMES = new Set([
  '.credentials.json', 'auth.json', '.claude.json', 'openclaw.json', '.env', '.netrc',
  'id_ed25519', 'id_rsa', 'known_hosts', 'authorized_keys',
]);
const DIRECTORY_SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function hasExactKeys(source: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(source).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function canonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/')
      || Buffer.byteLength(value, 'utf8') > MAX_GOVERNANCE_PATH_BYTES
      || hasControlCharacter(value)) return false;
  const segments = value.split('/');
  return !segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function strictDescendant(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}/`);
}

function sensitiveDirectoryPath(path: string): boolean {
  return path.split('/').some((segment) => DIRECTORY_SENSITIVE_BASENAMES.has(segment)
    || DIRECTORY_SENSITIVE_SUFFIXES.some((suffix) => segment.endsWith(suffix)));
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_GOVERNANCE_DATE_BYTES) return false;
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
function normalizeCode(value: string): GovernanceReadCode {
  return READ_CODES.includes(value as GovernanceReadCode) ? (value as GovernanceReadCode) : 'unknown';
}

/** La misma derivación cerrada que hacen gateway y pty-agent, pero desde el HELLO medido. */
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
  // La conexión la busca quien llama. Si lo que vuelve no es del alias pedido, esto es una fuga
  // entre inquilinos, no un fallo de lectura: se corta aquí y no se pregunta nada.
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
      // Si no está truncado, la huella declarada tiene que describir exactamente lo que llegó.
      if (!metadata.truncated && metadata.sha !== '' && metadata.sha !== receivedSha) {
        finish({ error: 'unknown', reason: 'la huella de lectura no coincide con los datos recibidos' });
        return;
      }
      finish({ ...metadata, sha: metadata.sha || receivedSha, content: raw.toString('utf8') }, true);
    };

    const timer = setTimeout(() => {
      logEvent('terminal_relay_read_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no contestó en ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();

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
        // Contestar por otra ruta sería servir un fichero que nadie pidió.
        if (answered !== path) {
          finish({ error: 'unknown', reason: 'el agente contestó por una ruta distinta de la pedida' });
          return;
        }
        if (count < 0 || count > MAX_GOVERNANCE_CHUNKS) {
          finish({ error: 'too_large', reason: 'el agente anuncia más tramas de las que cabe un documento' });
          return;
        }
        const fallbackSha = declaredSha === undefined ? undefined : declaredSha;
        if (fallbackSha !== undefined && !/^[0-9a-f]{64}$/.test(fallbackSha)) {
          finish({ error: 'unknown', reason: 'el agente contestó con una huella inválida' });
          return;
        }
        // Compatibilidad de lectura: un agente pre-write no mandaba `sha`. Para un documento no
        // truncado se completa al final desde sus bytes; el marcador temporal se sustituye allí.
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
        // El tope se comprueba ANTES de guardar: si no, un agente que ignore su propio límite
        // llena la memoria del relay antes de que nadie cuente las tramas.
        if (accumulated > MAX_GOVERNANCE_BYTES) {
          finish({ error: 'too_large', reason: 'el agente mandó más bytes de los que esta vía sirve' });
          return;
        }
        chunks.push(chunk);
        received += 1;
        complete();
      },
      onReadDone() {
        // Un fichero termina por el conteo exacto anunciado en READ_OK. Si DONE encuentra todavía
        // vivo el handler, faltaron tramas y la conexión contradijo su propio contrato.
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
 * Pide un índice de memoria. A diferencia de `requestFileRead`, un READ_DATA es siempre una
 * violación: el índice completo tiene que vivir en el único READ_OK acotado del protocolo.
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
              || !validIsoDate(modifiedAt)) {
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
      finish({ error: 'timeout', reason: `el pty-agent no contestó en ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    connection.sendRead(requestId, 'dir', root);
  });
}
