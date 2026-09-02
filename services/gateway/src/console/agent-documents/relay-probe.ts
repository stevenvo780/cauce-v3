import { createHash } from 'node:crypto';
import { hasUnsafeTextCodePoint, isStrictUtcIso8601 } from '@cauce/protocol';
import type {
  AgentFactsProbe,
  FactsSource,
  GovernanceBatchWrite,
  GovernanceBatchWriteAck,
  GovernanceDocumentContent,
  GovernanceReadError,
  GovernanceWritePrecondition,
  MemoryDirectoryListing
} from '../agent-documents.routes.js';
import {
  hasNeverServePathSegment,
  memoryRootForHarness,
  resolveAgentDocuments,
  type DocumentKind,
  type RuntimeFacts
} from './catalog.js';
import {
  MAX_DOCUMENT_BYTES,
  verifyReadablePath,
  verifyWritablePath,
  verifyWritableProfilePath
} from './path-policy.js';

/** What the pty-agent returns after reading, already accumulated by the terminal-relay. */
export interface RelayFileRead {
  readonly path: string;
  /** REAL size of the file, even if `content` arrives truncated. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly modified_at: string;
  readonly sha: string;
  readonly content: string;
}
/** Internal shape of the relay index: still uses absolute paths vouched for by the agent. */
export interface RelayDirectoryRead {
  readonly path: string;
  readonly total: number | null;
  readonly observed_at_least: number;
  readonly truncated: boolean;
  readonly entries: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly modified_at: string;
  }[];
}

export interface RelayFileWrite {
  readonly path: string;
  readonly operation: 'replace' | 'create';
  readonly sha: string;
  readonly bytes: number;
}

export interface RelayFileWriteBatch {
  readonly files: readonly GovernanceBatchWriteAck[];
}

export type GovernanceWriteError = GovernanceReadError | { readonly error: 'conflict'; readonly reason: string };

/**
 * The little the gateway needs from the terminal-relay. It is declared here, and not imported
 * from the relay package, because they are two processes on two machines: this contract binds them.
 */
