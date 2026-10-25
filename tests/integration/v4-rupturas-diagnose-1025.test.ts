import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFleetHuman } from '../../packages/store/test/fleet-human-postgres.fixtures.js';
import { FleetExecutor } from '../../services/gateway/src/fleet/executor.js';
import { FleetExecutionFailure } from '../../services/gateway/src/fleet/recovery-host-command.js';
import { FleetHostSource } from '../../services/gateway/src/fleet/source.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createDrill } from './failure-drill-context-git.fixtures.js';
import { privateSshFixture, stopProcess } from './failure-drill-ssh.fixtures.js';
import { operatorGateway, receipt } from './v4-rupturas.fixtures.js';

const root = resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);
let database: TestDatabase;
beforeAll(async () => { database = await startTestDatabase({ requireOwnedContainer: true }); });
afterAll(async () => { await closeTestDatabase(database); });

describe('tres fallos localizados solo con registros del operador (g2)', () => {
  it('un host caído deja la operación fallida localizable en consola y en cauce diagnose', async () => {
    const current = await startTestCaseDatabase(database);
    const ssh = await privateSshFixture().catch(async (error: unknown) => { await current.close(); throw error; });
    const directory = join(ssh.directory, 'zz-canary-case');
    const host = `zz-canary-down-${randomUUID().slice(0, 8)}`;
    let runtime: ChildProcess | undefined;
    let worker: ChildProcess | undefined;
    let operator: Awaited<ReturnType<typeof operatorGateway>> | undefined;
    try {
      await mkdir(directory, { mode: 0o700 });
      await current.pool.query("INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-down-room','Steven')");
      await current.pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','zz_canary_operator')");
      await current.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
        VALUES('Steven','zz-canary-down-room','zz_canary_operator','operator'),('Steven','zz-canary-down-room','zz_canary_down','agent')`);
      const subject = await seedFleetHuman(current.adminPool, 'Steven', 'zz_canary_operator');
      await current.pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
        runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
        VALUES('Steven','zz_canary_down',$4,'codex',$4,'native','host:'||$4,$3,$1,$2,$3,'zz-canary-down-room','ready',true)`,
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
        kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'zz_canary_down' },
        parameters: {}, expected_revision: 0, idempotency_key: 'zz-canary-host-down' }, subject);
      await ssh.interrupt();
      worker = spawn(process.execPath, ['--import', 'tsx', 'tests/integration/v4-rupturas-executor.ts'], {
        cwd: root, env: { ...process.env, CAUCE_RUPTURE_CONFIG: JSON.stringify({ url: current.url, host,
          command: { python: '/usr/bin/python3', executable: join(root, 'tests/integration/failure-drill-ssh-executor.py'),
            policyFile, timeoutMs: 20_000, transport: ssh.transport } }) }, stdio: ['ignore', 'ignore', 'pipe'] });
      let log = '';
      worker.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString(); });
      expect((await once(worker, 'close'))[0]).toBe(0);
      const shown = await operator.request(`/v3/console/fleet/operations/${operation.id}`) as {
        status: string; error: { code: string; step?: string } | null };
      expect(shown).toMatchObject({ status: 'failed', error: { code: 'STEP_FAILED', step: 'stop' } });
      const diagnosis = await operator.diagnose(operation.id);
      expect(diagnosis.diagnosis.items).toContainEqual(expect.objectContaining({ type: 'operation',
        id: operation.id, component: 'fleet', error_code: 'STEP_FAILED', step: 'stop', state: 'failed' }));
      receipt({ kind: 'host_down', id: operation.id, component: 'fleet',
        cause: 'SSH sin daemon al ejecutar stop; STEP_FAILED en el paso stop',
        command: diagnosis.command, operator_evidence: { console: shown, diagnosis: diagnosis.diagnosis, executor_log: log.slice(-500) } });
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

  it('un Git de contextos sin red se localiza en auditoría, estado y cauce diagnose por evento', async () => {
    const drill = await createDrill(database);
    let operator: Awaited<ReturnType<typeof operatorGateway>> | undefined;
    try {
      operator = await operatorGateway(drill.database.pool, 'context_alpha@dev.example');
      await execute('git', ['-C', drill.firstRepository, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/contexts.git']);
      await drill.write(drill.first, 'Contexto con el remoto caído');
      await drill.process(drill.first);
      const auditPath = `/v3/console/audit?action=context.sync&alias=${drill.first.alias}&limit=100`;
      const audit = await operator.request(auditPath) as { items: { event_id: string; component: string; summary: string }[] };
      const found = audit.items.find(item => item.summary.includes('context_git_network_failed'));
      expect(found).toMatchObject({ component: 'context' });
      if (!found) throw new Error('network failure audit event unavailable');
      const statusPath = `/v3/console/context/agents/${drill.first.tenant_id}/${drill.first.alias}/status`;
      const status = await operator.request(statusPath) as { sync: { state: string; last_error: string } };
      expect(status).toMatchObject({ sync: { state: 'error', last_error: 'context_git_network_failed' } });
      const diagnosis = await operator.diagnose(found.event_id);
      expect(diagnosis.diagnosis.items).toContainEqual(expect.objectContaining({ type: 'audit', id: found.event_id, action: 'context.sync' }));
      expect(diagnosis.diagnosis.items).toContainEqual(expect.objectContaining({
        type: 'context', error_code: 'context_git_network_failed' }));
      receipt({ kind: 'context_git_no_network', id: found.event_id, component: 'context',
        cause: 'context_git_network_failed', command: `${operator.requestCommand(auditPath)}; ${diagnosis.command}`,
        operator_evidence: { audit: found, sync: status.sync, diagnosis: diagnosis.diagnosis } });
    } finally { try { await operator?.close(); } finally { await drill.close(); } }
  });

  it('un proveedor que rechaza la prueba de login deja la operación en el paso authenticate', async () => {
    const current = await startTestCaseDatabase(database);
    const host = `zz-canary-auth-${randomUUID().slice(0, 8)}`;
    let operator: Awaited<ReturnType<typeof operatorGateway>> | undefined;
    try {
      await current.pool.query("INSERT INTO rooms(id,tenant_id) VALUES('zz-canary-auth-room','Steven')");
      await current.pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','zz_canary_operator')");
      await current.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
        VALUES('Steven','zz-canary-auth-room','zz_canary_operator','operator'),('Steven','zz-canary-auth-room','zz_canary_auth','agent')`);
      const subject = await seedFleetHuman(current.adminPool, 'Steven', 'zz_canary_operator');
      await current.pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
        runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
        VALUES('Steven','zz_canary_auth',$1,'codex',$1,'native','host:'||$1,'dev','/home/dev','/home/dev/.cauce/auth','dev','zz-canary-auth-room','ready',true)`,
      [host]);
      const source = new FleetHostSource(current.pool, { controllerHost: host,
        snapshotQuery: await readFile(join(root, 'ops/scripts/fleet-query.sql'), 'utf8') });
      operator = await operatorGateway(current.pool, `${subject.slice('console:'.length)}@example.test`, source);
      const operation = await source.enqueue('Steven', 'zz_canary_operator', {
        kind: 'start', target: { resource: 'agent', tenant_id: 'Steven', alias: 'zz_canary_auth' },
        parameters: {}, expected_revision: 0, idempotency_key: 'zz-canary-provider-rejects' }, subject);
      const executor = new FleetExecutor(source, { host, worker: 'zz-canary-auth-worker', leaseMs: 5_000,
        perform: async (step) => {
          if (step === 'runtime') return { evidence: { runtime_digest: 'b'.repeat(64) } };
          if (step === 'authenticate') throw new FleetExecutionFailure('provider_functional_proof_failed');
          throw new Error(`unexpected canary step ${step}`);
        } });
      await executor.runOnce();
      const shown = await operator.request(`/v3/console/fleet/operations/${operation.id}`) as {
        status: string; error: { code: string; step?: string; reason?: string } | null };
      expect(shown).toMatchObject({ status: 'failed',
        error: { code: 'STEP_FAILED', step: 'authenticate', reason: 'provider_functional_proof_failed' } });
      const diagnosis = await operator.diagnose(operation.id);
      expect(diagnosis.diagnosis.items).toContainEqual(expect.objectContaining({ type: 'operation',
        id: operation.id, component: 'fleet', error_code: 'STEP_FAILED', step: 'authenticate', state: 'failed' }));
      receipt({ kind: 'provider_login_rejected', id: operation.id, component: 'fleet',
        cause: 'provider_functional_proof_failed en el paso authenticate; STEP_FAILED',
        command: diagnosis.command, operator_evidence: { console: shown, diagnosis: diagnosis.diagnosis } });
    } finally {
      try { await operator?.close(); } finally { await current.close(); }
    }
  });
});
