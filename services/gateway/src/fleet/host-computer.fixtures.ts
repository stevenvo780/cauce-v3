import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CauceRepository, FleetOperationsRepository, createPool, type DatabasePool } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { restrictedBrowserProxy } from '../../../../tests/e2e/ui-bootstrap-network.js';
import { buildGateway } from '../app.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { MtlsAuthProvider } from '../auth.js';
import { FleetMtlsIdentityProvider, FleetTokenProbeAuthProvider } from './mtls-identities.js';
import { startSignedFleetAuthorityBridge } from './authority/signed-bridge.js';
import { SignedFleetAuthorityClient } from './authority/signed-client.js';
import { HostSetupPackager, resolveHostSetup } from './host-setup.js';
import { inviteSetupHost, type SetupOwnerSession } from './host-setup.fixtures.js';

/**
 * A clean computer for physical fleet tests: PostgreSQL, the console gateway, the signed authority with its TLS
 * bootstrap gateway, a release built from the tracked tree and a systemd container that shares the host Docker.
 * The release and the agent image go through `ops/scripts/host-release.py pack` and the gateway serves both; the
 * agent image is removed before the computer starts, so `setup` has to load it.
 * Resource names start with `prefix`; setup's config-digest tag is tracked separately for cleanup.
 */
const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const COMPUTER_IMAGE = `FROM node:22-bookworm AS node
FROM docker:29-cli AS docker
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session openssl openssh-client ca-certificates \\
  && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir pyyaml==6.0.3
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
RUN useradd -m -u 1500 -s /bin/bash cauce && useradd -m -u 1000 -s /bin/bash node \\
  && ln -s /usr/local/bin/python3 /usr/bin/python3
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
/** The account identity the pinned provider CLI fixture reports; provider accounts must use it. */
export const FIXTURE_PROVIDER_IDENTITY = 'host-setup@example.test';
const PROVIDER_CLI = `#!/usr/local/bin/python3
import json,re,sys
if 'app-server' in sys.argv:
 for line in sys.stdin:
  packet=json.loads(line)
  if 'id' in packet:
   result={'account':{'type':'chatgpt','email':'${FIXTURE_PROVIDER_IDENTITY}'}} if packet['method']=='account/read' else {}
   print(json.dumps({'id':packet['id'],'result':result}),flush=True)
else:
 prompt=' '.join(sys.argv[1:]) if sys.argv[-1]!='-' else sys.stdin.read()
 nonce=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',prompt)
 if nonce is None: sys.exit(1)
 print(json.dumps({'type':'thread.started','thread_id':'host-setup-fixture'}))
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':nonce.group(0)}}))
`;
/**
 * A provider CLI that starts logged out, for the console login. The provider login checks that the exact pinned
 * executable runs, so the login is a static binary baked root-owned into the agent image, as a real CLI would be.
 * It asks for a device code on its terminal and then writes its account into CODEX_HOME; every other command
 * goes to the Python fixture, whose account/read answers only once that file exists.
 */
export const FIXTURE_DEVICE_CODE = 'FIXTURE-DEVICE-CODE';
export const FIXTURE_LOGIN_DONE = 'FIXTURE_LOGIN_SUCCEEDED';
const LOGIN_CLI = '/usr/local/bin/cauce-fixture-codex';
const LOGIN_CLI_SCRIPT = '/usr/local/lib/cauce-fixture/provider-cli.py';
const LOGIN_PROVIDER_CLI = PROVIDER_CLI.replace(`result={'account':{'type':'chatgpt','email':'${FIXTURE_PROVIDER_IDENTITY}'}}`,
  `import os\n   home=os.environ.get('CODEX_HOME','')\n   logged=home.startswith('/') and os.path.isfile(os.path.join(home,'auth.json'))\n`
  + `   result={'account':{'type':'chatgpt','email':'${FIXTURE_PROVIDER_IDENTITY}'} if logged else None}`);
const LOGIN_CLI_SOURCE = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "login") && !strcmp(argv[2], "--device-auth")) {
    const char *home = getenv("CODEX_HOME"); char line[256], path[4096];
    if (!home || home[0] != '/') return 2;
    printf("Open https://auth.example.test/device and enter the code ${FIXTURE_DEVICE_CODE}\\n"); fflush(stdout);
    if (!fgets(line, sizeof line, stdin)) return 3;
    line[strcspn(line, "\\r\\n")] = 0;
    if (strcmp(line, "${FIXTURE_DEVICE_CODE}")) { printf("FIXTURE_LOGIN_REJECTED\\n"); return 4; }
    if (snprintf(path, sizeof path, "%s/auth.json", home) >= (int)sizeof path) return 5;
    FILE *file = fopen(path, "w"); if (!file) return 6;
    fprintf(file, "{\\"email\\":\\"${FIXTURE_PROVIDER_IDENTITY}\\"}\\n"); if (fclose(file)) return 7;
    printf("${FIXTURE_LOGIN_DONE} ${FIXTURE_PROVIDER_IDENTITY}\\n"); fflush(stdout); return 0;
  }
  if (argc > 60) return 8;
  char *forward[64] = { "/usr/local/bin/python3", "${LOGIN_CLI_SCRIPT}" };
  for (int index = 1; index < argc; index++) forward[index + 1] = argv[index];
  forward[argc + 1] = NULL; execv(forward[0], forward); return 127;
}
`;
const LOGIN_IMAGE_LAYER = `COPY cauce-fixture-codex ${LOGIN_CLI}
COPY provider-cli.py ${LOGIN_CLI_SCRIPT}
RUN chmod 0755 ${LOGIN_CLI} && chmod 0644 ${LOGIN_CLI_SCRIPT}
`;
const AS_USER = ['-u', 'cauce', '-e', 'HOME=/home/cauce', '-e', 'XDG_RUNTIME_DIR=/run/user/1500'];
const TREE = ['services/gateway/src', 'packages/store/src', 'packages/protocol/src', 'packages/adapter-sdk/descriptors',
  'ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/schemas', 'ops/pty-agent',
  'ops/guardias/cauce-estado', 'ops/guardias/cauce-sesiones', 'ops/guardias/cauce-attach'];
