import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishResultSchema } from '@cauce/protocol';
import { withTransaction } from '@cauce/store';
import { object, startConsoleLedgerFixture, type Session } from '../../../tests/e2e/console-password-human-ledger.fixtures.js';
import { insertMessage } from '../../../packages/store/src/repository/messages/_insert.js';
import { putHumanMessageInitiator } from '../../../packages/store/src/repository/messages/human-initiators.js';
import { buildTestGateway } from './test-support/gateway-doubles.js';

const ROOT = 'zz-canary-owner-batch-root';
const BATCH = 'zz-canary-batch-lineage-body';
const TELEGRAM = 'zz-canary-telegram-proactive-body';
const OTHER_ROOM = 'zz-canary-other-room-body';
const OTHER_TENANT = 'zz-canary-other-tenant-body';

let fixture: Awaited<ReturnType<typeof startConsoleLedgerFixture>> | undefined;
const apps: FastifyInstance[] = [];
function current() { if (!fixture) throw new Error('Fixture unavailable'); return fixture; }

async function gateway() {
  const context = current();
  const app = await buildTestGateway({ pool: context.pool, repository: context.repository, authProvider: context.provider });
  apps.push(app);
  return app;
}

async function publishBatch(session: Session) {
  const context = current();
  const command = { ...context.command(), lane: 'batch' as const, body: { text: ROOT } };
  const prepared = await context.prepare(session, command);
  const response = await context.send('/v3/console/messages', prepared.body, session);
  expect(response.status).toBe(202);
  const receipt = PublishResultSchema.parse(response.body);
  const confirmed = await context.send('/v3/console/publish-intents/confirm', {
    idempotency_key: receipt.idempotency_key, message_id: receipt.message_id, causal_hash: receipt.causal_hash,
  }, session);
  expect(confirmed.status).toBe(200);
  return receipt.message_id;
}

async function copyLine(
  rootId: string, text: string, lane: 'batch' | 'interactive', channel: string,
  origin?: { adapter: string; channel: string; conversation_id: string; relay: []; metadata: Record<string, unknown> },
) {
  const context = current();
  const owner = await context.pool.query<{ human: string; tenant: string; conversation_id: string }>(
    `SELECT initiating_human_id AS human, initiating_tenant_id AS tenant, conversation_id
     FROM human_message_initiators WHERE message_id=$1`, [rootId]);
  const row = owner.rows[0];
  if (!row) throw new Error('Root initiator is missing');
  const receipt = await context.repository.publish({
    version: '3.0', idempotency_key: randomUUID(), request_id: randomUUID(), trace_id: randomUUID(),
    tenant_id: context.tenant, actor_alias: context.actor, room_id: context.room,
    recipients: [{ tenant_id: context.tenant, alias: context.target }], body: { text },
    ...(origin === undefined ? {} : { origin }), lane, priority: 1,
    authenticated_context: {
      session_id: `copy:${randomUUID()}`, channel, ...(origin === undefined ? {} : { origin }),
    },
  });
  await withTransaction(context.pool, (client) => putHumanMessageInitiator(client, {
    messageId: receipt.message_id, messageTenantId: context.tenant, humanId: row.human,
    tenantId: row.tenant, rootMessageId: rootId, conversationId: row.conversation_id,
  }));
  return receipt.message_id;
}

function detail(app: FastifyInstance, id: string, session: Session) {
  return app.inject({ method: 'GET', url: `/v3/console/messages/${id}`, headers: { cookie: session.cookie } });
}

function listed(app: FastifyInstance, session: Session) {
  return app.inject({ method: 'GET', url: '/v3/console/messages', headers: { cookie: session.cookie } });
}

beforeAll(async () => { fixture = await startConsoleLedgerFixture(); }, 120_000);
afterAll(async () => { try { await Promise.all(apps.splice(0).map((app) => app.close())); } finally { await fixture?.close(); } });

