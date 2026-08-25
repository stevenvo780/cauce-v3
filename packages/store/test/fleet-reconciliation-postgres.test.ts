import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import { startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;

const downPath = new URL('../migrations/down/029_reconcile_declared_fleet.sql', import.meta.url);
const notifyRolePath = new URL('../migrations/027_rol_agent_notify.sql', import.meta.url);

async function runDown(): Promise<void> {
  await pool.query(await readFile(downPath, 'utf8'));
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

afterAll(async () => {
  try {
    const applied = await pool.query<{ applied: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM schema_migrations WHERE version='029_reconcile_declared_fleet.sql'
       ) AS applied`,
    );
    if (applied.rows[0]?.applied !== true) await applyMigrations(pool);
  } finally {
    if (pool) await pool.end();
    if (database?.container) await database.container.stop();
  }
});

describe('029 reconciles desired catalog without inventing runtime presence', () => {
  it('027 creates the exact notify policy idempotently and refuses pre-existing permission drift', async () => {
    const source = await readFile(notifyRolePath, 'utf8');

    // Exercise the missing-row path without violating membership foreign keys, then restore the
    // exact applied 029 shape before committing the test setup.
    await pool.query('BEGIN');
    try {
      await pool.query(`UPDATE memberships SET role='agent' WHERE role='agent_notify'`);
      await pool.query(`DELETE FROM role_policies WHERE role='agent_notify'`);
      await pool.query(source);
      const inserted = await pool.query(
        `SELECT allow_route,allow_read,allow_control,allow_notify
           FROM role_policies WHERE role='agent_notify'`,
      );
      expect(inserted.rows).toEqual([{
        allow_route: true, allow_read: true, allow_control: false, allow_notify: true,
      }]);
      await pool.query(`UPDATE memberships SET role='agent_notify'
                         WHERE (tenant_id,alias) IN (
                           ('Steven','jarvis'),('Steven','socrates'),('Steven','zeus')
                         )`);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

    // Re-applying the exact contract is a no-op. A divergent pre-existing row is never silently
    // accepted or overwritten; the operator must resolve that authority change explicitly.
    await expect(pool.query(source)).resolves.toBeDefined();
    await pool.query(`UPDATE role_policies SET allow_control=true WHERE role='agent_notify'`);
    await expect(pool.query(source)).rejects.toThrow(/027 refuses divergent agent_notify role policy/);
    const divergent = await pool.query<{ allow_control: boolean }>(
      `SELECT allow_control FROM role_policies WHERE role='agent_notify'`,
    );
    expect(divergent.rows).toEqual([{ allow_control: true }]);
    await pool.query(`UPDATE role_policies SET allow_control=false WHERE role='agent_notify'`);
  });

  it('down029 waits on the same advisory lock as the forward migrator before touching state', async () => {
    const source = await readFile(downPath, 'utf8');
    const holder = await pool.connect();
    const runner = await pool.connect();
    let down: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      const runnerPid = await runner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      down = runner.query(source);

      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const lock = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted
           ) AS waiting`,
          [runnerPid.rows[0]!.pid],
        );
        if (lock.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await pool.query(
        `SELECT 1 FROM schema_migrations WHERE version='029_reconcile_declared_fleet.sql'`,
      )).rowCount).toBe(1);

      await holder.query('COMMIT');
      await down;
      down = undefined;
      expect((await pool.query(
        `SELECT 1 FROM schema_migrations WHERE version='029_reconcile_declared_fleet.sql'`,
      )).rowCount).toBe(0);
      await applyMigrations(pool);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      if (down !== undefined) await down.catch(() => undefined);
      holder.release();
      runner.release();
    }
  });

  it('is exact, idempotent, lease-preserving and CAS-safe on rollback', async () => {
    await runDown();

    // Simulate the measured pre-cutover shape: a historical alias is live and Pablo remains
    // catalogued but disabled. Epochs are evidence of runtime presence and must never be reset.
    await pool.query(`
      INSERT INTO agents(
        tenant_id,alias,harness_id,display_name,enabled,
        container_name,runtime_user,home_directory,state_directory
      ) VALUES (
        'Jhon','heraclito','openclaw','Heraclito',true,
        'agv2-jhon-heraclito-oc','claw','/home/claw','/home/claw/.openclaw/cauce-v3/heraclito'
      ) ON CONFLICT (tenant_id,alias) DO UPDATE SET enabled=true;
      INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
      VALUES ('Jhon','grp.jhon','heraclito','agent',true)
      ON CONFLICT (tenant_id,room_id,alias) DO UPDATE SET enabled=true,role='agent';
      INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until)
      VALUES
        ('Steven','kant','instance-kant',41,now()+interval '5 minutes'),
        ('Jhon','heraclito','instance-heraclito',73,now()+interval '5 minutes');
    `);

    const leasesBefore = await pool.query(
      `SELECT tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at,connected_at
         FROM connection_leases ORDER BY tenant_id,alias`,
    );
    await applyMigrations(pool);

    const enabled = await pool.query<{ tenant_id: string; alias: string }>(
      `SELECT tenant_id,alias FROM agents WHERE enabled ORDER BY tenant_id,alias`,
    );
    expect(enabled.rows).toHaveLength(15);
    expect(enabled.rows.map((row) => row.alias).sort()).toEqual([
      'argos', 'atlas', 'dedalo', 'hegel', 'iza', 'janus', 'jarvis', 'kant', 'kratos',
      'midas', 'salva', 'seneca', 'socrates', 'vulcano', 'zeus',
    ]);

    const keyRows = await pool.query(
      `SELECT tenant_id,alias,harness_id,container_name,runtime_user,home_directory,state_directory,enabled
         FROM agents WHERE alias IN ('argos','kant','zeus','heraclito') ORDER BY alias`,
    );
    expect(keyRows.rows).toEqual([
      expect.objectContaining({ alias: 'argos', harness_id: 'claude', container_name: 'ctrl-infra', enabled: true }),
      expect.objectContaining({ alias: 'heraclito', enabled: false }),
      expect.objectContaining({
        alias: 'kant', container_name: 'host:kratos', runtime_user: 'stev',
        home_directory: '/home/stev', state_directory: '/home/stev/.local/state/cauce-v3/kant', enabled: true,
      }),
      expect.objectContaining({ alias: 'zeus', harness_id: 'claude', container_name: 'ws-zeus', enabled: true }),
    ]);

    const memberships = await pool.query(
      `SELECT tenant_id,alias,room_id,role FROM memberships WHERE enabled ORDER BY tenant_id,alias`,
    );
    expect(memberships.rows).toHaveLength(16);
    expect(memberships.rows).toEqual(expect.arrayContaining([
      { tenant_id: 'Steven', alias: 'quota-collector', room_id: 'grp.steven', role: 'operator' },
      { tenant_id: 'Miguel', alias: 'janus', room_id: 'grp.miguel', role: 'operator' },
      { tenant_id: 'Steven', alias: 'zeus', room_id: 'grp.steven', role: 'agent_notify' },
    ]));
    expect(await pool.query(`SELECT 1 FROM agents WHERE alias='quota-collector'`)
      .then((result) => result.rowCount)).toBe(0);

    const leasesAfter = await pool.query(
      `SELECT tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at,connected_at
         FROM connection_leases ORDER BY tenant_id,alias`,
    );
    expect(leasesAfter.rows).toEqual(leasesBefore.rows);

    // Re-applying the same numbered migration does not recapture a polluted before-image or
    // create a second active reconciliation run.
    await pool.query(`DELETE FROM schema_migrations WHERE version='029_reconcile_declared_fleet.sql'`);
    await applyMigrations(pool);
    const activeRuns = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fleet_reconciliation_runs WHERE active`,
    );
    expect(activeRuns.rows[0]?.count).toBe('1');

    // A forward writer makes rollback fail closed. The SAME transaction keeps the run/version
    // active and writes no partial rollback audit or data mutation.
    const rollbackAuditBeforeRefusal = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='fleet.rollback.029'`,
    );
    await pool.query(`UPDATE agents SET state_directory='/forward/zeus' WHERE tenant_id='Steven' AND alias='zeus'`);
    await expect(runDown()).rejects.toThrow(/029 rollback refused: CAS conflicts/);
    const zeus = await pool.query<{ enabled: boolean; state_directory: string }>(
      `SELECT enabled,state_directory FROM agents WHERE tenant_id='Steven' AND alias='zeus'`,
    );
    expect(zeus.rows).toEqual([{ enabled: true, state_directory: '/forward/zeus' }]);
    expect((await pool.query(
      `SELECT 1 FROM schema_migrations WHERE version='029_reconcile_declared_fleet.sql'`,
    )).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM fleet_reconciliation_runs WHERE active`)).rowCount).toBe(1);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='fleet.rollback.029'`,
    )).rows).toEqual(rollbackAuditBeforeRefusal.rows);
    const leasesAfterRefusal = await pool.query(
      `SELECT tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at,connected_at
         FROM connection_leases ORDER BY tenant_id,alias`,
    );
    expect(leasesAfterRefusal.rows).toEqual(leasesBefore.rows);

    // Restore the exact applied image, then the same down succeeds and still preserves leases.
    await pool.query(
      `UPDATE agents SET state_directory='/home/dev/.local/state/cauce-v3/zeus'
        WHERE tenant_id='Steven' AND alias='zeus'`,
    );
    await runDown();
    const leasesAfterDown = await pool.query(
      `SELECT tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at,connected_at
         FROM connection_leases ORDER BY tenant_id,alias`,
    );
    expect(leasesAfterDown.rows).toEqual(leasesBefore.rows);

    await applyMigrations(pool);
  });
});
