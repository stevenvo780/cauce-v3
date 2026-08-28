import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHarness } from '@cauce/adapter-sdk';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { createDefaultJobHandlerRegistry, runDispatcher } from '../../services/dispatcher/src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const execute = promisify(execFile);
let database: TestDatabase;
let app: Awaited<ReturnType<typeof buildGateway>>;
let stopDispatcher: (() => void) | undefined;
let httpUrl: string;

interface DatabaseImageBinding {
  role: 'postgresql-test-dependency';
  repositoryDigest: string;
  imageId: string;
  containerConfigImage: string;
  containerIdSha256: string;
  verifiedAgainstRunningContainer: true;
}

let databaseImageBinding: DatabaseImageBinding | undefined;

beforeAll(async () => {
  database = await startTestDatabase();
  if (process.env.CAUCE_EVIDENCE_CLASS === 'testcontainers') {
    databaseImageBinding = await inspectDatabaseImage();
    process.env.CAUCE_TESTCONTAINERS_DB_REPOSITORY_DIGEST = databaseImageBinding.repositoryDigest;
    process.env.CAUCE_TESTCONTAINERS_DB_IMAGE_ID = databaseImageBinding.imageId;
    process.env.CAUCE_TESTCONTAINERS_DB_CONFIG_IMAGE = databaseImageBinding.containerConfigImage;
    process.env.CAUCE_TESTCONTAINERS_DB_CONTAINER_ID_SHA256 = databaseImageBinding.containerIdSha256;
  }
  app = await buildGateway({
    pool: database.pool,
    authProvider: DevOnlyAuthProvider.forTests(),
    leaseTtlMs: 30_000,
    outboxPollMs: 10,
    allowedJobKinds: ['system.database.probe', 'qa.fairness'],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${String(address.port)}`;
  stopDispatcher = runDispatcher(database.pool, {
    pollMs: 20,
    staleAckMs: 50,
    interactiveBurst: 3,
    jobLeaseMs: 500,
    handlers: createDefaultJobHandlerRegistry(database.pool, 'test'),
  }).stop;
}, 120_000);

afterAll(async () => {
  if (stopDispatcher) stopDispatcher();
  await app.close();
  await database.pool.end();
  await database.container.stop();
  for (const key of [
    'CAUCE_TESTCONTAINERS_DB_REPOSITORY_DIGEST', 'CAUCE_TESTCONTAINERS_DB_IMAGE_ID',
    'CAUCE_TESTCONTAINERS_DB_CONFIG_IMAGE', 'CAUCE_TESTCONTAINERS_DB_CONTAINER_ID_SHA256',
  ]) Reflect.deleteProperty(process.env, key);
});

async function inspectDatabaseImage(): Promise<DatabaseImageBinding> {
  const containerId = database.container.getId();
  const container = JSON.parse((await execute(
    'docker', ['inspect', '--format', '{{json .}}', containerId], { maxBuffer: 1024 * 1024 },
  )).stdout) as { Image?: unknown; Config?: { Image?: unknown } };
  if (typeof container.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(container.Image)
      || typeof container.Config?.Image !== 'string' || !container.Config.Image) {
    throw new Error('running Testcontainers database has no exact Docker image identity');
  }
  const repositoryDigests = JSON.parse((await execute(
    'docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', container.Image], { maxBuffer: 1024 * 1024 },
  )).stdout) as unknown;
  if (!Array.isArray(repositoryDigests)) throw new Error('Testcontainers database image has no RepoDigests');
  const raw = repositoryDigests.find((value): value is string =>
    typeof value === 'string' && /(?:^|\/)postgres@sha256:[a-f0-9]{64}$/u.test(value));
  if (!raw) throw new Error('Testcontainers PostgreSQL image is not repository-digest recoverable');
  const repositoryDigest = raw.startsWith('postgres@') ? `docker.io/library/${raw}` : raw;
  return {
    role: 'postgresql-test-dependency',
    repositoryDigest,
    imageId: container.Image,
    containerConfigImage: container.Config.Image,
    containerIdSha256: `sha256:${createHash('sha256').update(containerId).digest('hex')}`,
    verifiedAgainstRunningContainer: true,
  };
}

function sourceDigest(domain: 'runtime' | 'testcontainers'): string {
  const value = execFileSync('python3', [
    'ops/scripts/source-digest.py', '--domain', domain,
  ], { cwd: process.cwd(), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' }).trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid ${domain} source digest`);
  return value;
}

function testcontainersBindings() {
  if (process.env.CAUCE_EVIDENCE_CLASS !== 'testcontainers') return {};
  if (!databaseImageBinding) throw new Error('Testcontainers database image binding is unavailable');
  return {
    evidenceClass: 'testcontainers-source-execution',
    executionTarget: {
      application: 'source-tree',
      database: 'immutable-testcontainer-image',
      finalCauceImageExecuted: false,
    },
    sourceDigest: sourceDigest('runtime'),
    sourceDigestDomain: 'runtime',
    harnessDigest: sourceDigest('testcontainers'),
    harnessDigestDomain: 'testcontainers',
    databaseImage: databaseImageBinding,
  };
}

describe('real external QA harness', () => {
  it('passes against Fastify WebSocket and PostgreSQL and emits evidence', async () => {
    // `execFile` rejects with "Command failed: <argv>" and leaves the real stdout/stderr hanging
    // on error properties that nobody prints. That causeless message is what made this suite
    // look like a mystery for four days: the harness DID say which check fell over.
    const { stdout, stderr } = await execute(process.execPath, [
      'ops/harness/runner.mjs', '--live', '--artifact-dir', 'ops/artifacts/real',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CAUCE_BASE_URL: httpUrl,
        CAUCE_WS_URL: `${httpUrl.replace('http:', 'ws:')}/v3/ws`,
        CAUCE_FAULT_MODE: 'none',
        CAUCE_PRESENCE_LEASE_MS: '500',
        CAUCE_RETRY_TIMEOUT_MS: '45000',
      },
      timeout: 170_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(async (error: unknown) => {
      const detail = error as { stdout?: string; stderr?: string };
      const recovery = await database.pool.query<{
        status: string;
        attempt: number;
        max_attempts: number;
        available_in_seconds: string;
        claimed: boolean;
        last_error: string | null;
      }>(
        `SELECT status,attempt,max_attempts,
                round(EXTRACT(EPOCH FROM (available_at-now())))::text AS available_in_seconds,
                consumer_instance_id IS NOT NULL AS claimed,last_error
           FROM deliveries
          WHERE status NOT IN ('done','failed','dead')
          ORDER BY created_at`
      ).then((result) => result.rows).catch(() => []);
      throw new Error(
        `real QA harness failed\n--- stdout ---\n${detail.stdout ?? ''}` +
          `\n--- stderr ---\n${detail.stderr ?? ''}` +
          `\n--- sanitized recovery state ---\n${JSON.stringify(recovery)}`,
        { cause: error },
      );
    });
    expect(stderr).toBe('');
    expect(stdout).toContain('PASS 15 aliases and four harness kinds over real WS');
    expect(stdout).not.toContain('SKIP ');
    expect(stdout).not.toContain('FAIL ');
  }, 180_000);

  it('runs two permanent-style fake adapters through async push and terminal ACK', async () => {
    await resetTestDatabase(database.pool);
    await declareDeliveryConsumers([
      ['Isa', 'salva', 'codex'],
      ['Jhon', 'hegel', 'openclaw'],
    ]);
    const root = await mkdtemp(join(process.cwd(), '.adapter-e2e-'));
    const adapters: ChildProcess[] = [];
    const diagnostics: string[] = [];
    // The room is the agent's OWN identity, not the sender's: these are the rooms seeded by
    // 001_initial.sql for salva/hegel and the ones declared in their fleet manifests. Since
    // 547eda3 the adapter fails closed without it, so this harness must pass it the same way
    // the systemd unit (generate-units.py) and the container supervisor do.
    const identities = [
      { tenant: 'Isa', room: 'grp.isa', alias: 'salva', instance: 'e2e-fake-isa' },
      { tenant: 'Jhon', room: 'grp.jhon', alias: 'hegel', instance: 'e2e-fake-jhon' },
    ];
    try {
      for (const item of identities) {
        const child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/fake.js'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CAUCE_TENANT: item.tenant,
            CAUCE_ROOM: item.room,
            CAUCE_ALIAS: item.alias,
            CAUCE_INSTANCE_ID: item.instance,
            CAUCE_STATE_DIR: join(root, item.alias),
            CAUCE_RELAY_URL: `${httpUrl.replace('http:', 'ws:')}/v3/ws`,
            CAUCE_ENVIRONMENT: 'test',
            CAUCE_DEV_AUTH: '1',
            CAUCE_HARNESS_COMMAND: join(process.cwd(), 'packages/adapter-sdk/dist/src/bin/fake-harness.js'),
            CAUCE_HEARTBEAT_MS: '100',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString('utf8').trim()));
        child.stderr.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString('utf8').trim()));
        adapters.push(child);
      }
      try {
        await waitFor(async () => {
          const status = await authenticatedFetch<{ presence: Record<string, unknown>[] }>('/v3/status');
          return identities.every((item) => status.presence.some((row) =>
            row.tenant_id === item.tenant && row.alias === item.alias && row.online === true));
        });
      } catch (error) {
        throw new Error(
          `fake adapter presence timed out; child exits=${adapters.map((child) => child.exitCode).join(',')}; diagnostics=${diagnostics.join('|')}`,
          { cause: error },
        );
      }

      for (const item of identities) {
        const published = await authenticatedFetch<{ message_id: string }>('/v3/messages', {
          method: 'POST',
          body: JSON.stringify({
            room_id: 'grp.steven',
            recipients: [{ tenant_id: item.tenant, alias: item.alias }],
            body: { text: `fake adapter ${item.alias}` },
            idempotency_key: `adapter-e2e-${item.alias}`,
            lane: 'interactive',
            priority: 10,
          }),
        });
        let latestState = 'unknown';
        try {
          await waitFor(async () => {
            const message = await authenticatedFetch<{ deliveries: { status: string }[] }>(`/v3/messages/${published.message_id}`);
            latestState = message.deliveries[0]?.status ?? 'missing';
            if (latestState === 'failed' || latestState === 'dead') throw new Error(`fake adapter ${item.alias} ended ${latestState}`);
            return latestState === 'done';
          });
        } catch (error) {
          throw new Error(`fake adapter ${item.alias} stalled at ${latestState}; child exits=${adapters.map((child) => child.exitCode).join(',')}; diagnostics=${diagnostics.join('|')}`, { cause: error });
        }
      }
    } finally {
      await Promise.all(adapters.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve(); }));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('preserves offline deliveries across authentic gateway and PostgreSQL restarts', async () => {
    const startedAt = new Date().toISOString();
    const results: RestartResult[] = [];

    await resetTestDatabase(database.pool);
    await declareDeliveryConsumers([['Miguel', 'kratos', 'codex']]);
    const gatewayMessage = await publishForRestart('Miguel', 'kratos', 'grp.steven');
    await restartGateway();
    await consumeAfterRestart('Miguel', 'kratos', gatewayMessage);
    results.push({ name: 'gateway restart preserves queued delivery', status: 'passed', evidence: 'real' });

    await resetTestDatabase(database.pool);
    await declareDeliveryConsumers([['Pablo', 'seneca', 'openclaw']]);
    const postgresMessage = await publishForRestart('Pablo', 'seneca', 'grp.steven');
    await database.container.restart({ timeout: 30_000 });
    await reconnectDatabaseAfterContainerRestart();
    await consumeAfterRestart('Pablo', 'seneca', postgresMessage);
    results.push({ name: 'PostgreSQL restart preserves queued delivery', status: 'passed', evidence: 'real' });

    await writeRestartArtifacts(results, startedAt);
  }, 120_000);
});

