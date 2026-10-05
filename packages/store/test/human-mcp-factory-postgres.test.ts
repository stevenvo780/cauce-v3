import { randomUUID } from 'node:crypto';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { describe, expect, it } from 'vitest';
import { GatewayOperationError } from '../../../packages/mcp-fleet-monitor/src/gateway-operations.js';
import {
  assertNoHumanMcpEffects, changeAlias, createHumanMcpIdentity, createRealHumanMcpFactory,
  databasePool, effectCounts, finishHumanMcpRoots, getRepository, holdTechnicalMembership,
  humanMcpCommand, makeReader, openHumanMcpOperations, seedHumanPublishActor,
  waitForBlockedRoute,
} from './human-mcp-factory-postgres.fixtures.js';

async function failureOf(operation: Promise<unknown>): Promise<GatewayOperationError['failure']> {
  let error: unknown;
  try { await operation; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GatewayOperationError);
  return (error as GatewayOperationError).failure;
}

async function blockedStillWaiting(blockerPid: number, waitingPid: number): Promise<boolean> {
  const result = await databasePool().query<{ waiting: boolean }>(
    'SELECT $1=ANY(pg_blocking_pids($2)) AS waiting', [blockerPid, waitingPid],
  );
  return result.rows[0]?.waiting === true;
}

async function backendStillPresent(waitingPid: number): Promise<boolean> {
  const result = await databasePool().query<{ present: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present', [waitingPid],
  );
  return result.rows[0]?.present === true;
}

async function assertBackendAbsent(waitingPid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await backendStillPresent(waitingPid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${String(waitingPid)} remained in pg_stat_activity after request completion`);
}

async function assertCancelledBackend(waitingPid: number, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await blockedStillWaiting(blockerPid, waitingPid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${String(waitingPid)} stayed blocked after request cancellation`);
}

