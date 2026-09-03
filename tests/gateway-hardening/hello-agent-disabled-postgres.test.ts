import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeTestDatabase, dockerTestRequirement, resetTestDatabase, startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.js';
import { closeGatewaysAndSockets, text } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof buildGateway>>;

let database: TestDatabase | undefined;
let pool: DatabasePool;
const apps: Gateway[] = [];
const sockets: WebSocket[] = [];
const databaseRequirement = dockerTestRequirement(
  'disabled-agent hello rejection and enabled-agent lease creation against real PostgreSQL',
);
const testDatabaseNeedsDocker = !process.env.CAUCE_TEST_DATABASE_URL;

afterAll(async () => {
  await closeTestDatabase(database);
});

beforeEach(async ({ skip }) => {
  if (testDatabaseNeedsDocker) await databaseRequirement.skipIfUnavailable(skip);
  if (database === undefined) {
    database = await startTestDatabase();
    pool = database.pool;
  }
  await resetTestDatabase(pool);
  await pool.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
       container_name,runtime_user,home_directory,state_directory
     ) VALUES('Steven','argos','claude',false,100,'ws-argos','dev','/home/dev','/home/dev/.cauce')`,
  );
}, 180_000);

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
});

async function gateway(): Promise<{ port: number }> {
  const app = await buildGateway({
    pool, authProvider: DevOnlyAuthProvider.forTests(), leaseTtlMs: 10_000,
    ackDeadlineMs: 60_000, outboxPollMs: 60_000, logger: false,
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { port: (app.server.address() as AddressInfo).port };
}

/** Opens a socket to /v3/ws, sends the hello frame and resolves with the first reply frame. */
async function hello(port: number, instanceId: string): Promise<{
  frame: Record<string, unknown>;
  closeCode: Promise<number>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'argos' },
  });
  sockets.push(socket);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  const closeCode = new Promise<number>((resolveClose) => {
    socket.once('close', (code) => { resolveClose(code); });
  });
  const framePromise = new Promise<Record<string, unknown>>((resolveFrame, rejectFrame) => {
    socket.once('message', (data) => { resolveFrame(JSON.parse(text(data)) as Record<string, unknown>); });
    socket.once('error', rejectFrame);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Steven', alias: 'argos',
    instance_id: instanceId, capabilities: [],
  }));
  return { frame: await framePromise, closeCode };
}

describe('hello rejects a disabled agent (agents.enabled=false)', () => {
  it('rejects the hello and creates no connection lease when the agent is disabled', async () => {
    const { port } = await gateway();
    const { frame, closeCode } = await hello(port, 'disabled-argos-runtime');

    expect(frame).toMatchObject({ type: 'error', code: 'consumer_disabled' });
    expect(frame.type).not.toBe('hello_ack');
    expect(await closeCode).toBe(4403);

    const leases = await pool.query(
      `SELECT 1 FROM connection_leases WHERE tenant_id='Steven' AND alias='argos'`,
    );
    expect(leases.rowCount).toBe(0);
  }, 30_000);

  it('accepts the hello and issues hello_ack once the same agent is enabled', async () => {
    await pool.query(`UPDATE agents SET enabled=true WHERE tenant_id='Steven' AND alias='argos'`);
    const { port } = await gateway();
    const { frame } = await hello(port, 'enabled-argos-runtime');

    expect(frame).toMatchObject({ type: 'hello_ack', version: PROTOCOL_VERSION, epoch: 1 });

    const leases = await pool.query<{ instance_id: string }>(
      `SELECT instance_id FROM connection_leases WHERE tenant_id='Steven' AND alias='argos'`,
    );
    expect(leases.rows).toEqual([{ instance_id: 'enabled-argos-runtime' }]);
  }, 30_000);
});
