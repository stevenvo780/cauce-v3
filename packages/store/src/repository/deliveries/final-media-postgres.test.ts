import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHumanReadAuthority } from '../../../../../services/gateway/src/human-mcp-authority.js';
import { recent, seedTenantHuman } from '../../../test/human-inbox-postgres.fixtures.js';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { ackEnvelope } from '../../../test/helpers/consumer.js';
import { consoleIntent, HUMAN_PUBLISH_SCOPE, publishCommand } from '../../../test/human-publish-authority-postgres.fixtures.js';
import { databasePool, getRepository, humanOptions, humanPublishOptions, seededHuman, verifiedIdentity } from '../../../test/human-owned-receipt-postgres.fixtures.js';

const bytes = Buffer.from([0, 1, 127, 128, 255]);
async function fixture(mime = 'audio/mpeg', reply: string | null = null, console = true) {
  const account = await seededHuman(); const repository = getRepository();
  const intent = consoleIntent(account); const options = humanPublishOptions(account);
  const prepared = await repository.prepareConsolePublishIntent(intent, HUMAN_PUBLISH_SCOPE, humanOptions(account, 'publish'));
  if (prepared.state !== 'prepared') throw new Error('expected prepared intent');
  const root = await repository.publish(publishCommand(intent, prepared.idempotency_key, {
    authenticated_context: { session_id: `console-media-${randomUUID()}`, channel: console ? 'console' : 'human-mcp' },
  }), options);
  const instance = `media-${randomUUID()}`;
  const lease = await repository.acquireLease('Steven', 'argos', instance, [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000, { resume: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) throw new Error('missing lease');
  const deliveries = await repository.claimDeliveries('Steven', 'argos', instance, lease.epoch, 10, 30_000, 3, {}, lease.connection_token);
  const delivery = deliveries.find((item) => item.message_id === root.message_id);
  if (!delivery) throw new Error('root delivery not claimed');
  const ack = ackEnvelope(delivery, { instanceId: instance, epoch: lease.epoch }, {
    reply_attachments_v1: [{ secret: 'FORGED_FIELD_SENTINEL' }],
    output: { reply, messages: [], status: 'done', artifacts: [{ name: 'answer.bin', uri: `data:${mime};base64,${bytes.toString('base64')}` }] },
  });
  return { account, repository, root, delivery, ack, connectionToken: lease.connection_token };
}
async function persisted(id: string) {
  const result = await databasePool().query<{ result: Record<string, unknown>; status: string }>('SELECT result,status FROM deliveries WHERE id=$1', [id]);
  if (!result.rows[0]) throw new Error('missing durable delivery'); return result.rows[0];
}

describe('final human reply media on PostgreSQL', () => {
  it.each(['image/png', 'audio/mpeg', 'video/mp4'])('persists a true fenced file-only ACK and canonical %s without duplicating bytes', async (mime) => {
    const { repository, account, root, delivery, ack } = await fixture(mime);
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).applied).toBe(true);
    const stored = await persisted(delivery.delivery_id);
    expect(stored.result.reply_attachments_v1).toEqual([expect.objectContaining({ content_base64: bytes.toString('base64'), mime_type: mime })]);
    expect(JSON.stringify(stored.result.output)).not.toContain(bytes.toString('base64'));
    const ackRows = await databasePool().query<{ payload: unknown }>('SELECT payload FROM delivery_acks WHERE delivery_id=$1', [delivery.delivery_id]);
    expect(JSON.stringify(ackRows.rows)).not.toContain(bytes.toString('base64'));
    expect(JSON.stringify(ackRows.rows)).not.toContain('reply_attachments_v1');
    expect(JSON.stringify(ackRows.rows)).not.toContain('FORGED_FIELD_SENTINEL');
    const outbox = await databasePool().query('SELECT payload FROM adapter_outbox WHERE message_id=$1', [root.message_id]);
    expect(JSON.stringify(outbox.rows)).not.toContain(bytes.toString('base64'));
    const detail = await repository.getHumanMessage(root.message_id, humanOptions(account, 'read'));
    expect(detail.deliveries).toEqual([expect.objectContaining({ reply: null, reply_attachments: [expect.objectContaining({ mime_type: mime })],
      reply_attachment_delivery_id: delivery.delivery_id, reply_attachment_attempt: delivery.attempt })]);
    expect(JSON.stringify(detail)).not.toContain('content_base64');
    const inbox = await repository.listHumanInbox(recent(), humanOptions(account, 'read'));
    expect(inbox.items[0]?.deliveries[0]).toMatchObject({ reply_attachment_delivery_id: delivery.delivery_id,
      reply_attachment_attempt: delivery.attempt, reply_attachments: [expect.objectContaining({ mime_type: mime })] });
    expect(JSON.stringify(inbox)).not.toContain('content_base64');
    const download = await repository.getReplyAttachments(root.message_id, delivery.delivery_id, delivery.attempt, humanOptions(account, 'read'));
    expect(download).toEqual(stored.result.reply_attachments_v1);
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).applied).toBe(false);
    expect((await persisted(delivery.delivery_id)).result).toEqual(stored.result);
  });
  it('does not expose another human sharing the alias, another root or a stale attempt', async () => {
    const { repository, account, root, delivery, ack } = await fixture();
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).applied).toBe(true);
    const foreign = await seededHuman(account.alias);
    await expect(repository.getReplyAttachments(root.message_id, delivery.delivery_id, delivery.attempt, humanOptions(foreign, 'read'))).rejects.toMatchObject({ code: 'not_found' });
    for (const [rootId, deliveryId, attempt] of [[randomUUID(), delivery.delivery_id, delivery.attempt], [root.message_id, randomUUID(), delivery.attempt], [root.message_id, delivery.delivery_id, delivery.attempt + 1]] as const) {
      await expect(repository.getReplyAttachments(rootId, deliveryId, attempt, humanOptions(account, 'read'))).rejects.toMatchObject({ code: 'not_found' });
    }
  });
  it('rejects a failed ownership fence before server media derivation', async () => {
    const { repository, delivery, ack } = await fixture();
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', { ...ack, claim_token: randomUUID() })).applied).toBe(false);
    expect((await persisted(delivery.delivery_id)).result).toBeNull();
    const history = await databasePool().query('SELECT payload FROM delivery_acks WHERE delivery_id=$1', [delivery.delivery_id]);
    expect(JSON.stringify(history.rows)).not.toContain('content_base64');
    expect(JSON.stringify(history.rows)).not.toContain('FORGED_FIELD_SENTINEL');
  });
  it('preserves conservative late salvage and its effective attempt', async () => {
    const { repository, account, root, delivery, ack } = await fixture('audio/mpeg', 'late answer');
    await databasePool().query("UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1", [delivery.delivery_id]);
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).applied).toBe(true);
    expect(await repository.getReplyAttachments(root.message_id, delivery.delivery_id, delivery.attempt, humanOptions(account, 'read'))).toEqual((await persisted(delivery.delivery_id)).result.reply_attachments_v1);
    const history = await databasePool().query('SELECT payload FROM delivery_acks WHERE delivery_id=$1', [delivery.delivery_id]);
    expect(JSON.stringify(history.rows)).not.toContain('content_base64');
  });
  it('rolls back persisted bytes when a later terminal effect fails', async () => {
    const { repository, delivery, ack } = await fixture();
    const effect = vi.spyOn(repository as unknown as { materializeAgentNotifications(): Promise<unknown> }, 'materializeAgentNotifications').mockRejectedValue(new Error('terminal effect failed'));
    try {
      await expect(repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).rejects.toThrow('terminal effect failed');
      expect((await persisted(delivery.delivery_id)).result).toBeNull();
      const history = await databasePool().query('SELECT payload FROM delivery_acks WHERE delivery_id=$1', [delivery.delivery_id]);
      expect(history.rows).toHaveLength(0);
    } finally { effect.mockRestore(); }
  });
  it('keeps failed ACK files unknown', async () => {
    const { repository, delivery, ack, root } = await fixture('audio/mpeg', 'failed');
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', { ...ack, status: 'failed', retryable: false })).applied).toBe(true);
    expect((await persisted(delivery.delivery_id)).result.reply_attachments_v1).toBeUndefined();
    expect(root.message_id).toBeDefined();
  });
  it('does not retain inline bytes for a non-console human root', async () => {
    const { repository, delivery, ack } = await fixture('audio/mpeg', 'human MCP answer', false);
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).applied).toBe(true);
    expect((await persisted(delivery.delivery_id)).result.reply_attachments_v1).toBeUndefined();
  });
  it('withholds bytes from a real foreign-tenant human authority', async () => {
    const { repository, root, delivery, ack } = await fixture();
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack)).applied).toBe(true);
    const foreign = await seedTenantHuman('Isa', 'media-reader');
    const signal = new AbortController().signal;
    const humanAuthority = createHumanReadAuthority(verifiedIdentity(foreign, ['cauce.read']),
      { humanId: foreign.humanId, tenantId: foreign.tenant, actorAlias: foreign.alias }, signal);
    await expect(repository.getReplyAttachments(root.message_id, delivery.delivery_id, delivery.attempt,
      { signal, humanAuthority })).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['done', 'failed'] as const)('selects only the real %s fan-in and binds its effective delivery', async (status) => {
    const { repository, account, root, delivery, ack, connectionToken } = await fixture('image/png', 'root fallback');
    const output = { reply: 'delegating', status: 'done', artifacts: [], messages: [{ to: 'socrates', body: 'prepare response' }] };
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', { ...ack, result: { output } })).applied).toBe(true);
    const childInstance = `media-child-${randomUUID()}`;
    const childLease = await repository.acquireLease('Steven', 'socrates', childInstance, [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000, { resume: true });
    if (childLease.epoch === undefined || childLease.connection_token === undefined) throw new Error('missing child lease');
    const children = await repository.claimDeliveries('Steven', 'socrates', childInstance, childLease.epoch, 10, 30_000, 3, {}, childLease.connection_token);
    const child = children.find((entry) => entry.body.type === 'agent.message');
    if (!child) throw new Error('missing materialized child');
    expect((await repository.ackDelivery(child.delivery_id, 'Steven', 'socrates', ackEnvelope(child,
      { instanceId: childInstance, epoch: childLease.epoch }, { output: { reply: 'child reply', messages: [], artifacts: [] } }))).applied).toBe(true);
    const responses = await repository.claimDeliveries('Steven', 'argos', ack.instance_id, ack.epoch, 10, 30_000, 3, {}, connectionToken);
    const response = responses.find((entry) => entry.body.type === 'agent.response');
    if (!response) throw new Error('missing real return-hop');
    const fileOnly = { output: { reply: null, status: 'done', messages: [],
      artifacts: [{ name: 'final.png', uri: `data:image/png;base64,${bytes.toString('base64')}` }] } };
    expect((await repository.ackDelivery(response.delivery_id, 'Steven', 'argos', ackEnvelope(response,
      { instanceId: ack.instance_id, epoch: ack.epoch }, fileOnly))).applied).toBe(true);
    expect((await persisted(response.delivery_id)).result.reply_attachments_v1).toBeDefined();
    const fanins = await repository.claimDeliveries('Steven', 'argos', ack.instance_id, ack.epoch, 10, 30_000, 3, {}, connectionToken);
    const fanin = fanins.find((entry) => entry.body.type === 'agent.fanin');
    if (!fanin) throw new Error('missing real consolidated turn');
    const final = ackEnvelope(fanin, { instanceId: ack.instance_id, epoch: ack.epoch }, fileOnly, { status });
    expect((await repository.ackDelivery(fanin.delivery_id, 'Steven', 'argos', final)).applied).toBe(true);
    const detail = await repository.getHumanMessage(root.message_id, humanOptions(account, 'read'));
    expect(detail.deliveries).toEqual([expect.objectContaining({ reply: null,
      reply_attachments: status === 'done' ? [expect.objectContaining({ mime_type: 'image/png' })] : [],
      ...(status === 'done' ? { reply_attachment_delivery_id: fanin.delivery_id, reply_attachment_attempt: fanin.attempt } : {}) })]);
    await expect(repository.getReplyAttachments(root.message_id, response.delivery_id, response.attempt,
      humanOptions(account, 'read'))).rejects.toMatchObject({ code: 'not_found' });
    if (status === 'done') expect(await repository.getReplyAttachments(root.message_id, fanin.delivery_id, fanin.attempt,
      humanOptions(account, 'read'))).toEqual((await persisted(fanin.delivery_id)).result.reply_attachments_v1);
  });

});
