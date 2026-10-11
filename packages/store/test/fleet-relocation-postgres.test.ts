import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetOperationRequest, FleetStepName } from '@cauce/protocol';
import { FleetOperationsRepository, aggregateHostEvidence, selectFleetHostSlices, type DatabasePool, type FleetOperationClaim } from '../src/index.js';
import { FleetCoordinator } from '../../../services/gateway/src/fleet/coordinator.js';
import { performHostCommand, performHostCompensation, type HostCommandConfig } from '../../../services/gateway/src/fleet/host-command.js';
import type { FleetExecution } from '../../../services/gateway/src/fleet/executor.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedFleetHuman } from './fleet-human-postgres.fixtures.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase; let pool: DatabasePool; let subject: string;
let directory: string; let sourceProcess: ChildProcess | undefined;
const sourceHost = 'relocation-source'; const destinationHost = 'relocation-destination';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('Relocation database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; directory = await mkdtemp('/var/tmp/cauce-relocation-');
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('relocation-room','Steven')");
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','relocation_operator')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','relocation-room','relocation_operator','operator')");
  subject = await seedFleetHuman(current.adminPool, 'Steven', 'relocation_operator');
  for (const host of [sourceHost, destinationHost]) {
    await pool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id) SELECT $1,$1,company_id FROM tenants WHERE id='Steven'`, [host]);
    await mkdir(join(directory, host), { mode: 0o700 });
  }
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('relocation-account','codex','relocation-test-account','Steven','env_path','CAUCE_RELOCATION_TEST_PATH',true)`);
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','relocation-room','relocation_agent','agent')");
  await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
    runtime_user,home_directory,state_directory,systemd_user,primary_room_id,primary_account_id,lifecycle_state,enabled)
    VALUES('Steven','relocation_agent','relocation-agent','codex',$1,'native','host:'||$1,'dev','/home/dev',$2,'stev',
      'relocation-room','relocation-account','ready',true)`, [sourceHost, join(directory, sourceHost)]);
  await writeFile(join(directory, sourceHost, 'project'), 'Recoverable project contents', { mode: 0o600 });
  await writeFile(join(directory, sourceHost, 'provider-profile'), 'Synthetic local profile retained', { mode: 0o600 });
});
afterEach(async () => {
  if (sourceProcess?.exitCode === null && sourceProcess.signalCode === null) {
    const ended = once(sourceProcess, 'exit'); sourceProcess.kill('SIGTERM'); await ended;
  }
  sourceProcess = undefined;
  try { process.kill(Number(await readFile(join(directory, destinationHost, 'pid'), 'utf8')), 'SIGTERM'); } catch { /* The fixture runtime may already be stopped. */ }
  await current.close(); await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function repository(coordinatorEnabled = true, hosts = [sourceHost, destinationHost]) {
  return new FleetOperationsRepository(pool, { controllerHost: sourceHost, coordinatorEnabled, coordinatorHosts: hosts });
}
function request(host = destinationHost): FleetOperationRequest {
  return { kind: 'update', target: { resource: 'agent', tenant_id: 'Steven', alias: 'relocation_agent' }, expected_revision: 0,
    idempotency_key: 'relocation-test-operation', parameters: { runtime_key: 'relocation-agent', harness_id: 'codex',
      primary_room_id: 'relocation-room', primary_account_id: 'relocation-account', memberships: [{ room_id: 'relocation-room', role: 'agent' }],
      placement: { host_id: host, mode: 'native', runtime_user: 'dev', home_directory: '/home/dev',
        state_directory: join(directory, host), systemd_user: 'stev' } } };
}
async function prepared(repo = repository(), input = request()) {
  await repo.enqueue('Steven', 'relocation_operator', input, subject);
  const claim = await repo.claim('relocation-worker', sourceHost); if (!claim) throw new Error('Relocation claim absent');
  const result = await repo.prepare(claim); return { repo, claim, result };
}
async function complete(repo: FleetOperationsRepository, claim: FleetOperationClaim, step: FleetStepName) {
  await repo.startStep(claim, step);
  for (const slice of selectFleetHostSlices(await repo.hostSlices(claim), step)) {
    const evidence = step === 'stop' ? { stopped_verified: true } : step === 'revoke' ? { revocation_verified: true }
      : { artifact_sha256: slice.placement_role === 'source' ? 'a'.repeat(64) : 'b'.repeat(64) };
    await repo.completeHostStep(claim, step, slice.host_id, slice.target_sha256, evidence);
  }
  await repo.completeStep(claim, step, aggregateHostEvidence(step, await repo.hostReceipts(claim, step)));
}
describe('relocation with durable source and destination barriers', () => {
  it('rejects direct relocation, missing transports and changed runtime identity before fencing', async () => {
    for (const repo of [repository(false), repository(true, [sourceHost])]) {
      await expect(repo.enqueue('Steven', 'relocation_operator', request(), subject)).rejects.toMatchObject({ code: 'conflict' });
    }
    const input = request(); if (input.kind !== 'update') throw new Error('Update absent');
    await expect(repository().enqueue('Steven', 'relocation_operator', { ...input,
      parameters: { ...input.parameters, runtime_key: 'new-runtime' } }, subject)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT enabled,host_id FROM agents WHERE alias='relocation_agent'")).rows[0])
      .toEqual({ enabled: true, host_id: sourceHost });
    expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(0);
  });
  it('keeps same-host update free of relocation roles and the additional revoke step', async () => {
    const { repo, claim } = await prepared(repository(false), request(sourceHost));
    expect((await repo.hostSlices(claim)).map(slice => slice.placement_role)).toEqual([undefined]);
    expect((await repo.execution(claim)).operation.steps.map(step => step.name)).not.toContain('revoke');
    await repo.startStep(claim, 'stop'); expect((await repo.completeStep(claim, 'stop', { stopped_verified: true })).steps[1]?.status).toBe('succeeded');
  });
  it('seals a single logical identity twice by placement and requires the exact selected step receipts', async () => {
    const { repo, claim, result } = await prepared();
    expect(result.fenced_targets).toEqual([{ resource: 'agent', tenant_id: 'Steven', alias: 'relocation_agent' }]);
    expect(result.operation.steps.map(step => step.name)).toEqual(['prepare', 'stop', 'revoke', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission']);
    const slices = await repo.hostSlices(claim); const source = slices.find(slice => slice.placement_role === 'source');
    const destination = slices.find(slice => slice.placement_role === 'destination'); if (!source || !destination) throw new Error('Roles absent');
    expect(source.agents[0]).toMatchObject({ host_id: sourceHost, enabled: true });
    expect(destination.agents[0]).toMatchObject({ host_id: destinationHost, enabled: false });
    await expect(repo.startStep(claim, 'credentials')).rejects.toMatchObject({ code: 'conflict' });
    await repo.startStep(claim, 'stop');
    await expect(repo.completeHostStep(claim, 'stop', destinationHost, destination.target_sha256, { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.completeStep(claim, 'stop', { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await complete(repo, claim, 'stop'); await expect(repo.startStep(claim, 'artifacts')).rejects.toMatchObject({ code: 'conflict' });
    await complete(repo, claim, 'revoke'); await complete(repo, claim, 'artifacts'); await repo.startStep(claim, 'credentials');
    await expect(repo.completeHostStep(claim, 'credentials', sourceHost, source.target_sha256,
      { certificate_fingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.completeHostStep(claim, 'credentials', destinationHost, source.target_sha256,
      { certificate_fingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('retains sealed source stop and revoke across epochs without repeating those steps', async () => {
    const { repo, claim } = await prepared(); await complete(repo, claim, 'stop'); await complete(repo, claim, 'revoke');
    await current.adminPool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.operation.id]);
    const retry = await repo.claim('relocation-retry', sourceHost); if (!retry) throw new Error('Retry absent');
    expect(retry.epoch).toBe(claim.epoch + 1); expect(await repo.hostReceipts(retry, 'revoke')).toEqual([]);
    expect((await repo.execution(retry)).operation.steps.filter(step => ['stop', 'revoke'].includes(step.name)).map(step => step.status)).toEqual(['succeeded', 'succeeded']);
    await complete(repo, retry, 'artifacts'); await repo.startStep(retry, 'credentials');
    const source = (await repo.hostSlices(retry)).find(slice => slice.placement_role === 'source'); if (!source) throw new Error('Source absent');
    await expect(repo.completeHostStep(claim, 'revoke', sourceHost, source.target_sha256, { revocation_verified: true })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('executes source stop, role-specific artifacts and destination-only auth with real local helper processes', async () => {
    const { repo, claim } = await prepared();
    sourceProcess = spawn(process.execPath, ['--eval', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    if (!sourceProcess.pid) throw new Error('Source process absent');
    await writeFile(join(directory, sourceHost, 'pid'), String(sourceProcess.pid));
    await writeFile(join(directory, sourceHost, 'authority'), 'Synthetic Cauce authority', { mode: 0o600 });
    const helper = join(directory, 'effect.py');
    await writeFile(helper, `import hashlib,json,os,signal,subprocess,sys,time
