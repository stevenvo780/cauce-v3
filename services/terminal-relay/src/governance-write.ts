import { createHash, randomUUID } from 'node:crypto';
import { logEvent } from '@cauce/protocol';
import type { AgentConnection, AgentGovernanceBatchEntry } from './agent-leg.js';
import { MAX_GOVERNANCE_BYTES, type GovernanceReadCode } from './governance-read.js';
import { integerField, stringField } from './validation.js';

type GovernanceWriteOperation = 'replace' | 'create';

export type GovernanceWritePrecondition =
  | { readonly state: 'present'; readonly sha256: string }
  | { readonly state: 'absent' };

interface GovernanceFileWrite {
  readonly path: string;
  readonly operation: GovernanceWriteOperation;
  readonly sha: string;
  readonly bytes: number;
}

interface GovernanceWriteFailure {
  readonly error: GovernanceReadCode | 'conflict';
  readonly reason: string;
}

export type FileWriteOutcome = GovernanceFileWrite | GovernanceWriteFailure;

const READ_CODES: readonly GovernanceReadCode[] = [
  'not_found', 'permission_denied', 'invalid_path', 'symlink_detected',
  'too_large', 'timeout', 'cancelled', 'busy', 'unavailable', 'unknown'
];
const WRITE_CODES: readonly GovernanceWriteFailure['error'][] = [...READ_CODES, 'conflict'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function normalizeWriteCode(value: string): GovernanceWriteFailure['error'] {
  return WRITE_CODES.includes(value as GovernanceWriteFailure['error'])
    ? (value as GovernanceWriteFailure['error'])
    : 'unknown';
}

/**
 * End-to-end CAS write. The only possible success is a WRITE_OK whose path, operation, bytes and
 * SHA describe exactly the content this relay put into the agent's socket.
 */
export async function requestFileWrite(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  path: string,
  content: Buffer,
  precondition: GovernanceWritePrecondition,
  timeoutMs = 5_000,
  signal?: AbortSignal
): Promise<FileWriteOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceWrite) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no sabe escribir ficheros de gobierno' };
  }
  if (content.byteLength > MAX_GOVERNANCE_BYTES) {
    return { error: 'too_large', reason: 'el contenido se pasa del tope de gobierno' };
  }
  if (precondition.state === 'present' && !SHA256_PATTERN.test(precondition.sha256)) {
    return { error: 'invalid_path', reason: 'replace exige una precondición SHA-256 válida' };
  }
  if (signal?.aborted === true) {
    return { error: 'unavailable', reason: 'la petición de escritura fue cancelada' };
  }

  const requestId = randomUUID();
  const operation: GovernanceWriteOperation = precondition.state === 'present' ? 'replace' : 'create';
  const expectedSha = precondition.state === 'present' ? precondition.sha256 : undefined;
  const contentSha = createHash('sha256').update(content).digest('hex');

  return new Promise<FileWriteOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: FileWriteOutcome, cancelAgent = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      connection.detachWrite(requestId);
      if (cancelAgent) connection.cancelWrite(requestId);
      resolve(outcome);
    };
    const aborted = (): void => { finish(
      { error: 'unavailable', reason: 'la petición de escritura fue cancelada' },
      true
    ); };
    const timer = setTimeout(() => {
      logEvent('terminal_relay_write_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no confirmó la escritura en ${String(timeoutMs)} ms` }, true);
    }, timeoutMs);
    timer.unref();

    connection.attachWrite(requestId, {
      onWriteOk(body) {
        const answeredPath = stringField(body, 'path');
        const answeredOperation = stringField(body, 'operation');
        const answeredSha = stringField(body, 'sha');
        const answeredBytes = integerField(body, 'bytes');
        if (answeredPath !== path || answeredOperation !== operation
          || answeredSha !== contentSha || answeredBytes !== content.byteLength) {
          finish({ error: 'unknown', reason: 'el ACK del agente no acredita la escritura solicitada' });
          return;
        }
        finish({ path, operation, sha: contentSha, bytes: content.byteLength });
      },
      onWriteErr(failure) {
        finish({ error: normalizeWriteCode(failure.code), reason: failure.reason });
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      }
    });
    signal?.addEventListener('abort', aborted, { once: true });

    if (!connection.sendWrite(requestId, path, operation, expectedSha, contentSha, content)) {
      finish({ error: 'unavailable', reason: 'la cola hacia el pty-agent está congestionada' }, true);
    }
  });
}

export type GovernanceWriteBatchEntry =
  | {
      readonly mode: 'write';
      readonly path: string;
      readonly content: Buffer;
      readonly precondition: GovernanceWritePrecondition;
    }
  | {
      readonly mode: 'verify';
      readonly path: string;
      readonly precondition: GovernanceWritePrecondition;
    };

type GovernanceBatchAckOperation = 'create' | 'replace' | 'unchanged' | 'absent';

interface GovernanceBatchFileAck {
  readonly path: string;
  readonly operation: GovernanceBatchAckOperation;
  readonly sha: string | null;
  readonly bytes: number;
}

export type GovernanceWriteBatchOutcome =
  | { readonly files: readonly GovernanceBatchFileAck[] }
  | GovernanceWriteFailure;

const MAX_GOVERNANCE_BATCH_FILES = 7;

