import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction } from '@cauce/store';
import { startTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { createLegacyAdoptionProbe } from './legacy-adoption-probe.js';
import { HostLegacyAdoptionProbe } from './adoption-bridge-client.js';
import { startLegacyAdoptionBridge, type LegacyAdoptionBridgeOptions } from './adoption-bridge-server.js';

const target = { tenant_id: 'Steven', alias: 'bridge-proof' };
const facts = { source: 'measured', target, runtime_key: 'bridge-proof', harness_id: 'codex',
  placement: { host_id: 'fixture', mode: 'container', container_name: 'fixture-container', runtime_user: 'dev',
    home_directory: '/home/dev', state_directory: '/home/dev/state', systemd_user: 'stev' },
  primary_account_id: null, account_provider: null, account_binding_approved: false,
  physical_identity_sha256: 'a'.repeat(64), supervisor_fenced: true };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
async function locked(path: string): Promise<boolean> {
  const child = spawn('/usr/bin/python3', ['-B', '-c', 'import os,sys,fcntl; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', path]);
  child.stderr.resume(); const [code] = await once(child, 'exit') as [number | null]; return code !== 0;
}
async function fixture(response: unknown = facts, delay = 0, options: LegacyAdoptionBridgeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'adoption-bridge-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, 'guard'); const log = join(directory, 'log'); const policy = join(directory, 'policy.json');
  await writeFile(lock, '', { mode: 0o600 }); await writeFile(policy, JSON.stringify({ facts: response, lock, log, delay }), { mode: 0o600 });
  const script = join(directory, 'probe.py');
  await writeFile(script, `import sys,json,os,fcntl,time\np=json.load(open(sys.argv[sys.argv.index('--policy')+1]))\nf=None\ntry:\n for line in sys.stdin:\n  r=json.loads(line)\n  with open(p['log'],'a') as log: log.write(r['action']+'\\n')\n  if r['action']=='acquire':\n   f=os.open(p['lock'],os.O_RDWR)\n   fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n  if r['action']=='measure': time.sleep(p['delay']/1000)\n  if r['action']=='release':\n   os.close(f)\n   f=None\n  print(json.dumps({'id':r['id'],'ok':True,**({'facts':p['facts']} if r['action']=='measure' else {})}),flush=True)\n  if r['action']=='release': break\nfinally:\n if f is not None: os.close(f)\n`);
  const probe = createLegacyAdoptionProbe([{ hostId: 'fixture', targets: [target], python: '/usr/bin/python3',
    executable: script, policyFile: policy, timeoutMs: 2000 }]);
  const socketPath = join(directory, 'bridge.sock'); const socketPolicy = { ownerUid: process.geteuid?.() ?? 0 };
  const app = await startLegacyAdoptionBridge(socketPath, probe, socketPolicy, options); cleanup.push(() => app.close());
  return { directory, lock, log, probe, app, socketPath, socketPolicy, client: new HostLegacyAdoptionProbe(socketPath, socketPolicy) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function rawClient(path: string) {
  const socket = new WebSocket('ws://localhost/adoption', { createConnection: () => connect(path), perMessageDeflate: false });
  await once(socket, 'open'); cleanup.push(async () => { socket.terminate(); }); return socket;
}
function disconnect(f: Awaited<ReturnType<typeof fixture>>) { for (const socket of f.app.websocketServer.clients) socket.terminate(); }
describe('private legacy adoption bridge with a real local flock', () => {
  it('connects the real Python worker socket and OFD fence through the private Unix bridge', async () => {
    const cwd = resolve(import.meta.dirname, '../../../..');
    const source = `import sys,json\nfrom ops.tests.test_fleet_legacy_supervisor_fence import LegacySupervisorFenceTests\nt=LegacySupervisorFenceTests()\nt.setUp()\ntry:\n print(json.dumps({'policy':str(t.policy),'control':str(t.control)}),flush=True)\n sys.stdin.readline()\nfinally: t.tearDown()\n`;
    const child = spawn('/usr/bin/python3', ['-B', '-c', source], { cwd, stdio: ['pipe', 'pipe', 'pipe'] }); child.stderr.resume();
    try {
      const [chunk] = await once(child.stdout, 'data') as [Buffer];
      const details = JSON.parse(chunk.toString('utf8')) as { policy: string; control: string };
      const physicalTarget = { tenant_id: 'acme', alias: 'iza' };
      const probe = createLegacyAdoptionProbe([{ hostId: 'local', targets: [physicalTarget], python: '/usr/bin/python3',
        executable: join(cwd, 'ops/cli/fleet-adoption-probe.py'), policyFile: details.policy, timeoutMs: 5000 }]);
      const directory = await mkdtemp(join(tmpdir(), 'bridge-ofd-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, 'bridge.sock'); const policy = { ownerUid: process.geteuid?.() ?? 0 };
      const app = await startLegacyAdoptionBridge(path, probe, policy); cleanup.push(() => app.close());
      const guard = join(details.control, 'cauce-v3-adoption.guard');
      await new HostLegacyAdoptionProbe(path, policy).withSupervisorFence([physicalTarget], async fence => {
        expect(await fence.measure(physicalTarget)).toMatchObject({ source: 'measured', supervisor_fenced: true, primary_account_id: null });
        expect(await locked(guard)).toBe(true); await fence.assertHeld();
      });
      expect(await locked(guard)).toBe(false);
    } finally { child.stdin.end('\n'); await once(child, 'exit'); }
  }, 15_000);
  it('retains the physical lock through the remote callback and releases only after it returns', async () => {
    const f = await fixture();
    const result = await f.client.withSupervisorFence([target], async fence => {
      expect(await locked(f.lock)).toBe(true); expect(await fence.measure(target)).toEqual(facts);
      await fence.assertHeld(); expect(await readFile(f.log, 'utf8')).not.toContain('release');
      return 17;
    });
    expect(result).toBe(17); expect(await locked(f.lock)).toBe(false);
  });
});

describe('legacy adoption bridge protocol and cleanup', () => {
  it('serializes concurrent measurements without overlapping the physical probe RPCs', async () => {
    const f = await fixture();
    await f.client.withSupervisorFence([target], async fence => {
      const measured = await Promise.all([fence.measure(target), fence.measure(target), fence.assertHeld()]);
      expect(measured.slice(0, 2)).toEqual([facts, facts]);
    });
    expect(await locked(f.lock)).toBe(false);
  });
  it('preserves a callback failure and releases the physical lock', async () => {
    const f = await fixture(); const error = new Error('transaction failed');
    await expect(f.client.withSupervisorFence([target], async () => { throw error; })).rejects.toBe(error);
    expect(await locked(f.lock)).toBe(false);
  });
  it('does not complete the callback early when its channel is lost', async () => {
    const release = deferred(); const admitted = deferred(); const drain = deferred();
    const f = await fixture(facts, 0, { drain: () => drain.promise }); let completed = false;
    const operation = f.client.withSupervisorFence([target], async () => { admitted.resolve(); await release.promise; return 3; });
    const observed = operation.then(() => { completed = true; }, () => { completed = true; });
    await admitted.promise; disconnect(f); await expect.poll(() => f.app.websocketServer.clients.size).toBe(0);
    expect(completed).toBe(false); expect(await locked(f.lock)).toBe(true);
    release.resolve(); await expect(operation).rejects.toMatchObject({ code: 'unavailable' }); await observed;
    expect(await locked(f.lock)).toBe(true); drain.resolve(); await expect.poll(() => locked(f.lock)).toBe(false);
  });
  it('waits for drain during server shutdown instead of releasing a live fence', async () => {
    const release = deferred(); const admitted = deferred(); const drained = deferred(); const draining = deferred();
    const f = await fixture(facts, 0, { drain: async () => { draining.resolve(); await drained.promise; } });
    const operation = f.client.withSupervisorFence([target], async () => { admitted.resolve(); await release.promise; });
    const failure = expect(operation).rejects.toMatchObject({ code: 'unavailable' });
    await admitted.promise; let closed = false; const closing = f.app.close().then(() => { closed = true; });
    await draining.promise; expect(await locked(f.lock)).toBe(true); expect(closed).toBe(false);
    release.resolve(); await failure; drained.resolve(); await closing; expect(await locked(f.lock)).toBe(false);
  });
  it('retries a failed drain while keeping the fence held', async () => {
    const failed = deferred(); const finish = deferred(); let calls = 0;
    const f = await fixture(facts, 0, { drain: async () => { calls += 1; if (calls === 1) { failed.resolve(); throw new Error('PG unavailable'); } await finish.promise; } });
    const socket = await rawClient(f.socketPath); const acquired = once(socket, 'message');
    socket.send(JSON.stringify({ version: 1, id: 0, action: 'acquire', targets: [target] })); await acquired;
    socket.terminate(); await failed.promise; expect(await locked(f.lock)).toBe(true);
    await expect.poll(() => calls).toBe(2); finish.resolve(); await expect.poll(() => locked(f.lock)).toBe(false);
  });
  it.each([
    { ...facts, private_secret: 'must-not-be-returned' },
    { ...facts, target: { ...target, alias: 'foreign' } },
    { ...facts, primary_account_id: null, account_provider: 'codex' },
  ])('rejects mismatched or private measured facts %#', async invalid => {
    const f = await fixture(invalid);
    await expect(f.client.withSupervisorFence([target], fence => fence.measure(target))).rejects.toBeInstanceOf(Error);
    await expect.poll(() => locked(f.lock)).toBe(false);
  });
  it('rejects a measurement outside the acquired target scope', async () => {
    const f = await fixture();
    await expect(f.client.withSupervisorFence([target], fence => fence.measure({ ...target, alias: 'foreign' }))).rejects.toMatchObject({ code: 'unavailable' });
    expect(await locked(f.lock)).toBe(false);
  });
  it.each(['duplicate', 'out-of-order', 'binary', 'extra-after-release'])('invalidates %s protocol packets', async kind => {
    const f = await fixture(); const socket = await rawClient(f.socketPath); const acquired = once(socket, 'message');
    socket.send(JSON.stringify({ version: 1, id: 0, action: 'acquire', targets: [target] })); await acquired;
    const closed = once(socket, 'close');
    if (kind === 'extra-after-release') socket.send(JSON.stringify({ version: 1, id: 1, action: 'release' }));
    socket.send(JSON.stringify({ version: 1, id: kind === 'out-of-order' ? 2 : kind === 'duplicate' ? 0 : 1, action: 'assertHeld' }), { binary: kind === 'binary' });
    await closed; await expect.poll(() => locked(f.lock)).toBe(false);
  });
  it('fails a stalled RPC and waits for physical cleanup', async () => {
    const f = await fixture(facts, 200); const client = new HostLegacyAdoptionProbe(f.socketPath, f.socketPolicy, { rpcTimeoutMs: 80 });
    await expect(client.withSupervisorFence([target], fence => fence.measure(target))).rejects.toMatchObject({ code: 'unavailable' });
    await expect.poll(() => locked(f.lock)).toBe(false);
  });
  it('refuses sockets whose directory or socket permits unrelated users', async () => {
    const f = await fixture(); await chmod(f.socketPath, 0o666);
    await expect(f.client.withSupervisorFence([target], async () => 1)).rejects.toMatchObject({ code: 'unavailable' });
    await chmod(f.socketPath, 0o660); await chmod(f.directory, 0o777);
    await expect(f.client.withSupervisorFence([target], async () => 1)).rejects.toMatchObject({ code: 'unavailable' });
    await chmod(f.directory, 0o700);
  });
});
describe('legacy adoption PostgreSQL transaction drain', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await startTestDatabase(); await database.pool.query('CREATE TABLE bridge_commit_proof (outcome text)'); });
  afterAll(async () => { await database.pool.end(); await database.container.stop(); });
  it.each(['COMMIT', 'ROLLBACK'])('retains its real flock until PostgreSQL %s after channel loss', async outcome => {
    const pool = createPool(database.url, { max: 1 }); const drainPool = createPool(database.url, { max: 1 });
    cleanup.push(() => pool.end()); cleanup.push(() => drainPool.end());
    const entered = deferred(); const proceed = deferred(); const draining = deferred();
    const f = await fixture(facts, 0, { drain: async () => {
      draining.resolve(); await withTransaction(drainPool, async client => { await client.query('SELECT pg_advisory_xact_lock(783003004)'); });
    } });
    const operation = f.client.withSupervisorFence([target], fence => withTransaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(783003004)');
      await client.query('INSERT INTO bridge_commit_proof(outcome) VALUES($1)', [outcome]);
      await fence.assertHeld(); entered.resolve(); await proceed.promise;
      if (outcome === 'ROLLBACK') await fence.assertHeld();
      return 'committed';
    }));
    const failure = expect(operation).rejects.toMatchObject({ code: 'unavailable' });
    await entered.promise; disconnect(f); await draining.promise;
    expect(await locked(f.lock)).toBe(true);
    expect((await database.pool.query('SELECT * FROM bridge_commit_proof WHERE outcome=$1', [outcome])).rows).toHaveLength(0);
    proceed.resolve(); await failure; await expect.poll(() => locked(f.lock)).toBe(false);
    expect((await database.pool.query('SELECT * FROM bridge_commit_proof WHERE outcome=$1', [outcome])).rows).toHaveLength(outcome === 'COMMIT' ? 1 : 0);
  });
});
