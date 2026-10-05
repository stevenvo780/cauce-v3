import { UUID_ANY_PATTERN, CANONICAL_UUID_V4_PATTERN } from '@cauce/protocol';

export interface GovernanceWriteOperation {
  readonly operationId: string;
  readonly operationToken: string;
  readonly operationGeneration: string;
  readonly runtimeGeneration: string;
  readonly signal?: AbortSignal;
}

export interface RelayWriteStatus {
  readonly operation_id: string;
  readonly operation_generation: string;
  readonly request_id: string;
  readonly runtime_generation: string;
  readonly writer_instance_id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  readonly state: 'writing' | 'done' | 'unknown';
  readonly files: readonly { readonly path: string; readonly sha: string | null; readonly bytes: number }[];
}

export function governanceOperationPayload(operation: GovernanceWriteOperation): Record<string, string> {
  if (!UUID_ANY_PATTERN.test(operation.operationId) || !CANONICAL_UUID_V4_PATTERN.test(operation.operationToken)
    || !UUID_ANY_PATTERN.test(operation.operationGeneration) || operation.runtimeGeneration.length === 0) {
    throw new Error('invalid governance operation');
  }
  return {
    operation_id: operation.operationId, operation_token: operation.operationToken,
    operation_generation: operation.operationGeneration, request_id: operation.operationId,
    runtime_generation: operation.runtimeGeneration,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function validatedWriteStatus(value: unknown, expected: {
  tenantId: string; alias: string; operationId: string; generation: string; runtimeGeneration: string;
}): RelayWriteStatus | undefined {
  if (!record(value) || !keys(value, ['operation_id', 'operation_generation', 'request_id',
    'runtime_generation', 'writer_instance_id', 'tenant_id', 'alias', 'container_id', 'state', 'files'])
    || value.operation_id !== expected.operationId || value.request_id !== expected.operationId
    || value.operation_generation !== expected.generation || value.runtime_generation !== expected.runtimeGeneration
    || value.tenant_id !== expected.tenantId || value.alias !== expected.alias
    || typeof value.writer_instance_id !== 'string' || !UUID_ANY_PATTERN.test(value.writer_instance_id)
    || typeof value.container_id !== 'string' || value.container_id.length === 0
    || !['writing', 'done', 'unknown'].includes(String(value.state))
    || !Array.isArray(value.files) || value.files.length > 7) return undefined;
  const seen = new Set<string>();
  for (const file of value.files) {
    if (!record(file) || !keys(file, ['path', 'sha', 'bytes'])
      || typeof file.path !== 'string' || !file.path.startsWith('/') || file.path.includes('\0')
      || file.path === '/' || file.path.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')
      || Buffer.byteLength(file.path) > 4096 || seen.has(file.path)
      || (file.sha !== null && (typeof file.sha !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha)))
      || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0
      || (file.sha === null && file.bytes !== 0)) return undefined;
    seen.add(file.path);
  }
  return value as unknown as RelayWriteStatus;
}
