import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type AgentTargetPermission } from '../src/repository.js';
import type { DatabasePool } from '../src/db.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let repo: CauceRepository;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repo = new CauceRepository(pool);
  console.info(`[testcontainers] agent-target-access owned container id=${database.container.getId()}`);
}, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('owned PostgreSQL fixture not started');
  await resetTestDatabase(database.pool);
  await pool.query("INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory) SELECT tenant,alias,enabled,'codex',tenant||'-'||alias,'fixture','/tmp/agent-target/home','/tmp/agent-target/state' FROM (VALUES('Steven','kant',true),('Miguel','kant',true),('Steven','apagado',false),('Miguel','apagado',false)) AS targets(tenant,alias,enabled)");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven','zeus','operator') ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='operator',enabled=true");
  await pool.query("UPDATE acl_edges SET enabled=true,allow_read=true,allow_control=true WHERE from_tenant='Steven' AND to_tenant='Miguel'");
});
afterAll(async () => {
  if (!database) return;
  await database.pool.end();
  await database.container.stop();
});
const target = (permission: AgentTargetPermission, tenant = 'Miguel', alias = 'kant') =>
  repo.authorizeAgentTarget('Steven', 'zeus', tenant, alias, permission);

describe('CauceRepository.authorizeAgentTarget against PostgreSQL', () => {
  it('returns only the exact tenant and alias when both tenants reuse an alias', async () => {
    for (const tenant of ['Steven', 'Miguel']) {
      expect(await target('read', tenant)).toMatchObject({ tenant_id: tenant, alias: 'kant', enabled: true });
    }
    expect(await target('read', 'Miguel', 'unknown')).toBeUndefined();
  });
  it('denies each cross-tenant permission when the ACL edge is absent', async () => {
    await pool.query("DELETE FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Miguel'");
    for (const permission of ['read', 'control', 'configure'] as const) {
      expect(await target(permission)).toBeUndefined();
      expect(await target(permission, 'Steven')).toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
    }
  });
  it.each([
    ["UPDATE role_policies SET allow_control=false WHERE role='operator'", 'control'],
    ["UPDATE acl_edges SET allow_control=false WHERE from_tenant='Steven' AND to_tenant='Miguel'", 'control'],
    ["UPDATE role_policies SET allow_read=false WHERE role='operator'", 'read'],
    ["UPDATE acl_edges SET allow_read=false WHERE from_tenant='Steven' AND to_tenant='Miguel'", 'read'],
  ] as const)('revoked authority %s denies %s', async (sql, permission) => {
    await pool.query(sql);
    expect(await target(permission)).toBeUndefined();
    expect(await target(permission === 'read' ? 'control' : 'read')).toMatchObject({ tenant_id: 'Miguel', alias: 'kant' });
    const configured = await target('configure');
    if (permission === 'control') expect(configured).toBeUndefined();
    else expect(configured).toMatchObject({ tenant_id: 'Miguel', alias: 'kant' });
  });
  it.each([['read', true], ['control', false], ['configure', true]] as const)(
    'disabled targets: %s authorization is %s', async (permission, allowed) => {
      for (const tenant of ['Steven', 'Miguel']) {
        const selected = await target(permission, tenant, 'apagado');
        if (allowed) expect(selected).toMatchObject({ tenant_id: tenant, alias: 'apagado', enabled: false });
        else expect(selected).toBeUndefined();
      }
    },
  );
  it('denies configuration of retired agents while retaining read access', async () => {
    await pool.query("UPDATE agents SET enabled=false,retired_at=now() WHERE tenant_id='Miguel' AND alias='kant'");
    expect(await target('configure')).toBeUndefined();
    expect(await target('control')).toBeUndefined();
    expect(await target('read')).toMatchObject({ tenant_id: 'Miguel', alias: 'kant', enabled: false });
  });
  it('denies every permission for purged agents and purged target tenants', async () => {
    await pool.query("UPDATE agents SET enabled=false,retired_at=now(),purged_at=now() WHERE tenant_id='Miguel' AND alias='kant'");
    for (const permission of ['read', 'configure', 'control'] as const) expect(await target(permission)).toBeUndefined();
    await pool.query("UPDATE agents SET purged_at=NULL WHERE tenant_id='Miguel' AND alias='kant'");
    await pool.query("UPDATE tenants SET enabled=false,retired_at=now(),retired_enabled=true,purged_at=now() WHERE id='Miguel'");
    for (const permission of ['read', 'configure', 'control'] as const) expect(await target(permission)).toBeUndefined();
  });
});
