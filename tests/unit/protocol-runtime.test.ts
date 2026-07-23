import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeliveryEnvelopeSchema, OriginSchema, QueryDeliveriesSchema, WsOutboundSchema
} from '@cauce/protocol';

describe('protocol v3 runtime envelopes', () => {
  it('validates all correlation identifiers on a delivery', () => {
    const delivery = DeliveryEnvelopeSchema.parse({
      type: 'delivery',
      version: '3.0',
      event_id: randomUUID(),
      delivery_id: randomUUID(),
      message_id: randomUUID(),
      request_id: randomUUID(),
      trace_id: '00-a-distributed-trace',
      epoch: 7,
      attempt: 2,
      claim_token: randomUUID(),
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
      tenant_id: 'Steven',
      room_id: 'grp.steven',
      actor_alias: 'kant',
      recipient_alias: 'salva',
      body: { text: 'hola' },
      origin: { adapter: 'telegram', channel: 'dm', conversation_id: '42' }
    });

    expect(WsOutboundSchema.parse(delivery)).toEqual(delivery);
    expect(delivery.origin).toMatchObject({ relay: [], metadata: {} });
  });

  it('is strict and rejects malformed IDs or unknown fields', () => {
    expect(DeliveryEnvelopeSchema.safeParse({ type: 'delivery', delivery_id: 'not-a-uuid' }).success).toBe(false);
    expect(OriginSchema.safeParse({
      adapter: 'telegram', channel: 'dm', conversation_id: '42', injected: true
    }).success).toBe(false);
  });

  it('bounds HTTP delivery queries', () => {
    expect(QueryDeliveriesSchema.parse({ instance_id: 'consumer-1', epoch: 1 }).limit).toBe(20);
    expect(QueryDeliveriesSchema.safeParse({ instance_id: 'consumer-1', epoch: 1, limit: 101 }).success).toBe(false);
  });
});
