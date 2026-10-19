#!/usr/bin/env node
// cauce:requiere docker
// cauce:timeout-ms 600000
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GenericContainer, Wait } from 'testcontainers';
import { tsImport } from 'tsx/esm/api';
import { applyCompany, inventoryPlan, main, parseArguments, readInventory } from '../scripts/v4_limpiar_canary.mjs';

test('defaults to simulation and refuses normal identifiers or ambiguous destructive flags before connecting', async () => {
  assert.deepEqual(parseArguments([]), { apply: false, company: null, actor: null });
  for (const args of [['--empresa', 'humanizar'], ['--empresa', 'praxis'], ['--empresa', 'zz-canary-'],
    ['--aplicar'], ['--simular', '--aplicar'], ['--empresa', 'zz-canary-a', '--empresa', 'zz-canary-b']]) {
    assert.throws(() => parseArguments(args));
    let connected = false;
    assert.equal(await main(args, { store: { createPool() { connected = true; } }, output() {} }), 2);
    assert.equal(connected, false);
  }
});

test('real PostgreSQL keeps simulations read-only, purges via durable backup and preserves normal companies and physical resources', async () => {
  const store = await tsImport('../../packages/store/src/index.ts', import.meta.url);
  const { applyMigrations } = await tsImport('../../packages/store/src/db.ts', import.meta.url);
  const { arrancarPostgresDePrueba, saludDePostgresDePrueba } = await tsImport('../../tests/helpers/contenedor-de-prueba.ts', import.meta.url);
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  const user = 'cauce_test', database = 'cauce_test_canary', password = 'fixture-canary-password';
  let builder = new GenericContainer('postgres:16-alpine').withEnvironment({ POSTGRES_DB: database,
    POSTGRES_USER: user, POSTGRES_PASSWORD: password }).withHealthCheck(saludDePostgresDePrueba(user, database))
    .withWaitStrategy(Wait.forHealthCheck());
  builder = network ? builder.withNetworkMode(network) : builder.withExposedPorts(5432);
  const container = await arrancarPostgresDePrueba(() => builder.start());
  const url = new URL('postgresql://localhost');
  url.username = user; url.password = password; url.hostname = network ? container.getIpAddress(network) : container.getHost();
  url.port = String(network ? 5432 : container.getMappedPort(5432)); url.pathname = database;
  const pool = store.createPool(url.href, { max: 2 });
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-canary-'));
  const previous = process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
  process.env.CAUCE_SPACE_BACKUP_DIRECTORY = scratch;
  const actor = '00000000-0000-4000-8000-000000000001';
  const company = 'zz-canary-cleanup';
  const normal = 'normal-cleanup-fixture';
  const fixture = async id => store.registerCompany(pool, { company: { slug: id, name: id },
    email: `${id}@example.invalid`, name: 'Fixture owner', passwordHash: '$scrypt$n=32768,r=8,p=1$' + 'e'.repeat(32) + '$' + 'e'.repeat(64) });
  const snapshot = async (filterCompany = null) => {
    const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
    const result = {};
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z_][a-z0-9_]*$/u);
      result[tablename] = (await pool.query(`SELECT to_jsonb(entry) AS record FROM "${tablename}" entry
        WHERE $1::text IS NULL OR to_jsonb(entry)->>'company_id'=$1 OR ($2::boolean AND to_jsonb(entry)->>'id'=$1)
        ORDER BY to_jsonb(entry)::text`, [filterCompany, tablename === 'companies'])).rows;
    }
    return JSON.stringify(result);
  };
  try {
    await applyMigrations(pool);
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('canary-admin','Steven')");
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','canary_operator')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','canary-admin','canary_operator','operator')");
    await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'canary-admin@example.invalid','canary-admin@example.invalid',$2,'Fixture admin','operator','Steven','canary_operator')`,
    [actor, '$scrypt$' + 'x'.repeat(48)]);
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,'Steven','canary_operator',ARRAY['read','control'])`, [actor]);
    await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [actor]);
    const registered = await fixture(company);
    await fixture(normal);
    const source = client => store.lockCompanyAuthority(client,
      { tenant: 'Steven', alias: 'canary_operator', humanId: actor, requestedCompany: company });
    const enrollments = new store.HostEnrollmentRepository(pool);
    const invitation = await enrollments.invite(source,
      { host_id: `${company}-host`, display_name: 'Fixture computer', notes: '' });
    const key = generateKeyPairSync('ed25519');
    await enrollments.claim(invitation.enrollment_id, { invitation_token: invitation.invitation_token,
      public_key: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      proof: sign(null, Buffer.from(store.hostEnrollmentMessage(invitation)), key.privateKey).toString('base64') });
    await enrollments.invite(source, { host_id: `${company}-pending`, display_name: 'Fixture pending computer', notes: '' });
    const before = await snapshot();
    const normalBefore = await snapshot(normal);
    const logs = [];
    const dependencies = { store, databaseUrl: url.href, output: value => logs.push(value) };
    assert.equal(await main([], dependencies), 0);
    assert.equal(await main(['--simular', '--empresa', company], dependencies), 0);
    assert.equal(await snapshot(), before);
    assert.deepEqual(await readdir(scratch), []);
    assert.equal(logs[0].count, 1);
    assert.equal(logs[0].inventory[0].company_id, company);
    assert.ok(logs[0].inventory[0].invitations.some(value => value.id === invitation.enrollment_id));
    assert.equal(logs[0].inventory[0].hosts[0].enrolled, true);
    assert.doesNotMatch(JSON.stringify(logs), /token_hash|public_key|credential_ref|password_hash|example\.invalid|fixture-canary-password/u);
    assert.equal(logs[1].preflight, 'not_run_read_only_plan');
    const item = (await readInventory(pool, company))[0];
    const denied = [];
    assert.equal(await main(['--aplicar', '--empresa', company, '--admin', '00000000-0000-4000-8000-000000000099'],
      { ...dependencies, output: value => denied.push(value) }), 1);
    assert.equal(denied.at(-1).code, 'forbidden');
    assert.equal(await snapshot(), before);
    const receipt = await applyCompany(pool, store, item, actor);
    assert.equal(receipt.status, 'purged');
    assert.ok(receipt.backup_path.startsWith(join(scratch, 'companies')));
    const backup = JSON.parse(await readFile(receipt.backup_path, 'utf8'));
    assert.equal(backup.company_id, company);
    assert.ok(backup.records.agents.length > 0);
    assert.equal(backup.records.fleet_hosts.length, 1);
    assert.equal(backup.records.fleet_host_enrollments.length, 2);
    assert.equal(backup.records.fleet_host_identities.length, 1);
    assert.ok(backup.records.fleet_host_enrollments.some(value => value.state === 'pending'));
    assert.equal((await pool.query('SELECT 1 FROM companies WHERE id=$1', [company])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM tenants WHERE id=$1', [registered.hub.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM fleet_hosts WHERE company_id=$1', [company])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM fleet_host_enrollments WHERE company_id=$1', [company])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM fleet_host_identities WHERE company_id=$1', [company])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM companies WHERE id=$1 AND enabled', [normal])).rowCount, 1);
    assert.equal(await snapshot(normal), normalBefore);
    assert.equal(await main(['--aplicar', '--empresa', company, '--admin', actor], dependencies), 0);
    assert.equal((await readdir(join(scratch, 'companies'))).length, 1);

    const failedCompany = 'zz-canary-backup-fail';
    await fixture(failedCompany);
    const failed = (await readInventory(pool, failedCompany))[0];
    const beforeBackupFailure = await snapshot();
    await assert.rejects(applyCompany(pool, { ...store, saveCompanyPurgeBackup: async () => { throw new Error('fixture backup failure'); } }, failed, actor));
    assert.equal(await snapshot(), beforeBackupFailure);
    assert.equal((await pool.query('SELECT 1 FROM companies WHERE id=$1 AND enabled AND retired_at IS NULL', [failedCompany])).rowCount, 1);

    const physicalCompany = 'zz-canary-physical';
    const remote = await fixture(physicalCompany);
    await pool.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('canary-host',$1,'Fixture physical host')", [physicalCompany]);
    await pool.query(`INSERT INTO agents(tenant_id,company_id,alias,host_id,container_name,runtime_mode,runtime_key,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'canary_physical','canary-host','canary-container','container','canary-physical','dev','/home/dev','/home/dev/.cauce')`,
    [remote.hub.id, physicalCompany]);
    const physical = (await readInventory(pool, physicalCompany))[0];
    assert.equal(inventoryPlan(physical).blockers[0].kind, 'agent');
    const blocked = await applyCompany(pool, store, physical, actor, {} ).catch(error => ({ code: error.code }));
    assert.equal(blocked.code, 'conflict');
    assert.equal((await pool.query('SELECT 1 FROM companies WHERE id=$1 AND enabled', [physicalCompany])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM agents WHERE alias='canary_physical' AND container_name='canary-container' AND purged_at IS NULL")).rowCount, 1);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office','canary_physical','agent')", [remote.hub.id]);
    await pool.query(`UPDATE agents SET harness_id='codex',systemd_user='dev',primary_room_id='office'
      WHERE tenant_id=$1 AND alias='canary_physical'`, [remote.hub.id]);
    const physicalRow = async () => JSON.stringify((await pool.query("SELECT * FROM agents WHERE tenant_id=$1 AND alias='canary_physical'", [remote.hub.id])).rows);
    const physicalBefore = await physicalRow();
    const configured = { CAUCE_FLEET_CONTROLLER_HOST: 'canary-host' };
    const queued = await applyCompany(pool, store, (await readInventory(pool, physicalCompany))[0], actor, configured);
    assert.equal(queued.status, 'pending');
    assert.equal(queued.kind, 'retire');
    assert.equal(queued.remote_effect, 'not_verified');
    assert.deepEqual((await pool.query('SELECT kind,status FROM fleet_operations WHERE id=$1 AND company_id=$2',
      [queued.operation_id, physicalCompany])).rows, [{ kind: 'retire', status: 'queued' }]);
    assert.equal((await applyCompany(pool, store, (await readInventory(pool, physicalCompany))[0], actor, configured)).status, 'blocked');
    assert.equal((await pool.query('SELECT 1 FROM fleet_operations WHERE company_id=$1', [physicalCompany])).rowCount, 1);
    assert.equal(await physicalRow(), physicalBefore);
    const remoteSource = client => store.lockCompanyAuthority(client,
      { tenant: 'Steven', alias: 'canary_operator', humanId: actor, requestedCompany: physicalCompany });
    const repository = new store.FleetOperationsRepository(pool, { controllerHost: 'canary-host' }).forAuthority(remoteSource);
    await repository.cancel('Steven', 'canary_operator', queued.operation_id, 0, `console:${actor}`);
    await pool.query("UPDATE agents SET retired_at=now(),enabled=false,lifecycle_state='retired' WHERE tenant_id=$1 AND alias='canary_physical'", [remote.hub.id]);
    const retiredBefore = await physicalRow();
    const queuedPurge = await applyCompany(pool, store, (await readInventory(pool, physicalCompany))[0], actor, configured);
    assert.equal(queuedPurge.status, 'pending');
    assert.equal(queuedPurge.kind, 'purge');
    assert.equal((await pool.query("SELECT 1 FROM fleet_operations WHERE company_id=$1 AND kind='purge' AND status='queued'", [physicalCompany])).rowCount, 1);
    assert.equal(await physicalRow(), retiredBefore);
    const retained = { ...physical, agents: [], backups: [{ id: 'retained', status: 'done' }] };
    assert.equal((await applyCompany(pool, store, retained, actor)).blockers[0].kind, 'retained_space_backup');
    assert.throws(() => inventoryPlan({ ...physical, company_id: normal }));
  } finally {
    if (previous === undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
    else process.env.CAUCE_SPACE_BACKUP_DIRECTORY = previous;
    await pool.end();
    await container.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