type DeliveryConsumerIdentity =
  | readonly ['Isa', 'salva', 'codex']
  | readonly ['Jhon', 'hegel', 'openclaw']
  | readonly ['Miguel', 'kratos', 'codex']
  | readonly ['Pablo', 'seneca', 'openclaw'];

/**
 * `resetTestDatabase()` deliberately truncates the mutable agent registry. Since lease admission
 * now fails closed when an agent has no durable concurrency declaration, every authentic consumer
 * used after a reset MUST be restored explicitly. The full placement is intentionally local to this
 * disposable test database: production placement has its own manifest parity gates, and copying
 * it here would create a second source of truth. What this scenario proves is the durable
 * declared-consumer contract instead of weakening gateway admission for a missing fixture row.
 */
async function declareDeliveryConsumers(identities: readonly DeliveryConsumerIdentity[]): Promise<void> {
  for (const [tenant, alias, harness] of identities) {
    await database.pool.query(
      `INSERT INTO agents(
         tenant_id,alias,harness_id,display_name,enabled,
         container_name,runtime_user,home_directory,state_directory,max_concurrent_deliveries
       ) VALUES ($1,$2,$3,initcap($2),true,$4,'test','/tmp',$5,2)
       ON CONFLICT (tenant_id,alias) DO UPDATE SET
         harness_id=EXCLUDED.harness_id,display_name=EXCLUDED.display_name,enabled=true,
         container_name=EXCLUDED.container_name,runtime_user=EXCLUDED.runtime_user,
         home_directory=EXCLUDED.home_directory,state_directory=EXCLUDED.state_directory,
         max_concurrent_deliveries=EXCLUDED.max_concurrent_deliveries,updated_at=now()`,
      [tenant, alias, harness, `e2e-${alias}`, `/tmp/cauce-v3-e2e/${alias}`],
    );
  }
}

