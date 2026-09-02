import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '@cauce/store';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dockerTestRequirement,
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { EgressCrash, TelegramEgressWorker } from '../src/egress.js';
import { PostgresTelegramBridgeRepository } from '../src/repository.js';
import type {
  TelegramAliasConfig, TelegramApi, TelegramSendResult, TelegramUpdate
} from '../src/types.js';
import { noopActivity, noopObserver } from './bridge-fixtures.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const postgresRequirement = dockerTestRequirement(
  'PostgreSQL Telegram egress ambiguity, dead-letter, manual replay fencing and reconciliation contracts',
);
const testDatabaseNeedsDocker = !process.env.CAUCE_TEST_DATABASE_URL;

const alias: TelegramAliasConfig = {
  alias: 'kant',
  tenant_id: 'Steven',
  room_id: 'grp.steven',
  token_file: '/synthetic/token',
  v2_shutdown_marker_file: '/synthetic/marker',
  allowed_user_ids: ['101'],
  allowed_chat_ids: ['201'],
  chats: [],
  recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
  poll_timeout_seconds: 1,
  poll_lease_ms: 60_000
};

class RecordingTelegram implements TelegramApi {
  readonly sends: { chat: string; text: string }[] = [];

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }
  async getUpdates(): Promise<TelegramUpdate[]> { return []; }
  async getFile(): Promise<never> { throw new Error('no file fixture'); }
  async downloadFile(): Promise<never> { throw new Error('no file fixture'); }
  async setMessageReaction(): Promise<void> { /* noop */ }
  async sendChatAction(): Promise<void> { /* noop */ }
  async sendText(chatId: string, text: string): Promise<TelegramSendResult> {
    this.sends.push({ chat: chatId, text });
    return { message_id: String(this.sends.length) };
  }
}

async function seedRelay(pool: DatabasePool, eventId = EVENT_ID): Promise<void> {
  const room = `telegram-pg-${randomUUID()}`;
  const requestId = randomUUID();
  const message = await pool.query<{ id: string }>(
    `WITH inserted_room AS (
       INSERT INTO rooms(id,tenant_id) VALUES($1,'Steven') RETURNING id
     ), inserted_member AS (
       INSERT INTO memberships(tenant_id,room_id,alias,role)
       VALUES('Steven',$1,'kant','adapter') RETURNING alias
     )
     INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES($2,'telegram-postgres-test','Steven',$1,'kant','{}'::jsonb,'interactive')
     RETURNING id`,
    [room, requestId]
  );
  const origin = {
    adapter: 'telegram',
    channel: 'telegram',
    conversation_id: '201',
    relay: [],
    metadata: { bridge_alias: 'kant' }
  };
  const messageRow = message.rows[0];
  if (!messageRow) throw new Error('Message row not found');
  await pool.query(
    `INSERT INTO adapter_outbox(
       id,tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,origin,payload,max_attempts
     ) VALUES($1,'Steven','telegram','origin_relay',$2,$3,$4,'telegram-postgres-test',$5::jsonb,$6::jsonb,1)`,
    [eventId, `telegram-pg-${randomUUID()}`, requestId, messageRow.id,
      JSON.stringify(origin), JSON.stringify({ result: { text: 'durable reply' } })]
  );
}

