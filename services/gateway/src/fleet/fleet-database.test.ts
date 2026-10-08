import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@cauce/store';
import { createFleetAuthDatabasePool } from './fleet-database.js';

const execute = promisify(execFile);
let directory: string; let container: StartedTestContainer | undefined; let connectionString: string; let environment: NodeJS.ProcessEnv;
beforeAll(async () => {
  directory = await mkdtemp(join(userInfo().homedir, '.cauce-fleet-db-tls-'));
  for (const name of ['ca', 'other-ca']) await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.crt`), '-days', '1', '-subj', `/CN=${name}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await execute('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'server.key'),
    '-out', join(directory, 'server.csr'), '-subj', '/CN=postgres']);
  await writeFile(join(directory, 'extensions'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:postgres\n');
  await execute('/usr/bin/openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', join(directory, 'ca.crt'),
    '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-out', join(directory, 'server.crt'), '-days', '1', '-extfile', join(directory, 'extensions')]);
  const fixtureLogs: string[] = [];
  container = await new GenericContainer('postgres:16-alpine').withEnvironment({ POSTGRES_USER: 'fleet_tls_fixture',
    POSTGRES_PASSWORD: 'isolated_tls_fixture', POSTGRES_DB: 'cauce_test_fleet_tls' }).withExposedPorts(5432)
    .withCopyFilesToContainer(['server.key', 'server.crt'].map(name => ({ source: join(directory, name), target: `/tls/${name}` })))
    .withEntrypoint(['/bin/sh']).withCommand(['-c', 'chown -R postgres:postgres /tls && chmod 700 /tls && chmod 600 /tls/server.key && chmod 644 /tls/server.crt && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key'])
    .withLogConsumer(stream => { stream.on('data', chunk => fixtureLogs.push(String(chunk))); stream.on('err', chunk => fixtureLogs.push(String(chunk))); })
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)).start()
    .catch((error: unknown) => { throw new Error(`PostgreSQL TLS fixture failed: ${fixtureLogs.join('')}`, { cause: error }); });
  connectionString = `postgresql://fleet_tls_fixture:isolated_tls_fixture@127.0.0.1:${String(container.getMappedPort(5432))}/cauce_test_fleet_tls`;
  environment = { NODE_ENV: 'production', PGSSLMODE: 'verify-full', PGSSLROOTCERT: join(directory, 'ca.crt'), CAUCE_FLEET_DATABASE_TLS_SERVERNAME: 'postgres' };
});
afterAll(async () => { await container?.stop(); await rm(directory, { recursive: true, force: true }); });
describe('fleet authentication database TLS over an isolated loopback transport', () => {
  it('verifies the PostgreSQL DNS identity over an IP endpoint and preserves unrelated URL options', async () => {
    const url = new URL(connectionString);
    for (const key of ['sslcert', 'sslkey', 'sslrootcert']) url.searchParams.set(key, '/unread-url-override');
    url.searchParams.set('sslmode', 'verify-full'); url.searchParams.set('sslnegotiation', 'direct');
    url.searchParams.set('ssl', 'false'); url.searchParams.set('application_name', 'fleet-tls-preserved');
    const pool = createFleetAuthDatabasePool(url.toString(), environment);
    try {
      expect(pool.options.ssl).toMatchObject({ ca: await readFile(join(directory, 'ca.crt'), 'utf8'), rejectUnauthorized: true, servername: 'postgres' });
      expect((await pool.query<{ ssl: boolean; application: string }>("SELECT ssl,current_setting('application_name') AS application FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0])
        .toEqual({ ssl: true, application: 'fleet-tls-preserved' });
    } finally { await pool.end(); }
  });
  it.each(['incorrect name', 'incorrect CA'] as const)('rejects %s during the real PostgreSQL TLS handshake', async failure => {
    const pool = createFleetAuthDatabasePool(connectionString, { ...environment,
      ...(failure === 'incorrect name' ? { CAUCE_FLEET_DATABASE_TLS_SERVERNAME: 'different-host' } : { PGSSLROOTCERT: join(directory, 'other-ca.crt') }) });
    try { await expect(pool.query('SELECT 1')).rejects.toThrow(); } finally { await pool.end(); }
  });
  it.each([
    { NODE_ENV: 'test' }, { PGSSLMODE: 'require' }, { CAUCE_FLEET_DATABASE_TLS_SERVERNAME: '127.0.0.1' },
    { CAUCE_FLEET_DATABASE_TLS_SERVERNAME: 'postgres:5432' }, { CAUCE_FLEET_DATABASE_TLS_SERVERNAME: '-postgres' },
    { CAUCE_FLEET_DATABASE_TLS_SERVERNAME: 'K' }, { CAUCE_FLEET_DATABASE_TLS_SERVERNAME: 'ſ' },
  ])('rejects a TLS identity configuration outside the production verified DNS policy: %j', override => {
    expect(() => createFleetAuthDatabasePool(connectionString, { ...environment, ...override })).toThrow('Fleet authentication database TLS configuration is invalid');
  });
  it.each(['remote.example', 'localhost'])('rejects the transport hostname %s before opening a connection', hostname => {
    const url = new URL(connectionString); url.hostname = hostname;
    expect(() => createFleetAuthDatabasePool(url.toString(), environment)).toThrow('Fleet authentication database TLS configuration is invalid');
  });
  it('rejects query host overrides and weaker or ambiguous URL SSL modes', () => {
    for (const suffix of ['?host=remote.example', '?sslmode=no-verify', '?sslmode=verify-full&sslmode=no-verify']) {
      expect(() => createFleetAuthDatabasePool(connectionString + suffix, environment)).toThrow('Fleet authentication database TLS configuration is invalid');
    }
  });
  it('preserves the existing pool behavior exactly when the TLS identity environment variable is absent', async () => {
    const baseline = createPool(connectionString, { applicationName: 'cauce-fleet-auth', max: 4 });
    const pool = createFleetAuthDatabasePool(connectionString, {});
    try {
      for (const key of ['connectionString', 'ssl', 'application_name', 'max', 'connectionTimeoutMillis'] as const) expect(pool.options[key]).toEqual(baseline.options[key]);
      expect((await pool.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl).toBe(false);
    } finally { await pool.end(); await baseline.end(); }
  });
});
