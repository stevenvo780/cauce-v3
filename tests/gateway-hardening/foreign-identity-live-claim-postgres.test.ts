import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DeliveryEnvelopeSchema, type Ack, type PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
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
    `INSERT INTO agents(
       tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
       container_name,runtime_user,home_directory,state_directory
     ) VALUES('Steven','argos','claude',true,100,'ws-argos','dev','/home/dev','/home/dev/.cauce')`,
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
    trace_id: `foreign-identity-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'claimed under epoch 1, acked from epoch 2' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
  };
}

/*
 * P0 reproducido: un ACK cuyo claim_token+attempt siguen vigentes pero cuya identidad ya no es
 * la dueña del claim (acks.ts:~140) cerraba el socket con un 'error' sin correlación en vez de
 * responder 'ack_result'/ownership_lost como ya hace `staleTerminalReplay`. El outbox durable del
 * adaptador reenviaba el mismo ACK sin fin: rechazo -> cierre -> reconexión -> mismo ACK.
 *
 * `second` nunca reclama esta entrega con `claimDeliveries`: sólo la conoce por rehidratación
 * (lectura del claim aún vivo, que no toca `consumer_epoch`). La fila sigue diciendo que la
 * época 1 es la dueña; `second`, ya autenticado en época 2, no tiene forma de saberlo. Es
 * exactamente la forma de un ACK reenviado desde el outbox: la identidad que lo firma está
 * legítimamente conectada, sólo que ya no es la dueña de registro de ESTE claim.
 */
it('answers a live claim with a foreign identity as a correlated ownership_lost, not a socket-closing fence', async () => {
  const repository = new CauceRepository(pool);
  app = await buildGateway({
    pool,
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: async () => async () => undefined,
    outboxPollMs: 60_000,
    ackDeadlineMs: 120_000,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  await repository.publish(command());

  const first = await connect(port);
  expect(await first.next()).toMatchObject({ type: 'hello_ack', epoch: 1 });
  const delivery = DeliveryEnvelopeSchema.parse(await first.next());

  // La conexión se cae sin soltar el lease (partición de red, no un cierre limpio). El claim de
  // la entrega no se toca: sólo el derecho a reanudar bajo la misma época se apaga con el tiempo.
  const firstClosed = new Promise<void>((resolveClose) => first.socket.once('close', () => { resolveClose(); }));
  first.socket.terminate();
  await firstClosed;
  await pool.query(
    `UPDATE connection_leases SET lease_until=now()-interval '5 minutes'
      WHERE tenant_id='Steven' AND alias='argos'`,
  );

  const second = await connect(port);
  expect(await second.next()).toMatchObject({ type: 'hello_ack', epoch: 2 });

  const ack: Ack = {
    version: '3.0',
    event_id: randomUUID(),
    status: 'started',
    instance_id: 'stable-argos-runtime',
    epoch: 2,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
  };
  second.socket.send(JSON.stringify({ type: 'ack', delivery_id: delivery.delivery_id, ...ack }));
  const result = await second.next();
  expect(result).toEqual({
    type: 'ack_result',
    event_id: ack.event_id,
    delivery_id: delivery.delivery_id,
    attempt: ack.attempt,
    claim_token: ack.claim_token,
    status: 'leased',
    applied: false,
    receipt: 'ownership_lost',
  });

  // El receipt correlacionado hizo su trabajo sin un 4401: la conexión sigue tan usable como
  // antes de mandar el ACK ajeno.
  expect(second.socket.readyState).toBe(WebSocket.OPEN);
  const heartbeatAck = new Promise<Record<string, unknown>>((resolve) => {
    second.socket.once('message', (data) => {
      resolve(JSON.parse(text(data)) as Record<string, unknown>);
    });
  });
  second.socket.send(JSON.stringify({ type: 'heartbeat', instance_id: 'stable-argos-runtime', epoch: 2 }));
  await expect(heartbeatAck).resolves.toMatchObject({ type: 'heartbeat_ack' });

  // Nada del fencing en la base cambió: sigue 'leased', sigue siendo el claim de la época 1.
  const row = await pool.query<{
    status: string; consumer_instance_id: string; consumer_epoch: string; claim_token: string;
  }>(
    `SELECT status,consumer_instance_id,consumer_epoch,claim_token FROM deliveries WHERE id=$1`,
    [delivery.delivery_id],
  );
  expect(row.rows[0]).toMatchObject({
    status: 'leased',
    consumer_instance_id: 'stable-argos-runtime',
    consumer_epoch: '1',
    claim_token: delivery.claim_token,
  });
}, 180_000);
