import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CauceRepository, FleetOperationsRepository, createPool, type DatabasePool } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { buildGateway } from '../app.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { MtlsAuthProvider } from '../auth.js';
import { FleetMtlsIdentityProvider, FleetTokenProbeAuthProvider } from './mtls-identities.js';
import { startSignedFleetAuthorityBridge } from './authority/signed-bridge.js';
import { SignedFleetAuthorityClient } from './authority/signed-client.js';
import { HostSetupConfigSchema, HostSetupPackager } from './host-setup.js';
import { inviteSetupHost, registerSetupOwner, type SetupOwnerSession } from './host-setup.fixtures.js';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const RESOURCE_PREFIX = `zz-canary-host-setup-${randomUUID().slice(0, 8)}`;
const COMPUTER_IMAGE = `FROM node:22-bookworm AS node
FROM docker:29-cli AS docker
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session openssl ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
RUN useradd -m -u 1500 -s /bin/bash cauce && useradd -m -u 1000 -s /bin/bash node \\
  && ln -s /usr/local/bin/python3 /usr/bin/python3
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
const PROVIDER_CLI = `#!/usr/local/bin/python3
import json,re,sys
if 'app-server' in sys.argv:
 for line in sys.stdin:
  packet=json.loads(line)
  if 'id' in packet:
   result={'account':{'type':'chatgpt','email':'host-setup@example.test'}} if packet['method']=='account/read' else {}
   print(json.dumps({'id':packet['id'],'result':result}),flush=True)
else:
 prompt=' '.join(sys.argv[1:]) if sys.argv[-1]!='-' else sys.stdin.read()
 nonce=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',prompt)
 if nonce is None: sys.exit(1)
 print(json.dumps({'type':'thread.started','thread_id':'host-setup-fixture'}))
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':nonce.group(0)}}))
`;
const AS_USER = ['-u', 'cauce', '-e', 'HOME=/home/cauce', '-e', 'XDG_RUNTIME_DIR=/run/user/1500'];
const TREE = ['services/gateway/src', 'packages/store/src', 'packages/protocol/src', 'packages/adapter-sdk/descriptors',
  'ops/cli', 'ops/scripts', 'ops/container-runtime'];

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let closePool = () => Promise.resolve();
let work = ''; let container = ''; let image = ''; let gatewayUrl = ''; let packager: HostSetupPackager;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined; let artifacts: Server | undefined;
let bootstrapApp: Awaited<ReturnType<typeof buildGateway>> | undefined;
let bridge: Awaited<ReturnType<typeof startSignedFleetAuthorityBridge>> | undefined;

function command(file: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('close', code => { resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
function gateway() { if (!app) throw new Error('gateway absent'); return app; }
const onComputer = (args: string[], input?: string) => command('docker', ['exec', '-i', ...AS_USER, container, ...args], input);
const cli = (args: string[], input?: string) => onComputer(['python3', '/opt/cauce-cli/host_enrollment.py', ...args], input);

async function buildRelease(tree: string): Promise<{ archive: Buffer; bundleDigest: string; hookDigest: string; revision: string }> {
  const stage = join(work, 'stage');
  for (const part of ['ops/cli', 'ops/scripts', 'ops/container-runtime']) await cp(join(tree, part), join(stage, part), { recursive: true });
  await cp(join(tree, 'packages/adapter-sdk/descriptors'), join(stage, 'adapter/packages/adapter-sdk/dist/descriptors'), { recursive: true });
  await writeFile(join(stage, 'adapter/provider-cli.py'), PROVIDER_CLI, { mode: 0o755 });
  const runtime = join(work, 'bootstrap-runtime.ts');
  await writeFile(runtime, `import { bootstrapOnStartup } from ${JSON.stringify(join(ROOT, 'packages/adapter-sdk/src/sdk/bootstrap-runner.ts'))};
