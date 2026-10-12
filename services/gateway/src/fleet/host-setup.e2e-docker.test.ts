import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CauceRepository, FleetOperationsRepository, createPool, type DatabasePool } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { buildGateway } from '../app.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { startSignedFleetAuthorityBridge } from './authority/signed-bridge.js';
import { SignedFleetAuthorityClient } from './authority/signed-client.js';
import { HostSetupConfigSchema, HostSetupPackager } from './host-setup.js';
import { inviteSetupHost, registerSetupOwner, type SetupOwnerSession } from './host-setup.fixtures.js';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** A clean computer: systemd as PID 1, a normal user with linger, Python 3.12, OpenSSL and Node.js 22, and nothing of Cauce. */
const COMPUTER_IMAGE = `FROM node:22-bookworm AS node
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session openssl ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN useradd -m -u 1500 -s /bin/bash cauce
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
const AS_USER = ['-u', 'cauce', '-e', 'HOME=/home/cauce', '-e', 'XDG_RUNTIME_DIR=/run/user/1500'];
const TREE = ['services/gateway/src', 'packages/store/src', 'packages/protocol/src', 'packages/adapter-sdk/descriptors',
  'ops/cli', 'ops/scripts', 'ops/container-runtime'];

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let work = ''; let container = ''; let gatewayUrl = ''; let packager: HostSetupPackager;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined; let artifacts: Server | undefined;
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

/** The release a platform would approve: the committed executor tree, its Python helpers, the adapter descriptors and a self-contained host process. */
async function buildRelease(tree: string): Promise<{ archive: Buffer; bundleDigest: string; hookDigest: string; revision: string }> {
  const stage = join(work, 'stage');
  for (const part of ['ops/cli', 'ops/scripts', 'ops/container-runtime']) await cp(join(tree, part), join(stage, part), { recursive: true });
  await cp(join(tree, 'packages/adapter-sdk/descriptors'), join(stage, 'adapter/packages/adapter-sdk/dist/descriptors'), { recursive: true });
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
  const registries: Record<string, string> = {};
  for (const name of ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token']) {
    await mkdir(join(directory, name), { mode: 0o700 });
    registries[name] = join(directory, name, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
    await writeFile(registries[name], JSON.stringify({ version: 1, identities: [] }), { mode: 0o600 });
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
  return { client: new SignedFleetAuthorityClient(socket, { ownerUid: uid, peerUid: uid }), ca: await readFile(certificate) };
}
async function computerImage(): Promise<string> {
  const tag = `zz-canary-host-setup:${hash(COMPUTER_IMAGE).slice(0, 12)}`;
  if ((await command('docker', ['image', 'inspect', tag])).code !== 0) {
    const built = await command('docker', ['build', '-q', '-t', tag, '-'], COMPUTER_IMAGE);
    if (built.code !== 0) throw new Error(`computer image build failed: ${built.stderr}`);
  }
  return tag;
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

describe.skipIf(process.env.CAUCE_HOST_SETUP_E2E !== '1')('a clean computer prepares its executor without the platform administrator', () => {
  let ownerA: SetupOwnerSession;
  beforeAll(async () => {
    work = await mkdtemp('/var/tmp/cauce-host-setup-e2e-');
    const tree = join(work, 'tree'); await mkdir(tree);
    await execute('bash', ['-c', 'git -C "$1" archive HEAD "${@:3}" | tar -x -C "$2"', 'archive', ROOT, tree, ...TREE]);
    await execute('chmod', ['-R', 'u=rwX,go=rX', join(tree, 'ops/cli')]);
    database = await startTestDatabase(); current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 8 });
    const [release, authority, image] = await Promise.all([buildRelease(tree), signedAuthority(), computerImage()]);
    const origin = await serveArtifacts({ '/release.tar': release.archive, '/fleet-ca.pem': authority.ca });
    const imageId = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
    const hook = { executable: '@release@/ops/cli/fleet-provider-hook.py', sha256: release.hookDigest, argv: [], user: '@user@' };
    packager = new HostSetupPackager(HostSetupConfigSchema.parse({ version: 1, signing_key_file: '/etc/cauce/unused.pem',
      release: { name: 'release', revision: release.revision, url: `${origin}/release.tar`, sha256: hash(release.archive), size: release.archive.length },
      files: [{ name: 'fleet-ca', url: `${origin}/fleet-ca.pem`, sha256: hash(authority.ca), size: authority.ca.length }],
      policy: {
        bundles: { codex: { directory: '@release@/adapter', digest: release.bundleDigest, executable: '/usr/local/bin/python3.12',
          executable_sha256: null, argv: [] } },
        container_templates: [{ harness_id: 'codex', prefix: 'zz-canary-', image: imageId, runtime_user: 'node', systemd_user: '@user@',
          home_directory: '/home/node', state_root: '/home/node/.cauce', profile_root: '/home/node/.cauce-profiles', python: '/usr/bin/python3' }],
        profile_templates: [{ provider: 'codex', runtime_user: 'node', path_root: '/home/node/.cauce-profiles', command: '/usr/local/bin/codex',
          command_sha256: 'f'.repeat(64), runtime_mode: 'container', container_prefix: 'zz-canary-' }],
        hooks: { authenticate: hook, profile: hook, verify: hook, revoke: hook },
        transport: { bootstrap_url: 'https://cauce.invalid/v3/bootstrap', gateway_url: 'https://cauce.invalid', ca_certificate: '@install@/files/fleet-ca', network: 'bridge' },
        authority: { identity_directory: '@identity@', host_id: '@host@', ca_certificate: '@install@/files/fleet-ca' },
      } }), generateKeyPairSync('ed25519').privateKey);
    app = await buildGateway({ pool, repository: new CauceRepository(pool), consoleOrigins: ['http://localhost'], logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 61) }),
      hostSetup: packager, signedFleetAuthorityClient: authority.client, fleetOperationsRepository: new FleetOperationsRepository(pool) });
    gatewayUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    container = `zz-canary-hostsetup-${String(process.pid)}`;
    await command('docker', ['rm', '-f', container]);
    const started = await command('docker', ['run', '-d', '--name', container, '--privileged', '--cgroupns=private', '--network', 'host',
      '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${join(tree, 'ops/cli')}:/opt/cauce-cli:ro`, image]);
    if (started.code !== 0) throw new Error(`computer did not start: ${started.stderr}`);
    const settle = async (probe: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100 && !await probe(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
    };
    await settle(async () => (await command('docker', ['exec', container, 'systemctl', 'is-system-running', '--wait'])).stdout.trim() !== '');
    await command('docker', ['exec', container, 'loginctl', 'enable-linger', 'cauce']);
    await settle(async () => (await onComputer(['systemctl', '--user', 'is-system-running'])).stdout.trim() === 'running');
    ownerA = await registerSetupOwner(app, 'setupe2e');
  }, 600_000);
  afterAll(async () => {
    if (container) await command('docker', ['rm', '-f', container]);
    await app?.close(); await bridge?.close(); await new Promise(resolve => artifacts?.close(resolve));
    await pool.end(); await current?.close();
    if (database) { await database.pool.end(); await database.container.stop(); }
    if (work) await rm(work, { recursive: true, force: true });
  }, 120_000);

  it('enrolls with the console invitation, installs the user service and reports executor_ready', async () => {
    const invitation = await inviteSetupHost(gateway(), ownerA, 'setupe2e-laptop');
    expect(invitation.setup_signer_fingerprint).toBe(packager.signerFingerprint);
    const enrolled = await cli(['enroll', '--gateway', gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation));
    expect(enrolled.code, enrolled.stderr).toBe(0);
    expect(JSON.parse(enrolled.stdout)).toMatchObject({ host_id: 'setupe2e-laptop', state: 'enrolled', executor_ready: false });
    const prepared = await cli(['setup']);
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
    const status = await cli(['status']);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ executor_ready: true, service_active: true, templates: 1 });
    expect(await capability(ownerA)).toMatchObject({ available: true, placements: [{ host_id: 'setupe2e-laptop' }] });
    expect((await pool.query('SELECT 1 FROM platform_admins')).rowCount).toBe(0);
    expect((await onComputer(['systemctl', '--user', 'is-active', unit])).stdout.trim()).toBe('active');
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
