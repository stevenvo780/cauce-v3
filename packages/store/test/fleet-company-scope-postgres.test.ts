import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetEvidence, FleetOperationRequest, FleetStepName, FleetTarget } from '@cauce/protocol';
import { ConfigurationRepository, FleetOperationsRepository, companyRevision, lockCompanyAuthority, type DatabasePool,
  type FleetOperationClaim } from '../src/index.js';
import { FleetHostSource } from '../../../services/gateway/src/fleet/source.js';
import { FleetCoordinator } from '../../../services/gateway/src/fleet/coordinator.js';
import type { FleetExecution } from '../../../services/gateway/src/fleet/executor.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let actors: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  actors = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [actors.leon]);
  await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('company-empty','Steven'),('praxis-empty','PraxisHub')");
  await admin.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('humanizar-remote','Humanizar remote','humanizar')");
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const subject = (id: string): string => `console:${id}`;
function create(tenant: string, room: string, account: string, host: string, alias: string, revision = 0): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias }, expected_revision: revision,
    idempotency_key: `create-${tenant}-${alias}`, parameters: { runtime_key: alias.replaceAll('_', '-'), harness_id: 'codex',
      primary_room_id: room, primary_account_id: account, memberships: [{ room_id: room, role: 'agent' }],
      placement: { host_id: host, mode: 'container', runtime_user: 'dev', container_name: `cauce-${alias.replaceAll('_', '-')}`,
        home_directory: '/home/dev', state_directory: `/home/dev/.cauce/${alias.replaceAll('_', '-')}` } } };
}
const humanizar = (alias: string, host = 'humanizar-host', revision = 0) =>
  create('Steven', 'company-humanizar', 'humanizar-account', host, alias, revision);
const praxis = (alias: string, revision = 0) => create('PraxisTeam', 'company-team', 'praxis-account', 'praxis-host', alias, revision);

/** A real console configuration write of one company, through its owner. */
async function configure(company: 'humanizar' | 'praxis', enabled: boolean): Promise<void> {
  const [tenant, alias, human, room] = company === 'humanizar'
    ? ['Steven', 'kant', actors.steven, 'company-empty'] : ['PraxisHub', 'company_admin', actors.leon, 'praxis-empty'];
  await new ConfigurationRepository(pool).apply(tenant, alias, { resource: 'room', action: 'update', tenant_id: tenant, id: room,
    value: { enabled } }, false, undefined, client => lockCompanyAuthority(client, { tenant, alias, humanId: human }));
}
async function revisionOf(company: string): Promise<number> {
  const client = await pool.connect();
  try { return await companyRevision(client, company); } finally { client.release(); }
}
async function claimed(repository: FleetOperationsRepository, host: string, leaseMs?: number): Promise<FleetOperationClaim> {
  const claim = await repository.claim(`${host}-worker`, host, leaseMs); if (!claim) throw new Error(`claim absent on ${host}`);
  return claim;
}

describe('fleet revisions scoped to the target company', () => {
  it('keeps previews, enqueues and in-flight steps of one company valid across the other company writes', async () => {
    const repository = new FleetOperationsRepository(pool); const steven = subject(actors.steven);
    await configure('praxis', false);
    expect(await revisionOf('humanizar')).toBe(0);
    expect((await repository.preview('Steven', 'kant', humanizar('north_agent'), steven)).can_apply).toBe(true);
    const queued = await repository.enqueue('Steven', 'kant', humanizar('north_agent'), steven);
    await configure('praxis', true);
    const claim = await claimed(repository, 'humanizar-host');
    expect(claim.operation.id).toBe(queued.id);
    const desired = (await repository.prepare(claim)).operation.desired_revision;
    expect((await pool.query('SELECT company_id,platform_override,actor_human_id::text FROM config_revisions WHERE id=$1', [desired])).rows)
      .toEqual([{ company_id: 'humanizar', platform_override: false, actor_human_id: actors.steven }]);
    expect(await revisionOf('humanizar')).toBe(desired);
    await configure('praxis', false);
    expect((await repository.startStep(claim, 'artifacts')).steps.find(step => step.name === 'artifacts')?.status).toBe('running');
    await configure('humanizar', false);
    await expect(repository.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/configuration revision changed/u) as unknown });
    await expect(repository.preview('Steven', 'kant', humanizar('late_agent'), steven)).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await revisionOf('humanizar');
    expect((await repository.preview('Steven', 'kant', humanizar('late_agent', 'humanizar-host', fresh), steven)).can_apply).toBe(true);
  });

  it('records a platform switch under the target company with its override and administrator', async () => {
    const repository = new FleetOperationsRepository(pool); const steven = subject(actors.steven);
    await configure('humanizar', false);
    const queued = await repository.forCompany('praxis').enqueue('Steven', 'kant', praxis('switched_agent'), steven);
    const claim = await claimed(repository, 'praxis-host');
    expect(claim.operation.id).toBe(queued.id);
    const desired = (await repository.prepare(claim)).operation.desired_revision;
    expect((await pool.query('SELECT company_id,platform_override,actor_human_id::text FROM config_revisions WHERE id=$1', [desired])).rows)
      .toEqual([{ company_id: 'praxis', platform_override: true, actor_human_id: actors.steven }]);
    expect(await revisionOf('praxis')).toBe(desired);
    await configure('humanizar', true);
    expect((await repository.startStep(claim, 'artifacts')).status).toBe('running');
  });
});

