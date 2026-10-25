import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PublishResultSchema } from '@cauce/protocol';
import { applyMigrations, applyMigrationsThrough, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

export const OWNER = 't3-adaptador-vivo-1025';
export const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', OWNER);
const ROOT = process.cwd();
const execute = promisify(execFile);
export async function command(file: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 120_000) {
  return execute(file, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 });
}
export async function receipt(name: string, value: unknown): Promise<void> {
  await mkdir(RECEIPTS, { recursive: true });
  await writeFile(join(RECEIPTS, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export async function waitFor<T>(operation: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await delay(150);
  }
  throw new Error('Owned live adapter condition did not become true before its deadline');
}

async function buildBundle(directory: string, reference: string, name: string) {
  const ref = (await command('git', ['rev-parse', reference])).stdout.trim();
  const source = join(directory, `source-${name}`), bundle = join(RECEIPTS, `bundle-${ref}`);
  const identity = join(RECEIPTS, `bundle-${ref}.json`);
  const existing = await readFile(identity, 'utf8').then(text => JSON.parse(text) as { ref: string; digest: string }, () => undefined);
  if (existing) {
    const digest = (await command('python3', [join(ROOT, 'ops/container-runtime/cauce-container-runtime.py'), 'bundle-digest', bundle])).stdout.trim();
    assert.equal(existing.ref, ref); assert.equal(existing.digest, digest);
    assert.equal((await readFile(join(bundle, '.release-sha'), 'utf8')).trim(), ref);
    return { ref, bundle, digest, name: `lab-${ref.slice(0, 12)}` };
  }
  await command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', ROOT, source]);
  await command('git', ['-C', source, 'checkout', '--quiet', '--detach', ref]);
  await execute('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/datos/.pnpm-store'],
    { cwd: source, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const built = await command('bash', [join(source, 'ops/scripts/build-adapter-release.sh'), bundle], process.env, 600_000);
  await writeFile(join(RECEIPTS, `build-${name}.log`), built.stdout + built.stderr, { mode: 0o600 });
  await chmod(bundle, 0o755);
  await writeFile(join(bundle, '.release-sha'), `${ref}\n`, { mode: 0o444 });
  await chmod(bundle, 0o555);
  const digest = (await command('python3', [join(ROOT, 'ops/container-runtime/cauce-container-runtime.py'), 'bundle-digest', bundle])).stdout.trim();
  await writeFile(identity, JSON.stringify({ ref, digest, builder: 'ops/scripts/build-adapter-release.sh' }), { mode: 0o600 });
  return { ref, bundle, digest, name: `lab-${ref.slice(0, 12)}` };
}

const CLAUDE = String.raw`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
if(process.argv.includes('--version')){console.log('2.1.0 controlled-lab');process.exit(0);}
const home=process.env.HOME;const config=process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude');
const dir=path.join(config,'projects',process.cwd().replace(/\//g,'-'));fs.mkdirSync(dir,{recursive:true});
const session=crypto.randomUUID();const transcript=path.join(dir,session+'.jsonl');let buffer='',paste='',typed='',lastOutput='';
let submits=0;const stateFile=path.join(home,'controlled-tui-state.json');
const state=value=>fs.writeFileSync(stateFile,JSON.stringify({submits,bufferLength:buffer.length,pasteLength:paste.length,...value}));
const screen=()=>{const draft=(paste+typed+buffer).replaceAll('\x1b[200~','').replaceAll('\x1b[201~','');
const lines=draft.replace(/\r\n?/g,'\n').split('\n');const column=(lines.length===1?2:0)+lines.at(-1).length;
process.stdout.write('\x1b[2J\x1b[H'+(lastOutput?lastOutput+'\r\n':'')+'─'.repeat(60)+'\r\n❯ '+lines.join('\r\n')
+'\r\n'+'─'.repeat(60)+'\x1b[1A\r'+(column?'\x1b['+column+'C':''));};
function append(value){fs.appendFileSync(transcript,JSON.stringify(value)+'\n');}
function submit(){if(!paste)return;submits+=1;const text=paste;paste='';const user=crypto.randomUUID();
append({type:'user',uuid:user,parentUuid:null,isSidechain:false,promptSource:'typed',sessionId:session,message:{role:'user',content:text}});
const error=fs.existsSync(path.join(home,'api-error'));const id=/"cauce_correlation_id":"([a-f0-9]{64})"/.exec(text)?.[1];
const output=error?'PRIVATE_PROVIDER_ERROR':JSON.stringify({reply:'LIVE_RELEASE_CANARY_DONE',messages:[],status:'done',retryable:false,artifacts:[],cauce_correlation_id:id});
append({type:'assistant',uuid:crypto.randomUUID(),parentUuid:user,isSidechain:false,sessionId:session,
...(error?{isApiErrorMessage:true}:{}),message:{role:'assistant',stop_reason:error?'stop_sequence':'end_turn',content:[{type:'text',text:output}]}});state({correlationFound:!!id,stopReason:error?'stop_sequence':'end_turn'});typed='';lastOutput=output;}
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdout.write('\x1b[?2004h');screen();state({ready:true});
process.stdin.on('data',chunk=>{buffer+=chunk;state({inputReceived:true});while(buffer.length){if(buffer.startsWith('\x1b[200~')){const end=buffer.indexOf('\x1b[201~');if(end<0)break;paste=buffer.slice(6,end).replace(/\r\n?/g,'\n');buffer=buffer.slice(end+6);state({pasteReceived:true});continue;}if(buffer.startsWith('\x1b')&&buffer.length<6)break;const c=buffer[0];buffer=buffer.slice(1);if(c==='\r'||c==='\n')submit();else typed+=c;}screen();});
`;

const OPENCLAW_AGENT = `import { existsSync } from 'node:fs';
export async function agentCliCommand(request) {
  const text = typeof request?.message === 'string' ? request.message : '';
  const id = /"cauce_correlation_id":"([a-f0-9]{64})"/.exec(text)?.[1];
  if (existsSync((process.env.HOME ?? '') + '/api-error')) return { ok: false, error: 'terminal API error synthetic' };
  const output = JSON.stringify({ reply: 'LIVE_RELEASE_CANARY_DONE', messages: [], status: 'done', retryable: false, artifacts: [], ...(id === undefined ? {} : { cauce_correlation_id: id }) });
  return { payloads: [{ text: output }] };
}
`;

const OPENCLAW_RUNTIME = `export const defaultRuntime = { log() {}, error() {} };
`;

interface Delivery { id: string; status: string; last_error: string | null; terminal_at: Date | null; error_code: string | null }
interface Metadata { phase: string; pid: number; starttime: number; bundleDigest: string; executable: { path: string } }

export async function startLiveAdapterFixture(options: { harness?: 'claude' | 'openclaw' } = {}) {
  const harness = options.harness ?? 'claude';
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-/u, 'Run this suite with scripts/e2e-lab.sh');
  assert.equal(process.getuid?.(), 1000);
  await mkdir(RECEIPTS, { recursive: true });
  const directory = await mkdtemp('/tmp/zz-canary-t3-release-');
  const run = randomUUID().slice(0, 8), alias = `zz-canary-t3-${run}`, publisher = `zz-canary-t3-pub-${run}`;
  const containerName = `zz-canary-${OWNER}-${run}`, stateDirectory = `/home/node/.local/state/cauce-v3/${alias}`;
  const databaseName = `zz-canary-${OWNER}-pg-${run}`;
  const roots = Object.fromEntries(['config', 'bundle', 'pki', 'locks', 'ops', 'home'].map(name => [name, join(directory, name)])) as Record<'config' | 'bundle' | 'pki' | 'locks' | 'ops' | 'home', string>;
  const controlRoot = '/run/zz-canary-t3-supervisor';
  const tls = createSelfSignedCert({ directory });
  const workerTls = createSelfSignedCert({ directory });
  let database: StartedTestContainer | undefined, runtime: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined, app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  const children: ChildProcess[] = [];
  const probeServer = createServer();
  const supervisor = join(ROOT, 'ops/scripts/container-adapter-supervisor.sh');
  const environment: NodeJS.ProcessEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    CAUCE_CONTAINER_TEST_MODE: '1', CAUCE_CONTAINER_OPS_ROOT: roots.ops, CAUCE_CONTAINER_CONFIG_ROOT: roots.config,
    CAUCE_CONTAINER_BUNDLE_ROOT: roots.bundle, CAUCE_CONTAINER_PKI_ROOT: roots.pki,
    CAUCE_CONTAINER_LOCK_ROOT: roots.locks, CAUCE_CONTAINER_CONTROL_ROOT: controlRoot, CAUCE_CONTAINER_WAIT_SECONDS: '0',
  };
  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    const cleanup: Record<string, unknown> = { alias, containerName, databaseName };
    if (runtime && children.length > 0) {
      try {
        await command('bash', [supervisor, 'stop', alias], environment);
        await command('bash', [supervisor, 'stopped', alias], environment);
        cleanup.adapterStoppedVerified = true;
        if (pool) {
          const activePool = pool;
          cleanup.activeLeases = await waitFor(async () => {
            const count = Number((await activePool.query<{ count: string }>(
              "SELECT count(*)::text FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now()", [alias])).rows[0]?.count);
            return count === 0 ? count : undefined;
          }, 45_000);
          cleanup.deliveries = (await pool.query<{ status: string; count: string }>(
            'SELECT status,count(*)::text FROM deliveries WHERE recipient_alias=$1 GROUP BY status ORDER BY status', [alias])).rows;
        }
      } catch (error) { failures.push(error); }
    }
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    for (const remove of [async () => new Promise<void>(resolve => { probeServer.close(() => { resolve(); }); }),
      async () => app?.close(), async () => pool?.end(), async () => runtime?.stop(), async () => database?.stop(),
      async () => { await command('find', [directory, '-type', 'd', '-exec', 'chmod', 'u+w', '{}', '+']); await rm(directory, { recursive: true, force: true }); }]) {
      try { await remove(); } catch (error) { failures.push(error); }
    }
    for (const [field, name] of [['runtimeRemoved', containerName], ['databaseRemoved', databaseName]] as const) {
      try {
        const remaining = (await command('docker', ['container', 'ls', '-aq', '--filter', `name=^/${name}$`])).stdout.trim();
        assert.equal(remaining, ''); cleanup[field] = true;
      } catch (error) { failures.push(error); }
    }
    await receipt('cleanup', { ...cleanup, failureCount: failures.length, result: failures.length ? 'FAIL' : 'PASS' });
    if (failures.length) throw new AggregateError(failures, 'Owned live adapter cleanup failed');
  };
  try {
    const old = await buildBundle(directory, '5464c84e^', 'old');
    const candidate = await buildBundle(directory, '5464c84e', 'new');
    await Promise.all(Object.values(roots).map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    await mkdir(join(roots.bundle, 'releases'), { mode: 0o700 });
    await cp(old.bundle, join(roots.bundle, 'releases', old.name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    const opsFiles = ['scripts/container-alias-query.py', 'scripts/container_alias_lib.py', 'scripts/fleet_derive.py',
      'scripts/fleet_runtime_inventory.py', 'scripts/fleet_runtime_materialization.py', 'scripts/atomic_file.py',
      'scripts/secure_path.py', 'scripts/pin-container-release.py', 'scripts/validate-container-mount.py',
      'scripts/alias-lock-exec.py', 'scripts/verify-hermes-runtime.py', 'container-runtime/cauce-container-runtime.py',
      'container-runtime/cauce_container_base.py', 'container-runtime/cauce_container_proc.py',
      'container-runtime/cauce_container_lease.py',
      'container-runtime/cauce_container_tree.py', 'container-runtime/cauce_container_adoption.py',
      'container-runtime/cauce_container_restart.py', 'container-runtime/podar-releases.py'];
    for (const file of opsFiles) { await mkdir(join(roots.ops, file, '..'), { recursive: true }); await copyFile(join(ROOT, 'ops', file), join(roots.ops, file)); }
    const openClawWorkspace = '/home/node/openclaw-workspace';
    const openClawDist = '/home/node/openclaw-dist';
    await writeFile(join(roots.ops, 'container-aliases.json'), JSON.stringify({ schemaVersion: 2, systemPrincipals: {}, historicalAliases: {}, aliases: {
      [alias]: { tenant: 'Steven', room: 'grp.steven', container: containerName, user: 'node', home: '/home/node',
        stateDirectory, harness, membershipRole: 'agent', systemdUser: 'stev',
        ...(harness === 'openclaw' ? { workspace: openClawWorkspace } : {}) },
    } }), { mode: 0o600 });
    await command('python3', [join(roots.ops, 'scripts/container-alias-query.py'), alias, '--supervisor'], environment);
    const homeFolders = harness === 'openclaw'
      ? ['.local/bin', 'projects', 'openclaw-workspace', 'openclaw-dist']
      : ['.local/bin', '.claude', 'projects'];
    for (const folder of homeFolders) await mkdir(join(roots.home, folder), { recursive: true, mode: 0o700 });
    if (harness === 'claude') {
      await writeFile(join(roots.home, '.local/bin/claude'), CLAUDE, { mode: 0o700 });
      await writeFile(join(roots.home, '.bash_profile'), 'export PATH="$HOME/.local/bin:$PATH"\n', { mode: 0o600 });
    } else {
      await writeFile(join(roots.home, 'openclaw-dist/package.json'), '{"type":"module"}\n', { mode: 0o644 });
      await writeFile(join(roots.home, 'openclaw-dist/agent-via-gateway-lab.js'), OPENCLAW_AGENT, { mode: 0o644 });
      await writeFile(join(roots.home, 'openclaw-dist/runtime-lab.js'), OPENCLAW_RUNTIME, { mode: 0o644 });
    }
    const recipe = await readFile(join(ROOT, 'tests/e2e/lab-runner/Dockerfile'));
    const image = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
    runtime = await new GenericContainer(image).withName(containerName).withLabels({ 'cauce.e2e.owner': OWNER })
      .withUser('0').withNetworkMode('host').withBindMounts([{ source: roots.home, target: '/home/node', mode: 'rw' }])
      .withWorkingDir('/home/node/projects').withCommand(['sleep', 'infinity']).withWaitStrategy(Wait.forSuccessfulCommand('id node')).start();
    if (harness === 'claude') {
      const launcher = await command('docker', ['exec', '--user', '1000', '-e', 'HOME=/home/node',
        '-e', 'PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin', containerName, 'bash', '-lc', 'command -v claude']);
      assert.equal(launcher.stdout.trim(), '/home/node/.local/bin/claude');
    } else {
      const present = await command('docker', ['exec', '--user', '1000', containerName, 'test', '-f', `${openClawDist}/agent-via-gateway-lab.js`]);
      assert.equal(present.stdout, '');
    }
    const imageId = (await command('docker', ['inspect', '--format', '{{.Image}}', containerName])).stdout.trim();
    const pki = join(roots.pki, alias); await mkdir(pki, { mode: 0o700 });
    for (const [source, target] of [[workerTls.cert_path, 'client.crt'], [workerTls.key_path, 'client.key'], [tls.cert_path, 'ca.crt']]) {
      assert.ok(source && target); await copyFile(source, join(pki, target)); await chmod(join(pki, target), 0o600);
    }
    const password = randomUUID();
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(databaseName).withLabels({ 'cauce.e2e.owner': OWNER }).withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck()).start());
    pool = createPool(`postgresql://cauce_test:${encodeURIComponent(password)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`);
    await applyMigrationsThrough(pool, '047_agent_preferences.sql');
    for (const target of [alias, publisher]) {
      await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
        VALUES('Steven',$1,$2,true,$3,'node','/home/node',$4)`, [target, harness, containerName, stateDirectory]);
      await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [target]);
    }
    await applyMigrations(pool);
    const identities = join(directory, 'identities.json');
    await writeFile(identities, JSON.stringify({ version: 1, identities: [[alias, workerTls], [publisher, tls]].map(([target, material]) => {
      assert.ok(typeof target === 'string' && typeof material === 'object');
      return { certificate_sha256: new X509Certificate(material.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
      expires_at: new Date(Date.now() + 1_800_000).toISOString(), principal: { tenant_id: 'Steven', alias: target,
        session_id: `canary:${run}`, channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] },
      };
    }) }), { mode: 0o600 });
    app = await buildGateway({ pool, logger: false, outboxPollMs: 10, leaseTtlMs: 30_000,
      authProvider: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)),
      https: { cert: tls.cert, key: tls.key, ca: [tls.cert, workerTls.cert], requestCert: true, rejectUnauthorized: true } });
    await app.listen({ host: '0.0.0.0', port: 0 });
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `https://127.0.0.1:${String(address.port)}`;
    const config = join(roots.config, `${alias}.env`);
    const configEntries: Record<string, string> = { BUNDLE_RELEASE: old.name, BUNDLE_SHA256: old.digest, PKI_DIR: pki,
      RELAY_URL: `${origin.replace('https:', 'wss:')}/v3/ws`, EXPECTED_IMAGE_ID: imageId,
      EXPECTED_LABEL_KEY: 'cauce.e2e.owner', EXPECTED_LABEL_VALUE: OWNER, MOUNT_TYPE: 'bind', MOUNT_SOURCE: roots.home,
      MOUNT_DESTINATION: '/home/node', MOUNT_RW: 'true', CAUCE_SEMBRAR_PERFIL: '1' };
    if (harness === 'claude') {
      configEntries.EXPECTED_CLI_VERSION = '2.1.0';
      configEntries.SHARED_SESSION = '1';
      configEntries.SHARED_SESSION_WORKSPACE = '/home/node/projects';
    } else {
      configEntries.OPENCLAW_WORKSPACE = openClawWorkspace;
      configEntries.OPENCLAW_DIST_DIR = openClawDist;
    }
    await writeFile(config, Object.entries(configEntries).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    const inventory = join(directory, 'inventory.json');
    await writeFile(inventory, JSON.stringify({ version: 1, agents: [{ alias, kind: 'container', transport: 'local', lifecycle: 'supervisor',
      harness, container: containerName, ops_root: roots.ops, config_root: roots.config, bundle_root: roots.bundle,
      pki_root: roots.pki, lock_root: roots.locks, control_root: controlRoot, state_directory: stateDirectory,
      supervisor_path: supervisor }] }), { mode: 0o600 });
    const activePool = pool;
    async function deliveryDiagnostics(deliveryId: string) {
      const rows = (await activePool.query<Delivery & { attempt: number; consumer_epoch: string | null }>(`SELECT id,status,last_error,terminal_at,
        (SELECT payload->>'error_code' FROM delivery_acks WHERE delivery_id=delivery.id AND applied AND status='failed' ORDER BY id DESC LIMIT 1) AS error_code,
        attempt,consumer_epoch FROM deliveries delivery WHERE id=$1`, [deliveryId])).rows;
      const adapterLog = await command('docker', ['exec', '--user', '0', containerName, 'tail', '-c', '16384',
        `${stateDirectory}/.cauce-adapter.log`]).then(result => result.stdout.replaceAll('PRIVATE_PROVIDER_ERROR', '[synthetic provider error]'), () => 'unavailable');
      const metadata = await command('docker', ['exec', '--user', '0', containerName, 'cat',
        `${controlRoot}/${alias}/cauce-v3-adapter.json`]).then(result => JSON.parse(result.stdout) as Metadata, () => undefined);
      const tuiState = await readFile(join(roots.home, 'controlled-tui-state.json'), 'utf8').then(value => JSON.parse(value) as Record<string, unknown>, () => undefined);
      const transcriptRoot = join(roots.home, '.claude/projects');
      const files = await readdir(transcriptRoot, { recursive: true }).catch(() => []);
      const transcripts = await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(async file => {
        const text = await readFile(join(transcriptRoot, file), 'utf8');
        return text.trim().split('\n').filter(Boolean).slice(-8).map(line => {
          const entry = JSON.parse(line) as { type?: string; isApiErrorMessage?: boolean; message?: { stop_reason?: string } };
          return { type: entry.type, stopReason: entry.message?.stop_reason, isApiErrorMessage: entry.isApiErrorMessage === true };
        });
      }));
      await receipt(`delivery-failure-${alias}`, { alias, deliveryId, deliveries: rows, metadata, tuiState, transcripts, adapterLog });
    }
    async function delivery(apiError = false): Promise<Delivery> {
      if (apiError) await writeFile(join(roots.home, 'api-error'), 'synthetic');
      else await rm(join(roots.home, 'api-error'), { force: true });
      const key = randomUUID();
      const body = JSON.stringify({ room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias }],
        body: { text: 'Synthetic live release canary' }, idempotency_key: key });
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = request(`${origin}/v3/messages`, { method: 'POST', ca: tls.cert, cert: tls.cert, key: tls.key,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
          let result = '';
          incoming.setEncoding('utf8'); incoming.on('data', (chunk: string) => { result += chunk; });
          incoming.once('error', reject);
          incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, body: result }); });
        }); outgoing.once('error', reject); outgoing.end(body);
      });
      assert.equal(response.status, 202);
      const published = PublishResultSchema.parse(JSON.parse(response.body));
      assert.equal(published.delivery_ids.length, 1);
      const deliveryId = published.delivery_ids[0]; assert.ok(deliveryId);
      return waitFor(async () => {
        const row = (await activePool.query<Delivery>(`SELECT delivery.id,delivery.status,delivery.last_error,delivery.terminal_at,
          (SELECT payload->>'error_code' FROM delivery_acks WHERE delivery_id=delivery.id AND applied AND status='failed' ORDER BY id DESC LIMIT 1) AS error_code
          FROM deliveries delivery
          WHERE delivery.id=$1 AND delivery.message_id=$2 AND delivery.recipient_tenant='Steven'
          AND delivery.recipient_alias=$3`, [deliveryId, published.message_id, alias])).rows[0];
        return row && ['done', 'dead', 'failed'].includes(row.status) ? row : undefined;
      }).catch(async (error: unknown) => { await deliveryDiagnostics(deliveryId); throw error; });
    }
    const probes: Record<string, unknown>[] = [];
    async function probe(release: string, nonce: string) {
      await waitFor(() => command('bash', [supervisor, 'check', alias], environment).then(() => true, () => undefined), 180_000);
      const metadata = JSON.parse((await command('docker', ['exec', '--user', '0', containerName, 'cat',
        `${controlRoot}/${alias}/cauce-v3-adapter.json`])).stdout) as Metadata;
      const lease = await waitFor(async () => (await activePool.query<{ epoch: string }>(
        "SELECT epoch FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now()", [alias])).rows[0]);
      const completed = await delivery();
      const deliveryDone = completed.status === 'done';
      const helloAck = Number(lease.epoch) > 0 && deliveryDone;
      assert.equal(deliveryDone, true);
      assert.ok(metadata.executable.path.includes(`/releases/${release}/`));
      const result = { alias, release, nonce, process_alive: metadata.phase === 'running', effective_release: release,
        hello_ack: helloAck, lease_valid: Number(lease.epoch) > 0, lease_epoch: lease.epoch,
        bundle_digest: metadata.bundleDigest, executable_path: metadata.executable.path,
        delivery_done: deliveryDone, delivery_id: completed.id, pid: metadata.pid, starttime: metadata.starttime };
      probes.push(result); return result;
    }
    probeServer.on('request', (incoming, outgoing) => {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      void probe(url.searchParams.get('release') ?? '', url.searchParams.get('nonce') ?? '').then(value => {
        outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(value));
      }, () => { outgoing.writeHead(500); outgoing.end('{}'); });
    });
    await new Promise<void>(resolve => { probeServer.listen(0, '127.0.0.1', resolve); });
    const probeAddress = probeServer.address(); assert.ok(probeAddress && typeof probeAddress !== 'string');
    const probePath = join(directory, 'probe.py');
    await writeFile(probePath, `#!/usr/bin/env python3\nimport sys,urllib.parse,urllib.request\nquery=urllib.parse.urlencode({'release':sys.argv[2],'nonce':sys.argv[3]})\nwith urllib.request.urlopen('http://127.0.0.1:${String(probeAddress.port)}/?'+query,timeout=120) as response: print(response.read().decode())\n`, { mode: 0o700 });
    const probeSha = createHash('sha256').update(await readFile(probePath)).digest('hex');
    const start = () => { const child = spawn('bash', [supervisor, 'start', alias], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); return child; };
    const stop = async () => { await command('bash', [supervisor, 'stop', alias], environment); await command('bash', [supervisor, 'stopped', alias], environment); };
    return { alias, directory, old, candidate, config, inventory, probePath, probeSha, environment, probes, pool: activePool,
      runtime, containerName, roots, close, start, stop, probe, delivery };
  } catch (error) { await close(); throw error; }
}
