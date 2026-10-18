import { describe, expect, it } from 'vitest';
import { StoreError } from '@cauce/store';
import { TelegramPoller } from '../src/poller.js';
import type {
  PollLease, TelegramAliasConfig, TelegramApi, TelegramCursorRepository, TelegramIngress,
  TelegramIngressMessage, TelegramRemoteFile, TelegramSendResult, TelegramUpdate
} from '../src/types.js';
import { noopActivity, noopObserver } from './bridge-fixtures.js';

const TENANT = 'Steven';
const CHAT = 201;
const USER = 101;

function update(updateId: number, text: string, date?: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 700,
      ...(date === undefined ? {} : { date }),
      from: { id: USER },
      chat: { id: CHAT, type: 'private' },
      text
    }
  };
}

function config(): TelegramAliasConfig {
  return {
    alias: 'kant',
    tenant_id: TENANT,
    room_id: 'grp.steven',
    token_file: '/synthetic/token',
    v2_shutdown_marker_file: '/synthetic/marker',
    allowed_user_ids: [String(USER)],
    allowed_chat_ids: [String(CHAT)],
    chats: [],
    recipients: [{ tenant_id: TENANT, alias: 'kant' }],
    poll_timeout_seconds: 1,
    poll_lease_ms: 60_000
  };
}

class MemoryCursorRepository implements TelegramCursorRepository {
  next = 0;
  epoch = 0;
  current: PollLease | undefined;
  readonly advances: number[] = [];
  failNextAdvance = false;

  async initializeCursor(): Promise<void> { /* noop */ }

  async acquirePollLease(botId: string, ownerId: string, leaseMs: number): Promise<PollLease> {
    this.epoch += 1;
    this.current = {
      bot_id: botId,
      owner_id: ownerId,
      epoch: this.epoch,
      lease_until: new Date(Date.now() + leaseMs)
    };
    return this.current;
  }

  async renewPollLease(lease: PollLease, leaseMs: number): Promise<PollLease> {
    this.current = { ...lease, lease_until: new Date(Date.now() + leaseMs) };
    return this.current;
  }

  async cursor(): Promise<number> { return this.next; }

  async advanceCursor(_lease: PollLease, nextUpdateId: number): Promise<void> {
    this.advances.push(nextUpdateId);
    if (this.failNextAdvance) {
      this.failNextAdvance = false;
      throw new Error('synthetic cursor failure');
    }
    this.next = Math.max(this.next, nextUpdateId);
  }
}

class ScriptedTelegram implements TelegramApi {
  readonly calls: { offset: number; timeout: number }[] = [];

  constructor(private readonly batches: readonly TelegramUpdate[][]) {}

  async getIdentity(): Promise<{ id: string }> { return { id: 'synthetic-bot' }; }

  async getUpdates(
    offset: number,
    timeout: number,
    _signal?: AbortSignal
  ): Promise<TelegramUpdate[]> {
    void _signal;
    this.calls.push({ offset, timeout });
    const batch = this.batches[Math.min(this.calls.length - 1, this.batches.length - 1)] ?? [];
    return batch.filter((entry) => entry.update_id >= offset);
  }

  async getFile(): Promise<TelegramRemoteFile> { throw new Error('no file fixture'); }
  async downloadFile(): Promise<Buffer> { throw new Error('no file fixture'); }
  async sendText(): Promise<TelegramSendResult> { return { message_id: 'synthetic-result' }; }
  async setMessageReaction(): Promise<void> { /* noop */ }
  async sendChatAction(): Promise<void> { /* noop */ }
}

class DurableRecordingIngress implements TelegramIngress {
  readonly calls: TelegramIngressMessage[] = [];
  readonly effects = new Set<string>();
  error: Error | undefined;

  async publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }> {
    this.calls.push(message);
    if (this.error !== undefined) throw this.error;
    const key = `${message.bot_id}:${String(message.update_id)}`;
    const duplicate = this.effects.has(key);
    this.effects.add(key);
    return { duplicate };
  }
}

function poller(
  api: TelegramApi,
  repository: TelegramCursorRepository,
  ingress: TelegramIngress,
  metrics: string[] = []
): TelegramPoller {
  return new TelegramPoller({
    activity: noopActivity(), observer: noopObserver(),
    config: config(),
    botId: 'synthetic-bot',
    api,
    repository,
    ingress,
    botUsername: 'kant_bot',
    onMetric: (metric) => { metrics.push(metric); }
  });
}

