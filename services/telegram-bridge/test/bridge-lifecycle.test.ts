import { describe, expect, it } from 'vitest';
import { TelegramActivityIndicator } from '../src/activity.js';
import { EgressCrash, TelegramEgressWorker } from '../src/egress.js';
import { TelegramPoller } from '../src/poller.js';
import type { TelegramApi } from '../src/types.js';
import {
  config, DeduplicatingIngress, FailingActivityTelegram, FakeTelegram, MemoryCursorRepository,
  MemoryEgressRepository, relay, TENANT, update
} from './bridge-fixtures.js';

describe('Telegram poller lifecycle and recovery', () => {
  it('deduplicates repeated updates through a stable ingress key and advances the cursor', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([update(5), update(5)]);
    const activity = new TelegramActivityIndicator();
    const metrics: string[] = [];
    const poller = new TelegramPoller({
      config: config(), botId: '900001', api, repository, ingress, ownerId: 'one',
      activity,
      onMetric: (metric) => metrics.push(metric)
    });

    await poller.runOnce();
    await activity.whenIdle();

    expect(ingress.effects.size).toBe(1);
    expect(ingress.calls).toHaveLength(2);
    expect(repository.next).toBe(6);
    expect(metrics).toContain('updates_duplicate');
    expect(ingress.calls[0]?.origin).toMatchObject({
      channel: 'telegram',
      conversation_id: '201',
      external_message_id: '105',
      metadata: { bridge_alias: 'kant', bridge_tenant: TENANT }
    });
    expect(api.reactions.map((entry) => entry.reaction)).toEqual(['👀', '🤔']);
    expect(api.actions).toEqual([{ chat: '201', action: 'typing' }]);
    activity.stop();
  });

  it('resumes from the persisted cursor after restart', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    await new TelegramPoller({
      config: config(), botId: '900001', api: new FakeTelegram([update(9)]), repository, ingress, ownerId: 'first'
    }).runOnce();
    repository.expire();
    const restartedApi = new FakeTelegram([]);
    await new TelegramPoller({
      config: config(), botId: '900001', api: restartedApi, repository, ingress, ownerId: 'second'
    }).runOnce();

    expect(restartedApi.offsets).toEqual([10]);
    expect(ingress.effects.size).toBe(1);
  });

  it('does not restart visual activity for an already-published duplicate after restart', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    ingress.effects.add('900001:15');
    const api = new FakeTelegram([update(15)]);
    const activity = new TelegramActivityIndicator();

    await new TelegramPoller({
      config: config(), botId: '900001', api, repository, ingress, activity
    }).runOnce();
    await activity.whenIdle();

    expect(ingress.calls).toHaveLength(1);
    expect(repository.next).toBe(16);
    expect(api.reactions).toHaveLength(0);
    expect(api.actions).toHaveLength(0);
    activity.stop();
  });

  it('fences a competing poller for the same bot', async () => {
    const repository = new MemoryCursorRepository();
    const firstApi = new FakeTelegram([]);
    const secondApi = new FakeTelegram([update(1)]);
    const ingress = new DeduplicatingIngress();
    await new TelegramPoller({
      config: config(), botId: '900001', api: firstApi, repository, ingress, ownerId: 'first'
    }).runOnce();
    const count = await new TelegramPoller({
      config: config(), botId: '900001', api: secondApi, repository, ingress, ownerId: 'second'
    }).runOnce();

    expect(count).toBe(0);
    expect(secondApi.offsets).toEqual([]);
  });

  it('keeps publication and cursor advancement durable when every visual API call fails', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FailingActivityTelegram([update(12)]);
    const activity = new TelegramActivityIndicator({
      typingIntervalMs: 5_000,
      maxLifetimeMs: 60_000
    });

    await new TelegramPoller({
      config: config(), botId: '900001', api, repository, ingress, activity
    }).runOnce();
    await activity.whenIdle();

    expect(ingress.calls).toHaveLength(1);
    expect(repository.next).toBe(13);
    activity.stop();
  });
});

