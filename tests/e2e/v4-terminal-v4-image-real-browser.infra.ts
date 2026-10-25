import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get as httpGet } from 'node:http';
import { Agent } from 'node:https';
import { createRequire } from 'node:module';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { deriveAliasKey } from '../../services/gateway/src/terminal/tickets.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { startTrustedBrowser, type BrowserContext, type BrowserPage, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { browserDocker, browserExec as execute } from './browser-owned-lifecycle.js';
import { defaultContext } from './v4-terminal-v4-image-real-browser.image.js';
const TENANT = 'Steven';
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
interface Pki {
 directory: string; caCert: string; serverCert: string; serverKey: string; relayClientCert: string; relayClientKey: string;
 consoleClientCert: string; consoleClientKey: string; agentCert: string; agentKey: string; agentRegistry: string; relayIdentityFile: string; relayInstanceId: string;
}
async function writePrivate(directory: string, name: string, value: string, mode = 0o600): Promise<string> {
 const path = join(directory,name); await writeFile(path,value,{mode}); return path;
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

async function makePki(directory: string, alias: string, runtimeKey: string): Promise<Pki> {
  const run = async (args: string[]) => execute('openssl', args, {
    cwd: directory, 
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
  const agent = await issue('pty-agent', 'clientAuth', `URI:urn:cauce:runtime:${runtimeKey}`);
  const agentFingerprint = new X509Certificate(await readFile(agent.cert)).fingerprint256.replaceAll(':', '').toLowerCase();
  const agentRegistry = await writePrivate(directory, 'agent-registry.json', JSON.stringify({
    version: 1,
    agents: [{ fingerprint_sha256: agentFingerprint, tenant_id: TENANT, alias: alias, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }],
  }), 0o644);
  const relayInstanceId = relayInstanceIdFromCertificate(await readFile(relayClient.cert));
  const relayIdentityFile = await writePrivate(directory, 'relay-mtls-identities.json', JSON.stringify({
    version: 1,
    identities: [{ certificate_sha256: agentFingerprint, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), principal: {
      tenant_id: TENANT, alias, session_id: `adapter-${runtimeKey}`, channel: 'adapter', roles: ['adapter'], permissions: ['read', 'route'],
    } }, { certificate_sha256: new X509Certificate(await readFile(relayClient.cert)).fingerprint256.replaceAll(':', '').toLowerCase(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), principal: {
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
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'HOME' && name !== 'CODEX_HOME'));
  return spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'services/terminal-relay/src/main.ts'], {
    cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
     detached: true,
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

export async function startV4Infrastructure(alias: string, runtimeKey: string, harness: string, context = defaultContext) {
  const { evidence, runId, owner } = context;
  const prefix = owner.split('-')[0] ?? 'h8b';
  const directory = await mkdtemp(join(tmpdir(), `zz-canary-${prefix}-infra-`));
  const actions: { label: string; run: () => Promise<void> }[] = [];
  const resources: { kind: 'container' | 'network' | 'image'; reference: string }[] = [];
  const contexts: BrowserContext[] = [];
  let trusted: TrustedBrowser | undefined;
  const close = async () => {
    const errors: unknown[] = [];
    for (const context of contexts) {
      try { await context.close(); } catch (error) { errors.push(error); }
    }
    for (const action of [...actions].reverse()) {
      try { await action.run(); } catch (error) { errors.push(new Error(action.label, { cause: error })); }
    }
    const verified: { kind: string; reference: string; absent: boolean }[] = [];
    for (const resource of resources) {
      try {
        const filter = resource.kind === 'image' ? `reference=${resource.reference}` : `id=${resource.reference}`;
        const result = await browserDocker([resource.kind, 'ls', '-q', ...(resource.kind === 'container' ? ['-a'] : []), '--filter', filter]);
        const absent = result.stdout.trim() === '';
        verified.push({ ...resource, absent });
        if (!absent) errors.push(new Error(`owned ${resource.kind} remains: ${resource.reference}`));
      } catch (error) { errors.push(error); }
    }
    await writeFile(join(evidence, `${harness}-infra-cleanup.json`), JSON.stringify({ run_id: runId, attempted: actions.map(action => action.label), verified, all_closed: errors.length === 0 }, null, 2));
    await rm(directory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'V4 infrastructure cleanup failed');
  };
  try {
  const database = await startTestDatabase();
  resources.push({ kind: 'container', reference: database.container.getId() });
  actions.push({ label: `PostgreSQL ${database.container.getId()}`, run: async () => {
    const results = await Promise.allSettled([...new Set([database.pool, database.adminPool])].map(pool => pool.end()));
    const stopped = await Promise.allSettled([database.container.stop()]);
    const errors = [...results, ...stopped].filter(row => row.status === 'rejected');
    if (errors.length) throw new AggregateError(errors, 'PostgreSQL cleanup failed');
  } });
  const pki = await makePki(directory, alias, runtimeKey);
  const room = `${prefix}-${randomUUID()}`;
  const email = `${prefix}-${randomUUID()}@cauce.test`;
  const password = randomBytes(24).toString('base64url');
  const operator = `op${randomBytes(4).toString('hex')}`;
  await database.pool.query('INSERT INTO tenants(id) VALUES($1) ON CONFLICT DO NOTHING', [TENANT]);
  await database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, TENANT]);
  await database.pool.query("INSERT INTO harness_definitions(id,display_name,capabilities) VALUES($1,$1,'[]'::jsonb) ON CONFLICT DO NOTHING", [harness]);
  for (const name of [operator, alias]) {
    await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,runtime_key,runtime_mode,max_concurrent_deliveries)
      VALUES($1,$2,$3,$2,true,'pending','node','/home/node',$4,$5,$6,1)`, [TENANT, name, harness, `/home/node/.cauce/${runtimeKey}`,
      name === alias ? runtimeKey : `op-${randomBytes(8).toString('hex')}`, name === alias ? 'container' : null]);
    await database.pool.query('INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,$4)', [TENANT, room, name, name === alias ? 'agent' : 'operator']);
  }
  const reservations = await reserveNamedLoopbackPorts(['browser', 'agent', 'health', 'gateway', 'frontend'] as const);
  actions.push({ label: 'port reservations', run: () => reservations.releaseAll() });
  const ports = reservations.ports;
  const ticketKey = randomBytes(32);
  const relayToken = randomBytes(32).toString('base64url');
  const tokenPath = await writePrivate(directory, 'relay-token', relayToken);
  const grantsFile = await writePrivate(directory, 'grants.json', JSON.stringify({ version: 1, grants: [{ operator: email, tenant_id: TENANT, alias, modes: ['shell', 'harness'] }] }));
  const config: TerminalConfig = {
    wsPath: '/v3/console/terminal/ws', ticketKey, relayToken, relayInstanceIds: new Set([pki.relayInstanceId]),
    grantsFile, ticketTtlSeconds: 60, sessionTtlSeconds: 300, sessionMaxTotalSeconds: 600,
    claimLeaseSeconds: 150, maxSessionsPerOperator: 4, operatorHeader: 'x-cauce-operator', operators: new Set([email]),
  };
  const auth = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(database.pool), signingKey: randomBytes(32),
    sessionTtlMs: 30 * 60_000, fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(pki.relayIdentityFile)) });
  await auth.ready();
  const tls = { key: await readFile(pki.serverKey), cert: await readFile(pki.serverCert), ca: await readFile(pki.caCert), requestCert: true, rejectUnauthorized: true };
  const gatewayUrl = `https://127.0.0.1:${String(ports.gateway)}`;
  const baseUrl = `https://localhost:${String(ports.frontend)}`;
  const app = await buildGateway({ pool: database.pool, authProvider: auth, https: tls, consoleOrigins: [gatewayUrl, baseUrl],
    terminalCapability: terminalCapabilityAnnouncement(config), operatorResolution: { operatorHeader: config.operatorHeader, operators: config.operators } });
  actions.push({ label: 'gateway', run: () => app.close() });
  await app.register(registerTerminalControlPlane, { pool: database.pool, authProvider: auth, config, registry: new AgentRegistry() });
  await reservations.release('gateway');
  await app.listen({ host: '127.0.0.1', port: ports.gateway });
  const proxy = new Agent({ cert: await readFile(pki.consoleClientCert), key: await readFile(pki.consoleClientKey), ca: await readFile(pki.caCert), rejectUnauthorized: true });
  actions.push({ label: 'proxy TLS agent', run: async () => { proxy.destroy(); } });
  const viteModule = consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<{ close(): Promise<void>; listen(): Promise<void> }> };
  const vite = await viteModule.createServer({ configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'),
    cacheDir: join(directory, 'vite-cache'), envDir: directory, server: { host: '127.0.0.1', port: ports.frontend, strictPort: true,
      https: { key: tls.key, cert: tls.cert }, proxy: {
        [`/v3/console/terminal/relays/${pki.relayInstanceId}/ws`]: { target: `https://127.0.0.1:${String(ports.browser)}`, agent: proxy, secure: true, changeOrigin: false, ws: true },
        '/v3': { target: gatewayUrl, agent: proxy, secure: true, changeOrigin: false, ws: false },
      } } });
  actions.push({ label: 'Vite', run: () => vite.close() });
  await reservations.release('frontend'); await vite.listen();
  await execute(join(process.cwd(), 'node_modules/.bin/tsx'), ['services/gateway/src/console-user-cli.ts', '--email', email, '--name', 'Canary operator', '--role', 'operator', '--tenant', TENANT, '--alias', operator],
    { env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: database.url, CAUCE_CONSOLE_USER_PASSWORD: password }, timeout: 20_000 });
  await writePrivate(directory, 'close-spool.json', '');
  await Promise.all(['browser', 'agent', 'health'].map(name => reservations.release(name as 'browser' | 'agent' | 'health')));
  let relayLog = '';
  const relay = launchRelay({ PATH: process.env.PATH, NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: pki.caCert,
    CAUCE_TERMINAL_RELAY_BIND_HOST: '127.0.0.1', CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(ports.browser),
    CAUCE_TERMINAL_RELAY_AGENT_PORT: String(ports.agent), CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(ports.health),
    CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: pki.serverCert, CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: pki.serverKey,
    CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: pki.caCert, CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console',
    CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: pki.caCert, CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: pki.agentRegistry,
    CAUCE_TERMINAL_GATEWAY_URL: gatewayUrl, CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenPath,
    CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: pki.relayClientCert, CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: pki.relayClientKey,
    CAUCE_TERMINAL_RELAY_INSTANCE_ID: pki.relayInstanceId, CAUCE_TERMINAL_CLOSE_SPOOL_FILE: join(directory, 'close-spool.json'),
    CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1', CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1', CAUCE_TERMINAL_RECONNECT_GRACE_SECONDS: '30',
    CAUCE_TERMINAL_PRESENCE_MAX_STALE_SECONDS: '30', CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '150', CAUCE_TERMINAL_IDLE_TIMEOUT_SECONDS: '600' });
  relay.stdout?.on('data', (chunk: Buffer) => { relayLog = boundedAppend(relayLog, chunk); });
  relay.stderr?.on('data', (chunk: Buffer) => { relayLog = boundedAppend(relayLog, chunk); });
  actions.push({ label: 'terminal relay', run: () => stopProcess(relay, 'terminal relay') });
    await waitForRelay(relay, ports.health, () => relayLog);
    trusted = await startTrustedBrowser(pki.caCert, directory, [ports.frontend, ports.gateway]);
    const browser = trusted;
    actions.push({ label: `Chromium ${browser.container}`, run: () => browser.close() });
    const browserIdentity = (await browserDocker(['inspect', '--format', '{{.Id}} {{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}', browser.container])).stdout.trim().split(' ');
    for (const [index, kind] of ['container', 'network'].entries()) {
      const reference = browserIdentity[index];
      if (!reference) throw new Error('owned browser resource identity is unavailable');
      resources.push({ kind: kind as 'container' | 'network' | 'image', reference });
    }
    if (browser.runtime.owned) resources.push({ kind: 'image', reference: browser.runtime.image });
    await mkdir(join(directory, 'launcher-pki', alias), { recursive: true, mode: 0o700 });
    const launcherPki = join(directory, 'launcher-pki', alias);
    for (const [name, path] of [['client.crt', pki.agentCert], ['client.key', pki.agentKey], ['ca.crt', pki.caCert]] as const) {
      await writePrivate(launcherPki, name, await readFile(path, 'utf8'));
    }
    await writePrivate(launcherPki, 'alias-key.hex', deriveAliasKey(ticketKey, TENANT, alias).toString('hex'), 0o400);
    const launcherConfig = join(directory, 'launcher-config'); await mkdir(launcherConfig, { mode: 0o700 });
    await writePrivate(launcherConfig, `${alias}.env`, `RELAY_HOST=127.0.0.1\nRELAY_PORT=${String(ports.agent)}\nRELAY_SERVER_NAME=localhost\nPKI_DIR=${launcherPki}\nALIAS_KEY_FILE=${launcherPki}/alias-key.hex\nCONTAINER_RUNTIME_DIR=/run\n`);
    return { directory, database, pki, room, email, password, gatewayUrl, baseUrl, ports, launcherConfig,
      launcherPkiRoot: join(directory, 'launcher-pki'), close,
      page: async (width: number): Promise<BrowserPage> => {
        if (!trusted) throw new Error('Chromium is unavailable');
        const context = await trusted.browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
        contexts.push(context); return context.newPage();
      } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'V4 infrastructure startup failed'); }
    throw error;
  }
}

export { stopProcess };