describe('fleet claims serialized per company', () => {
  it('lets two companies claim in parallel while one company keeps a single claim across its hosts', async () => {
    const repository = new FleetOperationsRepository(pool);
    const north = await repository.enqueue('Steven', 'kant', humanizar('north_agent'), subject(actors.steven));
    const second = await repository.enqueue('Steven', 'kant', humanizar('second_agent', 'humanizar-remote'), subject(actors.steven));
    const south = await repository.enqueue('PraxisHub', 'company_admin', praxis('south_agent'), subject(actors.leon));
    expect((await pool.query('SELECT id::text,cohort_key FROM fleet_operations ORDER BY created_at,id')).rows).toEqual([
      { id: north.id, cohort_key: 'fleet:humanizar:humanizar-host' }, { id: second.id, cohort_key: 'fleet:humanizar:humanizar-remote' },
      { id: south.id, cohort_key: 'fleet:praxis:praxis-host' }]);
    const [northClaim, southClaim] = await Promise.all([claimed(repository, 'humanizar-host'), claimed(repository, 'praxis-host')]);
    expect([northClaim.operation.id, southClaim.operation.id]).toEqual([north.id, south.id]);
    expect(await repository.claim('humanizar-remote-worker', 'humanizar-remote')).toBeNull();
    await repository.prepare(southClaim); await repository.prepare(northClaim);
    expect((await repository.startStep(northClaim, 'artifacts')).status).toBe('running');
    expect((await repository.startStep(southClaim, 'artifacts')).status).toBe('running');
  });

  it('fails a claim renewed past its step bound and frees only its own company', async () => {
    const repository = new FleetOperationsRepository(pool, { stepMaxMs: 3000 });
    const stalled = await repository.enqueue('Steven', 'kant', humanizar('stalled_agent'), subject(actors.steven));
    const waiting = await repository.enqueue('Steven', 'kant', humanizar('waiting_agent', 'humanizar-remote'), subject(actors.steven));
    await repository.enqueue('PraxisHub', 'company_admin', praxis('south_agent'), subject(actors.leon));
    const claim = await claimed(repository, 'humanizar-host', 2500);
    const south = await claimed(repository, 'praxis-host', 2500);
    await repository.prepare(claim); await repository.startStep(claim, 'artifacts');
    expect(await repository.renew(claim, 2500)).toBe(true);
    expect(await repository.claim('humanizar-remote-worker', 'humanizar-remote')).toBeNull();
    await sleep(1000);
    expect(await repository.renew(south, 1000)).toBe(true);
    expect(await repository.renew(claim, 2500)).toBe(false);
    const row = (await pool.query<{ status: string; error: unknown; worker_id: string | null; steps: { name: string; status: string }[] }>(
      'SELECT status,error,worker_id,steps FROM fleet_operations WHERE id=$1', [stalled.id])).rows[0];
    expect(row).toMatchObject({ status: 'failed', worker_id: null, error: { code: 'HOST_UNAVAILABLE', step: 'artifacts', retryable: true } });
    expect(row?.steps.find(step => step.name === 'artifacts')?.status).toBe('failed');
    expect(await repository.renew(claim, 1000)).toBe(false);
    expect((await claimed(repository, 'humanizar-remote')).operation.id).toBe(waiting.id);
    expect(() => new FleetOperationsRepository(pool, { stepMaxMs: 999 })).toThrow(/step duration bound/u);
  });
});

