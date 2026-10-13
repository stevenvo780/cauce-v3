import { describe, expect, it } from 'vitest';
import type { InboxRecord } from '../../adapter-sdk/src/sdk/durable-store.js';
import { HttpEgressReceiptSource } from '../../adapter-sdk/src/sdk/egress-receipt-source.js';
import { pertinentNotices, type NoticeScope } from '../../adapter-sdk/src/sdk/notify-history.js';
import {
  ackWith, CHAT_ID, claim, command, createDestination, grantNotifyRole, notifyOutput, pool,
  registerEgressSuite, repository, seedPriorContact,
} from './egress-notification-postgres-helpers.js';

registerEgressSuite(import.meta.url);

describe('agent egress historical channel', () => {
  it.each(['dm', ' dm ', 'telegram'])('preserves historical channel %j through PostgreSQL and the SDK', async (channel) => {
    await grantNotifyRole('argos');
    await createDestination({ channel, handle: 'steven.dm' });
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    const body = 'aviso por el canal histórico';
    const notify = [{ to: 'steven.dm', kind: 'alert' as const, body }];
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput(notify)),
    );

    const listed = await repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.destination).toMatchObject({
      adapter: 'telegram', channel, conversation_id: CHAT_ID, handle: 'steven.dm',
    });

    const record: InboxRecord = {
      delivery_id: delivery.delivery_id, fingerprint: '0'.repeat(64), epoch, attempt: delivery.attempt,
      claim_token: delivery.claim_token, state: 'done', origin: undefined, updated_at: new Date().toISOString(),
      output: { reply: null, messages: [], notify, status: 'done', retryable: false, artifacts: [] },
    };
    const scope: NoticeScope = { tenant_id: 'Steven', alias: 'argos', adapter: 'telegram',
      channel, conversation_id: CHAT_ID };
    const source = new HttpEgressReceiptSource(
      async () => repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]), scope,
    );
    async function assertChannelIsolation(): Promise<void> {
      const receipts = await source.read(scope, [delivery.delivery_id], new AbortController().signal);
      const now = Date.now() + 1000;
      expect(pertinentNotices([record], scope, receipts, now).records.map(item => item.body)).toEqual([body]);
      for (const foreignChannel of ['telegram', 'dm', ' dm ', 'group'].filter(value => value !== channel)) {
        expect(pertinentNotices([record], { ...scope, channel: foreignChannel }, receipts, now).records).toEqual([]);
      }
    }
    await assertChannelIsolation();

    await pool.query(`UPDATE egress_destinations SET channel='group' WHERE handle='steven.dm'`);
    const edited = await repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]);
    expect(edited.items[0]?.destination.channel).toBe(channel);
    await assertChannelIsolation();

    await pool.query(
      `UPDATE adapter_outbox SET origin = origin - 'channel'
       WHERE id = (SELECT produced_outbox_id FROM egress_notifications WHERE source_delivery_id=$1)`,
      [delivery.delivery_id],
    );
    const stripped = await repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]);
    expect(stripped.items).toEqual([]);
    const receipts = await source.read(scope, [delivery.delivery_id], new AbortController().signal);
    expect(pertinentNotices([record], scope, receipts).records).toEqual([]);
  });
});
