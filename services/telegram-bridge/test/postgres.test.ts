import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '@cauce/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestDatabase,
  type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { EgressCrash, TelegramEgressWorker } from '../src/egress.js';
import { PostgresTelegramBridgeRepository } from '../src/repository.js';
import type {
  TelegramAliasConfig, TelegramApi, TelegramSendResult, TelegramUpdate
} from '../src/types.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

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
  readonly sends: Array<{ chat: string; text: string }> = [];

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }
  async getUpdates(): Promise<TelegramUpdate[]> { return []; }
  async getFile(): Promise<never> { throw new Error('no file fixture'); }
  async downloadFile(): Promise<never> { throw new Error('no file fixture'); }
  async setMessageReaction(): Promise<void> {}
  async sendChatAction(): Promise<void> {}
  async sendText(chatId: string, text: string): Promise<TelegramSendResult> {
    this.sends.push({ chat: chatId, text });
    return { message_id: String(this.sends.length) };
  }
}

async function seedRelay(pool: DatabasePool): Promise<void> {
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
  await pool.query(
    `INSERT INTO adapter_outbox(
       id,tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,origin,payload,max_attempts
     ) VALUES($1,'Steven','telegram','origin_relay',$2,$3,$4,'telegram-postgres-test',$5::jsonb,$6::jsonb,1)`,
    [EVENT_ID, `telegram-pg-${randomUUID()}`, requestId, message.rows[0]!.id,
      JSON.stringify(origin), JSON.stringify({ result: { text: 'durable reply' } })]
  );
}

describe('Telegram PostgreSQL crash recovery', () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await startTestDatabase();
    await seedRelay(database.pool);
  });

  afterAll(async () => {
    if (database) {
      await database.pool.end();
      await database.container.stop();
    }
  });

  it('persists ambiguity, dead outbox diagnosis and a fenced manual replay across restart', async () => {
    if (!database) throw new Error('PostgreSQL test database did not start');
    const api = new RecordingTelegram();
    const firstRepository = new PostgresTelegramBridgeRepository(database.pool);
    await expect(new TelegramEgressWorker({
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

    await expect(restartedRepository.manualReplayEffect(`${EVENT_ID}:0`, 'wrong-hash', 'ticket 42'))
      .rejects.toThrow('payload changed');
    const replayed = await restartedRepository.manualReplayEffect(
      `${EVENT_ID}:0`, ambiguous!.payload_hash, 'ticket 42'
    );
    expect(replayed).toMatchObject({ state: 'prepared', replay_count: 1 });

    await new TelegramEgressWorker({
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
  });
});