async function restartGateway(): Promise<void> {
  await app.close();
  app = await buildGateway({
    pool: database.pool,
    authProvider: DevOnlyAuthProvider.forTests(),
    leaseTtlMs: 30_000,
    outboxPollMs: 10,
    allowedJobKinds: ['system.database.probe', 'qa.fairness'],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${String(address.port)}`;
}

async function reconnectDatabaseAfterContainerRestart(): Promise<void> {
  const containerHost = database.container.getHost();
  let target = containerHost;
  if (containerHost !== 'external') {
    const endpoint = new URL(database.url);
    const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
    endpoint.hostname = network ? database.container.getIpAddress(network) : containerHost;
    endpoint.port = String(network ? 5432 : database.container.getMappedPort(5432));
    database.url = endpoint.toString();
    database.pool.options.connectionString = database.url;
    target = `${endpoint.hostname}:${endpoint.port}`;
  }

  let lastError: unknown;
  await waitFor(async () => database.pool.query('SELECT 1').then(() => true).catch((error: unknown) => {
    lastError = error;
    return false;
  }), 45_000).catch((error: unknown) => {
    throw new Error(
      `database pool did not reconnect to ${target}`,
      { cause: lastError ?? error },
    );
  });
}

async function publishForRestart(tenant: 'Miguel' | 'Pablo', alias: string, room: string): Promise<string> {
  const response = await authenticatedFetch<{ message_id: string }>('/v3/messages', {
    method: 'POST',
    body: JSON.stringify({
      room_id: room,
      recipients: [{ tenant_id: tenant, alias }],
      body: { text: `restart-${tenant}-${alias}` },
      idempotency_key: randomUUID(),
      lane: 'interactive',
      priority: 10,
    }),
  });
  return response.message_id;
}

async function consumeAfterRestart(tenant: 'Miguel' | 'Pablo', alias: string, messageId: string): Promise<void> {
  const consumer = new FakeHarness({ tenant_id: tenant, alias, instance_id: randomUUID(), capabilities: ['restart-qa'] });
  try {
    await consumer.connect(`${httpUrl.replace('http:', 'ws:')}/v3/ws`);
    const delivery = await consumer.nextDelivery(15_000);
    expect(delivery.message_id).toBe(messageId);
    consumer.ack(delivery, 'done');
    await expect(consumer.waitFor((frame) => frame.type === 'ack_result' && frame.delivery_id === delivery.delivery_id))
      .resolves.toMatchObject({ status: 'done', applied: true });
  } finally {
    await consumer.close();
  }
}

interface RestartResult {
  name: string;
  status: 'passed' | 'skipped';
  evidence: 'real' | 'skipped';
  error?: string;
}

async function writeRestartArtifacts(results: RestartResult[], startedAt: string): Promise<void> {
  const directory = join(process.cwd(), 'ops/artifacts/restarts');
  await mkdir(directory, { recursive: true });
  const report = `${JSON.stringify({
    schemaVersion: 2,
    suite: 'cauce-v3-restart-e2e',
    mode: 'real',
    ...testcontainersBindings(),
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: {
      tests: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: 0,
      skipped: results.filter((result) => result.status === 'skipped').length,
      criticalSkipped: 0,
      real: results.filter((result) => result.evidence === 'real').length,
      mocked: 0,
    },
    tests: results,
  }, null, 2)}\n`;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cauce-v3-restart-e2e" tests="${String(results.length)}" failures="0" skipped="${String(skipped)}">\n${results.map((result) => `  <testcase classname="cauce.restart" name="${result.name}">${result.status === 'skipped' ? `<skipped message="${result.error ?? ''}"/>` : ''}</testcase>`).join('\n')}\n</testsuite>\n`;
  await writeFile(join(directory, 'report.json'), report);
  await writeFile(join(directory, 'junit.xml'), junit);
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${digest(report)}  report.json\n${digest(junit)}  junit.xml\n`);
}

async function authenticatedFetch<T = Record<string, unknown>>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('x-cauce-tenant', 'Steven');
  headers.set('x-cauce-alias', 'kant');
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${httpUrl}${pathname}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`${pathname} returned ${String(response.status)}`);
  return response.json() as Promise<T>;
}

async function waitFor(operation: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition timed out after ${String(timeoutMs)}ms`);
}
