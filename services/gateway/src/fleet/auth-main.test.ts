import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { runFleetAuthHost } from './auth-main.js';

const root = resolve(import.meta.dirname, '../../../..');
let database: TestDatabase; let current: EmptyTestDatabase; let directory: string;
let child: ChildProcess | undefined; let diagnostic: string; let environment: NodeJS.ProcessEnv;
async function stop(signal: NodeJS.Signals = 'SIGTERM') {
  if (child?.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal);
  const timer = setTimeout(() => { child?.kill('SIGKILL'); }, 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function post(body: unknown): Promise<{ status: number | undefined; value: unknown }> {
  return new Promise((done, fail) => {
    const outgoing = request({ socketPath: join(directory, 'bridge/auth.sock'), method: 'POST', path: '/auth',
      headers: { 'content-type': 'application/json' } }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once('error', fail); incoming.once('end', () => { done({ status: incoming.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) as unknown }); });
    });
    outgoing.once('error', fail); outgoing.end(JSON.stringify(body));
  });
}
beforeAll(async () => { database = await startTestDatabase(); });
beforeEach(async () => {
  current = await startTestCaseDatabase(database); directory = await mkdtemp(join(userInfo().homedir, '.cauce-auth-main-'));
  child = undefined; diagnostic = '';
  await mkdir(join(directory, 'bridge'), { mode: 0o700 }); await mkdir(join(directory, 'login'), { mode: 0o700 });
  const helper = join(root, 'ops/cli/provider-login.py');
  await writeFile(join(directory, 'database-url'), current.url, { mode: 0o600 });
  await writeFile(join(directory, 'executor.json'), JSON.stringify({ schemaVersion: 1, host_id: 'server2', profiles: {} }), { mode: 0o600 });
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ schemaVersion: 1, host_id: 'server2', state_root: join(directory, 'login'),
    helper: { executable: helper, sha256: createHash('sha256').update(await readFile(helper)).digest('hex') }, profiles: {}, logins: {} }), { mode: 0o600 });
  environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userInfo().homedir, CAUCE_FLEET_PROJECT_ROOT: root,
    CAUCE_FLEET_DATABASE_URL_FILE: join(directory, 'database-url'), CAUCE_FLEET_HOST: 'server2', CAUCE_FLEET_WORKER_ID: 'auth-only-must-not-claim',
    CAUCE_FLEET_PYTHON: '/usr/bin/python3', CAUCE_FLEET_EXECUTABLE: join(root, 'ops/cli/fleet-executor.py'),
    CAUCE_FLEET_POLICY_FILE: join(directory, 'executor.json'), CAUCE_FLEET_API_SOCKET: join(directory, 'bridge/auth.sock'),
    CAUCE_FLEET_AUTH_POLICY_FILE: join(directory, 'auth.json') };
});
afterEach(async () => { await stop(); await current.close(); await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
async function launch() {
  const entry = `import(${JSON.stringify(pathToFileURL(join(root, 'services/gateway/src/fleet/auth-main.ts')).href)}).then(({runFleetAuthHost}) => runFleetAuthHost()).catch(() => { process.stderr.write('auth host failed'); process.exitCode = 1; });`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', entry], { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (value: Buffer) => { diagnostic += value.toString(); });
  await expect.poll(async () => {
    if (child?.exitCode !== null) throw new Error(diagnostic || 'auth host exited');
    try { return await post({}); } catch { return undefined; }
  }, { timeout: 10_000 }).toEqual({ status: 409, value: { error: 'HOST_UNAVAILABLE' } });
}
describe('real authentication host lifecycle without a fleet worker', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('serves a private bridge and drains PostgreSQL on %s without claiming queued work', async signal => {
    await current.pool.query("INSERT INTO rooms(id,tenant_id) VALUES('auth-control','Steven'),('auth-queued','Isa')");
    await current.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','auth-control','auth_operator','operator')");
    const revision = Number((await current.pool.query<{ revision: string }>('SELECT COALESCE(MAX(id),0)::text AS revision FROM config_revisions')).rows[0]?.revision);
    const operation = await new FleetOperationsRepository(current.pool, { controllerHost: 'server' }).enqueue('Steven', 'auth_operator', {
      kind: 'retire', target: { resource: 'room', tenant_id: 'Isa', room_id: 'auth-queued' }, parameters: {}, expected_revision: revision, idempotency_key: 'auth-no-claim' });
    await launch();
    const socket = await lstat(join(directory, 'bridge/auth.sock')); expect(socket.isSocket()).toBe(true);
    expect(socket.uid).toBe(process.geteuid?.()); expect(socket.mode & 0o777).toBe(0o660);
    expect((await post({ action: 'scope', actor: { tenant_id: 'Steven', alias: 'auth_operator', subject: `console:${randomUUID()}` }, operation_id: operation.id })).status).toBe(409);
    expect((await current.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='cauce-fleet-auth' AND datname=current_database()")).rows[0]?.count).toBeGreaterThan(0);
    await stop(signal); expect(child?.exitCode).toBe(0); expect(diagnostic).toBe('');
    expect((await current.pool.query('SELECT status,worker_id,claim_token FROM fleet_operations WHERE id=$1', [operation.id])).rows[0])
      .toEqual({ status: 'queued', worker_id: null, claim_token: null });
    expect((await current.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM fleet_operation_events WHERE operation_id=$1 AND event='claimed'", [operation.id])).rows[0]?.count).toBe(0);
    expect((await current.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='cauce-fleet-auth' AND datname=current_database()")).rows[0]?.count).toBe(0);
  });
  it('requires an authentication bridge and rejects controller configuration before opening PostgreSQL', async () => {
    const withoutAuth = { ...environment }; delete withoutAuth.CAUCE_FLEET_API_SOCKET; delete withoutAuth.CAUCE_FLEET_AUTH_POLICY_FILE;
    await expect(runFleetAuthHost(withoutAuth)).rejects.toThrow('Fleet authentication host configuration is invalid');
    await expect(runFleetAuthHost({ ...environment, CAUCE_FLEET_CONTROLLER_FILE: '/unread-controller.json' })).rejects.toThrow('Fleet authentication host configuration is invalid');
    expect((await current.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='cauce-fleet-auth' AND datname=current_database()")).rows[0]?.count).toBe(0);
  });
  it('closes its pool and leaves no socket when private authentication policy fails validation', async () => {
    await writeFile(join(directory, 'auth.json'), '{}', { mode: 0o600 });
    await expect(runFleetAuthHost(environment)).rejects.toThrow();
    await expect(lstat(join(directory, 'bridge/auth.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await current.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='cauce-fleet-auth' AND datname=current_database()")).rows[0]?.count).toBe(0);
  });
});
