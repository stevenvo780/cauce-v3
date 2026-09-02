import type { Origin, Tenant } from '@cauce/protocol';
import type { TelegramActivity } from '../src/activity.js';
import type { TelegramLoopObserver } from '../src/progress.js';
import { TelegramApiError } from '../src/telegram.js';
import type {
  PollLease, TelegramAliasConfig, TelegramApi, TelegramCursorRepository, TelegramEffect,
  TelegramEffectInput, TelegramEgressRepository, TelegramEntity, TelegramIngress, TelegramIngressMessage,
  TelegramOriginRelay, TelegramOriginRelayAck, TelegramRemoteFile, TelegramSendOptions, TelegramSendResult,
  TelegramUpdate
} from '../src/types.js';

export const TENANT = 'Steven';

export function noopActivity(): TelegramActivity {
  return { begin: () => undefined, finish: () => undefined, stop: () => undefined };
}

export function noopObserver(): TelegramLoopObserver {
  return {
    pollCycleStarted: () => undefined,
    pollCycleHeartbeat: () => undefined,
    pollCycleFenced: () => undefined,
    pollCycleSucceeded: () => undefined,
    pollCycleFailed: () => undefined,
    egressCycleStarted: () => undefined,
    egressCycleHeartbeat: () => undefined,
    egressCycleFenced: () => undefined,
    egressCycleSucceeded: () => undefined,
    egressCycleFailed: () => undefined
  };
}

export function config(overrides: Partial<TelegramAliasConfig> = {}): TelegramAliasConfig {
  return {
    alias: 'kant',
    tenant_id: TENANT,
    room_id: 'grp.steven',
    token_file: '/synthetic/token',
    v2_shutdown_marker_file: '/synthetic/marker',
    allowed_user_ids: ['101'],
    allowed_chat_ids: ['201'],
    chats: [],
    recipients: [{ tenant_id: TENANT, alias: 'kant' }],
    poll_timeout_seconds: 1,
    poll_lease_ms: 60_000,
    ...overrides
  };
}

/**
 * `chats` ABSENT (not `[]`) is `config.ts groupRouting()`'s legacy escape hatch, but
 * `exactOptionalPropertyTypes` rejects assigning `chats: undefined` through `config()`'s
 * `Partial<TelegramAliasConfig>` overrides — the key must be omitted from the object literal
 * entirely, which is what this variant of `config()`'s defaults does.
 */
export function legacyGroupConfig(overrides: Partial<Omit<TelegramAliasConfig, 'chats'>> = {}): TelegramAliasConfig {
  return {
    alias: 'kant',
    tenant_id: TENANT,
    room_id: 'grp.steven',
    token_file: '/synthetic/token',
    v2_shutdown_marker_file: '/synthetic/marker',
    allowed_user_ids: ['101'],
    allowed_chat_ids: ['201'],
    recipients: [{ tenant_id: TENANT, alias: 'kant' }],
    poll_timeout_seconds: 1,
    poll_lease_ms: 60_000,
    ...overrides
  };
}

export function update(updateId: number, chatId = 201, userId = 101): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: userId },
      chat: { id: chatId, type: 'private' },
      text: `message-${String(updateId)}`
    }
  };
}

export const GROUP_CHAT_ID = -5001;

export function groupUpdate(updateId: number, overrides: {
  chatId?: number; userId?: number; text?: string; entities?: TelegramEntity[];
  firstName?: string; username?: string;
} = {}): TelegramUpdate {
  const { chatId = GROUP_CHAT_ID, userId = 101, text = `message-${String(updateId)}`, entities, firstName, username } = overrides;
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: userId, ...(firstName === undefined ? {} : { first_name: firstName }), ...(username === undefined ? {} : { username }) },
      chat: { id: chatId, type: 'supergroup' },
      text,
      ...(entities === undefined ? {} : { entities })
    }
  };
}

