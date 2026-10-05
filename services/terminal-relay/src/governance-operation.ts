import { logEvent } from '@cauce/protocol';
import type { AgentConnection } from './agent-leg.js';
import { hasControlCharacter, integerField, stringField } from './validation.js';

export interface GovernanceOperationDescriptor {
  readonly operation_id: string;
  readonly operation_token: string;
  readonly operation_generation: string;
  readonly request_id: string;
  readonly runtime_generation: string;
}

export type GovernanceWriteState = 'writing' | 'done' | 'unknown';

export interface GovernanceWriteStatusReceipt {
  readonly operation_id: string;
  readonly operation_generation: string;
  readonly request_id: string;
  readonly runtime_generation: string;
  readonly writer_instance_id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  readonly state: GovernanceWriteState;
  readonly files: readonly { readonly path: string; readonly sha: string | null; readonly bytes: number }[];
}

export interface GovernanceWriteFileReceipt {
  readonly path: string;
  readonly sha: string | null;
  readonly bytes: number;
}

export interface GovernanceWriteReceipt {
  readonly operation_id: string;
  readonly operation_generation: string;
  readonly request_id: string;
  readonly runtime_generation: string;
  readonly writer_instance_id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  readonly state: 'done';
  readonly files: readonly GovernanceWriteFileReceipt[];
}

export interface GovernanceWriteFileAck extends GovernanceWriteFileReceipt {
  readonly operation: 'create' | 'replace' | 'unchanged' | 'absent';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VALID_STATES = new Set<GovernanceWriteState>(['writing', 'done', 'unknown']);
const FILE_OPERATIONS = new Set(['create', 'replace', 'unchanged', 'absent']);

export function parseGovernanceOperation(value: unknown): GovernanceOperationDescriptor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expected = [
    'operation_generation', 'operation_id', 'operation_token', 'request_id', 'runtime_generation',
  ];
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
  if (typeof record.operation_id !== 'string' || !UUID_PATTERN.test(record.operation_id)
    || typeof record.operation_generation !== 'string' || !UUID_PATTERN.test(record.operation_generation)
    || typeof record.request_id !== 'string' || !UUID_PATTERN.test(record.request_id)
    || record.request_id !== record.operation_id
    || typeof record.operation_token !== 'string' || !UUID_V4_PATTERN.test(record.operation_token)
    || typeof record.runtime_generation !== 'string' || !IDENTITY_PATTERN.test(record.runtime_generation)) {
    return undefined;
  }
  return {
    operation_id: record.operation_id,
    operation_token: record.operation_token,
    operation_generation: record.operation_generation,
    request_id: record.request_id,
    runtime_generation: record.runtime_generation,
  };
}

export function parseGovernanceWriteOperation(value: unknown): GovernanceOperationDescriptor | undefined {
  return parseGovernanceOperation(value);
}

export function parseWriteFiles(value: unknown): readonly GovernanceWriteFileReceipt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: GovernanceWriteFileReceipt[] = [];
  const paths = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 3 || keys.some((key, index) => key !== ['bytes', 'path', 'sha'][index])) {
      return undefined;
    }
    const path = stringField(record, 'path');
    const bytes = integerField(record, 'bytes');
    const rawSha = record.sha;
    const sha = rawSha === null ? null : typeof rawSha === 'string' ? rawSha : undefined;
    if (path === undefined || !path.startsWith('/') || hasControlCharacter(path)
      || Buffer.byteLength(path, 'utf8') > 4096
      || path.split('/').slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
      || paths.has(path) || bytes === undefined || bytes < 0 || sha === undefined
      || (sha !== null && !SHA256_PATTERN.test(sha)) || (sha === null && bytes !== 0)) return undefined;
    paths.add(path);
    files.push({ path, sha, bytes });
  }
  return files;
}

export function parseWriteFileAcks(value: unknown): readonly GovernanceWriteFileAck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: GovernanceWriteFileAck[] = [];
  const paths = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 4 || keys.some((key, index) => key !== ['bytes', 'operation', 'path', 'sha'][index])) {
      return undefined;
    }
    const [file] = parseWriteFiles([{ path: record.path, sha: record.sha, bytes: record.bytes }]) ?? [];
    const operation = stringField(record, 'operation');
    if (file === undefined || paths.has(file.path) || operation === undefined || !FILE_OPERATIONS.has(operation)
      || (operation === 'absent' && file.sha !== null)
      || (operation !== 'absent' && file.sha === null)) {
      return undefined;
    }
    paths.add(file.path);
    files.push({ ...file, operation: operation as GovernanceWriteFileAck['operation'] });
  }
  return files;
}