export interface GovernanceRelayClient {
  readFile(
    tenantId: string,
    alias: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RelayFileRead | GovernanceReadError>;
  /** Missing only in legacy implementations; never replaced with an empty index. */
  listDirectory?(
    tenantId: string,
    alias: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RelayDirectoryRead | GovernanceReadError>;
  /** Missing in legacy doubles/clients; the probe fails honestly and does not claim application. */
  writeFile?(
    tenantId: string,
    alias: string,
    path: string,
    content: string,
    precondition: GovernanceWritePrecondition,
  ): Promise<RelayFileWrite | GovernanceWriteError>;
  writeFiles?(
    tenantId: string,
    alias: string,
    writes: readonly GovernanceBatchWrite[],
  ): Promise<RelayFileWriteBatch | GovernanceWriteError>;
}

/** Where measured facts come from. Injected so the probe is not tied to the store. */
export interface MeasuredFactsSource {
  factsFor(tenantId: string, alias: string): Promise<{ facts: RuntimeFacts; source: FactsSource } | undefined>;
}

/**
 * AgentFactsProbe backed by terminal-relay and pty-agent.
 */
export class TerminalRelayFactsProbe implements AgentFactsProbe {
  private readonly facts: MeasuredFactsSource;
  private readonly relay: GovernanceRelayClient;

  constructor(facts: MeasuredFactsSource, relay: GovernanceRelayClient) {
    this.facts = facts;
    this.relay = relay;
  }

  async factsFor(tenantId: string, alias: string): Promise<{ facts: RuntimeFacts; source: FactsSource } | undefined> {
    return this.facts.factsFor(tenantId, alias);
  }

  async readGovernanceDocument(
    path: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<GovernanceDocumentContent | GovernanceReadError> {
    const verdict = verifyReadablePath(facts, path);
    if (!verdict.allowed) {
      return { error: 'invalid_path', reason: verdict.reason ?? 'ruta no permitida' };
    }

    let answer: RelayFileRead | GovernanceReadError;
    try {
      answer = await this.relay.readFile(tenantId, alias, path, signal);
    } catch (error) {
      // The relay blowing up cannot take down the whole screen: it is counted as a failed read.
      return { error: 'unknown', reason: `la lectura falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;
    if (answer.path !== path) {
      return { error: 'unknown', reason: 'la respuesta es de otra ruta distinta de la pedida' };
    }
    if (!Number.isInteger(answer.bytes) || answer.bytes < 0) {
      return { error: 'unknown', reason: 'la respuesta no trae un tamaño creíble' };
    }
    if (!/^[0-9a-f]{64}$/.test(answer.sha)) {
      return { error: 'unknown', reason: 'la respuesta no trae una huella SHA-256 válida' };
    }

    // WATCH OUT with the units: `MAX_DOCUMENT_BYTES` is BYTES, while `string.length` is UTF-16
    // units. Comparing them directly lets through any document with accented characters, which
    // are abundant here. We measure with `byteLength` and truncate on the buffer.
    const size = Buffer.byteLength(answer.content, 'utf8');
    if (!answer.truncated && size !== answer.bytes) {
      return { error: 'unknown', reason: 'el tamaño de la lectura no coincide con su contenido' };
    }
    if (!answer.truncated && createHash('sha256').update(answer.content, 'utf8').digest('hex') !== answer.sha) {
      return { error: 'unknown', reason: 'la huella de la lectura no coincide con su contenido' };
    }
    const overflowed = size > MAX_DOCUMENT_BYTES;
    const text = overflowed
      ? Buffer.from(answer.content, 'utf8').subarray(0, MAX_DOCUMENT_BYTES).toString('utf8')
      : answer.content;

    return {
      text,
      bytes: answer.bytes,
      truncated: answer.truncated || overflowed,
      modified_at: answer.modified_at,
      sha: answer.sha,
    };
  }

  async writeGovernanceDocument(
    path: string,
    contenido: string,
    precondition: GovernanceWritePrecondition,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<{ sha: string; bytes: number } | GovernanceWriteError> {
    const kind = documentForPathKind(facts, path);
    if (kind === undefined) {
      return { error: 'invalid_path', reason: 'la ruta no pertenece al juego cerrado de documentos' };
    }
    const verdict = verifyWritablePath(facts, kind, path);
    if (!verdict.allowed) {
      return { error: 'invalid_path', reason: verdict.reason ?? 'ruta no permitida' };
    }
    const raw = Buffer.from(contenido, 'utf8');
    if (raw.byteLength > MAX_DOCUMENT_BYTES) {
      return { error: 'too_large', reason: 'el contenido se pasa del tope de 256 KiB' };
    }
    if (precondition.state === 'present' && !/^[0-9a-f]{64}$/.test(precondition.sha256)) {
      return { error: 'invalid_path', reason: 'la precondición de reemplazo no es un SHA-256 válido' };
    }
    if (this.relay.writeFile === undefined) {
      return { error: 'unavailable', reason: 'el cliente del terminal-relay no publica escritura gobernada' };
    }

    let answer: RelayFileWrite | GovernanceWriteError;
    try {
      answer = await this.relay.writeFile(tenantId, alias, path, contenido, precondition);
    } catch (error) {
      return { error: 'unknown', reason: `la escritura falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;
    const expectedOperation = precondition.state === 'present' ? 'replace' : 'create';
    const expectedSha = createHash('sha256').update(raw).digest('hex');
    if (answer.path !== path || answer.operation !== expectedOperation
      || answer.sha !== expectedSha || answer.bytes !== raw.byteLength) {
      return { error: 'unknown', reason: 'el ACK del relay no acredita el contenido solicitado' };
    }
    return { sha: answer.sha, bytes: answer.bytes };
  }

  async writeGovernanceBatch(
    writes: readonly GovernanceBatchWrite[],
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<readonly GovernanceBatchWriteAck[] | GovernanceWriteError> {
    if (writes.length === 0 || writes.length > 7 || this.relay.writeFiles === undefined) {
      return { error: 'unavailable', reason: 'el relay no publica el lote gobernado del perfil' };
    }
    const seen = new Set<string>();
    for (const write of writes) {
      const verdict = verifyWritableProfilePath(facts, write.path);
      if (!verdict.allowed || seen.has(write.path)) {
        return { error: 'invalid_path', reason: verdict.reason ?? 'el lote repite una ruta' };
      }
      seen.add(write.path);
      if (write.mode === 'write' && Buffer.byteLength(write.content, 'utf8') > MAX_DOCUMENT_BYTES) {
        return { error: 'too_large', reason: 'un documento del perfil se pasa de 256 KiB' };
      }
      if (write.precondition.state === 'present' && !/^[0-9a-f]{64}$/.test(write.precondition.sha256)) {
        return { error: 'invalid_path', reason: 'una precondición del lote no es un SHA-256 válido' };
      }
    }

    let answer: RelayFileWriteBatch | GovernanceWriteError;
    try {
      answer = await this.relay.writeFiles(tenantId, alias, writes);
    } catch (error) {
      return { error: 'unknown', reason: `el lote falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;
    if (answer.files.length !== writes.length) {
      return { error: 'unknown', reason: 'el ACK del lote no acredita todos los documentos' };
    }
    const byPath = new Map(answer.files.map((file) => [file.path, file]));
    if (byPath.size !== writes.length) {
      return { error: 'unknown', reason: 'el ACK del lote repite documentos' };
    }
    const acknowledgements: GovernanceBatchWriteAck[] = [];
    for (const write of writes) {
      const file = byPath.get(write.path);
      if (file === undefined) {
        return { error: 'unknown', reason: 'un ACK del lote no coincide con el contenido solicitado' };
      }
      if (write.mode === 'verify') {
        const valid = write.precondition.state === 'present'
          ? file.operation === 'unchanged' && file.sha === write.precondition.sha256
          : file.operation === 'absent' && file.sha === null && file.bytes === 0;
        if (!valid) {
          return { error: 'unknown', reason: 'un ACK del lote no acredita el fichero preservado' };
        }
      } else {
        const content = Buffer.from(write.content, 'utf8');
        const expectedOperation = write.precondition.state === 'present' ? 'replace' : 'create';
        const expectedSha = createHash('sha256').update(content).digest('hex');
        if ((file.operation !== expectedOperation && file.operation !== 'unchanged')
          || file.sha !== expectedSha || file.bytes !== content.byteLength) {
          return { error: 'unknown', reason: 'un ACK del lote no coincide con el contenido solicitado' };
        }
      }
      acknowledgements.push(file);
    }
    return acknowledgements;
  }

  async listMemoryDirectory(
    memoryRoot: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<MemoryDirectoryListing | GovernanceReadError> {
    const expectedRoot = memoryRootForHarness(facts);
    if (expectedRoot === null || memoryRoot !== expectedRoot || !canonicalAbsoluteMemoryPath(memoryRoot)) {
      return { error: 'invalid_path', reason: 'la raíz pedida no es la memoria medida de ese arnés' };
    }
    if (this.relay.listDirectory === undefined) {
      return { error: 'unavailable', reason: 'el cliente del terminal-relay no publica índices de memoria' };
    }

    let answer: RelayDirectoryRead | GovernanceReadError;
    try {
      answer = await this.relay.listDirectory(tenantId, alias, memoryRoot, signal);
    } catch (error) {
      return { error: 'unknown', reason: `el índice falló: ${error instanceof Error ? error.message : 'sin detalle'}` };
    }
    if ('error' in answer) return answer;

    const response = answer as unknown as Record<string, unknown>;
    const topKeys = Object.keys(response).sort();
    if (topKeys.length !== 5 || topKeys.some((key, index) => key !== [
      'entries', 'observed_at_least', 'path', 'total', 'truncated',
    ][index])) {
      return { error: 'unknown', reason: 'el relay devolvió un índice con campos desconocidos' };
    }
    const total = response.total;
    const observedAtLeast = response.observed_at_least;
    const truncated = response.truncated;
    const rawEntries = response.entries;
    if (response.path !== memoryRoot
        || (total !== null && (!Number.isSafeInteger(total) || (total as number) < 0))
        || !Number.isSafeInteger(observedAtLeast) || (observedAtLeast as number) < 0
        || typeof truncated !== 'boolean' || !Array.isArray(rawEntries)
        || rawEntries.length > MAX_MEMORY_DIRECTORY_ENTRIES
        || (observedAtLeast as number) < rawEntries.length
        || (total !== null && total !== observedAtLeast)
        || (total === null && !truncated)
        || (!truncated && (total !== rawEntries.length || observedAtLeast !== rawEntries.length))) {
      return { error: 'unknown', reason: 'el relay devolvió un índice con raíz, límites o conteos inválidos' };
    }

    const entries: MemoryDirectoryListing['entries'] = [];
    const seen = new Set<string>();
    for (const rawEntry of rawEntries as unknown[]) {
      if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        return { error: 'unknown', reason: 'el relay devolvió una entrada de memoria inválida' };
      }
      const record = rawEntry as Record<string, unknown>;
      if (record.symlink === true || record.type === 'symlink') {
        return { error: 'symlink_detected', reason: 'el índice intentó publicar un enlace simbólico' };
      }
      const keys = Object.keys(record).sort();
      if (keys.length !== 3 || keys.some((key, index) => key !== ['bytes', 'modified_at', 'path'][index])) {
        return { error: 'unknown', reason: 'el relay devolvió una entrada con campos desconocidos' };
      }
      const entryPath = record.path;
      const bytes = record.bytes;
      const modifiedAt = record.modified_at;
      if (!canonicalAbsoluteMemoryPath(entryPath)
          || !entryPath.startsWith(`${memoryRoot}/`)
          || seen.has(entryPath)
          || !Number.isSafeInteger(bytes) || (bytes as number) < 0
          || !isStrictUtcIso8601(modifiedAt, MAX_MEMORY_DATE_BYTES)) {
        return { error: 'unknown', reason: 'el relay devolvió una ruta, fecha o tamaño de memoria inválidos' };
      }
      const relative = entryPath.slice(memoryRoot.length + 1);
      if (!canonicalRelativeMemoryPath(relative)) {
        return { error: 'unknown', reason: 'el relay devolvió una entrada fuera de la raíz de memoria' };
      }
      if (hasNeverServePathSegment(relative)) {
        return { error: 'permission_denied', reason: 'el índice intentó publicar metadata de credenciales' };
      }
      seen.add(entryPath);
      entries.push({ path: relative, bytes: bytes as number, modified_at: modifiedAt });
    }

    return {
      root: memoryRoot,
      total: total as number | null,
      observed_at_least: observedAtLeast as number,
      truncated,
      entries,
    };
  }
}

const MAX_MEMORY_DIRECTORY_ENTRIES = 200;
const MAX_MEMORY_PATH_BYTES = 4_096;
const MAX_MEMORY_DATE_BYTES = 64;

function canonicalAbsoluteMemoryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/')
      || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_PATH_BYTES
      || hasUnsafeTextCodePoint(value)) return false;
  const segments = value.split('/');
  return !segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function canonicalRelativeMemoryPath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_PATH_BYTES
      || hasUnsafeTextCodePoint(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** `verifyWritablePath` requires kind: it derives it from the same closed set that produced the path. */
function documentForPathKind(facts: RuntimeFacts, path: string): DocumentKind | undefined {
  return resolveAgentDocuments(facts).find((document) => document.path === path)?.kind;
}
