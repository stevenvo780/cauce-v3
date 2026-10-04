import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db.js';
import { loadHumanMessageLineage, preserveHumanMessageLineage } from '../src/repository/human-message-lineage.js';
import { pool, registerAgentOutputSuite, repository } from './agent-output-postgres-helpers.js';
import { lineageMessage, lineageRoot, seedIdentity } from './human-message-lineage-postgres.fixtures.js';
import { ackWith, consumer, nextDelivery } from './helpers/consumer.js';
import {
  concurrentCalls, ContinuationRepository, counts, externalNotification, failingOutbox, historicalReplay,
  notificationDestination, notificationRow, notificationSource, openGate, permissions, readDelivery,
  terminalize, terminalSource,
} from './human-message-continuation-postgres.fixtures.js';

registerAgentOutputSuite(import.meta.url);
beforeEach(async () => {
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='kant'");
});

const lineageFor = (id: string) => withTransaction(pool, (client) => loadHumanMessageLineage(client, id));
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`missing ${key}`);
  return value;
}

describe('canonical human lineage through ordinary chain gate answers', () => {
  it('keeps the initiator across tenants, the answerer in audit and the resumed descendant', async () => {
    const gate = await openGate(true, true);
    const before = await permissions();
    const answer = await repository.answerChainGate(gate.id, 'Continue', 'Steven', 'kant');
    const messageId = stringField(answer, 'resume_message_id');
    expect(await lineageFor(messageId)).toEqual({ ...gate.lineage, messageId, messageTenantId: 'Jhon' });
    const audit = await pool.query<{ actor_alias: string; metadata: { answered_by: string } }>(
      "SELECT actor_alias,metadata FROM audit_events WHERE action='agent_chain.gate_answered' AND message_id=$1", [messageId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_alias: 'kant', metadata: { answered_by: 'Steven/kant' } });
    const resume = await nextDelivery(repository, gate.target);
    await ackWith(repository, gate.target, resume, { messages: [{ to: 'socrates', body: 'Ordinary continuation' }] });
    const children = await pool.query<{ produced_message_id: string }>(
      "SELECT produced_message_id FROM agent_output_materializations WHERE source_delivery_id=$1 AND status='materialized'", [resume.delivery_id]);
    expect(children.rows).toHaveLength(1);
    for (const child of children.rows) expect(await lineageFor(child.produced_message_id))
      .toEqual({ ...gate.lineage, messageId: child.produced_message_id, messageTenantId: 'Jhon' });
    expect(await permissions()).toEqual(before);
    await expect(repository.answerChainGate(gate.id, 'Again', 'Steven', 'kant')).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query('SELECT id FROM adapter_outbox WHERE idempotency_key=$1', [`chain-gate-resume:${gate.id}`])).rowCount).toBe(1);
  });

  it('accepts a replay transport root while preserving the original human root', async () => {
    const source = await terminalSource(true, 'Steven');
    const replay = await repository.replayDelivery(source.deliveryId, 'Steven', 'kant');
    const clone = await readDelivery(stringField(replay, 'delivery_id'));
    expect(clone.message_id).not.toBe(source.messageId);
    await pool.query("UPDATE agent_chain_policies SET human_gate_enabled=true WHERE id='default'");
    const target = await consumer(repository, 'Steven', 'argos');
    const delivery = await nextDelivery(repository, target);
    await ackWith(repository, target, delivery, { messages: [{ to: '@human', body: 'Continue replay?' }] });
    const gate = (await pool.query<{ id: string; root_message_id: string }>(
      'SELECT id,root_message_id FROM agent_chain_gates WHERE source_delivery_id=$1', [clone.id])).rows[0];
    expect(gate?.root_message_id).toBe(clone.message_id);
    if (!gate) throw new Error('missing replay gate');
    const answered = await repository.answerChainGate(gate.id, 'Continue', 'Steven', 'kant');
    const id = stringField(answered, 'resume_message_id');
    expect(await lineageFor(id)).toEqual({ ...source.lineage, messageId: id });
  });

  it.each([false, true])('leaves unknown or partial gate lineage unattributed (partial=%s)', async (partial) => {
    const gate = await openGate(partial);
    if (partial) {
      const unknown = await withTransaction(pool, (client) => lineageMessage(client));
      await pool.query('UPDATE agent_chain_gates SET root_message_id=$2 WHERE id=$1', [gate.id, unknown]);
    }
    const answer = await repository.answerChainGate(gate.id, 'Continue', 'Steven', 'kant');
    expect(await lineageFor(stringField(answer, 'resume_message_id'))).toBeUndefined();
  });

  it.each(['different_human', 'missing_root', 'recipient'] as const)('rejects an inconsistent durable gate %s without writes', async (kind) => {
    const gate = await openGate();
    if (kind === 'recipient') await pool.query("UPDATE agent_chain_gates SET asked_by_alias='kant' WHERE id=$1", [gate.id]);
    else {
      const other = await seedIdentity(pool, gate.human.alias);
      const root = await lineageRoot(pool, other.humanId);
      await pool.query('UPDATE agent_chain_gates SET root_message_id=$2 WHERE id=$1', [gate.id, kind === 'missing_root' ? randomUUID() : root.messageId]);
      if (kind === 'missing_root') await pool.query(
        `UPDATE agent_chain_gates SET origin=$2::jsonb WHERE id=$1`,
        [gate.id, JSON.stringify({ adapter: 'telegram', channel: 'telegram', conversation_id: 'fixture',
          relay: [], metadata: { bridge_tenant: 'Steven', bridge_alias: 'argos' } })]);
    }
    const before = await counts();
    await expect(repository.answerChainGate(gate.id, 'Continue', 'Steven', 'kant')).rejects.toMatchObject({ code: 'conflict' });
    expect(await counts()).toEqual(before);
    expect((await pool.query('SELECT status FROM agent_chain_gates WHERE id=$1', [gate.id])).rows).toEqual([{ status: 'open' }]);
  });

  it('keeps the existing invalid-actor failure when the asker has no routable room', async () => {
    const gate = await openGate(true, true);
    await pool.query("UPDATE memberships SET enabled=false WHERE tenant_id='Jhon' AND alias='hegel'");
    const before = await counts();
    await expect(repository.answerChainGate(gate.id, 'Continue', 'Steven', 'kant')).rejects.toMatchObject({ code: 'invalid_actor' });
    expect(await counts()).toEqual(before);
  });

  it('serializes concurrent answers into one continuation and one conflict', async () => {
    const gate = await openGate();
    const results = await concurrentCalls('agent_chain_gates', gate.id,
      (repo) => repo.answerChainGate(gate.id, 'Continue', 'Steven', 'kant'));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect((await pool.query('SELECT id FROM adapter_outbox WHERE idempotency_key=$1', [`chain-gate-resume:${gate.id}`])).rowCount).toBe(1);
  });

  it('rolls back copied lineage and all continuation writes when the outbox fails', async () => {
    const gate = await openGate();
    const before = await counts();
    await expect(failingOutbox((repo) => repo.answerChainGate(gate.id, 'Continue', 'Steven', 'kant'))).rejects.toThrow('fixture outbox failure');
    expect(await counts()).toEqual(before);
    expect((await pool.query('SELECT status FROM agent_chain_gates WHERE id=$1', [gate.id])).rows).toEqual([{ status: 'open' }]);
  });

  it('preserves scope denial after answering and never reactivates a revoked human', async () => {
    const gate = await openGate(true, true);
    await pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [gate.human.humanId]);
    const before = await permissions();
    const answer = await repository.answerChainGate(gate.id, 'Continue', 'Steven', 'kant');
    expect(await lineageFor(stringField(answer, 'resume_message_id'))).toMatchObject({ humanId: gate.human.humanId });
    expect(await permissions()).toEqual(before);
    await pool.query("UPDATE acl_edges SET allow_control=false WHERE from_tenant='Steven' AND to_tenant='Jhon'");
    await expect(repository.answerChainGate(gate.id, 'Again', 'Steven', 'kant')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('canonical human lineage through operator replay and own retry', () => {
  it.each(['dead', 'failed'] as const)('copies a %s source across recipient tenants and audits only the operator', async (status) => {
    const source = await terminalSource();
    await pool.query('UPDATE deliveries SET status=$2 WHERE id=$1', [source.deliveryId, status]);
    const before = await permissions();
    const replay = await repository.replayDelivery(source.deliveryId, 'Steven', 'kant');
    const clone = await readDelivery(stringField(replay, 'delivery_id'));
    expect(await lineageFor(clone.message_id)).toEqual({ ...source.lineage, messageId: clone.message_id });
    expect(clone).toMatchObject({ tenant_id: 'Steven', recipient_tenant: 'Jhon', recipient_alias: 'hegel' });
    expect(clone.body).toEqual((await readDelivery(source.deliveryId)).body);
    expect((await pool.query("SELECT actor_alias FROM audit_events WHERE action='delivery.replay' AND delivery_id=$1", [clone.id])).rows).toEqual([{ actor_alias: 'kant' }]);
    expect(await permissions()).toEqual(before);
    await expect(repository.replayDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('retains the same original tuple after more than sixteen replay generations', async () => {
    const source = await terminalSource();
    let id = source.deliveryId;
    for (let index = 0; index < 18; index += 1) {
      const replay = await repository.replayDelivery(id, 'Steven', 'kant');
      const clone = await readDelivery(stringField(replay, 'delivery_id'));
      expect(await lineageFor(clone.message_id)).toEqual({ ...source.lineage, messageId: clone.message_id });
      await terminalize(clone.id);
      id = clone.id;
    }
  });

  it('returns an exact public DTO for repeated and concurrent own retry with one clone', async () => {
    const source = await terminalSource();
    const results = await concurrentCalls('deliveries', source.deliveryId,
      (repo) => repo.retryOwnDelivery(source.deliveryId, 'Steven', 'kant'));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    const again = await repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant');
    expect(Object.keys(again).sort()).toEqual(['already_replayed', 'delivery_id', 'replayed', 'replayed_from_delivery_id', 'state']);
    expect(again.already_replayed).toBe(true);
    expect(fulfilled.map((result) => result.value)).toEqual(expect.arrayContaining([
      { ...again, already_replayed: false }, again,
    ]));
    expect((await pool.query("SELECT id FROM audit_events WHERE action='delivery.replay'")).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM adapter_outbox WHERE idempotency_key LIKE 'wake-replay:%'")).rowCount).toBe(1);
    expect(await lineageFor((await readDelivery(stringField(again, 'delivery_id'))).message_id)).toMatchObject({ rootMessageId: source.messageId });
  });

  it.each(['known_unknown', 'unknown_known', 'different_root', 'different_human'] as const)('does not repair existing replay %s', async (kind) => {
    const source = await terminalSource(kind !== 'unknown_known');
    const otherHuman = await seedIdentity(pool, source.human.alias);
    const other = await lineageRoot(pool, kind === 'different_human' ? otherHuman.humanId : source.human.humanId);
    const target = await historicalReplay(source.deliveryId, kind === 'known_unknown' ? undefined : other);
    const before = await counts();
    await expect(repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'conflict' });
    expect(await counts()).toEqual(before);
    expect(await lineageFor(target.messageId)).toEqual(kind === 'known_unknown' ? undefined : { ...other, messageId: target.messageId });
    await expect(repository.replayDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('accepts an existing unknown legacy clone without assigning it a human', async () => {
    const source = await terminalSource(false);
    const target = await historicalReplay(source.deliveryId);
    const retried = await repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant');
    expect(retried).toMatchObject({ delivery_id: target.deliveryId, already_replayed: true });
    expect(await lineageFor(target.messageId)).toBeUndefined();
  });

  it.each(['ambiguous', 'recipient'] as const)('rejects an existing %s replay without creating another', async (kind) => {
    const source = await terminalSource(true, 'Steven');
    await historicalReplay(source.deliveryId, source.lineage, kind === 'recipient' ? 'socrates' : undefined);
    if (kind === 'ambiguous') await historicalReplay(source.deliveryId, source.lineage);
    const before = await counts();
    await expect(repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'conflict' });
    expect(await counts()).toEqual(before);
  });

  it('does not mistake multiple audit rows for multiple clone targets', async () => {
    const source = await terminalSource();
    const replay = await repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant');
    await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
      SELECT tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
      FROM audit_events WHERE action='delivery.replay' AND delivery_id=$1`, [replay.delivery_id]);
    expect(await repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant')).toEqual({ ...replay, already_replayed: true });
  });

  it('preserves own authorization and terminal-state denials without mutation', async () => {
    const source = await terminalSource();
    await expect(repository.retryOwnDelivery(source.deliveryId, 'Steven', 'argos')).rejects.toMatchObject({ code: 'not_found' });
    await pool.query("UPDATE deliveries SET status='failed' WHERE id=$1", [source.deliveryId]);
    await expect(repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'not_found' });
    await pool.query("UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Jhon'");
    await expect(repository.replayDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('retains the legacy dead-letter guard and recognizes a verified legacy wake', async () => {
    const source = await terminalSource();
    await pool.query('UPDATE dead_letters SET resolved_at=now() WHERE delivery_id=$1', [source.deliveryId]);
    await expect(repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant')).rejects.toMatchObject({ code: 'not_found' });
    await pool.query(`INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,payload)
      SELECT d.recipient_tenant,'gateway','wake',$2,m.request_id,m.id,d.id,m.trace_id,
        jsonb_build_object('recipient_alias',d.recipient_alias)
      FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.id=$1`,
    [source.deliveryId, `wake-replay:${source.deliveryId}:legacy`]);
    const replay = await repository.retryOwnDelivery(source.deliveryId, 'Steven', 'kant');
    expect(await lineageFor((await readDelivery(stringField(replay, 'delivery_id'))).message_id)).toMatchObject({ rootMessageId: source.messageId });
  });

  it('rolls back the clone, human lineage and dead-letter resolution on outbox failure', async () => {
    const source = await terminalSource();
    const before = await counts();
    await expect(failingOutbox((repo) => repo.replayDelivery(source.deliveryId, 'Steven', 'kant'))).rejects.toThrow('fixture outbox failure');
    expect(await counts()).toEqual(before);
    expect((await pool.query('SELECT resolved_at FROM dead_letters WHERE delivery_id=$1', [source.deliveryId])).rows).toEqual([{ resolved_at: null }]);
  });
});

describe('canonical human lineage for notifications', () => {
  it('uses the verified cross-tenant delivery while keeping the relay self-root and correlation', async () => {
    const source = await notificationSource(true);
    const human = await seedIdentity(pool);
    const root = await lineageRoot(pool, human.humanId, source.delivery.message_id);
    const before = await permissions();
    await repository.ackDelivery(source.delivery.delivery_id, source.target.tenant, source.target.alias, source.ack);
    const notice = await notificationRow();
    expect(await lineageFor(notice.produced_message_id)).toEqual({ ...root, messageId: notice.produced_message_id, messageTenantId: 'Jhon' });
    const relay = (await pool.query<{ payload: Record<string, unknown> }>('SELECT payload FROM adapter_outbox WHERE id=$1', [notice.produced_outbox_id])).rows[0];
    expect(relay?.payload).toMatchObject({ correlation: { root_message_id: notice.produced_message_id },
      source_correlation: { source_delivery_id: source.delivery.delivery_id, source_message_id: source.delivery.message_id } });
    expect(await permissions()).toEqual(before);
    expect(await withTransaction(pool, async (client) => new ContinuationRepository(pool).notify(client,
      await readDelivery(source.delivery.delivery_id), source.ack))).toEqual({ allowed: 0, denied: 0, errors: 0 });
    expect((await pool.query('SELECT id FROM egress_notifications')).rowCount).toBe(1);
  });

  it.each(['known_unknown', 'unknown_known', 'different_root'] as const)('validates immutable existing notification %s', async (kind) => {
    const source = await notificationSource();
    await repository.ackDelivery(source.delivery.delivery_id, source.target.tenant, source.target.alias, source.ack);
    const notice = await notificationRow();
    const human = await seedIdentity(pool);
    if (kind !== 'unknown_known') await lineageRoot(pool, human.humanId, source.delivery.message_id);
    if (kind !== 'known_unknown') {
      const other = await lineageRoot(pool, human.humanId);
      await withTransaction(pool, (client) => preserveHumanMessageLineage(client, notice.produced_message_id, other));
    }
    const before = await counts();
    expect(await withTransaction(pool, async (client) => new ContinuationRepository(pool).notify(client,
      await readDelivery(source.delivery.delivery_id), source.ack))).toEqual({ allowed: 0, denied: 0, errors: 1 });
    expect(await counts()).toEqual(before);
  });

  it('never adopts a known UUID from body, trace or supplied source transport root', async () => {
    const source = await notificationSource();
    const human = await seedIdentity(pool);
    const unrelated = await lineageRoot(pool, human.humanId);
    const row = await readDelivery(source.delivery.delivery_id);
    row.body = { type: 'agent.message', text: unrelated.humanId, correlation: { root_message_id: unrelated.messageId } };
    row.trace_id = unrelated.messageId;
    const result = await withTransaction(pool, (client) => new ContinuationRepository(pool).notify(client, row, source.ack));
    expect(result).toEqual({ allowed: 1, denied: 0, errors: 0 });
    expect(await lineageFor((await notificationRow()).produced_message_id)).toBeUndefined();
  });

  it.each(['message', 'tenant', 'alias'] as const)('rejects a mismatched notification source %s before side effects', async (field) => {
    const source = await notificationSource();
    const row = await readDelivery(source.delivery.delivery_id);
    if (field === 'message') row.message_id = await withTransaction(pool, (client) => lineageMessage(client));
    if (field === 'tenant') { row.recipient_tenant = 'Jhon'; row.recipient_alias = 'hegel'; await notificationDestination('Jhon', 'hegel'); }
    if (field === 'alias') { row.recipient_alias = 'socrates'; await notificationDestination('Steven', 'socrates'); }
    const before = await counts();
    expect(await withTransaction(pool, (client) => new ContinuationRepository(pool).notify(client, row, source.ack)))
      .toEqual({ allowed: 0, denied: 0, errors: 1 });
    expect(await counts()).toEqual(before);
  });

  it('keeps external legacy notices unknown and validates their repeated targets', async () => {
    await notificationDestination();
    const input = externalNotification();
    const notice = await repository.enqueueNotification('Steven', 'argos', input);
    if (!notice.message_id) throw new Error('missing notice');
    expect(await lineageFor(notice.message_id)).toBeUndefined();
    expect(await repository.enqueueNotification('Steven', 'argos', input)).toEqual({ ...notice, duplicate: true });
    const human = await seedIdentity(pool);
    await lineageRoot(pool, human.humanId, notice.message_id);
    await expect(repository.enqueueNotification('Steven', 'argos', input)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rolls back known notification lineage inside its savepoint without aborting the ACK', async () => {
    const source = await notificationSource();
    const human = await seedIdentity(pool);
    await lineageRoot(pool, human.humanId, source.delivery.message_id);
    const before = await counts();
    await expect(failingOutbox((repo) => repo.ackDelivery(source.delivery.delivery_id,
      source.target.tenant, source.target.alias, source.ack))).resolves.toMatchObject({ applied: true });
    expect((await pool.query('SELECT id FROM egress_notifications')).rowCount).toBe(0);
    const after = await counts();
    expect(after?.messages).toBe(before?.messages);
    expect(after?.lineage).toBe(before?.lineage);
    expect(after?.outbox).toBe(before?.outbox);
  });

  it('serializes concurrent external notifications to a single unknown target', async () => {
    await notificationDestination();
    const input = externalNotification();
    const results = await Promise.all([repository.enqueueNotification('Steven', 'argos', input),
      repository.enqueueNotification('Steven', 'argos', input)]);
    expect(results[0].message_id).toBe(results[1].message_id);
    expect(results.map((row) => row.duplicate).sort()).toEqual([false, true]);
    expect((await pool.query('SELECT id FROM egress_notifications')).rowCount).toBe(1);
    expect(await lineageFor((await notificationRow()).produced_message_id)).toBeUndefined();
  });
});
