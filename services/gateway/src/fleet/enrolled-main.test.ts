import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runEnrolledFleetHost } from './enrolled-main.js';
import { HostCapabilitiesSchema } from './host-channel.capabilities.js';
import { readFleetHostConfig } from './main.js';
import { boundedProviderReceipt } from './provider-login.js';
import { SignedHostChannel } from './signed-source.js';
import { invokeSpaceBackupProcess, streamSpaceBackupHelper } from './space-backup.process.js';

const auxiliary = vi.hoisted(() => ({ enabled: false }));
vi.mock('./worker.js', () => ({ FleetHostWorker: class {
  constructor(_source: unknown, private readonly options: { runQuotaOnce(signal: AbortSignal): Promise<boolean> }) {}
  async start() { if (auxiliary.enabled) await this.options.runQuotaOnce(new AbortController().signal); }
  async shutdown() { await Promise.resolve(); }
} }));
vi.mock('./provider-login.js', async importOriginal => ({
  ...await importOriginal<typeof import('./provider-login.js')>(), boundedProviderReceipt: vi.fn(),
}));

let directory: string | undefined;
afterEach(async () => { auxiliary.enabled = false; vi.restoreAllMocks(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
const report = { resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'test',
  policy_sha256: 'a'.repeat(64), fleet_executor: false, quota_executor: true, templates: [],
  quota_providers: ['codex'], quota_provider_actions: { codex: ['query'] } };
const unavailable = { codex: { authenticate: 'operations.authenticate: command is unavailable' },
  grok: { query: 'operations.quota: command is unavailable' } };

it('lets the real backup helper outlive the fleet command budget with its own bounded deadline', async () => {
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-c171b-backup-budget-'));
  const scripts = join(directory, 'ops/cli'); await mkdir(scripts, { recursive: true, mode: 0o700 });
  const policy = join(directory, 'policy.json'); await writeFile(policy, '{}', { mode: 0o600 });
  await writeFile(join(scripts, 'space_backup_runtime.py'), `import json,pathlib,sys,time
request=json.load(sys.stdin)
if request['action']=='export':
 time.sleep(0.15)
 pathlib.Path(__file__).with_name('export-completed').write_text('completed')
 result={'bytes':1,'sha256':'b'*64,'manifest_sha256':'c'*64}
elif request['action']=='read': result={'offset':0,'data':'Wg=='}
else: result={'removed':True}
print(json.dumps(result))
`, { mode: 0o600 });
  await writeFile(join(scripts, 'space_backup_local.py'), `import json,sys
request=json.loads(sys.stdin.readline())
assert request['action']=='read' and request['offset']==0
print(json.dumps({'offset':0,'data':'Wg=='}),flush=True)
assert json.loads(sys.stdin.readline())=={'offset':1}
print(json.dumps({'done':True,'offset':1}),flush=True)
`, { mode: 0o600 });
  const claim = { id: 'ab000000-0000-4000-8000-000000000001', claim_token: 'ab000000-0000-4000-8000-000000000002', claim_epoch: 1,
    company_id: 'test-company', tenant_id: 'Test', alias: 'worker', host_id: 'test-host', policy_sha256: 'a'.repeat(64),
    agent_snapshot: { company_id: 'test-company', tenant_id: 'Test', alias: 'worker', runtime_key: 'worker', host_id: 'test-host', harness_id: 'codex',
      runtime_mode: 'native', container_name: 'host:test-host', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/state/worker', systemd_user: 'dev' } };
  const actions: string[] = [];
  const request = vi.fn(async (_method: string, path: string, payload: Record<string, unknown>) => {
    if (!path.endsWith('/space-backups')) return payload.action === 'claim' ? { claim: null } : {};
    actions.push(String(payload.action));
    if (payload.action === 'claim') return { claim }; if (payload.action === 'begin') return { offset: 0 };
    if (payload.action === 'append') return { offset: 1 }; if (payload.action === 'finish') return { ready: true }; return { failed: true };
  });
  vi.spyOn(SignedHostChannel, 'load').mockResolvedValue({ identity: { host_id: 'test-host', company_id: 'test-company' }, request } as unknown as SignedHostChannel);
  vi.mocked(boundedProviderReceipt).mockResolvedValue({ available: false, actions: [], placements: [] });
  const timers = vi.spyOn(globalThis, 'setTimeout'); auxiliary.enabled = true;
  const configured = readFleetHostConfig({ CAUCE_FLEET_PROJECT_ROOT: directory, CAUCE_FLEET_HOST: 'test-host', CAUCE_FLEET_WORKER_ID: 'test-worker',
    CAUCE_FLEET_PYTHON: '/usr/bin/python3', CAUCE_FLEET_EXECUTABLE: join(directory, 'executor.py'), CAUCE_FLEET_POLICY_FILE: policy,
    CAUCE_FLEET_IDENTITY_DIRECTORY: join(directory, 'identity'), CAUCE_FLEET_COMMAND_TIMEOUT_MS: '25' });
  const started = performance.now(); await runEnrolledFleetHost(configured);
  const completed = await readFile(join(scripts, 'export-completed'), 'utf8').then(value => value === 'completed', () => false);
  const backupTimers = timers.mock.calls.map(call => call[1]).filter(value => value === 1_800_000);
  console.info('BACKUP_ENROLLED_REAL_PROCESS_BUDGET', JSON.stringify({ fleet_command_ms: configured.command.timeoutMs,
    helper_sleep_ms: 150, elapsed_ms: performance.now() - started, helper_completed: completed, backup_timers: backupTimers, actions }));
  expect(actions).toEqual(['claim', 'begin', 'append', 'finish']); expect(completed).toBe(true); expect(backupTimers).toHaveLength(3);
});

it('kills a real helper at its explicit backup deadline and rejects an unbounded budget before spawning', async () => {
  const run = () => invokeSpaceBackupProcess('/usr/bin/python3', ['-c', 'import time; time.sleep(1)'], {}, new AbortController().signal, 25);
  await expect(run()).rejects.toThrow('exceeded its time or output limit');
  await expect(invokeSpaceBackupProcess('/usr/bin/python3', ['-c', 'raise SystemExit(99)'], {}, new AbortController().signal, 3_600_001))
    .rejects.toThrow('helper is unavailable');
});

it.each([
  ['premature completion', "print('{\"done\":true,\"offset\":1}',flush=True)", 'completion differs'],
  ['oversized unterminated frame', "sys.stdout.write('x'*(8*1024*1024+1));sys.stdout.flush()", 'frame exceeds'],
  ['trailing frame', "print('{\"offset\":0,\"data\":\"Wg==\"}',flush=True)\nsys.stdin.readline()\nprint('{\"done\":true,\"offset\":1}\\n{\"done\":true,\"offset\":1}',flush=True)", 'unexpected frame'],
  ['completion followed by failed exit', "print('{\"offset\":0,\"data\":\"Wg==\"}',flush=True)\nsys.stdin.readline()\nprint('{\"done\":true,\"offset\":1}',flush=True)\nsys.exit(7)", 'without a verified diagnostic'],
  ['truncated completion', "print('{\"offset\":0,\"data\":\"Wg==\"}',flush=True)\nsys.stdin.readline()\nsys.stdout.write('{\"done\":true');sys.stdout.flush()", 'without a verified receipt'],
  ['EOF without completion', "print('{\"offset\":0,\"data\":\"Wg==\"}',flush=True)\nsys.stdin.readline()", 'without a verified receipt'],
])('rejects a real persistent helper with %s', async (_label, script, error) => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-stream-'));
  const scripts = join(directory, 'ops/cli'); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'space_backup_local.py'), `import sys\nsys.stdin.readline()\n${script}\n`);
  await expect(streamSpaceBackupHelper({ python: '/usr/bin/python3', policyFile: join(directory, 'policy'), projectRoot: directory },
    { action: 'read', claim: {}, offset: 0 }, 1, new AbortController().signal, async () => 1)).rejects.toThrow(error);
});

it('waits for a real reader to observe cancellation and exit before rejecting', async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-stream-cancel-'));
  const scripts = join(directory, 'ops/cli'); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'space_backup_local.py'), `import json,pathlib,sys
sys.stdin.readline()
print('{"offset":0,"data":"Wg=="}',flush=True)
assert json.loads(sys.stdin.readline())=={'cancel':True}
pathlib.Path(__file__).with_name('cancel-observed').write_text('closed')
`);
  const abort = new AbortController();
  await expect(streamSpaceBackupHelper({ python: '/usr/bin/python3', policyFile: join(directory, 'policy'), projectRoot: directory },
    { action: 'read', claim: {}, offset: 0 }, 1, abort.signal, async () => { abort.abort(); return 1; })).rejects.toThrow('lease stopped');
  expect(await readFile(join(scripts, 'cancel-observed'), 'utf8')).toBe('closed');
});

