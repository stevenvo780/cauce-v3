import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrationsThrough, createPool, firstFootprintMigration, migrationLockFootprints, migrationLockModes,
  migrationSourcesForApply, type DatabaseClient, type DatabasePool, type MigrationLockMode,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const base = '051_companies.sql';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
const pools: DatabasePool[] = [];
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough(base);
}, 120_000);
beforeEach(async () => {
  if (!database) return;
  current = await startTestCaseDatabase(database);
  pool = current.adminPool;
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((extra) => extra.end().catch(() => undefined)));
  await current?.close();
  current = undefined;
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function extraPool(max: number, applicationName: string): DatabasePool {
  if (!current) throw new Error('no case database');
  const extra = createPool(current.adminUrl, { max, applicationName });
  pools.push(extra);
  return extra;
}
function code(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'none';
}
async function appliedHead(): Promise<string | undefined> {
  return (await pool.query<{ version: string }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version;
}
/** An open transaction that read the table: the session a deploy must not migrate behind. */
async function idleReader(table: string): Promise<DatabaseClient> {
  const client = await extraPool(1, `idle-${table}`).connect();
  await client.query('BEGIN');
  await client.query(`SELECT count(*) FROM ${table}`);
  return client;
}
async function release(client: DatabaseClient): Promise<void> {
  await client.query('ROLLBACK');
  client.release();
}
async function timed(work: Promise<unknown>): Promise<{ ms: number; error: unknown }> {
  const started = Date.now();
  const error = await work.then(() => undefined, (failure: unknown) => failure);
  return { ms: Date.now() - started, error };
}
/** Autocommit readers in a tight loop, the way the dispatcher metrics and the gateway probe query. */
function hammer(queries: readonly string[], clients: number): { stop: () => Promise<{ done: number; errors: string[] }> } {
  const readers = extraPool(clients, 'migration-lock-load');
  let running = true;
  let done = 0;
  const errors: string[] = [];
  const loops = Array.from({ length: clients }, async (_, index) => {
    for (let round = index; running; round += 1) {
      try {
        await readers.query(queries[round % queries.length] ?? 'SELECT 1');
        done += 1;
      } catch (error) {
        errors.push(code(error));
      }
    }
  });
  return { stop: async () => { running = false; await Promise.all(loops); return { done, errors }; } };
}

const metricsQueries = [
  `SELECT m.lane,d.status,count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id GROUP BY m.lane,d.status`,
  `SELECT m.lane,count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
    WHERE d.status IN ('leased','accepted','started') AND d.claim_expires_at>now() GROUP BY m.lane`,
  `SELECT count(*) FROM connection_leases WHERE lease_until>now()`,
  `SELECT m.lane,o.status,count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id GROUP BY m.lane,o.status`,
  `SELECT a.alias,(SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.recipient_alias=a.alias)
     FROM agents a LEFT JOIN connection_leases l ON l.tenant_id=a.tenant_id AND l.alias=a.alias`,
];
const reverseOrderQueries = [
  `SELECT count(*) FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id`,
  `SELECT count(*) FROM quota_provider_reports pr JOIN quota_collections qc ON qc.id=pr.collection_id JOIN tenants t ON t.id=qc.collector_tenant`,
];

describe('migration lock footprints', () => {
  it('declares exactly the locks of SHARE or above each migration takes on the tables before it', async () => {
    const versions = (await migrationSourcesForApply()).filter((source) => source.version >= firstFootprintMigration);
    // A new migration shows up in the diff below with the footprint to declare for it.
    const measured: Record<string, Record<string, MigrationLockMode>> = {};
    for (const source of versions) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE TEMP TABLE before_migration ON COMMIT DROP AS
          SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace`);
        await client.query(source.source);
        const held = await client.query<{ relation: string; kind: string; mode: string }>(
          `SELECT COALESCE(owner.relname,c.relname) AS relation,
                  CASE WHEN owner.relname IS NULL THEN c.relkind::text ELSE 'r' END AS kind,
                  upper(regexp_replace(regexp_replace(l.mode,'Lock$',''),'([a-z])([A-Z])','\\1 \\2','g')) AS mode
             FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
             LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class owner ON owner.oid=i.indrelid
            WHERE l.pid=pg_backend_pid() AND l.locktype='relation' AND l.granted
              AND l.relation IN (SELECT oid FROM before_migration)`,
        );
        const footprint: Record<string, MigrationLockMode> = {};
        for (const lock of held.rows) {
          const rank = (migrationLockModes as readonly string[]).indexOf(lock.mode);
          if (rank < 0) continue;
          expect(lock.kind, `${source.version} locks ${lock.relation} in ${lock.mode}`).toMatch(/^[rp]$/u);
          const known = footprint[lock.relation];
          if (known === undefined || migrationLockModes.indexOf(known) < rank) footprint[lock.relation] = lock.mode as MigrationLockMode;
        }
        measured[source.version] = footprint;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await applyMigrationsThrough(pool, source.version);
    }
    expect(measured).toEqual(migrationLockFootprints);
  }, 120_000);
});

describe('migration lock waits', () => {
  it('fails within the lock timeout behind an idle transaction that read a table the bundle alters', async () => {
    await applyMigrationsThrough(pool, '057_quota_environments.sql');
    const reader = await idleReader('deliveries');
    const attempt = await timed(applyMigrationsThrough(pool, '058_context_versions.sql', { lockTimeoutMs: 1_000 }));
    expect(String(attempt.error)).toContain('lock timeout');
    expect(attempt.ms).toBeGreaterThanOrEqual(900);
    expect(attempt.ms).toBeLessThan(4_000);
    expect(await appliedHead()).toBe('057_quota_environments.sql');
    await release(reader);
    await applyMigrationsThrough(pool, '058_context_versions.sql', { lockTimeoutMs: 1_000 });
    expect(await appliedHead()).toBe('058_context_versions.sql');
  }, 60_000);

  it('bounds a wait inside a migration as well, not only the pre-lock', async () => {
    await applyMigrationsThrough(pool, '060_space_backups.sql');
    const holder = await extraPool(1, 'exclusive-holder').connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE company_admin_versions IN ACCESS EXCLUSIVE MODE');
    const attempt = await timed(applyMigrationsThrough(pool, '061_people_admin_history.sql', { lockTimeoutMs: 1_000 }));
    expect(String(attempt.error)).toContain('lock timeout');
    expect(attempt.ms).toBeLessThan(4_000);
    expect(await appliedHead()).toBe('060_space_backups.sql');
    await release(holder);
  }, 60_000);

  it('releases the backend of a migrator whose client died while it waited', async () => {
    await applyMigrationsThrough(pool, '057_quota_environments.sql');
    const reader = await idleReader('deliveries');
    const migrator = extraPool(1, 'dead-migrator');
    const run = applyMigrationsThrough(migrator, '058_context_versions.sql', { lockTimeoutMs: 30_000 }).then(() => 'applied', () => 'failed');
    let pid: number | undefined;
    for (let poll = 0; pid === undefined && poll < 100; poll += 1) {
      pid = (await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE application_name='dead-migrator' AND wait_event_type='Lock'`)).rows[0]?.pid;
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pid).toBeDefined();
    const clients = (migrator as unknown as { _clients: { processID?: number; connection: { stream: { destroy: () => void } } }[] })._clients;
    clients.find((client) => client.processID === pid)?.connection.stream.destroy();
    const killed = Date.now();
    let alive = true;
    while (alive && Date.now() - killed < 10_000) {
      alive = (await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid])).rows.length > 0;
      if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(alive).toBe(false);
    expect(Date.now() - killed).toBeLessThan(5_000);
    expect(await run).toBe('failed');
    await release(reader);
    expect(await appliedHead()).toBe('057_quota_environments.sql');
  }, 60_000);
});

