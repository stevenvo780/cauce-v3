import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpGovernanceRelayClient } from './relay-governance-client.js';

const fixture = vi.hoisted((): { body: string; payload: string; options: RequestOptions } => ({ body: '', payload: '', options: {} }));
vi.mock('node:https', () => ({
  request: (_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    fixture.options = options;
    const request = new EventEmitter();
    return Object.assign(request, {
      setTimeout: () => undefined,
      write: (payload: Buffer) => { fixture.payload = payload.toString('utf8'); },
      end: () => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, destroy: () => undefined });
        queueMicrotask(() => {
          callback(response as unknown as IncomingMessage);
          response.emit('data', Buffer.from(fixture.body));
          response.emit('end');
        });
      },
      destroy: (error: Error) => { request.emit('error', error); },
    });
  },
}));

const operation = { operationId: randomUUID(), operationToken: randomUUID(),
  operationGeneration: randomUUID(), runtimeGeneration: 'runtime-one' };
const receipt = { operation_id: operation.operationId, request_id: operation.operationId,
  operation_generation: operation.operationGeneration, runtime_generation: 'runtime-one',
  writer_instance_id: randomUUID(), tenant_id: 'TenantA', alias: 'agent', container_id: 'container-one',
  state: 'done', files: [{ path: '/home/fixture/CLAUDE.md', sha: 'a'.repeat(64), bytes: 10 }] };
const client = (): HttpGovernanceRelayClient => new HttpGovernanceRelayClient({ relayUrl: 'https://localhost', token: 'fixture-only' });
const status = (): ReturnType<HttpGovernanceRelayClient['writeStatus']> => client().writeStatus(
  'TenantA', 'agent', operation.operationId, operation.operationToken, operation.operationGeneration,
  operation.operationId, operation.runtimeGeneration);

beforeEach(() => { fixture.payload = ''; fixture.body = JSON.stringify(receipt); });
describe('governance HTTP client exact durable contract', () => {
  it('sends five flat status fields and returns validated receipt', async () => {
    expect(await status()).toEqual(receipt);
    expect(JSON.parse(fixture.payload)).toEqual({ tenant_id: 'TenantA', alias: 'agent',
      operation_id: operation.operationId, operation_token: operation.operationToken,
      operation_generation: operation.operationGeneration, request_id: operation.operationId,
      runtime_generation: operation.runtimeGeneration });
  });
  it.each(['alias', 'tenant_id', 'request_id', 'writer_instance_id', 'files'])('rejects forged %s', async (field) => {
    fixture.body = JSON.stringify({ ...receipt, [field]: null });
    expect(await status()).toMatchObject({ error: 'unknown' });
  });
  it('does not accept legacy ACK as quiescence', async () => {
    fixture.body = JSON.stringify({ path: receipt.files[0]?.path, sha: 'a'.repeat(64), bytes: 10, operation: 'replace' });
    expect(await status()).toMatchObject({ error: 'unknown' });
  });
  it('requires receipt and preserves exactly nested write identity', async () => {
    fixture.body = JSON.stringify({ request_id: operation.operationId, path: '/home/fixture/CLAUDE.md',
      operation: 'replace', sha: 'a'.repeat(64), bytes: 10, receipt });
    const controller = new AbortController();
    expect(await client().writeFileDurable('TenantA', 'agent', '/home/fixture/CLAUDE.md', 'fixture',
      { state: 'present', sha256: 'b'.repeat(64) }, { ...operation, signal: controller.signal },
      { generation: 'runtime-one', containerId: 'container-one', path: '/home/fixture/CLAUDE.md' })).toMatchObject({ operation: 'replace' });
    const payload = JSON.parse(fixture.payload) as { operation: Record<string, unknown> };
    expect(Object.keys(payload.operation).sort()).toEqual(['operation_generation', 'operation_id', 'operation_token', 'request_id', 'runtime_generation']);
    expect(payload.operation.request_id).toBe(operation.operationId);
    expect(fixture.options.signal).toBe(controller.signal);
  });
  it('rejects a write ACK with no durable receipt', async () => {
    fixture.body = JSON.stringify({ path: '/home/fixture/CLAUDE.md', operation: 'replace', sha: 'a'.repeat(64), bytes: 10 });
    expect(await client().writeFileDurable('TenantA', 'agent', '/home/fixture/CLAUDE.md', 'fixture',
      { state: 'present', sha256: 'b'.repeat(64) }, operation,
      { generation: 'runtime-one', containerId: 'container-one', path: '/home/fixture/CLAUDE.md' })).toMatchObject({ error: 'unknown' });
  });
});