const RELEASE_PARTS = ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/schemas', 'ops/pty-agent',
  'ops/guardias/cauce-estado', 'ops/guardias/cauce-sesiones', 'ops/guardias/cauce-attach'];
const AGENT_FORWARDER = `import { writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
const [socketPath, target, listen = '9443'] = process.argv.slice(2);
const port = Number(target);
const listenPort = Number(listen);
if (!socketPath || [port, listenPort].some(value => !Number.isInteger(value) || value < 1 || value > 65535)) throw new Error('Invalid transport target');
createServer(client => {
  client.pause();
  const upstream = createConnection(socketPath);
  const close = () => { client.destroy(); upstream.destroy(); };
  for (const socket of [client, upstream]) {
    socket.on('error', close);
    socket.once('close', close);
    socket.setTimeout(5000, close);
  }
  let greeted = false;
  let buffered = Buffer.alloc(0);
  const receive = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 512) { close(); return; }
    if (!greeted) {
      if (buffered.length < 2) return;
      if (!buffered.subarray(0, 2).equals(Buffer.from([5, 0]))) { close(); return; }
      greeted = true;
      buffered = buffered.subarray(2);
      upstream.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]));
    }
    if (buffered.length < 10) return;
    if (!buffered.subarray(0, 10).equals(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))) { close(); return; }
    upstream.off('data', receive);
    client.setTimeout(0); upstream.setTimeout(0);
    if (buffered.length > 10) client.write(buffered.subarray(10));
    buffered = Buffer.alloc(0);
    client.pipe(upstream); upstream.pipe(client); client.resume();
  };
  upstream.on('data', receive);
  upstream.once('connect', () => { upstream.write(Buffer.from([5, 1, 0])); });
}).on('error', error => { writeFileSync('/tmp/transport-error', error.code ?? 'unknown'); })
  .listen(listenPort, '0.0.0.0', () => { writeFileSync('/tmp/transport-ready', String(listenPort)); });
`;

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface DockerInventory { containers: string; volumes: string; images: string }
export interface ComputerRuntimeBundle {
  readonly providerCli: string;
  readonly sharedTui: boolean;
  stage(directory: string): Promise<readonly string[]>;
}
/** The runtime the computer's single container template approves; the executor derives each agent from it. */
export const COMPUTER_RUNTIME = { user: 'cauce', home: '/home/cauce', stateRoot: '/home/cauce/.cauce' } as const;

