import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { createServer as createHttpServer } from 'node:https';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { hechosDelRegistro } from '../../services/gateway/src/terminal/hechos-del-registro.js';
import { relayInstanceIdFromCertificate } from '../../services/terminal-relay/src/relay-identity.js';
import { AgentLeg, createAgentTlsServer } from '../../services/terminal-relay/src/agent-leg.js';
import { setupGovernanceRelay } from '../../services/terminal-relay/src/governance-relay.js';
import { createPool, CauceRepository, CONTEXT_WRITE_QUARANTINE_KIND } from '@cauce/store';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

const executePath = join(process.cwd(), 'ops/pty-agent');
const TEST_TENANT = 'Steven';
const OPERATOR_ALIAS = 'kant';
const TEST_TOKEN = randomBytes(32).toString('base64url');

export interface ContextWriteQuiescenceFixture {
  readonly database: TestDatabase;
  readonly databaseId: string;
  readonly journalDirectory: string;
  readonly directory: string;
  readonly targetPath: string;
  readonly oldContent: string;
  readonly newContent: string;
  readonly operationUrl: string;
  readonly requestWrite: () => Promise<{ status: number; body: string }>;
  readonly waitForReplaceBarrier: () => Promise<void>;
  readonly releaseReplaceBarrier: () => Promise<void>;
  readonly readTarget: () => Promise<string>;
  readonly writeTarget: (value: string) => Promise<void>;
  readonly record: (value: string) => Promise<void>;
  readonly loseCoordinatorPool: () => Promise<number[]>;
  readonly journalState: (operationId: string) => Promise<{ state: string; operation_id: string; request_id: string; writer_instance_id: string }>;
  readonly claim: () => Promise<unknown>;
  readonly attemptNewLease: () => Promise<unknown>;
  readonly attemptResumeLease: () => Promise<unknown>;
  readonly attemptTakeoverLease: () => Promise<unknown>;
  readonly leaseState: () => Promise<{ readonly instanceId: string; readonly epoch: string; readonly tokenSha: string } | undefined>;
  readonly pendingOperation: () => Promise<{ id: string; status: string; lease_until: Date | null; payload: unknown } | undefined>;
  readonly readRelayStatus: (payload: Record<string, unknown>) => Promise<{ status: number; body: string }>;
  readonly repository: CauceRepository;
  readonly close: () => Promise<void>;
}

