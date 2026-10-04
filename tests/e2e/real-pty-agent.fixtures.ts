import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { deriveAliasKey } from '../../services/gateway/src/terminal/tickets.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { startTrustedBrowser, type BrowserContext, type BrowserPage, type TrustedBrowser } from './console-functional-browser.fixtures.js';

const execute = promisify(execFile);
const APPROVED_NODE_IMAGE = 'node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';
const TARGET_UID = 1000;
const TARGET_GID = 1000;
const OWNER_LABEL = 'cauce.e2e.owner=real-pty-agent';
const NONCE = randomUUID();
const TENANT = 'Steven';
const OPERATOR_ALIAS = `ptyop${randomBytes(4).toString('hex')}`;
const TARGET_ALIAS = `ptyagent${randomBytes(4).toString('hex')}`;
const OPERATOR_EMAIL = `pty-${randomBytes(5).toString('hex')}@cauce.test`;
const OPERATOR_PASSWORD = randomBytes(24).toString('base64url');
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));

interface HttpResult { status: number; headers: import('node:http').IncomingHttpHeaders; body: string }
interface Pki {
  directory: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
  relayClientCert: string;
  relayClientKey: string;
  consoleClientCert: string;
  consoleClientKey: string;
  agentCert: string;
  agentKey: string;
  agentRegistry: string;
  relayIdentityFile: string;
  relayInstanceId: string;
}
interface BrowserSession { cookie: string; csrf: string }
export interface PtySocket {
  socket: import('ws').WebSocket;
  waitControl(predicate: (value: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitOutput(predicate: (value: string) => boolean, timeoutMs?: number): Promise<string>;
  waitForClose(timeoutMs?: number): Promise<void>;
  closeCode: number | undefined;
}
export interface RealPtyFixture {
  database: TestDatabase;
  app: Awaited<ReturnType<typeof buildGateway>>;
  directory: string;
  gatewayUrl: string;
  baseUrl: string;
  browserContainer: string;
  browserPage(viewport: { width: number; height: number }): Promise<BrowserPage>;
  relayPorts: { browser: number; agent: number; health: number };
  relayInstanceId: string;
  agentContainer: string;
  agentContainerId: string;
  agentImage: string;
  agentImageId: string;
  operatorEmail: string;
  operatorPassword: string;
  operatorAlias: string;
  targetAlias: string;
  tenant: string;
  nonce: string;
  agentLog: () => string;
  login(): Promise<BrowserSession>;
  request(path: string, options?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<HttpResult>;
  connect(ticket: string, sessionId: string, cols: number, rows: number): Promise<PtySocket>;
  waitForTarget(cookie: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface RealPtyFixtureOptions {
  readonly governanceRelay?: boolean;
}

function boundedAppend(current: string, chunk: Buffer, limit = 24 * 1024): string {
  return `${current}${chunk.toString('utf8')}`.slice(-limit);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function isMissingDockerObject(error: unknown): boolean {
  return error instanceof Error && /No such (?:object|image|container)/iu.test(error.message);
}

async function inspectImage(tag: string): Promise<{ id: string; owner: string } | undefined> {
  try {
    const { stdout } = await execute('docker', ['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', tag], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const [id, owner] = stdout.trim().split(' ');
    if (!id) throw new Error(`Docker returned an empty image identity for ${tag}`);
    return { id, owner: owner ?? '' };
  } catch (error) {
    if (isMissingDockerObject(error)) return undefined;
    throw error;
  }
}

async function removeOwnedImage(tag: string, id: string): Promise<void> {
  const current = await inspectImage(tag);
  if (!current) return;
  if (current.id !== id || current.owner !== 'real-pty-agent') throw new Error(`refusing to remove image without exact ownership: ${tag}`);
  await execute('docker', ['image', 'rm', tag], { timeout: 15_000, maxBuffer: 64 * 1024 });
  if (await inspectImage(tag)) throw new Error(`owned Python agent image remains after cleanup: ${tag}`);
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

async function dockerExecInput(args: string[], input: string, timeoutMs = 15_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(-64 * 1024);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let failureTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      signalProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProcessGroup(child, 'SIGKILL');
      }, 500);
      failureTimer = setTimeout(() => { finish(new Error('docker exec input process did not stop before its deadline')); }, 2_500);
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (failureTimer) clearTimeout(failureTimer);
      if (error) reject(error); else resolve();
    };
    child.once('error', (error) => {
      finish(error);
    });
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`docker exec input failed (${String(code)} ${String(signal)}): ${stderr || stdout}`));
    });
    child.stdin.once('error', (error) => {
      if (!settled) {
        signalProcessGroup(child, 'SIGTERM');
        finish(error);
      }
    });
    child.stdin.end(input);
  });
}