export class MemoryCursorRepository implements TelegramCursorRepository {
  next = 0;
  epoch = 0;
  current: PollLease | undefined;

  async initializeCursor(): Promise<void> { /* noop */ }

  async acquirePollLease(botId: string, ownerId: string, leaseMs: number): Promise<PollLease | undefined> {
    if (this.current && this.current.lease_until.getTime() > Date.now() && this.current.owner_id !== ownerId) return undefined;
    this.epoch += this.current?.owner_id === ownerId ? 0 : 1;
    this.current = { bot_id: botId, owner_id: ownerId, epoch: this.epoch, lease_until: new Date(Date.now() + leaseMs) };
    return this.current;
  }

  async renewPollLease(lease: PollLease, leaseMs: number): Promise<PollLease | undefined> {
    if (this.current?.owner_id !== lease.owner_id || this.current.epoch !== lease.epoch ||
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

export class FakeTelegram implements TelegramApi {
  offsets: number[] = [];
  sends: { chat: string; text: string; options?: TelegramSendOptions; arity: number }[] = [];
  reactions: { chat: string; message: string; reaction: string }[] = [];
  actions: { chat: string; action: string }[] = [];
  files = new Map<string, TelegramRemoteFile>();
  filePayloads = new Map<string, Buffer>();

  constructor(readonly updates: TelegramUpdate[] = []) {}

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    this.offsets.push(offset);
    return this.updates.filter((entry) => entry.update_id >= offset);
  }

  async getFile(fileId: string): Promise<TelegramRemoteFile> {
    const file = this.files.get(fileId);
    if (!file) throw new Error('no file fixture');
    return file;
  }
  async downloadFile(path: string): Promise<Buffer> {
    const payload = this.filePayloads.get(path);
    if (!payload) throw new Error('no file fixture');
    return payload;
  }

  async sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<TelegramSendResult> {
    // `arity` records how many arguments the worker actually passed, so the "old relays produce a
    // byte-identical two-argument call" guarantee is observable and not merely asserted.
    this.sends.push({
      chat: chatId, text, ...(options === undefined ? {} : { options }),
      arity: options === undefined ? 2 : 3
    });
    return { message_id: String(this.sends.length) };
  }

  async setMessageReaction(chatId: string, messageId: string, reaction: '👀' | '🤔' | '👍' | '👎'): Promise<void> {
    this.reactions.push({ chat: chatId, message: messageId, reaction });
  }

  async sendChatAction(chatId: string, action: 'typing'): Promise<void> {
    this.actions.push({ chat: chatId, action });
  }
}

export class FailingActivityTelegram extends FakeTelegram {
  override async setMessageReaction(): Promise<void> {
    throw new Error('reaction unavailable');
  }

  override async sendChatAction(): Promise<void> {
    throw new Error('typing unavailable');
  }
}

export class RejectingSendTelegram extends FakeTelegram {
  override async sendText(): Promise<TelegramSendResult> {
    throw new TelegramApiError('message rejected', false, undefined, true);
  }
}

export class DeduplicatingIngress implements TelegramIngress {
  readonly calls: TelegramIngressMessage[] = [];
  readonly effects = new Set<string>();

  async publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }> {
    this.calls.push(message);
    const key = `${message.bot_id}:${String(message.update_id)}`;
    const duplicate = this.effects.has(key);
    this.effects.add(key);
    return { duplicate };
  }
}

export function relay(overrides: Partial<TelegramOriginRelay> = {}): TelegramOriginRelay {
  const origin: Origin = {
    adapter: 'telegram',
    channel: 'telegram',
    conversation_id: '201',
    external_message_id: '301',
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

export class MemoryEgressRepository implements TelegramEgressRepository {
  readonly effects = new Map<string, TelegramEffect>();
  readonly acknowledgements: TelegramOriginRelayAck[] = [];
  readonly claimLimits: number[] = [];
  renewCalls = 0;
  renewAllowed = true;
  failAck = false;
  outboxState: 'pending' | 'failed' | 'sent' | 'dead' = 'pending';

  constructor(readonly event: TelegramOriginRelay) {}

  async claim(_workerId?: string, limit = 1): Promise<TelegramOriginRelay[]> {
    this.claimLimits.push(limit);
    return this.outboxState === 'pending' || this.outboxState === 'failed' ? [this.event] : [];
  }

  async renew(): Promise<boolean> {
    this.renewCalls += 1;
    return this.renewAllowed;
  }

  async ack(value: TelegramOriginRelayAck): Promise<void> {
    if (this.failAck) throw new Error('fenced durable ACK');
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
    if (existing?.payload_hash !== payloadHash) throw new Error('missing');
    const next: TelegramEffect = existing.state === 'prepared' ? { ...existing, state: 'sending' } : existing;
    this.effects.set(effectId, next);
    return next;
  }

  async resetPrepared(effectId: string, payloadHash: string): Promise<void> {
    const existing = this.effects.get(effectId);
    if (existing?.payload_hash !== payloadHash) throw new Error('missing');
    this.effects.set(effectId, { ...existing, state: 'prepared' });
  }

  async completeEffect(effectId: string, payloadHash: string, providerMessageId: string): Promise<void> {
    const existing = this.effects.get(effectId);
    if (existing?.payload_hash !== payloadHash || existing.state !== 'sending') throw new Error('fenced');
    this.effects.set(effectId, { ...existing, state: 'sent', provider_message_id: providerMessageId });
  }

  private diagnose(
    effectId: string,
    payloadHash: string,
    state: 'ambiguous' | 'dead',
    diagnostic: string
  ): TelegramEffect {
    const existing = this.effects.get(effectId);
    if (existing?.payload_hash !== payloadHash) throw new Error('missing');
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

  async manualReplayEffect(
    chunkIndex: number,
    payloadHash: string,
    reason: string,
    _actorTenant: Tenant,
    _actorAlias: string,
    duplicateRiskAcknowledged: boolean,
    _requestId: string,
    _deadLetterId: string,
    _incidentEvidenceSha256: string,
    _expectedReplayCount: number
  ): Promise<TelegramEffect> {
    void _requestId;
    void _deadLetterId;
    void _incidentEvidenceSha256;
    void _expectedReplayCount;
    const existing = [...this.effects.values()].find((candidate) =>
      candidate.chunk_index === chunkIndex && candidate.payload_hash === payloadHash);
    if (!duplicateRiskAcknowledged || existing?.payload_hash !== payloadHash ||
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
    this.effects.set(existing.effect_id, replayed);
    this.outboxState = 'failed';
    return replayed;
  }
}

export function groupRelay(overrides: Partial<TelegramOriginRelay> = {}): TelegramOriginRelay {
  return relay({
    origin: {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: String(GROUP_CHAT_ID),
      external_message_id: '301',
      relay: [],
      metadata: { bridge_alias: 'kant' }
    },
    ...overrides
  });
}

export function proactiveRelay(overrides: Partial<Origin> = {}): TelegramOriginRelay {
  const origin: Origin = {
    adapter: 'telegram',
    channel: 'telegram',
    conversation_id: '201',
    relay: [],
    metadata: { bridge_alias: 'kant', bridge_tenant: TENANT, chat_type: 'group', proactive: true },
    ...overrides
  };
  return relay({
    origin,
    payload: {
      relay_kind: 'notify',
      terminal: true,
      outcome: 'done',
      kind: 'task_complete',
      result: {
        output: {
          reply: 'terminé la tarea larga',
          messages: [],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      },
      correlation: {
        request_id: '33333333-3333-4333-8333-333333333333',
        message_id: '44444444-4444-4444-8444-444444444444',
        trace_id: 'trace-notify',
        root_message_id: '44444444-4444-4444-8444-444444444444'
      }
    }
  });
}
