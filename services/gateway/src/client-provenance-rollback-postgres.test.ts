import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyMigrations, resolveHumanIdentity, type DatabasePool } from '@cauce/store';
import { database, databaseThrough, hybridHumanAuthorityDatabase, seed, connection, issuer } from '../../../packages/store/test/human-client-provenance-postgres.fixtures.js';
import { lineageRoot } from '../../../packages/store/test/human-message-lineage-postgres.fixtures.js';

const version = '046_human_client_provenance.sql';
const down = await readFile(new URL(`../../../packages/store/migrations/down/${version}`, import.meta.url), 'utf8');
const tables = ['human_message_client_provenance', 'human_client_delegation_operations', 'human_oauth_client_delegations'] as const;
async function durableAuthorityState(pool: DatabasePool) {
  const ledgers = [];
  for (const ledger of ['schema_migrations', 'schema_migration_ledger']) {
    ledgers.push((await pool.query(`SELECT to_jsonb(record) AS value FROM ${ledger} record ORDER BY version`)).rows);
  }
  const effects = [...tables, 'messages', 'deliveries', 'idempotency_keys', 'cauce_oauth_requests', 'cauce_oauth_grants',
    'cauce_oauth_codes', 'cauce_oauth_tokens', 'cauce_oauth_refresh_tokens', 'cauce_oauth_grant_revocations'];
  const counts = (await pool.query(effects.map(table =>
    `SELECT '${table}' AS name,count(*)::integer AS count FROM ${table}`).join(' UNION ALL '))).rows;
  return { ledgers, counts };
}