/**
 * Multi-file governed profile. `verify` accredits state without opening for writing or changing
 * mtime; `write` accepts `unchanged` if a retry finds exactly the desired bytes. The only success
 * is a complete and correlated ACK for all entries.
 */
export async function requestFileWriteBatch(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  entries: readonly GovernanceWriteBatchEntry[],
  timeoutMs = 5_000,
  signal?: AbortSignal
): Promise<GovernanceWriteBatchOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceWriteBatch) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no soporta perfiles atómicos' };
  }
  if (entries.length < 1 || entries.length > MAX_GOVERNANCE_BATCH_FILES) {
    return { error: 'too_large', reason: 'el perfil debe contener entre uno y siete ficheros' };
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    return { error: 'conflict', reason: 'el perfil contiene rutas duplicadas' };
  }
  let totalBytes = 0;
  const wireEntries: AgentGovernanceBatchEntry[] = [];
  for (const entry of entries) {
    if (entry.precondition.state === 'present' && !SHA256_PATTERN.test(entry.precondition.sha256)) {
      return { error: 'invalid_path', reason: 'una precondición del perfil no es un SHA-256 válido' };
    }
    const expectedSha = entry.precondition.state === 'present' ? entry.precondition.sha256 : undefined;
    if (entry.mode === 'verify') {
      wireEntries.push({
        path: entry.path,
        mode: 'verify',
        operation: entry.precondition.state,
        expectedSha,
      });
      continue;
    }
    totalBytes += entry.content.byteLength;
    if (totalBytes > MAX_GOVERNANCE_BYTES) {
      return { error: 'too_large', reason: 'el perfil se pasa del tope total de gobierno' };
    }
    wireEntries.push({
      path: entry.path,
      mode: 'write',
      operation: entry.precondition.state === 'present' ? 'replace' : 'create',
      expectedSha,
      contentSha: createHash('sha256').update(entry.content).digest('hex'),
      content: entry.content,
    });
  }
  if (signal?.aborted === true) {
    return { error: 'unavailable', reason: 'la petición de perfil fue cancelada' };
  }

  const requestId = randomUUID();
  return new Promise<GovernanceWriteBatchOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: GovernanceWriteBatchOutcome, cancelAgent = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      connection.detachWrite(requestId);
      if (cancelAgent) connection.cancelGovernanceWriteBatch(requestId);
      resolve(outcome);
    };
    const aborted = (): void => { finish(
      { error: 'unavailable', reason: 'la petición de perfil fue cancelada' }, true
    ); };
    const timer = setTimeout(() => {
      logEvent('terminal_relay_write_batch_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no confirmó el perfil en ${String(timeoutMs)} ms` }, true);
    }, timeoutMs);
    timer.unref();

    connection.attachWrite(requestId, {
      onWriteOk(body) {
        const rawFiles: unknown = body.files;
        if (!Array.isArray(rawFiles) || rawFiles.length !== wireEntries.length) {
          finish({ error: 'unknown', reason: 'el ACK del agente no acredita todos los ficheros del perfil' });
          return;
        }
        const acknowledgements: GovernanceBatchFileAck[] = [];
        for (let index = 0; index < wireEntries.length; index += 1) {
          const requested = wireEntries[index];
          const raw: unknown = rawFiles[index];
          if (requested === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            finish({ error: 'unknown', reason: 'el ACK del agente contiene una entrada inválida' });
            return;
          }
          const answer = raw as Record<string, unknown>;
          const answeredPath = stringField(answer, 'path');
          const operation = stringField(answer, 'operation');
          const bytes = integerField(answer, 'bytes');
          const rawSha: unknown = answer.sha;
          const sha = rawSha === null ? null : typeof rawSha === 'string' ? rawSha : undefined;
          const validOperation = operation === 'create' || operation === 'replace'
            || operation === 'unchanged' || operation === 'absent';
          if (answeredPath !== requested.path || !validOperation || bytes === undefined || bytes < 0
            || sha === undefined || (sha !== null && !SHA256_PATTERN.test(sha))) {
            finish({ error: 'unknown', reason: 'el ACK del agente contiene metadatos inválidos' });
            return;
          }
          if (requested.mode === 'write') {
            if ((operation !== requested.operation && operation !== 'unchanged')
              || sha !== requested.contentSha || bytes !== requested.content.byteLength) {
              finish({ error: 'unknown', reason: 'el ACK del agente no acredita los bytes solicitados' });
              return;
            }
          } else if (requested.operation === 'present') {
            if (operation !== 'unchanged' || sha !== requested.expectedSha) {
              finish({ error: 'unknown', reason: 'el ACK del agente no acredita el fichero preservado' });
              return;
            }
          } else if (operation !== 'absent' || sha !== null || bytes !== 0) {
            finish({ error: 'unknown', reason: 'el ACK del agente no acredita la ausencia solicitada' });
            return;
          }
          acknowledgements.push({ path: requested.path, operation, sha, bytes });
        }
        finish({ files: acknowledgements });
      },
      onWriteErr(failure) {
        finish({ error: normalizeWriteCode(failure.code), reason: failure.reason });
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      },
    });
    signal?.addEventListener('abort', aborted, { once: true });

    if (!connection.sendGovernanceWriteBatch(requestId, wireEntries)) {
      finish({ error: 'unavailable', reason: 'la cola hacia el pty-agent está congestionada' }, true);
    }
  });
}
