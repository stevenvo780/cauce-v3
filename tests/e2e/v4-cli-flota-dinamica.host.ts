import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CauceRepository, FleetOperationsRepository } from '@cauce/store';
import { expect } from 'vitest';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { COMPUTER_RUNTIME, FIXTURE_PROVIDER_IDENTITY, command, docker, enrollComputer, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';
import { createFleetCliRuntimeBundle, FLEET_CLI_PROVIDER_FIXTURE, fleetCliPrepareDelivery, fleetCliRuntimeDiagnostics } from './v4-cli-flota-dinamica.runtime.js';

const execute = promisify(execFile);
const root = process.cwd();
const consoleRequire = createRequire(join(root, 'console/package.json'));
export const FLEET_CLI_OWNER = 'l2-cli-flota-dinamica-1025';
export const fleetCliRun = randomUUID().replaceAll('-', '').slice(0, 8);
export const fleetCliPrefix = `zz-canary-${FLEET_CLI_OWNER}-${fleetCliRun}`;
export const fleetCliReceipts = join(root, '.delegados/v4/recibos', FLEET_CLI_OWNER, fleetCliRun);
interface Pki { ca: string; server: { cert: string; key: string }; relay: { cert: string; key: string };
  console: { cert: string; key: string } }
export interface FleetCliRuntime {
  container: string; id: string; image: string; generation: string; home: string; stateDirectory: string;
  runtimeKey: string; hostId: string; tmuxSocket: string; codexHome: string; adapterPid: number; uid: number; gid: number;
  hostname: string; pidNamespace: string;
}
interface RuntimeRow { runtime_key: string; container_name: string; home_directory: string; state_directory: string; host_id: string }
interface ObservedAdapter { generation: string; uid: number; gid: number; pid: number; codexHome: string; tmuxTmpdir: string; releaseRoot: string;
  hostname: string; pidNamespace: string }
export interface FleetCliFixture {
  computer: ComputerHarness; page: V4Page; errors: BrowserErrorLog; baseUrl: string; directory: string; caFile: string;
  owner: V4Person; tenantId: string; hostId: string; unit: string; room: string; accountId: string; prefix: string; run: string;
  receipts: string; registry: AgentRegistry; gateway: Awaited<ReturnType<typeof buildGateway>>;
  advanceClock(ms: number): void; resetClock(): void;
  runtimeFor(alias: string): Promise<FleetCliRuntime>;
  prepareTerminal(alias: string): Promise<FleetCliRuntime>;
  resumeTerminal(alias: string, expectedMarker: string): Promise<FleetCliRuntime>;
  probeTmux(alias: string): Promise<{ panePid: number; nativeId: string; capture: string; clients: number; runtime: FleetCliRuntime }>;
  close(): Promise<void>;
}

async function makePki(directory: string): Promise<Pki> {
  const ca = join(directory, 'ca.crt');
  const caKey = join(directory, 'ca.key');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey,
    '-out', ca, '-subj', '/CN=Cauce dynamic fleet CLI E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await chmod(caKey, 0o600);
  const issue = async (name: string, purpose: 'serverAuth' | 'clientAuth') => {
    const key = join(directory, `${name}.key`), cert = join(directory, `${name}.crt`), config = join(directory, `${name}.cnf`);
    await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=' + name
      + '\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' + purpose
      + (purpose === 'serverAuth' ? '\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n' : '\n'));
    await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, `${name}.csr`), '-config', config]);
    await execute('openssl', ['x509', '-req', '-in', join(directory, `${name}.csr`), '-CA', ca, '-CAkey', caKey,
      '-CAcreateserial', '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
    await chmod(key, 0o600);
    return { key, cert };
  };
  return { ca, server: await issue('localhost', 'serverAuth'), relay: await issue('relay', 'clientAuth'),
    console: await issue('console', 'clientAuth') };
}

async function stopRelay(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolveStop, reject) => {
    const kill = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
    const deadline = setTimeout(() => { reject(new Error('owned terminal relay did not exit')); }, 7_000);
    child.once('close', () => { clearTimeout(kill); clearTimeout(deadline); resolveStop(); });
  });
  child.kill('SIGTERM');
  await stopped;
}

