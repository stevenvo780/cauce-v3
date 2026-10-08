import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('lifecycle-admin','Steven')");
  for (const alias of ['bot_hub', 'current_web', 'stale_web']) {
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory) VALUES('Steven',$1,'codex',true,'test-container','dev','/home/dev','/home/dev/.cauce')", [alias]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','lifecycle-admin',$1,'operator')", [alias]);
  }
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('configuration lifecycle authority on PostgreSQL', () => {
  it('restores an unused draft after deletion with the lifecycle schema installed', async () => {
    await pool.query("INSERT INTO agents(tenant_id,alias,enabled) VALUES('Steven','unused_draft',false)");
    const repo = new ConfigurationRepository(pool);
    const deleted = await repo.apply('Steven', 'bot_hub', { resource: 'agent', action: 'delete',
      tenant_id: 'Steven', alias: 'unused_draft' }, false, 0);
    await repo.rollback('Steven', 'bot_hub', deleted.revision, false, deleted.revision);
    expect((await pool.query("SELECT enabled,primary_room_id FROM agents WHERE alias='unused_draft'")).rows[0])
      .toEqual({ enabled: false, primary_room_id: null });
  });
  it('requires fleet authority for membership topology of physical agents while allowing a pause', async () => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('secondary-room','Steven')");
    await pool.query("UPDATE agents SET runtime_key='physical-web' WHERE alias='current_web'");
    const repo = new ConfigurationRepository(pool);
    for (const mutation of [
      { action: 'create' as const, room_id: 'secondary-room', value: { role: 'agent' } },
      { action: 'update' as const, room_id: 'lifecycle-admin', value: { role: 'agent' } },
      { action: 'delete' as const, room_id: 'lifecycle-admin' },
      { action: 'retire' as const, room_id: 'lifecycle-admin' },
    ]) await expect(repo.apply('Steven', 'bot_hub', { resource: 'membership', tenant_id: 'Steven',
      alias: 'current_web', ...mutation }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    const paused = await repo.apply('Steven', 'bot_hub', { resource: 'membership', action: 'update',
      tenant_id: 'Steven', alias: 'current_web', room_id: 'lifecycle-admin', value: { enabled: false } }, false, 0);
    expect(paused.applied).toBe(true);
    await expect(repo.rollback('Steven', 'bot_hub', paused.revision, false, paused.revision)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('protects the current web operator when an old MCP identity remains authorized', async () => {
    const user = (await pool.query<{ id: string }>(
      `INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
       VALUES('fixture@example.test','fixture@example.test',$1,'Fixture','operator','Steven','current_web') RETURNING id`,
      ['$scrypt$' + 'x'.repeat(48)])).rows[0];
    if (!user) throw new Error('fixture user absent');
    await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','stale_web','operator',ARRAY['read','control'])", [user.id]);
    await expect(new ConfigurationRepository(pool).apply('Steven', 'bot_hub', {
      resource: 'membership', action: 'retire', tenant_id: 'Steven', room_id: 'lifecycle-admin', alias: 'current_web',
    }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ enabled: boolean; retired_at: unknown }>("SELECT enabled,retired_at FROM memberships WHERE alias='current_web'" )).rows[0])
      .toEqual({ enabled: true, retired_at: null });
  });
  it('requires a fleet operation for physical edits and enabling a prepared agent', async () => {
    await pool.query("UPDATE agents SET runtime_key='current-web',enabled=false WHERE alias='current_web'");
    const repo = new ConfigurationRepository(pool);
    for (const value of [{ harness_id: 'claude' }, { enabled: true }, { state_directory: '/home/dev/other' }]) {
      await expect(repo.apply('Steven', 'bot_hub', { resource: 'agent', action: 'update', tenant_id: 'Steven',
        alias: 'current_web', value }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    }
    const safe = await repo.apply('Steven', 'bot_hub', { resource: 'agent', action: 'update', tenant_id: 'Steven',
      alias: 'current_web', value: { display_name: 'Current', max_concurrent_deliveries: 4 } }, false, 0);
    expect(safe.applied).toBe(true);
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='current_web'")).rows[0]?.enabled).toBe(false);
  });
  it('moves a draft primary membership atomically and fences physical primary edits', async () => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('draft-destination','Steven')");
    await pool.query("INSERT INTO agents(tenant_id,alias,enabled) VALUES('Steven','move_draft',false)");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','lifecycle-admin','move_draft','agent')");
    await pool.query("UPDATE agents SET primary_room_id='lifecycle-admin' WHERE alias='move_draft'");
    const repo = new ConfigurationRepository(pool);
    const move = await repo.apply('Steven', 'bot_hub', { resource: 'batch', action: 'apply', mutations: [
      { resource: 'membership', action: 'create', tenant_id: 'Steven', room_id: 'draft-destination', alias: 'move_draft', value: { role: 'agent' } },
      { resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'move_draft', value: { primary_room_id: 'draft-destination' } },
      { resource: 'membership', action: 'delete', tenant_id: 'Steven', room_id: 'lifecycle-admin', alias: 'move_draft' },
    ] }, false, 0);
    expect((await pool.query<{ primary_room_id: string }>("SELECT primary_room_id FROM agents WHERE alias='move_draft'")).rows[0]?.primary_room_id).toBe('draft-destination');
    await repo.rollback('Steven', 'bot_hub', move.revision, false, move.revision);
    expect((await pool.query<{ primary_room_id: string }>("SELECT primary_room_id FROM agents WHERE alias='move_draft'")).rows[0]?.primary_room_id).toBe('lifecycle-admin');
    await pool.query("UPDATE agents SET runtime_key='physical-draft' WHERE alias='move_draft'");
    await expect(repo.apply('Steven', 'bot_hub', { resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'move_draft',
      value: { primary_room_id: 'draft-destination' } }, false, move.revision + 1)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects generic creation with live routing admission', async () => {
    await expect(new ConfigurationRepository(pool).apply('Steven', 'bot_hub', { resource: 'agent', action: 'create',
      tenant_id: 'Steven', alias: 'unsafe', value: { enabled: true, harness_id: 'codex' } }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM agents WHERE alias='unsafe'")).rowCount).toBe(0);
  });
  it('rejects generic edits of a retired agent before changing its saved runtime state', async () => {
    await pool.query("UPDATE agents SET enabled=false,lifecycle_state='retired',retired_at=now() WHERE alias='current_web'");
    await expect(new ConfigurationRepository(pool).apply('Steven', 'bot_hub', {
      resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'current_web', value: { display_name: 'Changed' },
    }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ display_name: string | null }>("SELECT display_name FROM agents WHERE alias='current_web'")).rows[0]?.display_name).toBeNull();
  });
  it('preserves an inverse larger than the public request limit and restores all cascaded bindings', async () => {
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref)
      VALUES('fixture-pool','codex','fixture-account','Steven','env_path','CAUCE_TEST_TOKEN_PATH')`);
    for (let i = 0; i < 51; i += 1) {
      const alias = `fixture_${String(i)}`;
      await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven',$1)", [alias]);
      await pool.query("INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant) VALUES('Steven',$1,'fixture-pool','Steven','Steven')", [alias]);
      await pool.query("INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled) VALUES('Steven',$1,'fixture-pool',7,false)", [alias]);
    }
    const repo = new ConfigurationRepository(pool);
    const result = await repo.apply('Steven', 'bot_hub', { resource: 'batch', action: 'apply',
      mutations: Array.from({ length: 51 }, (_, i) => ({ resource: 'alias_routing_ceiling', action: 'delete', tenant_id: 'Steven', alias: `fixture_${String(i)}`, account_id: 'fixture-pool' })),
    }, false, 0);
    expect(result.inverse_mutation.resource).toBe('batch');
    if (result.inverse_mutation.resource !== 'batch') throw new Error('inverse is not atomic');
    expect(result.inverse_mutation.mutations).toHaveLength(102);
    await repo.rollback('Steven', 'bot_hub', result.revision, false, result.revision);
    const bindings = await pool.query<{ priority: number; enabled: boolean }>("SELECT priority,enabled FROM agent_account_bindings WHERE account_id='fixture-pool'");
    expect(bindings.rows).toHaveLength(51);
    expect(bindings.rows.every((binding) => binding.priority === 7 && !binding.enabled)).toBe(true);
  });
});