p=json.load(open(sys.argv[2]));x=json.load(sys.stdin);step=sys.argv[-1];role=x['fleet_scope']['placement_role'];host=x['fleet_scope']['host_id'];root=p['root']+'/'+host
assert host==p['host'];assert role in ('source','destination');assert all(a['host_id']==host for a in x['previous_agents'])
def stop():
 try:
  pid=int(open(root+'/pid').read());os.kill(pid,signal.SIGTERM)
  for _ in range(100):
   if not os.path.exists('/proc/'+str(pid)):break
   time.sleep(.01)
  assert not os.path.exists('/proc/'+str(pid));os.unlink(root+'/pid')
 except FileNotFoundError:pass
proof={}
if step=='stop':assert role=='source';stop();proof={'stopped_verified':True}
elif step=='revoke':
 assert role=='source';os.unlink(root+'/authority');proof={'revocation_verified':True}
elif step=='artifacts':
 assert role!='source' or all(a['alias']!='relocation_agent' for a in x['snapshot']['agents'])
 body=json.dumps(x['snapshot'],sort_keys=True).encode();open(root+'/artifact','wb').write(body);proof={'artifact_sha256':hashlib.sha256(body).hexdigest()}
elif step=='credentials':
 assert role=='destination' and not os.path.exists(p['root']+'/relocation-source/authority')
 open(root+'/authority','w').write('Synthetic destination authority');proof={'certificate_fingerprint':'c'*64}