async function createRuntimeDirectory(): Promise<string> {
  const script = "import fs from 'node:fs';import os from 'node:os';import path from 'node:path';console.log(fs.mkdtempSync(path.join(os.tmpdir(),'cauce-real-pty-private-')))";
  const uid = typeof process.getuid === 'function' && process.getuid() === 0 ? TARGET_UID : process.getuid?.();
  const gid = typeof process.getgid === 'function' && process.getuid?.() === 0 ? TARGET_GID : process.getgid?.();
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], {
    ...(uid === undefined ? {} : { uid }), ...(gid === undefined ? {} : { gid }),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const directory = stdout.trim();
  if (!directory.startsWith(join(tmpdir(), 'cauce-real-pty-private-'))) throw new Error('private runtime directory was not created in the expected temp root');
  return directory;
}

async function writePrivate(directory: string, name: string, value: string, mode = 0o644): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, value, { mode });
  return path;
}

async function makePki(directory: string): Promise<Pki> {
  const uid = typeof process.getuid === 'function' && process.getuid() === 0 ? TARGET_UID : process.getuid?.();
  const gid = typeof process.getgid === 'function' && process.getuid?.() === 0 ? TARGET_GID : process.getgid?.();
  const run = async (args: string[]) => execute('openssl', args, {
    cwd: directory, ...(uid === undefined ? {} : { uid }), ...(gid === undefined ? {} : { gid }),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    timeout: 30_000, maxBuffer: 64 * 1024,
  });
  const caKey = join(directory, 'ca.key');
  const caCert = join(directory, 'ca.crt');
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey, '-out', caCert, '-subj', '/CN=Cauce real PTY E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await execute('chmod', ['600', caKey], { timeout: 5_000, maxBuffer: 64 * 1024 });
  const issue = async (name: string, purpose: 'serverAuth' | 'clientAuth', san?: string) => {
    const key = join(directory, `${name}.key`);
    const csr = join(directory, `${name}.csr`);
    const cert = join(directory, `${name}.crt`);
    const config = join(directory, `${name}.cnf`);
    const extensions = `[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=extensions\n[dn]\nCN=${name}\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${purpose}\n${san ? `subjectAltName=${san}\n` : ''}`;
    await writePrivate(directory, `${name}.cnf`, extensions, 0o644);
    await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-config', config]);
    await run(['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'extensions']);
    await execute('chmod', ['600', key], { timeout: 5_000, maxBuffer: 64 * 1024 });
    await execute('chmod', ['600', cert], { timeout: 5_000, maxBuffer: 64 * 1024 });
    return { key, cert };
  };
  const server = await issue('relay-server', 'serverAuth', 'DNS:localhost,IP:127.0.0.1');
  const relayClient = await issue('relay-client', 'clientAuth');
  const consoleClient = await issue('console', 'clientAuth');
  const agent = await issue('pty-agent', 'clientAuth');
  const agentFingerprint = new X509Certificate(await readFile(agent.cert)).fingerprint256.replaceAll(':', '').toLowerCase();
  const agentRegistry = await writePrivate(directory, 'agent-registry.json', JSON.stringify({
    version: 1,
    agents: [{ fingerprint_sha256: agentFingerprint, tenant_id: TENANT, alias: TARGET_ALIAS, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }],
  }), 0o644);
  const relayInstanceId = relayInstanceIdFromCertificate(await readFile(relayClient.cert));
  const relayIdentityFile = await writePrivate(directory, 'relay-mtls-identities.json', JSON.stringify({
    version: 1,
    identities: [{ certificate_sha256: new X509Certificate(await readFile(relayClient.cert)).fingerprint256.replaceAll(':', '').toLowerCase(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), principal: {
      tenant_id: TENANT, alias: `relay${randomBytes(3).toString('hex')}`, session_id: `relay:${randomUUID()}`,
      channel: 'agent', roles: ['adapter'], permissions: ['read'],
    } }],
  }), 0o644);
  return {
    directory, caCert, serverCert: server.cert, serverKey: server.key,
    relayClientCert: relayClient.cert, relayClientKey: relayClient.key,
    consoleClientCert: consoleClient.cert, consoleClientKey: consoleClient.key,
    agentCert: agent.cert, agentKey: agent.key, agentRegistry, relayIdentityFile, relayInstanceId,
  };
}

function launchRelay(env: NodeJS.ProcessEnv): ChildProcess {
  const uid = typeof process.getuid === 'function' && process.getuid() === 0 ? TARGET_UID : process.getuid?.();
  const gid = typeof process.getgid === 'function' && process.getuid?.() === 0 ? TARGET_GID : process.getgid?.();
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'HOME' && name !== 'CODEX_HOME'));
  return spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'services/terminal-relay/src/main.ts'], {
    cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    ...(uid === undefined ? {} : { uid }), ...(gid === undefined ? {} : { gid }), detached: true,
  });
}

