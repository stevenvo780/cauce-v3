import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyMigrationsThrough, type DatabasePool } from '../src/index.js';
import { downSnapshot, downSql, registerDownSafetyTests, rejectDown } from './down-safety.fixtures.js';

const targets = [
  { version: '051_companies.sql', marker: 'companies', kind: 'table' },
  { version: '052_runtime_roles.sql', marker: 'cauce_runtime_grants_052()', kind: 'function' },
  { version: '053_company_isolation.sql', marker: 'cauce_runtime_grants_053()', kind: 'function', lockTable: 'config_revisions' },
  { version: '054_company_admins.sql', marker: 'company_admins', kind: 'table' },
  { version: '055_company_registration.sql', marker: 'company_admin_versions', kind: 'table', lockTable: 'company_admin_versions' },
  { version: '056_company_office.sql', marker: 'company_office_layouts', kind: 'table' },
] as const;
const getPool = registerDownSafetyTests(import.meta.url, '050_fleet_hosts.sql', targets);

async function person(pool: DatabasePool): Promise<string> {
  const id = randomUUID(); const email = `${id}@example.invalid`;
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Rollback fixture','operator','Steven','kant')`, [id, email, '$scrypt$' + 'x'.repeat(48)]);
  return id;
}

async function baselineAdministrator(pool: DatabasePool): Promise<string> {
  await applyMigrationsThrough(pool, '054_company_admins.sql');
  const id = await person(pool);
  await pool.query(`INSERT INTO company_admins(company_id,human_id,role,source)
    VALUES('humanizar',$1,'admin','v4.0-hub-operator')`, [id]);
  return id;
}

describe('audit attribution protected by 053 down', () => {
  const version = '053_company_isolation.sql';
  it.each(['audit-actor', 'revision-actor', 'platform-override'])('refuses to erase %s metadata and preserves every row', async kind => {
    const pool = getPool(); await applyMigrationsThrough(pool, version);
    const human = await person(pool);
    if (kind === 'audit-actor') {
      await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,actor_human_id)
        VALUES('Steven','kant','rollback.actor','allow',$1)`, [human]);
    } else {
      if (kind === 'platform-override') await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [human]);
      await pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary,actor_human_id,platform_override)
        VALUES('Steven','kant','{"resource":"room"}','{}','Rollback history',$1,$2)`,
      [human, kind === 'platform-override']);
      if (kind === 'platform-override') {
        await pool.query('ALTER TABLE config_revisions DISABLE TRIGGER config_revisions_append_only');
        await pool.query('UPDATE config_revisions SET actor_human_id=NULL WHERE platform_override');
        await pool.query('ALTER TABLE config_revisions ENABLE TRIGGER config_revisions_append_only');
      }
    }
    await rejectDown(pool, version, 'rollback preserves audit attribution; human actors or platform overrides cannot be removed');
  });

  it('keeps reconstructible legacy audit and revision rows across up, down and reapply', async () => {
    const pool = getPool(); await applyMigrationsThrough(pool, '052_runtime_roles.sql');
    await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision)
      VALUES('Steven','kant','rollback.legacy','allow')`);
    await pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES('Steven','kant','{"resource":"room"}','{}','Legacy revision')`);
    const original = await downSnapshot(pool);
    await applyMigrationsThrough(pool, version);
    const applied = await downSnapshot(pool);
    await pool.query(await downSql(version));
    expect(await downSnapshot(pool)).toEqual(original);
    await applyMigrationsThrough(pool, version);
    const reapplied = await downSnapshot(pool);
    expect(reapplied.catalog).toEqual(applied.catalog);
    expect(reapplied.ledger).toEqual(applied.ledger);
    expect(reapplied.rows).toEqual(applied.rows);
  });
});

describe('company administrator history protected by 055 down', () => {
  const version = '055_company_registration.sql';
  it.each(['orphan-history', 'admin-version', 'history-version'])('refuses to discard %s and preserves its catalog, ledgers and rows', async kind => {
    const pool = getPool(); const human = await baselineAdministrator(pool);
    await applyMigrationsThrough(pool, version);
    if (kind === 'orphan-history') await pool.query('DELETE FROM company_admins WHERE human_id=$1', [human]);
    if (kind === 'admin-version') await pool.query('UPDATE company_admins SET version=2 WHERE human_id=$1', [human]);
    if (kind === 'history-version') await pool.query('UPDATE company_admin_versions SET version=2 WHERE human_id=$1', [human]);
    await rejectDown(pool, version, 'rollback preserves company administrator history; versions or revocations cannot be removed');
  });

  it('allows the unchanged version-one backfill and reconstructs it on reapply', async () => {
    const pool = getPool(); const human = await baselineAdministrator(pool);
    const original = await downSnapshot(pool);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT version::text FROM company_admin_versions WHERE human_id=$1', [human])).rows)
      .toEqual([{ version: '1' }]);
    const applied = await downSnapshot(pool);
    await pool.query(await downSql(version));
    expect(await downSnapshot(pool)).toEqual(original);
    await applyMigrationsThrough(pool, version);
    const reapplied = await downSnapshot(pool);
    expect(reapplied.catalog).toEqual(applied.catalog);
    expect(reapplied.ledger).toEqual(applied.ledger);
    expect(reapplied.rows).toEqual(applied.rows);
  });

  it('blocks a writer of company_admins before checking version history', async () => {
    const pool = getPool(); await baselineAdministrator(pool); await applyMigrationsThrough(pool, version);
    const original = await downSnapshot(pool);
    const holder = await pool.connect(); const runner = await pool.connect();
    try {
      await holder.query('BEGIN'); await holder.query('LOCK TABLE company_admins IN ROW EXCLUSIVE MODE');
      await runner.query('BEGIN');
      await runner.query("SET LOCAL lock_timeout='200ms'; SET LOCAL statement_timeout='3000ms'");
      await expect(runner.query(await downSql(version))).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await runner.query('ROLLBACK'); await holder.query('ROLLBACK'); runner.release(); holder.release();
    }
    expect(await downSnapshot(pool)).toEqual(original);
  });
});
