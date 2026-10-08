import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, planFleetHostSlices, publicFleetOperation, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { FleetOperationRequestSchema } from '@cauce/protocol';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import type { ProviderAuthActor } from '../console/provider-auth.types.js';
import { createHostProviderAuthService } from './host-provider-auth.js';
import { type z } from 'zod';
import { OpenClawDriver } from './host-provider-openclaw.js';
import { boundedProviderReceipt } from './provider-login.js';
import { fleetHostPacket } from './coordinator.js';

interface LoginFixture { method: string; command: string[]; sha256: string; env?: Record<string, string>; files?: Record<string, string> }
const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let directory: string;
let actor: ProviderAuthActor;
let operationId: string;
let policy: { schemaVersion: number; host_id: string; state_root: string; helper: { executable: string; sha256: string };
  profiles: Record<string, { provider: string; path: string; identity: string; runtime_user: string; container_name?: string;
    command?: string; command_sha256?: string; command_files?: Record<string, string>; openclaw?: z.infer<typeof OpenClawDriver> }>;
  profile_templates?: { provider: string; runtime_user: string; path_root: string; command: string; command_sha256: string;
    command_files?: Record<string, string>; openclaw?: z.infer<typeof OpenClawDriver>; runtime_mode?: string; container_name?: string; container_prefix?: string; login?: LoginFixture }[];
  logins: Record<string, LoginFixture> };
let config: { hostConfig: { host: string; command: { python: string; executable: string; policyFile: string } }; authPolicyFile: string; projectRoot: string };
const createMemberships = [{ tenant_id: 'Steven', alias: 'physical-new', room_id: 'physical-hub', role: 'agent', enabled: true },
  { tenant_id: 'Steven', alias: 'other-agent', room_id: 'physical-hub', role: 'agent', enabled: true }];