export interface ContextWriteQuiescenceSetupResources {
  readonly database: TestDatabase;
  readonly databaseId: string;
  readonly directory: string;
  readonly gatewayPool: ReturnType<typeof createPool>;
  readonly agent: ChildProcess;
  readonly ports: readonly number[];
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function listen(server: import('node:net').Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`owned agent did not reach the filesystem barrier: ${path}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const finish = (exited: boolean) => { clearTimeout(timer); child.off('exit', onExit); resolve(exited); };
    const onExit = () => { finish(true); };
    const timer = setTimeout(() => { finish(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function requestJson(url: string, tls: HttpsAgent, body: unknown): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'PUT', agent: tls, headers: {
        origin: new URL(url).origin, 'content-type': 'application/json',
        'x-cauce-tenant': TEST_TENANT, 'x-cauce-alias': OPERATOR_ALIAS,
        'content-length': payload.byteLength,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    request.setTimeout(45_000, () => request.destroy(new Error('owned context write request deadline')));
    request.once('error', reject);
    request.end(payload);
  });
}

export async function startContextWriteQuiescenceFixture(options: {
  readonly afterAgentReady?: (resources: ContextWriteQuiescenceSetupResources) => Promise<void>;
} = {}): Promise<ContextWriteQuiescenceFixture> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
    throw new Error('context write quiescence requires its own disposable Testcontainers database');
  }
  if (process.getuid?.() === 0) throw new Error('PTY causal E2E must run as the normal workspace user');
  let ownedDatabase: TestDatabase | undefined;
  let ownedDirectory: string | undefined;
  let releasePath: string | undefined;
  let ownedAgent: ChildProcess | undefined;
  let ownedAgentServer: ReturnType<typeof createAgentTlsServer> | undefined;
  let ownedLeg: AgentLeg | undefined;
  let ownedRelayServer: ReturnType<typeof createHttpServer> | undefined;
  let ownedReservation: ReturnType<typeof createTcpServer> | undefined;
  let ownedApp: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let ownedGatewayPool: ReturnType<typeof createPool> | undefined;
  let ownedTls: HttpsAgent | undefined;
  let gatewayPoolClosed = false;
  let closed = false;
  const closeOwned = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>): Promise<void> => {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    };
    const ownedReleasePath = releasePath;
    if (ownedReleasePath !== undefined) await cleanup(() => writeFile(ownedReleasePath, 'release', { mode: 0o600 }));
    let reaped = ownedAgent === undefined;
    if (ownedAgent !== undefined) {
      reaped = await waitForExit(ownedAgent, 2_000);
      if (!reaped) {
        ownedAgent.kill('SIGTERM');
        reaped = await waitForExit(ownedAgent, 2_000);
      }
      if (!reaped) {
        ownedAgent.kill('SIGKILL');
        reaped = await waitForExit(ownedAgent, 2_000);
      }
      if (!reaped) cleanupErrors.push(new Error(`owned pty-agent PID ${String(ownedAgent.pid)} did not exit after cleanup`));
    }
    const activeLeg = ownedLeg;
    if (activeLeg !== undefined) await cleanup(() => activeLeg.close());
    const activeAgentServer = ownedAgentServer;
    if (activeAgentServer?.listening) await cleanup(() => new Promise<void>((resolve, reject) => {
      activeAgentServer.close((error) => { if (error) reject(error); else resolve(); });
    }));
    const activeRelayServer = ownedRelayServer;
    if (activeRelayServer?.listening) await cleanup(() => new Promise<void>((resolve, reject) => {
      activeRelayServer.close((error) => { if (error) reject(error); else resolve(); });
    }));
    const activeReservation = ownedReservation;
    if (activeReservation?.listening) await cleanup(() => new Promise<void>((resolve, reject) => {
      activeReservation.close((error) => { if (error) reject(error); else resolve(); });
    }));
    const activeApp = ownedApp;
    if (activeApp !== undefined) await cleanup(() => activeApp.close());
    const activePool = ownedGatewayPool;
    if (!gatewayPoolClosed && activePool !== undefined) await cleanup(() => activePool.end());
    ownedTls?.destroy();
    const activeDatabase = ownedDatabase;
    if (activeDatabase !== undefined) {
      await cleanup(() => activeDatabase.pool.end());
      await cleanup(() => activeDatabase.container.stop());
    }
    const activeDirectory = ownedDirectory;
    if (reaped && activeDirectory !== undefined) await cleanup(() => rm(activeDirectory, { recursive: true, force: true }));
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'owned context write fixture cleanup failed');
  };
  try {
  const database = await startTestDatabase();
  ownedDatabase = database;
  const databaseId = database.container.getId();
  const directory = await mkdtemp(join(tmpdir(), 'cauce-context-quiescence-'));
  ownedDirectory = directory;
  const certificate = createSelfSignedCert({ directory });
  const ca = certificate.cert;
  const key = certificate.key;
  const cert = certificate.cert;
  const targetAlias = `ctxq${randomBytes(5).toString('hex')}`;
  const targetContainer = `ctxq-container-${randomUUID()}`;
  const generation = randomBytes(16).toString('hex');
  const home = join(directory, 'runtime-home');
  const claudeDirectory = join(home, '.claude');
  const targetPath = join(claudeDirectory, 'CLAUDE.md');
  const oldContent = '# Existing private runtime context\n';
  const newContent = '# Updated private runtime context\n';
  const barrierDirectory = join(directory, 'barrier');
  const targetReached = join(barrierDirectory, 'replace-reached');
  const release = join(barrierDirectory, 'replace-release');
  const tls = new HttpsAgent({ cert, key, ca, rejectUnauthorized: true });
  ownedTls = tls;
  const agentServer = createAgentTlsServer({ cert, key, ca });
  ownedAgentServer = agentServer;
  const registryPath = join(directory, 'agent-registry.json');
  const agentFingerprint = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  await writeFile(registryPath, JSON.stringify({ version: 1, agents: [{
    fingerprint_sha256: agentFingerprint, tenant_id: TEST_TENANT, alias: targetAlias,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  }] }), { mode: 0o600 });
  const leg = new AgentLeg({ server: agentServer, registryFile: registryPath });
  ownedLeg = leg;
  const agentPort = await listen(agentServer);
  const relayServer = createHttpServer({ cert, key, ca, requestCert: true, rejectUnauthorized: true });
  ownedRelayServer = relayServer;
  setupGovernanceRelay({ server: relayServer, agents: leg, token: async () => TEST_TOKEN, timeoutMs: 30_000 });
  const relayPort = await listen(relayServer);
  const relayId = relayInstanceIdFromCertificate(cert);
  const registry = new AgentRegistry();
  const auth = DevOnlyAuthProvider.forTests();
  const gatewayApplicationName = `ctxq-gateway-${randomUUID()}`;
  const gatewayPool = createPool(database.url, { applicationName: gatewayApplicationName });
  ownedGatewayPool = gatewayPool;
  const config: TerminalConfig = {
    wsPath: '/v3/console/terminal/ws', ticketKey: randomBytes(32), relayToken: TEST_TOKEN,
    relayInstanceIds: new Set([relayId]), relayUrl: `https://127.0.0.1:${String(relayPort)}`,
    relayClientCertFile: certificate.cert_path, relayClientKeyFile: certificate.key_path,
    relayCaFile: certificate.cert_path, grantsFile: join(directory, 'grants.json'),
    ticketTtlSeconds: 30, sessionTtlSeconds: 900, claimLeaseSeconds: 150,
    maxSessionsPerOperator: 2, operatorHeader: 'x-cauce-operator', operators: new Set(),
  };
  await writeFile(config.grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
  const roomId = `ctxq-room-${randomUUID()}`;
  await database.pool.query('INSERT INTO tenants(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [TEST_TENANT]);
  await database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES ($1,$2)', [roomId, TEST_TENANT]);
  await database.pool.query(`
    INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES ($1,$2,'claude',$2,true,$3,'dev',$4,$5);
  `, [TEST_TENANT, targetAlias, targetContainer, home, join(home, '.cauce')]);
  await database.pool.query(`
    INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES ($1,$2,'claude','Operator',true,$3,'dev','/home/dev','/tmp/operator');
  `, [TEST_TENANT, OPERATOR_ALIAS, `ctxq-operator-${randomUUID()}`]);
  await database.pool.query(`
    INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
      VALUES ($1,$2,$3,'operator',true),($1,$2,$4,'agent',true);
  `, [TEST_TENANT, roomId, OPERATOR_ALIAS, targetAlias]);
  const reservation = createTcpServer();
  ownedReservation = reservation;
  const gatewayPort = await listen(reservation);
  await new Promise<void>((resolve, reject) => { reservation.close((error) => { if (error) reject(error); else resolve(); }); });
  const gatewayUrl = `https://127.0.0.1:${String(gatewayPort)}`;
  const app = await buildGateway({
    pool: gatewayPool, authProvider: auth,
    https: { key, cert, ca, requestCert: true, rejectUnauthorized: true },
    consoleOrigins: [gatewayUrl], outboxPollMs: 60_000,
  });
  ownedApp = app;
  await app.register(registerTerminalControlPlane, {
    pool: gatewayPool, authProvider: auth, config, registry,
    measuredFacts: hechosDelRegistro(registry),
  });
  await app.listen({ host: '127.0.0.1', port: gatewayPort });
  await mkdir(claudeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(targetPath, oldContent, { mode: 0o600 });
  await mkdir(barrierDirectory, { mode: 0o700 });
  releasePath = release;
  const hookDirectory = join(directory, 'python-hook');
  await mkdir(hookDirectory, { mode: 0o700 });
  await writeFile(join(hookDirectory, 'sitecustomize.py'), [
    'import os, time',
    '_real_replace = os.replace',
    `def _blocked_replace(src, dst, *args, **kwargs):`,
    `    if dst == 'CLAUDE.md' and isinstance(src, str) and src.startswith('.cauce-governance-') and not os.path.exists(${JSON.stringify(release)}):`,
    `        with open(${JSON.stringify(targetReached)}, 'x', encoding='ascii') as marker: marker.write('ready')`,
    `        deadline = time.monotonic() + 40`,
    `        while not os.path.exists(${JSON.stringify(release)}):`,
    `            if time.monotonic() >= deadline: raise TimeoutError('owned barrier deadline')`,
    '            time.sleep(0.01)',
    '    return _real_replace(src, dst, *args, **kwargs)',
    'os.replace = _blocked_replace',
    '',
  ].join('\n'), { mode: 0o600 });
  const journalDirectory = join(directory, 'journal');
  await mkdir(journalDirectory, { mode: 0o700 });
  const bundlePath = join(directory, 'agent-bundle.json');
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const bundle = {
    tenant_id: TEST_TENANT, alias: targetAlias, container_id: targetContainer,
    generation, image_id: `sha256:${'c'.repeat(64)}`, runtime_user: 'dev', runtime_uid: uid,
    runtime_gid: gid, home, shell_candidates: ['/bin/sh'], harness: 'claude',
    relay_host: '127.0.0.1', relay_port: agentPort, relay_server_name: 'localhost',
    alias_key_hex: randomBytes(32).toString('hex'), client_cert_pem: cert.toString(),
    client_key_pem: key.toString(), ca_pem: ca.toString(), agent_version: 'causal-quiescence-test',
    governance_journal_dir: journalDirectory,
    runtime_facts: { claude_config_dir: claudeDirectory },
  };
  await writeFile(bundlePath, JSON.stringify(bundle), { mode: 0o400 });
  const agent = spawn('python3', ['-m', 'cauce_pty_agent', '--bundle', bundlePath], {
    cwd: process.cwd(), env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONPATH: `${hookDirectory}:${executePath}`,
      CAUCE_TEST_WRITE_TARGET: targetPath, CAUCE_TEST_WRITE_BARRIER: barrierDirectory,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownedAgent = agent;
  if (agent.pid === undefined) throw new Error('owned pty-agent process did not start');
  let agentLog = '';
  for (const stream of [agent.stdout, agent.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      agentLog = `${agentLog}${chunk.toString('utf8')}`.slice(-12_000);
    });
  }
  const relayBootId = randomUUID();
  const helloDeadline = Date.now() + 15_000;
  while (Date.now() < helloDeadline && leg.presence().length === 0) {
    if (agent.exitCode !== null) throw new Error(`real pty-agent exited before HELLO: ${agentLog}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const presence = leg.presence();
  if (presence.length !== 1) {
    throw new Error(`real agent HELLO did not advertise durable writer identity: ${agentLog}`);
  }
  const connected = presence[0];
  const features = connected?.features ?? [];
  if (connected?.writer_instance_id === undefined || !features.includes('write_quiescence_v1')) {
    throw new Error(`real agent HELLO did not advertise durable writer identity: ${agentLog}`);
  }
  registry.observe({ relay_instance_id: relayId, relay_boot_id: relayBootId }, presence);
  const repository = new CauceRepository(database.pool);
  const instanceId = randomUUID();
  const lease = await repository.acquireLease(
    TEST_TENANT, targetAlias, instanceId, [...features], 60_000,
  );
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('owned PTY test could not acquire its own connection lease');
  }
  const leaseEpoch = lease.epoch;
  const connectionToken = lease.connection_token;
  await options.afterAgentReady?.({
    database, databaseId, directory, gatewayPool, agent,
    ports: [agentPort, relayPort, gatewayPort],
  });
  return {
    database, databaseId, directory, journalDirectory, targetPath, oldContent, newContent,
    operationUrl: `${gatewayUrl}/v3/console/tenants/${TEST_TENANT}/agents/${targetAlias}/documents/directive/content`,
    requestWrite: () => requestJson(`${gatewayUrl}/v3/console/tenants/${TEST_TENANT}/agents/${targetAlias}/documents/directive/content`, tls, {
      content: newContent, expected_sha: sha(oldContent), reason: 'reconcile private runtime context',
    }),
    waitForReplaceBarrier: async () => {
      try {
        await waitForFile(targetReached, 8_000);
      } catch (error) {
        throw new Error(`${String(error)}; pty-agent=${agentLog.slice(-2_000)}; presence=${String(leg.presence().length)}`);
      }
    },
    releaseReplaceBarrier: async () => { await writeFile(release, 'release', { mode: 0o600 }); },
    readTarget: async () => readFile(targetPath, 'utf8'),
    writeTarget: async (value) => writeFile(targetPath, value, { mode: 0o600 }),
    record: async (value) => writeFile(join(directory, 'evidence.txt'), value, { mode: 0o600 }),
    loseCoordinatorPool: async () => {
      if (gatewayPoolClosed) return [];
      const terminated = await database.pool.query<{ pid: number; terminated: boolean }>(
        `SELECT pid,pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()`,
        [gatewayApplicationName],
      );
      if (terminated.rows.length === 0 || terminated.rows.some((row) => !row.terminated)) {
        throw new Error('owned gateway backend termination was not confirmed');
      }
      gatewayPoolClosed = true;
      await gatewayPool.end();
      return terminated.rows.map((row) => row.pid);
    },
    journalState: async (operationId) => {
      const parsed: unknown = JSON.parse(await readFile(join(journalDirectory, `${operationId}.json`), 'utf8'));
      if (parsed === null || typeof parsed !== 'object') throw new Error('owned journal record is malformed');
      const record = parsed as Record<string, unknown>;
      if (typeof record.state !== 'string' || typeof record.operation_id !== 'string'
        || typeof record.request_id !== 'string' || typeof record.writer_instance_id !== 'string') {
        throw new Error('owned journal receipt is missing required fields');
      }
      return { state: record.state, operation_id: record.operation_id, request_id: record.request_id, writer_instance_id: record.writer_instance_id };
    },
    claim: () => repository.claimDeliveries(
      TEST_TENANT, targetAlias, instanceId, leaseEpoch, 1, 30_000, 3, {}, connectionToken,
    ),
    attemptNewLease: () => repository.acquireLease(TEST_TENANT, targetAlias, randomUUID(), [], 60_000),
    attemptResumeLease: () => repository.acquireLease(TEST_TENANT, targetAlias, instanceId,
      [...features], 60_000, { resume: true }),
    attemptTakeoverLease: () => repository.acquireLease(TEST_TENANT, targetAlias, randomUUID(), [], 60_000, { takeover: true }),
    leaseState: async () => {
      const result = await database.pool.query<{ instance_id: string; epoch: string; connection_token: string }>(
        `SELECT instance_id,epoch::text,connection_token::text FROM connection_leases WHERE tenant_id=$1 AND alias=$2`,
        [TEST_TENANT, targetAlias],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { instanceId: row.instance_id, epoch: row.epoch, tokenSha: sha(row.connection_token) };
    },
    pendingOperation: async () => {
      const result = await database.pool.query<{ id: string; status: string; lease_until: Date | null; payload: unknown }>(
        `SELECT id,status,lease_until,payload FROM jobs
          WHERE tenant_id=$1 AND kind=$2 AND payload->>'alias'=$3 ORDER BY created_at DESC LIMIT 1`,
        [TEST_TENANT, CONTEXT_WRITE_QUARANTINE_KIND, targetAlias],
      );
      return result.rows[0];
    },
    readRelayStatus: (body) => new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const request = httpsRequest(`https://127.0.0.1:${String(relayPort)}/v3/terminal/relay/write-status`, {
        method: 'POST', agent: tls, headers: {
          authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json',
          'content-length': payload.byteLength,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      });
      request.setTimeout(10_000, () => request.destroy(new Error('owned relay status deadline')));
      request.once('error', reject);
      request.end(payload);
    }),
    repository,
    close: closeOwned,
  };
  } catch (error) {
    try {
      await closeOwned();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'owned context write fixture setup and cleanup failed');
    }
    throw error;
  }
}
