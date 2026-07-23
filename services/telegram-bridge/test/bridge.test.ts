import type { Origin } from '@cauce/protocol';
import { describe, expect, it } from 'vitest';
import { EgressCrash, TelegramEgressWorker } from '../src/egress.js';
import { TelegramPoller } from '../src/poller.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import type {
  PollLease, TelegramAliasConfig, TelegramApi, TelegramCursorRepository, TelegramEffect,
  TelegramEffectInput, TelegramEgressRepository, TelegramIngress, TelegramIngressMessage, TelegramOriginRelay,
  TelegramOriginRelayAck, TelegramSendResult, TelegramUpdate
} from '../src/types.js';

const TENANT = 'Steven';

function config(overrides: Partial<TelegramAliasConfig> = {}): TelegramAliasConfig {
  return {
    alias: 'kant',
    tenant_id: TENANT,
    room_id: 'grp.steven',
    token_file: '/synthetic/token',
    v2_shutdown_marker_file: '/synthetic/marker',
    allowed_user_ids: ['101'],
    allowed_chat_ids: ['201'],
    recipients: [{ tenant_id: TENANT, alias: 'argos' }],
    poll_timeout_seconds: 1,
    poll_lease_ms: 60_000,
    ...overrides
  };
}

function update(updateId: number, chatId = 201, userId = 101): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: userId },
      chat: { id: chatId, type: 'private' },
      text: `message-${updateId}`
    }
  };
}

class MemoryCursorRepository implements TelegramCursorRepository {
  next = 0;
  epoch = 0;
  current: PollLease | undefined;

  async initializeCursor(): Promise<void> {}

  async acquirePollLease(botId: string, ownerId: string, leaseMs: number): Promise<PollLease | undefined> {
    if (this.current && this.current.lease_until.getTime() > Date.now() && this.current.owner_id !== ownerId) return undefined;
    this.epoch += this.current?.owner_id === ownerId ? 0 : 1;
    this.current = { bot_id: botId, owner_id: ownerId, epoch: this.epoch, lease_until: new Date(Date.now() + leaseMs) };
    return this.current;
  }

  async renewPollLease(lease: PollLease, leaseMs: number): Promise<PollLease | undefined> {
    if (!this.current || this.current.owner_id !== lease.owner_id || this.current.epoch !== lease.epoch ||
        this.current.lease_until.getTime() <= Date.now()) return undefined;
    this.current = { ...lease, lease_until: new Date(Date.now() + leaseMs) };
    return this.current;
  }

  async cursor(lease: PollLease): Promise<number> {
    if (this.current?.owner_id !== lease.owner_id || this.current.epoch !== lease.epoch) throw new Error('fenced');
    return this.next;
  }

  async advanceCursor(lease: PollLease, nextUpdateId: number): Promise<void> {
    if (this.current?.owner_id !== lease.owner_id || this.current.epoch !== lease.epoch) throw new Error('fenced');
    this.next = Math.max(this.next, nextUpdateId);
  }

  expire(): void {
    if (this.current) this.current = { ...this.current, lease_until: new Date(0) };
  }
}

class FakeTelegram implements TelegramApi {
  offsets: number[] = [];
  sends: Array<{ chat: string; text: string }> = [];

  constructor(readonly updates: TelegramUpdate[] = []) {}

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    this.offsets.push(offset);
    return this.updates.filter((entry) => entry.update_id >= offset);
  }

  async sendText(chatId: string, text: string): Promise<TelegramSendResult> {
    this.sends.push({ chat: chatId, text });
    return { message_id: String(this.sends.length) };
  }
}

class DeduplicatingIngress implements TelegramIngress {
  readonly calls: TelegramIngressMessage[] = [];
  readonly effects = new Set<string>();

  async publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }> {
    this.calls.push(message);
    const key = `${message.bot_id}:${message.update_id}`;
    const duplicate = this.effects.has(key);
    this.effects.add(key);
    return { duplicate };
  }
}