let services: Awaited<ReturnType<typeof createHostProviderAuthService>>[];
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
async function fingerprint(filename: string): Promise<string> { return createHash('sha256').update(await readFile(filename)).digest('hex'); }
async function savePolicy(): Promise<void> { await writeFile(config.authPolicyFile, JSON.stringify(policy), { mode: 0o600 }); }
async function saveExecutorPolicy(): Promise<void> {
  await writeFile(config.hostConfig.command.policyFile, JSON.stringify({ schemaVersion: 1, host_id: policy.host_id, profiles: policy.profiles,
    ...(policy.profile_templates === undefined ? {} : { profile_templates: policy.profile_templates }) }), { mode: 0o600 });
}
async function service() { const value = await createHostProviderAuthService(pool, config); services.push(value); return value; }
async function trace(): Promise<string[]> { try { return (await readFile(join(directory, 'effects.log'), 'utf8')).trim().split('\n'); } catch { return []; } }
beforeEach(async ({ task }) => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  directory = await mkdtemp(join(tmpdir(), 'host-provider-auth-')); services = [];
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('physical-hub','Steven')");
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','physical-human')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','physical-hub','physical-human','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('physical@example.test','physical@example.test',$1,'Fixture','operator','Steven','physical-human') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('test human absent');
  actor = { tenant_id: 'Steven', alias: 'physical-human', subject: `console:${human.id}` };
  await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','physical-human','operator',ARRAY['read','control'])", [human.id]);
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('physical-account','codex','physical-identity','Steven','env_path','CAUCE_SYNTHETIC_TOKEN_PATH',true)`);
  const placementContainer = /placement container ([a-z-]+)/u.exec(task.name)?.[1];
  await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,container_name,runtime_user,home_directory,state_directory,host_id,runtime_mode,systemd_user,primary_account_id,lifecycle_state,enabled)
    VALUES('Steven','physical-new','physical-new',$3,$1,'dev','/home/dev','/home/dev/.cauce/physical-new','isolated',$2,'stev','physical-account','auth_pending',false)`,
  [...(placementContainer ? [placementContainer, 'container'] : task.name.includes('immutable container binding') ? ['physical-container', 'container'] : ['host:isolated', 'native']),
    task.name.includes('OpenClaw') ? 'openclaw' : 'codex']);
  operationId = randomUUID();
  const creation = task.name.includes('create host inputs');
  const target = { resource: 'agent', tenant_id: 'Steven', alias: 'physical-new' };
  const request = creation ? { kind: 'create', target, expected_revision: 0, idempotency_key: 'physical-operation',
    parameters: { runtime_key: 'physical-new', harness_id: 'codex', primary_room_id: 'physical-hub', memberships: [{ room_id: 'physical-hub', role: 'agent' }],
      primary_account_id: 'physical-account', placement: { host_id: 'isolated', mode: 'native', runtime_user: 'dev', home_directory: '/home/dev',
        state_directory: '/home/dev/.cauce/physical-new', systemd_user: 'stev' } } }
    : { kind: 'start', target, parameters: {}, expected_revision: 0, idempotency_key: 'physical-operation' };
  await pool.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,idempotency_key,expected_revision,status)
    VALUES($1,'Steven','physical-human',$2::jsonb,'agent:Steven:physical-new','isolated:dev',$5,$6,$3::jsonb,$4,'physical-operation',0,'awaiting_auth')`,
  [operationId, JSON.stringify(request.target), JSON.stringify(request), 'a'.repeat(64), task.name.includes('different controller') ? 'controller' : 'isolated', request.kind]);
  await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)", [operationId, JSON.stringify({ actor_subject: actor.subject })]);
  const previous = (await pool.query<{ agent: Record<string, unknown> }>("SELECT to_jsonb(agent) AS agent FROM agents agent WHERE alias='physical-new'")).rows[0]?.agent;
  await pool.query('UPDATE fleet_operations SET desired_revision=0 WHERE id=$1', [operationId]);
  const row = (await pool.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [operationId])).rows[0];
  if (!previous || !row) throw new Error('test sealed placement absent');
  await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_completed',$2::jsonb)",
    [operationId, JSON.stringify({ step: 'prepare', prepared_revision: 0, fenced_targets: creation ? [] : [request.target], previous_agents: creation ? [] : [previous],
      desired_memberships: creation ? createMemberships : [],
      ...(task.name.includes('absent host seal') ? {} : { host_slices: planFleetHostSlices(row, [previous], creation ? [] : [previous]) }) })]);
  const executable = join(directory, 'executor.py'); const helper = join(directory, 'login.py');
  const log = JSON.stringify(join(directory, 'effects.log'));
  await writeFile(executable, `import json,sys,pathlib,hashlib\np=json.loads(sys.stdin.read())\nif 'trusted_accounts' in p.get('snapshot',{}): sys.exit(2)\nif any('credential_ref' in a or 'credential_ref_kind' in a for a in p.get('trusted_accounts',[])): sys.exit(2)\npolicy=json.loads(pathlib.Path(sys.argv[sys.argv.index('--policy')+1]).read_text())\nif '--binding' in sys.argv:\n agent=next(a for a in p['snapshot']['agents'] if a['alias']==p['request']['target']['alias'])\n profile=policy['profiles'].get(agent['primary_account_id'])\n if profile is None:\n  account=next(a for a in p['trusted_accounts'] if a['id']==agent['primary_account_id'])\n  sys.path.insert(0,${JSON.stringify(join(projectRoot, 'ops/cli'))})\n  from fleet_executor_templates import resolved_template\n  template=resolved_template(policy,agent,account['provider'])\n  profile={'provider':template['provider'],'runtime_user':template['runtime_user'],'path':str(pathlib.Path(template['path_root'])/agent['runtime_key']/hashlib.sha256(account['id'].encode()).hexdigest()),'identity':account['external_account_id'],'command':template['command'],'command_sha256':template['command_sha256']}\n  if 'command_files' in template: profile['command_files']=template['command_files']\n  if 'openclaw' in template: profile['openclaw']=template['openclaw']\n  if agent['runtime_mode']=='container': profile['container_name']=agent['container_name']\n receipt={'agent':agent,'profile_binding':profile}\n marker=pathlib.Path(${JSON.stringify(directory)})/'container-binding.json'\n if marker.exists(): receipt['runtime_binding']=json.loads(marker.read_text())\n print(json.dumps(receipt))\nelse:\n step=sys.argv[sys.argv.index('--step')+1]\n with open(${log},'a') as f: f.write(step+'\\n')\n marker=pathlib.Path(${JSON.stringify(directory)})\n receipt={'evidence':{'stopped_verified':not (marker/'unverified-stop').exists()}} if step=='login-stop' else {'evidence':{'provider_verified':not (marker/'unverified-auth').exists()}}\n if step=='authenticate' and (marker/'awaiting-auth').exists(): receipt={'evidence':{},'awaiting_auth':True}\n print(json.dumps(receipt))\n`, { mode: 0o700 });
  await writeFile(helper, `import sys,json,os\nlog=${log}\nif '--cleanup' in sys.argv:\n with open(log,'a') as f: f.write('cleanup\\n')\n print(json.dumps({'stopped_verified':True}))\n sys.exit(0)\np=json.loads(sys.stdin.readline())\nexpected=${JSON.stringify(join(directory, 'profile'))}\nmarker=${JSON.stringify(join(directory, 'profile-path.expected'))}\nif os.path.exists(marker):\n with open(marker) as f: expected=f.read()\nif p['env'].get('CODEX_HOME')!=expected: sys.exit(2)\ncommand_marker=${JSON.stringify(join(directory, 'login-command.expected'))}\nif os.path.exists(command_marker):\n with open(command_marker) as f: command_expected=json.load(f)\n if [p['command'],p['command_sha256']]!=command_expected: sys.exit(2)\nwith open(log,'a') as f: f.write('login\\n')\nprint(json.dumps({'type':'started','operation_id':p['operation_id'],'pid':os.getpid(),'start_ticks':'100','runtime_uid':1000,'backend':p['backend'],**({'container_id':p['container_binding']['container_id']} if p['backend']=='container' else {})}),flush=True)\nfor line in sys.stdin:\n if json.loads(line)['type']=='close':\n  with open(log,'a') as f: f.write('login-close\\n')\n  print(json.dumps({'type':'exited','operation_id':p['operation_id'],'exit_code':0,'stopped_verified':True}),flush=True)\n  break\n`, { mode: 0o700 });
  policy = { schemaVersion: 1, host_id: 'isolated', state_root: directory, helper: { executable: helper, sha256: await fingerprint(helper) },
    profiles: { 'physical-account': { provider: 'codex', path: join(directory, 'profile'), identity: 'physical-identity', runtime_user: 'dev' } },
    logins: { codex: { method: 'device', command: ['/usr/bin/true'], sha256: await fingerprint('/usr/bin/true') } } };
  config = { hostConfig: { host: 'isolated', command: { python: '/usr/bin/python3', executable, policyFile: join(directory, 'executor-policy.json') } },
    authPolicyFile: join(directory, 'auth-policy.json'), projectRoot };
  await writeFile(config.hostConfig.command.policyFile, JSON.stringify({ schemaVersion: 1, host_id: 'isolated', profiles: policy.profiles }), { mode: 0o600 });
  await savePolicy();
});
afterEach(async () => { for (const value of services) await value.shutdown(); await pool.end(); await current?.close(); current = undefined; await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
async function configureOpenClaw(): Promise<void> {
  const profile = policy.profiles['physical-account']; if (!profile) throw new Error('profile absent');
  const command = join(directory, 'openclaw.mjs'); const bridge = join(directory, 'bridge.mjs');
  const authSource = join(directory, 'auth-list.js');
  await writeFile(command, 'export const cli = true;', { mode: 0o600 }); await writeFile(bridge, 'export const bridge = true;', { mode: 0o600 });
  await writeFile(authSource, await readFile(join(config.projectRoot, 'ops/tests/fixtures/openclaw-auth-list-2026.6.6.txt')), { mode: 0o600 });
  profile.command = command; profile.command_sha256 = await fingerprint(command);
  profile.openclaw = OpenClawDriver.parse({ provider_id: 'openai', method_id: 'device-code', version: '2026.6.6',
    auth_list_source: authSource, auth_list_sha256: await fingerprint(authSource), node_command: '/usr/bin/node',
    node_command_sha256: await fingerprint('/usr/bin/node'), bridge, bridge_sha256: await fingerprint(bridge) });
  policy.logins.openclaw = { method: 'device', command: ['/usr/bin/node', command, 'models', 'auth', 'login'],
    sha256: profile.openclaw.node_command_sha256, files: { [command]: profile.command_sha256 } };
  await savePolicy(); await saveExecutorPolicy();
}
describe('host provider authentication factory', () => {
  it.each(['container-one', 'container-two', 'approved-new'])('uses sealed placement container %s login and functional pins without public configuration', async name => {
    const one = '/usr/bin/true'; const two = '/usr/bin/false';
    policy.profiles = {}; policy.logins = {};
    policy.profile_templates = [
      { provider: 'codex', runtime_user: 'dev', runtime_mode: 'container', container_name: 'container-one',
        path_root: join(directory, 'one-accounts'), command: one, command_sha256: await fingerprint(one),
        login: { method: 'device', command: [one, 'login', '--device-auth'], sha256: await fingerprint(one) } },
      { provider: 'codex', runtime_user: 'dev', runtime_mode: 'container', container_name: 'container-two',
        path_root: join(directory, 'two-accounts'), command: two, command_sha256: await fingerprint(two),
        login: { method: 'terminal', command: [two, 'login'], sha256: await fingerprint(two) } },
      { provider: 'codex', runtime_user: 'dev', runtime_mode: 'container', container_prefix: 'approved-',
        path_root: join(directory, 'prefix-accounts'), command: one, command_sha256: await fingerprint(one),
        login: { method: 'device', command: [one, 'login', '--device-auth'], sha256: await fingerprint(one) } },
    ];
    const template = policy.profile_templates.find(row => row.container_name === name || row.container_prefix && name.startsWith(row.container_prefix));
    if (!template?.login) throw new Error('placement login absent');
    await savePolicy(); await saveExecutorPolicy();
    const expected = join(template.path_root, 'physical-new', createHash('sha256').update('physical-account').digest('hex'));
    await writeFile(join(directory, 'profile-path.expected'), expected);
    await writeFile(join(directory, 'login-command.expected'), JSON.stringify([template.login.command, template.login.sha256]));
    await writeFile(join(directory, 'container-binding.json'), JSON.stringify({ container_id: 'a'.repeat(64), generation: 'b'.repeat(64),
      image_digest: 'sha256:' + 'c'.repeat(64), python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' }));
    const value = await service(); const request = await value.resolve(actor, operationId);
    expect(JSON.stringify(request)).not.toContain(directory); expect(JSON.stringify(request)).not.toContain('login');
    const opened = await value.start(actor, request); expect(opened.status).toBe('awaiting_login');
    await value.attach(actor, opened.session_id, () => undefined);
    expect((await value.verify(actor, opened.session_id)).status).toBe('authenticated');
    expect(await trace()).toContain('login');
    const events = JSON.stringify((await pool.query('SELECT metadata FROM fleet_operation_events')).rows);
    expect(events).not.toContain(directory); expect(events).not.toContain('--device-auth');
    expect(events).not.toContain(template.login.sha256);
  });
  it('denies sealed placement container unapproved-new login and overlapping templates before effects', async () => {
    policy.profiles = {}; const command = '/usr/bin/true';
    const template = { provider: 'codex', runtime_user: 'dev', runtime_mode: 'container', container_prefix: 'approved-',
      path_root: join(directory, 'accounts'), command, command_sha256: await fingerprint(command),
      login: { method: 'device', command: [command, 'login', '--device-auth'], sha256: await fingerprint(command) } };
    policy.profile_templates = [template]; await savePolicy(); await saveExecutorPolicy();
    const value = await service(); await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const legacy: NonNullable<typeof policy.profile_templates>[number] = { ...template };
    delete legacy.runtime_mode; delete legacy.container_prefix;
    policy.profile_templates = [template, { ...template, container_prefix: 'unapproved-' }, legacy];
    await savePolicy(); await saveExecutorPolicy();
    await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const exact: NonNullable<typeof policy.profile_templates>[number] = { ...template, container_name: 'unapproved-new' };
    delete exact.container_prefix;
    policy.profile_templates = [{ ...template, container_prefix: 'unapproved-' }, exact];
    await savePolicy(); await saveExecutorPolicy();
    await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).toEqual([]);
  });
  it('selects native placement login and rejects its policy replacement before launch', async () => {
    const command = '/usr/bin/true'; const sha = await fingerprint(command);
    policy.profiles = {}; policy.logins = {};
    const template = { provider: 'codex', runtime_user: 'dev', runtime_mode: 'native', path_root: join(directory, 'accounts'),
      command, command_sha256: sha, login: { method: 'device', command: [command, 'login', '--device-auth'], sha256: sha } };
    policy.profile_templates = [{ ...template, runtime_mode: 'container', container_name: 'container-one', command: '/usr/bin/false',
      command_sha256: await fingerprint('/usr/bin/false'), login: { method: 'terminal', command: ['/usr/bin/false', 'login'], sha256: await fingerprint('/usr/bin/false') } }, template];
    await savePolicy(); await saveExecutorPolicy();
    const expected = join(directory, 'accounts', 'physical-new', createHash('sha256').update('physical-account').digest('hex'));
    await writeFile(join(directory, 'profile-path.expected'), expected);
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    expect(opened.status).toBe('awaiting_login');
    template.login = { method: 'terminal', command: [command, 'login'], sha256: sha };
    await savePolicy(); await saveExecutorPolicy();
    await expect(value.attach(actor, opened.session_id, () => undefined)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    expect(await trace()).not.toContain('login');
  });
  it('denies sealed placement container container-one static profile owned by another container before effects', async () => {
    const profile = policy.profiles['physical-account']; if (!profile) throw new Error('profile absent');
    profile.container_name = 'container-two'; await savePolicy(); await saveExecutorPolicy();
    const value = await service(); await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).toEqual([]);
  });
  it.each(['command', 'sha', 'argument', 'extra', 'selector'])('rejects invalid placement template login %s before effects', async mutation => {
    policy.profiles = {}; const command = '/usr/bin/true';
    const template = { provider: 'codex', runtime_user: 'dev', runtime_mode: 'native', path_root: join(directory, 'accounts'),
      command, command_sha256: await fingerprint(command), login: { method: 'device', command: [command, 'login', '--device-auth'], sha256: await fingerprint(command) } };
    const invalid: Record<string, unknown> = structuredClone(template);
    const login = invalid.login as Record<string, unknown>;
    if (mutation === 'command') login.command = ['/usr/bin/false', 'login', '--device-auth'];
    if (mutation === 'sha') login.sha256 = '0'.repeat(64);
    if (mutation === 'argument') login.command = [command, 'login', '--force'];
    if (mutation === 'extra') login.extra = 'unapproved';
    if (mutation === 'selector') invalid.container_name = 'container-one';
    policy.profile_templates = [invalid as typeof template]; await savePolicy(); await saveExecutorPolicy();
    await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' }); expect(await trace()).toEqual([]);
  });
  it('uses a sealed OpenClaw harness with a separate Codex economic provider and exact login projection', async () => {
    await configureOpenClaw();
    const helper = policy.helper.executable; let source = await readFile(helper, 'utf8');
    source = source.replace("if p['env'].get('CODEX_HOME')!=expected: sys.exit(2)",
      "if p['env'].get('OPENCLAW_HOME')!=expected or p['env'].get('CODEX_HOME')!=expected+'/.external-cli-disabled': sys.exit(2)\n" +
      "if p['command'][-6:]!=['--provider','openai','--method','device-code','--profile-id','cauce:physical-account']: sys.exit(2)\n" +
      "if p['env'].get('OPENCLAW_AGENT_DIR')!=expected+'/agents/physical-new/agent' or p['env'].get('CAUCE_OPENCLAW_LOCAL')!='1': sys.exit(2)");
    await writeFile(helper, source); policy.helper.sha256 = await fingerprint(helper); await savePolicy();
    const value = await service(); const request = await value.resolve(actor, operationId);
    expect(request.provider_id).toBe('codex'); expect(request.harness_id).toBe('openclaw');
    const opened = await value.start(actor, request); expect(opened.status).toBe('awaiting_login');
    await value.attach(actor, opened.session_id, () => undefined);
    expect(await trace()).toContain('login');
    expect((await value.cancel(actor, opened.session_id)).cleanup_pending).toBe(false);
  });
  it('refuses an OpenClaw login configured to overwrite existing profiles before the provider process opens', async () => {
    await configureOpenClaw(); const login = policy.logins.openclaw; if (!login) throw new Error('login absent');
    login.command.push('--force'); await savePolicy(); const value = await service();
    const result = await value.start(actor, await value.resolve(actor, operationId));
    expect(result.status).toBe('failed'); expect(await trace()).not.toContain('login');
  });
  it('refuses changed OpenClaw measured source pins', async () => {
    await configureOpenClaw();
    const profile = policy.profiles['physical-account']; if (!profile?.openclaw) throw new Error('driver absent');
    profile.openclaw.auth_list_sha256 = '0'.repeat(64) as typeof profile.openclaw.auth_list_sha256;
    await savePolicy(); await saveExecutorPolicy(); await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(await trace()).toEqual([]);
  });

  it('accepts a physical host sealed by a different controller and cleans up with a max1 pool', async () => {
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    expect(opened.status).toBe('awaiting_login');
    const cancelled = await value.cancel(actor, opened.session_id);
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.cleanup_pending).toBe(false); expect(pool.totalCount).toBe(1);
  });
  it('sends the executor the same create host inputs as the coordinator for login stop and cleanup', async () => {
    const row = (await pool.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [operationId])).rows[0];
    const agent = (await pool.query<{ agent: Record<string, unknown> }>("SELECT to_jsonb(agent) AS agent FROM agents agent WHERE alias='physical-new'")).rows[0]?.agent;
    if (!row || !agent) throw new Error('test create operation absent');
    const slices = planFleetHostSlices(row, [agent], []);
    const source = await readFile(config.hostConfig.command.executable, 'utf8');
    await writeFile(config.hostConfig.command.executable, source.replace('p=json.loads(sys.stdin.read())\n',
      `p=json.loads(sys.stdin.read())\nif '--step' in sys.argv:\n open(${JSON.stringify(join(directory, 'inputs.log'))},'a').write(json.dumps({'step':sys.argv[sys.argv.index('--step')+1],'inputs':{k:p[k] for k in ('fenced_targets','previous_agents','desired_memberships')}})+'\\n')\n`));
    const [slice] = slices; if (!slice) throw new Error('test host slice absent');
    const claim = { operation: publicFleetOperation(row), request: FleetOperationRequestSchema.parse(row.request), worker_id: 'worker', claim_token: 'token', epoch: 1 };
    const packet = fleetHostPacket({ operation: claim.operation, request: claim.request, fenced_targets: [], previous_agents: [], desired_memberships: createMemberships }, slice, claim);
    const expected = { fenced_targets: packet.fenced_targets, previous_agents: packet.previous_agents, desired_memberships: packet.desired_memberships };
    expect(expected).toEqual({ fenced_targets: [{ resource: 'agent', tenant_id: 'Steven', alias: 'physical-new' }], previous_agents: [], desired_memberships: [createMemberships[0]] });
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    expect(opened.status).toBe('awaiting_login');
    expect((await value.cancel(actor, opened.session_id)).cleanup_pending).toBe(false);
    const sent = (await readFile(join(directory, 'inputs.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { step: string; inputs: unknown });
    expect(sent.map(entry => entry.step)).toEqual(['login-stop', 'login-stop']);
    for (const entry of sent) expect(entry.inputs).toEqual(expected);
  });
  it('refuses an absent host seal before stopping or opening a provider process', async () => {
    const value = await service(); await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).toEqual([]);
  });
  it('resolves public account scope and proves login stopped before the functional provider call', async () => {
    const value = await service(); const request = await value.resolve(actor, operationId);
    expect(request.profile_id).toBe('physical-account'); expect(JSON.stringify(request)).not.toContain(directory);
    const opened = await value.start(actor, request); expect(opened.status).toBe('awaiting_login');
    await value.attach(actor, opened.session_id, () => undefined);
    const verified = await value.verify(actor, opened.session_id);
    expect(verified.status).toBe('authenticated'); expect(verified.cleanup_pending).toBe(false);
    const effects = await trace(); expect(effects.indexOf('login-close')).toBeLessThan(effects.indexOf('authenticate'));
    const events = (await pool.query('SELECT metadata FROM fleet_operation_events')).rows;
    expect(JSON.stringify(events)).not.toContain(directory);
  });
  it('rejects divergent auth and executor profiles before any physical effect', async () => {
    const profile = policy.profiles['physical-account']; if (!profile) throw new Error('profile absent'); profile.path += '-substitute'; await savePolicy();
    await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(await trace()).toEqual([]);
  });
  it('selects a new durable account through the approved template without exposing its path or identity publicly', async () => {
    policy.profiles = {}; policy.profile_templates = [{ provider: 'codex', runtime_user: 'dev', path_root: join(directory, 'accounts'),
      command: '/usr/bin/true', command_sha256: await fingerprint('/usr/bin/true'), command_files: {} }];
    await savePolicy(); await saveExecutorPolicy();
    const expected = join(directory, 'accounts', 'physical-new', createHash('sha256').update('physical-account').digest('hex'));
    await writeFile(join(directory, 'profile-path.expected'), expected);
    const value = await service(); const request = await value.resolve(actor, operationId);
    expect(request.profile_id).toBe('physical-account'); expect(JSON.stringify(request)).not.toContain(expected);
    const opened = await value.start(actor, request); expect(opened.status).toBe('awaiting_login');
    await value.attach(actor, opened.session_id, () => undefined);
    expect((await value.verify(actor, opened.session_id)).status).toBe('authenticated');
    expect(JSON.stringify((await pool.query('SELECT metadata FROM fleet_operation_events')).rows)).not.toContain(expected);
  });
  it('rejects differing, duplicated and missing provider/user templates before a dynamic login', async () => {
    policy.profiles = {}; const template = { provider: 'codex', runtime_user: 'dev', path_root: join(directory, 'accounts'),
      command: '/usr/bin/true', command_sha256: await fingerprint('/usr/bin/true') };
    policy.profile_templates = [template]; await saveExecutorPolicy();
    policy.profile_templates = [{ ...template, path_root: join(directory, 'substitute') }]; await savePolicy();
    await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    policy.profile_templates = [template, template]; await savePolicy(); await saveExecutorPolicy();
    await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    policy.profile_templates = [{ ...template, runtime_user: 'other' }]; await savePolicy(); await saveExecutorPolicy();
    const value = await service(); await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).toEqual([]);
  });
  it('rejects dynamic account identity or consent revocation before PTY launch', async () => {
    policy.profiles = {}; policy.profile_templates = [{ provider: 'codex', runtime_user: 'dev', path_root: join(directory, 'accounts'),
      command: '/usr/bin/true', command_sha256: await fingerprint('/usr/bin/true') }];
    await savePolicy(); await saveExecutorPolicy();
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    expect(opened.status).toBe('awaiting_login');
    await pool.query("UPDATE provider_accounts SET external_account_id='revoked-identity' WHERE id='physical-account'");
    await expect(value.attach(actor, opened.session_id, () => undefined)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    expect(await trace()).not.toContain('login');
    await pool.query("UPDATE provider_accounts SET enabled=false WHERE id='physical-account'");
    await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('never uses a template to replace a conflicting explicitly configured profile', async () => {
    const profile = policy.profiles['physical-account']; if (!profile) throw new Error('profile absent'); profile.identity = 'different';
    policy.profile_templates = [{ provider: 'codex', runtime_user: 'dev', path_root: join(directory, 'accounts'), command: '/usr/bin/true',
      command_sha256: await fingerprint('/usr/bin/true') }]; await savePolicy(); await saveExecutorPolicy();
    const value = await service(); await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).toEqual([]);
  });
  it('compares functional command pins and fails closed on an unconfigured provider or wrong host', async () => {
    const profile = policy.profiles['physical-account']; if (!profile) throw new Error('profile absent');
    profile.command = '/usr/bin/true'; profile.command_sha256 = await fingerprint('/usr/bin/true'); profile.command_files = {};
    const parser = `import json,sys\nsys.path.insert(0,${JSON.stringify(join(config.projectRoot, 'ops/cli'))})\nfrom fleet_provider_identity import provider_command\nprint(json.dumps({'command':provider_command(json.loads(sys.stdin.read()))}))`;
    const packet = JSON.stringify({ profile_binding: profile });
    expect(await boundedProviderReceipt('/usr/bin/python3', ['-c', parser], packet, new AbortController().signal)).toEqual({ command: '/usr/bin/true' });
    await writeFile(config.hostConfig.command.policyFile, JSON.stringify({ schemaVersion: 1, host_id: 'isolated', profiles: policy.profiles }), { mode: 0o600 });
    await savePolicy(); const value = await service(); expect((await value.resolve(actor, operationId)).account_id).toBe('physical-account');
    profile.command_sha256 = '0'.repeat(64); await savePolicy(); await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    profile.provider = 'gemini'; await pool.query("UPDATE provider_accounts SET provider='gemini' WHERE id='physical-account'");
    await writeFile(config.hostConfig.command.policyFile, JSON.stringify({ schemaVersion: 1, host_id: 'isolated', profiles: policy.profiles }), { mode: 0o600 });
    await savePolicy(); const unsupported = await service(); await expect(unsupported.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    config.hostConfig.host = 'other'; await expect(service()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(await trace()).toEqual([]);
  });
  it('rejects identity drift and removed login policy when resolving the request', async () => {
    const value = await service(); await pool.query("UPDATE provider_accounts SET external_account_id='other' WHERE id='physical-account'");
    await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await pool.query("UPDATE provider_accounts SET external_account_id='physical-identity' WHERE id='physical-account'");
    policy.logins = {}; await savePolicy();
    await expect(value.resolve(actor, operationId)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).toEqual([]);
  });
  it.each(['unverified-auth', 'awaiting-auth'])('does not accept %s as a verified provider effect', async marker => {
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    await value.attach(actor, opened.session_id, () => undefined); await writeFile(join(directory, marker), 'synthetic');
    const verified = await value.verify(actor, opened.session_id); expect(verified.status).toBe('failed');
    expect(verified.cleanup_pending).toBe(false);
  });
  it('rejects revised configuration before start', async () => {
    const value = await service(); const request = await value.resolve(actor, operationId);
    await pool.query("INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary) VALUES('Steven','physical-human','{}','{}','synthetic revision')");
    const failed = await value.start(actor, request); expect(failed.status).toBe('failed'); expect(await trace()).not.toContain('login');
  });
  it('rejects human revocation before launch and closes only its own operation effects', async () => {
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [actor.subject.slice(8)]);
    await expect(value.attach(actor, opened.session_id, () => undefined)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await trace()).not.toContain('login'); expect(await trace()).toContain('cleanup');
  });
  it('rejects a changed immutable container binding between open and PTY launch', async () => {
    await pool.query("UPDATE agents SET runtime_mode='container',container_name='physical-container' WHERE alias='physical-new'");
    const profile = policy.profiles['physical-account']; if (!profile) throw new Error('profile absent'); profile.container_name = 'physical-container';
    await writeFile(config.hostConfig.command.policyFile, JSON.stringify({ schemaVersion: 1, host_id: 'isolated', profiles: policy.profiles }), { mode: 0o600 }); await savePolicy();
    const binding = { container_id: 'a'.repeat(64), generation: 'b'.repeat(64), image_digest: 'sha256:' + 'c'.repeat(64),
      python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' };
    const filename = join(directory, 'container-binding.json'); await writeFile(filename, JSON.stringify(binding));
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    expect(opened.status).toBe('awaiting_login');
    await writeFile(filename, JSON.stringify({ ...binding, generation: 'd'.repeat(64) }));
    await expect(value.attach(actor, opened.session_id, () => undefined)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    expect(await trace()).not.toContain('login');
  });
  it('refuses a substituted provider home and requires verified adapter stop before opening login', async () => {
    const login = policy.logins.codex; if (!login) throw new Error('login absent'); login.env = { CODEX_HOME: '/synthetic-substitute' }; await savePolicy();
    const value = await service(); const failed = await value.start(actor, await value.resolve(actor, operationId));
    expect(failed.status).toBe('failed'); expect(await trace()).not.toContain('login');
    delete login.env; await savePolicy(); await writeFile(join(directory, 'unverified-stop'), 'synthetic');
    const retry = await service(); const stopped = await retry.start(actor, await retry.resolve(actor, operationId));
    expect(stopped.status).toBe('failed'); expect(stopped.error).toBe('STOP_UNCONFIRMED'); expect(stopped.cleanup_pending).toBe(true);
    expect(await trace()).not.toContain('login');
    await rm(join(directory, 'unverified-stop'));
  });
  it('cleans an expired reservation after restart without waiting on its caller row lock', async () => {
    const cohort = JSON.stringify(['isolated', 'dev', 'physical-account']);
    await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_started',$2::jsonb)", [operationId,
      JSON.stringify({ step: 'authenticate', provider_auth: { session_id: randomUUID(), actor_subject: actor.subject, cohort, expires_at: '2000-01-01T00:00:00.000Z', state: 'reserved' } })]);
    const value = await service(); const opened = await value.start(actor, await value.resolve(actor, operationId));
    expect(opened.status).toBe('awaiting_login'); expect(await trace()).toContain('cleanup');
    await value.cancel(actor, opened.session_id); expect((await value.get(actor, opened.session_id)).cleanup_pending).toBe(false);
  }, 10_000);
});