export function parseWriteReceipt(
  value: unknown,
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  operation: GovernanceOperationDescriptor,
): GovernanceWriteReceipt | undefined {
  const writerInstanceId = connection.hello.writer_instance_id;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    'alias', 'container_id', 'files', 'operation_generation', 'operation_id', 'request_id',
    'runtime_generation', 'state', 'tenant_id', 'writer_instance_id',
  ];
  const keys = Object.keys(receipt).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || receipt.state !== 'done'
    || receipt.operation_id !== operation.operation_id
    || receipt.operation_generation !== operation.operation_generation
    || receipt.request_id !== operation.request_id
    || receipt.runtime_generation !== operation.runtime_generation
    || writerInstanceId === undefined || receipt.writer_instance_id !== writerInstanceId
    || receipt.tenant_id !== tenantId || receipt.tenant_id !== connection.hello.tenant_id
    || receipt.alias !== alias || receipt.alias !== connection.hello.alias
    || receipt.container_id !== connection.hello.container_id) return undefined;
  const files = parseWriteFiles(receipt.files);
  if (files === undefined || files.length === 0) return undefined;
  return {
    operation_id: operation.operation_id,
    operation_generation: operation.operation_generation,
    request_id: operation.request_id,
    runtime_generation: operation.runtime_generation,
    writer_instance_id: writerInstanceId,
    tenant_id: tenantId,
    alias,
    container_id: connection.hello.container_id,
    state: 'done',
    files,
  };
}

function parseStatusReceipt(
  body: Record<string, unknown>,
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  operation: GovernanceOperationDescriptor,
): GovernanceWriteStatusReceipt | undefined {
  const expectedKeys = [
    'alias', 'container_id', 'files', 'operation_generation', 'operation_id', 'request_id',
    'runtime_generation', 'state', 'tenant_id', 'writer_instance_id',
  ];
  const keys = Object.keys(body).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined;
  const state = stringField(body, 'state');
  const operationId = stringField(body, 'operation_id');
  const operationGeneration = stringField(body, 'operation_generation');
  const requestId = stringField(body, 'request_id');
  const runtimeGeneration = stringField(body, 'runtime_generation');
  const writerInstanceId = stringField(body, 'writer_instance_id');
  const bodyTenantId = stringField(body, 'tenant_id');
  const bodyAlias = stringField(body, 'alias');
  const containerId = stringField(body, 'container_id');
  const rawFiles = parseWriteFiles(body.files);
  if (state === undefined || !VALID_STATES.has(state as GovernanceWriteState)
    || operationId !== operation.operation_id || operationGeneration !== operation.operation_generation
    || requestId !== operation.request_id || runtimeGeneration !== operation.runtime_generation
    || writerInstanceId === undefined || writerInstanceId !== connection.hello.writer_instance_id
    || bodyTenantId !== tenantId || bodyTenantId !== connection.hello.tenant_id
    || bodyAlias !== alias || bodyAlias !== connection.hello.alias
    || containerId !== connection.hello.container_id || rawFiles === undefined
    || (state !== 'done' && rawFiles.length !== 0) || (state === 'done' && rawFiles.length === 0)) return undefined;
  return {
    operation_id: operationId,
    operation_generation: operationGeneration,
    request_id: requestId,
    runtime_generation: runtimeGeneration,
    writer_instance_id: writerInstanceId,
    tenant_id: bodyTenantId,
    alias: bodyAlias,
    container_id: containerId,
    state: state as GovernanceWriteState,
    files: rawFiles,
  };
}

export async function requestWriteStatus(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  operation: GovernanceOperationDescriptor,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<GovernanceWriteStatusReceipt | { readonly error: string; readonly reason: string }> {
  if (parseGovernanceOperation(operation) === undefined) {
    return { error: 'conflict', reason: 'la identidad de la operación no es válida' };
  }
  if (!connection.alive) return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (operation.runtime_generation !== connection.hello.generation) {
    return { error: 'conflict', reason: 'la generación actual no coincide con la de la operación' };
  }
  if (!connection.supportsWriteQuiescence) {
    return { error: 'unavailable', reason: 'el pty-agent no acredita estado durable de escritura' };
  }
  if (signal?.aborted === true) return { error: 'unavailable', reason: 'la petición de estado fue cancelada' };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      outcome: GovernanceWriteStatusReceipt | { readonly error: string; readonly reason: string },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      connection.detachWriteStatus(operation.request_id);
      resolve(outcome);
    };
    const aborted = (): void => {
      finish({ error: 'unavailable', reason: 'la petición de estado fue cancelada' });
    };
    const timer = setTimeout(() => {
      logEvent('terminal_relay_write_status_timeout', { tenant_id: tenantId, alias, request_id: operation.request_id });
      finish({ error: 'timeout', reason: `el pty-agent no confirmó el estado en ${String(timeoutMs)} ms` });
    }, timeoutMs);
    timer.unref();

    if (!connection.attachWriteStatus(operation.request_id, {
      onStatusOk(body) {
        const receipt = parseStatusReceipt(body, connection, tenantId, alias, operation);
        finish(receipt ?? { error: 'unknown', reason: 'el ACK no coincide con la operación o su alcance' });
      },
      onStatusErr(failure) {
        finish({ error: normalizeCode(failure.code), reason: failure.reason });
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      },
    })) {
      clearTimeout(timer);
      resolve({ error: 'conflict', reason: 'ya hay una consulta de estado para esta operación' });
      return;
    }
    signal?.addEventListener('abort', aborted, { once: true });
    if (!connection.sendWriteStatus(operation)) {
      finish({ error: 'unavailable', reason: 'la cola hacia el pty-agent está congestionada' });
    }
  });
}

function normalizeCode(value: string): 'unavailable' | 'timeout' | 'conflict' | 'unknown' {
  return value === 'timeout' || value === 'conflict' || value === 'unavailable' ? value : 'unknown';
}