describe('human MCP operations factory against durable PostgreSQL identity', () => {
  it('expires during the real post-authority route lock and leaves no durable effects before barrier release', async () => {
    const account = await seedHumanPublishActor();
    const expiresAt = Date.now() / 1_000 + 1.8;
    const operations = await openHumanMcpOperations(account, ['cauce.publish'], expiresAt);
    const barrier = await holdTechnicalMembership(account.alias);
    const command = humanMcpCommand(randomUUID(), `expiry barrier ${randomUUID()}`);
    const pending = failureOf(operations.submit(command));
    let waitingPid: number | undefined;
    try {
      waitingPid = await waitForBlockedRoute(databasePool(), barrier.pid);
      expect(await blockedStillWaiting(barrier.pid, waitingPid)).toBe(true);
      const failure = await pending;
      expect(failure).toMatchObject({ status_code: 503, error: 'operation_unavailable' });
      expect(Date.now()).toBeGreaterThanOrEqual(expiresAt * 1_000);
      await assertNoHumanMcpEffects();
      expect(await blockedStillWaiting(barrier.pid, waitingPid)).toBe(false);
      await assertBackendAbsent(waitingPid);
    } finally {
      await barrier.release();
    }
  }, 15_000);

  it('cancels the actual route-lock query when the request signal aborts', async () => {
    const account = await seedHumanPublishActor();
    const request = new AbortController();
    const operations = await openHumanMcpOperations(account, ['cauce.publish'], undefined, request.signal);
    const barrier = await holdTechnicalMembership(account.alias);
    const pending = failureOf(operations.submit(humanMcpCommand(randomUUID(), `abort barrier ${randomUUID()}`)));
    let waitingPid: number | undefined;
    try {
      waitingPid = await waitForBlockedRoute(databasePool(), barrier.pid);
      expect(await blockedStillWaiting(barrier.pid, waitingPid)).toBe(true);
      request.abort(new Error('private HTTP disconnect reason'));
      await expect(pending).resolves.toMatchObject({ status_code: 503, error: 'operation_unavailable' });
      await assertCancelledBackend(waitingPid, barrier.pid);
      await assertBackendAbsent(waitingPid);
      await assertNoHumanMcpEffects();
    } finally {
      request.abort();
      await barrier.release();
    }
  }, 15_000);

  it('recovers one committed publish after relogin with the same issuer, subject, and request key', async () => {
    const account = await seedHumanPublishActor();
    const key = randomUUID();
    const command = humanMcpCommand(key, `same request key ${randomUUID()}`);
    const first = await openHumanMcpOperations(account, ['cauce.publish']);
    const committed = await first.submit(command);
    const relogin = await createRealHumanMcpFactory().forRequest(
      createHumanMcpIdentity(account, ['cauce.publish']), new AbortController().signal,
    );
    const recovered = await relogin.submit(command);
    expect(recovered.message_id).toBe(committed.message_id);
    expect(recovered.idempotency_key).toBe(committed.idempotency_key);
    expect(recovered.duplicate).toBe(false);
    expect(await effectCounts(committed.message_id, committed.idempotency_key)).toEqual({
      messages: '1', initiators: '1', deliveries: '1', outbox: '1', idempotency: '1',
      publish_audit: '1', console_audit: '2',
    });
  }, 20_000);

  it('returns each same-alias receipt only to the matching durable human UUID', async () => {
    const first = await seedHumanPublishActor();
    const second = await seedHumanPublishActor(first.alias);
    const firstOps = await openHumanMcpOperations(first, ['cauce.publish']);
    const secondOps = await openHumanMcpOperations(second, ['cauce.publish']);
    const firstReceipt = await firstOps.submit(humanMcpCommand(randomUUID(), `owner one ${randomUUID()}`));
    const secondReceipt = await secondOps.submit(humanMcpCommand(randomUUID(), `owner two ${randomUUID()}`));
    await finishHumanMcpRoots([
      { messageId: firstReceipt.message_id, humanId: first.humanId, reply: `reply-${first.humanId}` },
      { messageId: secondReceipt.message_id, humanId: second.humanId, reply: `reply-${second.humanId}` },
    ]);
    await makeReader(first);
    await makeReader(second);
    const firstReader = await openHumanMcpOperations(first, ['cauce.read']);
    const secondReader = await openHumanMcpOperations(second, ['cauce.read']);
    await expect(firstReader.receipt(firstReceipt.message_id)).resolves.toMatchObject({
      message_id: firstReceipt.message_id,
      deliveries: [expect.objectContaining({ reply: `reply-${first.humanId}` })],
    });
    await expect(secondReader.receipt(secondReceipt.message_id)).resolves.toMatchObject({
      message_id: secondReceipt.message_id,
      deliveries: [expect.objectContaining({ reply: `reply-${second.humanId}` })],
    });
    expect(await failureOf(firstReader.receipt(secondReceipt.message_id)))
      .toMatchObject({ status_code: 404, error: 'not_found' });
    expect(await failureOf(secondReader.receipt(firstReceipt.message_id)))
      .toMatchObject({ status_code: 404, error: 'not_found' });
  }, 30_000);

  it('rejects an in-flight alias change, then reads its old root through the fresh durable snapshot', async () => {
    const account = await seedHumanPublishActor();
    const oldOperations = await openHumanMcpOperations(account, ['cauce.read', 'cauce.publish']);
    const root = await oldOperations.submit(humanMcpCommand(randomUUID(), `alias source ${randomUUID()}`));
    const replyAgent = await getRepository().acquireLease('Steven', 'argos', 'human-mcp-factory-fixture',
      [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000, { resume: true });
    if (!replyAgent.acquired || replyAgent.epoch === undefined || replyAgent.connection_token === undefined) {
      throw new Error('fixture delivery agent could not acquire its lease');
    }
    const delivery = (await getRepository().claimDeliveries('Steven', 'argos', 'human-mcp-factory-fixture',
      replyAgent.epoch, 10, 30_000, 3, {}, replyAgent.connection_token))
      .find((item) => item.message_id === root.message_id);
    if (!delivery) throw new Error('fixture delivery agent could not claim old root');
    expect(delivery.human_initiator?.human_id).toBe(account.humanId);
    await getRepository().ackDelivery(delivery.delivery_id, 'Steven', 'argos',
      (await import('./helpers/consumer.js')).terminalAck(delivery,
        { instanceId: 'human-mcp-factory-fixture', epoch: replyAgent.epoch }, { reply: 'root survives alias change' }));
    const alias = await changeAlias(account);
    const deniedCommand = humanMcpCommand(randomUUID(), `must not publish ${randomUUID()}`);
    const beforeDenied = await databasePool().query<{ messages: string; prepares: string }>(
      `SELECT (SELECT count(*)::text FROM messages WHERE body->>'text'=$1) AS messages,
              (SELECT count(*)::text FROM audit_events
                WHERE action='console.publish.prepare' AND actor_alias=$2) AS prepares`,
      [deniedCommand.body.text, account.alias],
    );
    const rejected = await failureOf(oldOperations.submit(deniedCommand));
    expect(rejected).toMatchObject({ status_code: 401, error: 'unauthorized' });
    const afterDenied = await databasePool().query<{ messages: string; prepares: string }>(
      `SELECT (SELECT count(*)::text FROM messages WHERE body->>'text'=$1) AS messages,
              (SELECT count(*)::text FROM audit_events
                WHERE action='console.publish.prepare' AND actor_alias=$2) AS prepares`,
      [deniedCommand.body.text, account.alias],
    );
    expect(afterDenied.rows[0]).toEqual(beforeDenied.rows[0]);
    const freshOperations = await createRealHumanMcpFactory().forRequest(
      createHumanMcpIdentity(account, ['cauce.read']), new AbortController().signal,
    );
    const detail = await freshOperations.receipt(root.message_id);
    expect(detail.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reply: 'root survives alias change' }),
    ]));
    expect(alias).not.toBe(account.alias);
    const durable = await databasePool().query<{ actor_alias: string }>(
      'SELECT actor_alias FROM messages WHERE id=$1::uuid', [root.message_id],
    );
    expect(durable.rows[0]?.actor_alias).toBe(account.alias);
  }, 25_000);

  it('does not confirm a committed publish when its prepare audit entry is absent', async () => {
    const account = await seedHumanPublishActor();
    const operations = await openHumanMcpOperations(account, ['cauce.publish']);
    const committed = await operations.submit(humanMcpCommand(randomUUID(), `missing prepare ledger ${randomUUID()}`));
    const prepare = await databasePool().query<{ id: string; operator_scope_hash: string }>(
      `SELECT id::text AS id,metadata->>'operator_scope_hash' AS operator_scope_hash
         FROM audit_events WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`, [committed.idempotency_key],
    );
    const ledger = prepare.rows[0];
    if (!ledger?.id || !ledger.operator_scope_hash) throw new Error('committed prepare ledger fixture was not found');
    await databasePool().query('DELETE FROM audit_events WHERE id=$1::bigint', [ledger.id]);
    const before = await databasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE action='console.publish.confirm' AND metadata->>'idempotency_key'=$1`, [committed.idempotency_key],
    );
    await expect(getRepository().confirmConsolePublishIntent('Steven', account.alias, ledger.operator_scope_hash, {
      idempotency_key: committed.idempotency_key, message_id: committed.message_id, causal_hash: committed.causal_hash,
    })).rejects.toMatchObject({ code: 'conflict' });
    const after = await databasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE action='console.publish.confirm' AND metadata->>'idempotency_key'=$1`, [committed.idempotency_key],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 20_000);

  it('denies a fresh operation after committed authority revocation without removing committed data', async () => {
    const account = await seedHumanPublishActor();
    const operations = await openHumanMcpOperations(account, ['cauce.publish']);
    const committed = await operations.submit(humanMcpCommand(randomUUID(), `revoked after commit ${randomUUID()}`));
    await databasePool().query('UPDATE console_users SET active=false WHERE id=$1', [account.humanId]);
    expect(await failureOf(operations.submit(humanMcpCommand(randomUUID(), `denied after revoke ${randomUUID()}`))))
      .toMatchObject({ status_code: 401, error: 'unauthorized' });
    expect(await failureOf(createRealHumanMcpFactory().forRequest(
      createHumanMcpIdentity(account, ['cauce.read', 'cauce.publish']), new AbortController().signal,
    ))).toEqual({ status_code: 401, error: 'unauthorized' });
    const durable = await effectCounts(committed.message_id, committed.idempotency_key);
    expect(durable).toEqual({ messages: '1', initiators: '1', deliveries: '1', outbox: '1',
      idempotency: '1', publish_audit: '1', console_audit: '2' });
  }, 20_000);
});
