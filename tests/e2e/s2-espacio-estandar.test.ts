import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishResultSchema } from '@cauce/protocol';
import { applyMigrations, applyMigrationsThrough, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { docker, startComputerHarness, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { addRehearsalRuntimes, configureRehearsal, HARNESS_SOURCE_FILES, prepareRehearsalAuth, runRehearsal, type Rehearsal } from './s2-espacio-estandar.rehearsal.js';

const execute = promisify(execFile);
const ROOT = process.cwd();
const REHEARSAL = process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL === '1';
const PREPARED_COMMIT = process.env.CAUCE_S2_PREPARED_COMMIT;
const OWNER = REHEARSAL ? 's2b-espacio-estandar-prod-1025' : 's2-espacio-estandar-1025';
const CAMPAIGN = PREPARED_COMMIT === undefined ? OWNER : 's2c-ventana-produccion-1025';
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);
const PREFIX = 'zz-canary-' + OWNER + '-' + RUN;
const EVIDENCE = join(ROOT, '.delegados/v4/recibos', CAMPAIGN, RUN);
const CONTROL = '/run/zz-canary-s2-supervisor';
const SOURCE = join(ROOT, 'packages/adapter-sdk');
const SUPERVISOR = join(ROOT, 'ops/scripts/container-adapter-supervisor.sh');
const LAUNCHER = join(ROOT, 'ops/scripts/adapter-space-launcher.sh');
const BANNER = 'import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);';
type Harness = 'claude' | 'codex' | 'openclaw';
export interface Runtime {
  alias: string; harness: Harness; container: string; user: string; uid: number; home: string; state: string;
  cwd: string; providerCwd: string; native: boolean; unit?: string; child?: ChildProcess; log: string; leaseFingerprint?: string;
  startAttempted?: boolean;
  rehearsal?: boolean;
}
export interface Probe {
  pid: number; ticks: string; uid: { real: number; effective: number }; cwd: string; adapter: boolean;
  environment: { CAUCE_SPACE_ROOT: string | null; TMPDIR: string | null };
  layout: Record<string, { mode: string; uid: number; inode: number; directory: boolean; symlink: boolean }>;
  legacy: Legacy;
}
export type Legacy = Record<string, { inode: number; directory: boolean; symlink: boolean;
  marker: { inode: number; uid: number; mode: string; regular: boolean; content: string };
  link: { inode: number; target: string; resolved: string; target_inode: number; content: string } }>;
let directory = '';
let release = '';
let bundleDigest = '';
let computer: ComputerHarness | undefined;
let databasePool: DatabasePool | undefined;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
let environment: NodeJS.ProcessEnv = {};
let origin = '';
let publisherTls: ReturnType<typeof createSelfSignedCert> | undefined;
let rehearsal: Rehearsal | undefined;
const runtimes: Runtime[] = [];
const containers: StartedTestContainer[] = [];
const active = () => { if (!computer) throw new Error('owned native computer missing'); return computer; };
const pool = () => { if (!databasePool) throw new Error('owned legacy PostgreSQL missing'); return databasePool; };

async function save(name: string, value: unknown) {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  await writeFile(join(EVIDENCE, name + '.json'), JSON.stringify({ owner: OWNER, campaign: CAMPAIGN, run: RUN, value },
    (key, entry: unknown) => REHEARSAL && key === 'environment' && entry !== null && typeof entry === 'object'
      ? Object.keys(entry) : entry, 2) + '\n', { mode: 0o600 });
}
async function shell(file: string, args: string[], env = process.env) {
  return execute(file, args, { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}
async function compile(entry: string, output: string) {
  await mkdir(dirname(output), { recursive: true });
  await shell(join(ROOT, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm',
    '--target=node22', '--log-level=error', '--outfile=' + output,
    '--alias:@cauce/protocol=' + join(ROOT, 'packages/protocol/src/index.ts'), '--banner:js=' + BANNER]);
}
async function buildBundle() {
  release = join(directory, 'bundles/releases/candidate');
  const sdk = join(release, 'packages/adapter-sdk');
  await mkdir(sdk, { recursive: true, mode: 0o700 });
  await writeFile(join(sdk, 'package.json'), '{"name":"@cauce/adapter-sdk","type":"module"}\n');
  await cp(join(SOURCE, 'descriptors'), join(sdk, 'dist/descriptors'), { recursive: true });
  await cp(join(SOURCE, 'bridge'), join(sdk, 'dist/bridge'), { recursive: true });
  for (const harness of ['claude', 'codex', 'openclaw']) {
    const output = join(sdk, 'dist/src/bin', harness + '.js');
    await compile(join(SOURCE, 'src/bin', harness + '.ts'), output); await chmod(output, 0o555);
  }
  await compile(join(SOURCE, 'src/context/space-layout.ts'), join(sdk, 'dist/src/context/space-layout.js'));
  await shell('chmod', ['-R', 'a=rX', release]);
  bundleDigest = (await shell('python3', [join(ROOT, 'ops/container-runtime/cauce-container-runtime.py'), 'bundle-digest', release])).stdout.trim();
  await save('candidate', { bundle_digest: bundleDigest, compiler: 'esbuild actual SDK and protocol source',
    driver_sha256: createHash('sha256').update(await readFile(join(ROOT, 'tests/e2e/s2-espacio-estandar.test.ts'))).digest('hex'),
    supervisor_sha256: createHash('sha256').update(await readFile(SUPERVISOR)).digest('hex'),
    launcher_sha256: createHash('sha256').update(await readFile(LAUNCHER)).digest('hex') });
}

const TEMP_PROOF = [
  "import { mkdtemp, writeFile } from 'node:fs/promises';",
  "import { tmpdir } from 'node:os'; import { join } from 'node:path';",
  'export async function proveTemporary(prompt) {',
  " const marker=/(?:S2_TEMP_[a-z0-9-]+|CAUCE_LIVE_[a-f0-9]{32})/.exec(prompt)?.[0]; if(!marker) throw new Error('turn marker missing');",
  " const temporary=await mkdtemp(join(tmpdir(),marker+'-'));",
  " await writeFile(join(temporary,'proof.json'),JSON.stringify({marker,pid:process.pid,cwd:process.cwd(),tmpdir:tmpdir()}),{mode:0o600});",
  '}',
].join('\n');
async function stageProvider(home: string) {
  const kernel = join(home, 's2-kernels');
  await mkdir(kernel, { recursive: true, mode: 0o700 });
  await writeFile(join(kernel, 'package.json'), '{"type":"module"}\n');
  await copyFile(join(SOURCE, 'test/fixtures/fake-cli-common.mjs'), join(kernel, 'fake-cli-common.mjs'));
  if (REHEARSAL) {
    const fixture = await readFile(join(kernel, 'fake-cli-common.mjs'), 'utf8');
    assert.ok(fixture.includes('reply: isFailure ?'));
    await writeFile(join(kernel, 'fake-cli-common.mjs'), fixture.replace('reply: isFailure ?',
      'reply: /CAUCE_LIVE_[a-f0-9]{32}/.exec(prompt)?.[0] ?? (isFailure ?').replace('`${dialect} success`,', '`${dialect} success`),'));
  }
  await writeFile(join(kernel, 'proof.mjs'), TEMP_PROOF);
  await writeFile(join(kernel, 'turn.mjs'), [
    "import { runFakeCli } from './fake-cli-common.mjs'; import { proveTemporary } from './proof.mjs';",
    "const dialect=process.argv[2]; process.argv.splice(2,1); process.umask(0o077);",
    "if(process.argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }",
    "await runFakeCli(dialect,async()=>{const chunks=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));",
    "const prompt=Buffer.concat(chunks).toString('utf8');await proveTemporary(prompt);return prompt;});",
  ].join('\n'));
  await mkdir(join(home, '.local/bin'), { recursive: true, mode: 0o700 });
  for (const harness of ['claude', 'codex']) {
    await writeFile(join(home, '.local/bin', harness), '#!/bin/sh\nexec node "$HOME/s2-kernels/turn.mjs" ' + harness + ' "$@"\n', { mode: 0o700 });
  }
  const dist = join(home, 's2-openclaw-dist');
  await mkdir(join(dist, 'kernel'), { recursive: true, mode: 0o700 });
  await writeFile(join(dist, 'package.json'), '{"type":"module"}\n');
  await copyFile(join(SOURCE, 'test/fixtures/openclaw-dist-compatible/runtime-fixture.js'), join(dist, 'runtime-fixture.js'));
  await copyFile(join(SOURCE, 'test/fixtures/openclaw-dist-compatible/agent-via-gateway-fixture.js'), join(dist, 'kernel/agent.js'));
  await writeFile(join(dist, 'proof.mjs'), TEMP_PROOF);
  await writeFile(join(dist, 'agent-via-gateway-owned.js'), [
    "import { agentCliCommand as kernel } from './kernel/agent.js'; import { proveTemporary } from './proof.mjs';",
    'export async function agentCliCommand(options,runtime) { await proveTemporary(options.message); return kernel(options,runtime); }',
  ].join('\n'));
  await writeFile(join(home, '.bash_profile'), 'export PATH="$HOME/.local/bin:$PATH"\n', { mode: 0o600 });
}
async function stageOps() {
  const ops = join(directory, 'ops');
  const files = ['scripts/container-adapter-supervisor.sh', 'scripts/container-adapter-supervisor-lib.sh', 'scripts/adapter-space-launcher.sh',
    'scripts/container-alias-query.py', 'scripts/container_alias_lib.py', 'scripts/fleet_derive.py',
    'scripts/fleet_runtime_inventory.py', 'scripts/fleet_runtime_materialization.py', 'scripts/atomic_file.py',
    'scripts/secure_path.py', 'scripts/pin-container-release.py', 'scripts/validate-container-mount.py',
    'scripts/alias-lock-exec.py', 'scripts/verify-hermes-runtime.py', 'container-runtime/cauce-container-runtime.py',
    'container-runtime/cauce_container_base.py', 'container-runtime/cauce_container_proc.py', 'container-runtime/cauce_container_lease.py',
    'container-runtime/cauce_container_tree.py', 'container-runtime/cauce_container_adoption.py',
    'container-runtime/cauce_container_restart.py', 'container-runtime/podar-releases.py'];
  for (const file of files) {
    await mkdir(dirname(join(ops, file)), { recursive: true }); await copyFile(join(ROOT, 'ops', file), join(ops, file));
  }
  await writeFile(join(ops, 'container-aliases.json'), JSON.stringify({ schemaVersion: 2, systemPrincipals: {}, historicalAliases: {},
    aliases: Object.fromEntries(runtimes.filter(row => !row.native).map(row => [row.alias, {
      tenant: 'Steven', room: 'grp.steven', container: row.container, user: row.user, home: row.home,
      harness: row.harness, stateDirectory: row.state, membershipRole: 'agent', systemdUser: row.rehearsal ? 'cauce' : 'stev',
      ...(row.harness === 'openclaw' ? { workspace: row.providerCwd } : {}),
    }])) }), { mode: 0o600 });
  environment = { ...process.env, CAUCE_CONTAINER_TEST_MODE: '1', CAUCE_CONTAINER_OPS_ROOT: ops,
    CAUCE_CONTAINER_CONFIG_ROOT: join(directory, 'config'), CAUCE_CONTAINER_BUNDLE_ROOT: join(directory, 'bundles'),
    CAUCE_CONTAINER_PKI_ROOT: join(directory, 'pki'), CAUCE_CONTAINER_LOCK_ROOT: join(directory, 'locks'),
    CAUCE_CONTAINER_CONTROL_ROOT: CONTROL, CAUCE_CONTAINER_WAIT_SECONDS: '0' };
}
async function seedRuntime(runtime: Runtime) {
  await pool().query('INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)' +
    " VALUES('Steven',$1,$2,true,$3,$4,$5,$6)", [runtime.alias, runtime.harness, runtime.container, runtime.user, runtime.home, runtime.state]);
  await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [runtime.alias]);
}
class ReapingContainer extends GenericContainer {
  constructor(image: string) {
    super(image);
    this.hostConfig.Init = true;
  }
}

async function provisionContainers(image: string) {
  const wsHome = join(directory, 'ws-home'), clawHome = join(directory, 'claw-home'), workspace = join(directory, 'workspace');
  for (const home of [wsHome, clawHome]) {
    await mkdir(home, { mode: 0o700 }); await stageProvider(home);
    for (const folder of ['.claude', '.codex', '.local/state/cauce-v3', 'clawd']) await mkdir(join(home, folder), { recursive: true, mode: 0o700 });
  }
  await mkdir(workspace, { mode: 0o700 }); await writeFile(join(workspace, 'legacy.marker'), RUN, { mode: 0o600 });
  await writeFile(join(clawHome, 'legacy.marker'), RUN, { mode: 0o600 });
  const ws = await new ReapingContainer(image).withName(PREFIX + '-ws').withLabels({ 'cauce.e2e.owner': OWNER, 'cauce.e2e.run': RUN })
    .withUser('0').withNetworkMode('host').withBindMounts([{ source: wsHome, target: '/home/node', mode: 'rw' },
      { source: workspace, target: '/workspace', mode: 'rw' }]).withWorkingDir('/workspace')
    .withCommand(['sleep', 'infinity']).withWaitStrategy(Wait.forSuccessfulCommand('id node')).start();
  containers.push(ws);
  const claw = await new ReapingContainer(image).withName(PREFIX + '-claw').withLabels({ 'cauce.e2e.owner': OWNER, 'cauce.e2e.run': RUN })
    .withUser('0').withNetworkMode('host').withBindMounts([{ source: clawHome, target: '/home/node', mode: 'rw' }])
    .withWorkingDir('/home/node').withCommand(['sleep', 'infinity']).withWaitStrategy(Wait.forSuccessfulCommand('id node')).start();
  containers.push(claw);
  for (const harness of ['claude', 'codex', 'openclaw'] as const) {
    const alias = 'zz-canary-s2-' + harness + '-' + RUN;
    const home = harness === 'openclaw' ? clawHome : wsHome;
    const state = '/home/node/.local/state/cauce-v3/' + alias;
    await mkdir(join(home, '.local/state/cauce-v3', alias), { mode: 0o700 });
    await writeFile(join(home, '.local/state/cauce-v3', alias, 'legacy.marker'), RUN, { mode: 0o600 });
    if (harness !== 'openclaw') {
      const config = join(home, '.local/share/cauce-v3/config', alias, '.' + harness);
      await mkdir(config, { recursive: true, mode: 0o700 });
      const documents = harness === 'claude' ? { 'CLAUDE.md': 'S2 synthetic provider\n', '.credentials.json': '{}\n', '.claude.json': '{}\n' }
        : { 'AGENTS.md': 'S2 synthetic provider\n', 'config.toml': '', 'auth.json': '{}\n' };
      for (const [name, content] of Object.entries(documents)) await writeFile(join(config, name), content, { mode: 0o600 });
    }
    runtimes.push({ alias, harness, container: harness === 'openclaw' ? PREFIX + '-claw' : PREFIX + '-ws',
      user: 'node', uid: 1000, home: '/home/node', state, cwd: harness === 'openclaw' ? '/home/node' : '/workspace',
      providerCwd: harness === 'openclaw' ? '/home/node/clawd' : '/workspace', native: false, log: '' });
  }
}
async function provisionNative() {
  const alias = 'zz-canary-s2-native-' + RUN, home = '/home/cauce';
  const runtime: Runtime = { alias, harness: 'codex', container: active().container, user: 'cauce', uid: 1500, home,
    state: home + '/.local/state/cauce-v3/' + alias, cwd: home + '/legacy-work', providerCwd: home + '/legacy-work',
    native: true, unit: 'cauce-v3-host-' + alias + '.service', log: '' };
  runtimes.push(runtime);
  const source = join(directory, 'native-home'); await mkdir(source, { mode: 0o700 }); await stageProvider(source);
  await docker(['cp', source + '/.', runtime.container + ':' + home]);
  await docker(['cp', release, runtime.container + ':' + home + '/s2-release']);
  await docker(['cp', LAUNCHER, runtime.container + ':' + home + '/adapter-space-launcher.sh']);
  await docker(['exec', runtime.container, 'chown', '1500:1500', home + '/.local']);
  await docker(['exec', runtime.container, 'chown', '-R', '1500:1500', ...[
    '.local/bin', 's2-kernels', 's2-openclaw-dist', 's2-release', 'adapter-space-launcher.sh', '.bash_profile',
  ].map(path => home + '/' + path)]);
  await docker(['exec', runtime.container, 'chmod', '0700', home + '/adapter-space-launcher.sh']);
  const setup = ['import pathlib,sys', 'home=pathlib.Path(sys.argv[1]);state=pathlib.Path(sys.argv[2]);work=pathlib.Path(sys.argv[3])',
    'for path in [state,work,home/".config/systemd/user",home/".codex"]: path.mkdir(parents=True,exist_ok=True,mode=0o700)',
    'state.chmod(0o700)', '(state/"legacy.marker").write_text(sys.argv[4]);(work/"legacy.marker").write_text(sys.argv[4])'].join('\n');
  const result = await active().onComputer(['python3', '-I', '-B', '-c', setup, home, runtime.state, runtime.cwd, RUN]);
  expect(result.code, result.stderr).toBe(0);
}

beforeAll(async () => {
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-/u, 'use scripts/e2e-lab.sh with CAUCE_E2E_CONTEXT=lab');
  assert.equal(process.getuid?.(), 1000);
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('own Testcontainers PostgreSQL is required');
  console.info('S2_STANDARD_SPACE_EVIDENCE', JSON.stringify({ owner: OWNER, run: RUN, directory: EVIDENCE, runner_uid: process.getuid() }));
  directory = await mkdtemp('/datos/' + PREFIX + '-');
  for (const folder of ['config', 'pki', 'locks']) await mkdir(join(directory, folder), { mode: 0o700 });
  await buildBundle();
  computer = await startComputerHarness({ prefix: PREFIX + '-native-host', consoleOrigins: [], resourceOwner: OWNER, workRoot: '/datos',
    extraSourceFiles: HARNESS_SOURCE_FILES });
  const image = 'cauce-e2e-lab-runner:' + createHash('sha256').update(await readFile(join(ROOT, 'tests/e2e/lab-runner/Dockerfile'))).digest('hex').slice(0, 12);
  await provisionContainers(image); await provisionNative();
  if (REHEARSAL) await addRehearsalRuntimes({ directory, run: RUN, computer: active(), runtimes });
  await stageOps();
  const seededLegacy = new Set<string>();
  for (const runtime of runtimes) {
    const paths = [...new Set([runtime.state, runtime.cwd, runtime.providerCwd])].filter(path => {
      const key = runtime.container + ':' + path;
      if (seededLegacy.has(key)) return false;
      seededLegacy.add(key); return true;
    });
    await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
      ['import pathlib,sys', 'for value in dict.fromkeys(sys.argv[2:]):',
        ' path=pathlib.Path(value);path.mkdir(parents=True,exist_ok=True,mode=0o700)',
        ' marker=path/"legacy.marker";marker.write_text(sys.argv[1]);marker.chmod(0o600)',
        ' (path/"legacy.link").symlink_to("legacy.marker")'].join('\n'), RUN, ...paths]);
  }
  publisherTls = createSelfSignedCert({ directory });
  const workers = runtimes.map(() => createSelfSignedCert({ directory }));
  const identities = join(directory, 'identities.json');
  const publisher = 'zz-canary-s2-publisher-' + RUN;
  const password = randomUUID();
  const database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
    .withName(PREFIX + '-postgres').withLabels({ 'cauce.e2e.owner': OWNER, 'cauce.e2e.run': RUN })
    .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
    .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
    .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
    .withWaitStrategy(Wait.forHealthCheck()).start());
  containers.push(database);
  databasePool = createPool('postgresql://cauce_test:' + encodeURIComponent(password) + '@' + database.getHost()
    + ':' + String(database.getMappedPort(5432)) + '/cauce_test');
  await applyMigrationsThrough(pool(), '047_agent_preferences.sql');
  for (const runtime of runtimes) await seedRuntime(runtime);
  await pool().query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES('Steven',$1,'codex',false)", [publisher]);
  await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [publisher]);
  await applyMigrations(pool());
  const baselines = (await pool().query<{ alias: string; runtime_key: string; baseline: boolean; runtime_mode: string | null }>(
    `SELECT agent.alias,agent.runtime_key,identity.baseline,agent.runtime_mode FROM agents agent
       JOIN fleet_runtime_identities identity USING(tenant_id,alias,runtime_key)
      WHERE agent.tenant_id='Steven' AND agent.alias=ANY($1::text[]) ORDER BY agent.alias`, [runtimes.map(runtime => runtime.alias)])).rows;
  expect(baselines).toHaveLength(runtimes.length);
  for (const row of baselines) expect(row).toMatchObject({ runtime_key: row.alias, baseline: true, runtime_mode: null });
  await save('postgres-baselines', baselines);
  const principals = [{ alias: publisher, material: publisherTls }, ...runtimes.map((runtime, index) => {
    const material = workers[index]; assert.ok(material); return { alias: runtime.alias, material };
  })];
  await writeFile(identities, JSON.stringify({ version: 1, identities: principals.map(({ alias, material }) => ({
    certificate_sha256: new X509Certificate(material.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    principal: { tenant_id: 'Steven', alias, session_id: 'canary:' + RUN, channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] },
  })) }), { mode: 0o600 });
  const machineAuth = new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities));
  const consoleAuth = REHEARSAL ? await prepareRehearsalAuth(pool(), machineAuth, publisher, RUN) : undefined;
  app = await buildGateway({ pool: pool(), logger: false, outboxPollMs: 10, leaseTtlMs: 30_000,
    authProvider: consoleAuth?.provider ?? machineAuth, ...(consoleAuth ? { consoleOrigins: [consoleAuth.origin] } : {}),
    https: { cert: publisherTls.cert, key: publisherTls.key, ca: [publisherTls.cert, ...workers.map(row => row.cert)],
      requestCert: true, rejectUnauthorized: !REHEARSAL } });
  await app.listen({ host: '0.0.0.0', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  origin = 'https://127.0.0.1:' + String(address.port);
  for (const [index, runtime] of runtimes.entries()) {
    const material = workers[index]; assert.ok(material);
    const pki = join(directory, 'pki', runtime.alias); await mkdir(pki, { mode: 0o700 });
    for (const [name, content] of [['client.crt', material.cert], ['client.key', material.key], ['ca.crt', publisherTls.cert]] as const) {
      await writeFile(join(pki, name), content, { mode: 0o600 });
    }
    if (runtime.native) {
      assert.ok(runtime.unit);
      const nativePki = runtime.home + (runtime.rehearsal ? '/s2b-pki-' + runtime.alias : '/s2-pki');
      await docker(['cp', pki, runtime.container + ':' + nativePki]);
      await docker(['exec', runtime.container, 'chown', '-R', '1500:1500', nativePki]);
      const sdk = runtime.home + '/s2-release/packages/adapter-sdk/dist';
      const unit = ['[Unit]', 'Description=Owned standard-space native adapter', '[Service]', 'Type=simple',
        'WorkingDirectory=' + runtime.cwd,
        'Environment=HOME=' + runtime.home, 'Environment=PATH=' + runtime.home + '/.local/bin:/usr/local/bin:/usr/bin:/bin',
        'Environment=NODE_ENV=production', 'Environment=CAUCE_ENVIRONMENT=production', 'Environment=CAUCE_ORIGIN_TRANSPORT=telegram',
        'Environment=CAUCE_TENANT=Steven', 'Environment=CAUCE_ROOM=grp.steven', 'Environment=CAUCE_ALIAS=' + runtime.alias,
        'Environment=CAUCE_INSTANCE_ID=systemd-' + runtime.alias, 'Environment=CAUCE_STATE_DIR=' + runtime.state,
        'Environment=CODEX_HOME=' + runtime.home + '/.codex', 'Environment=CAUCE_RELAY_URL=' + origin.replace('https:', 'wss:') + '/v3/ws',
        'Environment=CAUCE_TLS_CERT_FILE=' + nativePki + '/client.crt',
        'Environment=CAUCE_TLS_KEY_FILE=' + nativePki + '/client.key',
        'Environment=CAUCE_TLS_CA_FILE=' + nativePki + '/ca.crt',
        'ExecStart=' + (runtime.rehearsal ? '/usr/local/bin/node "--conditions=owned extra argument" ' + sdk + '/src/bin/codex.js --alias ' + runtime.alias
          : runtime.home + '/adapter-space-launcher.sh /usr/local/bin/node ' + sdk + '/src/context/space-layout.js -- /usr/local/bin/node ' + sdk + '/src/bin/codex.js'),
        'KillMode=control-group', 'TimeoutStopSec=20', ''].join('\n');
      const stagedUnit = join(directory, runtime.unit ?? 'missing'); await writeFile(stagedUnit, unit, { mode: 0o600 });
      const unitPath = runtime.home + '/.config/systemd/user/' + runtime.unit;
      await docker(['cp', stagedUnit, runtime.container + ':' + unitPath]);
      await docker(['exec', runtime.container, 'chown', '1500:1500', unitPath]);
      const result = await active().onComputer(['systemctl', '--user', 'daemon-reload']); expect(result.code, result.stderr).toBe(0);
    } else {
      const source = runtime.harness === 'openclaw' ? join(directory, 'claw-home') : join(directory, 'ws-home');
      const imageId = (await shell('docker', ['inspect', '--format', '{{.Image}}', runtime.container])).stdout.trim();
      const config = { BUNDLE_RELEASE: 'candidate', BUNDLE_SHA256: bundleDigest, PKI_DIR: pki,
        RELAY_URL: origin.replace('https:', 'wss:') + '/v3/ws', EXPECTED_IMAGE_ID: imageId,
        EXPECTED_LABEL_KEY: 'cauce.e2e.owner', EXPECTED_LABEL_VALUE: OWNER, MOUNT_TYPE: 'bind', MOUNT_SOURCE: source,
        MOUNT_DESTINATION: '/home/node', MOUNT_RW: 'true', CAUCE_SEMBRAR_PERFIL: '1',
        ...(runtime.harness !== 'openclaw' ? { CONFIG_POR_ALIAS: '1' } : {}),
        ...(runtime.harness === 'claude' ? { EXPECTED_CLI_VERSION: '2.1.0' } : {}),
        ...(runtime.harness === 'openclaw' ? { OPENCLAW_TRANSPORT: 'cli', OPENCLAW_DIST_DIR: '/home/node/s2-openclaw-dist',
          OPENCLAW_WORKSPACE: '/home/node/clawd' } : {}) };
      await writeFile(join(directory, 'config', runtime.alias + '.env'),
        Object.entries(config).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 });
    }
  }
  if (consoleAuth) rehearsal = await configureRehearsal({ root: ROOT, directory, owner: OWNER, run: RUN, release,
    bundleDigest, computer: active(), pool: pool(), runtimes, consoleAuth, gateway: origin, certificate: publisherTls.cert_path, save,
    ...(PREPARED_COMMIT === undefined ? {} : { preparedCommit: PREPARED_COMMIT }) });
}, 900_000);

