import { describe, expect, it } from 'vitest';
import {
  ackWith, CHAT_ID, claim, command, createDestination, grantNotifyRole, notifyOutput, pool,
  registerEgressSuite, repository, seedPriorContact,
} from './egress-notification-postgres-helpers.js';

registerEgressSuite(import.meta.url);

describe('agent egress historical channel', () => {
  it('projects the outbox origin channel and drops the receipt when that evidence is gone', async () => {
    await grantNotifyRole('argos');
    await createDestination({ channel: 'dm', handle: 'steven.dm' });
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'alert', body: 'aviso por canal dm' },
      ])),
    );

    const listed = await repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.destination).toMatchObject({
      adapter: 'telegram', channel: 'dm', conversation_id: CHAT_ID, handle: 'steven.dm',
    });

    await pool.query(`UPDATE egress_destinations SET channel='group' WHERE handle='steven.dm'`);
    const edited = await repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]);
    expect(edited.items[0]?.destination.channel).toBe('dm');

    await pool.query(
      `UPDATE adapter_outbox SET origin = origin - 'channel'
       WHERE id = (SELECT produced_outbox_id FROM egress_notifications WHERE source_delivery_id=$1)`,
      [delivery.delivery_id],
    );
    const stripped = await repository.listAgentEgress('Steven', 'argos', [delivery.delivery_id]);
    expect(stripped.items).toEqual([]);
  });
});
