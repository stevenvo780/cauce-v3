import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WsOutboundSchema } from '../src/index.js';

describe('WebSocket ACK result receipts', () => {
  const receiptFrame = {
    type: 'ack_result',
    event_id: randomUUID(),
    delivery_id: randomUUID(),
    attempt: 1,
    claim_token: randomUUID(),
    status: 'started',
    applied: true
  } as const;

  it.each(['applied', 'duplicate', 'superseded', 'ownership_lost'] as const)(
    'accepts the %s receipt',
    (receipt) => {
      expect(WsOutboundSchema.parse({ ...receiptFrame, receipt })).toMatchObject({ receipt });
    }
  );

  it('rejects an unknown receipt', () => {
    expect(WsOutboundSchema.safeParse({
      ...receiptFrame,
      receipt: 'renewed'
    }).success).toBe(false);
  });
});
