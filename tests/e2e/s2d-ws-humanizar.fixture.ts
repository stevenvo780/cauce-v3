import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { expect } from 'vitest';
import { applyMigrations, applyMigrationsThrough, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { docker, dockerInventory, startComputerHarness, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { HARNESS_SOURCE_FILES, prepareRehearsalAuth } from './s2-espacio-estandar.rehearsal.js';
import { controlledSharedProvider } from './s2d-provider.js';

const ROOT = process.cwd();
const OWNER = 's2b-espacio-estandar-prod-1025';
export const BASELINE = '5dcb70e733ede767d7d7281930ed4b87113a73c8';
const CANDIDATE_COMMIT = process.env.CAUCE_S2D_CANDIDATE_COMMIT;
const execute = promisify(execFile);
const PYTHON = "import runpy,sys;sys.argv=sys.argv[1:];sys.path.insert(0,sys.argv.pop(0));runpy.run_path(sys.argv[0],run_name='__main__')";
const OPS_FILES = ['scripts/container-adapter-supervisor.sh', 'scripts/container-adapter-supervisor-lib.sh', 'scripts/adapter-space-launcher.sh',
  'scripts/container-alias-query.py', 'scripts/container_alias_lib.py', 'scripts/fleet_derive.py', 'scripts/fleet_runtime_inventory.py',
  'scripts/fleet_runtime_materialization.py', 'scripts/atomic_file.py', 'scripts/secure_path.py', 'scripts/pin-container-release.py',
  'scripts/validate-container-mount.py', 'scripts/alias-lock-exec.py', 'scripts/verify-hermes-runtime.py',
  'container-runtime/cauce-container-runtime.py', 'container-runtime/cauce_container_base.py', 'container-runtime/cauce_container_proc.py',
  'container-runtime/cauce_container_tree.py', 'container-runtime/cauce_container_adoption.py', 'container-runtime/podar-releases.py'];
const SOURCES = ['tests/e2e/s2d-ws-humanizar.test.ts', 'tests/e2e/s2d-ws-humanizar.fixture.ts', 'tests/e2e/s2d-provider.ts',
  ...(CANDIDATE_COMMIT === undefined ? [] : ['tests/e2e/s2d-ws-humanizar-unfixed.test.ts']),
  'tests/e2e/s2-espacio-estandar.rehearsal.ts', 'services/gateway/src/fleet/host-computer.fixtures.ts', ...HARNESS_SOURCE_FILES,
  '.delegados/v4/espacio-estandar.sh', '.delegados/v4/espacio-estandar.py', '.delegados/v4/espacio-estandar.remoto.py',
  '.delegados/v4/live_adapter.py', '.delegados/v4/live_adapter_probe.py',
  ...(CANDIDATE_COMMIT === undefined ? ['ops/container-runtime/cauce_container_restart.py', ...OPS_FILES.map(path => 'ops/' + path)] : [])];

export interface Identity { pid: number; ticks: string; ppid: number; uid: number; state: string }
export interface Actor { alias: string; harness: 'claude' | 'codex'; state: string; unit: string; profile: string }
export interface Observation {
  actors: Record<string, { adapter: Identity; controller: Identity; authority: string | null }>;
  server: Identity;
  panes: Record<string, { session: string; pane: string; process: Identity }>;
  job?: Identity;
}
interface ToolResult { code: number; stdout: string; stderr: string }
export interface SharedWindowFixture {
  actors: Actor[];
  run: string;
  snapshot(): Promise<Observation>;
  pane(actor: Actor): Promise<string>;
  provider(actor: Actor): Promise<{ inputBytes: number; submits: number; draftLength: number; pid: number }>;
  keys(actor: Actor, keys: string[], literal?: boolean): Promise<void>;
  apply(actor: Actor, phase: string): Promise<{ result: ToolResult; receipt: unknown }>;
  directStop(actor: Actor): Promise<ToolResult>;
  gone(identity: Identity): Promise<boolean>;
  start(actor: Actor): Promise<void>;
  save(name: string, value: unknown): Promise<void>;
  diagnostics(): Promise<void>;
  close(): Promise<void>;
}
async function command(file: string, args: string[], input?: string, timeout = 240_000) {
  const pending = execute(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  if (input !== undefined) pending.child.stdin?.end(input);
  return pending;
}
async function result(file: string, args: string[], input?: string): Promise<ToolResult> {
  try { const observed = await command(file, args, input); return { code: 0, ...observed }; }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !('stdout' in error) || !('stderr' in error)) throw error;
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}
export async function until<T>(read: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    const value = await read(); if (value !== undefined) return value;
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
  throw new Error('Owned shared-session condition did not settle before its deadline');
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function sourceHashes(): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(SOURCES.map(async (file): Promise<[string, string]> => [file, hash(await readFile(join(ROOT, file)))])));
}

export async function sharedWindowFixture(): Promise<SharedWindowFixture> {
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-s2b-/u, 'use CAUCE_E2E_CONTEXT=lab scripts/e2e-lab.sh s2b-s2d ...');
  assert.equal(process.getuid?.(), 1000);
  assert.equal(process.env.CAUCE_TEST_DATABASE_URL, undefined);
  assert.ok(CANDIDATE_COMMIT === undefined || CANDIDATE_COMMIT === BASELINE);
  const run = randomUUID().replaceAll('-', '').slice(0, 12), prefix = 'zz-canary-' + OWNER + '-' + run;
  const evidence = join(ROOT, '.delegados/v4/recibos/s2d-ventana-ws-humanizar-1025', run);
  const directory = await mkdtemp('/datos/' + prefix + '-');
  const home = join(directory, 'home'), workspace = join(directory, 'workspace'), control = '/run/zz-canary-s2d';
  const wsName = prefix + '-ws', managerRoot = '/home/cauce/s2d';
  const actors: Actor[] = (['codex', 'claude'] as const).map((harness, index) => {
    const alias = 'zz-canary-s2d-' + harness + '-' + run;
    return { alias, harness, state: '/home/node/zz-canary-s2d-' + run + '/' + String(index),
      unit: 'cauce-v3-container-' + alias + '.service', profile: '/home/node/.local/share/cauce-v3/config/' + alias + '/.' + harness };
  });
  const save = async (name: string, value: unknown) => {
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    await writeFile(join(evidence, name + '.json'), JSON.stringify({ owner: OWNER, campaign: 's2d-ventana-ws-humanizar-1025', run, value }, null, 2) + '\n', { mode: 0o600 });
  };
  console.info('S2D_EVIDENCE', JSON.stringify({ run, directory: evidence, owner: OWNER }));
  let computer: ComputerHarness | undefined, ws: StartedTestContainer | undefined, database: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined, app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of [async () => ws?.stop(), async () => computer?.close(), async () => app?.close(), async () => pool?.end(),
      async () => database?.stop(), async () => {
        await command('find', ['-P', directory, '-type', 'd', '-exec', 'chmod', 'u+w', '--', '{}', '+']);
        await rm(directory, { recursive: true, force: true });
      }]) try { await cleanup(); } catch (error) { failures.push(error); }
    const remaining = await dockerInventory(prefix);
    try { expect(remaining).toEqual({ containers: '', volumes: '', images: '' }); } catch (error) { failures.push(error); }
    await save('cleanup', { remaining, failures: failures.length, result: failures.length ? 'FAIL' : 'PASS' });
    if (failures.length) throw new AggregateError(failures, 'Owned shared-window cleanup failed');
  };
  try {
    for (const path of [home, workspace, join(home, '.local/bin'), join(home, 'zz-canary-s2d-' + run), join(directory, 'pki')]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(home, '.bash_profile'), 'export PATH="$HOME/.local/bin:$PATH"\n', { mode: 0o600 });
    for (const actor of actors) {
      await mkdir(join(home, 'zz-canary-s2d-' + run, actor.state.split('/').at(-1) ?? 'missing'), { mode: 0o700 });
      const profile = join(home, actor.profile.slice('/home/node/'.length)); await mkdir(profile, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(actor.harness === 'claude'
        ? { 'CLAUDE.md': 'Owned shared provider\n', '.credentials.json': '{}\n', '.claude.json': '{}\n' }
        : { 'AGENTS.md': 'Owned shared provider\n', 'config.toml': '', 'auth.json': '{}\n' })) await writeFile(join(profile, name), content, { mode: 0o600 });
      await writeFile(join(home, '.local/bin', actor.harness), controlledSharedProvider, { mode: 0o700 });
    }
    const archivedTree = join(directory, 'baseline-tree'); await mkdir(archivedTree, { mode: 0o700 });
    const archive = await execute('git', ['-C', ROOT, 'archive', BASELINE, ...OPS_FILES.map(path => 'ops/' + path)],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const extraction = execute('tar', ['-xf', '-', '--no-same-owner', '-C', archivedTree]);
    extraction.child.stdin?.end(archive.stdout); await extraction;
    const baselineOps = join(archivedTree, 'ops');
    const bundle = join(directory, 'bundles/releases/candidate'), sdk = join(bundle, 'packages/adapter-sdk');
    await mkdir(sdk, { recursive: true, mode: 0o700 }); await writeFile(join(sdk, 'package.json'), '{"type":"module"}\n');
    for (const name of ['descriptors', 'bridge']) await cp(join(ROOT, 'packages/adapter-sdk', name), join(sdk, 'dist', name), { recursive: true });
    for (const entry of ['bin/claude', 'bin/codex', 'bin/shared-session', 'context/space-layout']) {
      const output = join(sdk, 'dist/src', entry + '.js'); await mkdir(dirname(output), { recursive: true });
      await command(join(ROOT, 'node_modules/.bin/esbuild'), [join(ROOT, 'packages/adapter-sdk/src', entry + '.ts'), '--bundle',
        '--platform=node', '--format=esm', '--target=node22', '--log-level=error', '--outfile=' + output,
        '--alias:@cauce/protocol=' + join(ROOT, 'packages/protocol/src'),
        '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);']);
      if (entry.startsWith('bin/')) await chmod(output, 0o755);
    }
    await command('chmod', ['-R', 'a=rX', bundle]);
    const digest = async (target: string) => (await command('python3', ['-I', '-B', '-c', PYTHON, join(baselineOps, 'container-runtime'),
      join(baselineOps, 'container-runtime/cauce-container-runtime.py'), 'bundle-digest', target])).stdout.trim();
    const bundleDigest = await digest(bundle);
    computer = await startComputerHarness({ prefix: prefix + '-native-host', consoleOrigins: [], resourceOwner: OWNER,
      workRoot: '/datos', extraSourceFiles: HARNESS_SOURCE_FILES });
    const manager = computer;
    const image = 'cauce-e2e-lab-runner:' + hash(await readFile(join(ROOT, 'tests/e2e/lab-runner/Dockerfile'))).slice(0, 12);
    ws = await new GenericContainer(image).withName(wsName).withLabels({ 'cauce.e2e.owner': OWNER, 'cauce.e2e.run': run })
      .withUser('0').withNetworkMode('host').withBindMounts([{ source: home, target: '/home/node', mode: 'rw' },
        { source: workspace, target: '/workspace', mode: 'rw' }]).withWorkingDir('/workspace')
      .withCommand(['sleep', 'infinity']).withWaitStrategy(Wait.forSuccessfulCommand('id node')).start();
    const password = randomUUID();
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine').withName(prefix + '-pg')
      .withLabels({ 'cauce.e2e.owner': OWNER, 'cauce.e2e.run': run }).withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck()).start());
    pool = createPool(`postgresql://cauce_test:${encodeURIComponent(password)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`);
    const activePool = pool;
    await applyMigrationsThrough(pool, '047_agent_preferences.sql');
    for (const actor of actors) {
      await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory) VALUES('Steven',$1,$2,true,$3,'node','/home/node',$4)",
        [actor.alias, actor.harness, wsName, actor.state]);
      await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [actor.alias]);
    }
    const publisher = 'zz-canary-s2d-pub-' + run;
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES('Steven',$1,'codex',false)", [publisher]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [publisher]);
    await applyMigrations(pool);
    const baselines = (await pool.query<{ alias: string; runtime_key: string; baseline: boolean; runtime_mode: string | null }>(
      `SELECT agent.alias,agent.runtime_key,identity.baseline,agent.runtime_mode FROM agents agent
         JOIN fleet_runtime_identities identity USING(tenant_id,alias,runtime_key)
        WHERE agent.tenant_id='Steven' AND agent.alias=ANY($1::text[]) ORDER BY agent.alias`, [actors.map(actor => actor.alias)])).rows;
    expect(baselines).toHaveLength(2);
    for (const row of baselines) expect(row).toMatchObject({ runtime_key: row.alias, baseline: true, runtime_mode: null });
    await save('postgres', { legacy_seed_through: '047_agent_preferences.sql', migrated: true, agents: baselines });
    const material = createSelfSignedCert({ directory }), workers = actors.map(() => createSelfSignedCert({ directory }));
    for (const certificate of [material, ...workers]) for (const file of [certificate.cert_path, certificate.key_path]) await chmod(file, 0o600);
    const identities = join(directory, 'identities.json');
    await writeFile(identities, JSON.stringify({ version: 1, identities: [{ alias: publisher, material }, ...actors.map((actor, index) => {
      const certificate = workers[index]; assert.ok(certificate); return { alias: actor.alias, material: certificate };
    })].map(row => ({ certificate_sha256: new X509Certificate(row.material.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), principal: { tenant_id: 'Steven', alias: row.alias,
        session_id: 'canary:' + run, channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] } })) }), { mode: 0o600 });
    const auth = await prepareRehearsalAuth(pool, new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)), publisher, run);
    const consoleOwners = (await pool.query<{ id: string; tenant_id: string; alias: string; role: string; active: boolean }>(
      'SELECT id::text,tenant_id,alias,role,active FROM console_users WHERE email_normalized=$1', [auth.email])).rows;
    expect(consoleOwners).toHaveLength(1); const consoleOwner = consoleOwners[0]; assert.ok(consoleOwner);
    expect(consoleOwner).toMatchObject({ tenant_id: 'Steven', alias: publisher, role: 'operator', active: true });
    await save('console-tui-owner', { human_id: consoleOwner.id, tenant_id: consoleOwner.tenant_id,
      actor_alias: consoleOwner.alias, source: 'owned PostgreSQL console user' });
    app = await buildGateway({ pool, logger: false, outboxPollMs: 10, leaseTtlMs: 30_000, authProvider: auth.provider, consoleOrigins: [auth.origin],
      https: { cert: material.cert, key: material.key, ca: [material.cert, ...workers.map(worker => worker.cert)], requestCert: true, rejectUnauthorized: false } });
    await app.listen({ host: '0.0.0.0', port: 0 }); const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const gateway = 'https://127.0.0.1:' + String(address.port);
    const mapping = { schemaVersion: 2, systemPrincipals: {}, historicalAliases: {}, aliases: Object.fromEntries(actors.map(actor => [actor.alias,
      { tenant: 'Steven', room: 'grp.steven', container: wsName, user: 'node', home: '/home/node', harness: actor.harness,
        stateDirectory: actor.state, membershipRole: 'agent', systemdUser: 'cauce' }])) };
    const candidateOps = join(directory, 'candidate-ops');
    for (const relative of OPS_FILES) {
      await mkdir(dirname(join(candidateOps, relative)), { recursive: true, mode: 0o700 });
      await copyFile(CANDIDATE_COMMIT === undefined ? join(ROOT, 'ops', relative) : join(baselineOps, relative), join(candidateOps, relative));
    }
    if (CANDIDATE_COMMIT === undefined) await copyFile(join(ROOT, 'ops/container-runtime/cauce_container_restart.py'), join(candidateOps, 'container-runtime/cauce_container_restart.py'));
    for (const ops of [baselineOps, candidateOps]) {
      await writeFile(join(ops, 'container-aliases.json'), JSON.stringify(mapping) + '\n', { mode: 0o600 });
      await command('chmod', ['-R', 'a=rX', ops]);
    }
    const baselineDigest = await digest(baselineOps), candidateDigest = await digest(candidateOps);
    if (CANDIDATE_COMMIT === undefined) expect(baselineDigest).not.toBe(candidateDigest);
    else expect(baselineDigest).toBe(candidateDigest);
    const made = await manager.onComputer(['mkdir', '-m', '0700', managerRoot, managerRoot + '/releases', managerRoot + '/config',
      managerRoot + '/pki', managerRoot + '/locks', managerRoot + '/bundles']); expect(made.code, made.stderr).toBe(0);
    const unitDirectory = await manager.onComputer(['mkdir', '-p', '-m', '0700', '/home/cauce/.config/systemd/user']);
    expect(unitDirectory.code, unitDirectory.stderr).toBe(0);
    for (const [source, target] of [[baselineOps, managerRoot + '/baseline-ops'], [join(directory, 'bundles/releases'), managerRoot + '/bundles/releases']] as const) {
      await docker(['cp', source, manager.container + ':' + target]); await docker(['exec', manager.container, 'chown', '-R', '1500:1500', target]);
    }
    const imageId = await docker(['inspect', '--format', '{{.Image}}', wsName]);
    for (const [index, actor] of actors.entries()) {
      const worker = workers[index]; assert.ok(worker); const pki = join(directory, 'pki', actor.alias); await mkdir(pki, { mode: 0o700 });
      for (const [name, content] of [['client.crt', worker.cert], ['client.key', worker.key], ['ca.crt', material.cert]] as const) await writeFile(join(pki, name), content, { mode: 0o600 });
      await docker(['cp', pki, manager.container + ':' + managerRoot + '/pki/' + actor.alias]);
      const config = join(directory, actor.alias + '.env');
      await writeFile(config, Object.entries({ BUNDLE_RELEASE: 'candidate', BUNDLE_SHA256: bundleDigest,
        PKI_DIR: managerRoot + '/pki/' + actor.alias, RELAY_URL: gateway.replace('https:', 'wss:') + '/v3/ws', EXPECTED_IMAGE_ID: imageId,
        EXPECTED_LABEL_KEY: 'cauce.e2e.owner', EXPECTED_LABEL_VALUE: OWNER, MOUNT_TYPE: 'bind', MOUNT_SOURCE: home, MOUNT_DESTINATION: '/home/node',
        MOUNT_RW: 'true', CONFIG_POR_ALIAS: '1', CAUCE_SEMBRAR_PERFIL: '1', SHARED_SESSION: '1', SHARED_SESSION_WORKSPACE: '/workspace',
        OWNER_HUMAN_ID: consoleOwner.id,
        ...(actor.harness === 'claude' ? { EXPECTED_CLI_VERSION: '2.1.0' } : {}) }).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 });
      await docker(['cp', config, manager.container + ':' + managerRoot + '/config/' + actor.alias + '.env']);
      const unit = ['[Unit]', 'Description=Owned shared legacy adapter', '[Service]', 'Type=simple', 'Environment=HOME=/home/cauce',
        'Environment=PATH=/usr/local/bin:/usr/bin:/bin', 'Environment=CAUCE_CONTAINER_TEST_MODE=1', 'Environment=CAUCE_CONTAINER_WAIT_SECONDS=0',
        ...Object.entries({ OPS: 'baseline-ops', CONFIG: 'config', PKI: 'pki', BUNDLE: 'bundles', LOCK: 'locks' }).map(([name, path]) =>
          'Environment=CAUCE_CONTAINER_' + name + '_ROOT=' + managerRoot + '/' + path), 'Environment=CAUCE_CONTAINER_CONTROL_ROOT=' + control,
        'ExecStart=' + managerRoot + '/baseline-ops/scripts/container-adapter-supervisor.sh start ' + actor.alias,
        'ExecStop=' + managerRoot + '/baseline-ops/scripts/container-adapter-supervisor.sh stop ' + actor.alias,
        'KillMode=process', 'TimeoutStopSec=45', ''].join('\n');
      const stagedUnit = join(directory, actor.unit); await writeFile(stagedUnit, unit, { mode: 0o600 });
      const unitPath = '/home/cauce/.config/systemd/user/' + actor.unit;
      await docker(['cp', stagedUnit, manager.container + ':' + unitPath]); await docker(['exec', manager.container, 'chown', '1500:1500', unitPath]);
    }
    await docker(['exec', manager.container, 'chown', '-R', '1500:1500', managerRoot + '/pki', managerRoot + '/config']);
    const reload = await manager.onComputer(['systemctl', '--user', 'daemon-reload']); expect(reload.code, reload.stderr).toBe(0);
    const session = join(directory, 'console-session.json');
    await command('python3', ['-B', join(ROOT, 'ops/cli/cauce-login'), '--gateway', gateway, '--origin', auth.origin, '--ca-file', material.cert_path,
      '--email', auth.email, '--password-stdin', '--session-file', session], auth.password + '\n');
    const sources = await sourceHashes();
    await save('sources', { baseline_revision: BASELINE, baseline_ops_digest: baselineDigest, candidate_ops_digest: candidateDigest,
      candidate_source: CANDIDATE_COMMIT === undefined ? 'workingtree candidate' : 'gitarchive5dcb',
      canonical_digest_revision: BASELINE, sdk_digest: bundleDigest, source_sha256: sources, original_runtime_expected_authority: null });
    const start = async (actor: Actor) => {
      const prior = (await activePool.query<{ fingerprint: string }>("SELECT encode(digest(connection_token::text,'sha256'),'hex') AS fingerprint FROM connection_leases WHERE tenant_id='Steven' AND alias=$1", [actor.alias])).rows[0]?.fingerprint;
      const started = await manager.onComputer(['systemctl', '--user', 'start', actor.unit]); expect(started.code, started.stderr).toBe(0);
      await until(async () => {
        const lease = (await activePool.query<{ fingerprint: string }>("SELECT encode(digest(connection_token::text,'sha256'),'hex') AS fingerprint FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND epoch>0 AND lease_until>clock_timestamp()", [actor.alias])).rows[0];
        if (!lease || lease.fingerprint === prior) return undefined;
        const valid = await docker(['exec', '--user', '0', wsName, 'python3', '-I', '-B', '-c',
          'import json,pathlib,sys\ntry:\n d=json.loads(pathlib.Path(sys.argv[1]).read_bytes());s=(pathlib.Path("/proc")/str(d["pid"])/"stat").read_text().rsplit(") ",1)[1].split();print(d["phase"]=="running" and s[0]!="Z" and s[19]==str(d["starttime"]))\nexcept (OSError,KeyError,TypeError):print(False)', control + '/' + actor.alias + '/cauce-v3-adapter.json']);
        return valid === 'True' ? true : undefined;
      });
    };
    const pane = (actor: Actor) => docker(['exec', '--user', '1000', wsName, 'tmux', '-L', 'cauce', 'capture-pane', '-p', '-e', '-t', 'cauce-' + actor.alias + ':agente']);
    const identity = async (pids: number[]): Promise<Record<string, Identity>> => JSON.parse(await docker(['exec', '--user', '0', wsName, 'python3', '-I', '-B', '-c',
      'import json,pathlib,sys;r={}\nfor pid in json.loads(sys.argv[1]):\n p=pathlib.Path("/proc")/str(pid);s=(p/"stat").read_text().rsplit(") ",1)[1].split();assert s[0]!="Z";r[str(pid)]={"pid":pid,"ticks":s[19],"ppid":int(s[1]),"uid":p.stat().st_uid,"state":s[0]}\nprint(json.dumps(r))', JSON.stringify(pids)])) as Record<string, Identity>;
    const snapshot = async (): Promise<Observation> => {
      const metadata = JSON.parse(await docker(['exec', '--user', '0', wsName, 'python3', '-I', '-B', '-c',
        'import json,pathlib,sys;r={}\nfor alias in sys.argv[2:]:\n d=json.loads((pathlib.Path(sys.argv[1])/alias/"cauce-v3-adapter.json").read_bytes());r[alias]={k:d.get(k) for k in ("pid","starttime","controllerPid","controllerStarttime","stopAuthority")}\nprint(json.dumps(r))', control, ...actors.map(actor => actor.alias)])) as Record<string, { pid: number; starttime: number; controllerPid: number; controllerStarttime: number; stopAuthority: string | null }>;
      const columnSeparator = '|', rowSeparator = String.fromCharCode(10);
      const format = ['#{session_name}', '#{session_id}', '#{pane_id}', '#{pane_pid}', '#{pid}'].join(columnSeparator);
      const rows = (await docker(['exec', '--user', '1000', wsName, 'tmux', '-L', 'cauce', 'list-panes', '-a', '-F', format]))
        .split(rowSeparator).map(row => row.split(columnSeparator));
      if (rows.some(row => row.length !== 5 || !Number.isFinite(Number(row[4])) || Number(row[4]) <= 1)) {
        await save('snapshot-format-failure', { columns: ['session_name', 'session_id', 'pane_id', 'pane_pid', 'pid'], rows,
          separator_codes: [columnSeparator.charCodeAt(0), rowSeparator.charCodeAt(0)] });
      }
      expect(rows).toHaveLength(2);
      const serverPid = Number(rows[0]?.[4]); expect(serverPid).toBeGreaterThan(1);
      for (const row of rows) expect(Number(row[4])).toBe(serverPid);
      let job: { pid: number; ticks: string } | undefined;
      try { job = JSON.parse(await readFile(join(home, 's2d-job.json'), 'utf8')) as { pid: number; ticks: string }; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      const ids = await identity([...new Set([serverPid, ...Object.values(metadata).flatMap(row => [row.pid, row.controllerPid]),
        ...rows.map(row => Number(row[3])), ...(job ? [job.pid] : [])])]);
      const actorStates: Observation['actors'] = {}, panes: Observation['panes'] = {};
      for (const actor of actors) {
        const row = metadata[actor.alias]; assert.ok(row);
        const adapter = ids[String(row.pid)], controller = ids[String(row.controllerPid)]; assert.ok(adapter && controller);
        expect(adapter.ticks).toBe(String(row.starttime)); expect(controller.ticks).toBe(String(row.controllerStarttime));
        actorStates[actor.alias] = { adapter, controller, authority: row.stopAuthority ?? null };
        const selected = rows.find(row => row[0] === 'cauce-' + actor.alias); assert.ok(selected?.[1] && selected[2]);
        const process = ids[String(selected[3])]; assert.ok(process); panes[actor.alias] = { session: selected[1], pane: selected[2], process };
      }
      const server = ids[String(serverPid)]; assert.ok(server);
      const observed: Observation = { actors: actorStates, server, panes };
      if (job) { const process = ids[String(job.pid)]; assert.ok(process); expect(process.ticks).toBe(job.ticks); observed.job = process; }
      return observed;
    };
    const inventory = join(directory, 'inventory.json');
    await writeFile(inventory, JSON.stringify({ version: 1, agents: actors.map(actor => ({ alias: actor.alias, kind: 'container', transport: 'docker',
      host: manager.container, manager: 'cauce', uid: 1500, unit: actor.unit, state_directory: actor.state, runtime_user: 'node', runtime_uid: 1000,
      harness: actor.harness, tenant_id: 'Steven', room_id: 'grp.steven', expected_instance_id: 'systemd-container-' + actor.alias,
      release_root: managerRoot + '/releases', preserve_paths: ['/workspace', '/home/node', actor.state], container: wsName,
      bundle_root: managerRoot + '/bundles', config_root: managerRoot + '/config', ops_root: managerRoot + '/baseline-ops', owner: OWNER, namespace: run })) }) + '\n', { mode: 0o600 });
    const installedOps = new Map<string, string>();
    return { actors, run, save, close, start, pane, snapshot,
      diagnostics: async () => {
        const safe = (text: string) => text.slice(-16_384).split('\n').map(line =>
          /CAUCE_[A-Z_]+=|authorization|bearer|cookie|csrf|password|credential|secret|private.key|"body"|"prompt"|"reply"/iu.test(line)
            ? '[REDACTED_LOG_LINE]' : line).join('\n');
        const records = await Promise.all(actors.map(async actor => {
          const checks = await Promise.allSettled([
            manager.onComputer(['systemctl', '--user', 'show', actor.unit, '--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,MainPID']),
            manager.onComputer(['journalctl', '--user', '--unit=' + actor.unit, '--no-pager', '-n', '30', '--output=cat']),
            result('docker', ['exec', '--user', '0', wsName, 'tail', '-c', '16384', actor.state + '/.cauce-adapter.log']),
          ]);
          return { alias: actor.alias, checks: checks.map((check, index) => ({ source: ['unit', 'journal', 'adapter'][index],
            ...(check.status === 'fulfilled' ? { code: check.value.code, stdout: safe(check.value.stdout), stderr: safe(check.value.stderr) } : { unavailable: true }) })) };
        }));
        await save('failure-diagnostics', records);
      },
      gone: async process => await docker(['exec', '--user', '0', wsName, 'python3', '-I', '-B', '-c',
        'import pathlib,sys;p=pathlib.Path("/proc")/sys.argv[1];print(not p.exists() or (p/"stat").read_text().rsplit(") ",1)[1].split()[19]!=sys.argv[2] or (p/"stat").read_text().rsplit(") ",1)[1].split()[0]=="Z")',
        String(process.pid), process.ticks]) === 'True',
      keys: async (actor, keys, literal = false) => { await docker(['exec', '--user', '1000', wsName, 'tmux', '-L', 'cauce', 'send-keys',
        '-t', 'cauce-' + actor.alias + ':agente', ...(literal ? ['-l'] : []), ...keys]); },
      provider: async actor => JSON.parse(await docker(['exec', '--user', '1000', wsName, 'python3', '-I', '-B', '-c',
        'import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())', actor.profile + '/s2d-provider-state.json'])) as { inputBytes: number; submits: number; draftLength: number; pid: number },
      directStop: actor => {
        const ops = installedOps.get(actor.alias); assert.ok(ops);
        return manager.onComputer(['env', 'CAUCE_CONTAINER_TEST_MODE=1', 'CAUCE_CONTAINER_OPS_ROOT=' + ops,
          'CAUCE_CONTAINER_CONFIG_ROOT=' + managerRoot + '/config', 'CAUCE_CONTAINER_BUNDLE_ROOT=' + managerRoot + '/bundles',
          'CAUCE_CONTAINER_PKI_ROOT=' + managerRoot + '/pki', 'CAUCE_CONTAINER_LOCK_ROOT=' + managerRoot + '/locks',
          'CAUCE_CONTAINER_CONTROL_ROOT=' + control, ops + '/scripts/container-adapter-supervisor.sh', 'stop', actor.alias]);
      },
      apply: async (actor, phase) => {
        expect(await sourceHashes(), 'runtime or window source changed during the run').toEqual(sources);
        const receiptPath = join(directory, 'window-' + actor.harness + '-' + phase + '.json');
        const observed = await result('bash', [join(ROOT, '.delegados/v4/espacio-estandar.sh'), '--aplicar', actor.alias,
          '--inventario', inventory, '--ops-release', candidateOps, '--ops-sha256', candidateDigest,
          '--sdk-release', bundle, '--sdk-sha256', bundleDigest, '--recibo', receiptPath, '--laboratorio', '--sesion', session,
          '--gateway', gateway, '--origin', auth.origin, '--ca-file', material.cert_path, '--timeout', '120']);
        let receipt: unknown = null;
        try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        if (observed.code === 0) {
          const packet = (receipt as { packet?: { ops_target?: string } } | null)?.packet;
          assert.ok(packet?.ops_target); expect(packet.ops_target.startsWith(managerRoot + '/releases/ops-')).toBe(true);
          installedOps.set(actor.alias, packet.ops_target);
        }
        await save('window-' + actor.harness + '-' + phase, { exit_code: observed.code, receipt });
        return { result: observed, receipt };
      } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Shared-window setup and cleanup failed'); }
    throw error;
  }
}