describe('Telegram PostgreSQL crash recovery', () => {
  let database: TestDatabase | undefined;

  beforeEach(async ({ skip }) => {
    if (testDatabaseNeedsDocker) await postgresRequirement.skipIfUnavailable(skip);
    database ??= await startTestDatabase();
    await resetTestDatabase(database.pool);
  }, 180_000);

  afterAll(async () => {
    if (database !== undefined) {
      try {
        await database.pool.end();
      } finally {
        await database.container.stop();
      }
    }
  });

  it('persists ambiguity, dead outbox diagnosis and a fenced manual replay across restart', async () => {
    if (!database) throw new Error('PostgreSQL test database did not start');
    await seedRelay(database.pool);
    const api = new RecordingTelegram();
    const firstRepository = new PostgresTelegramBridgeRepository(database.pool);
    await expect(new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository: firstRepository,
      aliases: [alias],
      apis: new Map([['kant', api]]),
      leaseMs: 1_000,
      hooks: { beforeSend: () => { throw new EgressCrash('before_send'); } }
    }).runOnce()).rejects.toBeInstanceOf(EgressCrash);

    expect(api.sends).toHaveLength(0);
    expect((await firstRepository.getEffect(`${EVENT_ID}:0`))?.state).toBe('sending');
    await database.pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, [EVENT_ID]
    );

    const restartedRepository = new PostgresTelegramBridgeRepository(database.pool);
    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository: restartedRepository,
      aliases: [alias],
      apis: new Map([['kant', api]])
    }).runOnce(); // final expired attempt is dead-lettered and reconciled without being reclaimed

    const ambiguous = await restartedRepository.getEffect(`${EVENT_ID}:0`);
    expect(ambiguous).toMatchObject({ state: 'ambiguous', chunk_count: 1, replay_count: 0 });
    expect(ambiguous?.diagnostic).toContain('automatic replay is disabled');
    const dead = await database.pool.query<{ status: string; last_error: string }>(
      `SELECT status,last_error FROM adapter_outbox WHERE id=$1`, [EVENT_ID]
    );
    expect(dead.rows[0]).toMatchObject({ status: 'dead' });
    expect(dead.rows[0]?.last_error).toContain('automatic replay is disabled');
    expect(api.sends).toHaveLength(0);
    const incidentRows = (await database.pool.query<{ id: string; evidence_sha256: string }>(
      `SELECT id,evidence_sha256 FROM outbox_dead_letters WHERE outbox_id=$1`, [EVENT_ID],
    )).rows;
    const incident = incidentRows[0];
    if (!incident) throw new Error('Incident not found');

    await expect(restartedRepository.manualReplayEffect(
      0, 'b'.repeat(64), 'ticket 42', 'Steven', 'kant', true, randomUUID(),
      incident.id, incident.evidence_sha256, 0
    ))
      .rejects.toThrow('exactly one current effect');
    if (!ambiguous) throw new Error('Ambiguous effect not found');
    const replayed = await restartedRepository.manualReplayEffect(
      0, ambiguous.payload_hash, 'ticket 42', 'Steven', 'kant', true, randomUUID(),
      incident.id, incident.evidence_sha256, 0
    );
    expect(replayed).toMatchObject({ state: 'prepared', replay_count: 1 });
    const preservedIncident = await database.pool.query<{
      resolved_at: Date | null; resolution_rule: string; disposition: string;
    }>(
      `SELECT resolved_at,resolution_rule,disposition
       FROM outbox_dead_letters WHERE outbox_id=$1`,
      [EVENT_ID]
    );
    expect(preservedIncident.rows[0]).toMatchObject({
      resolution_rule: 'telegram_manual_replay_v1',
      disposition: 'safe_retry'
    });
    expect(preservedIncident.rows[0]?.resolved_at).toBeInstanceOf(Date);
    expect((await database.pool.query(
      `SELECT 1 FROM telegram_manual_replays WHERE effect_id=$1`, [`${EVENT_ID}:0`]
    )).rowCount).toBe(1);

    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository: restartedRepository,
      aliases: [alias],
      apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(1);
    expect(await restartedRepository.getEffect(`${EVENT_ID}:0`)).toMatchObject({
      state: 'sent', replay_count: 1, provider_message_id: '1'
    });
    const sent = await database.pool.query<{ status: string }>(
      `SELECT status FROM adapter_outbox WHERE id=$1`, [EVENT_ID]
    );
    expect(sent.rows[0]?.status).toBe('sent');
    expect((await database.pool.query(
      `SELECT 1 FROM outbox_dead_letters WHERE outbox_id=$1`, [EVENT_ID]
    )).rowCount).toBe(1);
  });

  it('reconciles an expired final lease only when every remote effect is durably sent', async () => {
    if (!database) throw new Error('PostgreSQL test database did not start');
    const eventId = '22222222-2222-4222-8222-222222222222';
    await seedRelay(database.pool, eventId);
    const repository = new PostgresTelegramBridgeRepository(database.pool);
    const [event] = await repository.claim('proof-worker', 1, 1_000);
    expect(event?.event_id).toBe(eventId);
    const payloadHash = 'a'.repeat(64);
    await repository.prepareEffect({
      effect_id: `${eventId}:0`, outbox_id: eventId, tenant_id: 'Steven', bridge_alias: 'kant',
      chunk_index: 0, chunk_count: 1, payload_hash: payloadHash
    });
    await repository.beginEffect(`${eventId}:0`, payloadHash);
    await repository.completeEffect(`${eventId}:0`, payloadHash, 'remote-proof');
    await database.pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, [eventId]
    );

    const restarted = new PostgresTelegramBridgeRepository(database.pool);
    expect(await restarted.claim('reconciler', 1, 1_000)).toEqual([]);
    const outbox = await database.pool.query<{ status: string; last_error: string | null }>(
      `SELECT status,last_error FROM adapter_outbox WHERE id=$1`, [eventId]
    );
    const letter = await database.pool.query<{ resolved_at: Date | null }>(
      `SELECT resolved_at FROM outbox_dead_letters WHERE outbox_id=$1`, [eventId]
    );
    expect(outbox.rows[0]).toEqual({ status: 'sent', last_error: null });
    expect(letter.rows[0]?.resolved_at).toBeInstanceOf(Date);
  });
});