async function start(runtime: Runtime) {
  runtime.startAttempted = true;
  const previousFingerprint = runtime.leaseFingerprint;
  let lease: { epoch: number; connected_at: string; token_rotated: boolean } | undefined;
  if (runtime.unit) {
    const result = await active().onComputer(['systemctl', '--user', 'start', runtime.unit ?? 'missing']);
    expect(result.code, result.stderr).toBe(0);
  } else {
    const child = spawn('bash', [SUPERVISOR, 'start', runtime.alias], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    runtime.child = child;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { runtime.log = (runtime.log + chunk.toString()).slice(-16_384); });
  }
  await expect.poll(async () => {
    if (runtime.child && runtime.child.exitCode !== null) throw new Error('canonical supervisor exited: ' + runtime.log);
    try { if (!(await inspect(runtime)).adapter) return false; }
    catch { return false; }
    const row = (await pool().query<{ epoch: string; connected_at: string; fingerprint: string }>(
      `SELECT epoch,connected_at::text,encode(digest(connection_token::text,'sha256'),'hex') AS fingerprint
         FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>clock_timestamp()`, [runtime.alias])).rows[0];
    if (!row || !Number.isSafeInteger(Number(row.epoch)) || Number(row.epoch) < 1 || row.fingerprint === previousFingerprint) return false;
    runtime.leaseFingerprint = row.fingerprint;
    lease = { epoch: Number(row.epoch), connected_at: row.connected_at,
      token_rotated: previousFingerprint !== undefined && row.fingerprint !== previousFingerprint };
    return true;
  },
  { timeout: 45_000, interval: 250, message: 'real adapter did not acquire a new fenced lease' }).toBe(true);
  assert.ok(lease); return lease;
}
async function stop(runtime: Runtime) {
  if (runtime.unit) {
    const result = await active().onComputer(['systemctl', '--user', 'stop', runtime.unit ?? 'missing']);
    expect(result.code, result.stderr).toBe(0);
  } else {
    await shell('bash', [SUPERVISOR, 'stop', runtime.alias], environment);
    await shell('bash', [SUPERVISOR, 'stopped', runtime.alias], environment);
  }
  const lease = (await pool().query<{ epoch: string; connected_at: string; lease_until: string; live: boolean }>(
    `SELECT epoch,connected_at::text,lease_until::text,lease_until>clock_timestamp() AS live
       FROM connection_leases WHERE tenant_id='Steven' AND alias=$1`, [runtime.alias])).rows[0] ?? null;
  runtime.startAttempted = false;
  return lease;
}
async function verifyStopped(runtime: Runtime, observed: Probe) {
  const absent = await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
    'import pathlib,sys;p=pathlib.Path("/proc")/sys.argv[1];print(not p.exists() or (p/"stat").read_text().split(") ",1)[1].split()[19]!=sys.argv[2])',
    String(observed.pid), observed.ticks]);
  expect(absent.trim()).toBe('True');
}
const LEGACY_PROBE = [
  'def legacy_probe(values):',
  ' result={}',
  ' for value in dict.fromkeys(values):',
  '  path=pathlib.Path(value);s=path.lstat();marker=path/"legacy.marker";m=marker.lstat();link=path/"legacy.link";l=link.lstat()',
  '  assert stat.S_ISLNK(l.st_mode)',
  '  result[value]={"inode":s.st_ino,"directory":stat.S_ISDIR(s.st_mode),"symlink":path.is_symlink(),',
  '   "marker":{"inode":m.st_ino,"uid":m.st_uid,"mode":oct(stat.S_IMODE(m.st_mode)),"regular":stat.S_ISREG(m.st_mode),"content":marker.read_text()},',
  '   "link":{"inode":l.st_ino,"target":os.readlink(link),"resolved":str(link.resolve(strict=True)),"target_inode":link.stat().st_ino,"content":link.read_text()}}',
  ' return result',
].join('\n');
async function inspectLegacy(runtime: Runtime): Promise<Legacy> {
  return JSON.parse(await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
    'import json,os,pathlib,stat,sys\n' + LEGACY_PROBE + '\nprint(json.dumps(legacy_probe(sys.argv[1:])))',
    runtime.state, runtime.cwd, runtime.providerCwd])) as Legacy;
}
const PROBE = [
  'import json,os,pathlib,stat,sys',
  LEGACY_PROBE,
  'pid=sys.argv[1];state=pathlib.Path(sys.argv[2]);proc=pathlib.Path("/proc")/pid',
  'env=dict(entry.decode().split("=",1) for entry in (proc/"environ").read_bytes().split(bytes([0])) if b"=" in entry)',
  'root=pathlib.Path(env.get("CAUCE_SPACE_ROOT",str(state/"space")));layout={}',
  'for name in ([".","context","directives","projects","config","data","logs","tmp"] if "CAUCE_SPACE_ROOT" in env else []):',
  ' path=root/name;s=path.lstat();layout[name]={"mode":oct(stat.S_IMODE(s.st_mode)),"uid":s.st_uid,"inode":s.st_ino,"directory":stat.S_ISDIR(s.st_mode),"symlink":path.is_symlink()}',
  'cmd=(proc/"cmdline").read_bytes().split(bytes([0]));cwd=os.readlink(proc/"cwd")',
  'uid=next(line.split()[1:] for line in (proc/"status").read_text().splitlines() if line.startswith("Uid:"))',
  'print(json.dumps({"pid":int(pid),"ticks":(proc/"stat").read_text().split(") ",1)[1].split()[19],"uid":{"real":int(uid[0]),"effective":int(uid[1])},"cwd":cwd,',
  ' "adapter":any(b"/dist/src/bin/" in value for value in cmd),"environment":{key:env.get(key) for key in ["CAUCE_SPACE_ROOT","TMPDIR"]},',
  ' "layout":layout,"legacy":legacy_probe(sys.argv[2:])}))',
].join('\n');
async function inspect(runtime: Runtime): Promise<Probe> {
  const pid = runtime.native ? (await active().onComputer(['systemctl', '--user', 'show', runtime.unit ?? 'missing', '--property=MainPID', '--value'])).stdout.trim()
    : String((JSON.parse(await docker(['exec', '--user', '0', runtime.container, 'cat', CONTROL + '/' + runtime.alias + '/cauce-v3-adapter.json'])) as { pid: number }).pid);
  return JSON.parse(await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c', PROBE,
    pid, runtime.state, runtime.cwd, runtime.providerCwd])) as Probe;
}
async function send(runtime: Runtime, marker: string) {
  const tls = publisherTls; assert.ok(tls);
  const body = JSON.stringify({ room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: runtime.alias }],
    body: { text: marker }, idempotency_key: randomUUID() });
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(origin + '/v3/messages', { method: 'POST', ca: tls.cert, cert: tls.cert, key: tls.key,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
      let response = ''; incoming.setEncoding('utf8'); incoming.on('data', (chunk: string) => { response += chunk; });
      incoming.once('error', reject); incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, body: response }); });
    }); outgoing.once('error', reject); outgoing.end(body);
  });
  expect(result.status, result.body).toBe(202);
  const published = PublishResultSchema.parse(JSON.parse(result.body));
  const id = published.delivery_ids[0]; assert.ok(id);
  let delivery: { status: string; error: string | null } | undefined;
  await expect.poll(async () => {
    delivery = (await pool().query<{ status: string; error: string | null }>(
      'SELECT status,last_error AS error FROM deliveries WHERE id=$1 AND recipient_alias=$2', [id, runtime.alias])).rows[0];
    return ['done', 'dead', 'cancelled', 'expired'].includes(delivery?.status ?? '');
  }, { timeout: 45_000, interval: 250 }).toBe(true);
  expect(delivery?.status, JSON.stringify({ error: delivery?.error, log: runtime.log })).toBe('done');
  const proof = ['import json,pathlib,sys', 'root=pathlib.Path(sys.argv[1]);marker=sys.argv[2]',
    'paths=list(root.glob(marker+"-*/proof.json"));assert len(paths)==1',
    'proof=json.loads(paths[0].read_text());proof["path"]=str(paths[0]);print(json.dumps(proof))'].join('\n');
  const observed = JSON.parse(await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
    proof, runtime.state + '/space/tmp', marker])) as { marker: string; cwd: string; tmpdir: string; path: string };
  expect(observed.marker).toBe(marker); expect(observed.cwd).toBe(runtime.providerCwd);
  expect(observed.tmpdir).toBe(runtime.state + '/space/tmp');
  expect(observed.path.startsWith(runtime.state + '/space/tmp/')).toBe(true);
  return { delivery_id: id, status: delivery?.status, temporary: observed };
}