describe('Telegram egress crash recovery and replay', () => {
  it('safely retries a crash before beginEffect and produces one remote effect', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    const crashing = new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      hooks: { beforeBegin: () => { throw new EgressCrash('before_begin'); } }
    });
    await expect(crashing.runOnce()).rejects.toBeInstanceOf(EgressCrash);
    expect(api.sends).toHaveLength(0);
    expect([...repository.effects.values()][0]?.state).toBe('prepared');

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();
    expect(api.sends).toHaveLength(1);
    expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
  });

  it('marks a crash between beginEffect and sendText ambiguous on restart without a false sent ACK', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    await expect(new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      hooks: { beforeSend: () => { throw new EgressCrash('before_send'); } }
    }).runOnce()).rejects.toBeInstanceOf(EgressCrash);

    expect([...repository.effects.values()][0]?.state).toBe('sending');
    await expect(repository.ack({
      event_id: repository.event.event_id,
      attempt: repository.event.attempt,
      claim_token: repository.event.claim_token,
      status: 'sent',
      effect_count: 1
    })).rejects.toThrow('sent ACK without confirmed effects');
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    const effect = [...repository.effects.values()][0];
    expect(api.sends).toHaveLength(0);
    expect(effect).toMatchObject({ state: 'ambiguous', replay_count: 0 });
    expect(effect?.diagnostic).toContain('automatic replay is disabled');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'sent')).toBe(false);
  });

  it('leaves a crash during send ambiguous and never resends it automatically after restart', async () => {
    let calls = 0;
    const api: TelegramApi = {
      getIdentity: async () => ({ id: '900001' }),
      getUpdates: async () => [],
      getFile: async () => { throw new Error('no file fixture'); },
      downloadFile: async () => { throw new Error('no file fixture'); },
      setMessageReaction: async () => undefined,
      sendChatAction: async () => undefined,
      sendText: async () => {
        calls += 1;
        throw new EgressCrash('during_send');
      }
    };
    const repository = new MemoryEgressRepository(relay());
    await expect(new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce()).rejects.toBeInstanceOf(EgressCrash);

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(calls).toBe(1);
    expect([...repository.effects.values()][0]?.state).toBe('ambiguous');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
  });

  it('does not double send or falsely ACK sent after a crash following Telegram success', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    const crashing = new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      hooks: { afterSend: () => { throw new EgressCrash('after_send'); } }
    });
    await expect(crashing.runOnce()).rejects.toBeInstanceOf(EgressCrash);
    expect(api.sends).toHaveLength(1);

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();
    expect(api.sends).toHaveLength(1);
    expect([...repository.effects.values()][0]?.state).toBe('ambiguous');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'sent')).toBe(false);
  });

  it('ACKs sent after restart only when the crash happened after durable completion', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    await expect(new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      hooks: { afterComplete: () => { throw new EgressCrash('after_complete'); } }
    }).runOnce()).rejects.toBeInstanceOf(EgressCrash);

    expect([...repository.effects.values()][0]?.state).toBe('sent');
    expect(repository.acknowledgements).toHaveLength(0);
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(1);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent', effect_count: 1 });
  });

  it('allows only an explicit, payload-fenced manual replay of an ambiguous effect', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    await expect(new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      hooks: { beforeSend: () => { throw new EgressCrash('before_send'); } }
    }).runOnce()).rejects.toBeInstanceOf(EgressCrash);
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();
    const effect = [...repository.effects.values()][0]!;

    await expect(repository.manualReplayEffect(
      effect.chunk_index, 'wrong-hash', 'operator ticket', 'Steven', 'kant', true,
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a'.repeat(64), 0
    ))
      .rejects.toThrow('unsafe replay');
    await expect(repository.manualReplayEffect(
      effect.chunk_index, effect.payload_hash, 'operator ticket', 'Steven', 'kant', false,
      '22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b'.repeat(64), 0
    )).rejects.toThrow('unsafe replay');
    const replayed = await repository.manualReplayEffect(
      effect.chunk_index, effect.payload_hash, 'operator ticket', 'Steven', 'kant', true,
      '33333333-3333-4333-8333-333333333333',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c'.repeat(64), 0
    );
    expect(replayed).toMatchObject({ state: 'prepared', replay_count: 1 });
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(1);
    expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
  });
});