describe('human client rollback serialization on disposable PostgreSQL', () => {
  it('builds the historical prefix on a fresh database while latest fixtures keep later migrations', async () => {
    const historical = await databaseThrough(version); const latest = await database();
    for (const ledger of ['schema_migrations', 'schema_migration_ledger']) {
      expect((await historical.query(`SELECT version FROM ${ledger} WHERE version > $1`, [version])).rowCount).toBe(0);
      expect((await historical.query(`SELECT version FROM ${ledger} WHERE version=$1`, [version])).rowCount).toBe(1);
      expect((await latest.query(`SELECT version FROM ${ledger} WHERE version > $1`, [version])).rowCount).toBeGreaterThan(0);
    }
    expect((await historical.query<{ name: string | null }>("SELECT to_regclass('fleet_operations') AS name")).rows[0]?.name).toBeNull();
    expect((await latest.query<{ name: string | null }>("SELECT to_regclass('fleet_operations') AS name")).rows[0]?.name).toBe('fleet_operations');
  });
  it('rejects current human authority on the pure historical prefix without adding dependencies or effects', async () => {
    const pool = await databaseThrough(version); const owner = await seed(pool);
    const before = await durableAuthorityState(pool);
    expect((await pool.query("SELECT to_regprocedure('cauce_lock_authority_read_guard()') AS guard,to_regclass('companies') AS companies")).rows)
      .toEqual([{ guard: null, companies: null }]);
    await expect(resolveHumanIdentity(pool, { provider: 'oauth', namespace: issuer, subject: owner.humanId },
      new AbortController().signal)).rejects.toMatchObject({ code: '42P01', message: 'relation "companies" does not exist' });
    expect(await durableAuthorityState(pool)).toEqual(before);
  });
  it.each(['disabled', 'retired'] as const)('denies current publication for a %s company on the hybrid fixture without effects', async change => {
    const pool = await hybridHumanAuthorityDatabase(); const owner = await seed(pool); const c = await connection(pool, owner);
    const key = { provider: 'oauth' as const, namespace: issuer, subject: owner.humanId };
    expect(await resolveHumanIdentity(pool, key, new AbortController().signal)).toMatchObject({ humanId: owner.humanId });
    const result = await pool.query(`UPDATE companies SET enabled=false,retired_at=CASE WHEN $1 THEN now() ELSE NULL END
      WHERE id=(SELECT company_id FROM tenants WHERE id='Steven') RETURNING retired_at IS NOT NULL AS retired`, [change === 'retired']);
    expect(result.rows).toEqual([{ retired: change === 'retired' }]);
    const before = await durableAuthorityState(pool);
    expect(await resolveHumanIdentity(pool, key, new AbortController().signal)).toBeUndefined();
    await expect(c.operations.submit({ request_key: randomUUID(), room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'denied company publication' } }))
      .rejects.toMatchObject({ failure: { status_code: 401 } });
    expect(await durableAuthorityState(pool)).toEqual(before);
  });
  it('removes the empty schema and both migration records atomically and can migrate up again', async () => {
    const pool = await databaseThrough(version);
    await pool.query(down);
    for (const table of tables) {
      expect((await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name).toBeNull();
    }
    for (const table of ['schema_migrations', 'schema_migration_ledger']) {
      expect((await pool.query(`SELECT version FROM ${table} WHERE version=$1`, [version])).rowCount).toBe(0);
    }
    await applyMigrations(pool);
    for (const table of tables) {
      expect((await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name).toBe(table);
    }
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(1);
  });

  it('refuses an empty downgrade when a later migration is recorded', async () => {
    const pool = await databaseThrough(version);
    await pool.query("INSERT INTO schema_migrations(version) VALUES('047_fixture_later.sql')");
    await expect(pool.query(down)).rejects.toThrow('cannot downgrade schema 046 while a later migration is present');
    for (const table of tables) {
      expect((await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name).toBe(table);
    }
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(1);
  });

  for (const key of ['783003003', '783003046']) {
    it(`honors advisory migration lock ${key}`, async () => {
      const pool = await databaseThrough(version); const holder = await pool.connect(); const rollback = await pool.connect();
      try {
        await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        await rollback.query("SET lock_timeout='100ms'");
        await expect(rollback.query(down)).rejects.toMatchObject({ code: '55P03' });
        for (const table of tables) {
          expect((await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name).toBe(table);
        }
      } finally {
        await holder.query('ROLLBACK'); holder.release(); rollback.release();
      }
    });
  }

  for (const table of tables) {
    it(`waits for a concurrent committed insert into ${table} and preserves it`, async () => {
      const pool = await hybridHumanAuthorityDatabase(); const owner = await seed(pool); const c = await connection(pool, owner);
      const root = await lineageRoot(pool, owner.humanId);
      const holder = await pool.connect(); const rollback = await pool.connect();
      let attempt: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN'); await holder.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
        await rollback.query('BEGIN'); await rollback.query("SET LOCAL lock_timeout='10s'");
        const pid = (await rollback.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        attempt = rollback.query(down).then(() => null, (error: unknown) => error);
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation=$2::regclass
            AND mode='AccessExclusiveLock' AND NOT granted) AS waiting`, [pid, table],
        )).rows[0]?.waiting, { timeout: 5000 }).toBe(true);
        if (table === 'human_message_client_provenance') {
          await holder.query(`INSERT INTO human_message_client_provenance(root_message_id,initiating_human_id,
            initiating_tenant_id,conversation_id,local_oauth_grant_id) VALUES($1,$2,'Steven',$3,$4)`,
          [root.messageId, owner.humanId, root.conversationId, c.identity.grantId]);
        } else if (table === 'human_oauth_client_delegations') {
          await holder.query(`INSERT INTO human_oauth_client_delegations(local_oauth_grant_id,human_id,
            tenant_id,declared_by_human_id,label) VALUES($1,$2,'Steven',$2,'Dots')`, [c.identity.grantId, owner.humanId]);
        } else {
          await holder.query(`INSERT INTO human_client_delegation_operations(human_id,tenant_id,request_id,
            request_hash,operation,response) VALUES($1,'Steven',$2,$3,'create','{}')`,
          [owner.humanId, randomUUID(), 'a'.repeat(64)]);
        }
        await holder.query('COMMIT');
        const result = await attempt;
        if (result === null) {
          const remaining = await rollback.query<{ name: string | null }>(
            'SELECT to_regclass(name) AS name FROM unnest($1::text[]) AS name', [[...tables]]);
          console.info('Rollback accepted concurrent history inside disposable test transaction', { table, remaining: remaining.rows });
        }
        expect(result).toBeInstanceOf(Error);
        expect(result instanceof Error ? result.message : null).toContain('populated provenance schema cannot be removed');
        await rollback.query('ROLLBACK');
        expect((await pool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0]?.n).toBe(1);
        expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(1);
      } finally {
        await holder.query('ROLLBACK');
        await attempt;
        await rollback.query('ROLLBACK');
        holder.release(); rollback.release();
      }
    });
  }
});