const observeAdapter = `import json,os,pathlib,sys
d=json.loads(pathlib.Path(sys.argv[1]).read_text());pid=d['pid']
env=dict(p.split(b'=',1) for p in pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().split(bytes([0])) if b'=' in p)
argv=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().decode().split(chr(0))
scripts=[a for a in argv if a.endswith('/adapter/src/bin/codex.js')]
if len(scripts)!=1: raise SystemExit('the live adapter script was not observed')
print(json.dumps({'generation':d['containerGeneration'],'uid':d['runtimeUid'],'gid':d['runtimeGid'],'pid':pid,
 'codexHome':env[b'CODEX_HOME'].decode(),'tmuxTmpdir':env.get(b'TMUX_TMPDIR',b'').decode(),
 'releaseRoot':str(pathlib.Path(scripts[0]).parents[3]),'hostname':os.uname().nodename,'pidNamespace':os.readlink('/proc/self/ns/pid')}))
`;

const installTerminalMaterial = `import json,os,pathlib,stat,sys
os.umask(63)
for entry in json.load(sys.stdin):
 path=pathlib.Path(entry['path']);body=entry['body'].encode();mode=entry['mode']
 path.parent.mkdir(mode=448,parents=True,exist_ok=True)
 for parent in path.parents:
  info=parent.lstat()
  if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode): raise SystemExit('terminal bootstrap parent is unsafe')
 if path.exists() or path.is_symlink():
  info=path.lstat()
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or path.read_bytes()!=body: raise SystemExit('terminal bootstrap would overwrite another file')
 else:
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
  with os.fdopen(fd,'wb') as stream: stream.write(body)
  path.chmod(mode)
print('terminal bootstrap material installed privately')
`;