describe.sequential('standard space through the real legacy startup interfaces', () => {
  for (const kind of ['claude', 'codex', 'openclaw', 'native'] as const) {
    it(kind + ': preserves legacy cwd, exports the layout, executes a turn and restarts without moving data', async () => {
      const runtime = runtimes.find(row => kind === 'native' ? row.native : !row.native && row.harness === kind); assert.ok(runtime);
      const legacy = await inspectLegacy(runtime);
      for (const [path, entry] of Object.entries(legacy)) {
        expect(entry).toMatchObject({ directory: true, symlink: false,
          marker: { uid: runtime.uid, mode: '0o600', regular: true, content: RUN },
          link: { target: 'legacy.marker', resolved: path + '/legacy.marker', target_inode: entry.marker.inode, content: RUN } });
      }
      await save(kind + '-legacy-before', legacy);
      const startedAt = Date.now();
      const firstLease = await start(runtime);
      const firstReadyAt = Date.now();
      const first = await inspect(runtime);
      expect(first.adapter).toBe(true); expect(first.cwd).toBe(runtime.cwd); expect(first.legacy).toEqual(legacy);
      expect(first.uid).toEqual({ real: runtime.uid, effective: runtime.uid });
      expect(first.environment).toEqual({ CAUCE_SPACE_ROOT: runtime.state + '/space', TMPDIR: runtime.state + '/space/tmp' });
      for (const entry of Object.values(first.layout)) expect(entry).toMatchObject({ mode: '0o700', uid: runtime.uid, directory: true, symlink: false });
      const turn = await send(runtime, 'S2_TEMP_' + runtime.alias + '-first');
      const firstDoneAt = Date.now(), restartAt = Date.now();
      const firstStoppedLease = await stop(runtime); await verifyStopped(runtime, first);
      const secondLease = await start(runtime);
      const restartedReadyAt = Date.now();
      const second = await inspect(runtime);
      expect(second.pid).not.toBe(first.pid); expect(second.ticks).not.toBe(first.ticks);
      expect(secondLease.token_rotated).toBe(true);
      expect(second.cwd).toBe(first.cwd); expect(second.environment).toEqual(first.environment);
      expect(second.legacy).toEqual(legacy); expect(second.layout).toEqual(first.layout); expect(second.uid).toEqual(first.uid);
      const restartedTurn = await send(runtime, 'S2_TEMP_' + runtime.alias + '-second');
      const restartedDoneAt = Date.now();
      const finalStoppedLease = await stop(runtime);
      await verifyStopped(runtime, second);
      await save(kind, { alias: runtime.alias, adapter_cwd: runtime.cwd, provider_cwd: runtime.providerCwd,
        legacy_before: legacy, first, turn, second, restarted_turn: restartedTurn, stopped_verified: true,
        lifecycle: { first_lease: firstLease, previous_adapter_stopped: true, previous_stopped_lease: firstStoppedLease,
          restarted_lease: secondLease, final_stopped_lease: finalStoppedLease },
        timing_ms: { start_to_ready: firstReadyAt - startedAt, start_to_first_done: firstDoneAt - startedAt,
          stop_and_restart_to_ready: restartedReadyAt - restartAt, stop_and_restart_to_second_done: restartedDoneAt - restartAt,
          final_stop_verified: Date.now() - restartedDoneAt } });
    }, 240_000);
  }
  it('keeps temporaries isolated between aliases sharing the same workspace and uid', async () => {
    for (const runtime of runtimes.filter(row => !row.rehearsal)) {
      const names = JSON.parse(await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
        'import json,pathlib,sys;print(json.dumps(sorted(p.name for p in pathlib.Path(sys.argv[1]).iterdir() if p.name.startswith("S2_TEMP_"))))',
        runtime.state + '/space/tmp'])) as string[];
      expect(names).toHaveLength(2);
      expect(names.every(name => name.startsWith('S2_TEMP_' + runtime.alias + '-'))).toBe(true);
    }
    await save('isolation', { aliases: runtimes.map(row => row.alias), shared_workspace_aliases: runtimes.filter(row => row.cwd === '/workspace').map(row => row.alias),
      temporary_directories_per_alias: 2, isolated: true });
  });
  it('rejects nonprivate existing layouts and an ancestor symlink before starting the native command', async () => {
    const native = runtimes.find(row => row.native); assert.ok(native);
    const root = native.home + '/s2-invalid-layouts', module = native.home + '/s2-release/packages/adapter-sdk/dist/src/context/space-layout.js';
    const setup = ['import json,pathlib,sys', 'root=pathlib.Path(sys.argv[1]);root.mkdir(mode=0o700);paths=[]',
      'for name in ["state-mode","space-mode","child-mode"]:',
      ' state=root/name;state.mkdir(mode=0o700)',
      ' if name=="state-mode":state.chmod(0o755)',
      ' else:',
      '  space=state/"space";space.mkdir(mode=0o700)',
      '  if name=="space-mode":space.chmod(0o755)',
      '  else:(space/"context").mkdir(mode=0o755)',
      ' paths.append(str(state))',
      'real=root/"real";real.mkdir(mode=0o700);(real/"state").mkdir(mode=0o700);(root/"link").symlink_to(real,target_is_directory=True)',
      'paths.append(str(root/"link/state"));print(json.dumps(paths))'].join('\n');
    const prepared = await active().onComputer(['python3', '-I', '-B', '-c', setup, root]);
    expect(prepared.code, prepared.stderr).toBe(0);
    const paths = JSON.parse(prepared.stdout) as string[], outcomes: { state: string; code: number }[] = [];
    for (const state of paths) {
      const result = await active().onComputer(['env', 'CAUCE_STATE_DIR=' + state, native.home + '/adapter-space-launcher.sh',
        '/usr/local/bin/node', module, '--', '/usr/bin/touch', root + '/unexpected-command']);
      expect(result.code, result.stderr).toBe(78);
      expect(result.stdout).toBe('');
      outcomes.push({ state, code: result.code });
    }
    const untouched = await active().onComputer(['test', '!', '-e', root + '/unexpected-command']);
    expect(untouched.code).toBe(0);
    await save('native-invalid-layouts', { outcomes, original_command_started: false });
  });
  if (REHEARSAL) for (const native of [false, true]) {
    it('deployment tool: simulates, applies, verifies and reverts a real ' + (native ? 'native' : 'container') + ' unit', async () => {
      assert.ok(rehearsal);
      const runtime = runtimes.find(row => row.rehearsal && row.native === native); assert.ok(runtime);
      await runRehearsal(rehearsal, runtime, { start, stop, inspect, inspectLegacy, verifyStopped, save });
    }, 600_000);
  }
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const runtime of runtimes) {
    if (runtime.startAttempted) try { await stop(runtime); } catch (error) { failures.push(error); }
    if (runtime.child?.exitCode === null) runtime.child.kill('SIGTERM');
  }
  for (const cleanup of [async () => app?.close(), async () => databasePool?.end(), ...containers.map(container => async () => container.stop()),
    async () => computer?.close(), async () => {
      if (directory) {
        await shell('find', ['-P', directory, '-type', 'd', '-exec', 'chmod', 'u+w', '--', '{}', '+']);
        await rm(directory, { recursive: true, force: true });
      }
    }]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  const remaining: Record<string, string> = {};
  for (const [kind, args] of [['containers', ['ps', '-aq', '--filter', 'name=^/' + PREFIX]],
    ['volumes', ['volume', 'ls', '-q', '--filter', 'name=' + PREFIX]],
    ['images', ['image', 'ls', '-q', '--filter', 'reference=' + PREFIX + '*']]] as const) {
    try { remaining[kind] = await docker([...args]); expect(remaining[kind]).toBe(''); }
    catch (error) { failures.push(error); }
  }
  await save('cleanup', { remaining, failures: failures.length, result: failures.length ? 'FAIL' : 'PASS' });
  if (failures.length) throw new AggregateError(failures, 'owned standard-space cleanup failed');
}, 240_000);