describe('Telegram update boundaries', () => {
  it('publishes the pieces Telegram cut from one long message as ONE message under the first piece', async () => {
    const head = 'a'.repeat(4_096);
    const tail = 'y fin';
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    const loop = poller(
      new ScriptedTelegram([[update(1, head, 100)], [update(1, head, 100), update(2, tail, 100)]]),
      repository,
      ingress
    );

    expect(await loop.runOnce()).toBe(1);
    expect(ingress.calls).toHaveLength(0);
    expect(repository.advances).toEqual([]);

    expect(await loop.runOnce()).toBe(1);
    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.update_id).toBe(1);
    expect(ingress.calls[0]?.body.text).toBe(head + tail);
    expect(ingress.calls[0]?.origin.external_message_id).toBe('701');
    expect(repository.advances).toEqual([3]);
  });

  it('does not publish or advance when polling fails', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    const api = new ScriptedTelegram([]);
    api.getUpdates = async (): Promise<TelegramUpdate[]> => { throw new Error('synthetic poll error'); };

    await expect(poller(api, repository, ingress).runOnce()).rejects.toThrow('synthetic poll error');
    expect(ingress.calls).toHaveLength(0);
    expect(repository.advances).toEqual([]);
    expect(repository.next).toBe(0);
  });

  it('does not publish when shutdown arrives during pre-publish attachment preparation', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    const pending = update(1, 'con adjunto');
    if (pending.message) {
      pending.message.document = {
        file_id: 'document-id', file_name: 'document.txt', mime_type: 'text/plain', file_size: 4
      };
    }
    const api = new ScriptedTelegram([[pending]]);
    const rendezvous = {
      entered: (): void => undefined,
      release: (): void => undefined
    };
    const entered = new Promise<void>((resolve) => { rendezvous.entered = resolve; });
    const released = new Promise<void>((resolve) => { rendezvous.release = resolve; });
    api.getFile = async (): Promise<TelegramRemoteFile> => {
      rendezvous.entered();
      await released;
      return { file_id: 'document-id', file_path: 'document.txt', file_size: 4 };
    };
    api.downloadFile = async (): Promise<Buffer> => Buffer.from('dato');
    const controller = new AbortController();
    const running = poller(api, repository, ingress).runOnce(controller.signal);

    await entered;
    controller.abort();
    rendezvous.release();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(ingress.calls).toHaveLength(0);
    expect(repository.advances).toEqual([]);
    expect(repository.next).toBe(0);
  });

  it('resolves a publish idempotency conflict by update_id instead of stalling the batch on it', async () => {
    // `idempotency_key` is `telegram:{bot_id}:{update_id}` alone, content-free: this conflict is
    // what a non-deterministic voice transcription produces on a retried update, and the store
    // proves the update_id is already durably represented the moment it raises this error.
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    ingress.error = new StoreError('conflict', 'idempotency key reused with a different request', 'idempotency_durable_conflict');
    const metrics: string[] = [];

    const count = await poller(
      new ScriptedTelegram([[update(1, 'uno'), update(2, 'dos')]]),
      repository,
      ingress,
      metrics
    ).runOnce();

    // The fence resolves by update_id for BOTH updates in the batch: neither one stalls the
    // poller waiting for a body match it can never get twice from a non-deterministic source.
    expect(count).toBe(2);
    expect(ingress.calls.map((call) => call.update_id)).toEqual([1, 2]);
    expect(repository.advances).toEqual([2, 3]);
    expect(repository.next).toBe(3);
    expect(metrics.filter((metric) => metric === 'updates_conflict')).toHaveLength(2);
  });

  it('retries publish-before-cursor safely without duplicating or losing the update', async () => {
    const api = new ScriptedTelegram([[update(1, 'persistime')]]);
    const repository = new MemoryCursorRepository();
    repository.failNextAdvance = true;
    const ingress = new DurableRecordingIngress();
    const metrics: string[] = [];
    const worker = poller(api, repository, ingress, metrics);

    await expect(worker.runOnce()).rejects.toThrow('synthetic cursor failure');
    expect(ingress.effects.size).toBe(1);
    expect(repository.next).toBe(0);

    await worker.runOnce();

    expect(ingress.calls.map((call) => call.update_id)).toEqual([1, 1]);
    expect(ingress.effects.size).toBe(1);
    expect(repository.advances).toEqual([2, 2]);
    expect(repository.next).toBe(2);
    expect(metrics).toContain('updates_allowed');
    expect(metrics).toContain('updates_duplicate');
  });
});
