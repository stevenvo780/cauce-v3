import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import type { PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.js';

type Gateway = Awaited<ReturnType<typeof buildGateway>>;

let database: TestDatabase;
let observer: DatabasePool;
const apps: Gateway[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  database = await startTestDatabase();
  observer = database.pool;
}, 120_000);

afterAll(async () => {
  await observer?.end();
  await database?.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(observer);
  await observer.query(
    `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
     VALUES('Isa','salva',false,100)`,
  );
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function start(pool: DatabasePool, repository: CauceRepository): Promise<{
  app: Gateway;
  port: number;
}> {
  const app = await buildGateway({
    pool,
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: async () => async () => undefined,
    outboxPollMs: 10,
    outboxLeaseMs: 30_000,
    outboxWakeConcurrency: 2,
    outboxShutdownTimeoutMs: 100,
    logger: false,
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as AddressInfo).port };
}

async function connect(port: number, tenant: Tenant, alias: string, instanceId: string): Promise<{
  socket: WebSocket;
  received: Record<string, unknown>[];
  hello: Record<string, unknown>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
    headers: { 'x-cauce-tenant': tenant, 'x-cauce-alias': alias },
  });
  sockets.push(socket);
  const received: Record<string, unknown>[] = [];
  const queued: Record<string, unknown>[] = [];
  const waiting: Array<(frame: Record<string, unknown>) => void> = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(text(data)) as Record<string, unknown>;
    received.push(frame);
    const resolve = waiting.shift();
    if (resolve === undefined) queued.push(frame);
    else resolve(frame);
  });
  const next = async (): Promise<Record<string, unknown>> => {
    const frame = queued.shift();
    return frame ?? new Promise((resolve) => waiting.push(resolve));
  };
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: tenant, alias, instance_id: instanceId,
    capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
  }));
  const hello = await next();
  expect(hello).toMatchObject({ type: 'hello_ack' });
  expect(hello).not.toHaveProperty('connection_token');
  return { socket, received, hello };
}

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `gateway-pg-fence-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'real PostgreSQL wake fence' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
  };
}

describe('gateway wake fencing against real PostgreSQL', () => {
  it('lets only the newest same-instance gateway claim, drain, heartbeat and ACK', async () => {
    const firstGateway = await start(observer, new CauceRepository(observer));
    const secondGateway = await start(observer, new CauceRepository(observer));
    const instanceId = 'shared-resume-instance';
    const stale = await connect(firstGateway.port, 'Isa', 'salva', instanceId);
    const current = await connect(secondGateway.port, 'Isa', 'salva', instanceId);
    expect(current.hello.epoch).toBe(stale.hello.epoch);

    await new CauceRepository(observer).publish(command());
    await waitFor(() => current.received.some((frame) => frame.type === 'wake'));
    await waitFor(async () => (await observer.query<{ sent: boolean; attempts: number }>(
      `SELECT status='sent' AS sent,attempts FROM adapter_outbox
       WHERE kind='wake' AND tenant_id='Isa' AND payload->>'recipient_alias'='salva'`,
    )).rows[0]?.sent === true);
    expect(stale.received.some((frame) => frame.type === 'wake' || frame.type === 'delivery')).toBe(false);
    expect((await observer.query<{ attempts: number }>(
      `SELECT attempts FROM adapter_outbox
       WHERE kind='wake' AND tenant_id='Isa' AND payload->>'recipient_alias'='salva'`,
    )).rows[0]).toEqual({ attempts: 1 });

    stale.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: instanceId, epoch: stale.hello.epoch,
    }));
    await waitFor(() => stale.received.some((frame) =>
      frame.type === 'error' && frame.code === 'fenced'));
    await firstGateway.app.close();
    apps.splice(apps.indexOf(firstGateway.app), 1);
    expect((await observer.query<{ live: boolean; instance_id: string }>(
      `SELECT lease_until>now() AS live,instance_id FROM connection_leases
       WHERE tenant_id='Isa' AND alias='salva'`,
    )).rows[0]).toEqual({ live: true, instance_id: instanceId });
  });

  it('aborts a lock-blocked real claim so app.close and pool.end finish with no late effect', async () => {
    const applicationName = `cauce-gateway-abort-${randomUUID()}`;
    const dedicated = createPool(database.url, {
      max: 4, connectionTimeoutMillis: 2_000, applicationName,
    });
    const repository = new CauceRepository(dedicated);
    const gateway = await start(dedicated, repository);
    const connection = await connect(gateway.port, 'Isa', 'salva', 'blocked-real-claim');
    const holder = await observer.connect();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let backendPid: number | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id='Isa' AND alias='salva' FOR UPDATE`,
      );
      await repository.publish(command());
      await waitFor(async () => {
        const blocked = await observer.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE application_name=$1 AND wait_event_type='Lock'
             AND query LIKE '%jsonb_to_recordset%connection_leases%'
           ORDER BY pid LIMIT 1`,
          [applicationName],
        );
        backendPid = blocked.rows[0]?.pid;
        return backendPid !== undefined;
      });

      const startedAt = Date.now();
      await expect(Promise.race([
        gateway.app.close().then(() => 'closed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 2_000)),
      ])).resolves.toBe('closed');
      apps.splice(apps.indexOf(gateway.app), 1);
      await expect(Promise.race([
        dedicated.end().then(() => 'ended' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 2_000)),
      ])).resolves.toBe('ended');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await waitFor(async () => (await observer.query<{ alive: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive`, [backendPid],
      )).rows[0]?.alive === false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connection.received.some((frame) => frame.type === 'wake')).toBe(false);
      expect((await observer.query<{ status: string; attempts: number }>(
        `SELECT status,attempts FROM adapter_outbox
         WHERE kind='wake' AND tenant_id='Isa' AND payload->>'recipient_alias'='salva'`,
      )).rows[0]).toEqual({ status: 'pending', attempts: 0 });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await gateway.app.close().catch(() => undefined);
      await dedicated.end().catch(() => undefined);
    }
  }, 30_000);
});
