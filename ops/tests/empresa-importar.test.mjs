#!/usr/bin/env node
// cauce:requiere docker
// Two migrated databases (the hospital's V3 at 043 and the central V4) and a dozen CLI runs.
// cauce:timeout-ms 600000
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import { tsImport } from 'tsx/esm/api';

import { buildBundle, parseImportArguments, parseInventory, parseProfiles } from '../cli/company_import.mjs';

const root = new URL('../../', import.meta.url);
const cli = fileURLToPath(new URL('ops/cli/platform_admin.mjs', root));
const inventoryFile = fileURLToPath(new URL('ops/instances/hospital/praxis-v4.json', root));
const hospital = fileURLToPath(new URL('ops/instances/hospital/', root));
const OWNER = 'zz-canary@praxis.example.invalid';
const OWNER_PASSWORD = 'zz-canary-initial-password';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MIGUEL = '00000000-0000-4000-8000-0000000000a2';
const DB_PASSWORD = 'fixture-import-password';

let container, pool, scratch, urlFile, url, store, passwords;
const files = {};

function run(args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 180_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL_FILE: urlFile, ...environment },
  });
}
const importArgs = (...extra) => ['empresa', 'importar', '--inventario', inventoryFile, '--email', OWNER, '--nombre', 'ZZ Canary', ...extra];
async function privateFile(name, content) {
  const path = join(scratch, name);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
async function scalar(sql, values = []) { return Object.values((await pool.query(sql, values)).rows[0] ?? {})[0]; }
async function counts() {
  const tables = ['companies', 'tenants', 'rooms', 'agents', 'memberships', 'acl_edges', 'console_users', 'human_tenant_memberships',
    'company_admins', 'config_revisions', 'audit_events', 'agent_profiles'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await scalar(`SELECT count(*)::int FROM ${table}`)])));
}
async function humanizarFingerprint() {
  return scalar(`SELECT md5(string_agg(row::text, ',' ORDER BY row::text)) FROM (
    SELECT concat_ws(':', 't', id, display_name, is_hub, enabled) AS row FROM tenants WHERE company_id='humanizar'
    UNION ALL SELECT concat_ws(':', 'a', tenant_id, alias, enabled, display_name) FROM agents WHERE company_id='humanizar'
    UNION ALL SELECT concat_ws(':', 'u', id, email_normalized, tenant_id, alias, active) FROM console_users WHERE company_id='humanizar'
    UNION ALL SELECT concat_ws(':', 'o', human_id, role) FROM company_admins WHERE company_id='humanizar'
    UNION ALL SELECT concat_ws(':', 'e', edge.from_tenant, edge.to_tenant, edge.enabled) FROM acl_edges edge
      JOIN tenants source ON source.id=edge.from_tenant JOIN tenants target ON target.id=edge.to_tenant
      WHERE source.company_id='humanizar' OR target.company_id='humanizar') rows`);
}
function report(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${OWNER_PASSWORD}|${DB_PASSWORD}|postgresql:`, 'u'));
  return JSON.parse(result.stdout);
}
async function psql(database, sql) {
  const target = `/tmp/zz-canary-${Math.random().toString(16).slice(2)}.sql`;
  await container.copyContentToContainer([{ content: sql, target }]);
  const result = await container.exec(['psql', '-U', 'cauce_test', '-d', database, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-f', target]);
  assert.equal(result.exitCode, 0, result.stderr || result.output);
  return result.stdout;
}

before(async () => {
  const { arrancarPostgresDePrueba, saludDePostgresDePrueba } = await tsImport('../../tests/helpers/contenedor-de-prueba.ts', import.meta.url);
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  const builder = new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_DB: 'cauce_test_import', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: DB_PASSWORD })
    .withLabels({ 'cauce.test': 'empresa-importar' })
    .withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test_import'))
    .withWaitStrategy(Wait.forHealthCheck());
  container = await arrancarPostgresDePrueba(() => (network ? builder.withNetworkMode(network) : builder.withExposedPorts(5432)).start());
  // Built at run time: no user:password@host literal in the repository.
  const address = new URL('postgresql://placeholder/cauce_test_import');
  Object.assign(address, { username: 'cauce_test', password: DB_PASSWORD, hostname: network ? container.getIpAddress(network) : container.getHost(),
    port: String(network ? 5432 : container.getMappedPort(5432)) });
  url = address.href;
  scratch = await mkdtemp(join(tmpdir(), 'zz-canary-empresa-importar-'));
  urlFile = await privateFile('database-url', `${url}\n`);
  store = await tsImport('../../packages/store/src/index.ts', import.meta.url);
  passwords = await tsImport('../../services/gateway/src/password.ts', import.meta.url);
  pool = store.createPool(url, { max: 2 });
  await store.applyMigrations(pool);
  await pool.query(`INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-steven','Steven'),('zz-canary-miguel','Miguel');
    INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory) VALUES
      ('Steven','zz-canary-admin',true,'codex','zz-canary','dev','/home/dev','/home/dev/.cauce'),
      ('Miguel','zz-canary-miguel',true,'codex','zz-canary','dev','/home/dev','/home/dev/.cauce');
    INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-steven','zz-canary-admin','operator'),
      ('Miguel','zz-canary-miguel','zz-canary-miguel','operator')`);
  for (const [id, email, tenant, alias] of [[ADMIN, 'zz-canary-admin@example.invalid', 'Steven', 'zz-canary-admin'],
    [MIGUEL, 'zz-canary-miguel@example.invalid', 'Miguel', 'zz-canary-miguel']]) {
    await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,$2,$2,$3,$2,'operator',$4,$5)`, [id, email, '$scrypt$' + 'x'.repeat(48), tenant, alias]);
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,$2,$3,ARRAY['route','read','control','notify'])`, [id, tenant, alias]);
  }
  await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [ADMIN]);
  await pool.query("SELECT cauce_platform_grant_admin('humanizar',$1,'zz-canary-miguel@example.invalid','owner',$2)", [MIGUEL, ADMIN]);

  // The hospital as it runs today: schema 043, bootstrap and the Praxis enablement, then the read-only export.
  await pool.query('CREATE DATABASE hospital_v3');
  const migrations = (await readdir(fileURLToPath(new URL('packages/store/migrations/', root))))
    .filter(name => /^\d{3}_.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 43).sort();
  await psql('hospital_v3', `BEGIN;\n${(await Promise.all(migrations.map(name =>
    readFile(fileURLToPath(new URL(`packages/store/migrations/${name}`, root)), 'utf8')))).join('\n')}\nCOMMIT;\n`);
  for (const script of ['bootstrap.sql', 'enable-praxis.sql']) await psql('hospital_v3', await readFile(join(hospital, script), 'utf8'));
  files.profiles = await privateFile('perfiles.json', await psql('hospital_v3', await readFile(join(hospital, 'praxis-perfiles-export.sql'), 'utf8')));
  files.password = await privateFile('clave', `${OWNER_PASSWORD}\n`);
}, { timeout: 300_000 });

after(async () => {
  await pool?.end();
  await container?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('the hospital export names its three live agents with their Praxis profiles', async () => {
  const exported = JSON.parse(await readFile(files.profiles, 'utf8'));
  assert.deepEqual(exported.agents.map(agent => agent.alias), ['operador', 'perseo', 'teseo']);
  assert.deepEqual(exported.profiles.map(profile => profile.alias), ['operador', 'perseo', 'teseo']);
  assert.match(exported.profiles[0].purpose, /Praxis/u, 'the export carries the live profile, enablement included');
  assert.equal(parseProfiles(JSON.stringify(exported), parseInventory(await readFile(inventoryFile, 'utf8'))).length, 3);
});

test('rejects malformed invocations and drifted inputs before connecting', async () => {
  const drifted = JSON.parse(await readFile(files.profiles, 'utf8'));
  drifted.agents.push({ alias: 'nuevo', display_name: 'Nuevo' });
  const drift = await privateFile('perfiles-deriva.json', JSON.stringify(drifted));
  const shared = join(scratch, 'perfiles-compartidos.json');
  await writeFile(shared, await readFile(files.profiles, 'utf8'), { mode: 0o644 });
  await chmod(shared, 0o644);
  const tampered = await privateFile('inventario-alterado.json', JSON.stringify({ ...parseInventory(await readFile(inventoryFile, 'utf8')), extra: true }));
  for (const [args, message] of [
    [['empresa', 'importar', '--inventario', inventoryFile, '--email', OWNER, '--dry-run'], /--nombre/u],
    [importArgs('--dry-run', '--apply'), /exactamente --dry-run o --apply/u],
    [importArgs(), /exactamente --dry-run o --apply/u],
    [['empresa', 'importar', '--inventario', 'relativo.json', '--email', OWNER, '--nombre', 'x', '--dry-run'], /ruta absoluta/u],
    [['empresa', 'importar', '--inventario', inventoryFile, '--email', 'sin-dominio@local', '--nombre', 'x', '--dry-run'], /correo válido/u],
    [importArgs('--dry-run', '--sql', 'DROP TABLE companies'), /Opción desconocida/u],
    [importArgs('--dry-run', '--perfiles', drift), /Deriva entre el inventario/u],
    [importArgs('--dry-run', '--perfiles', shared), /privado \(0600\)/u],
    [['empresa', 'importar', '--inventario', tampered, '--email', OWNER, '--nombre', 'x', '--dry-run'], /exactamente los campos/u],
  ]) {
    const result = run(args, { DATABASE_URL_FILE: '/nonexistent/database-url' });
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.deepEqual(parseImportArguments(['empresa', 'importar', '--inventario', inventoryFile, '--nombre', 'x', '--apply'],
    { CAUCE_IMPORT_OWNER_EMAIL: ' ZZ-Canary@Praxis.Example.Invalid ' }).email, OWNER, 'the owner email can come from the environment');
  const help = run(['empresa', 'importar', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--clave-archivo/u);
});

test('imports Praxis with its owner once, isolated from Humanizar, and a re-run changes nothing', async () => {
  const start = await counts(); const humanizar = await humanizarFingerprint();

  const dry = report(run(importArgs('--dry-run', '--perfiles', files.profiles)));
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.owner, { email: OWNER, state: 'planned', password_required: true });
  assert.deepEqual(dry.configuration.mutations.filter(item => !item.startsWith('create acl_edge')), [
    'create tenant Hospital', 'create room Hospital/grp.hospital', 'create agent Hospital/operador', 'create agent Hospital/perseo',
    'create agent Hospital/teseo', 'create membership Hospital/grp.hospital/operador', 'create membership Hospital/grp.hospital/perseo',
    'create membership Hospital/grp.hospital/teseo']);
  assert.equal(dry.configuration.mutations.filter(item => item.startsWith('create acl_edge')).length, 2);
  assert.ok(dry.isolation.length >= 8 && dry.isolation.every(item => item.ok), JSON.stringify(dry.isolation));
  assert.deepEqual(dry.profiles.map(item => item.state), ['planned', 'planned', 'planned']);
  assert.deepEqual(await counts(), start, 'the dry run leaves no row behind');

  const passwordless = run(importArgs('--apply', '--perfiles', files.profiles));
  assert.equal(passwordless.status, 1);
  assert.match(passwordless.stderr, /exige --clave-archivo/u);
  assert.deepEqual(await counts(), start);

  const applied = report(run(importArgs('--apply', '--perfiles', files.profiles, '--clave-archivo', files.password)));
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.owner, { email: OWNER, state: 'created', password_required: false });
  const hubless = mutations => mutations.map(item => item.replace(/hub-[0-9a-f]{32}/gu, 'hub'));
  assert.deepEqual(hubless(applied.configuration.mutations), hubless(dry.configuration.mutations), 'the dry run announced the same changes');
  assert.deepEqual(applied.profiles.map(item => item.state), ['prepared', 'prepared', 'prepared']);
  assert.ok(applied.isolation.every(item => item.ok));
  assert.equal(applied.physical_effect_verified, false);

  const owner = (await pool.query(`SELECT u.id::text,u.tenant_id,u.alias,u.company_id,u.password_hash,a.role
    FROM console_users u JOIN company_admins a ON a.human_id=u.id WHERE u.email_normalized=$1`, [OWNER])).rows;
  assert.equal(owner.length, 1);
  assert.equal(owner[0].company_id, 'praxis'); assert.equal(owner[0].role, 'owner');
  assert.equal(await passwords.verifyPassword(owner[0].password_hash, OWNER_PASSWORD), true, 'the owner logs in with the initial password');
  const hub = await scalar("SELECT id FROM tenants WHERE company_id='praxis' AND is_hub");
  assert.equal(hub, owner[0].tenant_id);
  assert.deepEqual((await pool.query("SELECT id,company_id,is_hub FROM tenants WHERE id='Hospital'")).rows,
    [{ id: 'Hospital', company_id: 'praxis', is_hub: false }]);
  assert.deepEqual((await pool.query("SELECT alias,enabled,company_id FROM agents WHERE tenant_id='Hospital' ORDER BY alias")).rows,
    ['operador', 'perseo', 'teseo'].map(alias => ({ alias, enabled: false, company_id: 'praxis' })), 'agents stay inactive drafts');
  assert.deepEqual((await pool.query(`SELECT (from_tenant=$1) AS owner_hub,allow_route,allow_read,allow_control FROM acl_edges
    WHERE from_tenant='Hospital' OR to_tenant='Hospital' ORDER BY from_tenant=$1`, [hub])).rows
    .map(row => [row.owner_hub, row.allow_route, row.allow_read, row.allow_control]),
  [[false, true, true, false], [true, true, true, true]]);
  const exported = JSON.parse(await readFile(files.profiles, 'utf8'));
  for (const alias of ['operador', 'perseo', 'teseo']) {
    const profile = (await pool.query(`SELECT purpose,responsibilities FROM agent_profiles WHERE tenant_id='Hospital' AND alias=$1`, [alias])).rows[0];
    const source = exported.profiles.find(item => item.alias === alias);
    assert.equal(profile.purpose, source.purpose.trim()); assert.deepEqual(profile.responsibilities, source.responsibilities);
  }
  assert.deepEqual((await pool.query(`SELECT alias,version,source,company_id FROM agent_context_versions
    WHERE tenant_id='Hospital' ORDER BY alias,version`)).rows,
  ['operador', 'perseo', 'teseo'].map(alias => ({ alias, version: '1', source: 'profile', company_id: 'praxis' })),
  'each imported profile is the first version of its agent context');
  assert.equal(await humanizarFingerprint(), humanizar, 'Humanizar is untouched');

  const authority = await store.withTransaction(pool, client => store.lockCompanyAuthority(client,
    { tenant: owner[0].tenant_id, alias: owner[0].alias, humanId: owner[0].id, requestedCompany: 'humanizar' }));
  assert.deepEqual([authority.role, authority.actingCompany], ['company_owner', 'praxis']);
  const miguel = await store.withTransaction(pool, client => store.lockCompanyAuthority(client,
    { tenant: 'Miguel', alias: 'zz-canary-miguel', humanId: MIGUEL, requestedCompany: 'praxis' }));
  assert.deepEqual([miguel.role, miguel.actingCompany], ['company_owner', 'humanizar'], 'a Humanizar owner never acts on Praxis');

  const settled = await counts();
  const again = report(run(importArgs('--apply', '--perfiles', files.profiles, '--clave-archivo', files.password)));
  assert.deepEqual(again.owner, { email: OWNER, state: 'existing' });
  assert.deepEqual(again.configuration.mutations, []);
  assert.deepEqual(again.profiles.map(item => item.state), ['existing', 'existing', 'existing']);
  assert.deepEqual(await counts(), settled, 'the re-run writes nothing');
  const verification = report(run(importArgs('--dry-run')));
  assert.deepEqual(verification.configuration.mutations, []);
  assert.ok(verification.isolation.every(item => item.ok));

  await pool.query(`UPDATE agent_profiles SET purpose='Editado por el dueño después de importar' WHERE tenant_id='Hospital' AND alias='teseo'`);
  const kept = report(run(importArgs('--apply', '--perfiles', files.profiles)));
  assert.deepEqual(kept.profiles.map(item => item.state), ['existing', 'existing', 'kept_differs']);
  assert.equal(await scalar("SELECT purpose FROM agent_profiles WHERE tenant_id='Hospital' AND alias='teseo'"),
    'Editado por el dueño después de importar', 'an owner edit survives the re-run');
});

test('refuses a foreign owner, a reused account and any route between the companies', async () => {
  const settled = await counts();
  const stranger = run(['empresa', 'importar', '--inventario', inventoryFile, '--email', 'zz-canary-otro@example.invalid', '--nombre', 'x', '--dry-run']);
  assert.equal(stranger.status, 1);
  assert.match(stranger.stderr, /praxis ya existe y zz-canary-otro@example.invalid no es su dueño/u);

  const other = await privateFile('inventario-otra.json', JSON.stringify({ ...parseInventory(await readFile(inventoryFile, 'utf8')),
    company: { id: 'zz-canary-otra', name: 'Otra' }, tenants: [{ id: 'ZzCanaryOtra', display_name: null, enabled: true }], rooms: [], agents: [], memberships: [] }));
  const reused = run(['empresa', 'importar', '--inventario', other, '--email', 'zz-canary-miguel@example.invalid', '--nombre', 'x', '--dry-run']);
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, /ya tiene cuenta en la empresa humanizar/u);

  const praxisHub = await scalar("SELECT id FROM tenants WHERE company_id='praxis' AND is_hub");
  await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [ADMIN]);
  await pool.query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
    VALUES('Steven',$1,true,true,true,false)`, [praxisHub]);
  try {
    const crossed = run(importArgs('--dry-run'));
    assert.equal(crossed.status, 1);
    assert.match(crossed.stderr, /aislamiento no se cumple \(no_cross_company_routes, no_company_links\)/u);
  } finally {
    await pool.query('DELETE FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', ['Steven', praxisHub]);
    await pool.query("DELETE FROM company_links WHERE company_a='humanizar' AND company_b='praxis'");
  }
  assert.deepEqual(await counts(), settled);
});

