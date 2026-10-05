import { describe, expect, it } from 'vitest';
import { type DatabaseClient } from '../src/index.js';
import { humanMessageAuthority, lockHumanMessageRead } from '../src/repository/messages/human-authority.js';
import {
  databasePool, finishRoots, getRepository, humanOptions, publishHumanRoot, seedLegacyRoot,
  seededHuman, switchHumanToReader,
} from './human-owned-receipt-postgres.fixtures.js';

type Revocation = Readonly<{
  name: string;
  sql: string;
  parameters: (humanId: string, alias: string) => readonly unknown[];
}>;

const revocations: readonly Revocation[] = [
  { name: 'console account', sql: 'UPDATE console_users SET active=false WHERE id=$1', parameters: (humanId) => [humanId] },
  { name: 'external identity binding', sql: 'UPDATE human_external_identities SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1', parameters: (humanId) => [humanId] },
  { name: 'human tenant membership', sql: "UPDATE human_tenant_memberships SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1 AND tenant_id='Steven'", parameters: (humanId) => [humanId] },
  { name: 'technical room membership', sql: "UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1", parameters: (_humanId, alias) => [alias] },
  { name: 'technical role policy', sql: "UPDATE role_policies SET allow_read=false WHERE role='human-reader'", parameters: () => [] },
  { name: 'tenant', sql: "UPDATE tenants SET enabled=false WHERE id='Steven'", parameters: () => [] },
  { name: 'room', sql: "UPDATE rooms SET enabled=false WHERE tenant_id='Steven' AND id='grp.steven'", parameters: () => [] },
];

async function blockedPid(observer: DatabaseClient, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const result = await observer.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND pid<>$1 AND state<>\'idle\' LIMIT 1',
      [blockerPid],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no PostgreSQL backend blocked by PID ${String(blockerPid)}`);
}

async function assertRejected(pending: Promise<unknown>): Promise<void> {
  await expect(pending).rejects.toBeInstanceOf(Error);
}

describe('human-owned durable message reads on PostgreSQL', () => {
  it('returns the reply only to the owning human UUID when aliases are shared', async () => {
    const first = await seededHuman();
    const second = await seededHuman(first.alias);
    const firstRoot = await publishHumanRoot(first);
    const secondRoot = await publishHumanRoot(second);
    await finishRoots([
      { messageId: firstRoot.receipt.message_id, humanId: first.humanId, reply: `reply-${first.humanId}` },
      { messageId: secondRoot.receipt.message_id, humanId: second.humanId, reply: `reply-${second.humanId}` },
    ]);
    await switchHumanToReader(first);
    await switchHumanToReader(second);

    const firstView = await getRepository().getHumanMessage(firstRoot.receipt.message_id, humanOptions(first, 'read'));
    const secondView = await getRepository().getHumanMessage(secondRoot.receipt.message_id, humanOptions(second, 'read'));
    expect(firstView).toMatchObject({ chain_open: false });
    expect(firstView.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reply: `reply-${first.humanId}`, status: 'done' }),
    ]));
    expect(secondView.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reply: `reply-${second.humanId}`, status: 'done' }),
    ]));
    await expect(getRepository().getHumanMessage(firstRoot.receipt.message_id, humanOptions(second, 'read')))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not expose a legacy root without a durable human initiator', async () => {
    const account = await seededHuman();
    await switchHumanToReader(account);
    const legacyMessageId = await seedLegacyRoot(account.alias);
    await expect(getRepository().getHumanMessage(legacyMessageId, humanOptions(account, 'read')))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(revocations)('holds the $name revocation behind an authorized read transaction', async (revocation) => {
    const account = await seededHuman();
    const root = await publishHumanRoot(account);
    await switchHumanToReader(account);
    const options = humanOptions(account, 'read');
    const holder = await databasePool().connect();
    const contender = await databasePool().connect();
    try {
      await holder.query('BEGIN');
      const human = await humanMessageAuthority(holder, options);
      await lockHumanMessageRead(holder, root.receipt.message_id, human);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (holderPid === undefined) throw new Error('missing read-holder PostgreSQL PID');
      await contender.query('BEGIN');
      const update = contender.query(revocation.sql, [...revocation.parameters(account.humanId, account.alias)]);
      void update.catch(() => undefined);
      const waitingPid = await blockedPid(holder, holderPid);
      expect(waitingPid).not.toBe(holderPid);
      await holder.query('COMMIT');
      const revoked = await update;
      if (revoked.rowCount !== 1) throw new Error(`expected one row for ${revocation.name} revocation`);
      await contender.query('COMMIT');
      await assertRejected(getRepository().getHumanMessage(root.receipt.message_id, options));
    } finally {
      await holder.query('ROLLBACK');
      await contender.query('ROLLBACK');
      holder.release();
      contender.release();
    }
  });

  it.each(revocations)('observes a $name revocation committed before the read decision', async (revocation) => {
    const account = await seededHuman();
    const root = await publishHumanRoot(account);
    await switchHumanToReader(account);
    const options = humanOptions(account, 'read');
    const holder = await databasePool().connect();
    try {
      await holder.query('BEGIN');
      const update = await holder.query(revocation.sql, [...revocation.parameters(account.humanId, account.alias)]);
      if (update.rowCount !== 1) throw new Error(`expected one row for ${revocation.name} revocation`);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (holderPid === undefined) throw new Error('missing revoke-holder PostgreSQL PID');
      const read = getRepository().getHumanMessage(root.receipt.message_id, options);
      const rejected = assertRejected(read);
      const waitingPid = await blockedPid(holder, holderPid);
      expect(waitingPid).not.toBe(holderPid);
      await holder.query('COMMIT');
      await rejected;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('physically cancels a PostgreSQL backend blocked on human identity authority', async () => {
    const account = await seededHuman();
    const root = await publishHumanRoot(account);
    const holder = await databasePool().connect();
    const controller = new AbortController();
    const reason = new Error('cancel blocked human message read');
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE console_users SET display_name=display_name WHERE id=$1', [account.humanId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (holderPid === undefined) throw new Error('missing abort-holder PostgreSQL PID');
      const options = humanOptions(account, 'read', controller.signal);
      const pending = getRepository().getHumanMessage(root.receipt.message_id, options);
      const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      const blockedBackendPid = await blockedPid(holder, holderPid);
      controller.abort(reason);
      const result = await settled;
      expect('error' in result ? result.error : undefined).toBe(reason);
      await holder.query('SELECT pg_stat_clear_snapshot()');
      expect((await holder.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [blockedBackendPid])).rows).toEqual([]);
      await holder.query('COMMIT');
    } finally {
      controller.abort(reason);
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});
