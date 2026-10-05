import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '@cauce/store';
import { database, seed, connection } from '../../../packages/store/test/human-client-provenance-postgres.fixtures.js';
import { lineageRoot } from '../../../packages/store/test/human-message-lineage-postgres.fixtures.js';

const version = '046_human_client_provenance.sql';
const down = await readFile(new URL(`../../../packages/store/migrations/down/${version}`, import.meta.url), 'utf8');
const tables = ['human_message_client_provenance', 'human_client_delegation_operations', 'human_oauth_client_delegations'] as const;

describe('human client rollback serialization on disposable PostgreSQL', () => {
  it('removes the empty schema and both migration records atomically and can migrate up again', async () => {
    const pool = await database();
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
    const pool = await database();
    await pool.query("INSERT INTO schema_migrations(version) VALUES('047_fixture_later.sql')");
    await expect(pool.query(down)).rejects.toThrow('cannot downgrade schema 046 while a later migration is present');
    for (const table of tables) {
      expect((await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name).toBe(table);
    }
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(1);
  });

  for (const key of ['783003003', '783003046']) {
    it(`honors advisory migration lock ${key}`, async () => {
      const pool = await database(); const holder = await pool.connect(); const rollback = await pool.connect();
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
      const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
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
