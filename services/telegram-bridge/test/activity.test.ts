import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramActivityIndicator,
  type TelegramActivityTarget,
  type TelegramTerminalOutcome
} from '../src/activity.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import { TELEGRAM_ACTIVITY_REACTIONS } from '../src/types.js';
import type {
  TelegramApi, TelegramChatAction, TelegramReactionEmoji, TelegramSendResult, TelegramUpdate
} from '../src/types.js';

class RecordingTelegram implements TelegramApi {
  readonly reactions: {
    chatId: string;
    messageId: string;
    reaction: TelegramReactionEmoji;
  }[] = [];
  readonly actions: { chatId: string; action: TelegramChatAction }[] = [];

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }
  async getUpdates(): Promise<TelegramUpdate[]> { return []; }
  async getFile(): Promise<never> { throw new Error('no file fixture'); }
  async downloadFile(): Promise<never> { throw new Error('no file fixture'); }
  async sendText(): Promise<TelegramSendResult> { return { message_id: '1' }; }

  async setMessageReaction(
    chatId: string,
    messageId: string,
    reaction: TelegramReactionEmoji,
    _signal?: AbortSignal
  ): Promise<void> {
    _signal?.throwIfAborted();
    this.reactions.push({ chatId, messageId, reaction });
  }

  async sendChatAction(
    chatId: string,
    action: TelegramChatAction,
    _signal?: AbortSignal
  ): Promise<void> {
    _signal?.throwIfAborted();
    this.actions.push({ chatId, action });
  }
}

function target(api: TelegramApi, messageId = '701'): TelegramActivityTarget {
  return { alias: 'jarvis', api, chatId: '201', messageId };
}

function jsonRecord(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(value);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('expected JSON object');
  }
  return decoded as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Telegram activity indicator', () => {
  it('rejects typing renewal intervals longer than the Bot API visibility window', () => {
    expect(() => new TelegramActivityIndicator({ typingIntervalMs: 5_001 })).toThrow(
      'Telegram typing interval must be between 1 and 5000 milliseconds'
    );
  });

  it('moves through read, thinking and success while renewing and then cleaning up typing', async () => {
    vi.useFakeTimers();
    const api = new RecordingTelegram();
    const activity = new TelegramActivityIndicator({
      typingIntervalMs: 4_000,
      maxLifetimeMs: 60_000
    });
    const message = target(api);

    activity.begin(message);
    await activity.whenIdle();

    expect(api.reactions.map((entry) => entry.reaction)).toEqual(['👀', '🤔']);
    expect(api.actions).toEqual([{ chatId: '201', action: 'typing' }]);

    await vi.advanceTimersByTimeAsync(4_000);
    await activity.whenIdle();
    expect(api.actions).toHaveLength(2);

    activity.finish(message, 'done');
    await activity.whenIdle();
    expect(api.reactions.at(-1)?.reaction).toBe('👍');

    const actionCount = api.actions.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.actions).toHaveLength(actionCount);
    activity.stop();
  });

  it.each<TelegramTerminalOutcome>(['failed', 'dead'])(
    'uses failure reaction for a %s terminal relay',
    async (outcome) => {
      const api = new RecordingTelegram();
      const activity = new TelegramActivityIndicator();

      activity.finish(target(api), outcome);
      await activity.whenIdle();

      expect(api.reactions).toEqual([
        { chatId: '201', messageId: '701', reaction: '👎' }
      ]);
      activity.stop();
    }
  );

  it('absorbs reaction and typing failures without an unhandled rejection', async () => {
    const api = new RecordingTelegram();
    api.setMessageReaction = async () => { throw new Error('reaction unavailable'); };
    api.sendChatAction = async () => { throw new Error('typing unavailable'); };
    const activity = new TelegramActivityIndicator({
      typingIntervalMs: 5_000,
      maxLifetimeMs: 60_000
    });
    const message = target(api);

    expect(() => { activity.begin(message); }).not.toThrow();
    await activity.whenIdle();
    expect(() => { activity.finish(message, 'done'); }).not.toThrow();
    await activity.whenIdle();
    activity.stop();
  });

  it('aborts an in-flight typing request and all renewals on stop', async () => {
    vi.useFakeTimers();
    const api = new RecordingTelegram();
    let actionAborted = false;
    api.sendChatAction = async (_chatId, _action, signal) => new Promise<void>((resolve) => {
      const aborted = (): void => {
        actionAborted = true;
        resolve();
      };
      if (signal?.aborted) aborted();
      else signal?.addEventListener('abort', aborted, { once: true });
    });
    const activity = new TelegramActivityIndicator({
      typingIntervalMs: 4_000,
      maxLifetimeMs: 60_000
    });

    activity.begin(target(api));
    await Promise.resolve();
    await Promise.resolve();
    activity.stop();
    await activity.whenIdle();

    expect(actionAborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.actions).toHaveLength(0);
  });

  it('keeps a terminal tombstone so finish-before-begin cannot restart thinking', async () => {
    vi.useFakeTimers();
    const api = new RecordingTelegram();
    const activity = new TelegramActivityIndicator({
      typingIntervalMs: 4_000,
      maxLifetimeMs: 60_000,
      terminalTombstoneMs: 60_000
    });
    const message = target(api);

    activity.finish(message, 'done');
    await activity.whenIdle();
    activity.begin(message);
    await activity.whenIdle();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(api.reactions).toEqual([
      { chatId: '201', messageId: '701', reaction: '👍' }
    ]);
    expect(api.actions).toHaveLength(0);
    activity.stop();
  });

  it('allows a terminal correction after manual replay without reopening thinking', async () => {
    const api = new RecordingTelegram();
    const activity = new TelegramActivityIndicator();
    const message = target(api);

    activity.finish(message, 'dead');
    await activity.whenIdle();
    activity.finish(message, 'done');
    await activity.whenIdle();
    activity.begin(message);
    await activity.whenIdle();

    expect(api.reactions.map((entry) => entry.reaction)).toEqual(['👎', '👍']);
    expect(api.actions).toHaveLength(0);
    activity.stop();
  });

  it('serializes concurrent terminal corrections through the tombstone reaction tail', async () => {
    const api = new RecordingTelegram();
    const originalReaction = api.setMessageReaction.bind(api);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    api.setMessageReaction = async (chatId, messageId, reaction, signal) => {
      calls += 1;
      if (calls === 1) await firstGate;
      await originalReaction(chatId, messageId, reaction, signal);
    };
    const activity = new TelegramActivityIndicator();
    const message = target(api);

    activity.finish(message, 'dead');
    activity.finish(message, 'done');
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(api.reactions).toHaveLength(0);

    releaseFirst();
    await activity.whenIdle();
    activity.begin(message);
    await activity.whenIdle();

    expect(api.reactions.map((entry) => entry.reaction)).toEqual(['👎', '👍']);
    expect(api.actions).toHaveLength(0);
    activity.stop();
  });

  it('shares one typing ticker per alias and chat until the final active message finishes', async () => {
    vi.useFakeTimers();
    const api = new RecordingTelegram();
    const activity = new TelegramActivityIndicator({
      typingIntervalMs: 4_000,
      maxLifetimeMs: 60_000
    });
    const first = target(api, '701');
    const second = target(api, '702');

    activity.begin(first);
    activity.begin(second);
    await activity.whenIdle();
    expect(api.actions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await activity.whenIdle();
    expect(api.actions).toHaveLength(2);

    activity.finish(first, 'done');
    await activity.whenIdle();
    expect(api.actions).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4_000);
    await activity.whenIdle();
    expect(api.actions).toHaveLength(4);

    activity.finish(second, 'failed');
    await activity.whenIdle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.actions).toHaveLength(4);
    activity.stop();
  });
});

