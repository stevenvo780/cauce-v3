#!/usr/bin/env node
// cauce:requiere docker
// cauce:timeout-ms 600000
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GenericContainer, Wait } from 'testcontainers';
import { tsImport } from 'tsx/esm/api';

import { parseSeedArguments } from '../cli/platform_admin.mjs';

const cli = fileURLToPath(new URL('../cli/platform_admin.mjs', import.meta.url));
// Las URLs de fixture se construyen en tiempo de ejecución: ningún literal user:password@host en el repositorio.
function fixtureDatabaseUrl({ user, password, host, port, database, query }) {
  const credentials = password === undefined ? user : `${user}:${password}`;
  return `postgresql://${credentials}@${host}${port === undefined ? '' : `:${port}`}/${database}${query ? `?${query}` : ''}`;
}

const FIXTURE_PASSWORD = 'fixture-placeholder-password';
const admin = '00000000-0000-4000-8000-000000000001';
const miguel = '00000000-0000-4000-8000-000000000002';

function run(args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...environment }, timeout: 40_000,
  });
}

test('shows platform operations without connecting to a database', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /admin otorgar\|revocar/u);
  assert.match(result.stdout, /DATABASE_URL_FILE/u);
});

test('rejects malformed identities, unknown options and unsupported operations before connecting', () => {
  for (const args of [
    ['admin', 'otorgar', '--empresa', 'humanizar', '--id', 'invalid', '--email', 'a@b.test', '--rol', 'owner'],
    ['admin', 'revocar', '--empresa', 'humanizar', '--id', admin, '--arbitrary-sql', 'DELETE FROM companies'],
    ['admin', 'revocar', '--empresa', 'humanizar', '--id', admin, '--id', admin.toUpperCase()],
    ['admin', 'otorgar', '--empresa', 'humanizar', '--id', admin, '--id', miguel, '--email', 'a@b.test', '--rol', 'owner'],
    ['admin', 'otorgar', '--empresa', 'humanizar', '--id', admin, '--email', 'a@b.test', '--rol', 'superuser'],
    ['empresa', 'estado', '--empresa', 'humanizar', '--estado', 'invalid'],
    ['empresa', 'estado', '--empresa', 'humanizar', '--empresa', 'praxis', '--estado', 'enabled'],
  ]) {
    const result = run([...args, '--admin', admin]);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /PostgreSQL|ECONN/u);
  }
  for (const args of [
    ['empresa', 'roles'], ['empresa', 'principales'], ['host', 'registrar'], ['host', 'asignar'],
    ['catalogo', 'aplicar', 'missing.json'], ['persona', 'contraseña'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /función SQL.*054/u);
  }
  const ownerless = run(['empresa', 'crear', '--empresa', 'acme', '--nombre', 'Acme', '--admin', admin]);
  assert.equal(ownerless.status, 2, ownerless.stderr);
  assert.match(ownerless.stderr, /bloqueada.*dueño/u);
});

test('parses the seed command and rejects malformed input before connecting', () => {
  assert.deepEqual(parseSeedArguments(['admin', 'semilla', '--email', 'Owner@Example.test']),
    { email: 'owner@example.test', company: null, role: 'owner', actor: null });
  assert.deepEqual(parseSeedArguments(['admin', 'semilla', '--email', 'a@b.test', '--company', 'humanizar', '--role', 'admin', '--admin', admin.toUpperCase()]),
    { email: 'a@b.test', company: 'humanizar', role: 'admin', actor: admin });
  for (const args of [
    ['--company', 'humanizar'], ['--email', 'sin-arroba'], ['--email', 'a@b.test', '--role', 'owner'],
    ['--email', 'a@b.test', '--company', 'humanizar', '--role', 'root'], ['--email', 'a@b.test', '--company', 'Bad Id'],
    ['--email', 'a@b.test', '--email', 'c@d.test'], ['--email', 'a@b.test', '--sql', 'x'],
  ]) {
    const result = run(['admin', 'semilla', ...args], { CAUCE_PLATFORM_ADMIN_ID: admin });
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /PostgreSQL|ECONN/u);
  }
});