describe('migration under live readers', () => {
  it('applies the bundle while dispatcher-metrics and readiness readers run, without a deadlock', async () => {
    await applyMigrationsThrough(pool, '052_runtime_roles.sql');
    const load = hammer(metricsQueries, 6);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const attempt = await timed(applyMigrationsThrough(pool, '065_runtime_grants_replay.sql'));
    const readers = await load.stop();
    expect(attempt.error).toBeUndefined();
    expect(readers.errors).toEqual([]);
    expect(readers.done).toBeGreaterThan(0);
    expect(await appliedHead()).toBe('065_runtime_grants_replay.sql');
  }, 60_000);

  it('finishes or fails fast and clean when readers lock in the opposite order too', async () => {
    await applyMigrationsThrough(pool, '052_runtime_roles.sql');
    const load = hammer([...metricsQueries, ...reverseOrderQueries], 8);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const attempt = await timed(applyMigrationsThrough(pool, '065_runtime_grants_replay.sql', { lockTimeoutMs: 2_000 }));
    const readers = await load.stop();
    expect(attempt.ms).toBeLessThan(15_000);
    if (attempt.error !== undefined) {
      expect(['40P01', '55P03']).toContain(code(attempt.error));
      expect(await appliedHead()).toBe('052_runtime_roles.sql');
    }
    expect(readers.errors.filter((failure) => failure !== '40P01')).toEqual([]);
    await applyMigrationsThrough(pool, '065_runtime_grants_replay.sql');
    expect(await appliedHead()).toBe('065_runtime_grants_replay.sql');
  }, 60_000);
});