it('reaps a real reader that ignores cancellation and TERM before rejecting', async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-stream-kill-'));
  const scripts = join(directory, 'ops/cli'); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'space_backup_local.py'), `import os,pathlib,signal,sys,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
pathlib.Path(__file__).with_name('pid').write_text(str(os.getpid()))
sys.stdin.readline()
print('{"offset":0,"data":"Wg=="}',flush=True)
time.sleep(60)
`);
  const abort=new AbortController();
  await expect(streamSpaceBackupHelper({python:'/usr/bin/python3',policyFile:join(directory,'policy'),projectRoot:directory},
    {action:'read',claim:{},offset:0},1,abort.signal,async()=>{abort.abort();return 1;})).rejects.toThrow('lease stopped');
  const pid=Number(await readFile(join(scripts,'pid'),'utf8'));
  expect(()=>process.kill(pid,0)).toThrow();
},20_000);

it('passes the same bounded Docker selection to export and persistent read helpers', async () => {
  directory=await mkdtemp(join(tmpdir(),'cauce-stream-environment-'));
  const scripts=join(directory,'ops/cli');await mkdir(scripts,{recursive:true});
  const keys=['DOCKER_CONTEXT','DOCKER_HOST','DOCKER_CONFIG'] as const;
  const expected=Object.fromEntries(keys.map(key=>[key,`fixture-${key.toLowerCase()}`]));
  for(const key of keys) vi.stubEnv(key,expected[key]);
  vi.stubEnv('CAUCE_BACKUP_UNRELATED_ENV','unavailable');
  try {
    const check=`import json,os,sys\nexpected=${JSON.stringify(expected)}\nassert all(os.environ.get(key)==value for key,value in expected.items())\nassert 'CAUCE_BACKUP_UNRELATED_ENV' not in os.environ\n`;
    await expect(invokeSpaceBackupProcess('/usr/bin/python3',['-c',`${check}print('{"verified":true}')`],{},new AbortController().signal)).resolves.toEqual({verified:true});
    await writeFile(join(scripts,'space_backup_local.py'),`${check}sys.stdin.readline()\nprint('{"offset":0,"data":"Wg=="}',flush=True)\nsys.stdin.readline()\nprint('{"done":true,"offset":1}',flush=True)\n`);
    await expect(streamSpaceBackupHelper({python:'/usr/bin/python3',policyFile:join(directory,'policy'),projectRoot:directory},
      {action:'read',claim:{},offset:0},1,new AbortController().signal,async()=>1)).resolves.toBeUndefined();
  } finally {vi.unstubAllEnvs();}
});

