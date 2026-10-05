import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeliveryEnvelopeSchema, HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { consoleIntent, HUMAN_PUBLISH_SCOPE, publishCommand, publishOptions,
  registerHumanPublishSuite } from './human-publish-authority-postgres.fixtures.js';
import { ackWith, terminalAck } from './helpers/consumer.js';
import {
  claimConsumer, claims, databasePool, deliverySnapshot, fairnessSnapshot, getRepository,
  nextClaim, publishRoot, seedHumanPublishActor, waitForLedgerLock, withLedgerView,
} from './human-message-claims-postgres.fixtures.js';

registerHumanPublishSuite(import.meta.url);

async function publishConsoleRoot(account: Awaited<ReturnType<typeof seedHumanPublishActor>>) {
  const intent = consoleIntent(account);
  const options = publishOptions(account);
  const { humanAuthority, signal } = options;
  if (humanAuthority === undefined || signal === undefined) throw new Error('console authority missing');
  const prepared = await getRepository().prepareConsolePublishIntent(intent, HUMAN_PUBLISH_SCOPE, { humanAuthority, signal });
  if (prepared.state !== 'prepared') throw new Error('console intent was not prepared');
  const receipt = await getRepository().publish(publishCommand(intent, prepared.idempotency_key,
    { authenticated_context: intent.authenticated_context }), options);
  const ledger = await databasePool().query<{ conversation_id: string }>(
    'SELECT conversation_id FROM human_message_initiators WHERE message_id=$1', [receipt.message_id]);
  const row = ledger.rows[0];
  if (row === undefined) throw new Error('console root ledger missing');
  return { receipt, initiator: { human_id: account.humanId, tenant_id: 'Steven',
    root_message_id: receipt.message_id, conversation_id: row.conversation_id } };
}

