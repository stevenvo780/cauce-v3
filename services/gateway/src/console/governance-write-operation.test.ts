import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { governanceOperationPayload, validatedWriteStatus } from './governance-write-operation.js';

const operationId = randomUUID();
const generation = randomUUID();
const expected = { tenantId: 'TenantA', alias: 'agent', operationId, generation, runtimeGeneration: 'runtime-one' };
const receipt = { operation_id: operationId, operation_generation: generation, request_id: operationId,
  runtime_generation: 'runtime-one', writer_instance_id: randomUUID(), tenant_id: 'TenantA', alias: 'agent',
  container_id: 'container-one', state: 'done', files: [{ path: '/home/fixture/CLAUDE.md', sha: 'a'.repeat(64), bytes: 10 }] };

describe('governance operation strict wire boundary', () => {
  it('serializes five fields and never serializes signal', () => {
    const operationToken = randomUUID();
    expect(governanceOperationPayload({ operationId, operationToken, operationGeneration: generation,
      runtimeGeneration: 'runtime-one', signal: new AbortController().signal })).toEqual({
      operation_id: operationId, operation_token: operationToken, operation_generation: generation,
      request_id: operationId, runtime_generation: 'runtime-one',
    });
  });
  it('accepts exact authenticated receipt shape', () => {
    expect(validatedWriteStatus(receipt, expected)).toEqual(receipt);
  });
  it.each([
    ['request_id', randomUUID()], ['tenant_id', 'TenantB'], ['alias', 'foreign'],
    ['operation_id', randomUUID()], ['operation_generation', randomUUID()],
    ['runtime_generation', 'other'], ['writer_instance_id', 'not-a-uuid'], ['state', 'failed_before_effect'],
    ['container_id', ''], ['state', true], ['files', null],
  ])('rejects malformed or foreign %s', (key, value) => {
    expect(validatedWriteStatus({ ...receipt, [key]: value }, expected)).toBeUndefined();
  });
  it.each([
    ...['/', '/home//file', '/home/../file', '/home/./file', 'relative', '/home/file\0'].map((path) => ({ files: [{ ...receipt.files[0], path }] })),
    { files: [{ ...receipt.files[0], bytes: -1 }] }, { files: [{ ...receipt.files[0], bytes: 1.5 }] },
    { files: [{ ...receipt.files[0], sha: 'not-sha' }] }, { files: [{ ...receipt.files[0], operation: 'replace' }] },
    { files: [receipt.files[0], receipt.files[0]] }, { files: [{ ...receipt.files[0], sha: null, bytes: 10 }] },
  ])('rejects invalid file evidence $files', ({ files }) => {
    expect(validatedWriteStatus({ ...receipt, files }, expected)).toBeUndefined();
  });
  it('rejects unexpected top-level metadata', () => {
    expect(validatedWriteStatus({ ...receipt, token: 'private' }, expected)).toBeUndefined();
  });
});
