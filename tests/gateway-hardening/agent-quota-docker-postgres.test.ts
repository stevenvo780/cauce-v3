import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import type { AgentQuotaClaim, AgentQuotaReceipt } from '@cauce/protocol';
import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { startTestDatabase, startTestCaseDatabase, type TestDatabase, type EmptyTestDatabase } from '../helpers/postgres.js';
import { channelCapabilities, channelCompany, channelHost } from '../../services/gateway/src/fleet/host-channel.fixtures.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { buildTestGateway } from '../../services/gateway/src/test-support/gateway-doubles.js';
import { SignedHostChannel } from '../../services/gateway/src/fleet/signed-source.js';
import { AgentQuotaExecutor, HostChannelAgentQuotaRepository } from '../../services/gateway/src/fleet/agent-quota-executor.js';
import { performAgentQuotaHostCommand } from '../../services/gateway/src/fleet/agent-quota-host-command.js';

interface Placement {
  tenant_id: string; alias: string; host_id: string; harness_id: string; runtime_mode: string; container_name: string;
  runtime_key: string; runtime_user: string; home_directory: string; state_directory: string; systemd_user: string;
}
interface Card {
  tenant_id: string; alias: string; revision: number; status: string; reader_available: boolean; captured_at: string | null;
  sample: { windows: { remaining_percent: number }[] } | null;
  binding: { account_id: string; shared: boolean } | null;
}
const PASSWORD = 'synthetic-durable-quota-password';
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let app: FastifyInstance | undefined; let helper: ChildProcessWithoutNullStreams | undefined; let directory: string | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database); pool = current.pool;
  directory = await mkdtemp('/var/tmp/zz-canary-agent-quota-channel-');
});
afterEach(async () => {
  if (helper) {
    const child = helper;
    const exit = child.exitCode === null ? once(child, 'exit').then(() => child.exitCode) : Promise.resolve(child.exitCode);
    helper.stdin.end('close\n');
    const code = await exit; expect(code, 'Docker fixture cleanup must succeed').toBe(0); helper = undefined;
  }
  await app?.close(); app = undefined; await current?.close(); current = undefined;
  if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined;
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function canary(host: string, tenant: string) {
  helper = spawn('/usr/bin/python3', ['-B', resolve('ops/tests/agent_quota_durable_fixture.py')], { stdio: 'pipe' });
  helper.stderr.on('data', (bytes: Buffer) => { process.stderr.write(bytes); });
  const lines = createInterface({ input: helper.stdout });
  const result = new Promise<{ policy_file: string; agents: Placement[] }>((resolveResult, reject) => {
    helper?.once('error', reject);
    helper?.once('exit', code => { reject(new Error(`Docker fixture exited before ready: ${String(code)}`)); });
    lines.once('line', line => { try { resolveResult(JSON.parse(line) as { policy_file: string; agents: Placement[] }); }
      catch { reject(new Error('Docker fixture returned an invalid setup packet')); } finally { lines.close(); } });
  });
  helper.stdin.write(JSON.stringify({ host_id: host, tenant_id: tenant }) + '\n');
  return result;
}
describe.skipIf(process.env.CAUCE_QUOTA_DOCKER_E2E !== '1')('durable agent quota HTTP -> signed host -> real Docker -> PostgreSQL -> agent card', () => {
  it('measures two real containers as one account, persists unsupported and receipts, and isolates companies', async () => {
    if (!current || !directory) throw new Error('fixture missing');
    const company = await channelCompany(pool, 'durablequota'); const foreign = await channelCompany(pool, 'foreignquota');
    const host = await channelHost(pool, company);
    const password = await hashPassword(PASSWORD, { cost: 1024, blockSize: 8, parallelism: 1 });
    await current.adminPool.query('UPDATE console_users SET password_hash=$1', [password]);
    app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 47),
    }) });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    const identity = (await pool.query<{ enrollment_id: string; key_fingerprint: string }>(
      'SELECT enrollment_id,key_fingerprint FROM fleet_host_identities WHERE host_id=$1', [host.host_id])).rows[0];
    if (!identity) throw new Error('host enrollment missing');
    await writeFile(join(directory, 'identity.json'), JSON.stringify({ ...identity, host_id: host.host_id, company_id: host.company_id,
      gateway, state: 'enrolled', executor_ready: false }), { mode: 0o600 });
    await writeFile(join(directory, 'private.pem'), host.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const channel = await SignedHostChannel.load(directory);
    await channel.request('POST', `/v3/fleet/hosts/${host.host_id}/channel`, channelCapabilities());
    const fixture = await canary(host.host_id, company.hub.id);
    for (const agent of fixture.agents) {
      await current.adminPool.query(`INSERT INTO agents(tenant_id,alias,company_id,harness_id,host_id,runtime_mode,container_name,
        runtime_key,runtime_user,home_directory,state_directory,systemd_user,enabled,lifecycle_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'ready')`,
      [agent.tenant_id,agent.alias,company.company.id,agent.harness_id,agent.host_id,agent.runtime_mode,agent.container_name,
        agent.runtime_key,agent.runtime_user,agent.home_directory,agent.state_directory,agent.systemd_user]);
    }
    async function login(email: string) {
      const response = await fetch(gateway + '/v3/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ email, password: PASSWORD }) });
      expect(response.status).toBe(200);
      return { cookie: response.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-cauce_session='))?.split(';')[0] ?? '',
        csrf: (await response.json() as { csrf_token: string }).csrf_token };
    }
    const session = await login(company.user.email); const other = await login(foreign.user.email);
    const path = (agent: Placement) => `/v3/console/agents/${encodeURIComponent(agent.tenant_id)}/${encodeURIComponent(agent.alias)}/quota`;
    async function read(agent: Placement): Promise<Card> {
      const response = await fetch(gateway + path(agent), { headers: { cookie: session.cookie } });
      expect(response.status).toBe(200); return await response.json() as Card;
    }
    async function enqueue(agent: Placement, revision: number, key: string) {
      return fetch(gateway + path(agent), { method: 'POST', headers: { cookie: session.cookie, origin: 'http://localhost',
        'x-csrf-token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: revision, idempotency_key: key }) });
    }
    let finalClaim: AgentQuotaClaim | undefined; let finalReceipt: AgentQuotaReceipt | undefined;
    const source = new HostChannelAgentQuotaRepository(channel, host.host_id);
    const originalClaim = source.claim.bind(source);
    source.claim = async (...args) => { const claim = await originalClaim(...args); if (claim) finalClaim = claim; return claim; };
    const executor = new AgentQuotaExecutor(source, { worker: `host-${host.host_id}`, host: host.host_id, leaseMs: 30_000,
      perform: async (execution, signal) => {
        const receipt = await performAgentQuotaHostCommand({ python: '/usr/bin/python3', executable: resolve('ops/cli/fleet-executor.py'),
          policyFile: fixture.policy_file, timeoutMs: 60_000 }, execution, signal);
        finalReceipt = receipt; return receipt;
      } });
    const cards: Card[] = [];
    for (const [index, agent] of fixture.agents.entries()) {
      const before = await read(agent);
      const foreignRead = await fetch(gateway + path(agent), { headers: { cookie: other.cookie } });
      expect(foreignRead.status).toBe(404);
      const foreignWrite = await fetch(gateway + path(agent), { method: 'POST', headers: { cookie: other.cookie, origin: 'http://localhost',
        'x-csrf-token': other.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: before.revision, idempotency_key: 'foreign' }) });
      expect(foreignWrite.status).toBe(404);
      const key = `docker-query-${String(index)}`;
      const queued = await enqueue(agent, before.revision, key);
      if (agent.harness_id === 'openclaw') {
        expect(before.reader_available).toBe(false); expect(before.status).toBe('unsupported');
        expect(queued.status).toBe(409); cards.push(await read(agent)); continue;
      }
      expect(queued.status).toBe(202); const operation = await queued.json() as { operation_id: string };
      const replay = await enqueue(agent, before.revision, key); expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ operation_id: operation.operation_id });
      expect(await executor.runOnce()).toBe(true);
      const card = await read(agent); expect(card.status).toBe('ok'); expect(card.captured_at).not.toBeNull();
      expect(card.sample?.windows).toEqual([expect.objectContaining({ remaining_percent: 75 })]);
      cards.push(card);
      expect(finalClaim?.id).toBe(operation.operation_id);
      if (!finalClaim || !finalReceipt) throw new Error('real receipt missing');
      await source.finish(finalClaim, finalReceipt);
      await expect(source.finish(finalClaim, { ...finalReceipt, captured_at: new Date().toISOString() })).rejects.toThrow();
      const again = await enqueue(agent, before.revision, key); expect(again.status).toBe(202);
      expect(await again.json()).toMatchObject({ operation_id: operation.operation_id });
      expect(await executor.runOnce()).toBe(false);
    }
    expect(cards[0]?.binding?.account_id).toBe(cards[1]?.binding?.account_id);
    expect(cards[1]?.binding?.shared).toBe(true);
    expect((await current.adminPool.query(`SELECT status,reader_available,account_id,sample,captured_at
      FROM agent_quota_observations WHERE status='unsupported' AND company_id='durablequota'`)).rows)
      .toEqual([{ status: 'unsupported', reader_available: false, account_id: null, sample: null, captured_at: null }]);
    const counts = (await current.adminPool.query<{ accounts: number; bindings: number; samples: number; operations: number }>(`SELECT
      (SELECT count(*)::int FROM provider_accounts WHERE quota_identity_hash IS NOT NULL) AS accounts,
      (SELECT count(*)::int FROM agent_account_bindings WHERE company_id='durablequota') AS bindings,
      (SELECT count(*)::int FROM quota_collections) AS samples,
      (SELECT count(*)::int FROM agent_quota_operations WHERE status='done') AS operations`)).rows[0];
    expect(counts).toEqual({ accounts: 1, bindings: 2, samples: 2, operations: 2 });
    console.info(`AGENT_QUOTA_DURABLE_DOCKER=${JSON.stringify({ counts, statuses: cards.map(card => card.status),
      captured_at: cards.slice(0, 2).map(card => card.captured_at), companies_isolated: true, idempotent: true })}`);
  }, 180_000);
});