elif step=='runtime':
 assert role=='destination' and x['previous_agents']==[]
 child=subprocess.Popen([p['node'],'--eval','setInterval(()=>{},1000)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 open(root+'/pid','w').write(str(child.pid));proof={'runtime_digest':'d'*64}
elif step=='authenticate':assert role=='destination';print(json.dumps({'evidence':{},'awaiting_auth':True}));sys.exit(0)
elif step=='compensate':
 stop()
 if role=='destination':os.unlink(root+'/authority')
 else:assert not os.path.exists(p['root']+'/relocation-destination/authority')
 proof={'stopped_verified':True,'revocation_verified':True}
else:raise ValueError('Unsupported fixture effect')
print(json.dumps({'evidence':proof}))
`, { mode: 0o600 });
    const commands = new Map<string, HostCommandConfig>();
    for (const host of [sourceHost, destinationHost]) {
      const policy = join(directory, `${host}.json`); await writeFile(policy, JSON.stringify({ host, root: directory, node: process.execPath }), { mode: 0o600 });
      commands.set(host, { python: '/usr/bin/python3', executable: helper, policyFile: policy });
    }
    const command = (host: string) => { const value = commands.get(host); if (!value) throw new Error('Unregistered fixture host'); return value; };
    const coordinator = new FleetCoordinator(repo, {
      perform: (host, step, execution, signal) => performHostCommand(command(host), step, execution, signal),
      compensate: (host, execution, signal) => performHostCompensation(command(host), execution, signal),
    });
    const execution = async (): Promise<FleetExecution> => {
      const state = await repo.execution(claim);
      const agents = (await pool.query("SELECT * FROM agents WHERE alias='relocation_agent'")).rows;
      return { ...state, snapshot: { agents }, trusted_accounts: [] };
    };
    for (const step of ['stop', 'revoke', 'artifacts', 'credentials', 'runtime'] as const) {
      await repo.startStep(claim, step); const effect = await coordinator.perform(step, await execution(), new AbortController().signal, claim);
      await repo.completeStep(claim, step, effect.evidence);
    }
    expect(sourceProcess.exitCode !== null || sourceProcess.signalCode !== null).toBe(true);
    expect(await readFile(join(directory, sourceHost, 'project'), 'utf8')).toBe('Recoverable project contents');
    await repo.startStep(claim, 'authenticate');
    expect((await coordinator.perform('authenticate', await execution(), new AbortController().signal, claim)).awaiting_auth).toBe(true);
    const waiting = await repo.awaitAuth(claim); expect(waiting.status).toBe('awaiting_auth');
    const cancelled = await repo.cancel('Steven', 'relocation_operator', waiting.id, waiting.version, subject); expect(cancelled.status).toBe('cancelling');
    const cancellation = await repo.claim('relocation-cancel', sourceHost); if (!cancellation) throw new Error('Cancellation claim absent');
    const state = await repo.execution(cancellation); const evidence = await coordinator.compensate({ ...state, snapshot: { agents: [] } }, new AbortController().signal, cancellation);
    expect((await repo.compensate(cancellation, evidence)).status).toBe('cancelled');
    expect((await pool.query("SELECT host_id,enabled,lifecycle_state FROM agents WHERE alias='relocation_agent'")).rows[0])
      .toEqual({ host_id: destinationHost, enabled: false, lifecycle_state: 'failed' });
    expect(await readFile(join(directory, sourceHost, 'provider-profile'), 'utf8')).toBe('Synthetic local profile retained');
    expect((await pool.query("SELECT metadata->'host_receipt'->>'host_id' AS host FROM fleet_operation_events WHERE operation_id=$1 AND metadata->>'step'='compensate' ORDER BY id", [claim.operation.id])).rows)
      .toEqual([{ host: destinationHost }, { host: sourceHost }]);
  });
});
