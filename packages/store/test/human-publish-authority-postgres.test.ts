import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConsolePublishIntentCommand } from '@cauce/protocol';
import {
  authorFor, consoleIntent, countsFor, databasePool, getRepository,
  blockingPids, installPublishBarrier, prepareHumanPublishIntent, publishCommand, publishOptions,
  registerHumanPublishSuite, removePublishBarrier, seedHumanPublishActor, waitForBlocked,
} from './human-publish-authority-postgres.fixtures.js';

registerHumanPublishSuite(import.meta.url);

interface Revocation {
  readonly name: string;
  readonly sql: string;
  readonly values: (humanId: string, alias: string) => unknown[];
  readonly recipientTenant?: 'Steven' | 'Isa';
  readonly deniedCode: string;
}

const revocations: readonly Revocation[] = [
  { name: 'account', sql: 'UPDATE console_users SET active=false WHERE id=$1', values: (id) => [id], deniedCode: 'forbidden' },
  { name: 'identity binding', sql: `UPDATE human_external_identities
    SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1`, values: (id) => [id], deniedCode: 'forbidden' },
  { name: 'human membership', sql: `UPDATE human_tenant_memberships
    SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1 AND tenant_id='Steven'`,
  values: (id) => [id], deniedCode: 'forbidden' },
  { name: 'source tenant', sql: `UPDATE tenants SET enabled=false WHERE id='Steven'`, values: () => [], deniedCode: 'invalid_actor' },
  { name: 'recipient tenant', sql: `UPDATE tenants SET enabled=false WHERE id='Isa'`, values: () => [], recipientTenant: 'Isa', deniedCode: 'no_route' },
  { name: 'actor room', sql: `UPDATE rooms SET enabled=false WHERE tenant_id='Steven' AND id='grp.steven'`, values: () => [], deniedCode: 'invalid_actor' },
  { name: 'recipient membership', sql: `UPDATE memberships SET enabled=false
    WHERE tenant_id='Isa' AND room_id='grp.isa' AND alias='salva'`, values: () => [], recipientTenant: 'Isa', deniedCode: 'no_route' },
  { name: 'route membership', sql: `UPDATE memberships SET enabled=false
    WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1`, values: (_id, alias) => [alias], deniedCode: 'invalid_actor' },
  { name: 'role policy', sql: `UPDATE role_policies SET allow_route=false WHERE role='operator'`, values: () => [], deniedCode: 'invalid_actor' },
  { name: 'cross-tenant route ACL', sql: `UPDATE acl_edges SET allow_route=false
    WHERE from_tenant='Steven' AND to_tenant='Isa'`, values: () => [], recipientTenant: 'Isa', deniedCode: 'forbidden' },
];

async function preparedSubmission(
  recipientTenant: 'Steven' | 'Isa' = 'Steven',
  body?: ConsolePublishIntentCommand['body'],
) {
  const account = await seedHumanPublishActor();
  const baseIntent = consoleIntent(account, recipientTenant);
  const intent = body === undefined ? baseIntent : { ...baseIntent, body };
  const prepared = await prepareHumanPublishIntent(intent);
  if (prepared.state !== 'prepared') throw new Error('expected a fresh prepared publication');
  const command = publishCommand(intent, prepared.idempotency_key);
  return { account, intent, command, options: publishOptions(account) };
}

async function poolQuery<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
  return databasePool().query<T>(sql, values);
}

async function revoke(revocation: Revocation, humanId: string, alias: string): Promise<void> {
  await poolQuery(revocation.sql, revocation.values(humanId, alias));
}

