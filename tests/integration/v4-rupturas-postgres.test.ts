import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFleetHuman } from '../../packages/store/test/fleet-human-postgres.fixtures.js';
import { FleetHostSource } from '../../services/gateway/src/fleet/source.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createDrill } from './failure-drill-context-git.fixtures.js';
import { contents, privateSshFixture, stopProcess } from './failure-drill-ssh.fixtures.js';
import { operatorGateway, receipt } from './v4-rupturas.fixtures.js';

const root = resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);
let database: TestDatabase;
beforeAll(async () => { database = await startTestDatabase({ requireOwnedContainer: true }); });
afterAll(async () => { await closeTestDatabase(database); });

describe('real ruptures diagnosed only through operator records', () => {
  it('correlates a real SSH cut in the middle of a fleet stop with its sanitized executor log', async () => {
    const current = await startTestCaseDatabase(database);
    const ssh = await privateSshFixture().catch(async (error: unknown) => { await current.close(); throw error; });
    const directory = join(ssh.directory, 'zz-canary-case');
    const host = `zz-canary-rupture-${randomUUID().slice(0, 8)}`;
    let runtime: ChildProcess | undefined;
    let worker: ChildProcess | undefined;
    let operator: Awaited<ReturnType<typeof operatorGateway>> | undefined;
    try {
      await mkdir(directory, { mode: 0o700 });
      await current.pool.query("INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-ssh-room','Steven')");
      await current.pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','zz_canary_operator')");
      await current.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','zz-canary-ssh-room','zz_canary_operator','operator'),('Steven','zz-canary-ssh-room','zz_canary_ssh','agent')");
      const subject = await seedFleetHuman(current.adminPool, 'Steven', 'zz_canary_operator');
      await current.pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
        runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
        VALUES('Steven','zz_canary_ssh',$4,'codex',$4,'native','host:'||$4,$3,$1,$2,$3,'zz-canary-ssh-room','ready',true)`,
      [ssh.directory, directory, userInfo().username, host]);
      const source = new FleetHostSource(current.pool, { controllerHost: host,
        snapshotQuery: await readFile(join(root, 'ops/scripts/fleet-query.sql'), 'utf8') });
      operator = await operatorGateway(current.pool, `${subject.slice('console:'.length)}@example.test`, source);
      runtime = spawn('/usr/bin/python3', ['-c', 'import time; time.sleep(120)', 'zz-canary-rupture'], { stdio: 'ignore' });
      const pid = runtime.pid;
      if (!pid) throw new Error('Canary runtime did not start');
      const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
      const ticks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19];
      const policyFile = join(directory, 'policy.json');
      await writeFile(policyFile, JSON.stringify({ root: directory, pid, ticks, stage: 'before-effect' }), { mode: 0o600 });
      const operation = await source.enqueue('Steven', 'zz_canary_operator', {
        kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'zz_canary_ssh' },
        parameters: {}, expected_revision: 0, idempotency_key: 'zz-canary-rupture-ssh' }, subject);
      worker = spawn(process.execPath, ['--import', 'tsx', 'tests/integration/v4-rupturas-executor.ts'], {
        cwd: root, env: { ...process.env, CAUCE_RUPTURE_CONFIG: JSON.stringify({ url: current.url, host,
          command: { python: '/usr/bin/python3', executable: join(root, 'tests/integration/failure-drill-ssh-executor.py'),
            policyFile, timeoutMs: 20_000, transport: ssh.transport } }) }, stdio: ['ignore', 'ignore', 'pipe'] });
      let log = '';
      worker.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString(); });
      const exited = once(worker, 'close');
      await expect.poll(() => contents(join(directory, 'pending.json')), { timeout: 20_000 }).not.toBe('');
      expect(await ssh.interrupt()).not.toHaveLength(0);
      expect((await exited)[0]).toBe(0);
      const diagnosis = await operator.diagnose(operation.id);
      expect(diagnosis.diagnosis.items).toContainEqual(expect.objectContaining({ type: 'operation',
        id: operation.id, component: 'fleet', error_code: 'STEP_FAILED', step: 'stop', state: 'failed' }));
      const line = log.split('\n').find(value => value.includes(`operation_id=${operation.id}`));
      expect(line).toContain('component=fleet.executor');
      expect(line).toContain(`host_id=${host}`);
      expect(line).toMatch(/exit=255.*(?:closed|reset|killed)/iu);
      const logFile = join(operator.directory, 'executor.log');
      await writeFile(logFile, log, { mode: 0o600 });
      const found = await execute('rg', ['-F', `operation_id=${operation.id}`, logFile]);
      expect(found.stdout.trim()).toBe(line);
      receipt({ kind: 'ssh_interrupted', id: operation.id, component: 'fleet.executor', cause: 'SSH connection closed during stop; STEP_FAILED',
        command: `${diagnosis.command}; rg -F operation_id=${operation.id} ${logFile}`,
        operator_evidence: { diagnosis: diagnosis.diagnosis, executor_log: line } });
      expect(runtime.exitCode).toBeNull();
    } finally {
      try { await stopProcess(worker); } finally {
        try { await stopProcess(runtime); } finally {
          try { await operator?.close(); } finally {
            try { await current.close(); } finally { await ssh.close(); }
          }
        }
      }
    }
  });

  it('finds a real broker non-fast-forward rejection using company audit and context status', async () => {
    const drill = await createDrill(database);
    let operator: Awaited<ReturnType<typeof operatorGateway>> | undefined;
    try {
      operator = await operatorGateway(drill.database.pool, 'context_alpha@dev.example');
      await Promise.all([drill.write(drill.first, 'First canary context'), drill.write(drill.second, 'Second canary context')]);
      await drill.freezeSecondFetch();
      await drill.process(drill.first); await drill.process(drill.second);
      const auditPath = `/v3/console/audit?action=context.sync&alias=${drill.second.alias}&limit=100`;
      const audit = await operator.request(auditPath) as { items: { component: string; summary: string }[] };
      const found = audit.items.find(item => item.summary.includes('context_git_non_fast_forward'));
      expect(found).toMatchObject({ component: 'context' });
      const statusPath = `/v3/console/context/agents/${drill.second.tenant_id}/${drill.second.alias}/status`;
      const status = await operator.request(statusPath) as { desired_version: number; sync: { state: string; last_error: string; git_commit: string } };
      expect(status).toMatchObject({ desired_version: 1, sync: { state: 'error', last_error: 'context_git_non_fast_forward' } });
      receipt({ kind: 'context_push_rejected', id: `${drill.second.tenant_id}/${drill.second.alias}/1`, component: 'context',
        cause: 'context_git_non_fast_forward', command: `${operator.requestCommand(auditPath)}; ${operator.requestCommand(statusPath)}`,
        operator_evidence: { audit: found, version: status.desired_version, sync: status.sync } });
      await drill.thawSecondFetch(); await drill.retry(drill.second); await drill.process(drill.second);
      const recovered = await operator.request(statusPath) as { sync: { state: string } };
      expect(recovered.sync.state).toBe('synced');
    } finally { try { await operator?.close(); } finally { await drill.close(); } }
  });
});
