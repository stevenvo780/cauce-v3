import { describe, expect, it } from 'vitest';
import { StoreError } from '@cauce/store';
import { TelegramPoller } from '../src/poller.js';
import type {
  PollLease, TelegramAliasConfig, TelegramApi, TelegramCursorRepository, TelegramIngress,
  TelegramIngressMessage, TelegramRemoteFile, TelegramSendResult, TelegramUpdate
} from '../src/types.js';

const TENANT = 'Steven';
const CHAT = 201;
const USER = 101;

function update(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 700,
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
  it('never infers that two consecutive human messages are fragments of one turn', async () => {
    const first = 'a'.repeat(4_096);
    const second = 'mensaje humano independiente';
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();

    await poller(
      new ScriptedTelegram([[update(1, first), update(2, second)]]),
      repository,
      ingress
    ).runOnce();

    expect(ingress.calls).toHaveLength(2);
    expect(ingress.calls.map((call) => call.update_id)).toEqual([1, 2]);
    expect(ingress.calls.map((call) => call.body.text)).toEqual([first, second]);
    expect(ingress.calls.map((call) => call.origin.external_message_id)).toEqual(['701', '702']);
    expect(ingress.calls.every((call) => call.body.fragments_v1 === undefined)).toBe(true);
    expect(repository.advances).toEqual([2, 3]);
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

  it('passes shutdown cancellation into the long poll without publishing or advancing', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    const api = new ScriptedTelegram([]);
    const rendezvous = { entered: (): void => undefined };
    const entered = new Promise<void>((resolve) => { rendezvous.entered = resolve; });
    api.getUpdates = async (
      _offset: number,
      _timeout: number,
      signal?: AbortSignal
    ): Promise<TelegramUpdate[]> => {
      rendezvous.entered();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('synthetic abort')); }, { once: true });
      });
    };
    const controller = new AbortController();
    const running = poller(api, repository, ingress).runOnce(controller.signal);

    await entered;
    controller.abort();

    await expect(running).rejects.toThrow('synthetic abort');
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

  it('does not advance past a publish error that is not an idempotency conflict', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    ingress.error = new Error('database offline');
    const metrics: string[] = [];

    await expect(poller(
      new ScriptedTelegram([[update(1, 'uno'), update(2, 'dos')]]),
      repository,
      ingress,
      metrics
    ).runOnce()).rejects.toThrow('database offline');

    expect(ingress.calls.map((call) => call.update_id)).toEqual([1]);
    expect(repository.advances).toEqual([]);
    expect(repository.next).toBe(0);
    expect(metrics).not.toContain('updates_conflict');
  });

  it('resolves a publish idempotency conflict by update_id instead of stalling the batch on it', async () => {
    // `idempotency_key` is `telegram:{bot_id}:{update_id}` alone, content-free: this conflict is
    // what a non-deterministic voice transcription produces on a retried update, and the store
    // proves the update_id is already durably represented the moment it raises this error.
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    ingress.error = new StoreError('conflict', 'idempotency key reused with a different request');
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

  it('fetches update 101 on the next page after a full Telegram batch of 100', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => update(index + 1, `m-${String(index + 1)}`));
    const api = new ScriptedTelegram([firstPage, [update(101, 'm-101')]]);
    const repository = new MemoryCursorRepository();
    const ingress = new DurableRecordingIngress();
    const worker = poller(api, repository, ingress);

    await worker.runOnce();
    expect(repository.next).toBe(101);
    await worker.runOnce();

    expect(api.calls.map((call) => call.offset)).toEqual([0, 101]);
    expect(ingress.calls).toHaveLength(101);
    expect(ingress.calls.at(-1)?.update_id).toBe(101);
    expect(repository.next).toBe(102);
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
