import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import {
  startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { StoreTelegramIngress } from '../src/ingress.js';
import { TelegramPoller } from '../src/poller.js';
import { PostgresTelegramBridgeRepository } from '../src/repository.js';
import type {
  PollLease, TelegramAliasConfig, TelegramApi, TelegramCursorRepository, TelegramRemoteFile,
  TelegramSendResult, TelegramUpdate
} from '../src/types.js';

let database: TestDatabase;
let pool: DatabasePool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

class OneUpdateTelegram implements TelegramApi {
  constructor(private readonly input: TelegramUpdate) {}

  async getIdentity(): Promise<{ id: string }> { return { id: 'synthetic-bot' }; }
  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.input.update_id >= offset ? [this.input] : [];
  }
  async getFile(): Promise<TelegramRemoteFile> { throw new Error('no file fixture'); }
  async downloadFile(): Promise<Buffer> { throw new Error('no file fixture'); }
  async sendText(): Promise<TelegramSendResult> { return { message_id: 'synthetic-result' }; }
  async setMessageReaction(): Promise<void> { /* noop */ }
  async sendChatAction(): Promise<void> { /* noop */ }
}

class FailFirstAdvanceRepository implements TelegramCursorRepository {
  private fail = true;

  constructor(private readonly durable: PostgresTelegramBridgeRepository) {}

  async initializeCursor(
    botId: string,
    tenantId: TelegramAliasConfig['tenant_id'],
    alias: string
  ): Promise<void> {
    await this.durable.initializeCursor(botId, tenantId, alias);
  }
  async acquirePollLease(botId: string, ownerId: string, leaseMs: number): Promise<PollLease | undefined> {
    return this.durable.acquirePollLease(botId, ownerId, leaseMs);
  }
  async renewPollLease(lease: PollLease, leaseMs: number): Promise<PollLease | undefined> {
    return this.durable.renewPollLease(lease, leaseMs);
  }
  async cursor(lease: PollLease): Promise<number> { return this.durable.cursor(lease); }
  async advanceCursor(lease: PollLease, nextUpdateId: number): Promise<void> {
    if (this.fail) {
      this.fail = false;
      throw new Error('synthetic post-publish cursor failure');
    }
    await this.durable.advanceCursor(lease, nextUpdateId);
  }
}

describe('Telegram PostgreSQL ingress boundary', () => {
  it('replays the same update after publish-before-cursor failure with one durable effect', async () => {
    const botId = `pg-${randomUUID()}`;
    const text = `telegram-pg-${randomUUID()}`;
    const config: TelegramAliasConfig = {
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
    const durableCursor = new PostgresTelegramBridgeRepository(pool);
    const cursor = new FailFirstAdvanceRepository(durableCursor);
    await cursor.initializeCursor(botId, 'Steven', 'kant');
    const metrics: string[] = [];
    const worker = new TelegramPoller({
      config,
      botId,
      api: new OneUpdateTelegram({
        update_id: 1,
        message: {
          message_id: 701,
          from: { id: 101 },
          chat: { id: 201, type: 'private' },
          text
        }
      }),
      repository: cursor,
      ingress: new StoreTelegramIngress(new CauceRepository(pool)),
      ownerId: `telegram-pg-${randomUUID()}`,
      onMetric: (metric) => { metrics.push(metric); }
    });

    await expect(worker.runOnce()).rejects.toThrow('synthetic post-publish cursor failure');
    expect((await pool.query<{ cursor: string }>(
      `SELECT next_update_id::text AS cursor FROM channel_bridge_cursors WHERE bot_id=$1`, [botId]
    )).rows[0]?.cursor).toBe('0');

    await worker.runOnce();

    const effect = (await pool.query<{
      messages: string; deliveries: string; cursor: string;
    }>(
      `SELECT
         (SELECT count(*) FROM messages message
           JOIN idempotency_keys key ON key.message_id=message.id
          WHERE key.tenant_id='Steven' AND key.actor_alias='kant'
            AND key.idempotency_key=$1)::text AS messages,
         (SELECT count(*) FROM deliveries delivery
           JOIN idempotency_keys key ON key.message_id=delivery.message_id
          WHERE key.tenant_id='Steven' AND key.actor_alias='kant'
            AND key.idempotency_key=$1)::text AS deliveries,
         (SELECT next_update_id::text FROM channel_bridge_cursors WHERE bot_id=$2) AS cursor`,
      [`telegram:${botId}:1`, botId]
    )).rows[0];

    expect(effect).toEqual({ messages: '1', deliveries: '1', cursor: '2' });
    expect(metrics).toContain('updates_allowed');
    expect(metrics).toContain('updates_duplicate');
  });
});
