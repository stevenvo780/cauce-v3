import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { FleetOperationSchema, type FleetOperation } from '@cauce/protocol';
import { FleetOperationsRepository } from '@cauce/store';
import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { seedFleetHuman } from '../../packages/store/test/fleet-human-postgres.fixtures.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const execute = promisify(execFile);
const origin = 'https://zz-canary.example.test';
const password = 'zz-canary-ephemeral-passphrase';
const label = 'zz-canary-fleet-restart';
const processes: ChildProcess[] = [];
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let directory: string | undefined;
let name: string | undefined;
let subject: string;
let config: { url: string; host: string; name: string; checkpoint: string; release: string };

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase({ requireOwnedContainer: true }); });
beforeEach(async () => {
  if (!database) throw new Error('Isolated PostgreSQL server is absent');
  current = await startTestCaseDatabase(database);
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-fleet-restart-'));
  name = `zz-canary-fleet-${randomUUID().slice(0, 8)}`;
  config = { url: current.url, host: 'zz-canary-host', name,
    checkpoint: join(directory, 'checkpoint'), release: join(directory, 'release') };
  await current.pool.query("INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-room','Steven')");
  await current.pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','zz_canary_operator')");
  await current.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-room','zz_canary_operator','operator')");
  subject = await seedFleetHuman(current.adminPool, 'Steven', 'zz_canary_operator');
  await current.adminPool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1',
    [subject.slice('console:'.length), await hashPassword(password, { cost: 1_024, blockSize: 8, parallelism: 1 })]);
  await current.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,runtime_key,host_id,runtime_mode,
    container_name,runtime_user,systemd_user,home_directory,state_directory,lifecycle_state,enabled)
    VALUES('Steven','zz_canary_target','codex',$1,$2,'container',$1,'nobody','nobody','/nonexistent','/tmp/zz-canary-state','ready',true)`, [name, config.host]);
  await execute('docker', ['run', '--detach', '--name', name, '--label', `${label}=${name}`,
    '--label', `cauce.fleet.runtime_key=${name}`, 'python:3.12-slim', 'python', '-c', 'import time; time.sleep(300)']);
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); child.kill('SIGKILL'); });
}
async function injectKill(child: ChildProcess): Promise<void> {
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); });
  expect(child.kill('SIGKILL')).toBe(true);
  await exited;
  expect(child.signalCode).toBe('SIGKILL');
}
async function containers(runtime: string): Promise<string[]> {
  const { stdout } = await execute('docker', ['ps', '-a', '--quiet', '--no-trunc', '--filter', `label=${label}=${runtime}`]);
  return stdout.trim().split('\n').filter(Boolean);
}
afterEach(async () => {
  await Promise.all(processes.splice(0).map(stop));
  try {
    if (name) {
      for (const id of await containers(name)) await execute('docker', ['rm', '--force', '--volumes', id]);
      expect(await containers(name)).toEqual([]);
      console.info(`cleanup ${name}: 0 containers`);
    }
  } finally {
    await current?.close(); current = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined; name = undefined;
  }
});
afterAll(async () => {
  if (database) {
    const id = database.container.getId();
    await closeTestDatabase(database);
    const probe = execute('docker', ['inspect', id]);
    await expect(probe).rejects.toHaveProperty('code', 1);
    await expect(probe).rejects.toHaveProperty('stderr', expect.stringMatching(/[Nn]o such object/u));
    console.info(`cleanup owned PostgreSQL ${id}: absent`);
  }
});

async function start(role: 'gateway' | 'worker'): Promise<{ child: ChildProcess; address: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./failure-drill-fleet-process.ts', import.meta.url)), role], {
    env: { ...process.env, NODE_ENV: 'test', CAUCE_FAILURE_DRILL_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  let output = ''; let error = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { error += data.toString(); });
  await expect.poll(() => {
    if (child.exitCode !== null) throw new Error(`Canary ${role} exited before ready: ${error}`);
    return output.includes('ready ');
  }, { timeout: 20_000 }).toBe(true);
  return { child, address: output.split('\n').find(line => line.startsWith('ready '))?.slice(6) ?? '' };
}
async function login(address: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${address}/v3/auth/login`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${subject.slice('console:'.length)}@example.test`, password }) });
  expect(response.status).toBe(200);
  const session = await response.json() as { csrf_token: string };
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-cauce_session='))?.split(';')[0];
  if (!cookie) throw new Error('Canary login did not return a session');
  return { cookie, csrf: session.csrf_token };
}
async function readOperation(address: string, cookie: string, id: string): Promise<FleetOperation> {
  const response = await fetch(`${address}/v3/console/fleet/operations/${id}`, { headers: { cookie, origin } });
  expect(response.status).toBe(200);
  return FleetOperationSchema.parse(await response.json());
}

it.each(['gateway', 'worker', 'both'] as const)('recovers a real stop operation after SIGKILL of %s without duplicate runtimes', async (victim) => {
  if (!current) throw new Error('Case database is absent');
  const originalIds = await containers(config.name);
  expect(originalIds).toHaveLength(1);
  let gateway = await start('gateway');
  const auth = await login(gateway.address);
  const response = await fetch(`${gateway.address}/v3/console/fleet/operations`, { method: 'POST',
    headers: { origin, cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'zz_canary_target' },
      expected_revision: 0, idempotency_key: `zz-canary-stop-${victim}`, parameters: {} }) });
  expect(response.status, await response.clone().text()).toBe(202);
  const receipt = await response.json() as { operation_id: string };
  const worker = await start('worker');
  await expect.poll(async () => { try { await access(config.checkpoint); return true; } catch { return false; } }, { timeout: 20_000 }).toBe(true);
  const checkpoint = JSON.parse(await readFile(config.checkpoint, 'utf8')) as { operation: string; epoch: number };
  expect(checkpoint.operation).toBe(receipt.operation_id);
  const before = await readOperation(gateway.address, auth.cookie, receipt.operation_id);
  expect(before.status).toBe('running'); expect(before.applied_revision).toBeNull();
  expect(before.steps.find(step => step.name === 'stop')?.status).toBe('running');
  const receipts = await current.pool.query(`SELECT metadata->'host_receipt' FROM fleet_operation_events
    WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step'='stop' AND metadata ? 'host_receipt'`, [receipt.operation_id]);
  expect(receipts.rows).toHaveLength(0);
  if (victim !== 'worker') await injectKill(gateway.child);
  if (victim !== 'gateway') await injectKill(worker.child);
  if (victim !== 'worker') gateway = await start('gateway');
  const interrupted = await readOperation(gateway.address, auth.cookie, receipt.operation_id);
  expect(interrupted.status).toBe('running'); expect(interrupted.applied_revision).toBeNull();
  await writeFile(config.release, 'release');
  if (victim !== 'gateway') await start('worker');
  await expect.poll(async () => (await readOperation(gateway.address, auth.cookie, receipt.operation_id)).status,
    { timeout: 20_000 }).toBe('succeeded');
  const final = await readOperation(gateway.address, auth.cookie, receipt.operation_id);
  expect(final.applied_revision).toBe(final.desired_revision);
  expect(final.steps.every(step => step.status === 'succeeded')).toBe(true);
  const record = await current.pool.query<{ epoch: string }>('SELECT epoch FROM fleet_operations WHERE id=$1', [receipt.operation_id]);
  expect(Number(record.rows[0]?.epoch)).toBe(victim === 'gateway' ? checkpoint.epoch : checkpoint.epoch + 1);
  const proofs = await current.pool.query(`SELECT metadata->'host_receipt' FROM fleet_operation_events
    WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step'='stop' AND metadata ? 'host_receipt'`, [receipt.operation_id]);
  expect(proofs.rows).toHaveLength(1);
  expect(await containers(config.name)).toEqual(originalIds);
  const state = await execute('docker', ['inspect', '--format', '{{.State.Running}}', config.name]);
  expect(state.stdout.trim()).toBe('false');
  const agent = await current.pool.query('SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', ['Steven', 'zz_canary_target']);
  expect(agent.rows).toEqual([{ enabled: false, lifecycle_state: 'draft' }]);
  const durable = await new FleetOperationsRepository(current.pool).get('Steven', 'zz_canary_operator', receipt.operation_id, subject);
  expect(durable.status).toBe('succeeded');
  console.info(`SIGKILL ${victim}: running with no host receipt -> succeeded; 1 durable host receipt, same container ID`);
});