function relay(overrides: Partial<TelegramOriginRelay> = {}): TelegramOriginRelay {
  const origin: Origin = {
    adapter: 'telegram',
    channel: 'telegram',
    conversation_id: '201',
    relay: [],
    metadata: { bridge_alias: 'kant' }
  };
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    max_attempts: 5,
    claim_token: '22222222-2222-4222-8222-222222222222',
    tenant_id: TENANT,
    adapter: 'telegram',
    origin,
    payload: { result: { text: 'done' } },
    ...overrides
  };
}

class MemoryEgressRepository implements TelegramEgressRepository {
  readonly effects = new Map<string, TelegramEffect>();
  readonly acknowledgements: TelegramOriginRelayAck[] = [];
  outboxState: 'pending' | 'failed' | 'sent' | 'dead' = 'pending';

  constructor(readonly event: TelegramOriginRelay) {}

  async claim(): Promise<TelegramOriginRelay[]> {
    return this.outboxState === 'pending' || this.outboxState === 'failed' ? [this.event] : [];
  }

  async ack(value: TelegramOriginRelayAck): Promise<void> {
    if (value.status === 'sent') {
      const expected = value.effect_count;
      const effects = [...this.effects.values()].filter((effect) => effect.outbox_id === value.event_id);
      if (!expected || effects.length !== expected ||
          effects.some((effect) => effect.chunk_count !== expected || effect.state !== 'sent')) {
        throw new Error('sent ACK without confirmed effects');
      }
    }
    this.acknowledgements.push(value);
    this.outboxState = value.status === 'retry' ? 'failed' : value.status;
  }

  async prepareEffect(input: TelegramEffectInput): Promise<TelegramEffect> {
    const existing = this.effects.get(input.effect_id);
    if (existing) {
      if (existing.payload_hash !== input.payload_hash || existing.chunk_count !== input.chunk_count) throw new Error('conflict');
      return existing;
    }
    const created: TelegramEffect = { ...input, state: 'prepared', replay_count: 0 };
    this.effects.set(input.effect_id, created);
    return created;
  }

  async beginEffect(effectId: string, payloadHash: string): Promise<TelegramEffect> {
    const existing = this.effects.get(effectId);
    if (!existing || existing.payload_hash !== payloadHash) throw new Error('missing');
    const next: TelegramEffect = existing.state === 'prepared' ? { ...existing, state: 'sending' } : existing;
    this.effects.set(effectId, next);
    return next;
  }

  async resetPrepared(effectId: string, payloadHash: string): Promise<void> {
    const existing = this.effects.get(effectId);
    if (!existing || existing.payload_hash !== payloadHash) throw new Error('missing');
    this.effects.set(effectId, { ...existing, state: 'prepared' });
  }

  async completeEffect(effectId: string, payloadHash: string, providerMessageId: string): Promise<void> {
    const existing = this.effects.get(effectId);
    if (!existing || existing.payload_hash !== payloadHash || existing.state !== 'sending') throw new Error('fenced');
    this.effects.set(effectId, { ...existing, state: 'sent', provider_message_id: providerMessageId });
  }

  private diagnose(
    effectId: string,
    payloadHash: string,
    state: 'ambiguous' | 'dead',
    diagnostic: string
  ): TelegramEffect {
    const existing = this.effects.get(effectId);
    if (!existing || existing.payload_hash !== payloadHash) throw new Error('missing');
    if (existing.state === 'sent') return existing;
    if (existing.state !== 'prepared' && existing.state !== 'sending' && existing.state !== state) throw new Error('fenced');
    const diagnosed: TelegramEffect = { ...existing, state, diagnostic, diagnosed_at: new Date() };
    this.effects.set(effectId, diagnosed);
    return diagnosed;
  }

