import { describe, expect, it } from 'vitest';
import { OPERATOR_BOT_COMMANDS } from '../src/operator-commands/menu.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';

const COMMAND = /^[a-z][a-z0-9_]{0,31}$/;

describe('OPERATOR_BOT_COMMANDS', () => {
  it('fits the Bot API command menu contract', () => {
    expect(OPERATOR_BOT_COMMANDS.length).toBeGreaterThan(0);
    expect(OPERATOR_BOT_COMMANDS.length).toBeLessThanOrEqual(100);
    const names = OPERATOR_BOT_COMMANDS.map((entry) => entry.command);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of OPERATOR_BOT_COMMANDS) {
      expect(entry.command).toMatch(COMMAND);
      expect(entry.description.length).toBeGreaterThanOrEqual(1);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('TelegramHttpClient.setMyCommands', () => {
  it('posts the menu scoped to private chats', async () => {
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
        requests.push({
          method: url.split('/').at(-1) ?? '',
          body: JSON.parse(init.body) as Record<string, unknown>
        });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    });
    await client.setMyCommands(OPERATOR_BOT_COMMANDS, { type: 'all_private_chats' });
    expect(requests).toEqual([{
      method: 'setMyCommands',
      body: {
        commands: OPERATOR_BOT_COMMANDS,
        scope: { type: 'all_private_chats' }
      }
    }]);
  });

  it('rejects a malformed command before calling Telegram', async () => {
    let calls = 0;
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
    });
    await expect(client.setMyCommands([{ command: '/estado', description: 'no' }]))
      .rejects.toBeInstanceOf(TelegramApiError);
    await expect(client.setMyCommands([{ command: 'estado', description: '' }]))
      .rejects.toBeInstanceOf(TelegramApiError);
    expect(calls).toBe(0);
  });
});
