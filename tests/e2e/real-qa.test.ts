import { execFile, spawn, type ChildProcess } from 'node:child_process';
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

beforeAll(async () => {
  database = await startTestDatabase();
  app = await buildGateway({
    pool: database.pool,
    authProvider: DevOnlyAuthProvider.forTests(),
    leaseTtlMs: 30_000,
    outboxPollMs: 10,
    allowedJobKinds: ['system.database.probe', 'qa.fairness'],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${address.port}`;
  stopDispatcher = runDispatcher(database.pool, {
    pollMs: 20,
    staleAckMs: 50,
    interactiveBurst: 3,
    jobLeaseMs: 500,
    handlers: createDefaultJobHandlerRegistry(database.pool, 'test'),
  }).stop;
}, 120_000);

afterAll(async () => {
  stopDispatcher?.();
  if (app) await app.close();
  if (database?.pool) await database.pool.end();
  if (database?.container) await database.container.stop();
});

describe('real external QA harness', () => {
  it('passes against Fastify WebSocket and PostgreSQL and emits evidence', async () => {
    // `execFile` rechaza con "Command failed: <argv>" y deja el stdout/stderr reales colgando en
    // propiedades del error que nadie imprime. Ese mensaje sin causa es lo que hizo que esta
    // suite pareciera un misterio durante cuatro dias: el arnes SI decia qué chequeo cayo.
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
        CAUCE_RETRY_TIMEOUT_MS: '15000',
      },
      timeout: 170_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch((error: unknown) => {
      const detail = error as { stdout?: string; stderr?: string };
      throw new Error(
        `real QA harness failed\n--- stdout ---\n${detail.stdout ?? ''}\n--- stderr ---\n${detail.stderr ?? ''}`,
        { cause: error },
      );
    });
    expect(stderr).toBe('');
    expect(stdout).toContain('PASS 12 aliases and four harness kinds over real WS');
    expect(stdout).not.toContain('SKIP ');
    expect(stdout).not.toContain('FAIL ');
  }, 180_000);

  it('runs two permanent-style fake adapters through async push and terminal ACK', async () => {
    await resetTestDatabase(database.pool);
    const root = await mkdtemp(join(process.cwd(), '.adapter-e2e-'));
    const adapters: ChildProcess[] = [];
    const diagnostics: string[] = [];
    // La sala es identidad PROPIA del agente, no la del remitente: estas son las que siembra
    // 001_initial.sql para salva/hegel y las que declaran sus manifiestos de flota. Desde 547eda3
    // el adaptador falla cerrado sin ella, asi que este arnes debe pasarla igual que la unit de
    // systemd (generate-units.py) y el supervisor de contenedor.
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
        child.stdout?.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString('utf8').trim()));
        child.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString('utf8').trim()));
        adapters.push(child);
      }
      try {
        await waitFor(async () => {
          const status = await authenticatedFetch<{ presence: Array<Record<string, unknown>> }>('/v3/status');
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
            const message = await authenticatedFetch<{ deliveries: Array<{ status: string }> }>(`/v3/messages/${published.message_id}`);
            latestState = message.deliveries?.[0]?.status ?? 'missing';
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
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('preserves offline deliveries across authentic gateway and PostgreSQL restarts', async () => {
    const results: RestartResult[] = [];

    await resetTestDatabase(database.pool);
    const gatewayMessage = await publishForRestart('Miguel', 'kratos', 'grp.steven');
    await restartGateway();
    await consumeAfterRestart('Miguel', 'kratos', gatewayMessage);
    results.push({ name: 'gateway restart preserves queued delivery', status: 'passed', evidence: 'real' });

    await resetTestDatabase(database.pool);
    const postgresMessage = await publishForRestart('Pablo', 'seneca', 'grp.steven');
    await database.container.restart({ timeout: 30_000 });
    await waitFor(async () => database.pool.query('SELECT 1').then(() => true).catch(() => false), 45_000);
    await consumeAfterRestart('Pablo', 'seneca', postgresMessage);
    results.push({ name: 'PostgreSQL restart preserves queued delivery', status: 'passed', evidence: 'real' });

    await writeRestartArtifacts(results);
  }, 120_000);
});

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
  httpUrl = `http://127.0.0.1:${address.port}`;
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

async function writeRestartArtifacts(results: RestartResult[]): Promise<void> {
  const directory = join(process.cwd(), 'ops/artifacts/restarts');
  await mkdir(directory, { recursive: true });
  const report = `${JSON.stringify({
    schemaVersion: 1,
    suite: 'cauce-v3-restart-e2e',
    mode: 'real',
    summary: {
      tests: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: 0,
      skipped: results.filter((result) => result.status === 'skipped').length,
      real: results.filter((result) => result.evidence === 'real').length,
      mocked: 0,
    },
    tests: results,
  }, null, 2)}\n`;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cauce-v3-restart-e2e" tests="${results.length}" failures="0" skipped="${skipped}">\n${results.map((result) => `  <testcase classname="cauce.restart" name="${result.name}">${result.status === 'skipped' ? `<skipped message="${result.error}"/>` : ''}</testcase>`).join('\n')}\n</testsuite>\n`;
  await writeFile(join(directory, 'report.json'), report);
  await writeFile(join(directory, 'junit.xml'), junit);
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${digest(report)}  report.json\n${digest(junit)}  junit.xml\n`);
}

async function authenticatedFetch<T = Record<string, unknown>>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${httpUrl}${pathname}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'x-cauce-tenant': 'Steven',
      'x-cauce-alias': 'kant',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function waitFor(operation: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition timed out after ${timeoutMs}ms`);
}