import { SpawnCommandRunner } from ${JSON.stringify(join(ROOT, 'packages/adapter-sdk/src/sdk/process-runner.ts'))};
import { commandPinsFromEnvironment } from ${JSON.stringify(join(ROOT, 'packages/adapter-sdk/src/sdk/command-pins.ts'))};
import { codexDefinition } from ${JSON.stringify(join(ROOT, 'packages/adapter-sdk/src/harnesses/codex.ts'))};
await bootstrapOnStartup({tenant_id:process.env.CAUCE_TENANT_ID!,alias:process.env.CAUCE_ALIAS!,definition:codexDefinition,
 runner:new SpawnCommandRunner(),commandOverride:{command:process.env.CAUCE_HARNESS_COMMAND!},commandPins:commandPinsFromEnvironment(),
 tls:{certFile:process.env.CAUCE_CERT_PATH!,keyFile:process.env.CAUCE_KEY_PATH!,caFile:process.env.CAUCE_CA_PATH!}});
setInterval(()=>{},60000);
`);
  await execute(join(ROOT, 'node_modules/.bin/esbuild'), [runtime, '--bundle', '--platform=node', '--format=esm', '--target=node22',
    '--log-level=error', `--outfile=${join(stage, 'adapter/bootstrap-runtime.mjs')}`, `--alias:@cauce/protocol=${join(tree, 'packages/protocol/src/index.ts')}`]);
  await mkdir(join(stage, 'services/gateway/dist/fleet'), { recursive: true });
  await execute(join(ROOT, 'node_modules/.bin/esbuild'), [join(tree, 'services/gateway/src/fleet/main.ts'), '--bundle', '--platform=node',
    '--format=esm', '--target=node22', '--external:pg-native', '--log-level=error', `--outfile=${join(stage, 'services/gateway/dist/fleet/main.js')}`,
    `--alias:@cauce/store=${join(tree, 'packages/store/src/index.ts')}`, `--alias:@cauce/protocol=${join(tree, 'packages/protocol/src/index.ts')}`,
    '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
  { env: { ...process.env, NODE_PATH: ['services/gateway', 'packages/store', 'packages/protocol', ''].map(part => join(ROOT, part, 'node_modules')).join(':') } });
  await execute('chmod', ['-R', 'u=rwX,go=rX', stage]);
  const archive = join(work, 'release.tar');
  await execute('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', stage, '.']);
  const measure = 'import pathlib,sys\nsys.path[:0]=[sys.argv[1]+"/ops/cli",sys.argv[1]+"/ops/container-runtime"]\nimport host_setup\n'
    + 'from cauce_container_base import bundle_digest\ntarget=pathlib.Path(sys.argv[3])\ntarget.parent.mkdir(parents=True)\n'
    + 'host_setup.extract_release(pathlib.Path(sys.argv[2]),target)\nprint(bundle_digest(str(target/"adapter")))\n';
  const measured = await execute('python3', ['-c', measure, tree, archive, join(work, 'measured/release')]);
  return { archive: await readFile(archive), bundleDigest: measured.stdout.trim(),
    hookDigest: hash(await readFile(join(stage, 'ops/cli/fleet-provider-hook.py'))),
    revision: (await execute('git', ['-C', ROOT, 'rev-parse', 'HEAD'])).stdout.trim() };
}
async function signedAuthority(): Promise<{ client: SignedFleetAuthorityClient; ca: Buffer }> {
  const directory = join(work, 'authority'); const state = join(directory, 'state');
  await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const registryFile = (name: string): string => join(directory, name, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
  const registries = { base_mtls: registryFile('base_mtls'), base_token: registryFile('base_token'),
    fleet_mtls: registryFile('fleet_mtls'), fleet_token: registryFile('fleet_token') };
  for (const [name, file] of Object.entries(registries)) {
    await mkdir(join(directory, name), { mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: 1, identities: [] }), { mode: 0o600 });
  }
  const certificate = join(directory, 'ca.crt'), key = join(directory, 'ca.key');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-subj', '/CN=host-setup-e2e-authority',
    '-keyout', key, '-out', certificate, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await chmod(key, 0o600);
  const policyFile = join(directory, 'issuer-policy.json');
  await writeFile(policyFile, JSON.stringify({ version: 1, state_root: state, registries, signer: { certificate, key,
    certificate_sha256: hash(await readFile(certificate)), key_sha256: hash(await readFile(key)) } }), { mode: 0o600 });
  const executable = join(ROOT, 'ops/cli/fleet-authority-issuer.py');
  const socket = join(directory, 'signed.sock'); const uid = process.geteuid?.() ?? 0;
  bridge = await startSignedFleetAuthorityBridge(socket, pool, { ownerUid: uid, peerUid: uid, command: { python: '/usr/bin/python3', executable,
    sha256: hash(await readFile(executable)), policy_file: policyFile, policy_sha256: hash(await readFile(policyFile)) } });
  await writeFile(join(directory, 'extensions'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  await execute('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=host-setup-gateway',
    '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', certificate, '-CAkey', key,
    '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'extensions'), '-out', join(directory, 'server.crt')]);
  const provider = (namespace: 'bootstrap' | 'normal') => new MtlsAuthProvider(new FleetMtlsIdentityProvider(
    registries.base_mtls, registries.fleet_mtls, namespace, uid));
  bootstrapApp = await buildGateway({ pool, repository: new CauceRepository(pool), logger: false, authProvider: provider('normal'),
    bootstrapProviders: { bootstrap: provider('bootstrap'), normal: provider('normal'),
      token: new FleetTokenProbeAuthProvider(registries.fleet_token, uid, registries.base_token) },
    https: { key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.crt')),
      ca: await readFile(certificate), requestCert: true, rejectUnauthorized: true } });
  return { client: new SignedFleetAuthorityClient(socket, { ownerUid: uid, peerUid: uid }), ca: await readFile(certificate) };
}
async function computerImage(): Promise<string> {
  image = `${RESOURCE_PREFIX}:computer`;
  const built = await command('docker', ['build', '-q', '-t', image, '-'], COMPUTER_IMAGE);
  if (built.code !== 0) throw new Error(`computer image build failed: ${built.stderr}`);
  return image;
}
async function inventory() {
  const containers = await execute('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${RESOURCE_PREFIX}`]);
  const volumes = await execute('docker', ['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${RESOURCE_PREFIX}`]);
  const images = await execute('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${RESOURCE_PREFIX}:*`]);
  return { containers: containers.stdout.trim(), volumes: volumes.stdout.trim(), images: images.stdout.trim() };
}
async function serveArtifacts(files: Record<string, Buffer>): Promise<string> {
  artifacts = createServer((request, response) => {
    const body = files[request.url ?? ''];
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>(resolve => artifacts?.listen(0, '127.0.0.1', resolve));
  const address = artifacts.address();
  if (address === null || typeof address === 'string') throw new Error('artifact server address absent');
  return `http://127.0.0.1:${String(address.port)}`;
}
async function enrollments(session: SetupOwnerSession) {
  const response = await app?.inject({ method: 'GET', url: '/v3/console/fleet/hosts/enrollments', headers: { ...session } });
  return JSON.parse(response?.body ?? '{}') as { enrollments: { host_id: string; executor_ready: boolean }[] };
}
async function capability(session: SetupOwnerSession) {
  const response = await app?.inject({ method: 'GET', url: '/v3/console/fleet/capability', headers: { ...session } });
  return JSON.parse(response?.body ?? '{}') as { available: boolean; placements: { host_id: string }[] };
}

describe('a clean computer prepares its executor without the platform administrator', () => {
  let ownerA: SetupOwnerSession;
  beforeAll(async () => {
    const before = await inventory();
    expect(before).toEqual({ containers: '', volumes: '', images: '' });
    console.info('HOST_SETUP_DOCKER_BEFORE', RESOURCE_PREFIX, JSON.stringify(before));
    work = await mkdtemp(`/var/tmp/${RESOURCE_PREFIX}-`);
    await chmod(work, 0o755); await mkdir(join(work, 'install'));
    const tree = join(work, 'tree'); await mkdir(tree);
    const tracked = (await execute('git', ['-C', ROOT, 'ls-files', '-z', '--', ...TREE])).stdout.split('\0').filter(Boolean);
    const deleted = new Set((await execute('git', ['-C', ROOT, 'ls-files', '--deleted', '-z', '--', ...TREE])).stdout.split('\0'));
    for (const part of tracked.filter(part => !deleted.has(part))) {
      await mkdir(dirname(join(tree, part)), { recursive: true }); await cp(join(ROOT, part), join(tree, part));
    }
    await execute('chmod', ['-R', 'u=rwX,go=rX', join(tree, 'ops/cli')]);
    database = await startTestDatabase(); current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 8 });
    closePool = () => pool.end();
    const [release, authority, computer] = await Promise.all([buildRelease(tree), signedAuthority(), computerImage()]);
    if (!bootstrapApp) throw new Error('bootstrap gateway absent');
    const bootstrapOrigin = await bootstrapApp.listen({ host: '127.0.0.1', port: 0 });
    console.info('HOST_SETUP_RELEASE', JSON.stringify({ revision: release.revision, source: 'working-tree-tracked',
      archive_sha256: hash(release.archive), bundle_digest: release.bundleDigest, hook_sha256: release.hookDigest }));
    const origin = await serveArtifacts({ '/release.tar': release.archive, '/fleet-ca.pem': authority.ca });
    const imageId = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', computer])).stdout.trim();
    const hook = { executable: '@release@/ops/cli/fleet-provider-hook.py', sha256: release.hookDigest, argv: [], user: '@user@' };
    packager = new HostSetupPackager(HostSetupConfigSchema.parse({ version: 1, signing_key_file: '/etc/cauce/unused.pem',
      release: { name: 'release', revision: release.revision, url: `${origin}/release.tar`, sha256: hash(release.archive), size: release.archive.length },
      files: [{ name: 'fleet-ca', url: `${origin}/fleet-ca.pem`, sha256: hash(authority.ca), size: authority.ca.length }],
      policy: {
        bundles: { codex: { directory: '@release@/adapter', digest: release.bundleDigest, executable: '/usr/local/bin/node',
          executable_sha256: null, argv: ['@release@/adapter/bootstrap-runtime.mjs'] } },
        container_templates: [{ harness_id: 'codex', prefix: `${RESOURCE_PREFIX}-`, image: imageId, runtime_user: 'node', systemd_user: '@user@',
          home_directory: '/home/node', state_root: '/home/node/.cauce', profile_root: '/home/node/.cauce-profiles', python: '/usr/local/bin/python3.12' }],
        profile_templates: [{ provider: 'codex', runtime_user: 'node', path_root: '/home/node/.cauce-profiles', command: '@release@/adapter/provider-cli.py',
          command_sha256: hash(PROVIDER_CLI), runtime_mode: 'container', container_prefix: `${RESOURCE_PREFIX}-` }],
        hooks: { authenticate: hook, profile: hook, verify: hook, revoke: hook },
        transport: { bootstrap_url: bootstrapOrigin, gateway_url: bootstrapOrigin, ca_certificate: '@install@/files/fleet-ca', network: 'host' },
        authority: { identity_directory: '@identity@', host_id: '@host@', ca_certificate: '@install@/files/fleet-ca' },
      } }), generateKeyPairSync('ed25519').privateKey);
    app = await buildGateway({ pool, repository: new CauceRepository(pool), consoleOrigins: ['http://localhost'], logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 61) }),
      hostSetup: packager, signedFleetAuthorityClient: authority.client, fleetOperationsRepository: new FleetOperationsRepository(pool) });
    gatewayUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    container = RESOURCE_PREFIX;
    const started = await command('docker', ['run', '-d', '--name', container, '--privileged', '--cgroupns=private', '--network', 'host',
      '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${join(tree, 'ops/cli')}:/opt/cauce-cli:ro`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${join(work, 'install')}:${join(work, 'install')}`, computer]);
    if (started.code !== 0) throw new Error(`computer did not start: ${started.stderr}`);
    const settle = async (probe: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100 && !await probe(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
    };
    await settle(async () => (await command('docker', ['exec', container, 'systemctl', 'is-system-running', '--wait'])).stdout.trim() !== '');
    const dockerGroup = String((await stat('/var/run/docker.sock')).gid);
    await execute('docker', ['exec', container, 'groupadd', '-g', dockerGroup, 'fixture-docker']);
    await execute('docker', ['exec', container, 'usermod', '-aG', 'fixture-docker', 'cauce']);
    await execute('docker', ['exec', container, 'chown', 'cauce:cauce', join(work, 'install')]);
    await execute('docker', ['exec', container, 'loginctl', 'enable-linger', 'cauce']);
    await settle(async () => (await onComputer(['systemctl', '--user', 'is-system-running'])).stdout.trim() === 'running');
    ownerA = await registerSetupOwner(app, 'setupe2e');
  }, 600_000);
  afterAll(async () => {
    const owned = await inventory();
    if (owned.containers.split('\n').includes(container)) {
      const removeInstall = 'import os,pathlib,shutil,sys\np=pathlib.Path(sys.argv[1])\n'
        + 'for child in p.iterdir():\n shutil.rmtree(child) if child.is_dir() else child.unlink()\n'
        + 'os.chown(p,int(sys.argv[2]),int(sys.argv[3]));os.chmod(p,448)\n';
      await execute('docker', ['exec', container, '/usr/local/bin/python3', '-c', removeInstall, join(work, 'install'),
        String(process.getuid?.() ?? 0), String(process.getgid?.() ?? 0)]);
    }
    for (const name of owned.containers.split('\n').filter(Boolean)) await execute('docker', ['rm', '-f', name]);
    for (const name of owned.volumes.split('\n').filter(Boolean)) await execute('docker', ['volume', 'rm', name]);
    const cleanup: PromiseSettledResult<unknown>[] = await Promise.allSettled([
      app?.close(), bootstrapApp?.close(), bridge?.close(),
      artifacts === undefined ? Promise.resolve() : new Promise<void>((resolve, reject) => artifacts?.close(error => {
        if (error) reject(error); else resolve();
      })),
    ]);
    if (image) cleanup.push(...await Promise.allSettled([execute('docker', ['image', 'rm', image])]));
    const after = await inventory();
    console.info('HOST_SETUP_DOCKER_AFTER', RESOURCE_PREFIX, JSON.stringify(after));
    await closePool(); await current?.close();
    if (database) { await database.pool.end(); await database.container.stop(); }
    if (work) await rm(work, { recursive: true, force: true });
    expect(after).toEqual({ containers: '', volumes: '', images: '' });
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }, 120_000);

  it('enrolls with the console invitation, installs the user service and reports executor_ready', async () => {
    const invitation = await inviteSetupHost(gateway(), ownerA, 'setupe2e-laptop');
    expect(invitation.setup_signer_fingerprint).toBe(packager.signerFingerprint);
    const enrolled = await cli(['enroll', '--gateway', gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation));
    expect(enrolled.code, enrolled.stderr).toBe(0);
    expect(JSON.parse(enrolled.stdout)).toMatchObject({ host_id: 'setupe2e-laptop', state: 'enrolled', executor_ready: false });
    const prepared = await cli(['setup', '--install-root', join(work, 'install')]);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ host_id: 'setupe2e-laptop', service_active: true, linger: true, templates: 1 });
    const unit = 'cauce-v3-host-executor-setupe2e-setupe2e-laptop.service';
    let ready = false;
    for (let attempt = 0; attempt < 90 && !ready; attempt++) {
      ready = (await enrollments(ownerA)).enrollments.some(row => row.host_id === 'setupe2e-laptop' && row.executor_ready);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const journal = ready ? '' : (await onComputer(['journalctl', '--user', '-u', unit, '--no-pager', '-n', '50'])).stdout;
    expect(ready, journal).toBe(true);
    const status = await cli(['status', '--install-root', join(work, 'install')]);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ executor_ready: true, service_active: true, templates: 1 });
    expect(await capability(ownerA)).toMatchObject({ available: true, placements: [{ host_id: 'setupe2e-laptop' }] });
    expect((await pool.query('SELECT 1 FROM platform_admins')).rowCount).toBe(0);
    expect((await onComputer(['systemctl', '--user', 'is-active', unit])).stdout.trim()).toBe('active');
    expect((await execute('docker', ['ps', '--format', '{{.Names}}', '--filter', `name=^/${container}$`])).stdout.trim()).toBe(container);
    const tenant = (await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', ['setupe2e@example.test'])).rows[0]?.tenant_id;
    if (!tenant) throw new Error('registered company has no tenant');
    const room = (await pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('registered company has no room');
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES('host-setup-account','codex','host-setup@example.test',$1,'env_path','CAUCE_HOST_SETUP_PROFILE_PATH',true)`, [tenant]);
    const runtimeKey = `${RESOURCE_PREFIX}-agent`;
    const response = await gateway().inject({ method: 'POST', url: '/v3/console/fleet/operations', headers: { ...ownerA }, payload: {
      kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias: 'setup-worker' }, expected_revision: 0,
      idempotency_key: `${RESOURCE_PREFIX}-create`, parameters: { runtime_key: runtimeKey, harness_id: 'codex',
        primary_room_id: room, primary_account_id: 'host-setup-account', memberships: [{ room_id: room, role: 'agent' }],
        placement: { host_id: 'setupe2e-laptop', mode: 'container', container_name: runtimeKey, runtime_user: 'node', systemd_user: 'cauce',
          home_directory: '/home/node', state_directory: `/home/node/.cauce/${runtimeKey}` } } } });
    expect(response.statusCode, response.body).toBe(202);
    const operationId = response.json<{ operation_id: string }>().operation_id;
    let operation: { status: string; error: unknown } = { status: 'queued', error: null };
    for (let attempt = 0; attempt < 90 && !['succeeded', 'failed', 'awaiting_auth'].includes(operation.status); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const receipt = await gateway().inject({ method: 'GET', url: `/v3/console/fleet/operations/${operationId}`, headers: { ...ownerA } });
      expect(receipt.statusCode, receipt.body).toBe(200); operation = receipt.json<typeof operation>();
    }
    const operationJournal = operation.status === 'succeeded' ? '' : (await onComputer(['journalctl', '--user', '-u', unit, '--no-pager', '-n', '60'])).stdout;
    expect(operation.status, JSON.stringify(operation.error) + operationJournal).toBe('succeeded');
    const observed = (await execute('docker', ['ps', '--format', '{{.Names}}', '--filter', `name=^/${runtimeKey}$`])).stdout.trim();
    expect(observed).toBe(runtimeKey);
    const probes = await pool.query<{ phase: string; state: string; reply: string | null; nonce: string }>(`SELECT DISTINCT ON (metadata->'bootstrap_probe'->'probe'->>'probe_id')
      metadata->'bootstrap_probe'->'probe'->>'phase' AS phase, metadata->'bootstrap_probe'->>'state' AS state,
      metadata->'bootstrap_probe'->'proof'->>'reply' AS reply, metadata->'bootstrap_probe'->'probe'->>'nonce' AS nonce
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'
      ORDER BY metadata->'bootstrap_probe'->'probe'->>'probe_id', created_at DESC`, [operationId]);
    for (const phase of ['bootstrap', 'normal']) expect(probes.rows.some(probe => probe.phase === phase && probe.state === 'succeeded'
      && probe.reply === `CAUCE_BOOTSTRAP_${probe.nonce}`)).toBe(true);
    console.info('HOST_SETUP_CREATE', JSON.stringify({ operation_id: operationId, status: operation.status, container: observed,
      bootstrap_nonce_verified: true, normal_nonce_verified: true, provider: 'pinned-fixture-cli', runtime: 'real-sdk-bootstrap' }));
  }, 300_000);

  it('another company neither sees that computer nor lets it ask for its setup package', async () => {
    const ownerB = await registerSetupOwner(gateway(), 'setupe2eb');
    await inviteSetupHost(gateway(), ownerB, 'setupe2eb-desk');
    expect((await enrollments(ownerB)).enrollments.map(row => row.host_id)).toEqual(['setupe2eb-desk']);
    expect((await capability(ownerB)).placements.map(row => row.host_id)).not.toContain('setupe2e-laptop');
    const forged = 'import pathlib,sys\nsys.path.insert(0,"/opt/cauce-cli")\nfrom host_channel_client import HostChannel,HostFailure,post_json\n'
      + 'channel=HostChannel(pathlib.Path("/home/cauce/.local/state/cauce-v3/hosts/setupe2e/setupe2e-laptop"))\n'
      + 'path="/v3/fleet/hosts/setupe2eb-desk/setup"\ntry:\n post_json(channel.gateway,path,channel.packet("POST",path,{"action":"package"}))\n'
      + ' print("accepted")\nexcept HostFailure as error:\n print(error)\n';
    const attempt = await onComputer(['python3', '-c', forged]);
    expect(attempt.stdout, attempt.stderr).toContain('HTTP 403');
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='fleet_host.setup.package' AND company_id='setupe2eb'")).rowCount).toBe(0);
  }, 120_000);
});
