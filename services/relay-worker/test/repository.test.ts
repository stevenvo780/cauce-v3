import { describe, expect, it } from 'vitest';
import { StoreOriginRelayRepository } from '../src/repository.js';

function claimedRow(): Record<string, unknown> {
  return {
    id: 'event-1', event_id: 'event-1', attempts: 1, max_attempts: 3,
    claim_token: 'opaque-claim', tenant_id: 'Steven', adapter: 'webhook-x',
    request_id: 'request-1', message_id: 'message-1', delivery_id: null, trace_id: 'trace-1',
    origin: { adapter: 'webhook-x', channel: 'dm', conversation_id: 'conversation', relay: [], metadata: {} },
    payload: { outcome: 'done' }
  };
}

describe('StoreOriginRelayRepository fenced ACK', () => {
  it('rejects ackOutbox applied=false instead of treating it as delivery', async () => {
    const store = {
      async claimOutbox() { return [claimedRow()]; },
      async ackOutbox() { return { status: 'failed' as const, applied: false }; }
    };
    const repository = new StoreOriginRelayRepository(store);
    const [event] = await repository.claim('worker', 1, 30_000, 'webhook-x');

    await expect(repository.ack({
      event_id: event!.event_id, attempt: event!.attempt, claim_token: event!.claim_token, status: 'sent'
    })).rejects.toThrow('fenced');
  });

  it('rejects a mismatched durable status even if applied=true', async () => {
    const store = {
      async claimOutbox() { return [claimedRow()]; },
      async ackOutbox() { return { status: 'sent' as const, applied: true }; }
    };
    const repository = new StoreOriginRelayRepository(store);
    const [event] = await repository.claim('worker', 1, 30_000, 'webhook-x');

    await expect(repository.ack({
      event_id: event!.event_id, attempt: event!.attempt, claim_token: event!.claim_token,
      status: 'retry', retry_after_ms: 1
    })).rejects.toThrow('fenced');
  });
});
