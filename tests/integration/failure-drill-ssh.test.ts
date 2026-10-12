import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFleetHuman } from '../../packages/store/test/fleet-human-postgres.fixtures.js';
import { FleetExecutor } from '../../services/gateway/src/fleet/executor.js';
import { performHostCommand } from '../../services/gateway/src/fleet/host-command.js';
import { FleetHostSource } from '../../services/gateway/src/fleet/source.js';
import { startTestCaseDatabase, startTestDatabase, closeTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { contents, privateSshFixture, stopProcess, sweepDatabaseFleet, type PrivateSshFixture } from './failure-drill-ssh.fixtures.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let ssh: PrivateSshFixture | undefined;
let runtime: ChildProcess | undefined;
let directory: string;
let subject: string;
let source: FleetHostSource;
let shutdown: AbortController | undefined;
let active: Promise<boolean> | undefined;
let runtimeKey: string;

beforeAll(async () => {
  database = await startTestDatabase({ requireOwnedContainer: true });
  ssh = await privateSshFixture();
}, 120_000);
beforeEach(async () => {
  if (!database || !ssh) throw new Error('Private SSH database fixture is absent');
  current = await startTestCaseDatabase(database);
  runtimeKey = `zz-canary-ssh-${randomUUID().slice(0, 8)}`;
  directory = join(ssh.directory, 'zz-canary-case');
  await mkdir(directory, { mode: 0o700 });
  await current.pool.query("INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-ssh-room','Steven')");
  await current.pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','zz_canary_operator')");
  await current.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-ssh-room','zz_canary_operator','operator')");
  subject = await seedFleetHuman(current.adminPool, 'Steven', 'zz_canary_operator');
  await current.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-ssh-room','zz_canary_ssh','agent')");
  await current.pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
    runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
    VALUES('Steven','zz_canary_ssh',$4,'codex',$4,'native','host:'||$4,
    $3,$1,$2,$3,'zz-canary-ssh-room','ready',true)`, [ssh.directory, directory, userInfo().username, runtimeKey]);
  source = new FleetHostSource(current.pool, {
    snapshotQuery: await readFile(join(projectRoot, 'ops/scripts/fleet-query.sql'), 'utf8'),
    controllerHost: runtimeKey,
  });
});
afterEach(async () => {
  shutdown?.abort();
  await active; active = undefined;
  await stopProcess(runtime); runtime = undefined;
  try {
    if (current) {
      await current.pool.query('UPDATE agents SET primary_room_id=NULL WHERE runtime_key=$1 AND host_id=$1', [runtimeKey]);
      await current.pool.query("DELETE FROM memberships WHERE tenant_id='Steven' AND alias='zz_canary_ssh'");
      await current.pool.query('DELETE FROM agents WHERE runtime_key=$1 AND host_id=$1', [runtimeKey]);
      const sweep = await sweepDatabaseFleet(current.pool, directory, runtimeKey, runtimeKey);
      expect(sweep.exitCode).toBe(0); expect(sweep.report.clean).toBe(true);
    }
  } finally {
    await current?.close(); current = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
afterAll(async () => {
  await ssh?.close();
  if (database) {
    const containerId = database.container.getId();
    await closeTestDatabase(database);
    try {
      await execute('/usr/bin/docker', ['inspect', containerId], { timeout: 5000 });
      throw new Error('Private PostgreSQL fixture container remains after cleanup');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 1
        && 'stderr' in error && typeof error.stderr === 'string' && /no such object/iu.test(error.stderr))) throw error;
    }
    console.log(`SSH_DRILL_POSTGRES_CLEANUP container=${containerId} remaining=0`);
  }
});

describe('private SSH interruption and durable operation recovery with real processes', () => {
  it.each(['before-effect', 'after-effect'] as const)('keeps %s loss failed until a measured remote retry completes once', async stage => {
    if (!ssh || !current) throw new Error('Private SSH case is absent');
    const transport = ssh.transport;
    runtime = spawn('/usr/bin/python3', ['-c', 'import time; time.sleep(120)', `zz-canary-${stage}`], { stdio: 'ignore' });
    const running = runtime;
    await expect.poll(() => running.pid).toBeTypeOf('number');
    const pid = running.pid;
    if (!pid) throw new Error('Canary process pid is absent');
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19];
    const policyFile = join(directory, 'policy.json');
    await writeFile(policyFile, JSON.stringify({ root: directory, pid, ticks, stage }), { mode: 0o600 });
    const operation = await source.enqueue('Steven', 'zz_canary_operator', {
      kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'zz_canary_ssh' },
      parameters: {}, expected_revision: 0, idempotency_key: `zz-canary-ssh-${stage}`,
    }, subject);
    shutdown = new AbortController();
    const executor = new FleetExecutor(source, {
      signal: shutdown.signal,
      host: runtimeKey, worker: 'zz-canary-ssh-worker', leaseMs: 5000,
      perform: (step, packet, signal) => performHostCommand({
        python: '/usr/bin/python3', executable: join(projectRoot, 'tests/integration/failure-drill-ssh-executor.py'),
        policyFile, timeoutMs: 20_000, transport,
      }, step, packet, signal),
    });
    const pending = executor.runOnce(); active = pending;
    await expect.poll(() => contents(join(directory, 'pending.json')), { timeout: 20_000 }).not.toBe('');
    const barrier = JSON.parse(await contents(join(directory, 'pending.json'))) as { operation: string; stage: string };
    expect(barrier).toMatchObject({ operation: operation.id, stage });
    const interruptedPids = await ssh.interrupt();
    expect(interruptedPids.length).toBeGreaterThan(1);
    await expect(pending).resolves.toBe(true);
    const failed = await source.get('Steven', 'zz_canary_operator', operation.id, subject);
    expect(failed).toMatchObject({ status: 'failed', applied_revision: null, error: { code: 'STEP_FAILED', step: 'stop', retryable: true } });
    expect(failed.steps.find(step => step.name === 'stop')?.status).toBe('failed');
    expect((await current.pool.query("SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step'='stop'", [operation.id])).rowCount).toBe(0);
    if (stage === 'before-effect') expect(running.exitCode).toBeNull();
    else await expect.poll(() => running.signalCode).toBe('SIGTERM');
    console.log(`SSH_DRILL stage=${stage} interrupted=${String(interruptedPids.length)} status=${failed.status} cause=${String(failed.error?.code)} applied=null`);
    await ssh.start();
    await writeFile(join(directory, 'release'), 'release', { mode: 0o600 });
    const resumed = await source.resume('Steven', 'zz_canary_operator', operation.id, failed.version, subject);
    expect(resumed.status).toBe('queued');
    active = executor.runOnce();
    await expect(active).resolves.toBe(true);
    const completed = await source.get('Steven', 'zz_canary_operator', operation.id, subject);
    expect(completed.status).toBe('succeeded');
    expect(completed.applied_revision).toBe(completed.desired_revision);
    await expect.poll(() => running.signalCode).toBe('SIGTERM');
    const effects = (await contents(join(directory, 'effects.jsonl'))).trim().split('\n').filter(Boolean);
    expect(effects).toHaveLength(1);
    expect(JSON.parse(effects[0] ?? '')).toMatchObject({ operation: operation.id, pid });
    expect((await current.pool.query("SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND event='succeeded'", [operation.id])).rowCount).toBe(1);
    expect(await executor.runOnce()).toBe(false);
    expect((await contents(join(directory, 'effects.jsonl'))).trim().split('\n')).toHaveLength(1);
    console.log(`SSH_DRILL stage=${stage} reconnected=true status=${completed.status} effects=1 duplicate_claims=0`);
  });
});