it('publishes unavailable quota actions from the executor receipt on the enrolled host channel', async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-capabilities-'));
  const policy = join(directory, 'policy.json'); await writeFile(policy, '{}', { mode: 0o600 });
  const request = vi.fn().mockResolvedValue({});
  vi.spyOn(SignedHostChannel, 'load').mockResolvedValue({ identity: { host_id: 'test-host' }, request } as unknown as SignedHostChannel);
  vi.mocked(boundedProviderReceipt).mockResolvedValue({ available: false, actions: [], placements: [],
    quota_environments: { providers: ['codex'], actions: { codex: ['query'] }, unavailable } });
  await runEnrolledFleetHost(readFleetHostConfig({ CAUCE_FLEET_PROJECT_ROOT: directory, CAUCE_FLEET_HOST: 'test-host',
    CAUCE_FLEET_WORKER_ID: 'test-worker', CAUCE_FLEET_PYTHON: '/usr/bin/python3',
    CAUCE_FLEET_EXECUTABLE: join(directory, 'executor.py'), CAUCE_FLEET_POLICY_FILE: policy,
    CAUCE_FLEET_IDENTITY_DIRECTORY: join(directory, 'identity') }));
  expect(request).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel',
    expect.objectContaining({ quota_provider_unavailable: unavailable, quota_provider_actions: { codex: ['query'] } }));
});

it('names what the enrolled provider auth policy rejects at startup and keeps the executor running', async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-enrolled-auth-'));
  const policy = join(directory, 'policy.json'); await writeFile(policy, '{}', { mode: 0o600 });
  const auth = join(directory, 'auth.json'); await writeFile(auth, JSON.stringify({ schemaVersion: 1, host_id: 'test-host' }), { mode: 0o600 });
  const request = vi.fn().mockResolvedValue({});
  vi.spyOn(SignedHostChannel, 'load').mockResolvedValue({ identity: { host_id: 'test-host' }, request } as unknown as SignedHostChannel);
  vi.mocked(boundedProviderReceipt).mockResolvedValue({ available: false, actions: [], placements: [] });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await runEnrolledFleetHost(readFleetHostConfig({ CAUCE_FLEET_PROJECT_ROOT: directory, CAUCE_FLEET_HOST: 'test-host',
    CAUCE_FLEET_WORKER_ID: 'test-worker', CAUCE_FLEET_PYTHON: '/usr/bin/python3',
    CAUCE_FLEET_EXECUTABLE: join(directory, 'executor.py'), CAUCE_FLEET_POLICY_FILE: policy,
    CAUCE_FLEET_IDENTITY_DIRECTORY: join(directory, 'identity'), CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE: auth }));
  expect(stderr).toHaveBeenCalledWith('Host provider authentication policy is unusable: auth policy rejects state_root, helper, profiles, logins\n');
  expect(request).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel', expect.objectContaining({ fleet_executor: false }));
});

it('accepts optional action reasons including a provider with no available actions', () => {
  expect(HostCapabilitiesSchema.parse({ ...report, quota_provider_unavailable: unavailable }).quota_provider_unavailable).toEqual(unavailable);
  expect(HostCapabilitiesSchema.parse(report).quota_provider_unavailable).toBeUndefined();
});

it.each([{ opencode: { query: 'missing' } }, { codex: { shell: 'missing' } }, { codex: { authenticate: '' } },
  { codex: { authenticate: 'x'.repeat(513) } }, { codex: { authenticate: 'invalid\nreason' } },
  { codex: { query: 'contradicts an available action' } }])('rejects malformed or contradictory quota reasons: %j', reasons => {
  expect(HostCapabilitiesSchema.safeParse({ ...report, quota_provider_unavailable: reasons }).success).toBe(false);
});