describe('Telegram Bot API activity calls', () => {
  it('sends exactly one emoji reaction and a typing action with validated numeric IDs', async () => {
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url;
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      requests.push({
        method: url.split('/').at(-1) ?? '',
        body: jsonRecord(init.body)
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher
    });

    for (const reaction of TELEGRAM_ACTIVITY_REACTIONS) {
      await client.setMessageReaction('-100201', '701', reaction);
    }
    await client.sendChatAction('-100201', 'typing');

    expect(requests).toEqual([
      ...TELEGRAM_ACTIVITY_REACTIONS.map((reaction) => ({
        method: 'setMessageReaction',
        body: {
          chat_id: '-100201',
          message_id: 701,
          reaction: [{ type: 'emoji', emoji: reaction }],
          is_big: false
        }
      })),
      {
        method: 'sendChatAction',
        body: { chat_id: '-100201', action: 'typing' }
      }
    ]);
  });

  it('rejects malformed chat and message IDs before making a request', async () => {
    let calls = 0;
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
    });

    await expect(client.setMessageReaction('chat-name', '701', '👀'))
      .rejects.toBeInstanceOf(TelegramApiError);
    await expect(client.setMessageReaction('201', '0', '👀'))
      .rejects.toBeInstanceOf(TelegramApiError);
    await expect(client.setMessageReaction('201', '9007199254740992', '👀'))
      .rejects.toBeInstanceOf(TelegramApiError);
    await expect(client.sendChatAction('99999999999999999999', 'typing'))
      .rejects.toBeInstanceOf(TelegramApiError);
    await expect(client.sendChatAction('0', 'typing'))
      .rejects.toBeInstanceOf(TelegramApiError);
    expect(calls).toBe(0);
  });
});