describe('human publication authority in PostgreSQL', () => {
  it('persists the trusted human root and returns one receipt on an owned idempotent retry', async () => {
    const { account, command, options } = await preparedSubmission('Steven', {
      text: `human publication ${randomUUID()}`,
      human_id: 'human:forged-from-message-body',
      console_author: { kind: 'human', subject_id: 'human:forged-from-message-body' },
    });
    const first = await getRepository().publish(command, options);
    const retry = await getRepository().publish({ ...command, request_id: randomUUID(), trace_id: `retry-${randomUUID()}` }, options);

    expect(retry).toEqual({ ...first, duplicate: true });
    expect(await countsFor(command)).toEqual({
      messages: '1', initiators: '1', deliveries: '1', outbox: '1', audit: '1', idempotency: '1',
    });
    const initiator = await poolQuery<Record<string, string>>(
      `SELECT initiating_human_id::text AS human_id,initiating_tenant_id AS tenant_id,
              message_tenant_id,root_message_id::text AS root_id,message_id::text AS message_id
         FROM human_message_initiators WHERE message_id=$1::uuid`, [first.message_id],
    );
    expect(initiator.rows).toEqual([{
      human_id: account.humanId, tenant_id: 'Steven', message_tenant_id: 'Steven',
      root_id: first.message_id, message_id: first.message_id,
    }]);
    const audit = await poolQuery<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE request_id=$1 AND action='message.publish'`, [command.request_id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      authenticated_channel: 'human-mcp', console_author: authorFor(account),
    });
    expect(audit.rows[0]?.metadata).not.toMatchObject({ console_author: { subject_id: 'human:forged-from-message-body' } });

    const other = await seedHumanPublishActor(account.alias);
    const foreignAttempt = getRepository().publish(
      { ...command, request_id: randomUUID(), trace_id: `foreign-${randomUUID()}` }, publishOptions(other),
    );
    await expect(foreignAttempt).rejects.toMatchObject({ code: 'not_found' });
    expect(await countsFor(command)).toMatchObject({ messages: '1', initiators: '1', idempotency: '1' });
  });

  it('fails closed for an unknown owner, mismatched actor, missing signal, prepared intent, author, or authority', async () => {
    const { account, command, options } = await preparedSubmission();
    const unknown = publishOptions(account, { authority: async (client) => {
      const { lockHumanIdentity } = await import('../src/index.js');
      const snapshot = await lockHumanIdentity(client, account.key, randomUUID());
      return { humanId: snapshot.humanId, tenantId: snapshot.membership.tenantId, actorAlias: snapshot.membership.actorAlias };
    } });
    await expect(getRepository().publish(command, unknown)).rejects.toMatchObject({ code: 'forbidden' });
    const mismatch = publishOptions(account, { authority: async (client) => {
      const { lockHumanIdentity } = await import('../src/index.js');
      const snapshot = await lockHumanIdentity(client, account.key, account.humanId);
      return { humanId: snapshot.humanId, tenantId: snapshot.membership.tenantId, actorAlias: 'spoofed-actor' };
    } });
    await expect(getRepository().publish(command, mismatch)).rejects.toMatchObject({ code: 'forbidden' });
    const { signal: _signal, ...withoutSignal } = options;
    void _signal;
    await expect(getRepository().publish(command, withoutSignal)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getRepository().publish(command, { ...options, requirePreparedConsoleIntent: false }))
      .rejects.toMatchObject({ code: 'forbidden' });
    const { consoleAuthor: _consoleAuthor, ...withoutAuthor } = options;
    void _consoleAuthor;
    await expect(getRepository().publish(command, withoutAuthor)).rejects.toMatchObject({ code: 'forbidden' });
    const wrongIntent = { ...command, idempotency_key: `wrong-${randomUUID()}` };
    await expect(getRepository().publish(wrongIntent, options)).rejects.toMatchObject({ code: 'conflict' });
    const { humanAuthority: _humanAuthority, ...withoutAuthority } = options;
    void _humanAuthority;
    await expect(getRepository().publish(command, withoutAuthority)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await countsFor(command)).toEqual({
      messages: '0', initiators: '0', deliveries: '0', outbox: '0', audit: '0', idempotency: '0',
    });
  });

  it.each(revocations)('publishes no effect when $name was revoked first', async (revocation) => {
    const { account, command, options } = await preparedSubmission(revocation.recipientTenant);
    await revoke(revocation, account.humanId, account.alias);
    await expect(getRepository().publish(command, options)).rejects.toMatchObject({ code: revocation.deniedCode });
    expect(await countsFor(command)).toEqual({
      messages: '0', initiators: '0', deliveries: '0', outbox: '0', audit: '0', idempotency: '0',
    });
  });

  it.each(revocations)('holds $name authority locks through publish before the concurrent revoke', async (revocation) => {
    const { account, command } = await preparedSubmission(revocation.recipientTenant);
    const barrier = await installPublishBarrier();
    const observer = await databasePool().connect();
    const revoker = await databasePool().connect();
    let publisherPid: number | undefined;
    const settlement: Promise<unknown>[] = [];
    try {
      const options = publishOptions(account, { authority: async (client) => {
        const { lockHumanIdentity } = await import('../src/index.js');
        const snapshot = await lockHumanIdentity(client, account.key, account.humanId);
        publisherPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        return { humanId: snapshot.humanId, tenantId: snapshot.membership.tenantId, actorAlias: snapshot.membership.actorAlias };
      } });
      const publication = getRepository().publish(command, options);
      settlement.push(publication);
      const deadline = Date.now() + 5_000;
      while (publisherPid === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      if (publisherPid === undefined) throw new Error('human publication did not open its PostgreSQL backend');
      await waitForBlocked(observer, publisherPid);
      expect(await blockingPids(observer, publisherPid)).toContain(barrier.blockerPid);
      const revokePid = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (revokePid === undefined) throw new Error('missing revoker PostgreSQL PID');
      const pendingRevoke = revoker.query(revocation.sql, revocation.values(account.humanId, account.alias));
      settlement.push(pendingRevoke);
      await waitForBlocked(observer, revokePid);
      expect(await blockingPids(observer, revokePid)).toContain(publisherPid);
      await barrier.release();
      const receipt = await publication;
      await pendingRevoke;
      expect(receipt.duplicate).toBe(false);
      expect(await countsFor(command)).toEqual({
        messages: '1', initiators: '1', deliveries: '1', outbox: '1', audit: '1', idempotency: '1',
      });
    } finally {
      await barrier.release().catch(() => undefined);
      await Promise.allSettled(settlement);
      observer.release();
      revoker.release();
      await removePublishBarrier(barrier);
    }
  });

  it('aborts a publish waiting on identity locks by terminating its PostgreSQL backend', async () => {
    const { account, command, options } = await preparedSubmission();
    const holder = await databasePool().connect();
    const observer = await databasePool().connect();
    const controller = new AbortController();
    const reason = new Error('cancel human publish authority');
    let blockedPid: number | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE console_users SET display_name=display_name WHERE id=$1', [account.humanId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (holderPid === undefined) throw new Error('missing identity lock holder PID');
      const publish = getRepository().publish(command, { ...options, signal: controller.signal });
      const rejected = expect(publish).rejects.toThrow(reason.message);
      const deadline = Date.now() + 5_000;
      while (blockedPid === undefined && Date.now() < deadline) {
        blockedPid = (await observer.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND datname=current_database() LIMIT 1`,
          [holderPid],
        )).rows[0]?.pid;
        if (blockedPid === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedPid).toBeDefined();
      controller.abort(reason);
      await rejected;
      await holder.query('SELECT pg_stat_clear_snapshot()');
      expect((await observer.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [blockedPid])).rows).toEqual([]);
      await holder.query('COMMIT');
      expect(await countsFor(command)).toEqual({
        messages: '0', initiators: '0', deliveries: '0', outbox: '0', audit: '0', idempotency: '0',
      });
    } finally {
      controller.abort(reason);
      await holder.query('ROLLBACK');
      holder.release();
      observer.release();
    }
  });

  it('rolls back the message, human root, delivery, outbox, audit, and idempotency key together', async () => {
    const { command, options } = await preparedSubmission();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `fail_human_publish_${suffix}`;
    const triggerName = `fail_human_publish_${suffix}`;
    await poolQuery(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.action='message.publish' AND NEW.request_id='${command.request_id}'::uuid THEN
          RAISE EXCEPTION 'injected human publish audit failure';
        END IF;
        RETURN NEW;
      END $body$`);
    await poolQuery(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    try {
      await expect(getRepository().publish(command, options)).rejects.toThrow('injected human publish audit failure');
      expect(await countsFor(command)).toEqual({
        messages: '0', initiators: '0', deliveries: '0', outbox: '0', audit: '0', idempotency: '0',
      });
      expect((await poolQuery(
        `SELECT count(*)::text AS count FROM audit_events WHERE action LIKE 'console.publish.%'`,
      )).rows[0]?.count).toBe('2');
    } finally {
      await poolQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
      await poolQuery(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    }
  });
});
