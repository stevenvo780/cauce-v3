import { describe, expect, it } from 'vitest';
import { NativeAdminChannel } from './native-admin-wire.js';
import { NativeAdminCommandSchema, NativePieceMutationSchema, type NativeAdminCommand } from '@cauce/protocol';
const command: NativeAdminCommand = { op: 'list', kind: 'skill', request_id: '00000000-0000-4000-8000-000000000061',
  identity: { generation: 'generation', container_id: 'container', writer_instance_id: '00000000-0000-4000-8000-000000000062' } };
describe('native administration wire', () => {
  it('correlates a strict reply and rejects unknown fields that could carry private data', async () => {
    const wire = new NativeAdminChannel(() => true); const pending = wire.request(command, 1000);
    wire.receive({ request_id: command.request_id, outcome: { type: 'inventory', kind: 'skill', items: [], truncated: false, raw_config: 'PRIVATE' } });
    expect(await pending).toEqual({ type: 'error', error: 'unavailable' });
  });
  it('closes pending requests immediately when the measured agent leaves', async () => {
    const wire = new NativeAdminChannel(() => true); const pending = wire.request(command, 1000); wire.close();
    expect(await pending).toEqual({ type: 'error', error: 'unavailable' });
  });
  it('refuses duplicate request ids without dropping the first waiter', async () => {
    const wire = new NativeAdminChannel(() => true); const pending = wire.request(command, 1000);
    expect(await wire.request(command, 1000)).toEqual({ type: 'error', error: 'unavailable' });
    wire.receive({ request_id: command.request_id, outcome: { type: 'inventory', kind: 'skill', items: [], truncated: false } });
    expect(await pending).toMatchObject({ type: 'inventory' });
  });
  it('fails closed and clears correlation when the physical send throws', async () => {
    let failed = true; const wire = new NativeAdminChannel(() => { if (failed) throw new Error('PRIVATE'); return true; });
    expect(await wire.request(command, 1000)).toEqual({ type: 'error', error: 'unavailable' });
    failed = false; const pending = wire.request(command, 1000); wire.close();
    expect(await pending).toEqual({ type: 'error', error: 'unavailable' });
  });
  it('rejects browser paths, raw bearer tokens and CAS-free deletes', () => {
    expect(NativeAdminCommandSchema.safeParse({ ...command, path: '/tmp/auth.json' }).success).toBe(false);
    expect(NativePieceMutationSchema.safeParse({ kind: 'mcp', id: 'native-proof', action: 'put', expected_sha: null,
      value: { mcp: { url: 'https://example.invalid/mcp', token: 'PRIVATE' } } }).success).toBe(false);
    expect(NativePieceMutationSchema.safeParse({ kind: 'skill', id: 'native-proof', action: 'delete', expected_sha: null }).success).toBe(false);
  });
  it('uses the same canonical UUIDv4 contract as the physical Python writer', () => {
    for (const request_id of ['00000000-0000-1000-8000-000000000061', 'AAAAAAAA-0000-4000-8000-000000000061']) {
      expect(NativeAdminCommandSchema.safeParse({ ...command, request_id }).success).toBe(false);
      expect(NativeAdminCommandSchema.safeParse({ ...command, op: 'mutate', mutation: { kind: 'skill', id: 'native-proof', action: 'put', expected_sha: null,
        value: { content: 'fixture' } }, operation: { operation_id: request_id, operation_token: command.request_id, operation_generation: command.request_id } }).success).toBe(false);
    }
  });
});