describe('room list and message detail share one human rule', () => {
  it('opens a console batch copy and a proactive telegram line, and keeps other people out', async () => {
    const context = current();
    const owner = await context.login(0);
    const other = await context.login(1);
    const rootId = await publishBatch(owner);
    const batchId = await copyLine(rootId, BATCH, 'batch', 'console');
    const telegramId = await copyLine(rootId, TELEGRAM, 'interactive', 'telegram', {
      adapter: 'telegram', channel: 'telegram', conversation_id: '1000000001', relay: [],
      metadata: { bridge_alias: context.actor, bridge_tenant: context.tenant, chat_type: 'private', proactive: true },
    });
    const stored = await context.pool.query<{ id: string; lane: string; auth_channel: string; proactive: boolean | null }>(
      `SELECT id,lane,auth_channel,(origin->'metadata'->>'proactive')::boolean AS proactive
       FROM messages WHERE id=ANY($1::uuid[])`, [[batchId, telegramId]]);
    expect(stored.rows).toEqual(expect.arrayContaining([
      { id: batchId, lane: 'batch', auth_channel: 'console', proactive: null },
      { id: telegramId, lane: 'interactive', auth_channel: 'telegram', proactive: true },
    ]));
    const suffix = randomBytes(4).toString('hex');
    const hiddenRoom = `other${suffix}`;
    const hiddenAlias = `zzother${suffix}`;
    await context.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [hiddenRoom, context.tenant]);
    await context.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,max_concurrent_deliveries,
      container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'claude',true,10,$3,'dev','/home/dev','/home/dev/.cauce')`,
    [context.tenant, hiddenAlias, `own-hidden-${suffix}`]);
    await context.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')`,
      [context.tenant, hiddenRoom, hiddenAlias]);
    const hidden = await withTransaction(context.pool, (client) => insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: context.tenant, roomId: hiddenRoom,
      actorAlias: hiddenAlias, body: { text: OTHER_ROOM }, origin: null, lane: 'batch', priority: 1,
      authSessionId: null, authChannel: 'console',
    }));
    const hiddenId = hidden.rows[0]?.id;
    const abroad = await withTransaction(context.pool, (client) => insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: 'Steven', roomId: 'grp.steven',
      actorAlias: 'kant', body: { text: OTHER_TENANT }, origin: null, lane: 'batch', priority: 1,
      authSessionId: null, authChannel: 'console',
    }));
    const abroadId = abroad.rows[0]?.id;
    if (!hiddenId || !abroadId) throw new Error('Hidden message was not inserted');
    const app = await gateway();
    const room = await listed(app, owner);
    expect(room.statusCode).toBe(200);
    expect(room.body).toContain(ROOT);
    expect(room.body).toContain(BATCH);
    expect(room.body).toContain(TELEGRAM);
    expect(room.body).not.toContain(OTHER_ROOM);
    expect(room.body).not.toContain(OTHER_TENANT);
    const blocked = await listed(app, other);
    expect(blocked.statusCode).toBe(200);
    expect(blocked.body).not.toContain(ROOT);
    expect(blocked.body).not.toContain(BATCH);
    expect(blocked.body).not.toContain(TELEGRAM);
    const root = await detail(app, rootId, owner);
    expect(root.statusCode).toBe(200);
    expect(object(object(root.json()).body).text).toBe(ROOT);
    for (const [id, text] of [[batchId, BATCH], [telegramId, TELEGRAM]] as const) {
      const opened = await detail(app, id, owner);
      expect(opened.statusCode).toBe(200);
      expect(object(object(opened.json()).body).text).toBe(text);
      const denied = await detail(app, id, other);
      expect(denied.statusCode).toBe(404);
      expect(denied.body).not.toContain(text);
    }
    for (const [id, text] of [[hiddenId, OTHER_ROOM], [abroadId, OTHER_TENANT]] as const) {
      const denied = await detail(app, id, owner);
      expect(denied.statusCode).toBe(404);
      expect(denied.body).not.toContain(text);
    }
  });
});