test('cauce platform routes authority groups to the engine and contenedor to the container wrapper', () => {
  const entry = fileURLToPath(new URL('../cli/cauce', import.meta.url));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const engine = spawnSync(entry, ['platform', 'admin', 'semilla', '--email', 'a@b.test'], { encoding: 'utf8', env });
  assert.equal(engine.status, 2, engine.stderr);
  assert.match(engine.stderr, /DATABASE_URL_FILE o DATABASE_URL/u);
  const container = spawnSync(entry, ['platform', 'contenedor', '--mostrar'],
    { encoding: 'utf8', env: { ...env, CAUCE_ENV_FILE: '/nonexistent/prod.env' } });
  assert.equal(container.status, 2, container.stderr);
  assert.match(container.stderr, /cauce-platform-contenedor: no puedo leer/u);
  const configuration = spawnSync(entry, ['platform', 'show'], { encoding: 'utf8', env });
  assert.notEqual(configuration.status, 0);
  assert.doesNotMatch(configuration.stderr, /semilla|DATABASE_URL_FILE o/u);
});

test('runs through a symlink, as an installed command is invoked', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-link-'));
  try {
    const link = join(scratch, 'cauce-platform');
    await symlink(cli, link);
    for (const command of [[process.execPath, link, '--help'], [link, '--help']]) {
      const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /admin otorgar\|revocar/u);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('reports a missing store runtime as a local failure, never as a PostgreSQL rejection', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-bare-'));
  try {
    await mkdir(join(scratch, 'ops/cli'), { recursive: true });
    const bare = join(scratch, 'ops/cli/cauce-platform');
    await copyFile(cli, bare);
    const result = spawnSync(process.execPath, [bare, 'enlace', 'crear', '--empresa', 'praxis', '--otra-empresa', 'humanizar'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, CAUCE_PLATFORM_ADMIN_ID: admin,
        DATABASE_URL: fixtureDatabaseUrl({ user: 'u', password: FIXTURE_PASSWORD, host: '127.0.0.1', port: 1, database: 'db' }) } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no enviada: falta tsx/u);
    assert.doesNotMatch(result.stderr, /rechazada por PostgreSQL|fixture-placeholder-password/u);
    const network = run(['enlace', 'crear', '--empresa', 'praxis', '--otra-empresa', 'humanizar'], {
      CAUCE_PLATFORM_ADMIN_ID: admin, PGSSLMODE: 'require',
      DATABASE_URL: fixtureDatabaseUrl({ user: 'u', password: FIXTURE_PASSWORD, host: 'cauce-platform.invalid', port: 5432, database: 'db' }) });
    assert.equal(network.status, 1, network.stderr);
    assert.match(network.stderr, /no enviada: la red no llegó al servidor/u);
    assert.doesNotMatch(network.stderr, /rechazada por PostgreSQL|fixture-placeholder-password/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('requires a strong TLS mode for remote servers and drops session-altering PG variables', async () => {
  const { databaseUrl, sanitizeEnvironment } = await import(new URL('../cli/platform_admin.mjs', import.meta.url));
  const remote = fixtureDatabaseUrl({ user: 'u', password: FIXTURE_PASSWORD, host: 'db.example.test', port: 5432, database: 'db' });
  await assert.rejects(databaseUrl({ DATABASE_URL: remote }), /sslmode require/u);
  await assert.rejects(databaseUrl({ DATABASE_URL: remote, PGSSLMODE: 'prefer' }), /sslmode require/u);
  await assert.rejects(databaseUrl({ DATABASE_URL: `${remote}?sslmode=verify-full&sslmode=disable` }), /repite/u);
  for (const mode of ['require', 'verify-ca', 'verify-full']) {
    assert.equal(await databaseUrl({ DATABASE_URL: `${remote}?sslmode=${mode}` }), `${remote}?sslmode=${mode}`);
    assert.equal(await databaseUrl({ DATABASE_URL: remote, PGSSLMODE: mode }), remote);
  }
  const local = fixtureDatabaseUrl({ user: 'u', password: FIXTURE_PASSWORD, host: '127.0.0.1', port: 5432, database: 'db' });
  assert.equal(await databaseUrl({ DATABASE_URL: local }), local);
  const environment = sanitizeEnvironment({ PGOPTIONS: '-c role=postgres', PGHOST: '/tmp', PGUSER: 'postgres',
    PGAPPNAME: 'spoofed', PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/run/secrets/postgres_ca', PATH: '/bin' });
  assert.deepEqual(environment, { PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/run/secrets/postgres_ca', PATH: '/bin' });
  assert.throws(() => sanitizeEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /verificación TLS/u);
  assert.throws(() => sanitizeEnvironment({ PGSSLMODE: 'no-verify' }), /PGSSLMODE/u);
  assert.throws(() => sanitizeEnvironment({ PGSSLROOTCERT: 'relative.crt' }), /absoluta/u);
});

test('asks before disabling or retiring a company unless --si confirms it in writing', async () => {
  const { confirmationFor } = await import(new URL('../cli/platform_admin.mjs', import.meta.url));
  const base = ['empresa', 'estado', '--empresa', 'humanizar', '--admin', admin, '--estado'];
  assert.deepEqual(confirmationFor([...base, 'disabled']), { company: 'humanizar', state: 'disabled' });
  assert.deepEqual(confirmationFor([...base, 'retired']), { company: 'humanizar', state: 'retired' });
  assert.equal(confirmationFor([...base, 'retired', '--si']), null);
  assert.equal(confirmationFor([...base, 'enabled']), null);
  const unattended = run([...base, 'disabled'], { DATABASE_URL: fixtureDatabaseUrl({ user: 'u', password: FIXTURE_PASSWORD, host: '127.0.0.1', port: 1, database: 'db' }) });
  assert.equal(unattended.status, 2, unattended.stderr);
  assert.match(unattended.stderr, /--si/u);
  assert.equal(run(['enlace', 'crear', '--empresa', 'praxis', '--otra-empresa', 'humanizar', '--si', '--admin', admin]).status, 2);
});

test('refuses connection strings that alter the session or weaken transport before connecting', () => {
  const args = ['empresa', 'estado', '--empresa', 'humanizar', '--estado', 'enabled'];
  const unsafe = { user: 'u', password: FIXTURE_PASSWORD, database: 'db' };
  for (const url of [
    fixtureDatabaseUrl({ ...unsafe, host: '127.0.0.1', port: 1, query: 'options=-c%20role%3Dpostgres' }),
    fixtureDatabaseUrl({ ...unsafe, host: '127.0.0.1', port: 1, query: 'host=/tmp' }),
    fixtureDatabaseUrl({ ...unsafe, host: 'db.example.test', port: 5432, query: 'sslmode=disable' }),
    fixtureDatabaseUrl({ ...unsafe, host: 'db.example.test', port: 5432 }),
    fixtureDatabaseUrl({ ...unsafe, host: 'db.example.test', port: 5432, query: 'sslmode=require&application_name=spoof' }),
    fixtureDatabaseUrl({ ...unsafe, host: '127.0.0.1', port: 1 }).replace(/^postgresql:/u, 'mysql:'),
  ]) {
    const result = run(args, { DATABASE_URL: url, CAUCE_PLATFORM_ADMIN_ID: admin });
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-placeholder-password|ECONN|PostgreSQL \(/u);
  }
});

test('only emits parameterized platform calls for every supported mutation', async () => {
  const { planOperation } = await import(new URL('../cli/platform_admin.mjs', import.meta.url));
  const cases = [
    [['admin', 'otorgar', '--empresa', 'humanizar', '--id', miguel, '--email', 'persona-b@example.test', '--rol', 'owner'],
      'SELECT public.cauce_platform_grant_admin($1,$2,$3,$4,$5)', ['humanizar', miguel, 'persona-b@example.test', 'owner', admin]],
    [['admin', 'revocar', '--empresa', 'humanizar', '--id', miguel],
      'SELECT public.cauce_platform_revoke_admin($1,$2,$3)', ['humanizar', miguel, admin]],
    [['empresa', 'estado', '--empresa', 'humanizar', '--estado', 'disabled', '--si'],
      'SELECT public.cauce_platform_set_company_state($1,$2,$3)', ['humanizar', 'disabled', admin]],
    [['enlace', 'crear', '--empresa', 'praxis', '--otra-empresa', "humanizar'); DELETE FROM companies; --"],
      null, null],
    [['enlace', 'crear', '--empresa', 'praxis', '--otra-empresa', 'humanizar'],
      'SELECT public.cauce_platform_link($1,$2,$3)', ['praxis', 'humanizar', admin]],
    [['enlace', 'borrar', '--empresa', 'praxis', '--otra-empresa', 'humanizar'],
      'SELECT public.cauce_platform_unlink($1,$2,$3)', ['praxis', 'humanizar', admin]],
  ];
  for (const [args, text, values] of cases) {
    if (text === null) assert.throws(() => planOperation([...args, '--admin', admin]), /empresa válido/u);
    else assert.deepEqual(planOperation([...args, '--admin', admin]), [{ text, values }]);
  }
});

test('the CLI repeats the two-owner seed atomically and the database audits and enforces its guards', async () => {
  const { createPool, applyMigrations } = await tsImport('../../packages/store/src/db.ts', import.meta.url);
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  let builder = new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_DB: 'cauce_test_platform', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: 'fixture-platform-password' })
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U cauce_test -d cauce_test_platform'],
      interval: 1_000, timeout: 3_000, retries: 60, startPeriod: 1_000 })
    .withWaitStrategy(Wait.forHealthCheck());
  builder = network ? builder.withNetworkMode(network) : builder.withExposedPorts(5432);
  const container = await builder.start();
  const host = network ? container.getIpAddress(network) : container.getHost();
  const port = network ? 5432 : container.getMappedPort(5432);
  const url = fixtureDatabaseUrl({ user: 'cauce_test', password: 'fixture-platform-password', host, port, database: 'cauce_test_platform' });
  const pool = createPool(url, { max: 2 });
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-'));
  const urlFile = join(scratch, 'database-url');
  try {
    await applyMigrations(pool);
    await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'owner@example.test','owner@example.test',$3,'Owner','operator','Steven','kant'),
            ($2,'persona-b@example.test','persona-b@example.test',$3,'Persona B','operator','Miguel','janus')`,
    [admin, miguel, '$scrypt$' + 'x'.repeat(48)]);
    await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [admin]);
    await writeFile(urlFile, `${url}\n`, { mode: 0o600 });
    const environment = { DATABASE_URL_FILE: urlFile, DATABASE_URL: 'postgresql://ignored-secret@127.0.0.1:1/ignored',
      CAUCE_PLATFORM_ADMIN_ID: admin, PGOPTIONS: '-c role=cauce_missing_role', PGHOST: '/nonexistent',
      PGUSER: 'cauce_missing_role', PGAPPNAME: 'spoofed' };
    const seed = ['admin', 'otorgar', '--empresa', 'humanizar', '--rol', 'owner',
      '--id', admin, '--email', 'owner@example.test', '--id', miguel, '--email', 'persona-b@example.test'];
    for (let iteration = 0; iteration < 2; iteration++) {
      const result = run(seed, environment);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /2 operación.*confirmada/u);
      assert.doesNotMatch(result.stdout + result.stderr, /postgresql:|fixture-platform-password/u);
    }
    assert.deepEqual((await pool.query(`SELECT human_id::text,role,source,granted_by::text FROM company_admins
      WHERE company_id='humanizar' ORDER BY human_id`)).rows, [admin, miguel].map(human_id =>
      ({ human_id, role: 'owner', source: 'platform', granted_by: admin })));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_authority_events WHERE action='admin.grant'")).rows[0].count, 4);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action='platform.admin.grant' AND company_id='humanizar' AND actor_human_id=$1", [admin])).rows[0].count, 4);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_authority_events WHERE action='admin.grant' AND actor_human_id=$1 AND company_id='humanizar' AND database_role='cauce_test'", [admin])).rows[0].count, 4);

    const wrongEmail = run(seed.slice(0, -1).map(value => value === 'owner' ? 'admin' : value)
      .concat('wrong@example.test'), environment);
    assert.equal(wrongEmail.status, 1);
    assert.match(wrongEmail.stderr, /22023/u);
    assert.equal(wrongEmail.stdout, '');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_authority_events WHERE action='admin.grant'")).rows[0].count, 4);
    assert.deepEqual((await pool.query("SELECT role FROM company_admins WHERE company_id='humanizar' ORDER BY human_id")).rows,
      [{ role: 'owner' }, { role: 'owner' }]);

    const unauthorized = run(seed, { ...environment, CAUCE_PLATFORM_ADMIN_ID: miguel });
    assert.equal(unauthorized.status, 1);
    assert.match(unauthorized.stderr, /42501/u);
    const revoke = ['admin', 'revocar', '--empresa', 'humanizar', '--id', miguel];
    assert.equal(run(revoke, environment).status, 0);
    const lastOwner = run(revoke.slice(0, -1).concat(admin), environment);
    assert.equal(lastOwner.status, 1);
    assert.match(lastOwner.stderr, /23514/u);
    assert.equal(lastOwner.stdout, '');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM company_admins WHERE role='owner'")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action='platform.admin.revoke'")).rows[0].count, 1);

    assert.equal(run(seed, environment).status, 0);
    const unconfirmed = run(['empresa', 'estado', '--empresa', 'humanizar', '--estado', 'retired'], environment);
    assert.equal(unconfirmed.status, 2, unconfirmed.stderr);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_authority_events WHERE action='company.state'")).rows[0].count, 0);
    for (const state of ['disabled', 'retired', 'enabled']) {
      const result = run(['empresa', 'estado', '--empresa', 'humanizar', '--estado', state, '--si'], environment);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual((await pool.query("SELECT enabled,retired_at IS NULL AS restored FROM companies WHERE id='humanizar'")).rows,
      [{ enabled: true, restored: true }]);
    const ownerless = run(['empresa', 'crear', '--empresa', 'ownerless', '--nombre', 'Ownerless'], environment);
    assert.equal(ownerless.status, 2);
    assert.match(ownerless.stderr, /bloqueada/u);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM companies WHERE id='ownerless'")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE company_id='ownerless'")).rows[0].count, 0);

    await pool.query("CREATE ROLE cauce_cli_test_runtime LOGIN PASSWORD 'runtime-test-only' IN ROLE cauce_runtime");
    const runtimeUrl = new URL(url);
    runtimeUrl.username = 'cauce_cli_test_runtime'; runtimeUrl.password = 'runtime-test-only';
    const runtime = run(seed, { DATABASE_URL: runtimeUrl.href, CAUCE_PLATFORM_ADMIN_ID: admin });
    assert.equal(runtime.status, 1);
    assert.match(runtime.stderr, /42501/u);
    assert.doesNotMatch(runtime.stderr, /runtime-test-only|postgresql:/u);

    const leon = '00000000-0000-4000-8000-000000000003';
    await pool.query('BEGIN');
    await pool.query("SELECT cauce_platform_create_company('praxis','Praxis',$1)", [admin]);
    await pool.query("INSERT INTO tenants(id,company_id) VALUES('PraxisHub','praxis')");
    await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'persona-c@example.test','persona-c@example.test',$2,'Persona C','operator','PraxisHub','operador')`,
    [leon, '$scrypt$' + 'x'.repeat(48)]);
    await pool.query("SELECT cauce_platform_grant_admin('praxis',$1,'persona-c@example.test','owner',$2)", [leon, admin]);
    await pool.query('COMMIT');
    for (const operation of ['crear', 'borrar']) {
      const result = run(['enlace', operation, '--empresa', 'praxis', '--otra-empresa', 'humanizar'], environment);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM company_links')).rows[0].count,
        operation === 'crear' ? 1 : 0);
    }
    assert.deepEqual((await pool.query(`SELECT action,company_id,peer_company_id,actor_human_id::text
      FROM platform_authority_events WHERE action IN ('company.link','company.unlink') ORDER BY id`)).rows,
    ['company.link', 'company.unlink'].map(action => ({ action, company_id: 'humanizar', peer_company_id: 'praxis', actor_human_id: admin })));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action IN ('platform.company.link','platform.company.unlink') AND company_id='humanizar' AND actor_human_id=$1", [admin])).rows[0].count, 2);
    const exporter = fileURLToPath(new URL('../scripts/export-fleet-snapshot.py', import.meta.url));
    const snapshot = join(scratch, 'snapshot.json');
    const placement = join(scratch, 'placement.json');
    await writeFile(placement, '{"schemaVersion":1,"placement":{}}');
    const exportArgs = [exporter, '--postgres-container', container.getId(), '--placement', placement,
      '--out', snapshot, '--company', 'humanizar'];
    const exported = spawnSync('python3', exportArgs, { encoding: 'utf8', timeout: 40_000 });
    assert.equal(exported.status, 0, exported.stderr);
    const parity = spawnSync('python3', [...exportArgs, '--check'], { encoding: 'utf8', timeout: 40_000 });
    assert.equal(parity.status, 0, parity.stderr);
    const previous = await readFile(snapshot, 'utf8');
    const unknown = spawnSync('python3', [...exportArgs.slice(0, -1), 'missing'], {
      encoding: 'utf8', timeout: 40_000,
    });
    assert.equal(unknown.status, 1);
    assert.equal(await readFile(snapshot, 'utf8'), previous);
    await writeFile(snapshot, '{}');
    assert.equal(spawnSync('python3', [...exportArgs, '--check'], {
      encoding: 'utf8', timeout: 40_000,
    }).status, 3);

    const beforeLock = (await pool.query('SELECT count(*)::int AS count FROM platform_authority_events')).rows[0].count;
    const schemaWriter = await pool.connect();
    try {
      await schemaWriter.query('BEGIN');
      await schemaWriter.query('SELECT pg_advisory_xact_lock(783003003)');
      const migrating = run(seed, environment);
      assert.equal(migrating.status, 1, 'the CLI must not write while a schema migration holds the lock');
      assert.match(migrating.stderr, /55P03/u);
      assert.equal(migrating.stdout, '');
    } finally { await schemaWriter.query('ROLLBACK'); schemaWriter.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_authority_events')).rows[0].count, beforeLock);
    await writeFile(urlFile, `${fixtureDatabaseUrl({ user: 'private-user', password: 'fixture-do-not-print', host: '127.0.0.1', port: 1, database: 'cauce_test' })}\n`);
    const connectionError = run(seed, environment);
    assert.equal(connectionError.status, 1);
    assert.doesNotMatch(connectionError.stderr, /private-user|fixture-do-not-print|postgresql:|rechazada por PostgreSQL/u);
    assert.match(connectionError.stderr, /no enviada: la red no llegó al servidor \(ECONNREFUSED\)/u);
    assert.equal((await readFile(urlFile, 'utf8')).includes('fixture-do-not-print'), true);
  } finally {
    await pool.end();
    await container.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('seeds the platform administrator and company owners idempotently without manual SQL', async () => {
  const { createPool, applyMigrations } = await tsImport('../../packages/store/src/db.ts', import.meta.url);
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  let builder = new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_DB: 'cauce_test_seed', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: 'fixture-seed-password' })
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U cauce_test -d cauce_test_seed'],
      interval: 1_000, timeout: 3_000, retries: 60, startPeriod: 1_000 })
    .withWaitStrategy(Wait.forHealthCheck());
  builder = network ? builder.withNetworkMode(network) : builder.withExposedPorts(5432);
  const container = await builder.start();
  const host = network ? container.getIpAddress(network) : container.getHost();
  const port = network ? 5432 : container.getMappedPort(5432);
  const url = fixtureDatabaseUrl({ user: 'cauce_test', password: 'fixture-seed-password', host, port, database: 'cauce_test_seed' });
  const pool = createPool(url, { max: 2 });
  const environment = { DATABASE_URL: url };
  const snapshot = async () => JSON.stringify([
    (await pool.query('SELECT human_id::text FROM platform_admins ORDER BY 1')).rows,
    (await pool.query('SELECT company_id,human_id::text,role,source FROM company_admins ORDER BY 1,2')).rows,
    (await pool.query('SELECT action,company_id,subject_human_id::text FROM platform_authority_events ORDER BY id')).rows,
    (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'platform.%'")).rows,
  ]);
  try {
    await applyMigrations(pool);
    await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'owner@example.test','owner@example.test',$3,'Owner','operator','Steven','kant'),
            ($2,'persona-b@example.test','persona-b@example.test',$3,'Persona B','operator','Miguel','janus')`,
    [admin, miguel, '$scrypt$' + 'x'.repeat(48)]);

    const noActor = run(['admin', 'semilla', '--email', 'owner@example.test', '--company', 'humanizar'], environment);
    assert.equal(noActor.status, 1, noActor.stderr);
    assert.match(noActor.stderr, /platform_admin activo/u);

    const missing = run(['admin', 'semilla', '--email', 'nadie@example.test'], environment);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /no existe ninguna persona con el correo nadie@example\.test/u);
    assert.equal(missing.stdout, '');

    const platform = ['admin', 'semilla', '--email', 'Owner@example.test'];
    const first = run(platform, environment);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /ahora es platform_admin/u);
    const afterFirst = await snapshot();
    const second = run(platform, environment);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /ya era platform_admin; sin cambios/u);
    assert.equal(await snapshot(), afterFirst);

    for (const email of ['owner@example.test', 'persona-b@example.test']) {
      const owner = run(['admin', 'semilla', '--email', email, '--company', 'humanizar', '--role', 'owner'], environment);
      assert.equal(owner.status, 0, owner.stderr);
      assert.match(owner.stdout, /ahora es owner de humanizar/u);
      assert.doesNotMatch(owner.stdout + owner.stderr, /postgresql:|fixture-seed-password/u);
    }
    const afterOwners = await snapshot();
    for (const email of ['owner@example.test', 'persona-b@example.test']) {
      const again = run(['admin', 'semilla', '--email', email, '--company', 'humanizar'], environment);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /ya era owner de humanizar; sin cambios/u);
    }
    assert.equal(await snapshot(), afterOwners);
    assert.deepEqual((await pool.query(`SELECT human_id::text,role,source,granted_by::text FROM company_admins
      WHERE company_id='humanizar' ORDER BY human_id`)).rows,
    [admin, miguel].sort().map(human_id => ({ human_id, role: 'owner', source: 'platform', granted_by: admin })));

    const resolved = await pool.query('SELECT platform_admin,company_role FROM cauce_company_authority($1,$2)', [miguel, 'humanizar']);
    assert.deepEqual(resolved.rows, [{ platform_admin: false, company_role: 'owner' }]);
    const { lockCompanyAuthority } = await tsImport('../../packages/store/src/company-authority.ts', import.meta.url);
    const { withTransaction } = await tsImport('../../packages/store/src/db.ts', import.meta.url);
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('company-humanizar','Miguel')");
    await pool.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
      VALUES('Miguel','janus',true,'codex','seed-fixture','dev','/home/dev','/home/dev/.cauce')`);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Miguel','company-humanizar','janus','operator')");
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,'Miguel','janus',ARRAY['read','control'])`, [miguel]);
    const authority = await withTransaction(pool, client => lockCompanyAuthority(client,
      { tenant: 'Miguel', alias: 'janus', humanId: miguel }));
    assert.equal(authority.role, 'company_owner');
    assert.equal(authority.scope, 'company');
    assert.equal(authority.actingCompany, 'humanizar');
  } finally {
    await pool.end();
    await container.stop();
  }
});