export async function startFleetCliFixture(options: { candidateSource: string }): Promise<FleetCliFixture> {
  await mkdir(fleetCliReceipts, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), 'cauce-cli-flota-'));
  const pki = await makePki(directory);
  const ports = await reserveNamedLoopbackPorts(['frontend', 'gateway', 'browser', 'agent', 'health'] as const);
  const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  const owner = { ...syntheticPerson('cli-flota', fleetCliRun), email: `${fleetCliPrefix}@example.test`,
    company: { name: `zz-canary-cli-flota-${fleetCliRun}`, slug: `zz-cli-${fleetCliRun}` } };
  const registry = new AgentRegistry();
  let computer: ComputerHarness | undefined;
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  let trusted: TrustedBrowser | undefined;
  let relay: ChildProcess | undefined;
  let transport: Agent | undefined;
  let page: V4Page | undefined;
  let offset = 0;
  let logs = '';
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
  const runtimeByAlias = new Map<string, FleetCliRuntime>();
  const grantedAliases = new Set<string>();
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => trusted?.close(), async () => vite?.close(),
      async () => { if (relay) await stopRelay(relay); }, async () => gateway?.close(), async () => transport?.destroy(),
      async () => { if (computer) expect(await computer.close()).toEqual({ containers: '', volumes: '', images: '' }); },
      async () => ports.releaseAll(), async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'dynamic fleet CLI cleanup failed');
  };
  try {
    computer = await startComputerHarness({ prefix: fleetCliPrefix, consoleOrigins: [baseUrl], workRoot: '/datos',
      resourceOwner: FLEET_CLI_OWNER, runtimeBundle: createFleetCliRuntimeBundle(options.candidateSource) });
    const active = computer;
    const relayId = relayInstanceIdFromCertificate(await readFile(pki.relay.cert));
    const token = randomBytes(32).toString('base64url');
    const ticketKey = randomBytes(32);
    const tokenFile = join(directory, 'relay-token'), grants = join(directory, 'grants.json');
    const recordingDirectory = join(directory, 'recordings');
    const authorityDirectory = join(dirname(active.installRoot), 'authority');
    const agentRegistry = join(authorityDirectory, 'pty/pty_agent_identities.json'), relayIdentities = join(directory, 'relay-identities.json');
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(grants, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
    await mkdir(recordingDirectory, { mode: 0o700 });
    await writeFile(relayIdentities, JSON.stringify({ version: 1, identities: [{ certificate_sha256: relayId,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), principal: { tenant_id: owner.company.slug,
        alias: `relay${fleetCliRun}`, session_id: randomUUID(), channel: 'agent', roles: ['adapter'], permissions: ['read'] } }] }), { mode: 0o600 });
    const auth = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(active.pool), signingKey: Buffer.alloc(32, 61),
      now: () => Date.now() + offset, fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(relayIdentities)) });
    const config: TerminalConfig = { wsPath: '/v3/console/terminal/ws', ticketKey, relayToken: token, relayInstanceIds: new Set([relayId]),
      grantsFile: grants, ticketTtlSeconds: 60, sessionTtlSeconds: 900, claimLeaseSeconds: 150, maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator', operators: new Set([owner.email]), writableTuiEnabled: true, controlHoldSeconds: 300 };
    const uid = process.geteuid?.() ?? 0;
    gateway = await buildGateway({ pool: active.pool, repository: new CauceRepository(active.pool), logger: false,
      consoleOrigins: [baseUrl], authProvider: auth, hostSetup: active.packager, fleetOperationsRepository: new FleetOperationsRepository(active.pool),
      signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(dirname(active.installRoot), 'authority/signed.sock'), { ownerUid: uid, peerUid: uid }),
      https: { key: await readFile(pki.server.key), cert: await readFile(pki.server.cert), ca: await readFile(pki.ca),
        requestCert: true, rejectUnauthorized: true }, terminalCapability: terminalCapabilityAnnouncement(config) });
    await gateway.register(registerTerminalControlPlane, { pool: active.pool, authProvider: auth, config, registry });
    await ports.release('gateway');
    const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: ports.ports.gateway });
    transport = new Agent({ cert: await readFile(pki.console.cert), key: await readFile(pki.console.key), ca: await readFile(pki.ca), rejectUnauthorized: true });
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(root, 'console/vite.config.ts'), root: join(root, 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
        https: { key: await readFile(pki.server.key), cert: await readFile(pki.server.cert) },
        proxy: { [`/v3/console/terminal/relays/${relayId}/ws`]: { target: `https://127.0.0.1:${String(ports.ports.browser)}`,
          agent: transport, secure: true, changeOrigin: false, ws: true },
        '/v3': { target: gatewayUrl, agent: transport, secure: true, changeOrigin: false, ws: false } } },
    });
    await ports.release('frontend'); await vite.listen();
    trusted = await startTrustedBrowser(pki.ca, directory, [ports.ports.frontend, ports.ports.gateway]);
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    page = asV4Page(await context.newPage()); errors.watch(page, 'fleet-cli-owner');
    const form = await openRegistration(page, baseUrl);
    await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await active.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const session = { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
    const hostId = `${owner.company.slug}-pc`;
    const unit = await enrollComputer(active, session, owner.company.slug, hostId);
    const tenantId = (await active.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenantId) throw new Error('the CLI person has no registered workspace');
    const room = (await active.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
    if (!room) throw new Error('the CLI company has no registered room');
    const accountId = `zz-cli-${fleetCliRun}`;
    await active.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_CLI_FLEET_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
    const enrollment = await apiGet(page, '/v3/console/fleet/hosts/enrollments');
    expect(enrollment.status).toBe(200);
    expect(enrollment.body.enrollments).toEqual(expect.arrayContaining([expect.objectContaining({ host_id: hostId, executor_ready: true })]));
    const capability = await apiGet(page, '/v3/console/fleet/capability');
    expect(capability.status).toBe(200);
    expect(capability.body.placements).toEqual(expect.arrayContaining([expect.objectContaining({ host_id: hostId })]));
    await writeFile(join(directory, 'close-spool.json'), '', { mode: 0o600 });
    await ports.release('browser'); await ports.release('agent'); await ports.release('health');
    relay = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'services/terminal-relay/src/main.ts'], { cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: pki.ca,
        CAUCE_TERMINAL_RELAY_BIND_HOST: '127.0.0.1', CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(ports.ports.browser),
        CAUCE_TERMINAL_RELAY_AGENT_PORT: String(ports.ports.agent), CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(ports.ports.health),
        CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: pki.server.cert, CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: pki.server.key,
        CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: pki.ca, CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console',
        CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: pki.ca, CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: agentRegistry,
        CAUCE_TERMINAL_GATEWAY_URL: gatewayUrl, CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile,
        CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: pki.relay.cert, CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: pki.relay.key,
        CAUCE_TERMINAL_RELAY_INSTANCE_ID: relayId, CAUCE_TERMINAL_CLOSE_SPOOL_FILE: join(directory, 'close-spool.json'),
        CAUCE_TERMINAL_RECORDING_DIR: recordingDirectory,
        CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1', CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1', CAUCE_TERMINAL_PRESENCE_INTERVAL_SECONDS: '1' } });
    const capture = (chunk: Buffer) => { logs = (logs + chunk.toString('utf8')).slice(-16 * 1024); };
    relay.stdout?.on('data', capture); relay.stderr?.on('data', capture);
    const relayDeadline = Date.now() + 30_000;
    while (!registry.available() && Date.now() < relayDeadline) {
      if (relay.exitCode !== null || relay.signalCode !== null) throw new Error('owned relay exited before publishing its presence');
      await new Promise<void>(resolve => { setTimeout(resolve, 100); });
    }
    if (!registry.available()) throw new Error('owned relay did not publish its initial presence before the deadline');
    const ownerId = (await active.pool.query<{ id: string }>('SELECT id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.id;
    if (!ownerId) throw new Error('the CLI person has no durable identity');
    const ownerPage = page;
    const observedAdapter = async (containerId: string, runtimeKey: string, alias: string, stateDirectory: string): Promise<ObservedAdapter> => {
      const observed = await command('docker', ['exec', '--user', '0', containerId, 'python3', '-B', '-c', observeAdapter,
        `/run/cauce-fleet/${runtimeKey}/cauce-v3-adapter.json`]);
      if (observed.code === 0) return JSON.parse(observed.stdout) as ObservedAdapter;
      const diagnostic = await command('docker', ['exec', '--user', '0', containerId, 'python3', '-B', '-c', fleetCliRuntimeDiagnostics,
        runtimeKey, alias, tenantId, stateDirectory]);
      let observation: unknown = { diagnostic_unavailable: true };
      if (diagnostic.code === 0) {
        try { observation = JSON.parse(diagnostic.stdout) as unknown; } catch { /* Only structured allowlisted diagnostics are retained. */ }
      }
      await writeFile(join(fleetCliReceipts, 'runtime-observation-failure.json'), JSON.stringify({
        code: 'CANONICAL_ADAPTER_OBSERVATION_FAILED', observation,
      }, null, 2) + '\n', { mode: 0o600 });
      throw new Error('the canonical adapter metadata or live identity was unavailable; see the private runtime observation receipt');
    };
    const runtimeFor = async (alias: string): Promise<FleetCliRuntime> => {
      if (!grantedAliases.has(alias)) {
        const grantStatus = await ownerPage.evaluate(async argument => {
          const state = await fetch('/v3/auth/session', { credentials: 'same-origin' }).then(response => response.json()) as { csrf_token: string };
          const result = await fetch('/v3/console/terminal/grants', { method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf_token },
            body: JSON.stringify({ tenant_id: argument.tenantId, alias: argument.alias, grantee_human_id: argument.ownerId,
              modes: ['shell', 'harness', 'harness_rw'], note: 'Canario CLI del dueño' }) });
          return result.status;
        }, { tenantId, alias, ownerId });
        if (grantStatus !== 201) throw new Error(`the owner could not grant its terminal through the product API (${String(grantStatus)})`);
        grantedAliases.add(alias);
      }
      const row = (await active.pool.query<RuntimeRow>(`SELECT runtime_key,container_name,home_directory,state_directory,host_id
        FROM agents WHERE tenant_id=$1 AND alias=$2 AND enabled`, [tenantId, alias])).rows[0];
      if (row?.host_id !== hostId) throw new Error('CLI target does not belong to the enrolled computer');
      const inspected = JSON.parse(await docker(['inspect', row.container_name])) as { Id: string; Image: string;
        Config: { Labels: Record<string, string> }; HostConfig: { NetworkMode: string } }[];
      const container = inspected[0];
      if (container?.Config.Labels['cauce.fleet.host'] !== hostId || container.Config.Labels['cauce.fleet.alias'] !== alias
        || row.container_name === active.container) throw new Error('CLI runtime placement was not physically observed on the enrolled host');
      const observed = await observedAdapter(container.Id, row.runtime_key, alias, row.state_directory);
      expect(container.HostConfig.NetworkMode).toBe('host');
      expect(observed.pidNamespace).not.toBe(await readlink('/proc/self/ns/pid'));
      const runtime: FleetCliRuntime = { container: row.container_name, id: container.Id, image: container.Image, generation: observed.generation,
        home: row.home_directory, stateDirectory: row.state_directory, runtimeKey: row.runtime_key, hostId, tmuxSocket: 'cauce',
        codexHome: observed.codexHome, adapterPid: observed.pid, uid: observed.uid, gid: observed.gid,
        hostname: observed.hostname, pidNamespace: observed.pidNamespace };
      expect(observed.tmuxTmpdir).toBe(row.state_directory);
      runtimeByAlias.set(alias, runtime);
      return runtime;
    };
    const deliverToRuntime = async (alias: string, action: 'REMEMBER' | 'RECALL', marker: string) => {
      if (!/^[A-Za-z0-9-]{1,128}$/u.test(marker)) throw new Error('the owned SDK marker is outside the fixture contract');
      const runtime = await runtimeFor(alias);
      const observed = await observedAdapter(runtime.id, runtime.runtimeKey, alias, runtime.stateDirectory);
      const published = await command('docker', ['exec', '--user', COMPUTER_RUNTIME.user, runtime.id, 'python3', '-B', '-c',
        fleetCliPrepareDelivery, String(observed.pid), action, marker]);
      if (published.code !== 0) {
        const httpStatus = /canonical bus publication returned HTTP (\d{3})/u.exec(published.stderr)?.[1];
        const knownKind = /canonical bus publication failed: (tls|urlopen|missing_env|local_io|invalid_response)/u.exec(published.stderr)?.[1];
        const failure = { code: 'CANONICAL_BUS_PUBLICATION_FAILED', failure_kind: httpStatus ? 'http' : knownKind ?? 'unclassified',
          ...(httpStatus === undefined ? {} : { http_status: Number(httpStatus) }) };
        await writeFile(join(fleetCliReceipts, 'terminal-publication-failure.json'), JSON.stringify(failure, null, 2) + '\n', { mode: 0o600 });
        throw new Error(`canonical runtime mTLS publication failed: ${failure.failure_kind}${httpStatus ? ` HTTP ${httpStatus}` : ''}`);
      }
      const delivery = JSON.parse(published.stdout) as { message_id: string; delivery_ids: string[] };
      if (Object.keys(delivery).sort().join(',') !== 'delivery_ids,message_id'
        || typeof delivery.message_id !== 'string' || !Array.isArray(delivery.delivery_ids)
        || delivery.delivery_ids.length !== 1 || delivery.delivery_ids.some(id => typeof id !== 'string')) {
        throw new Error('the canonical SDK publication returned an invalid delivery receipt');
      }
      const expectedReply = `${action === 'REMEMBER' ? 'STORED' : 'RECALLED'}:${marker}`;
      let delivered = false;
      const deliveryDeadline = Date.now() + 120_000;
      while (!delivered && Date.now() < deliveryDeadline) {
        const row = (await active.pool.query<{ status: string; reply: string | null }>(`SELECT status,result->'output'->>'reply' AS reply
          FROM deliveries WHERE message_id=$1 AND recipient_tenant=$2 AND recipient_alias=$3`, [delivery.message_id, tenantId, alias])).rows[0];
        if (row?.status === 'done') {
          if (row.reply !== expectedReply) throw new Error('the canonical SDK delivery did not verify its owned marker');
          delivered = true;
        } else if (row && ['dead', 'failed'].includes(row.status)) throw new Error('the canonical SDK preparation delivery failed');
        else await new Promise<void>(resolve => { setTimeout(resolve, 250); });
      }
      if (!delivered) throw new Error('the canonical SDK preparation delivery did not complete before its deadline');
      return { runtime, delivery };
    };
    const resumeTerminal = async (alias: string, expectedMarker: string): Promise<FleetCliRuntime> => {
      const { runtime, delivery } = await deliverToRuntime(alias, 'RECALL', expectedMarker);
      await writeFile(join(fleetCliReceipts, 'terminal-server-resume.json'), JSON.stringify({
        mode: 'canonical_real_mtls_delivery', marker_verified: true, delivery, runtime,
      }, null, 2) + '\n', { mode: 0o600 });
      return runtime;
    };
    const prepareTerminal = async (alias: string): Promise<FleetCliRuntime> => {
      const { runtime, delivery } = await deliverToRuntime(alias, 'REMEMBER', `SERVER-PRECONDITION-${fleetCliRun}`);
      const observed = await observedAdapter(runtime.id, runtime.runtimeKey, alias, runtime.stateDirectory);
      const policy = join(active.installRoot, owner.company.slug, hostId, 'executor-policy.json');
      const readPolicy = await active.onComputer(['python3', '-B', '-c',
        'import json,sys;print(json.dumps({"state":json.load(open(sys.argv[1]))["roots"]["state"]}))', policy]);
      if (readPolicy.code !== 0) throw new Error('the enrolled computer did not expose its applied inventory root');
      const runtimeState = (JSON.parse(readPolicy.stdout) as { state: string }).state;
      const serverOps = join(dirname(active.installRoot), 'stage/ops');
      const coreConfig = join(directory, 'terminal-core-config');
      const pkiRoot = join(directory, 'terminal-pki');
      const master = join(directory, 'terminal-master.key');
      await writeFile(master, ticketKey, { mode: 0o600 });
      const provision = `set -eu
OPS=$1
c_err= c_reset= c_dim= c_warn= c_b= c_ok=
source "$OPS/cli/cauce-credenciales.lib.sh"
provision_pty_identity "$2" "$3" "$4" "$5" 0
`;
      try {
        await execute('/bin/bash', ['-c', provision, 'cauce-l2-terminal-server', serverOps, alias, tenantId, pki.ca, join(directory, 'ca.key')],
          { timeout: 90_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: coreConfig,
            CAUCE_PTY_PKI_ROOT: pkiRoot, CAUCE_PTY_MASTER_FILE: master, CAUCE_PTY_RELAY_IDENTITIES: agentRegistry,
            CAUCE_PTY_RELAY_HOST: '127.0.0.1', CAUCE_PTY_RELAY_PORT: String(ports.ports.agent) } });
      } catch { throw new Error('the canonical server PTY provisioning helper did not complete'); }
      const destinationPkiRoot = `${COMPUTER_RUNTIME.home}/.config/cauce-v3/pty-pki`;
      const material = await Promise.all(['client.crt', 'client.key', 'ca.crt', 'alias-key.hex'].map(async name => ({
        path: join(destinationPkiRoot, alias, name), body: await readFile(join(pkiRoot, alias, name), 'utf8'), mode: name === 'alias-key.hex' ? 0o400 : 0o600,
      })));
      const destinationConfig = `${COMPUTER_RUNTIME.home}/.config/cauce-v3/pty/${alias}.env`;
      const serverConfig = (await readFile(join(coreConfig, 'cauce-v3/pty', `${alias}.env`), 'utf8'))
        .replace(`PKI_DIR=${join(pkiRoot, alias)}\n`, `PKI_DIR=${join(destinationPkiRoot, alias)}\n`)
        .replace(`ALIAS_KEY_FILE=${join(pkiRoot, alias, 'alias-key.hex')}\n`, `ALIAS_KEY_FILE=${join(destinationPkiRoot, alias, 'alias-key.hex')}\n`);
      if (!serverConfig.split('\n').includes(`PKI_DIR=${join(destinationPkiRoot, alias)}`)
        || !serverConfig.split('\n').includes(`ALIAS_KEY_FILE=${join(destinationPkiRoot, alias, 'alias-key.hex')}`)) {
        throw new Error('the server PTY configuration did not preserve its canonical alias-scoped PKI paths');
      }
      material.push({ path: destinationConfig, body: serverConfig + 'CONTAINER_RUNTIME_DIR=/run\nRELAY_SERVER_NAME=localhost\n', mode: 0o600 });
      const releaseOps = join(observed.releaseRoot, 'ops');
      material.push({ path: `${COMPUTER_RUNTIME.home}/.config/systemd/user/cauce-v3-pty@${alias}.service.d/10-release.conf`,
        body: `[Service]\nEnvironment=CAUCE_PTY_OPS_ROOT=${releaseOps}\nEnvironment=CAUCE_PTY_PKI_ROOT=${destinationPkiRoot}\nEnvironment=CAUCE_FLEET_RUNTIME_STATE=${runtimeState}\n`,
        mode: 0o600 });
      const transferred = await active.onComputer(['python3', '-B', '-c', installTerminalMaterial], JSON.stringify(material));
      if (transferred.code !== 0) throw new Error('the fresh server PTY channel could not be installed in its owned computer profile');
      const installed = await active.onComputer(['env', `CAUCE_PTY_OPS_ROOT=${releaseOps}`, `CAUCE_PTY_PKI_ROOT=${destinationPkiRoot}`,
        `CAUCE_FLEET_RUNTIME_STATE=${runtimeState}`, '/bin/bash', join(releaseOps, 'pty-agent/install-pty-agent.sh'), '--enable', alias]);
      if (installed.code !== 0) throw new Error('the canonical PTY installer did not enable its alias unit on the enrolled computer');
      const readyDeadline = Date.now() + 60_000;
      while (registry.state(tenantId, alias) !== 'online' && Date.now() < readyDeadline) {
        await new Promise<void>(resolve => { setTimeout(resolve, 250); });
      }
      if (registry.state(tenantId, alias) !== 'online') throw new Error('the canonical PTY launcher did not publish its authenticated presence');
      const unitStatus = await active.onComputer(['systemctl', '--user', 'is-active', `cauce-v3-pty@${alias}.service`]);
      if (unitStatus.stdout.trim() !== 'active') throw new Error('the canonical server PTY unit is not active');
      await writeFile(join(fleetCliReceipts, 'terminal-server-precondition.json'), JSON.stringify({
        provider: FLEET_CLI_PROVIDER_FIXTURE, bootstrap_method: 'canonical_server_provisioning_and_real_mtls_delivery',
        delivery, canonical_installer: true, canonical_launcher: true, alias_unit_active: true,
        inventory_source: 'verified_applied_fleet', master_retained_on_core: true,
        runtime_source: 'candidate_git_archive',
        configured_runtime_directory: '/run', configured_relay_server_name: 'localhost',
        generated_pty_bundle_by_fixture: false, direct_pty_start_by_fixture: false, runtime,
      }, null, 2) + '\n', { mode: 0o600 });
      return runtime;
    };
    const probeTmux = async (alias: string) => {
      const runtime = runtimeByAlias.get(alias);
      if (!runtime) throw new Error('the CLI alias has no observed terminal runtime');
      const script = `import json,pathlib,re,subprocess,sys
socket=sys.argv[1];target=sys.argv[2];home=pathlib.Path(sys.argv[3])
def tmux(*args): return subprocess.check_output(['/usr/bin/tmux','-S',socket,*args],text=True)
pane=int(tmux('display-message','-p','-t',target,'#{pane_pid}').strip())
capture=tmux('capture-pane','-p','-S','-100','-t',target)
files=list((home/'sessions').glob('rollout-cli-*.jsonl'));native=[]
for file in files:
 for line in file.read_text().splitlines():
  packet=json.loads(line)
  if packet.get('type')=='session_meta': native.append(packet['payload']['id']);break
if len(set(native))!=1: raise SystemExit('the runtime has no unique native session')
print(json.dumps({'panePid':pane,'nativeId':native[0],'capture':capture,'clients':int(tmux('display-message','-p','-t',target,'#{session_attached}').strip())}))
`;
      const value = JSON.parse(await docker(['exec', '--user', COMPUTER_RUNTIME.user, runtime.id, 'python3', '-B', '-c', script,
        `${runtime.stateDirectory}/tmux-${String(runtime.uid)}/cauce`, `cauce-${runtime.runtimeKey}:agente`, runtime.codexHome])) as
        { panePid: number; nativeId: string; capture: string; clients: number };
      return { ...value, runtime };
    };
    return { computer: active, gateway, page, errors, baseUrl, directory, caFile: pki.ca, owner, tenantId, hostId, unit, room, accountId,
      prefix: fleetCliPrefix, run: fleetCliRun, receipts: fleetCliReceipts, registry, advanceClock: ms => { offset += ms; },
      resetClock: () => { offset = 0; }, runtimeFor, prepareTerminal, resumeTerminal, probeTmux, close };
  } catch (error) {
    try {
      if (page) await writeFile(join(fleetCliReceipts, 'bootstrap-failure.json'), JSON.stringify({
        error: error instanceof Error ? error.message : String(error), page: await bodySnippet(page),
        browserErrors: errors.unexpected, browserTrace: errors.trace, relay: logs,
      }, null, 2) + '\n', { mode: 0o600 });
    } finally { await close(); }
    throw error;
  }
}