  async markEffectAmbiguous(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect> {
    return this.diagnose(effectId, payloadHash, 'ambiguous', diagnostic);
  }

  async markEffectDead(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect> {
    return this.diagnose(effectId, payloadHash, 'dead', diagnostic);
  }

  async getEffect(effectId: string): Promise<TelegramEffect | undefined> {
    return this.effects.get(effectId);
  }

  async manualReplayEffect(effectId: string, payloadHash: string, reason: string): Promise<TelegramEffect> {
    const existing = this.effects.get(effectId);
    if (!existing || existing.payload_hash !== payloadHash ||
        (existing.state !== 'ambiguous' && existing.state !== 'dead') || this.outboxState !== 'dead') {
      throw new Error('unsafe replay');
    }
    const replayed: TelegramEffect = {
      ...existing,
      state: 'prepared',
      diagnostic: `Manual replay authorized: ${reason}`,
      diagnosed_at: new Date(),
      replay_count: existing.replay_count + 1,
      replayed_at: new Date()
    };
    this.effects.set(effectId, replayed);
    this.outboxState = 'failed';
    return replayed;
  }
}

describe('Telegram durable polling', () => {
  it('deduplicates repeated updates through a stable ingress key and advances the cursor', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const api = new FakeTelegram([update(5), update(5)]);
    const metrics: string[] = [];
    const poller = new TelegramPoller({
      config: config(), botId: '900001', api, repository, ingress, ownerId: 'one',
      onMetric: (metric) => metrics.push(metric)
    });

    await poller.runOnce();

    expect(ingress.effects.size).toBe(1);
    expect(ingress.calls).toHaveLength(2);
    expect(repository.next).toBe(6);
    expect(metrics).toContain('updates_duplicate');
    expect(ingress.calls[0]?.origin).toMatchObject({ channel: 'telegram', conversation_id: '201' });
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

  it('denies a wrong chat without publishing but durably consumes the update', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    await new TelegramPoller({
      config: config(), botId: '900001', api: new FakeTelegram([update(3, 999)]), repository, ingress
    }).runOnce();

    expect(ingress.calls).toHaveLength(0);
    expect(repository.next).toBe(4);
  });
});

describe('Telegram fenced egress', () => {
  it('honors fake Telegram HTTP 429 retry_after', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response(JSON.stringify({
        ok: false, error_code: 429, parameters: { retry_after: 7 }
      }), { status: 429, headers: { 'content-type': 'application/json' } })
    });
    const repository = new MemoryEgressRepository(relay());
    const worker = new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', client]]), baseRetryMs: 10
    });

    await worker.runOnce();

    expect(repository.acknowledgements).toEqual([
      expect.objectContaining({ status: 'retry', retry_after_ms: 7_000 })
    ]);
    expect([...repository.effects.values()][0]?.state).toBe('prepared');
  });

  it('marks a known non-retryable rejection dead instead of leaving it replayable', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response(JSON.stringify({ ok: false, error_code: 400 }), {
        status: 400, headers: { 'content-type': 'application/json' }
      })
    });
    const repository = new MemoryEgressRepository(relay());
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', client]])
    }).runOnce();

    expect([...repository.effects.values()][0]?.state).toBe('dead');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
  });

  it('treats an unreadable 2xx send response as remotely ambiguous, not a safe retry', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response('not-json', { status: 200 })
    });
    const repository = new MemoryEgressRepository(relay());
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', client]])
    }).runOnce();

    expect([...repository.effects.values()][0]?.state).toBe('ambiguous');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'retry')).toBe(false);
  });

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

  it('keeps a multi-chunk partial send dead unless every chunk is confirmed sent', async () => {
    let calls = 0;
    const api: TelegramApi = {
      getIdentity: async () => ({ id: '900001' }),
      getUpdates: async () => [],
      sendText: async () => {
        calls += 1;
        if (calls === 2) throw new TelegramApiError('network outcome unknown', false, undefined, false);
        return { message_id: String(calls) };
      }
    };
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect([...repository.effects.values()].map((effect) => effect.state)).toEqual(['sent', 'ambiguous']);
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'sent')).toBe(false);
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();
    expect(calls).toBe(2);
  });

  it('ACKs a multi-chunk event sent only after every chunk is durably sent', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(2);
    expect([...repository.effects.values()].map((effect) => effect.state)).toEqual(['sent', 'sent']);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent', effect_count: 2 });
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

    await expect(repository.manualReplayEffect(effect.effect_id, 'wrong-hash', 'operator ticket'))
      .rejects.toThrow('unsafe replay');
    const replayed = await repository.manualReplayEffect(effect.effect_id, effect.payload_hash, 'operator ticket');
    expect(replayed).toMatchObject({ state: 'prepared', replay_count: 1 });
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(1);
    expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
  });

  it('fails closed on a cross-tenant origin', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({ tenant_id: 'Isa' }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements[0]?.status).toBe('dead');
  });
});
