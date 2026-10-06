import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildPublishReceipt } from '@cauce/protocol';
import { publishOperation, type PublishOperationInput } from './publish-operation.js';
import type { TrustedPublishCommand } from './routes/shared.js';

const nonce = 'b'.repeat(32);
function operation(): PublishOperationInput {
  return { actor: { tenant_id: 'CompanyA', alias: 'gate-probe', session_id: 'gate-probe', channel: 'gate',
    roles: ['agent'], permissions: ['route', 'read'] }, entry: 'direct', authMechanism: 'mtls',
    priorityLog: { warn: () => undefined, info: () => undefined }, logRedaction: () => undefined,
    body: { room_id: 'source.a', recipients: [{ tenant_id: 'CompanyB', alias: 'operator' }],
      body: { type: 'system.gate.probe', nonce, timeout_ms: 5000 }, lane: 'interactive', priority: -100,
      idempotency_key: `gate:CompanyB:operator:${nonce}` } };
}
function repository() {
  return {
    resolveSystemGateProbeActor: vi.fn(async () => 'configured-runtime'),
    publish: vi.fn(async (input: TrustedPublishCommand) => buildPublishReceipt(input, {
      message_id: randomUUID(), delivery_ids: [randomUUID()], duplicate: false,
      request_id: input.request_id, trace_id: input.trace_id,
    })),
    verifyPublishReceipt: vi.fn(async () => true),
  };
}

describe('generic mTLS gate authority', () => {
  it('uses authenticated tenant and durable actor resolver, preserving least privilege private authority', async () => {
    const store = repository();
    await publishOperation(store, operation());
    expect(store.resolveSystemGateProbeActor).toHaveBeenCalledWith('CompanyA', 'source.a');
    expect(store.publish).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'CompanyA', actor_alias: 'configured-runtime',
      authenticated_context: { session_id: 'gate-probe', channel: 'gate' } }), expect.objectContaining({
      systemGateProbeAuthority: { tenant_id: 'CompanyA', alias: 'gate-probe', session_id: 'gate-probe', channel: 'gate' } }));
  });

  it.each(['auth', 'alias', 'session', 'channel', 'role', 'permission', 'origin'])(
    'rejects forged dedicated identity before resolving durable scope: %s', async (field) => {
      const store = repository();
      const input = operation();
      const forged: PublishOperationInput = {
        ...input, ...(field === 'auth' ? { authMechanism: 'console-password' } : {}),
        actor: { ...input.actor,
          ...(field === 'alias' ? { alias: 'operator' } : {}),
          ...(field === 'session' ? { session_id: 'forged' } : {}),
          ...(field === 'channel' ? { channel: 'adapter' } : {}),
          ...(field === 'role' ? { roles: ['operator'] as const } : {}),
          ...(field === 'permission' ? { permissions: ['route', 'read', 'control'] as const } : {}),
          ...(field === 'origin' ? { origin: { adapter: 'telegram', channel: 'telegram', conversation_id: '123', relay: [], metadata: {} } } : {}),
        },
      };
      await expect(publishOperation(store, forged)).rejects.toThrow();
      expect(store.resolveSystemGateProbeActor).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
    },
  );
});