export function command(file: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', error => { resolve({ code: 1, stdout, stderr: stderr + error.message }); });
    child.once('close', code => { resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
/** Docker output that fails loudly: an empty listing must mean "nothing there", never "docker failed". */
export async function docker(args: string[]): Promise<string> {
  const result = await command('docker', args);
  if (result.code !== 0) throw new Error(`docker ${args[0] ?? ''} failed (${String(result.code)}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}
export async function dockerInventory(prefix: string): Promise<DockerInventory> {
  return {
    containers: await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${prefix}`]),
    volumes: await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${prefix}`]),
    images: await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${prefix}:*`]),
  };
}

export interface ComputerHarness {
  readonly prefix: string; readonly installRoot: string; readonly pool: DatabasePool; readonly databaseUrl: string;
  /** Immutable local Docker Id of the agent image; absent until `setup` loads it. */
  readonly agentImage: string;
  readonly configImage: string;
  readonly app: Awaited<ReturnType<typeof buildGateway>>; readonly gatewayUrl: string; readonly packager: HostSetupPackager;
  /** Name of the computer container; agent containers are `${prefix}-${runtime_key}`. */
  readonly container: string;
  readonly onComputer: (args: string[], input?: string) => Promise<CommandResult>;
  readonly cli: (args: string[], input?: string) => Promise<CommandResult>;
  /** Stops everything it started and returns the prefix inventory observed after cleanup. */
  readonly close: () => Promise<DockerInventory>;
}

interface Owned {
  work?: string; database?: TestDatabase; current?: EmptyTestDatabase; pool?: DatabasePool; container?: string; image?: string;
  agentImage?: string; imageReference?: string; app?: Awaited<ReturnType<typeof buildGateway>>; bootstrapApp?: Awaited<ReturnType<typeof buildGateway>>;
  bridge?: Awaited<ReturnType<typeof startSignedFleetAuthorityBridge>>;
  transportProxy?: Awaited<ReturnType<typeof restrictedBrowserProxy>>;
}

async function createAgentTransport(work: string, prefix: string, image: string, network: string) {
  const directory = join(work, 'transport'); await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'proxy.sock');
  if (Buffer.byteLength(socketPath) > 107) throw new Error('Agent transport path exceeds Unix socket limit');
  await writeFile(join(directory, 'forwarder.mjs'), AGENT_FORWARDER, { mode: 0o400 });
  const user = `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
  const container = `${prefix}-transport`;
  await docker(['run', '-d', '--name', container, '--network', network, '--user', user, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '--mount', `type=bind,src=${directory},dst=/transport,readonly`, image, '/bin/sleep', 'infinity']);
  const networks = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container])) as
    Record<string, { IPAddress: string }>;
  const address = networks[network]?.IPAddress;
  if (address === undefined || isIP(address) !== 4) throw new Error('Agent transport has no IPv4 address on its exact network');
  return { container, user, address, socketPath };
}

async function startAgentForwarder(transport: Awaited<ReturnType<typeof createAgentTransport>>, owned: Owned,
  bootstrapPort: number, gatewayPort: number) {
  owned.transportProxy = await restrictedBrowserProxy({ socketPath: transport.socketPath }, [bootstrapPort, gatewayPort]);
  const socket = await lstat(transport.socketPath);
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) {
    throw new Error('Agent transport socket ownership or mode differs');
  }
  await startTransportListener(transport, bootstrapPort);
}

async function startTransportListener(transport: { user: string; container: string }, targetPort: number, listenPort = 9443) {
  await docker(['exec', '-d', '--user', transport.user, transport.container, '/usr/local/bin/node', '/transport/forwarder.mjs',
    '/transport/proxy.sock', String(targetPort), String(listenPort)]);
  const readiness = `import { readFile } from 'node:fs/promises';
