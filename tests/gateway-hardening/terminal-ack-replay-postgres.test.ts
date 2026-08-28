import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DeliveryEnvelopeSchema, type Ack, type PublishMessage,
} from '@cauce/protocol';
import {
  CauceRepository, type AckResult, type DatabasePool,
} from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../helpers/postgres.js';
import { text } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof buildGateway>>;

let database: TestDatabase;
let pool: DatabasePool;
let app: Gateway | undefined;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
     VALUES('Steven','argos',false,100)`,
  );
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

async function connect(port: number): Promise<{
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'argos' },
  });
  sockets.push(socket);
  const queued: Record<string, unknown>[] = [];
  const waiting: ((frame: Record<string, unknown>) => void)[] = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(text(data)) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve === undefined) queued.push(frame);
    else resolve(frame);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  const next = async (): Promise<Record<string, unknown>> => {
    const frame = queued.shift();
    return frame ?? new Promise((resolveFrame) => waiting.push(resolveFrame));
  };
  socket.send(JSON.stringify({
    type: 'hello',
    version: '3.0',
    tenant_id: 'Steven',
    alias: 'argos',
    instance_id: 'stable-argos-runtime',
    capabilities: ['acks.v3', 'renewable_delivery_claims_v1', 'delegation_feedback_v1'],
  }));
  return { socket, next };
}

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `terminal-replay-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'commit before terminal receipt transport loss' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
  };
}

it('replays a committed terminal ACK through epoch N+1 with identical feedback', async () => {
  const authoritative = new CauceRepository(pool);
  let releaseFirstResult: (() => void) | undefined;
  const firstResultReleased = new Promise<void>((resolveRelease) => {
    releaseFirstResult = resolveRelease;
  });
  let publishCommitted: ((result: AckResult) => void) | undefined;
  const firstCommit = new Promise<AckResult>((resolveCommit) => {
    publishCommitted = resolveCommit;
  });
  let holdFirstResult = true;
  const gatewayRepository = new Proxy(authoritative, {
    get(target, property) {
      if (property === 'ackDelivery') {
        return async (...args: Parameters<CauceRepository['ackDelivery']>): Promise<AckResult> => {
          const result = await target.ackDelivery(...args);
          if (holdFirstResult) {
            holdFirstResult = false;
            publishCommitted?.(result);
            await firstResultReleased;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => method.apply(target, args);
    },
  });
  app = await buildGateway({
    pool,
    repository: gatewayRepository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: async () => async () => undefined,
    outboxPollMs: 60_000,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  await authoritative.publish(command());

  const first = await connect(port);
  expect(await first.next()).toMatchObject({ type: 'hello_ack', epoch: 1 });
  const delivery = DeliveryEnvelopeSchema.parse(await first.next());
  const ack: Ack = {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: 'stable-argos-runtime',
    epoch: 1,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: {
      output: {
        reply: 'delegated before transport loss',
        messages: [
          { to: 'socrates', body: 'first exact branch' },
          { to: 'INVALID ALIAS', body: 'durable rejection' },
          { to: 'socrates', body: 'second exact branch' },
        ],
        status: 'done',
        retryable: false,
        artifacts: [],
      },
    },
  };
  first.socket.send(JSON.stringify({ type: 'ack', delivery_id: delivery.delivery_id, ...ack }));
  const fresh = await firstCommit;
  expect(fresh).toMatchObject({ applied: true, receipt: 'applied' });
  expect(fresh.delegation_rejections).toHaveLength(1);
  expect(fresh.delegation_materializations).toHaveLength(2);

  // The DB commit is complete but the gateway cannot obtain the result yet. Terminating here
  // deterministically loses the ack_result frame instead of merely choosing not to assert it.
  const firstClosed = new Promise<void>((resolveClose) => first.socket.once('close', () => { resolveClose(); }));
  first.socket.terminate();
  await firstClosed;
  releaseFirstResult?.();
  await pool.query(
    `UPDATE connection_leases SET lease_until=now()-interval '11 minutes'
      WHERE tenant_id='Steven' AND alias='argos'`,
  );

  const second = await connect(port);
  expect(await second.next()).toMatchObject({ type: 'hello_ack', epoch: 2 });
  second.socket.send(JSON.stringify({ type: 'ack', delivery_id: delivery.delivery_id, ...ack }));
  const replay = await second.next();
  expect(replay).toEqual({
    type: 'ack_result',
    event_id: ack.event_id,
    delivery_id: delivery.delivery_id,
    attempt: ack.attempt,
    claim_token: ack.claim_token,
    status: 'done',
    applied: false,
    receipt: 'duplicate',
    delegation_rejections: fresh.delegation_rejections,
    delegation_materializations: fresh.delegation_materializations,
  });
  expect((await pool.query(
    `SELECT 1 FROM agent_output_materializations WHERE source_delivery_id=$1`,
    [delivery.delivery_id],
  )).rowCount).toBe(3);
  expect((await pool.query(
    `SELECT 1 FROM deliveries WHERE id IN (
       SELECT produced_delivery_id FROM agent_output_materializations
       WHERE source_delivery_id=$1 AND status='materialized'
     )`,
    [delivery.delivery_id],
  )).rowCount).toBe(2);
}, 180_000);
