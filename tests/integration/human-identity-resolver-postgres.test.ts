import { afterAll, describe, expect, it } from 'vitest';
import { lockHumanIdentity, resolveHumanIdentity, withAbortableTransaction, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { addDefaultMembership, revocations, seedIdentity, waitForBlocked } from './human-identity-resolver-postgres.fixtures.js';

let database: TestDatabase | undefined;
const pool = (): DatabasePool => {
  if (!database) throw new Error('PostgreSQL setup has not run');
  return database.pool;
};
const signal = (): AbortSignal => new AbortController().signal;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
afterAll(async () => {
  if (!database) return;
  try { await database.pool.end(); } finally { await database.container.stop(); }
});

describe('durable human identity resolver on PostgreSQL', () => {
  it('returns only the safe DTO with exact decimal revisions', async () => {
    const f = await seedIdentity(pool());
    const result = await resolveHumanIdentity(pool(), f.key, signal());
    expect(result).toMatchObject({ ...f.key, humanId: f.humanId, bindingRevision: '9007199254740993',
      account: { active: true, defaultTenant: 'Steven', displayName: 'Fixture human', role: 'operator' },
      membership: { tenantId: 'Steven', actorAlias: f.alias, revision: '9007199254740994' } });
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'account', 'bindingId', 'bindingRevision', 'humanId', 'membership', 'namespace', 'provider', 'subject',
    ]);
    expect(Object.keys(result?.account ?? {}).sort()).toEqual(['active', 'defaultTenant', 'displayName', 'role']);
    expect(Object.isFrozen(result?.membership.permissions)).toBe(true);
  });

  it('does not normalize issuer or subject or infer a UUID binding', async () => {
    const f = await seedIdentity(pool());
    for (const key of [{ ...f.key, namespace: `${f.key.namespace}/` }, { ...f.key, namespace: f.key.namespace.toUpperCase() },
      { ...f.key, subject: ` ${f.key.subject}` }, { ...f.key, subject: f.key.subject.toUpperCase() }]) {
      expect(await resolveHumanIdentity(pool(), key, signal())).toBeUndefined();
    }
    const other = await seedIdentity(pool(), f.alias);
    expect((await resolveHumanIdentity(pool(), other.key, signal()))?.humanId).toBe(other.humanId);
    expect((await resolveHumanIdentity(pool(), f.key, signal()))?.humanId).toBe(f.humanId);
  });

  it('fails closed for a missing default membership and follows only the account default', async () => {
    const f = await seedIdentity(pool());
    await pool().query("UPDATE console_users SET tenant_id='Jhon' WHERE id=$1", [f.humanId]);
    expect(await resolveHumanIdentity(pool(), f.key, signal())).toBeUndefined();
    await addDefaultMembership(pool(), f.humanId, f.alias);
    expect((await resolveHumanIdentity(pool(), f.key, signal()))?.membership.tenantId).toBe('Jhon');
  });

  it('takes the effective alias from membership rather than the account', async () => {
    const f = await seedIdentity(pool());
    await pool().query("UPDATE console_users SET alias='untrusted-account-alias' WHERE id=$1", [f.humanId]);
    expect((await resolveHumanIdentity(pool(), f.key, signal()))?.membership.actorAlias).toBe(f.alias);
  });

  it.each(Object.entries(revocations))('fails closed after %s revocation', async (_name, sql) => {
    const f = await seedIdentity(pool());
    await pool().query(sql, [f.humanId]);
    expect(await resolveHumanIdentity(pool(), f.key, signal())).toBeUndefined();
  });

  it('does not accept a different pinned human sharing the actor alias', async () => {
    const first = await seedIdentity(pool());
    const second = await seedIdentity(pool(), first.alias);
    await expect(withAbortableTransaction(pool(), signal(), (client) => lockHumanIdentity(client, first.key, second.humanId)))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each(Object.entries(revocations))('retains the %s share lock until transaction commit', async (_name, sql) => {
    const f = await seedIdentity(pool());
    const holder = await pool().connect();
    const contender = await pool().connect();
    try {
      await holder.query('BEGIN');
      await lockHumanIdentity(holder, f.key, f.humanId);
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout='5s'");
      const pid = (await contender.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('missing contender PID');
      const update = contender.query(sql, [f.humanId]);
      void update.catch(() => undefined);
      await waitForBlocked(holder, pid);
      await holder.query('COMMIT');
      await update;
      await contender.query('COMMIT');
      expect(await resolveHumanIdentity(pool(), f.key, signal())).toBeUndefined();
    } finally {
      await holder.query('ROLLBACK'); await contender.query('ROLLBACK');
      holder.release(); contender.release();
    }
  });

  it.each(Object.entries(revocations))('observes a %s revocation that commits before the lock decision', async (_name, sql) => {
    const f = await seedIdentity(pool());
    const holder = await pool().connect();
    const contender = await pool().connect();
    try {
      await holder.query('BEGIN'); await holder.query(sql, [f.humanId]);
      await contender.query('BEGIN'); await contender.query("SET LOCAL lock_timeout='5s'");
      const pid = (await contender.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('missing contender PID');
      const pending = lockHumanIdentity(contender, f.key, f.humanId);
      const denied = expect(pending).rejects.toMatchObject({ code: 'forbidden' });
      await waitForBlocked(holder, pid);
      await holder.query('COMMIT');
      await denied;
    } finally {
      await holder.query('ROLLBACK'); await contender.query('ROLLBACK');
      holder.release(); contender.release();
    }
  });

  it('physically cancels blocked resolver SQL and releases its backend', async () => {
    const f = await seedIdentity(pool());
    const holder = await pool().connect();
    const controller = new AbortController();
    const reason = new Error('cancel identity resolution');
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE console_users SET display_name=display_name WHERE id=$1', [f.humanId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const pending = resolveHumanIdentity(pool(), f.key, controller.signal);
      const rejected = expect(pending).rejects.toThrow(reason.message);
      let blockedPid: number | undefined;
      const deadline = Date.now() + 3000;
      while (blockedPid === undefined && Date.now() < deadline) {
        blockedPid = (await holder.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid],
        )).rows[0]?.pid;
        if (blockedPid === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedPid).toBeDefined();
      controller.abort(reason);
      await rejected;
      await holder.query('SELECT pg_stat_clear_snapshot()');
      expect((await holder.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [blockedPid])).rows).toEqual([]);
      await holder.query('COMMIT');
      expect((await resolveHumanIdentity(pool(), f.key, signal()))?.humanId).toBe(f.humanId);
    } finally {
      controller.abort(reason); await holder.query('ROLLBACK'); holder.release();
    }
  });
});
