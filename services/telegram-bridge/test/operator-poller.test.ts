import { describe, expect, it } from 'vitest';
import { TelegramPoller } from '../src/poller.js';
import type { OperatorActions } from '../src/operator-commands/dispatch.js';
import type { TelegramEntity } from '../src/types.js';
import {
  config, DeduplicatingIngress, FakeTelegram, GROUP_CHAT_ID, groupUpdate,
  MemoryCursorRepository, noopActivity, noopObserver, update
} from './bridge-fixtures.js';

function commandUpdate(updateId: number, text: string, userId = 101, entityLength = text.split(' ')[0]?.length ?? text.length) {
  const base = update(updateId, 201, userId);
  const message = base.message;
  if (!message) throw new Error('missing message');
  const entities: TelegramEntity[] = [{ type: 'bot_command', offset: 0, length: entityLength }];
  return { ...base, message: { ...message, text, entities } };
}

function actions(): OperatorActions {
  return {
    async listFleet() {
      return [{
        tenant_id: 'Steven', alias: 'zeus', work_state: 'idle', flags: [],
        in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0, claimed_not_started: 0,
        seconds_since_last_ack: 1, presence_online: true
      }];
    },
    async listQueue() { return { items: [] }; },
    async replayDelivery() { return { delivery_id: '22222222-2222-4222-8222-222222222222' }; },
    async cancelDelivery(deliveryId) { return { delivery_id: deliveryId, state: 'dead' }; },
    async nudge() { return { duplicate: false }; },
    async listStuckEgress() { return []; },
    async inspectTelegramReplay() { return { evidenceSha256: 'ab'.repeat(32), items: [] }; },
    async replayTelegramEgress() { return { state: 'prepared', replay_count: 1 }; }
  };
}

const enabled = config({
  operator_commands: true,
  operator_user_ids: ['101'],
  allowed_user_ids: ['101', '202'],
  allowed_chat_ids: ['201', String(GROUP_CHAT_ID)]
});

describe('TelegramPoller operator intercept', () => {
  it('does not publish an operator /estado; replies in the same chat and advances the cursor', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([commandUpdate(50, '/estado', 101, 7)]);
    const metrics: string[] = [];

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: enabled, botId: '900001', api, repository, ingress,
      operatorActions: actions(),
      onMetric: (metric) => { metrics.push(metric); }
    }).runOnce();

    expect(ingress.calls).toHaveLength(0);
    expect(api.sends).toHaveLength(1);
    expect(api.sends[0]?.chat).toBe('201');
    expect(api.sends[0]?.text).toContain('zeus');
    expect(api.sends[0]?.options?.reply_to_message_id).toBe('150');
    expect(repository.next).toBe(51);
    expect(metrics).toContain('operator_command_ok');
    expect(metrics).not.toContain('updates_allowed');
  });

  it('publishes the same /estado when the sender is allowlisted but not an operator', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([commandUpdate(50, '/estado', 202, 7)]);

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: enabled, botId: '900001', api, repository, ingress,
      operatorActions: actions()
    }).runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(api.sends).toHaveLength(0);
    expect(ingress.calls[0]?.body).toMatchObject({ text: '/estado' });
  });

  it('still publishes ordinary operator chat', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([update(50)]);

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: enabled, botId: '900001', api, repository, ingress,
      operatorActions: actions()
    }).runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(api.sends).toHaveLength(0);
  });

  it('does not intercept a group /estado even from the operator', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([groupUpdate(50, {
      text: '/estado',
      entities: [{ type: 'bot_command', offset: 0, length: 7 }]
    })]);
    const groupConfig = config({
      operator_commands: true,
      operator_user_ids: ['101'],
      allowed_user_ids: ['101', '202'],
      allowed_chat_ids: ['201', String(GROUP_CHAT_ID)],
      bot_username: 'kant_bot',
      chats: [{
        chat_id: String(GROUP_CHAT_ID),
        mode: 'always',
        default_alias: 'kant',
        session_scope: 'user',
        reply_to_origin: true,
        threads: []
      }]
    });

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: groupConfig, botId: '900001', api, repository, ingress,
      operatorActions: actions()
    }).runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(api.sends).toHaveLength(0);
  });

  it('without operatorActions keeps publishing, so existing pollers do not change', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([commandUpdate(50, '/estado', 101, 7)]);

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: enabled, botId: '900001', api, repository, ingress
    }).runOnce();

    expect(ingress.calls).toHaveLength(1);
  });
});