describe('human initiator envelopes from real durable publication and claims', () => {
  it('distinguishes two humans sharing the same actor alias and whitelists the wire fields', async () => {
    const first = await seedHumanPublishActor();
    const second = await seedHumanPublishActor(first.alias);
    const roots = [await publishRoot(first), await publishRoot(second)];
    const target = await claimConsumer();
    const deliveries = await claims(target);
    expect(deliveries).toHaveLength(2);
    for (const root of roots) {
      const delivery = deliveries.find((item) => item.message_id === root.receipt.message_id);
      expect(delivery?.human_initiator).toEqual(root.initiator);
      expect(delivery?.actor_alias).toBe(first.alias);
      expect(Object.keys(delivery?.human_initiator ?? {}).sort()).toEqual(
        ['conversation_id', 'human_id', 'root_message_id', 'tenant_id'],
      );
      expect(DeliveryEnvelopeSchema.safeParse(delivery).success).toBe(true);
    }
    expect(roots[0]?.initiator.human_id).not.toBe(roots[1]?.initiator.human_id);
  });

  it.each([{ capabilities: [] }, { capabilities: ['console_human_scope_v1'] },
    { capabilities: ['human_mcp_scope_v1'] }, { capabilities: ['human_message_initiator_v10'] }])(
    'retains MCP roots until the locked lease negotiates the modern capability $capabilities', async ({ capabilities }) => {
      const first = await seedHumanPublishActor();
      const second = await seedHumanPublishActor(first.alias);
      const roots = [await publishRoot(first), await publishRoot(second)];
      const before = await Promise.all(roots.map((root) => deliverySnapshot(root.receipt.message_id)));
      expect(before.every((rows) => rows.every((row) => row.status === 'pending' && row.attempt === 0))).toBe(true);
      const ordinary = await getRepository().publish({
        version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: 'Steven',
        room_id: 'grp.steven', actor_alias: first.alias,
        recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'ordinary compatibility' },
        lane: 'interactive', priority: 1, idempotency_key: randomUUID(),
      });
      const target = await claimConsumer('argos', capabilities);
      const compatible = await claims(target);
      expect(compatible.map((delivery) => delivery.message_id)).toEqual([ordinary.message_id]);
      expect(await Promise.all(roots.map((root) => deliverySnapshot(root.receipt.message_id)))).toEqual(before);
      const resumed = await getRepository().acquireLease(target.tenant, target.alias, target.instanceId,
        [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000, { resume: true });
      expect(resumed.epoch).toBe(target.epoch);
      await expect(claims(target)).rejects.toMatchObject({ code: 'fenced' });
      if (resumed.connection_token === undefined) throw new Error('resumed lease token missing');
      target.connectionToken = resumed.connection_token;
      const isolated = await claims(target);
      expect(isolated).toHaveLength(2);
      for (const root of roots) {
        expect(isolated.find((delivery) => delivery.message_id === root.receipt.message_id)?.human_initiator)
          .toEqual(root.initiator);
      }
      expect(new Set(isolated.map((delivery) => delivery.human_initiator?.human_id)).size).toBe(2);
    },
  );

  it('keeps the initiating tenant distinct from the cross-tenant receiver', async () => {
    const root = await publishRoot(await seedHumanPublishActor(), 'Isa');
    const target = await claimConsumer('salva', [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 'Isa');
    const delivery = await nextClaim(target, root.receipt.message_id);
    expect(delivery.human_initiator).toEqual(root.initiator);
    expect(delivery.recipient_alias).toBe('salva');
    expect(target.tenant).not.toBe(delivery.human_initiator?.tenant_id);
    expect(delivery.actor_alias).not.toBe(delivery.recipient_alias);
    await ackWith(getRepository(), target, delivery, { messages: [{ to: 'socrates', body: 'cross-tenant work' }] });
    const child = await nextClaim(await claimConsumer('socrates'));
    expect(child).toMatchObject({ tenant_id: 'Isa', actor_alias: 'salva', recipient_alias: 'socrates' });
    expect(child.human_initiator).toEqual(root.initiator);
    expect(child.tenant_id).not.toBe(child.human_initiator?.tenant_id);
  });

  it.each([
    { capabilities: [] }, { capabilities: ['human_message_initiator_v10'] },
    { capabilities: ['HUMAN_MESSAGE_INITIATOR_V1'] }, { capabilities: ['prefix_human_message_initiator_v1'] },
  ])(
    'omits the property for compatible console deliveries with unsupported capabilities $capabilities', async ({ capabilities }) => {
      const root = await publishConsoleRoot(await seedHumanPublishActor());
      const delivery = await nextClaim(await claimConsumer('argos', capabilities), root.receipt.message_id);
      expect(Object.hasOwn(delivery, 'human_initiator')).toBe(false);
      expect(DeliveryEnvelopeSchema.safeParse(delivery).success).toBe(true);
    },
  );

  it('uses the resumed console lease capability set and fences the earlier connection token', async () => {
    const account = await seedHumanPublishActor();
    const target = await claimConsumer('argos', []);
    const first = await publishConsoleRoot(account);
    const delivery = await nextClaim(target, first.receipt.message_id);
    expect(Object.hasOwn(delivery, 'human_initiator')).toBe(false);
    await ackWith(getRepository(), target, delivery);
    for (const capabilities of [[HUMAN_MESSAGE_INITIATOR_CAPABILITY], []]) {
      const root = await publishConsoleRoot(account);
      const resumed = await getRepository().acquireLease(target.tenant, target.alias, target.instanceId,
        capabilities, 60_000, { resume: true });
      expect(resumed.epoch).toBe(target.epoch);
      expect(resumed.connection_token).not.toBe(target.connectionToken);
      await expect(claims(target)).rejects.toMatchObject({ code: 'fenced' });
      if (resumed.connection_token === undefined) throw new Error('resumed lease token missing');
      target.connectionToken = resumed.connection_token;
      const next = await nextClaim(target, root.receipt.message_id);
      if (capabilities.length === 0) expect(Object.hasOwn(next, 'human_initiator')).toBe(false);
      else expect(next.human_initiator).toEqual(root.initiator);
      await ackWith(getRepository(), target, next);
    }
  });

  it('omits legacy identity despite a matching alias and forged body, origin and trace', async () => {
    const account = await seedHumanPublishActor();
    const forged = { human_id: account.humanId, tenant_id: 'Steven',
      root_message_id: randomUUID(), conversation_id: 'forged' };
    const receipt = await getRepository().publish({
      version: '3.0', request_id: randomUUID(), trace_id: account.humanId,
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: account.alias,
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'legacy message', human_initiator: forged, permissions: ['control'] },
      origin: { adapter: 'telegram', channel: 'dm', conversation_id: forged.conversation_id,
        metadata: { human_id: account.humanId }, relay: [] },
      lane: 'interactive', priority: 1, idempotency_key: randomUUID(),
    });
    const delivery = await nextClaim(await claimConsumer(), receipt.message_id);
    expect(Object.hasOwn(delivery, 'human_initiator')).toBe(false);
    expect(delivery.body.human_initiator).toEqual(forged);
    expect((await databasePool().query(
      'SELECT 1 FROM human_message_initiators WHERE message_id=$1', [receipt.message_id],
    )).rowCount).toBe(0);
  });

  it('preserves the real root through output, nested delegation and both response continuations', async () => {
    const root = await publishRoot(await seedHumanPublishActor());
    const parent = await claimConsumer();
    const rootDelivery = await nextClaim(parent, root.receipt.message_id);
    const repository = getRepository();
    await ackWith(repository, parent, rootDelivery, { messages: [{ to: 'kant', body: 'ordinary delegation' }] });
    const child = await claimConsumer('kant');
    const childDelivery = await nextClaim(child);
    expect(childDelivery.human_initiator).toEqual(root.initiator);
    expect(childDelivery.actor_alias).toBe('argos');
    await ackWith(repository, child, childDelivery, { messages: [{ to: 'socrates', body: 'nested work' }] });
    const leaf = await claimConsumer('socrates');
    const leafDelivery = await nextClaim(leaf);
    expect(leafDelivery.human_initiator).toEqual(root.initiator);
    await ackWith(repository, leaf, leafDelivery);
    const continuation = await nextClaim(child);
    expect(continuation.body.type).toBe('agent.response');
    expect(continuation.human_initiator).toEqual(root.initiator);
    await ackWith(repository, child, continuation);
    const response = await nextClaim(parent);
    expect(response.body.type).toBe('agent.response');
    expect(response.human_initiator).toEqual(root.initiator);
    await ackWith(repository, parent, response);
  });

  it('preserves the original initiator through a real human gate answer', async () => {
    const account = await seedHumanPublishActor();
    const root = await publishRoot(account);
    await databasePool().query("UPDATE agent_chain_policies SET human_gate_enabled=true WHERE id='default'");
    const target = await claimConsumer();
    const delivery = await nextClaim(target, root.receipt.message_id);
    await ackWith(getRepository(), target, delivery, { messages: [{ to: '@human', body: 'Continue?' }] });
    const gates = await databasePool().query<{ id: string }>(
      'SELECT id FROM agent_chain_gates WHERE source_delivery_id=$1', [delivery.delivery_id],
    );
    const gate = gates.rows[0];
    if (gate === undefined) throw new Error('real ACK did not open its gate');
    const answer = await getRepository().answerChainGate(gate.id, 'Continue', 'Steven', account.alias);
    const messageId = answer.resume_message_id;
    if (typeof messageId !== 'string') throw new Error('gate answer did not create its resumed message');
    const resumed = await nextClaim(target, messageId);
    expect(resumed.human_initiator).toEqual(root.initiator);
    expect(resumed.actor_alias).toBe('argos');
    expect(resumed.message_id).not.toBe(root.receipt.message_id);
  });

  it('preserves the original initiator through an ordinary failed-delivery replay', async () => {
    const account = await seedHumanPublishActor();
    const root = await publishRoot(account);
    const target = await claimConsumer();
    const delivery = await nextClaim(target, root.receipt.message_id);
    const ack = terminalAck(delivery, target);
    ack.status = 'failed'; ack.error_code = 'PROCESS_EXIT'; ack.error = 'ordinary fixture failure';
    expect((await getRepository().ackDelivery(delivery.delivery_id, target.tenant, target.alias, ack)).applied).toBe(true);
    const replay = await getRepository().replayDelivery(delivery.delivery_id, 'Steven', account.alias);
    const deliveryId = replay.delivery_id;
    if (typeof deliveryId !== 'string') throw new Error('replay did not create its delivery');
    const cloned = (await claims(target)).find((item) => item.delivery_id === deliveryId);
    if (cloned === undefined) throw new Error('replayed delivery was not claimable');
    expect(cloned.human_initiator).toEqual(root.initiator);
    expect(cloned.actor_alias).toBe(account.alias);
    expect(cloned.message_id).not.toBe(root.receipt.message_id);
  });
});