describe('coordinated snapshot of a non-controller host', () => {
  const remote = 'humanizar-remote';
  async function remoteAgents(): Promise<void> {
    await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('remote-room','Steven')");
    for (const alias of ['remote_agent', 'remote_sibling']) {
      const key = alias.replaceAll('_', '-');
      await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','remote-room',$1,'agent')", [alias]);
      await admin.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,runtime_user,
        home_directory,state_directory,systemd_user,primary_room_id,primary_account_id,lifecycle_state,enabled)
        VALUES('Steven',$1,$2,'codex',$3,'container',$4,'dev','/home/dev',$5,'dev','remote-room','humanizar-account','ready',true)`,
      [alias, key, remote, `cauce-${key}`, `/home/dev/.cauce/${key}`]);
    }
  }
  function evidence(step: FleetStepName): FleetEvidence {
    switch (step) {
      case 'stop': return { stopped_verified: true };
      case 'artifacts': return { artifact_sha256: 'a'.repeat(64) };
      case 'runtime': return { runtime_digest: 'd'.repeat(64) };
      case 'authenticate': return { provider_verified: true };
      case 'profile': return { profile_verified: true };
      case 'verify': return { bootstrap_verified: true, roundtrip_verified: true };
      case 'admission': return { artifact_sha256: 'b'.repeat(64) };
      default: throw new Error(`unexpected host step ${step}`);
    }
  }

  it('sends the remote host every agent of its company on stop and start', async () => {
    await remoteAgents();
    const source = new FleetHostSource(pool, { snapshotQuery: await readFile(new URL('../../../ops/scripts/fleet-query.sql', import.meta.url), 'utf8'),
      controllerHost: 'humanizar-host', coordinatorEnabled: true, coordinatorHosts: ['humanizar-host', remote] });
    const sent: { host: string; step: FleetStepName; agents: Record<string, unknown>[] }[] = [];
    const coordinator = new FleetCoordinator(source, {
      perform: (host, step, packet) => {
        sent.push({ host, step, agents: (packet.snapshot?.agents ?? []) as Record<string, unknown>[] });
        return Promise.resolve({ evidence: evidence(step) });
      },
      compensate: () => Promise.reject(new Error('compensation is not expected')),
    });
    const target: FleetTarget = { resource: 'agent', tenant_id: 'Steven', alias: 'remote_agent' };
    const run = async (kind: 'stop' | 'start'): Promise<void> => {
      const revision = await revisionOf('humanizar');
      await source.enqueue('Steven', 'kant', { kind, target, expected_revision: revision, idempotency_key: `remote-${kind}`, parameters: {} },
        subject(actors.steven));
      const claim = await claimed(source, 'humanizar-host');
      await source.prepare(claim);
      for (;;) {
        const pending = (await source.execution(claim)).operation.steps.find(step => step.status !== 'succeeded');
        if (!pending) break;
        await source.startStep(claim, pending.name);
        const execution = await source.execution(claim) as FleetExecution;
        const effect = await coordinator.perform(pending.name, execution, new AbortController().signal, claim);
        await source.completeStep(claim, pending.name, effect.evidence);
      }
      expect((await source.settle(claim)).status).toBe('succeeded');
    };
    await run('stop'); await run('start');
    expect(sent.map(packet => `${packet.host}:${packet.step}`)).toEqual([`${remote}:stop`, `${remote}:artifacts`,
      ...['runtime', 'authenticate', 'profile', 'verify', 'admission'].map(step => `${remote}:${step}`)]);
    const hosted = (await pool.query<{ alias: string }>('SELECT alias FROM agents WHERE host_id=$1 AND purged_at IS NULL ORDER BY alias', [remote]))
      .rows.map(row => row.alias);
    const controller = (await pool.query<{ alias: string }>("SELECT alias FROM agents WHERE host_id='humanizar-host' AND company_id='humanizar' ORDER BY alias"))
      .rows.map(row => row.alias);
    for (const packet of sent) {
      expect(packet.agents.filter(agent => agent.host_id === remote).map(agent => agent.alias).sort()).toEqual(hosted);
      expect(packet.agents.filter(agent => agent.host_id === 'humanizar-host').map(agent => agent.alias).sort()).toEqual(controller);
      expect(packet.agents.some(agent => String(agent.tenant_id).startsWith('Praxis'))).toBe(false);
    }
    expect(sent.find(packet => packet.step === 'artifacts')?.agents).toContainEqual(expect.objectContaining({ alias: 'remote_agent', enabled: false }));
    expect(sent.find(packet => packet.step === 'admission')?.agents).toContainEqual(expect.objectContaining({ alias: 'remote_sibling', enabled: true }));
  });
});
