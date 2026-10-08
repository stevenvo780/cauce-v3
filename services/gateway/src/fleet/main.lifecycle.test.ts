import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import type { FleetSshTransport } from './host-transport.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';

const execute = promisify(execFile); const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const projectRoot = resolve(import.meta.dirname, '../../../..');
let database: TestDatabase; let current: EmptyTestDatabase; let pool: DatabasePool;
let directory: string; let path: string; let daemon: ChildProcess; let transport: FleetSshTransport;
let host: ChildProcess | undefined; let diagnostic: string; let authBridge: Awaited<ReturnType<typeof startAuthBridge>> | undefined;
async function contents(filename: string): Promise<string> { try { return await readFile(filename, 'utf8'); } catch { return ''; } }
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
  try { await exited; } finally { clearTimeout(timeout); }
}
beforeAll(async () => {
  database = await startTestDatabase(); directory = await mkdtemp(join(userInfo().homedir, '.cauce-main-lifecycle-'));
  const server = createServer(); await new Promise<void>(done => { server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture port absent');
  const port = address.port; await new Promise<void>((done, fail) => { server.close(error => { if (error) fail(error); else done(); }); });
  for (const name of ['server-key', 'client-key']) await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
  await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
  const settings = `Port ${String(port)}\nListenAddress 127.0.0.1\nHostKey ${join(directory, 'server-key')}\nPidFile ${join(directory, 'sshd.pid')}\nAuthorizedKeysFile ${join(directory, 'authorized_keys')}\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin prohibit-password\nAllowUsers ${userInfo().username}\nAllowStreamLocalForwarding yes\nStreamLocalBindMask 0177\nStreamLocalBindUnlink no\nLogLevel ERROR\n`;
  await writeFile(join(directory, 'sshd.conf'), settings, { mode: 0o600 });
  daemon = spawn('/usr/bin/sshd', ['-D', '-f', join(directory, 'sshd.conf')], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const listening = await new Promise<boolean>(done => {
      const socket = connect(port, '127.0.0.1'); socket.once('error', () => { socket.destroy(); done(false); });
      socket.once('connect', () => { socket.destroy(); done(true); });
    });
    if (listening) break; if (attempt === 99 || daemon.exitCode !== null) throw new Error('fixture SSH did not listen'); await delay(20);
  }
  const key = (await readFile(join(directory, 'server-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  const known = `[127.0.0.1]:${String(port)} ${key}\n`; await writeFile(join(directory, 'known_hosts'), known, { mode: 0o600 });
  transport = { executable: '/usr/bin/ssh', executable_sha256: hash(await readFile('/usr/bin/ssh')),
    destination: `${userInfo().username}@127.0.0.1`, port, known_hosts_file: join(directory, 'known_hosts'), known_hosts_sha256: hash(known),
    identity_file: join(directory, 'client-key'), identity_sha256: hash(await readFile(join(directory, 'client-key'))) };
});
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool; diagnostic = ''; host = undefined;
  path = await mkdtemp(join(directory, 'case-'));
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('lifecycle-control','Steven'),('lifecycle-group','Isa'),('lifecycle-empty','Isa')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','lifecycle-control','lifecycle_operator','operator')");
  for (const suffix of ['a', 'b']) {
    const alias = `lifecycle_${suffix}`; const runtime = `lifecycle-${suffix}`;
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Isa','lifecycle-group',$1,'agent')", [alias]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
      runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
      VALUES('Isa',$1,$2,'codex',$3,'container',$2,'dev','/home/dev','/home/dev/'||$2,'stev','lifecycle-group','ready',true)`, [alias, runtime, `host-${suffix}`]);
    await writeFile(join(path, `${alias}.running`), 'running', { mode: 0o600 });
    await writeFile(join(path, `${alias}.credential`), 'fixture authority', { mode: 0o600 });
  }
});
afterEach(async () => { await stop(host); await authBridge?.close(); authBridge = undefined; await current.close(); await rm(path, { recursive: true, force: true }); });
afterAll(async () => { await stop(daemon); await database.pool.end(); await database.container.stop(); await rm(directory, { recursive: true, force: true }); });
function repository() { return new FleetOperationsRepository(pool, { controllerHost: 'host-a', coordinatorEnabled: true, coordinatorHosts: ['host-a', 'host-b'] }); }
async function enqueue(room = 'lifecycle-group') {
  const revision = (await pool.query<{ revision: string }>('SELECT COALESCE(MAX(id),0)::text AS revision FROM config_revisions')).rows[0]?.revision;
  return repository().enqueue('Steven', 'lifecycle_operator', { kind: 'retire', target: { resource: 'room', tenant_id: 'Isa', room_id: room },
    parameters: {}, expected_revision: Number(revision), idempotency_key: `main-${room}` });
}
async function launch(blocked = false): Promise<ChildProcess> {
  const executable = join(path, 'executor.py'); const log = join(path, 'effect.jsonl');
  const script = `import hashlib,json,os,signal,sys,time\np=json.load(open(sys.argv[2]));x=json.load(sys.stdin);step=sys.argv[-1];scope=x['fleet_scope'];assert scope['host_id']==p['host']\nassert all(a['host_id']==p['host'] for a in x['previous_agents'])\ndef abort(s,f):\n open(p['root']+'/aborted','w').write(str(os.getpid()))\n sys.exit(0)\nsignal.signal(signal.SIGTERM,abort)\nif step=='stop' and p['blocked']:\n open(p['root']+'/pending','w').write(str(os.getpid()))\n while not os.path.exists(p['root']+'/continue'): time.sleep(.02)\nproof={}\nif step in ('stop','revoke'):\n suffix='running' if step=='stop' else 'credential'\n for a in x['previous_agents']:\n  file=p['root']+'/'+a['alias']+'.'+suffix\n  if os.path.exists(file): os.unlink(file)\n assert all(not os.path.exists(p['root']+'/'+a['alias']+'.'+suffix) for a in x['previous_agents'])\n proof={'stopped_verified' if step=='stop' else 'revocation_verified':True}\nif step=='artifacts':\n body=json.dumps(x['snapshot'],sort_keys=True).encode();digest=hashlib.sha256(body).hexdigest()\n open(p['root']+'/'+p['host']+'.artifact','wb').write(body);proof={'artifact_sha256':digest}\nwith open(p['log'],'a') as log: log.write(json.dumps({'host':p['host'],'step':step,'operation':x['operation_id'],'aliases':[a['alias'] for a in x['previous_agents']],'evidence':proof})+'\\n')\nprint(json.dumps({'evidence':proof}))\n`;
  await writeFile(executable, script, { mode: 0o600 });
  for (const suffix of ['a', 'b']) await writeFile(join(path, `policy-${suffix}.json`), JSON.stringify({ host: `host-${suffix}`, root: path, log, blocked: blocked && suffix === 'a' }), { mode: 0o600 });
  const central = join(path, 'central'); const remote = join(path, 'remote'); await mkdir(central, { mode: 0o700 }); await mkdir(remote, { mode: 0o700 });
  await chmod(central, 0o2750); await chown(central, process.geteuid?.() ?? 0, 1000);
  const remoteSocket = join(remote, 'auth.sock');
  const manager = new ProviderAuthManager({ authorize: async () => { throw new Error('fixture denies provider actions'); },
    audit: async () => undefined, reserve: async () => { throw new Error('fixture denies provider reservations'); } });
  authBridge = await startAuthBridge(remoteSocket, manager, { ownerUid: process.geteuid?.() ?? 0, groupGid: 1000 });
  const command = (suffix: string) => ({ python: '/usr/bin/python3', executable, policyFile: join(path, `policy-${suffix}.json`), timeoutMs: 30_000 });
  const controller = { version: 1, controller_host: 'host-a', hosts: [{ host_id: 'host-a', command: command('a') },
    { host_id: 'host-b', command: { ...command('b'), transport }, auth_socket: join(central, 'auth.sock'), auth_remote_socket: remoteSocket }] };
  const controllerFile = join(path, 'controller.json'); const databaseFile = join(path, 'database-url');
  await writeFile(controllerFile, JSON.stringify(controller), { mode: 0o600 }); await writeFile(databaseFile, current.url, { mode: 0o600 });
  const entry = `import(${JSON.stringify(pathToFileURL(join(projectRoot, 'services/gateway/src/fleet/main.ts')).href)}).then(({runFleetHost}) => runFleetHost()).catch(error => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : 'fixture startup failed'); process.exitCode = 1; });`;
  host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', entry], { cwd: projectRoot,
    stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userInfo().homedir,
      CAUCE_FLEET_PROJECT_ROOT: projectRoot, CAUCE_FLEET_DATABASE_URL_FILE: databaseFile, CAUCE_FLEET_HOST: 'host-a',
      CAUCE_FLEET_WORKER_ID: 'lifecycle-real-worker', CAUCE_FLEET_PYTHON: '/usr/bin/python3', CAUCE_FLEET_EXECUTABLE: executable,
      CAUCE_FLEET_POLICY_FILE: join(path, 'policy-a.json'), CAUCE_FLEET_CONTROLLER_FILE: controllerFile,
      CAUCE_FLEET_POLL_MS: '25', CAUCE_FLEET_LEASE_MS: '5000' } });
  host.stderr?.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); }); return host;
}
async function row(id: string) { return (await pool.query<{ status: string; applied_revision: string | null; worker_id: string | null }>(
  'SELECT status,applied_revision,worker_id FROM fleet_operations WHERE id=$1', [id])).rows[0]; }
async function effects(): Promise<{ host: string; step: string; aliases: string[]; evidence: Record<string, unknown> }[]> {
  return (await contents(join(path, 'effect.jsonl'))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { host: string; step: string; aliases: string[]; evidence: Record<string, unknown> });
}
describe('real runFleetHost subprocess lifecycle with PostgreSQL and pinned private SSH fixtures', () => {
  it('retires a two-host group only after measured CLI effects and durable per-host receipts settle', async () => {
    const operation = await enqueue(); const child = await launch();
    await expect.poll(async () => { if (child.exitCode !== null) throw new Error(diagnostic || 'worker exited'); return (await row(operation.id))?.status; }, { timeout: 15_000 }).toBe('succeeded');
    expect(await row(operation.id)).toMatchObject({ status: 'succeeded', worker_id: null });
    const records = await effects(); expect(records.map(value => `${value.step}:${value.host}`)).toEqual(['stop:host-a', 'stop:host-b', 'revoke:host-a', 'revoke:host-b', 'artifacts:host-a', 'artifacts:host-b']);
    for (const value of records) expect(value.aliases).toEqual([value.host === 'host-a' ? 'lifecycle_a' : 'lifecycle_b']);
    const receipts = (await pool.query<{ host: string; step: string; evidence: Record<string, unknown> }>(`SELECT metadata->'host_receipt'->>'host_id' AS host,
      metadata->'host_receipt'->>'step' AS step,metadata->'host_receipt'->'evidence' AS evidence FROM fleet_operation_events
      WHERE operation_id=$1 AND metadata ? 'host_receipt' ORDER BY id`, [operation.id])).rows;
    expect(receipts).toHaveLength(6); expect(receipts.map(value => value.evidence)).toEqual(records.map(value => value.evidence));
    const prepared = (await pool.query<{ slices: { host_id: string; targets: { alias: string }[] }[] }>("SELECT metadata->'host_slices' AS slices FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'host_slices'", [operation.id])).rows[0];
    expect(prepared?.slices.map(slice => [slice.host_id, slice.targets.map(target => target.alias)])).toEqual([['host-a', ['lifecycle_a']], ['host-b', ['lifecycle_b']]]);
    expect((await pool.query("SELECT enabled,retired_at IS NOT NULL AS retired FROM rooms WHERE id='lifecycle-group'")).rows[0]).toEqual({ enabled: false, retired: true });
    expect((await pool.query("SELECT alias,enabled,lifecycle_state FROM agents WHERE tenant_id='Isa' ORDER BY alias")).rows)
      .toEqual([{ alias: 'lifecycle_a', enabled: false, lifecycle_state: 'draft' }, { alias: 'lifecycle_b', enabled: false, lifecycle_state: 'draft' }]);
    expect((await row(operation.id))?.applied_revision).not.toBeNull();
    for (const alias of ['lifecycle_a', 'lifecycle_b']) { expect(await contents(join(path, `${alias}.running`))).toBe(''); expect(await contents(join(path, `${alias}.credential`))).toBe(''); }
    const artifact = await contents(join(path, 'host-a.artifact')); expect(artifact).toContain('agents');
    expect(artifact).toBe(await contents(join(path, 'host-b.artifact')));
    for (const receipt of receipts.filter(value => value.step === 'artifacts')) expect(receipt.evidence.artifact_sha256).toBe(hash(artifact));
    await stop(child); expect(child.exitCode).toBe(0); expect(diagnostic).toBe('');
  });
  it.each(['SIGTERM', 'SSH channel loss'])('aborts a pending measured effect on %s without a success receipt or another claim', async reason => {
    const operation = await enqueue(); const child = await launch(true);
    await expect.poll(() => contents(join(path, 'pending')), { timeout: 15_000 }).not.toBe('');
    const exited = once(child, 'exit');
    if (reason === 'SIGTERM') child.kill('SIGTERM');
    else {
      if (!child.pid) throw new Error('fixture worker pid absent');
      const { stdout } = await execute('/usr/bin/ps', ['--ppid', String(child.pid), '-o', 'pid=,args=']);
      const forward = stdout.split('\n').find(line => line.includes('/usr/bin/ssh') && line.includes(' -N '));
      if (!forward) throw new Error('private SSH forward pid absent'); process.kill(Number(forward.trim().split(/\s+/u)[0]), 'SIGTERM');
    }
    await exited; expect(child.exitCode).toBe(0); expect(await contents(join(path, 'aborted'))).not.toBe('');
    expect(await row(operation.id)).toMatchObject({ status: 'running', applied_revision: null });
    expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND metadata->>'step'='stop' AND metadata ? 'host_receipt'", [operation.id])).rowCount).toBe(0);
    expect(await contents(join(path, 'lifecycle_a.running'))).toBe('running'); expect(await effects()).toEqual([]);
    const next = await enqueue('lifecycle-empty'); expect(await row(next.id)).toMatchObject({ status: 'queued', worker_id: null });
    expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND event='claimed'", [next.id])).rowCount).toBe(0);
    expect(diagnostic).toBe('');
  });
});
