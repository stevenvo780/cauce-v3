import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AckSchema, PublishMessageSchema } from '@cauce/protocol';

describe('versioned protocol schemas', () => {
  it('accepts the complete V3 correlation contract', () => {
    const parsed = PublishMessageSchema.parse({
      version: '3.0', request_id: randomUUID(), trace_id: 'trace-1',
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
      body: { text: 'hola' }, idempotency_key: 'idem-1',
      origin: { adapter: 'telegram', channel: 'dm', conversation_id: '42' }
    });
    expect(parsed.version).toBe('3.0');
    expect(parsed.origin?.metadata).toEqual({});
  });

  it.each(['accepted', 'started', 'done', 'failed'])('distinguishes ACK %s', (status) => {
    expect(AckSchema.parse({
      status, instance_id: 'i-1', epoch: 1, event_id: randomUUID(),
      claim_token: randomUUID(), attempt: 1
    }).status).toBe(status);
  });

  it('rejects unknown tenants and protocol versions', () => {
    expect(() => PublishMessageSchema.parse({ version: '2.0' })).toThrow();
  });
});
