import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chown, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import {
  terminalCapabilityAnnouncement,
  type TerminalConfig,
} from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { decodeTerminalSubject, verifyAuthorityContinuity } from '../../services/gateway/src/terminal/authority-continuity.js';
import { deriveAliasKey, verifyAuthorityResumeToken, verifyTicketSignature } from '../../services/gateway/src/terminal/tickets.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { startFakeAgent, type FakeAgentHandle } from '../terminal-pty/fake-pty-agent.mjs';
import {
  dockerTestRequirement,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.js';

const execute = promisify(execFile);
const OPERATOR_PASSWORD = randomBytes(24).toString('base64url');
const READER_PASSWORD = randomBytes(24).toString('base64url');
const TARGET_TENANT = 'Isa';
const FOREIGN_TENANT = 'Jhon';
let RELAY_INSTANCE_ID = 'd'.repeat(64);
const FOREIGN_RELAY_INSTANCE_ID = 'f'.repeat(64);
const RELAY_BOOT_ID = randomUUID();
const RELAY_TOKEN = randomBytes(32).toString('base64url');
const TICKET_KEY = randomBytes(32);
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const databaseRequirement = dockerTestRequirement(
  'password login, CSRF, terminal RBAC, grants, and ticket admission against disposable PostgreSQL',
);
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  return address.port;
}
async function waitForRelay(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`terminal relay exited before readiness (${String(child.exitCode)}): ${relayLog}`);
    try {
      const health = await relayHealthStatus(port, 500);
      if (health === 200) return;
    } catch { /* listener or first authenticated presence is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`terminal relay did not publish authenticated readiness within 30 seconds: ${relayLog}`);
}
async function assertLoopbackListeners(ports: number[]): Promise<void> {
  const listeners = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1)
    .map((row) => row.trim().split(/\s+/u)).filter((row) => row[3] === '0A');
  for (const port of ports) {
    const local = listeners.filter((row) => row[1]?.endsWith(`:${port.toString(16).toUpperCase().padStart(4, '0')}`));
    if (local.length !== 1 || local[0]?.[1]?.startsWith('0100007F:') !== true) {
      throw new Error(`terminal relay port ${String(port)} is not bound only to IPv4 loopback`);
    }
  }
}
function relayHealthStatus(port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, status = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(status);
    };
    const request = httpRequest(`http://127.0.0.1:${String(port)}/health/ready`, (response) => {
      response.resume();
      response.once('end', () => { finish(undefined, response.statusCode ?? 0); });
      response.once('error', (error) => { finish(error); });
    });
    const timer = setTimeout(() => {
      const error = new Error('terminal relay health request timed out');
      request.destroy(error);
      finish(error);
    }, timeoutMs);
    request.once('error', (error) => { finish(error); });
    request.end();
  });
}
async function stopRelay(): Promise<void> {
  syntheticAgent?.close();
  syntheticAgent = undefined;
  const child = relayProcess;
  relayProcess = undefined;
  if (child?.exitCode !== null) return;
  child.kill('SIGTERM');
  if (!await waitForChildExit(child, 2_000)) {
    child.kill('SIGKILL');
    if (!await waitForChildExit(child, 2_000)) throw new Error('terminal relay did not exit after SIGKILL');
  }
}
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
    const onExit = () => { finish(true); };
    const timer = setTimeout(() => { finish(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}
let database: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
let relayProcess: ChildProcess | undefined;
let relayDirectory = '';
let syntheticAgent: FakeAgentHandle | undefined;
let relayBrowserPort = 0;
let httpUrl = '';
let grantsFile = '';
let tempDirectory = '';
let operatorEmail = '';
let readerEmail = '';
let actorAlias = '';
let targetAlias = '';
let foreignAlias = '';
let setupReady = false;
let tlsMaterial: ReturnType<typeof createSelfSignedCert> | undefined;
let relayLog = '';
interface BrowserSession {
  cookie: string;
  csrf: string;
  body: Record<string, unknown>;
}
interface LoginResponse {
  status: number;
  cookie: string;
  body: Record<string, unknown>;
}
async function provision(email: string, alias: string, role: 'operator' | 'reader', password: string): Promise<void> {
  if (database === undefined) throw new Error('disposable database is not initialized');
  await execute(
    join(process.cwd(), 'node_modules/.bin/tsx'),
    [
      'services/gateway/src/console-user-cli.ts', '--email', email,
      '--name', `E2E terminal ${role}`, '--role', role, '--tenant', TARGET_TENANT, '--alias', alias,
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        DATABASE_URL: database.url, CAUCE_CONSOLE_USER_PASSWORD: password,
      },
      timeout: 30_000,
    },
  );
}
async function setup(): Promise<void> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
    throw new Error('remote-console-terminal requires its own Testcontainers database; external database fallback is rejected');
  }
  const startedDatabase = await startTestDatabase();
  let startedApp: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let directory = '';
  try {
    database = startedDatabase;
    process.stdout.write(`terminal-e2e-owned ${JSON.stringify({ database_container: startedDatabase.container.getId() })}\n`);
    const suffix = randomBytes(5).toString('hex');
    actorAlias = `ci-operator-${suffix}`;
    targetAlias = `ci-target-${suffix}`;
    foreignAlias = `ci-foreign-${suffix}`;
    operatorEmail = `terminal-operator-${suffix}@cauce.test`;
    readerEmail = `terminal-reader-${suffix}@cauce.test`;
    directory = await mkdtemp(join(tmpdir(), 'cauce-remote-console-terminal-'));
    relayDirectory = await mkdtemp(join(tmpdir(), 'cauce-remote-console-relay-'));
    const relayUid = process.getuid?.() === 0 ? 65_534 : process.getuid?.();
    const relayGid = process.getuid?.() === 0 ? 65_534 : process.getgid?.();
    if (process.getuid?.() === 0 && relayUid !== undefined && relayGid !== undefined) {
      await chown(relayDirectory, relayUid, relayGid);
    }
    tlsMaterial = createSelfSignedCert({ directory: relayDirectory });
    RELAY_INSTANCE_ID = relayInstanceIdFromCertificate(tlsMaterial.cert);
    if (process.getuid?.() === 0 && relayUid !== undefined && relayGid !== undefined) {
      await chown(tlsMaterial.directory, relayUid, relayGid);
      await Promise.all([tlsMaterial.cert_path, tlsMaterial.key_path].map((path) => chown(path, relayUid, relayGid)));
    }
    grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({
      version: 1,
      grants: [operatorEmail, readerEmail].map((operator) => ({
        operator, tenant_id: TARGET_TENANT, alias: targetAlias, modes: ['shell'],
      })).concat([{
        operator: operatorEmail, tenant_id: FOREIGN_TENANT, alias: foreignAlias, modes: ['shell'],
      }]),
    }), { mode: 0o600 });
    const tokenFile = join(relayDirectory, 'relay-token');
    const registryFile = join(relayDirectory, 'agent-registry.json');
    const closeSpoolFile = join(relayDirectory, 'close-spool.json');
    await Promise.all([
      writeFile(tokenFile, RELAY_TOKEN, { mode: 0o600 }),
      writeFile(closeSpoolFile, '', { mode: 0o600 }),
      writeFile(registryFile, JSON.stringify({ version: 1, agents: [{
        fingerprint_sha256: new X509Certificate(tlsMaterial.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
        tenant_id: TARGET_TENANT, alias: targetAlias,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      }] }), { mode: 0o600 }),
    ]);
    if (process.getuid?.() === 0 && relayUid !== undefined && relayGid !== undefined) {
      await Promise.all([tokenFile, registryFile, closeSpoolFile].map((path) => chown(path, relayUid, relayGid)));
    }
    await startedDatabase.pool.query(
      `INSERT INTO tenants(id) VALUES($1) ON CONFLICT(id) DO NOTHING`, [FOREIGN_TENANT],
    );
    const roomId = `e2e-terminal-${suffix}`;
    const foreignRoomId = `e2e-terminal-foreign-${suffix}`;
    await startedDatabase.pool.query(
      `INSERT INTO rooms(id, tenant_id) VALUES($1,$2),($3,$4)`,
      [roomId, TARGET_TENANT, foreignRoomId, FOREIGN_TENANT],
    );
    await startedDatabase.pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,
                          home_directory,state_directory)
       VALUES($1,$2,'openclaw',true,$3,'claw','/home/claw','/home/claw/.cauce'),
             ($1,$4,'openclaw',true,$5,'claw','/home/claw','/home/claw/.cauce'),
             ($6,$7,'openclaw',true,$8,'claw','/home/claw','/home/claw/.cauce')`,
      [
        TARGET_TENANT, targetAlias, `e2e-target-${suffix}`, actorAlias, `e2e-actor-${suffix}`,
        FOREIGN_TENANT, foreignAlias, `e2e-foreign-${suffix}`,
      ],
    );
    await startedDatabase.pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
         ($1,$2,$3,'operator'), ($1,$2,$4,'agent'), ($5,$6,$7,'agent')`,
      [TARGET_TENANT, roomId, actorAlias, targetAlias, FOREIGN_TENANT, foreignRoomId, foreignAlias],
    );
    await provision(operatorEmail, actorAlias, 'operator', OPERATOR_PASSWORD);
    await provision(readerEmail, actorAlias, 'reader', READER_PASSWORD);
    const relayIdentityFile = join(directory, 'relay-mtls-identities.json');
    await writeFile(relayIdentityFile, JSON.stringify({ version: 1, identities: [{
      certificate_sha256: RELAY_INSTANCE_ID,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      principal: {
        tenant_id: TARGET_TENANT, alias: targetAlias, session_id: randomUUID(), channel: 'agent',
        roles: ['agent'], permissions: ['route', 'read'],
      },
    }] }), { mode: 0o600 });
    const authProvider = new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(startedDatabase.pool),
      signingKey: randomBytes(32),
      sessionTtlMs: 15 * 60 * 1_000,
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(relayIdentityFile)),
    });
    await authProvider.ready();
    const config: TerminalConfig = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: TICKET_KEY,
      relayToken: RELAY_TOKEN,
      relayInstanceIds: new Set([RELAY_INSTANCE_ID, FOREIGN_RELAY_INSTANCE_ID]),
      grantsFile,
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator',
      operators: new Set([operatorEmail]),
    };
    const registry = new AgentRegistry();
    registry.observe({ relay_instance_id: FOREIGN_RELAY_INSTANCE_ID, relay_boot_id: RELAY_BOOT_ID }, [{
      tenant_id: FOREIGN_TENANT,
      alias: foreignAlias,
      container_id: `e2e-foreign-${suffix}`,
      generation: 'fixture-generation-1',
      image_id: IMAGE_ID,
      runtime_user: 'claw',
      runtime_uid: 1000,
      harness: 'openclaw',
      modes: ['shell'],
      connected_since: new Date().toISOString(),
    }]);
    startedApp = await buildGateway({
      pool: startedDatabase.pool,
      authProvider,
      https: { key: tlsMaterial.key, cert: tlsMaterial.cert, ca: tlsMaterial.cert, requestCert: true, rejectUnauthorized: true },
      terminalCapability: terminalCapabilityAnnouncement(config),
      outboxPollMs: 60_000,
    });
    await startedApp.register(registerTerminalControlPlane, {
      pool: startedDatabase.pool,
      authProvider,
      config,
      registry,
      measuredFacts: { factsFor: async () => undefined },
      governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'fixture has no manuals' }) },
    });
    await startedApp.listen({ host: '127.0.0.1', port: 0 });
    const address = startedApp.server.address() as AddressInfo;
    httpUrl = `https://127.0.0.1:${String(address.port)}`;
    app = startedApp;
    relayBrowserPort = await freeLoopbackPort();
    const agentPort = await freeLoopbackPort();
    const healthPort = await freeLoopbackPort();
    const relayEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CAUCE_TERMINAL_RELAY_BIND_HOST: '127.0.0.1',
      CAUCE_TERMINAL_RELAY_BROWSER_PORT: String(relayBrowserPort),
      CAUCE_TERMINAL_RELAY_AGENT_PORT: String(agentPort),
      CAUCE_TERMINAL_RELAY_HEALTH_PORT: String(healthPort),
      CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: tlsMaterial.cert_path,
      CAUCE_TERMINAL_RELAY_TLS_KEY_FILE: tlsMaterial.key_path,
      CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE: tlsMaterial.cert_path,
      CAUCE_TERMINAL_RELAY_AGENT_CA_FILE: tlsMaterial.cert_path,
      CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'localhost',
      CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE: registryFile,
      CAUCE_TERMINAL_GATEWAY_URL: httpUrl,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile,
      CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE: tlsMaterial.cert_path,
      CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE: tlsMaterial.key_path,
      CAUCE_TERMINAL_RELAY_INSTANCE_ID: RELAY_INSTANCE_ID,
      CAUCE_TERMINAL_CLOSE_SPOOL_FILE: closeSpoolFile,
      CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS: '1',
      CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS: '1',
      CAUCE_TERMINAL_PRESENCE_MAX_STALE_SECONDS: '30',
      NODE_EXTRA_CA_CERTS: tlsMaterial.cert_path,
    };
    await chmod(tlsMaterial.key_path, 0o600);
    const childIdentity = process.getuid?.() === 0 ? { uid: relayUid, gid: relayGid } : {};
    relayProcess = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'services/terminal-relay/src/main.ts'], {
      cwd: process.cwd(), env: relayEnv, stdio: ['ignore', 'pipe', 'pipe'], ...childIdentity,
    });
    relayLog = '';
    relayProcess.stdout?.on('data', (chunk: Buffer) => { relayLog = `${relayLog}${chunk.toString()}`.slice(-8_000); });
    relayProcess.stderr?.on('data', (chunk: Buffer) => { relayLog = `${relayLog}${chunk.toString()}`.slice(-8_000); });
    relayProcess.once('exit', (code) => { if (code !== 0) process.stderr.write(`relay exited (${String(code)}): ${relayLog}\n`); });
    await waitForRelay(relayProcess, healthPort);
    await assertLoopbackListeners([relayBrowserPort, agentPort, healthPort]);
    syntheticAgent = startFakeAgent({
      host: '127.0.0.1', port: agentPort, cert: tlsMaterial.cert, key: tlsMaterial.key, ca: tlsMaterial.cert,
      servername: 'localhost', tenant: TARGET_TENANT, alias: targetAlias,
      alias_key: deriveAliasKey(TICKET_KEY, TARGET_TENANT, targetAlias).toString('hex'),
      container_id: `e2e-target-${suffix}`, generation: 'fixture-generation-1', image_id: IMAGE_ID,
      runtime_user: 'claw', runtime_uid: 1000, modes: ['shell'], simulate_euid: 1000,
    });
    await syntheticAgent.ready;
    await new Promise((resolve) => setTimeout(resolve, 250));
    setupReady = true;
  } catch (error) {
    await stopRelay();
    await startedApp?.close().catch(() => undefined);
    await startedDatabase.pool.end().catch(() => undefined);
    await startedDatabase.container.stop().catch(() => undefined);
    if (directory !== '') await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (relayDirectory !== '') await rm(relayDirectory, { recursive: true, force: true }).catch(() => undefined);
    database = undefined;
    throw error;
  }
  tempDirectory = directory;
}

beforeEach(async ({ skip }) => {
  if (setupReady) return;
  if (process.env.CAUCE_TEST_DATABASE_URL === undefined) {
    await databaseRequirement.skipIfUnavailable(skip);
  }
  await setup();
}, 120_000);

afterAll(async () => {
  if (!setupReady || database === undefined) return;
  try {
    await stopRelay();
    await app?.close();
  } finally {
    try {
      await database.pool.end();
    } finally {
      try {
        await database.container.stop();
      } finally {
        try {
          await rm(tempDirectory, { recursive: true, force: true });
        } finally {
          await rm(relayDirectory, { recursive: true, force: true });
        }
      }
    }
  }
});
async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await httpsRequestBody(`${httpUrl}/v3/auth/login`, {
    method: 'POST',
    headers: { origin: httpUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers['set-cookie']?.[0] ?? '';
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('login returned a non-object response');
  return { status: response.status ?? 0, cookie: cookie.split(';', 1)[0] ?? '', body: body as Record<string, unknown> };
}
async function authenticated(email: string, password: string): Promise<BrowserSession> {
  const response = await login(email, password);
  expect(response.status).toBe(200);
  expect(response.cookie).toMatch(/^__Host-cauce_session=/u);
  expect(response.body.authenticated).toBe(true);
  const csrf = response.body.csrf_token;
  expect(typeof csrf).toBe('string');
  if (typeof csrf !== 'string') throw new Error('password login omitted CSRF token');
  return { cookie: response.cookie, csrf, body: response.body };
}
interface HttpsResponse {
  status: number | undefined;
  headers: import('node:http').IncomingHttpHeaders;
  json(): Promise<unknown>;
  text(): Promise<string>;
  clone(): { text(): Promise<string> };
}
async function httpsRequestBody(url: string, options: {
  method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number;
} = {}): Promise<HttpsResponse> {
  if (tlsMaterial === undefined) throw new Error('test TLS material is unavailable');
  const headers = { ...options.headers };
  if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));
  const response = await new Promise<{ statusCode: number | undefined; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { statusCode: number | undefined; headers: import('node:http').IncomingHttpHeaders; body: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(result as { statusCode: number | undefined; headers: import('node:http').IncomingHttpHeaders; body: string });
    };
    const request = httpsRequest(url, {
      method: options.method ?? 'GET', headers,
      cert: tlsMaterial?.cert, key: tlsMaterial?.key, ca: tlsMaterial?.cert,
      servername: 'localhost', rejectUnauthorized: true,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      incoming.once('error', (error) => { finish(error); });
      incoming.once('end', () => { finish(undefined, {
        statusCode: incoming.statusCode, headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }); });
    });
    const timer = setTimeout(() => {
      const error = new Error(`HTTPS request timed out after ${String(options.timeoutMs ?? 5_000)}ms`);
      request.destroy(error);
      finish(error);
    }, options.timeoutMs ?? 5_000);
    request.once('error', (error) => { finish(error); });
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
  return {
    status: response.statusCode, headers: response.headers,
    json: async () => JSON.parse(response.body) as unknown,
    text: async () => response.body,
    clone: () => ({ text: async () => response.body }),
  };
}
async function responseObject(response: HttpsResponse): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('HTTP response was not a JSON object');
  }
  return body as Record<string, unknown>;
}
function sessionPayload(alias = targetAlias, tenantId = TARGET_TENANT) {
  return {
    tenant_id: tenantId,
    alias,
    mode: 'shell',
    cols: 100,
    rows: 30,
    request_id: randomUUID(),
    owner_token: randomUUID(),
  };
}
async function createSession(
  session: BrowserSession,
  csrf: string | undefined,
  alias = targetAlias,
  tenantId = TARGET_TENANT,
  payload = sessionPayload(alias, tenantId),
) {
  return httpsRequestBody(`${httpUrl}/v3/console/terminal/sessions`, {
    method: 'POST',
    headers: {
      origin: httpUrl,
      cookie: session.cookie,
      'content-type': 'application/json',
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
    },
    body: JSON.stringify(payload),
  });
}
interface TerminalSocketStream {
  nextControl(timeoutMs?: number): Promise<Record<string, unknown>>;
  binaryUntil(value: string, timeoutMs?: number): Promise<string>;
}
function collectTerminalSocket(socket: WebSocket): TerminalSocketStream {
  const controls: Record<string, unknown>[] = [];
  const waiters: { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
  let output = '';
  socket.on('message', (data: RawData, isBinary: boolean) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (isBinary) { output += bytes.toString('utf8'); return; }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
    catch { return; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else controls.push(frame);
  });
  return {
    async nextControl(timeoutMs = 10_000) {
      const queued = controls.shift();
      if (queued !== undefined) return queued;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`terminal websocket control timeout; received ${JSON.stringify(controls)}`));
        }, timeoutMs);
        const waiter = { resolve: (frame: Record<string, unknown>) => { clearTimeout(timer); resolve(frame); }, reject };
        waiters.push(waiter);
      });
    },
    async binaryUntil(value, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!output.includes(value)) {
        if (Date.now() >= deadline) throw new Error(`terminal websocket output timeout; received ${JSON.stringify(output.slice(-200))}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return output;
    },
  };
}
function openRelaySocket(): { socket: WebSocket; stream: TerminalSocketStream } {
  if (tlsMaterial === undefined) throw new Error('test TLS material is unavailable');
  const socket = new WebSocket(
    `wss://127.0.0.1:${String(relayBrowserPort)}/v3/console/terminal/relays/${RELAY_INSTANCE_ID}/ws`,
    [], {
      cert: tlsMaterial.cert, key: tlsMaterial.key, ca: tlsMaterial.cert,
      origin: `https://127.0.0.1:${String(relayBrowserPort)}`, rejectUnauthorized: true,
    },
  );
  return { socket, stream: collectTerminalSocket(socket) };
}
function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onOpen = () => { finish(); }, onError = (error: Error) => { finish(error); };
    const onClose = () => { finish(new Error('terminal websocket closed before opening')); };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(new Error('terminal websocket handshake timed out'));
    }, 10_000);
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
async function expectHumanSubject(subject: unknown): Promise<void> {
  expect(typeof subject).toBe('string');
  if (typeof subject !== 'string' || database === undefined) throw new Error('durable human terminal subject is missing');
  const human = await database.pool.query<{ id: string }>('SELECT id::text AS id FROM console_users WHERE email=$1', [operatorEmail]);
  expect(human.rows).toHaveLength(1);
  expect(decodeTerminalSubject(subject)).toEqual({ kind: 'human', humanId: human.rows[0]?.id,
    actor: { tenantId: TARGET_TENANT, alias: actorAlias } });
}

describe('admisión HTTP de terminal: password auth, CSRF, grants y PostgreSQL desechable', () => {
  it('rechaza CSRF ausente antes de admitir una sesión', async () => {
    const session = await authenticated(operatorEmail, OPERATOR_PASSWORD);
    const response = await createSession(session, undefined);
    expect(response.status).toBe(403);
    expect((await responseObject(response)).error).toBe('forbidden');
    const rows = await database?.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM terminal_sessions',
    );
    expect(rows?.rows[0]?.count).toBe('0');
  });

  it('el rol reader no puede crear terminal aunque presente un CSRF válido', async () => {
    const session = await authenticated(readerEmail, READER_PASSWORD);
    const response = await createSession(session, session.csrf);
    expect(response.status).toBe(403);
    expect((await responseObject(response)).error).toBe('forbidden');
  });

  it('no revela destinos de otro tenant y rechaza la admisión cruzada', async () => {
    const session = await authenticated(operatorEmail, OPERATOR_PASSWORD);
    const targets = await httpsRequestBody(`${httpUrl}/v3/console/terminal/targets`, {
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    expect(targets.status).toBe(200);
    const targetBody = await targets.json() as { items: { tenant_id: string; alias: string }[] };
    expect(targetBody.items.some((item) => item.tenant_id === TARGET_TENANT && item.alias === targetAlias)).toBe(true);
    expect(targetBody.items.some((item) => item.tenant_id === FOREIGN_TENANT && item.alias === foreignAlias)).toBe(false);
    const response = await createSession(session, session.csrf, foreignAlias, FOREIGN_TENANT);
    expect([403, 404]).toContain(response.status);
    const body = await response.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(foreignAlias);
  });

  it('emite ticket firmado; sus campos HTTP en claro no exponen identidad, cookie ni CSRF', async () => {
    const session = await authenticated(operatorEmail, OPERATOR_PASSWORD);
    const requestPayload = sessionPayload();
    const response = await createSession(session, session.csrf, targetAlias, TARGET_TENANT, requestPayload);
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'authority_proof', 'expires_at', 'owner_generation', 'receipt_recovered', 'request_id', 'session_id', 'target',
      'ticket', 'ttl_seconds', 'websocket_path',
    ]);
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof body.ticket).toBe('string');
    expect(typeof body.authority_proof === 'string' && body.authority_proof.startsWith('ac2.')).toBe(true);
    expect(body.target).toMatchObject({ tenant_id: TARGET_TENANT, alias: targetAlias, mode: 'shell' });
    if (typeof body.ticket !== 'string' || typeof body.session_id !== 'string') {
      throw new Error('terminal admission response omitted its ticket or session id');
    }
    expect(verifyTicketSignature(body.ticket, deriveAliasKey(TICKET_KEY, TARGET_TENANT, targetAlias)))
      .toMatchObject({
        sid: body.session_id,
        op: operatorEmail,
        sub: `${TARGET_TENANT}:${actorAlias}`,
        tgt: { tenant: TARGET_TENANT, alias: targetAlias, uid: 1000, user: 'claw' },
      });
    const plainFields = { ...body };
    delete plainFields.ticket;
    expect(JSON.stringify(plainFields)).not.toContain(operatorEmail);
    expect(JSON.stringify(body)).not.toContain(session.cookie);
    expect(JSON.stringify(body)).not.toContain(session.csrf);
    const stored = await database?.pool.query<{
      tenant_id: string; alias: string; operator_id: string; console_subject: string; ticket_sha256: Buffer;
    }>(
      `SELECT tenant_id,alias,operator_id,console_subject,ticket_sha256
         FROM terminal_sessions WHERE id=$1`,
      [body.session_id],
    );
    expect(stored?.rows[0]).toMatchObject({
      tenant_id: TARGET_TENANT,
      alias: targetAlias,
      operator_id: operatorEmail,
    });
    await expectHumanSubject(stored?.rows[0]?.console_subject);
    expect(stored?.rows[0]?.ticket_sha256).toHaveLength(32);
    const released = await httpsRequestBody(`${httpUrl}/v3/console/terminal/sessions/${body.session_id}`, {
      method: 'DELETE',
      headers: {
        origin: httpUrl, cookie: session.cookie, 'content-type': 'application/json',
        'x-csrf-token': session.csrf,
      },
      body: JSON.stringify({
        owner_generation: body.owner_generation,
        owner_token: requestPayload.owner_token,
        request_id: requestPayload.request_id,
      }),
    });
    expect(released.status, await released.text()).toBe(204);
  });

  it('conecta por mTLS, reanuda y cierra al revocar la sesión durable en PostgreSQL', async () => {
    const session = await authenticated(operatorEmail, OPERATOR_PASSWORD);
    const requestPayload = sessionPayload();
    const admission = await createSession(session, session.csrf, targetAlias, TARGET_TENANT, requestPayload);
    expect(admission.status, await admission.text()).toBe(201);
    const admitted = await responseObject(admission);
    if (typeof admitted.session_id !== 'string' || typeof admitted.ticket !== 'string' || typeof admitted.authority_proof !== 'string') {
      throw new Error('gateway did not return a terminal session ticket');
    }
    const first = openRelaySocket();
    let ready: Record<string, unknown>;
    try {
      await waitForSocketOpen(first.socket);
      first.socket.send(JSON.stringify({
        type: 'attach', session_id: admitted.session_id, ticket: admitted.ticket, authority_proof: admitted.authority_proof, cols: 100, rows: 30,
      }));
      ready = await first.stream.nextControl();
      expect(ready).toMatchObject({ type: 'ready', session_id: admitted.session_id, resumed: false });
      expect(typeof ready.resume_token).toBe('string');
      const continuity = verifyAuthorityContinuity(admitted.authority_proof, TICKET_KEY);
      expect(continuity.sessionId).toBe(admitted.session_id);
      expect(verifyAuthorityResumeToken(String(ready.resume_token), TICKET_KEY, admitted.authority_proof))
        .toMatchObject({ sid: admitted.session_id, op: operatorEmail });
      expect(typeof ready.claim_token).toBe('string');
      expect(typeof ready.claim_epoch).toBe('string');
      first.socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
      expect(await first.stream.binaryUntil('pong-1')).toContain('pong-1');
    } finally {
      first.socket.terminate();
    }

    const claim = createHash('sha256').update(String(ready.claim_token)).digest();
    const persistedClaim = await database?.pool.query<{ relay_claim_sha256: Buffer; relay_claim_epoch: string }>(
      'SELECT relay_claim_sha256, relay_claim_epoch FROM terminal_sessions WHERE id=$1', [admitted.session_id],
    );
    expect(persistedClaim?.rows[0]?.relay_claim_sha256).toEqual(claim);
    expect(persistedClaim?.rows[0]?.relay_claim_epoch).toBe(ready.claim_epoch);

    const second = openRelaySocket();
    try {
      await waitForSocketOpen(second.socket);
      second.socket.send(JSON.stringify({
        type: 'resume', session_id: admitted.session_id, resume_token: ready.resume_token, authority_proof: admitted.authority_proof,
        prior_claim_token: ready.claim_token, prior_claim_epoch: ready.claim_epoch,
        after_bytes: 0, cols: 100, rows: 30,
      }));
      const resumed = await second.stream.nextControl();
      expect(resumed).toMatchObject({ type: 'ready', session_id: admitted.session_id, resumed: true });
      expect(await second.stream.binaryUntil('pong-1')).toContain('pong-1');
      second.socket.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
      expect(await second.stream.binaryUntil('pong-2')).toContain('pong-2');
      expect(admitted.owner_generation).toBe('1');
      expect(admitted.request_id).toBe(requestPayload.request_id);
      const ownerRow = await database?.pool.query<{
        request_id: string; browser_owner_generation: string; browser_owner_sha256: Buffer;
        operator_id: string; console_subject: string; attributed: boolean;
        revoked_at: Date | null; closed_at: Date | null;
      }>(
        `SELECT request_id, browser_owner_generation, browser_owner_sha256, operator_id, console_subject, attributed,
                revoked_at, closed_at
           FROM terminal_sessions WHERE id=$1`, [admitted.session_id],
      );
      expect(ownerRow?.rows[0]?.request_id).toBe(requestPayload.request_id);
      expect(ownerRow?.rows[0]?.browser_owner_generation).toBe(admitted.owner_generation);
      expect(ownerRow?.rows[0]?.browser_owner_sha256)
        .toEqual(createHash('sha256').update(requestPayload.owner_token, 'utf8').digest());
      expect(ownerRow?.rows[0]?.operator_id).toBe(operatorEmail);
      await expectHumanSubject(ownerRow?.rows[0]?.console_subject);
      expect(ownerRow?.rows[0]?.attributed).toBe(true);
      expect(ownerRow?.rows[0]?.revoked_at).toBeNull();
      expect(ownerRow?.rows[0]?.closed_at).toBeNull();
      const ownedSessions = await httpsRequestBody(`${httpUrl}/v3/console/terminal/sessions`, {
        headers: { cookie: session.cookie, accept: 'application/json' },
      });
      const ownedBody = await ownedSessions.json() as { items: { session_id: string }[] };
      expect(ownedBody.items.some((item) => item.session_id === admitted.session_id)).toBe(true);

      const socketClosed = new Promise<number>((resolve) => {
        const timer = setTimeout(() => { resolve(-1); }, 10_000);
        second.socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      const revocation = await httpsRequestBody(`${httpUrl}/v3/console/terminal/sessions/${admitted.session_id}`, {
        method: 'DELETE',
        headers: {
          origin: httpUrl, cookie: session.cookie, 'content-type': 'application/json',
          'x-csrf-token': session.csrf,
        },
        body: JSON.stringify({
          owner_generation: admitted.owner_generation,
          owner_token: requestPayload.owner_token,
          request_id: requestPayload.request_id,
        }),
      });
      expect(revocation.status, await revocation.text()).toBe(204);
      const closed = await socketClosed;
      expect(closed).toBe(4403);
    } finally {
      second.socket.terminate();
    }

    const deadline = Date.now() + 10_000;
    let closedAt: Date | null = null;
    while (Date.now() < deadline && closedAt === null) {
      const result = await database?.pool.query<{ closed_at: Date | null }>(
        'SELECT closed_at FROM terminal_sessions WHERE id=$1', [admitted.session_id],
      );
      closedAt = result?.rows[0]?.closed_at ?? null;
      if (closedAt === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(closedAt).toBeInstanceOf(Date);
    const audit = await database?.pool.query<{ action: string; decision: string }>(
      `SELECT action, decision FROM audit_events WHERE metadata->>'session_id'=$1 ORDER BY created_at`,
      [admitted.session_id],
    );
    expect(audit?.rows.some((row) => row.action === 'terminal.session.consume' && row.decision === 'info')).toBe(true);
    expect(audit?.rows.some((row) => row.action === 'terminal.session.close' && row.decision === 'info')).toBe(true);
  }, 60_000);
});