test('the bundle copies the registered hub and keeps the runtime of an already placed agent', () => {
  const inventory = { company: { id: 'praxis', name: 'Praxis' }, hub_edges: { allow_route: true, allow_read: false, allow_control: false },
    tenants: [{ id: 'Hospital', display_name: null, enabled: true }], rooms: [], memberships: [],
    agents: [{ tenant_id: 'Hospital', alias: 'teseo', display_name: null, max_concurrent_deliveries: 2 }] };
  const runtime = { runtime_key: 'placed' };
  const current = { company_id: 'praxis', schema_version: 'v', source_revision: 4,
    records: { tenants: [{ id: 'hub-x', display_name: 'Praxis', is_hub: true, enabled: true }],
      agents: [{ tenant_id: 'Hospital', alias: 'teseo', runtime }] } };
  const bundle = buildBundle(value => JSON.stringify(value).length.toString(16).padStart(64, '0'), current, inventory);
  assert.deepEqual(bundle.records.tenants.map(tenant => [tenant.id, tenant.is_hub]), [['hub-x', true], ['Hospital', false]]);
  assert.equal(bundle.records.agents[0].runtime, runtime);
  assert.deepEqual(bundle.records.acl_edges.map(edge => [edge.from_tenant, edge.to_tenant, edge.allow_route, edge.allow_read, edge.allow_control]),
    [['hub-x', 'Hospital', true, true, true], ['Hospital', 'hub-x', true, false, false]]);
  assert.throws(() => buildBundle(() => '', { ...current, records: { tenants: [], agents: [] } }, inventory), /no tiene hub/u);
});