for (let attempt = 0; attempt < 50; attempt++) {
  try { if (await readFile('/tmp/transport-ready', 'utf8') === process.argv[1]) process.exit(0); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
let observed; let failure;
try { observed = await readFile('/tmp/transport-ready', 'utf8'); } catch {}
try { failure = await readFile('/tmp/transport-error', 'utf8'); } catch {}
throw new Error('Agent transport did not become ready: '+JSON.stringify({expected:process.argv[1],observed,failure}));`;
  await docker(['exec', '--user', transport.user, transport.container, '/usr/local/bin/node', '--input-type=module', '-e', readiness, String(listenPort)]);
}

async function buildRelease(work: string, tree: string, agentImage: string, providers: string[], runtimeBundle?: ComputerRuntimeBundle) {
  const stage = join(work, 'stage');
  for (const part of RELEASE_PARTS) {
    await mkdir(dirname(join(stage, part)), { recursive: true });
    await cp(join(tree, part), join(stage, part), { recursive: true });
  }
  await cp(join(tree, 'packages/adapter-sdk/descriptors'), join(stage, 'adapter/packages/adapter-sdk/dist/descriptors'), { recursive: true });
  const providerCli = runtimeBundle?.providerCli ?? PROVIDER_CLI;
  await writeFile(join(stage, 'adapter/provider-cli.py'), providerCli, { mode: 0o755 });
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
    '--log-level=error', `--outfile=${join(stage, 'adapter/bootstrap-runtime.mjs')}`, `--alias:@cauce/protocol=${join(tree, 'packages/protocol/src')}`]);
  const argv = runtimeBundle === undefined ? ['@release@/adapter/bootstrap-runtime.mjs'] : await runtimeBundle.stage(join(stage, 'adapter'));
  await mkdir(join(stage, 'services/gateway/dist/fleet'), { recursive: true });
  await execute(join(ROOT, 'node_modules/.bin/esbuild'), [join(tree, 'services/gateway/src/fleet/main.ts'), '--bundle', '--platform=node',
    '--format=esm', '--target=node22', '--external:pg-native', '--log-level=error', `--outfile=${join(stage, 'services/gateway/dist/fleet/main.js')}`,
    `--alias:@cauce/store=${join(tree, 'packages/store/src/index.ts')}`, `--alias:@cauce/protocol=${join(tree, 'packages/protocol/src')}`,
    '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
  { env: { ...process.env, NODE_PATH: ['services/gateway', 'packages/store', 'packages/protocol', ''].map(part => join(ROOT, part, 'node_modules')).join(':') } });
  const revision = (await execute('git', ['-C', ROOT, 'rev-parse', 'HEAD'])).stdout.trim();
  const directory = join(work, 'host-release');
  const packed = await execute('python3', [join(ROOT, 'ops/scripts/host-release.py'), 'pack', '--stage', stage, '--out', directory,
    '--revision', revision, '--image', agentImage, ...providers.flatMap(item => ['--provider', item]),
    '--pin', `provider_cli_sha256=${hash(providerCli)}`], { maxBuffer: 1024 * 1024 });
  const manifest = JSON.parse(packed.stdout) as { release: { sha256: string }; image: { id: string; sha256: string; size: number };
    pins: Record<string, string> };
  return { directory, revision, manifest, argv };
}

export interface ComputerTerminal {
  masterFile: string; masterSha256: string; relayHost: string; relayPort: number; serverName?: string;
}

async function signedAuthority(work: string, pool: DatabasePool, owned: Owned, gatewayAddress?: string, terminal?: ComputerTerminal) {
  const directory = join(work, 'authority'); const state = join(directory, 'state');
  await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const registryFile = (name: string): string => join(directory, name, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
  const registries = { base_mtls: registryFile('base_mtls'), base_token: registryFile('base_token'),
    fleet_mtls: registryFile('fleet_mtls'), fleet_token: registryFile('fleet_token'),
    pty: join(directory, 'pty', 'pty_agent_identities.json') };
  for (const [name, file] of Object.entries(registries)) {
    await mkdir(join(directory, name), { mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: 1, ...(name === 'pty' ? { agents: [] } : { identities: [] }) }), { mode: 0o600 });
  }
  const certificate = join(directory, 'ca.crt'), key = join(directory, 'ca.key');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-subj', '/CN=host-setup-e2e-authority',
    '-keyout', key, '-out', certificate, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await chmod(key, 0o600);
  const policyFile = join(directory, 'issuer-policy.json');
  await writeFile(policyFile, JSON.stringify({ version: 1, state_root: state, registries, signer: { certificate, key,
    certificate_sha256: hash(await readFile(certificate)), key_sha256: hash(await readFile(key)) },
    ...(terminal === undefined ? {} : { terminal: { master_file: terminal.masterFile, master_sha256: terminal.masterSha256,
      relay_host: terminal.relayHost, relay_port: terminal.relayPort,
      ...(terminal.serverName === undefined ? {} : { relay_server_name: terminal.serverName }) } }) }), { mode: 0o600 });
  const executable = join(ROOT, 'ops/cli/fleet-authority-issuer.py');
  const socket = join(directory, 'signed.sock'); const uid = process.geteuid?.() ?? 0;
  owned.bridge = await startSignedFleetAuthorityBridge(socket, pool, { ownerUid: uid, peerUid: uid, command: { python: '/usr/bin/python3', executable,
    sha256: hash(await readFile(executable)), policy_file: policyFile, policy_sha256: hash(await readFile(policyFile)) } });
  await writeFile(join(directory, 'extensions'), `subjectAltName=IP:127.0.0.1${gatewayAddress ? `,IP:${gatewayAddress}` : ''}\nextendedKeyUsage=serverAuth\n`);
  await execute('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=host-setup-gateway',
    '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', certificate, '-CAkey', key,
    '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'extensions'), '-out', join(directory, 'server.crt')]);
  const provider = (namespace: 'bootstrap' | 'normal') => new MtlsAuthProvider(new FleetMtlsIdentityProvider(
    registries.base_mtls, registries.fleet_mtls, namespace, uid));
  owned.bootstrapApp = await buildGateway({ pool, repository: new CauceRepository(pool), logger: false, authProvider: provider('normal'),
    bootstrapProviders: { bootstrap: provider('bootstrap'), normal: provider('normal'),
      token: new FleetTokenProbeAuthProvider(registries.fleet_token, uid, registries.base_token) },
    https: { key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.crt')),
      ca: await readFile(certificate), requestCert: true, rejectUnauthorized: true } });
  return { client: new SignedFleetAuthorityClient(socket, { ownerUid: uid, peerUid: uid }), caFile: certificate };
}

async function closeOwned(owned: Owned, prefix: string): Promise<DockerInventory> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { errors.push(error); } };
  const present = await dockerInventory(prefix);
  if (owned.container && owned.work && present.containers.split('\n').includes(owned.container)) {
    // The executor user owns the install root inside the computer; only it can empty that bind mount.
    const removeInstall = 'import os,pathlib,shutil,sys\np=pathlib.Path(sys.argv[1])\n'
      + 'for child in p.iterdir():\n shutil.rmtree(child) if child.is_dir() else child.unlink()\n'
      + 'os.chown(p,int(sys.argv[2]),int(sys.argv[3]));os.chmod(p,448)\n';
    const work = owned.work;
    await attempt(() => docker(['exec', owned.container ?? '', '/usr/local/bin/python3', '-c', removeInstall, join(work, 'install'),
      String(process.getuid?.() ?? 0), String(process.getgid?.() ?? 0)]));
  }
  for (const name of present.containers.split('\n').filter(Boolean)) await attempt(() => docker(['rm', '-f', name]));
  for (const name of present.volumes.split('\n').filter(Boolean)) await attempt(() => docker(['volume', 'rm', name]));
  await attempt(async () => owned.transportProxy?.close());
  await attempt(async () => owned.app?.close());
  await attempt(async () => owned.bootstrapApp?.close());
  await attempt(async () => owned.bridge?.close());
  const agentImage = owned.agentImage;
  const imageReference = owned.imageReference;
  if (imageReference && agentImage) {
    const tagged = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', imageReference]);
    if (tagged.code === 0 && tagged.stdout.trim() === agentImage) await attempt(() => docker(['image', 'rm', imageReference]));
  }
  if (agentImage && (await command('docker', ['image', 'inspect', agentImage])).code === 0) await attempt(() => docker(['image', 'rm', agentImage]));
  if (owned.image) await attempt(() => docker(['image', 'rm', owned.image ?? '']));
  const after = await dockerInventory(prefix);
  await attempt(async () => owned.pool?.end());
  await attempt(async () => owned.current?.close());
  if (owned.database) { const database = owned.database; await attempt(() => database.pool.end()); await attempt(() => database.container.stop()); }
  if (owned.work) { const work = owned.work; await attempt(() => rm(work, { recursive: true, force: true })); }
  if (errors.length) throw new AggregateError(errors, `computer harness ${prefix} cleanup was incomplete`);
  return after;
}

/** Builds the computer image; with the login fixture, its context carries the logged-out provider CLI. */
async function buildComputerImage(work: string, image: string, providerLogin: boolean, sharedTui: boolean): Promise<string | undefined> {
  const recipe = sharedTui ? COMPUTER_IMAGE.replace('systemd-sysv dbus', 'systemd-sysv tmux dbus') : COMPUTER_IMAGE;
  if (!providerLogin) {
    const built = await command('docker', ['build', '-q', '-t', image, '-'], recipe);
    if (built.code !== 0) throw new Error(`computer image build failed: ${built.stderr}`);
    return undefined;
  }
  const context = join(work, 'computer-image'); await mkdir(context);
  await writeFile(join(context, 'Dockerfile'), recipe + LOGIN_IMAGE_LAYER);
  await writeFile(join(context, 'provider-cli.py'), LOGIN_PROVIDER_CLI);
  await writeFile(join(context, 'login.c'), LOGIN_CLI_SOURCE);
  await execute('/usr/bin/cc', ['-static', '-O2', '-o', join(context, 'cauce-fixture-codex'), join(context, 'login.c')], { timeout: 60_000 });
  const built = await command('docker', ['build', '-q', '-t', image, context]);
  if (built.code !== 0) throw new Error(`computer image build failed: ${built.stderr}`);
  return hash(await readFile(join(context, 'cauce-fixture-codex')));
}

export async function startComputerHarness(options: {
  prefix: string; consoleOrigins: string[]; providerLogin?: boolean; agentNetwork?: { name: string };
  workRoot?: string; dockerSocket?: string; hostDirectories?: readonly string[];
  resourceOwner?: string;
  runtimeBundle?: ComputerRuntimeBundle;
  extraSourceFiles?: readonly string[];
  terminal?: ComputerTerminal;
}): Promise<ComputerHarness> {
  const { prefix } = options; const owned: Owned = {};
  try {
    const work = await mkdtemp(join(options.workRoot ?? '/tmp', `${prefix}-`)); owned.work = work;
    await chmod(work, 0o755); await mkdir(join(work, 'install'));
    const tree = join(work, 'tree'); await mkdir(tree);
    const tracked = (await execute('git', ['-C', ROOT, 'ls-files', '-z', '--', ...TREE])).stdout.split('\0').filter(Boolean);
    const deleted = new Set((await execute('git', ['-C', ROOT, 'ls-files', '--deleted', '-z', '--', ...TREE])).stdout.split('\0'));
    const extra = options.extraSourceFiles ?? [];
    if (extra.some(part => part.includes('..') || !TREE.some(root => part.startsWith(`${root}/`)))) {
      throw new Error('extra fixture source must belong to the approved release tree');
    }
    for (const part of [...new Set([...tracked, ...extra])].filter(part => !deleted.has(part))) {
      await mkdir(dirname(join(tree, part)), { recursive: true }); await cp(join(ROOT, part), join(tree, part));
    }
    await execute('chmod', ['-R', 'u=rwX,go=rX', join(tree, 'ops/cli')]);
    owned.database = await startTestDatabase(); owned.current = await startTestCaseDatabase(owned.database);
    const pool = createPool(owned.current.url, { max: 8 }); owned.pool = pool;
    let loginCli: string | undefined;
    const images = async () => {
      owned.image = `${prefix}:computer`;
      loginCli = await buildComputerImage(work, owned.image, options.providerLogin === true, options.runtimeBundle?.sharedTui === true);
      // Its own layer makes `docker load` import data, not only a configuration over layers the computer already has.
      const agent = await command('docker', ['build', '-q', '-t', `${prefix}:agent`, '-'],
        `FROM ${owned.image}\nRUN printf '%s\\n' '${prefix}' > /etc/cauce-agent-image\n`);
      if (agent.code !== 0) throw new Error(`agent image build failed: ${agent.stderr}`);
      owned.agentImage = agent.stdout.trim();
      return { computer: owned.image, agent: `${prefix}:agent` };
    };
    const built = await images();
    const transport = options.agentNetwork === undefined ? undefined : await createAgentTransport(work, prefix, built.computer, options.agentNetwork.name);
    const authority = await signedAuthority(work, pool, owned, transport?.address, options.terminal);
    // With the login fixture the pack measures the provider CLI inside the agent image, as the real build does.
    const release = await buildRelease(work, tree, built.agent, loginCli === undefined ? [] : [`codex=${LOGIN_CLI}`], options.runtimeBundle);
    const imageReference = `cauce-host-image:${release.manifest.image.id.replace(/^sha256:/u, '')}`;
    const previous = await command('docker', ['image', 'inspect', imageReference]);
    if (previous.code !== 0) {
      if (!/no such image|not found/iu.test(previous.stderr)) throw new Error(`cannot inspect setup image reference: ${previous.stderr}`);
      owned.imageReference = imageReference;
    }
    await docker(['image', 'rm', built.agent]);
    if (loginCli !== undefined && release.manifest.pins.codex_command_sha256 !== loginCli) {
      throw new Error(`the release measured another login CLI in the agent image: ${JSON.stringify(release.manifest.pins)}`);
    }
    const provider = loginCli === undefined ? { command: '@release@/adapter/provider-cli.py', command_sha256: '@pin:provider_cli_sha256@' }
      : { command: '@pin:codex_command@', command_sha256: '@pin:codex_command_sha256@',
        login: { method: 'device', command: ['@pin:codex_command@', 'login', '--device-auth'], sha256: '@pin:codex_command_sha256@' } };
    if (!owned.bootstrapApp) throw new Error('bootstrap gateway absent');
    const bootstrapOrigin = await owned.bootstrapApp.listen({ host: '127.0.0.1', port: 0 });
    const agentOrigin = transport === undefined ? bootstrapOrigin : `https://${transport.address}:9443`;
    console.info('HOST_SETUP_RELEASE', JSON.stringify({ revision: release.revision, source: 'working-tree-tracked',
      archive_sha256: release.manifest.release.sha256, image_id: release.manifest.image.id, image_archive_bytes: release.manifest.image.size,
      pins: release.manifest.pins }));
    const hook = { executable: '@release@/ops/cli/fleet-provider-hook.py', sha256: '@pin:hook_sha256@', argv: [], user: '@user@' };
    const packager = new HostSetupPackager(await resolveHostSetup({ version: 1, signing_key_file: '/etc/cauce/unused.pem',
      release_directory: release.directory, files: [{ name: 'fleet-ca', path: authority.caFile }],
      policy: {
        bundles: { codex: { directory: '@release@/adapter', digest: '@pin:adapter_digest@', executable: '/usr/local/bin/node',
          executable_sha256: null, argv: release.argv,
          ...(options.runtimeBundle?.sharedTui === true ? {} : { shared_tui: false }) } },
        // The runtime user shares the executor's uid: the provider pin check inside the agent container only trusts
        // ancestors owned by root or by the checking user, and the release lives under the executor's install root.
        container_templates: [{ harness_id: 'codex', prefix: `${prefix}-`, image: '@pin:image@', runtime_user: COMPUTER_RUNTIME.user, systemd_user: '@user@',
          home_directory: COMPUTER_RUNTIME.home, state_root: COMPUTER_RUNTIME.stateRoot, profile_root: `${COMPUTER_RUNTIME.home}/.cauce-profiles`,
          python: '/usr/local/bin/python3.12' }],
        profile_templates: [{ provider: 'codex', runtime_user: COMPUTER_RUNTIME.user, path_root: `${COMPUTER_RUNTIME.home}/.cauce-profiles`,
          ...provider, runtime_mode: 'container', container_prefix: `${prefix}-` }],
        hooks: { authenticate: hook, profile: hook, verify: hook, revoke: hook },
        transport: { bootstrap_url: agentOrigin, gateway_url: agentOrigin, ca_certificate: '@install@/files/fleet-ca',
          network: options.agentNetwork?.name ?? 'host' },
        authority: { identity_directory: '@identity@', host_id: '@host@', ca_certificate: '@install@/files/fleet-ca' },
        ...(options.terminal === undefined ? {} : { terminal: { required: true } }),
      } }), generateKeyPairSync('ed25519').privateKey);
    const app = await buildGateway({ pool, repository: new CauceRepository(pool), consoleOrigins: options.consoleOrigins, logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 61) }),
      hostSetup: packager, signedFleetAuthorityClient: authority.client, fleetOperationsRepository: new FleetOperationsRepository(pool) });
    owned.app = app;
    const gatewayUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    if (transport !== undefined) await startAgentForwarder(transport, owned, Number(new URL(bootstrapOrigin).port), Number(new URL(gatewayUrl).port));
    const container = prefix;
    const started = await command('docker', ['run', '-d', '--name', container,
      ...(options.resourceOwner ? ['--label', `cauce.e2e.owner=${options.resourceOwner}`] : []), '--privileged', '--cgroupns=private',
      '--network', options.dockerSocket !== undefined && options.agentNetwork !== undefined ? options.agentNetwork.name : 'host',
      '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${join(tree, 'ops/cli')}:/opt/cauce-cli:ro`,
      ...(options.dockerSocket !== undefined && transport !== undefined ? ['--mount', `type=bind,src=${join(work, 'transport')},dst=/transport,readonly`] : []),
      ...(options.hostDirectories ?? []).flatMap(directory => ['--mount', `type=bind,src=${directory},dst=${directory},readonly`]),
      '-v', `${options.dockerSocket ?? '/var/run/docker.sock'}:/var/run/docker.sock`, '-v', `${join(work, 'install')}:${join(work, 'install')}`, built.computer]);
    if (started.code !== 0) throw new Error(`computer did not start: ${started.stderr}`);
    owned.container = container;
    const onComputer = (args: string[], input?: string) => command('docker', ['exec', '-i', ...AS_USER, container, ...args], input);
    const settle = async (probe: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100 && !await probe(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
    };
    await settle(async () => ['running', 'degraded'].includes(
      (await command('docker', ['exec', container, 'systemctl', 'is-system-running', '--wait'])).stdout.trim()));
    if (options.dockerSocket !== undefined && transport !== undefined) {
      await startTransportListener({ ...transport, container }, Number(new URL(gatewayUrl).port), Number(new URL(gatewayUrl).port));
    }
    const dockerGroup = String((await stat(options.dockerSocket ?? '/var/run/docker.sock')).gid);
    await docker(['exec', container, 'groupadd', '-g', dockerGroup, 'fixture-docker']);
    await docker(['exec', container, 'usermod', '-aG', 'fixture-docker', 'cauce']);
    await docker(['exec', container, 'chown', 'cauce:cauce', join(work, 'install')]);
    await docker(['exec', container, 'loginctl', 'enable-linger', 'cauce']);
    await settle(async () => (await onComputer(['systemctl', '--user', 'is-system-running'])).stdout.trim() === 'running');
    if (!owned.agentImage) throw new Error('agent image absent');
    return { prefix, installRoot: join(work, 'install'), agentImage: owned.agentImage, configImage: release.manifest.image.id,
      pool, databaseUrl: owned.current.url, app,
      gatewayUrl, packager, container,
      onComputer, cli: (args, input) => onComputer(['python3', '/opt/cauce-cli/host_enrollment.py', ...args], input),
      close: () => closeOwned(owned, prefix) };
  } catch (error) {
    try { await closeOwned(owned, prefix); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `computer harness ${prefix} failed and its cleanup was incomplete`); }
    throw error;
  }
}

