import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyMigrations, withAbortableTransaction, withTransaction, type DatabasePool } from '@cauce/store';
import { database, seed, connection, controlOptions, verify } from '../../../packages/store/test/human-client-provenance-postgres.fixtures.js';
import { lockOAuthAccess } from './oauth-grant-authority.js';

const version = '046_human_client_provenance.sql';
const down = await readFile(new URL(`../../../packages/store/migrations/down/${version}`, import.meta.url), 'utf8');
const relations = ['cauce_oauth_grants', 'human_message_client_provenance',
  'human_client_delegation_operations', 'human_oauth_client_delegations', 'schema_migrations'];
function gate<T>() {
  let resolve: (value: T) => void = () => { throw new Error('gate unavailable'); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const command = () => ({ request_key: randomUUID(), room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven' as const, alias: 'argos' }], body: { text: 'schema barrier fixture' } });
async function pendingSchemaLocks(pool: DatabasePool) {
  return (await pool.query<{ pid: number; mode: string }>(`SELECT pid,mode FROM pg_locks
    WHERE locktype='advisory' AND classid=0 AND objid=783003003 AND objsubid=1 AND NOT granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY pid`)).rows;
}
async function tableLocks(pool: DatabasePool, pid: number) {
  return (await pool.query<{ name: string; mode: string }>(`SELECT c.relname AS name,l.mode
    FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=$1 AND c.relname=ANY($2::text[])`,
  [pid, relations])).rows;
}
async function schemaLedger(pool: DatabasePool) {
  return (await pool.query<{ source_sha256: string }>('SELECT source_sha256 FROM schema_migration_ledger WHERE version=$1', [version])).rows;
}

describe('schema barriers before durable authority table locks on PostgreSQL', () => {

  it('fences the direct OAuth readiness probe before it accesses any authority table', async () => {
    const pool = await database(); const owner = await seed(pool); const holder = await pool.connect();
    let readiness: Promise<void> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      readiness = owner.store.ready(); void readiness.catch(() => undefined);
      await expect.poll(async () => (await pendingSchemaLocks(pool)).length).toBe(1);
      const waiting = (await pendingSchemaLocks(pool))[0];
      if (!waiting) throw new Error('missing blocked readiness probe');
      expect(waiting.mode).toBe('ShareLock'); expect(await tableLocks(pool, waiting.pid)).toEqual([]);
      await holder.query('COMMIT'); await readiness;
    } finally { await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled(readiness ? [readiness] : []); }
  });

  it('rejects invalid barrier bounds before checking out either transaction client', async () => {
    const pool = await database(); const count = pool.totalCount; let callback = false;
    const work = async () => { callback = true; };
    for (const schemaLockTimeoutMs of [0, -1, 60_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(withTransaction(pool, work, { schemaLockTimeoutMs })).rejects.toBeInstanceOf(RangeError);
      await expect(withAbortableTransaction(pool, new AbortController().signal, work,
        { schemaLockTimeoutMs })).rejects.toBeInstanceOf(RangeError);
      expect(pool.totalCount).toBe(count);
    }
    expect(callback).toBe(false);
  });

  it('serializes the real grant-first publisher before down046 and preserves its receipt and retry', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const before = await schemaLedger(pool); const entered = gate<number>(); const release = gate<null>();
    const publish = c.repository.publish.bind(c.repository);
    c.repository.publish = (input, options) => {
      const authority = options?.humanAuthority;
      if (!authority) throw new Error('real human authority required');
      return publish(input, { ...options, humanAuthority: async client => {
        await lockOAuthAccess(client, c.identity, controlOptions.issuer, controlOptions.resource, verify);
        entered.resolve((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0);
        await release.promise;
        return authority(client);
      } });
    };
    const rollback = await pool.connect(); const input = command(); const publication = c.operations.submit(input);
    void publication.catch(() => undefined);
    let attempt: Promise<unknown> | undefined;
    try {
      const publisherPid = await entered.promise;
      expect(publisherPid).toBeGreaterThan(0);
      expect(await tableLocks(pool, publisherPid)).toContainEqual({ name: 'cauce_oauth_grants', mode: 'RowShareLock' });
      expect((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND objid=783003003
        AND locktype='advisory' AND mode='ShareLock' AND granted`, [publisherPid])).rowCount).toBe(1);
      await rollback.query('BEGIN');
      const rollbackPid = (await rollback.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
      attempt = rollback.query(down).then(() => null, (error: unknown) => error);
      await expect.poll(() => pendingSchemaLocks(pool)).toContainEqual({ pid: rollbackPid, mode: 'ExclusiveLock' });
      expect(await tableLocks(pool, rollbackPid)).toEqual([]);
      release.resolve(null);
      const rejected = await attempt;
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected instanceof Error ? rejected.message : '').toContain('populated provenance schema cannot be removed');
      expect(rejected).not.toHaveProperty('code', '40P01');
      await rollback.query('ROLLBACK');
      const receipt = await publication;
      c.repository.publish = publish;
      expect((await c.operations.submit(input)).message_id).toBe(receipt.message_id);
      expect(await schemaLedger(pool)).toEqual(before);
      expect((await pool.query('SELECT root_message_id FROM human_message_client_provenance')).rows)
        .toEqual([{ root_message_id: receipt.message_id }]);
      expect((await pool.query('SELECT message_id FROM idempotency_keys WHERE message_id=$1', [receipt.message_id])).rowCount).toBe(1);
      expect((await pool.query('SELECT id FROM messages')).rows).toEqual([{ id: receipt.message_id }]);
    } finally {
      release.resolve(null); c.repository.publish = publish;
      await rollback.query('ROLLBACK'); rollback.release();
      await Promise.allSettled([publication, ...(attempt ? [attempt] : [])]);
    }
  });

  it('blocks the prepared real publisher before table locks when empty down046 wins, with no partial root', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const entered = gate<null>(); const start = gate<null>(); const publish = c.repository.publish.bind(c.repository);
    c.repository.publish = async (input, options) => { entered.resolve(null); await start.promise; return publish(input, options); };
    const publication = c.operations.submit(command()); void publication.catch(() => undefined);
    const rollback = await pool.connect();
    try {
      await entered.promise;
      await rollback.query('BEGIN'); await rollback.query('SELECT pg_advisory_xact_lock(783_003_003)');
      start.resolve(null);
      await expect.poll(async () => (await pendingSchemaLocks(pool)).length).toBe(1);
      const publisher = (await pendingSchemaLocks(pool))[0];
      expect(publisher?.mode).toBe('ShareLock');
      if (!publisher) throw new Error('missing blocked publisher');
      expect(await tableLocks(pool, publisher.pid)).toEqual([]);
      await rollback.query(down); await rollback.query('COMMIT');
      await expect(publication).rejects.toMatchObject({ failure: { status_code: 503 } });
      expect((await pool.query('SELECT id FROM messages')).rows).toEqual([]);
      expect((await pool.query('SELECT message_id FROM human_message_initiators')).rows).toEqual([]);
      expect((await pool.query('SELECT message_id FROM idempotency_keys')).rows).toEqual([]);
      expect(await schemaLedger(pool)).toEqual([]);
    } finally {
      start.resolve(null); await rollback.query('ROLLBACK'); rollback.release();
      await Promise.allSettled([publication]); c.repository.publish = publish;
    }
  });

  it('starts two real migrators with exclusive barriers, never shared-to-exclusive upgrades', async () => {
    const pool = await database(); const holder = await pool.connect(); const before = await schemaLedger(pool);
    const attempts: Promise<void>[] = [];
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      attempts.push(applyMigrations(pool), applyMigrations(pool));
      for (const attempt of attempts) void attempt.catch(() => undefined);
      await expect.poll(async () => (await pendingSchemaLocks(pool)).length).toBe(2);
      const waiting = await pendingSchemaLocks(pool);
      expect(waiting.map(lock => lock.mode)).toEqual(['ExclusiveLock', 'ExclusiveLock']);
      for (const lock of waiting) {
        expect(await tableLocks(pool, lock.pid)).toEqual([]);
        expect((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'
          AND objid=783003003 AND mode='ShareLock'`, [lock.pid])).rowCount).toBe(0);
      }
      await holder.query('COMMIT'); await Promise.all(attempts);
      expect(await schemaLedger(pool)).toEqual(before);
    } finally { await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled(attempts); }
  });

  it('terminates an aborted barrier backend without running the callback or holding authority tables', async () => {
    const pool = await database(); const holder = await pool.connect(); const controller = new AbortController();
    let callback = false; let attempt: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      attempt = withAbortableTransaction(pool, controller.signal, async client => {
        callback = true; await client.query('INSERT INTO agents(tenant_id,alias) VALUES($1,$2)', ['Steven', 'aborted']);
      });
      void attempt.catch(() => undefined);
      await expect.poll(async () => (await pendingSchemaLocks(pool)).length).toBe(1);
      const waiting = (await pendingSchemaLocks(pool))[0];
      if (!waiting) throw new Error('missing barrier backend');
      expect(await tableLocks(pool, waiting.pid)).toEqual([]);
      controller.abort(new Error('cancel schema barrier'));
      await expect(attempt).rejects.toThrow('cancel schema barrier');
      expect(callback).toBe(false);
      expect((await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [waiting.pid])).rowCount).toBe(0);
      await holder.query('COMMIT');
      expect((await pool.query("SELECT 1 FROM agents WHERE alias='aborted'")).rowCount).toBe(0);
      expect(await pendingSchemaLocks(pool)).toEqual([]);
    } finally { controller.abort(); await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled(attempt ? [attempt] : []); }
  });

  it.each(['read', 'migrate'] as const)('bounds %s waiting before callback and restores the pool after timeout', async schemaMode => {
    const pool = await database(); const holder = await pool.connect(); let callback = false;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      await expect(withTransaction(pool, async () => { callback = true; },
        { schemaMode, schemaLockTimeoutMs: 75 })).rejects.toMatchObject({ code: '55P03' });
      expect(callback).toBe(false); expect(await pendingSchemaLocks(pool)).toEqual([]);
      await holder.query('COMMIT');
      expect(await withTransaction(pool, async client => (await client.query<{ value: string }>(
        "SELECT current_setting('lock_timeout') AS value")).rows[0]?.value)).toBe('0');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });

  it('honors a shorter session timeout and preserves callback timeout settings', async () => {
    const pool = await database();
    expect(await withTransaction(pool, async client => (await client.query<{ lock: string; statement: string }>(
      "SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows[0]))
      .toEqual({ lock: '0', statement: '0' });
    const holder = await pool.connect(); const reader = await pool.connect();
    try {
      await reader.query("SET lock_timeout='40ms'; SET statement_timeout='700ms'"); reader.release();
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      await expect(withTransaction(pool, async () => { throw new Error('callback must not start'); },
        { schemaLockTimeoutMs: 5_000 })).rejects.toMatchObject({ code: '55P03' });
      await holder.query('COMMIT');
      expect(await withTransaction(pool, async client => (await client.query<{ lock: string; statement: string }>(
        "SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows[0]))
        .toEqual({ lock: '40ms', statement: '700ms' });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
});