describe('human initiator claim transaction failure boundaries', () => {
  it('does not read the console ledger when the locked lease lacks the capability', async () => {
    const root = await publishConsoleRoot(await seedHumanPublishActor());
    const target = await claimConsumer('argos', []);
    await withLedgerView(false, async () => {
      expect(Object.hasOwn(await nextClaim(target, root.receipt.message_id), 'human_initiator')).toBe(false);
    });
  });

  it.each(['sql', 'schema'] as const)('rolls back delivery and fairness after a real %s error', async (kind) => {
    const root = await publishRoot(await seedHumanPublishActor());
    const target = await claimConsumer();
    const before = await deliverySnapshot(root.receipt.message_id);
    const fairness = await fairnessSnapshot(target);
    await withLedgerView(kind === 'schema', async () => {
      if (kind === 'sql') await expect(claims(target)).rejects.toMatchObject({ code: '42P01' });
      else await expect(claims(target)).rejects.toMatchObject({ name: 'ZodError' });
      expect(await deliverySnapshot(root.receipt.message_id)).toEqual(before);
      expect(await fairnessSnapshot(target)).toEqual(fairness);
    });
    expect((await nextClaim(target, root.receipt.message_id)).human_initiator).toEqual(root.initiator);
  });

  it('physically cancels a blocked ledger read and rolls back the preceding claim', async () => {
    const root = await publishRoot(await seedHumanPublishActor());
    const target = await claimConsumer();
    const before = await deliverySnapshot(root.receipt.message_id);
    const fairness = await fairnessSnapshot(target);
    const blocker = await databasePool().connect();
    const controller = new AbortController();
    const reason = new Error('cancelled human initiator claim');
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE human_message_initiators IN ACCESS EXCLUSIVE MODE');
      const settled = claims(target, controller.signal).then(
        () => ({ error: undefined }), (error: unknown) => ({ error }),
      );
      const pid = await waitForLedgerLock();
      controller.abort(reason);
      expect((await settled).error).toBe(reason);
      expect(await deliverySnapshot(root.receipt.message_id)).toEqual(before);
      expect(await fairnessSnapshot(target)).toEqual(fairness);
      expect((await databasePool().query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid])).rowCount).toBe(0);
    } finally {
      controller.abort(reason);
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await nextClaim(target, root.receipt.message_id)).human_initiator).toEqual(root.initiator);
  });
});