interface ConsoleSession { cookie: string; origin: string; 'x-csrf-token': string }
async function readJson<T>(harness: ComputerHarness, session: ConsoleSession, url: string): Promise<T> {
  const response = await harness.app.inject({ method: 'GET', url, headers: { ...session } });
  if (response.statusCode !== 200) throw new Error(`${url} answered ${String(response.statusCode)}: ${response.body}`);
  return response.json<T>();
}
export function hostEnrollments(harness: ComputerHarness, session: ConsoleSession) {
  return readJson<{ enrollments: { host_id: string; executor_ready: boolean }[] }>(harness, session, '/v3/console/fleet/hosts/enrollments');
}
export function fleetCapability(harness: ComputerHarness, session: ConsoleSession) {
  return readJson<{ available: boolean; placements: { host_id: string }[] }>(harness, session, '/v3/console/fleet/capability');
}

/** The company invites the computer, which enrolls and installs its executor until the gateway sees executor_ready. */
export async function enrollComputer(harness: ComputerHarness, session: SetupOwnerSession, company: string, hostId: string): Promise<string> {
  const invitation = await inviteSetupHost(harness.app, session, hostId);
  const enrolled = await harness.cli(['enroll', '--gateway', harness.gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation));
  if (enrolled.code !== 0) throw new Error(`enroll failed: ${enrolled.stderr}`);
  const prepared = await harness.cli(['setup', '--install-root', harness.installRoot]);
  if (prepared.code !== 0) throw new Error(`setup failed: ${prepared.stderr}`);
  const unit = `cauce-v3-host-executor-${company}-${hostId}.service`;
  for (let attempt = 0; attempt < 90; attempt++) {
    if ((await hostEnrollments(harness, session)).enrollments.some(row => row.host_id === hostId && row.executor_ready)) return unit;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const journal = (await harness.onComputer(['journalctl', '--user', '-u', unit, '--no-pager', '-n', '50'])).stdout;
  throw new Error(`executor never became ready:\n${journal}`);
}