async function waitForRelay(child: ChildProcess, port: number, readLog: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`real terminal relay exited ${String(child.exitCode)} before readiness: ${readLog()}`);
    const ready = await new Promise<boolean>((resolve) => {
      const request = httpGet({ host: '127.0.0.1', port, path: '/health/ready', timeout: 1_000 }, (response) => {
        response.resume();
        response.once('end', () => { resolve(response.statusCode === 200); });
      });
      request.once('timeout', () => { request.destroy(); resolve(false); });
      request.once('error', () => { resolve(false); });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`real terminal relay readiness timeout: ${readLog()}`);
}

async function stopProcess(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child, 'SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) {
    signalProcessGroup(child, 'SIGKILL');
    const killed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { resolve(false); }, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!killed) throw new Error(`${label} did not exit after SIGKILL`);
  }
}

async function seed(database: TestDatabase, containerId: string): Promise<void> {
  await database.pool.query('INSERT INTO tenants(id) VALUES($1) ON CONFLICT DO NOTHING', [TENANT]);
  await database.pool.query("INSERT INTO harness_definitions(id,display_name,capabilities) VALUES('pty-e2e','Real PTY E2E','[]'::jsonb) ON CONFLICT DO NOTHING");
  const room = `pty-e2e-${randomBytes(4).toString('hex')}`;
  await database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [room, TENANT]);
  for (const [alias, runtimeUser, home] of [
    [OPERATOR_ALIAS, 'node', '/home/node'],
    [TARGET_ALIAS, 'node', '/home/node'],
  ] as const) {
    await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'pty-e2e',$2,true,$3,$4,$5,$6) ON CONFLICT (tenant_id,alias) DO NOTHING`,
    [TENANT, alias, alias === TARGET_ALIAS ? containerId : `operator-${randomUUID()}`, runtimeUser, home, `${home}/.cauce-e2e`]);
    await database.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [TENANT, room, alias, alias === TARGET_ALIAS ? 'agent' : 'operator']);
  }
}

export async function startRealPtyFixture(options: RealPtyFixtureOptions = {}): Promise<RealPtyFixture> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) throw new Error('real PTY E2E requires its own Testcontainers database');
  const imageTag = `cauce-real-pty-agent:${randomUUID()}`;
  const containerName = `cauce-real-pty-${randomUUID()}`;
  const buildContext = await mkdtemp(join(tmpdir(), 'cauce-real-pty-build-'));
  let directory = '';
  let database: TestDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let vite: { close(): Promise<void>; httpServer: import('node:http').Server | null; listen(): Promise<void> } | undefined;
  let trustedBrowser: TrustedBrowser | undefined;
  const browserContexts: BrowserContext[] = [];
  let relay: ChildProcess | undefined;
  let agent: ChildProcess | undefined;
  let agentContainerId: string | undefined;
  let imageId: string | undefined;
  let relayLog = '';
  let agentLog = '';
  let proxyAgent: import('node:https').Agent | undefined;
  let browserProxyAgent: import('node:https').Agent | undefined;
  let relayInstanceId = '';
  let gatewayUrl = '';
  let baseUrl = '';
  let ports: RealPtyFixture['relayPorts'] | undefined;
  const cleanupErrors: Error[] = [];
  const record = (label: string, error: unknown) => { cleanupErrors.push(new Error(`${label} cleanup failed`, { cause: error })); };
  const cleanup = async () => {
    for (const [index, context] of browserContexts.entries()) {
      try { await context.close(); } catch (error) { record(`browser context ${String(index)}`, error); }
    }
    if (trustedBrowser) {
      try { await trustedBrowser.close(); } catch (error) { record('owned browser runtime', error); }
    }
    if (vite) { try { await vite.close(); } catch (error) { record('Vite server', error); } }
    if (relay) { try { await stopProcess(relay, 'terminal relay'); } catch (error) { record('terminal relay', error); } }
    let ownedContainerFound = false;
    try {
      const inspection = await execute('docker', ['inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', containerName], { timeout: 15_000, maxBuffer: 64 * 1024 });
      const [id, owner] = inspection.stdout.trim().split(' ');
      if (owner !== 'real-pty-agent' || (agentContainerId !== undefined && id !== agentContainerId)) throw new Error(`refusing to remove changed container ${containerName}`);
      ownedContainerFound = true;
    } catch (error) { if (!isMissingDockerObject(error)) record('inspect agent container', error); }
    if (ownedContainerFound) {
      try {
        await execute('docker', ['rm', '--force', containerName], { timeout: 15_000, maxBuffer: 64 * 1024 });
        try {
          await execute('docker', ['inspect', '--format', '{{.Id}}', containerName], { timeout: 15_000, maxBuffer: 64 * 1024 });
          record('owned agent container', new Error(`container remains after removal: ${containerName}`));
        } catch (error) { if (!isMissingDockerObject(error)) record('verify agent container removal', error); }
      } catch (error) { if (!isMissingDockerObject(error)) record('owned agent container', error); }
    }
    if (agent && !await waitForExit(agent, 3_000)) {
      agent.kill('SIGKILL');
      if (!await waitForExit(agent, 2_000)) record('agent exec process', new Error('agent docker exec process did not exit after its container stopped'));
    }
    proxyAgent?.destroy();
    browserProxyAgent?.destroy();
    if (app) { try { await app.close(); } catch (error) { record('gateway', error); } }
    if (database) {
      try { await database.pool.end(); } catch (error) { record('database pool', error); }
      try { await database.container.stop(); } catch (error) { record('owned PostgreSQL container', error); }
    }
    if (imageId) { try { await removeOwnedImage(imageTag, imageId); } catch (error) { record('owned Python image', error); } }
    try { await rm(buildContext, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch (error) { record('build context', error); }
    if (directory) {
      try { await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch (error) { record('private TLS directory', error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'real PTY fixture cleanup incomplete');
  };

  try {
    directory = await createRuntimeDirectory();
    const sourcePackage = join(process.cwd(), 'ops/pty-agent/cauce_pty_agent');
    const stagedPackage = join(buildContext, 'cauce_pty_agent');
    await (await import('node:fs/promises')).cp(sourcePackage, stagedPackage, {
      recursive: true, filter: (path) => path === sourcePackage || path.endsWith('.py') || path.endsWith('/contexto-de-gobierno.json'),
    });
    await writeFile(join(buildContext, 'Dockerfile'), `FROM ${APPROVED_NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node cauce_pty_agent/ /opt/cauce-pty-agent/cauce_pty_agent/
USER node
WORKDIR /home/node
`, { mode: 0o600 });
    const imageCollision = await inspectImage(imageTag);
    if (imageCollision) throw new Error(`random agent image tag collision: ${imageTag}`);
    try {
      await execute('docker', ['build', '--label', OWNER_LABEL, '--tag', imageTag, '--file', join(buildContext, 'Dockerfile'), buildContext], { timeout: 8 * 60_000, maxBuffer: 512 * 1024 });
    } catch (error) {
      const partial = await inspectImage(imageTag);
      if (partial?.owner === 'real-pty-agent') imageId = partial.id;
      throw error;
    }
    const image = await inspectImage(imageTag);
    if (image?.owner !== 'real-pty-agent') throw new Error(`owned Python image build produced no verified image: ${imageTag}`);
    imageId = image.id;
    const capability = await execute('docker', ['run', '--rm', '--network', 'none', '--env', 'PYTHONPATH=/opt/cauce-pty-agent', '--entrypoint', 'python3', imageTag, '-c', "import os,pwd,cauce_pty_agent; print(os.geteuid(),pwd.getpwuid(os.geteuid()).pw_dir,os.environ.get('HOME','<unset>'))"], { timeout: 15_000, maxBuffer: 64 * 1024 });
    if (capability.stdout.trim() !== '1000 /home/node /home/node') throw new Error(`agent image USER/HOME validation failed: ${JSON.stringify(capability.stdout.trim())}`);

    database = await startTestDatabase();
    const startedDatabase = database;
    const pkiValue = await makePki(directory);
    relayInstanceId = relayInstanceIdFromCertificate(await readFile(pkiValue.relayClientCert));
    const allocatedPorts = [await availableLoopbackPort(), await availableLoopbackPort(), await availableLoopbackPort()];
    if (new Set(allocatedPorts).size !== allocatedPorts.length) throw new Error('relay loopback port allocation collided');
    const [browserPort, agentPort, healthPort] = allocatedPorts;
    if (browserPort === undefined || agentPort === undefined || healthPort === undefined) throw new Error('relay port allocation was incomplete');
    ports = { browser: browserPort, agent: agentPort, health: healthPort };
    const relayToken = randomBytes(32).toString('base64url');
    const ticketKey = randomBytes(32);
    const tokenPath = await writePrivate(directory, 'relay-token', relayToken, 0o644);
    const grantsFile = await writePrivate(directory, 'grants.json', JSON.stringify({ version: 1, grants: [{
      operator: OPERATOR_EMAIL, tenant_id: TENANT, alias: TARGET_ALIAS, modes: ['shell'],
    }] }), 0o644);
    const config: TerminalConfig = {
      wsPath: '/v3/console/terminal/ws', ticketKey, relayToken, relayInstanceIds: new Set([relayInstanceId]),
      ...(options.governanceRelay ? {
        relayUrl: `https://127.0.0.1:${String(ports.browser)}`,
        relayClientCertFile: pkiValue.consoleClientCert,
        relayClientKeyFile: pkiValue.consoleClientKey,
        relayCaFile: pkiValue.caCert,
      } : {}),
      grantsFile, ticketTtlSeconds: 60, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 1_800,
      claimLeaseSeconds: 150, maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set([OPERATOR_EMAIL]),
    };
    await seed(startedDatabase, 'pending');
    const auth = new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(startedDatabase.pool), signingKey: randomBytes(32),
      sessionTtlMs: 10 * 60_000, fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(pkiValue.relayIdentityFile)),
    });
    await auth.ready();
    const tls = {
      key: await readFile(pkiValue.serverKey), cert: await readFile(pkiValue.serverCert), ca: await readFile(pkiValue.caCert),
      requestCert: true, rejectUnauthorized: true,
    };
    const gatewayPort = await availableLoopbackPort();
    const frontendPort = await availableLoopbackPort();
    gatewayUrl = `https://127.0.0.1:${String(gatewayPort)}`;
    const frontendOrigin = `https://localhost:${String(frontendPort)}`;
    app = await buildGateway({
      pool: startedDatabase.pool, authProvider: auth, https: tls, consoleOrigins: [gatewayUrl, frontendOrigin],
      terminalCapability: terminalCapabilityAnnouncement(config),
      operatorResolution: { operatorHeader: config.operatorHeader, operators: config.operators },
    });
    const registry = new AgentRegistry();
    await app.register(registerTerminalControlPlane, { pool: startedDatabase.pool, authProvider: auth, config, registry });
    await app.listen({ host: '127.0.0.1', port: gatewayPort });
    proxyAgent = new (await import('node:https')).Agent({
      cert: await readFile(pkiValue.consoleClientCert), key: await readFile(pkiValue.consoleClientKey),
      ca: await readFile(pkiValue.caCert), rejectUnauthorized: true,
    });
    browserProxyAgent = new (await import('node:https')).Agent({
      cert: await readFile(pkiValue.consoleClientCert), key: await readFile(pkiValue.consoleClientKey),
      ca: await readFile(pkiValue.caCert), rejectUnauthorized: true,
    });
    const viteModule = consoleRequire('vite') as {
      createServer(config: Record<string, unknown>): Promise<{ close(): Promise<void>; httpServer: import('node:http').Server | null; listen(): Promise<void> }>;
    };
    const relayWebsocketPath = `/v3/console/terminal/relays/${relayInstanceId}/ws`;
    vite = await viteModule.createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'),
      root: join(process.cwd(), 'console'),
      envDir: directory,
      server: {
        host: '127.0.0.1', port: frontendPort, strictPort: true,
        https: { key: await readFile(pkiValue.serverKey), cert: await readFile(pkiValue.serverCert) },
        proxy: {
          [relayWebsocketPath]: {
            target: `https://127.0.0.1:${String(ports.browser)}`,
            agent: browserProxyAgent, secure: true, changeOrigin: false, ws: true,
          },
          '/v3': { target: gatewayUrl, agent: proxyAgent, secure: true, changeOrigin: false, ws: false },
        },
      },
    });
    await vite.listen();
    const frontendAddress = vite.httpServer?.address() as AddressInfo | null;
    if (!frontendAddress || typeof frontendAddress === 'string') throw new Error('Vite HTTPS server did not expose its bound address');
    baseUrl = `https://localhost:${String(frontendAddress.port)}`;
    if (baseUrl !== frontendOrigin) throw new Error('Vite HTTPS server did not bind its reserved origin');
    const trusted = await startTrustedBrowser(pkiValue.caCert, directory);
    trustedBrowser = trusted;
    const provision = await execute(join(process.cwd(), 'node_modules/.bin/tsx'), [
      'services/gateway/src/console-user-cli.ts', '--email', OPERATOR_EMAIL, '--name', 'Real PTY E2E operator',
      '--role', 'operator', '--tenant', TENANT, '--alias', OPERATOR_ALIAS,
    ], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', DATABASE_URL: startedDatabase.url, CAUCE_CONSOLE_USER_PASSWORD: OPERATOR_PASSWORD }, timeout: 20_000, maxBuffer: 64 * 1024 });
    if (!provision.stdout.includes('cuenta guardada') || provision.stdout.includes(OPERATOR_PASSWORD)) throw new Error('console-user-cli did not safely confirm operator provisioning');

    const relayEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test',
      NODE_EXTRA_CA_CERTS: pkiValue.caCert,
      CAUCE_TERMINAL_RELAY_BIND_HOST: '127.0.0.1',
      CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(ports.browser),
      CAUCE_TERMINAL_RELAY_AGENT_PORT: String(ports.agent),
      CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(ports.health),
      CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: pkiValue.serverCert,
      CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: pkiValue.serverKey,
      CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: pkiValue.caCert,
      CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console',
      CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: pkiValue.caCert,
      CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: pkiValue.agentRegistry,
      CAUCE_TERMINAL_GATEWAY_URL: gatewayUrl,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenPath,
      CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: pkiValue.relayClientCert,
      CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: pkiValue.relayClientKey,
      CAUCE_TERMINAL_RELAY_INSTANCE_ID: relayInstanceId,
      CAUCE_TERMINAL_CLOSE_SPOOL_FILE: join(directory, 'close-spool.json'),
      CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1', CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1',
      CAUCE_TERMINAL_RECONNECT_GRACE_SECONDS: '30', CAUCE_TERMINAL_PRESENCE_MAX_STALE_SECONDS: '30',
      CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '150',
    };
    await writePrivate(directory, 'close-spool.json', '', 0o644);
    relay = launchRelay(relayEnv);
    relay.stdout?.on('data', (chunk: Buffer) => { relayLog = boundedAppend(relayLog, chunk); });
    relay.stderr?.on('data', (chunk: Buffer) => { relayLog = boundedAppend(relayLog, chunk); });
    await waitForRelay(relay, ports.health, () => relayLog);

    const agentImage = imageTag;
    const agentEnvBundle = {
      tenant_id: TENANT, alias: TARGET_ALIAS,
      container_id: 'pending', generation: `g${randomBytes(10).toString('hex')}`,
      image_id: imageId, runtime_user: 'node', runtime_uid: TARGET_UID, runtime_gid: TARGET_GID,
      home: '/home/node', shell_candidates: ['/bin/sh'], harness: 'shell',
      relay_host: '127.0.0.1', relay_port: ports.agent, relay_server_name: 'localhost',
      alias_key_hex: deriveAliasKey(ticketKey, TENANT, TARGET_ALIAS).toString('hex'),
      client_cert_pem: (await readFile(pkiValue.agentCert, 'utf8')),
      client_key_pem: (await readFile(pkiValue.agentKey, 'utf8')),
      ca_pem: await readFile(pkiValue.caCert, 'utf8'), agent_version: 'cauce-pty-e2e',
      runtime_facts: {},
    };
    const run = await execute('docker', ['run', '--rm', '--detach', '--name', containerName, '--label', OWNER_LABEL,
      '--network', 'host', '--user', 'node', '--read-only', '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777', '--entrypoint', 'sh', agentImage, '-lc', 'sleep 600'],
    { timeout: 30_000, maxBuffer: 64 * 1024 });
    const dockerId = run.stdout.trim();
    const inspect = await execute('docker', ['inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{.Config.User}}', containerName], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const [containerId, owner, user] = inspect.stdout.trim().split(' ');
    if (containerId !== dockerId || owner !== 'real-pty-agent' || user !== 'node') throw new Error('target container identity/owner/user validation failed');
    agentContainerId = containerId;
    const targetId = containerId;
    await startedDatabase.pool.query('UPDATE agents SET container_name=$3 WHERE tenant_id=$1 AND alias=$2', [TENANT, TARGET_ALIAS, targetId]);
    agentEnvBundle.container_id = targetId;
    const bundlePath = join(directory, 'agent-bundle.json');
    await writeFile(bundlePath, JSON.stringify(agentEnvBundle), { mode: 0o600 });
    await dockerExecInput(['exec', '-i', '--user', 'node', containerName, 'sh', '-lc', 'umask 077; cat > /tmp/pty-bundle.json'], await readFile(bundlePath, 'utf8'));
    await execute('docker', ['exec', '--user', '0', containerName, 'sh', '-lc', 'chown node:node /tmp/pty-bundle.json && chmod 0400 /tmp/pty-bundle.json'], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const bundleStat = await execute('docker', ['exec', '--user', '0', containerName, 'stat', '-c', '%u:%g:%a', '/tmp/pty-bundle.json'], { timeout: 15_000, maxBuffer: 64 * 1024 });
    if (bundleStat.stdout.trim() !== '1000:1000:400') throw new Error(`agent bundle ownership/mode invalid: ${bundleStat.stdout.trim()}`);
    agent = spawn('docker', ['exec', '--user', 'node', '--env', 'PYTHONPATH=/opt/cauce-pty-agent', containerName,
      'python3', '-m', 'cauce_pty_agent', '--bundle', '/tmp/pty-bundle.json'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: undefined,
    });
    agent.stdout?.on('data', (chunk: Buffer) => { agentLog = boundedAppend(agentLog, chunk); });
    agent.stderr?.on('data', (chunk: Buffer) => { agentLog = boundedAppend(agentLog, chunk); });

    const relayPorts = ports;
    return {
      database: startedDatabase, app, directory, gatewayUrl, baseUrl, browserContainer: trustedBrowser.container,
      browserPage: async (viewport) => {
        if (!trustedBrowser) throw new Error('trusted Chromium fixture is not initialized');
        const context = await trustedBrowser.browser.newContext({ viewport, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
        browserContexts.push(context);
        return await context.newPage();
      },
      relayPorts: ports, relayInstanceId,
      agentContainer: containerName, agentContainerId, agentImage, agentImageId: imageId,
      operatorEmail: OPERATOR_EMAIL, operatorPassword: OPERATOR_PASSWORD, operatorAlias: OPERATOR_ALIAS, targetAlias: TARGET_ALIAS, tenant: TENANT, nonce: NONCE,
      agentLog: () => agentLog,
      login: async () => {
        const response = await requestGateway(gatewayUrl, proxyAgent, '/v3/auth/login', {
          method: 'POST', headers: { origin: gatewayUrl }, body: { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD },
        });
        if (response.status !== 200) throw new Error(`password login failed with HTTP ${String(response.status)}: ${response.body.slice(0, 400)}`);
        const setCookie = response.headers['set-cookie']?.find((value) => value.startsWith('__Host-cauce_session='));
        if (!setCookie) throw new Error('real PasswordAuthProvider login did not set its session cookie');
        const value = JSON.parse(response.body) as { csrf_token?: unknown };
        if (typeof value.csrf_token !== 'string') throw new Error('real PasswordAuthProvider login omitted CSRF token');
        return { cookie: setCookie.split(';', 1)[0] ?? '', csrf: value.csrf_token };
      },
      request: (path, options = {}) => requestGateway(gatewayUrl, proxyAgent, path, options),
      connect: async (ticket, sessionId, cols, rows) => {
        const { WebSocket } = await import('ws');
        const socket = new WebSocket(`wss://127.0.0.1:${String(relayPorts.browser)}/v3/console/terminal/relays/${relayInstanceId}/ws`, [], {
          cert: await readFile(pkiValue.consoleClientCert), key: await readFile(pkiValue.consoleClientKey), ca: await readFile(pkiValue.caCert),
          origin: `https://127.0.0.1:${String(relayPorts.browser)}`, rejectUnauthorized: true, handshakeTimeout: 10_000,
        });
        await waitForSocket(socket);
        const controls: Record<string, unknown>[] = [];
        const output: string[] = [];
        let closeCode: number | undefined;
        const listeners: (() => void)[] = [];
        socket.on('message', (data, isBinary) => {
          if (isBinary) output.push(Buffer.from(data as Buffer).toString('utf8'));
          else {
            try { controls.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>); }
            catch { controls.push({ type: 'invalid-json' }); }
          }
          for (const listener of [...listeners]) listener();
        });
        socket.once('close', (code) => { closeCode = code; for (const listener of [...listeners]) listener(); });
        const awaitMatch = async <T>(values: T[], predicate: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> => {
          const existing = values.find(predicate);
          if (existing !== undefined) return existing;
          return await new Promise<T>((resolve, reject) => {
            const finish = (value?: T, error?: Error) => {
              clearTimeout(timer);
              listeners.splice(listeners.indexOf(onChange), 1);
              if (error) reject(error); else if (value !== undefined) resolve(value);
            };
            const onChange = () => {
              const value = values.find(predicate);
              if (value !== undefined) finish(value);
              else if (closeCode !== undefined) finish(undefined, new Error(`terminal socket closed (${String(closeCode)}) while waiting for ${label}`));
            };
            const timer = setTimeout(() => { finish(undefined, new Error(`terminal socket deadline waiting for ${label}`)); }, timeoutMs);
            listeners.push(onChange);
          });
        };
        const client: PtySocket = {
          socket,
          waitControl: (predicate, timeoutMs = 15_000) => awaitMatch(controls, predicate, timeoutMs, 'control frame'),
          waitOutput: async (predicate, timeoutMs = 15_000) => {
            const existing = output.join('');
            if (predicate(existing)) return existing;
            return await new Promise<string>((resolve, reject) => {
              const finish = (value?: string, error?: Error) => {
                clearTimeout(timer);
                listeners.splice(listeners.indexOf(onChange), 1);
                if (error) reject(error); else if (value !== undefined) resolve(value);
              };
              const onChange = () => {
                const value = output.join('');
                if (predicate(value)) finish(value);
                else if (closeCode !== undefined) finish(undefined, new Error(`terminal socket closed (${String(closeCode)}) before PTY output`));
              };
              const timer = setTimeout(() => { finish(undefined, new Error('terminal PTY output deadline')); }, timeoutMs);
              listeners.push(onChange);
            });
          },
          waitForClose: async (timeoutMs = 15_000) => {
            if (closeCode !== undefined) return;
            await new Promise<void>((resolve, reject) => {
              const onChange = () => { if (closeCode !== undefined) { clearTimeout(timer); listeners.splice(listeners.indexOf(onChange), 1); resolve(); } };
              const timer = setTimeout(() => { listeners.splice(listeners.indexOf(onChange), 1); reject(new Error('terminal socket close deadline')); }, timeoutMs);
              listeners.push(onChange);
            });
          },
          get closeCode() { return closeCode; },
        };
        socket.send(JSON.stringify({ type: 'attach', session_id: sessionId, ticket, cols, rows }));
        return client;
      },
      waitForTarget: async (cookie, timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const response = await requestGateway(gatewayUrl, proxyAgent, '/v3/console/terminal/targets', { headers: { cookie, accept: 'application/json' } });
          if (response.status === 200) {
            const body = JSON.parse(response.body) as { items?: { tenant_id?: string; alias?: string; modes?: string[]; pty_state?: string; authorized?: boolean }[] };
            if (body.items?.some((item) => item.tenant_id === TENANT && item.alias === TARGET_ALIAS
              && item.modes?.includes('shell') && item.pty_state === 'online' && item.authorized === true)) return;
          }
          if (agent?.exitCode !== null) throw new Error(`real Python agent exited ${String(agent?.exitCode)} before presence: ${agentLog}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`real Python agent presence deadline; logs=${agentLog}; relay=${relayLog}`);
      },
      close: async () => {
        const errors: Error[] = [];
        if (agent?.exitCode === null && agent.signalCode === null) {
          agent.kill('SIGTERM');
          if (!await waitForExit(agent, 2_000)) { agent.kill('SIGKILL'); if (!await waitForExit(agent, 2_000)) errors.push(new Error('agent docker exec process did not exit')); }
        }
        try { await cleanup(); } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
        if (errors.length) throw new AggregateError(errors, 'real PTY fixture cleanup incomplete');
      },
    };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'real PTY fixture setup and cleanup failed', { cause: error }); }
    throw error;
  }
}

async function requestGateway(url: string, agent: import('node:https').Agent | undefined, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult> {
  if (!agent) throw new Error('gateway mTLS client has been closed');
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(new URL(path, url), {
      method: options.method ?? 'GET', agent,
      ...(payload === undefined ? {} : { headers: { ...options.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }),
      ...(options.headers === undefined || payload !== undefined ? {} : { headers: options.headers }),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); });
      response.once('error', reject);
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    request.once('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error('gateway HTTPS request deadline')));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function waitForSocket(socket: import('ws').WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('terminal relay WebSocket open timeout')); }, 10_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('close', (code, reason) => { clearTimeout(timer); reject(new Error(`terminal WebSocket closed before open: ${String(code)} ${reason.toString()}`)); });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
}
