import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { expect } from 'vitest';
import { WsOutboundSchema, type DeliveryEnvelope } from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { runDispatcher } from '../../services/dispatcher/src/index.js';
import { closeTestDatabase, resetTestDatabase, startTestDatabase } from '../helpers/postgres.js';
import { requireDockerLab } from './b2-lab.js';

type Frame = ReturnType<typeof WsOutboundSchema.parse>;

export class DeliveryWire {
  private readonly frames: Frame[] = [];
  private failure: Error | undefined;
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      try { this.frames.push(WsOutboundSchema.parse(JSON.parse(bytes.toString('utf8')))); }
      catch (error) { this.failure = error instanceof Error ? error : new Error('Invalid gateway frame'); }
    });
    socket.on('error', error => { this.failure = error; });
  }
  async next<T extends Frame['type']>(type: T, timeout = 70_000): Promise<Extract<Frame, { type: T }>> {
    let result: Frame | undefined;
    await expect.poll(() => {
      if (this.failure) throw this.failure;
      const index = this.frames.findIndex(frame => frame.type === type || frame.type === 'error');
      if (index < 0) return false;
      result = this.frames.splice(index, 1)[0];
      return true;
    }, { timeout, interval: 50 }).toBe(true);
    if (result?.type !== type) throw new Error(`Expected ${type}: ${JSON.stringify(result)}`);
    return result as Extract<Frame, { type: T }>;
  }
  send(value: object): void { this.socket.send(JSON.stringify(value)); }
  close(): void { this.socket.terminate(); }
}

export async function startDeliveryRuntime() {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('An owned disposable PostgreSQL container is required');
  await requireDockerLab();
  const database = await startTestDatabase({ requireOwnedContainer: true });
  const wires: DeliveryWire[] = [];
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let dispatcher: ReturnType<typeof runDispatcher> | undefined;
  let baseUrl = '';
  const boot = async () => {
    app = await buildGateway({ pool: database.pool, authProvider: DevOnlyAuthProvider.forTests(),
      ackDeadlineMs: 5000, outboxPollMs: 50, pendingSweepMs: 0, logger: false });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  };
  try {
    await resetTestDatabase(database.pool);
    await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
      container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven','argos','claude',true,1,'zz-canary-b2','dev','/home/dev','/home/dev/.cauce')`);
    await boot();
    console.info('B2_DELIVERY_RUNTIME', JSON.stringify({ daemon: 'docker-lab', postgres: database.container.getId(),
      gateway: 'real Fastify TCP and WebSocket', authentication: 'DevOnlyAuthProvider.forTests' }));
  } catch (error) { await app?.close(); await closeTestDatabase(database); throw error; }
  return {
    database,
    async request(path: string, body?: object, alias = 'argos') {
      const response = await fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-cauce-tenant': 'Steven', 'x-cauce-alias': alias },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() as unknown };
    },
    async publish(text: string, idempotencyKey = randomUUID(), author = 'kant') {
      const response = await this.request('/v3/messages', { room_id: 'grp.steven',
        recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text },
        idempotency_key: idempotencyKey, lane: 'interactive', priority: 0 }, author);
      expect(response.status).toBe(202);
      return response.body;
    },
    async connect() {
      const socket = new WebSocket(`${baseUrl.replace(/^http/u, 'ws')}/v3/ws`, {
        headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'argos' } });
      const wire = new DeliveryWire(socket); wires.push(wire);
      await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); });
      wire.send({ type: 'hello', version: '3.0', tenant_id: 'Steven', alias: 'argos',
        instance_id: 'zz-canary-b2-consumer', capabilities: [] });
      const hello = await wire.next('hello_ack');
      return { wire, epoch: hello.epoch };
    },
    ack(delivery: DeliveryEnvelope, epoch: number, extra: object = {}) {
      return { version: '3.0', event_id: randomUUID(), status: 'done',
        instance_id: 'zz-canary-b2-consumer', epoch, claim_token: delivery.claim_token,
        attempt: delivery.attempt, retryable: false, ...extra };
    },
    startReaper() {
      dispatcher = runDispatcher(database.pool, { pollMs: 100, staleAckMs: 5000,
        chainSweepMs: 0, retentionIntervalMs: 0 });
    },
    async restartGateway() { await app?.close(); await boot(); },
    async close() {
      dispatcher?.stop(); wires.forEach(wire => { wire.close(); });
      try { await app?.close(); } finally { await closeTestDatabase(database); }
    },
  };
}

export type DeliveryRuntime = Awaited<ReturnType<typeof startDeliveryRuntime>>;
