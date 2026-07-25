import { createHash, randomUUID } from 'node:crypto';
import type { TelegramActivity, TelegramActivityTarget, TelegramTerminalOutcome } from './activity.js';
import type {
  BridgeMetric, TelegramAliasConfig, TelegramApi, TelegramEgressRepository,
  TelegramEffect, TelegramOriginRelay, TelegramOriginRelayAck
} from './types.js';
import { TelegramApiError } from './telegram.js';

export class EgressCrash extends Error {
  constructor(readonly point: 'before_begin' | 'before_send' | 'during_send' | 'after_send' | 'after_complete') {
    super(`simulated egress crash at ${point}`);
    this.name = 'EgressCrash';
  }
}

export interface TelegramEgressHooks {
  beforeBegin?: (effectId: string) => void | Promise<void>;
  /** Runs after the durable sending transition and immediately before sendText. */
  beforeSend?: (effectId: string) => void | Promise<void>;
  afterSend?: (effectId: string) => void | Promise<void>;
  afterComplete?: (effectId: string) => void | Promise<void>;
}

export interface TelegramEgressWorkerOptions {
  repository: TelegramEgressRepository;
  aliases: readonly TelegramAliasConfig[];
  apis: ReadonlyMap<string, TelegramApi>;
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  hooks?: TelegramEgressHooks;
  activity?: TelegramActivity;
  onMetric?: (metric: BridgeMetric) => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

const VISIBLE_TEXT = /[\p{L}\p{N}\p{P}\p{S}]/u;

function hasVisibleText(value: unknown): value is string {
  return typeof value === 'string' && VISIBLE_TEXT.test(value);
}

function candidate(payload: Record<string, unknown>): string | undefined {
  const result = object(payload.result);
  const output = object(result?.output);
  const values = [
    output?.reply, result?.reply,
    result?.text, result?.content, result?.message,
    payload.text, payload.content, payload.message,
    typeof payload.error === 'string' ? `Error: ${payload.error}` : undefined
  ];
  return values.find(hasVisibleText);
}

export function telegramTextChunks(payload: Record<string, unknown>): string[] {
  if (isMissingFinalReply(payload)) return [];
  const value = candidate(payload);
  if (value === undefined) return [];
  const source = value.split('\u0000').join('').trim();
  const characters = [...source].slice(0, 65_536);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 4_096) {
    chunks.push(characters.slice(index, index + 4_096).join(''));
  }
  return chunks;
}

function isInterimAcknowledgement(payload: Record<string, unknown>): boolean {
  return payload.relay_kind === 'ack' && payload.terminal === false;
}

function isMissingFinalReply(payload: Record<string, unknown>): boolean {
  return payload.error_code === 'MISSING_FINAL_REPLY';
}

function aliasFrom(event: TelegramOriginRelay): string | undefined {
  const value = event.origin.metadata.bridge_alias;
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

function relayOutcome(payload: Record<string, unknown>): TelegramTerminalOutcome {
  if (payload.outcome === 'failed' || payload.outcome === 'dead') return payload.outcome;
  if (payload.outcome === 'done') return 'done';
  return typeof payload.error === 'string' && payload.error.length > 0 ? 'failed' : 'done';
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Telegram egress failed';
  return value.replace(/[\r\n\t]/g, ' ').replace(/[0-9]{5,}/g, '<id>').slice(0, 500);
}

const RESTART_AMBIGUOUS =
  'Interrupted while a Telegram request may have been in flight; automatic replay is disabled';

function blockedDiagnostic(effect: TelegramEffect): string {
  return effect.diagnostic ?? (effect.state === 'dead'
    ? 'Telegram effect is dead; manual replay is required'
    : RESTART_AMBIGUOUS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class TelegramEgressWorker {
  private readonly repository: TelegramEgressRepository;
  private readonly aliases: ReadonlyMap<string, TelegramAliasConfig>;
  private readonly apis: ReadonlyMap<string, TelegramApi>;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly hooks: TelegramEgressHooks;
  private readonly activity: TelegramActivity | undefined;
  private readonly onMetric: (metric: BridgeMetric) => void;

  constructor(options: TelegramEgressWorkerOptions) {
    this.repository = options.repository;
    this.aliases = new Map(options.aliases.map((entry) => [entry.alias, entry]));
    this.apis = options.apis;
    this.workerId = options.workerId ?? `telegram-egress:${randomUUID()}`;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.baseRetryMs = options.baseRetryMs ?? 500;
    this.hooks = options.hooks ?? {};
    this.activity = options.activity;
    this.onMetric = options.onMetric ?? (() => undefined);
  }

  private acknowledgement(
    event: TelegramOriginRelay,
    values: Omit<TelegramOriginRelayAck, 'event_id' | 'attempt' | 'claim_token'>
  ): TelegramOriginRelayAck {
    return { event_id: event.event_id, attempt: event.attempt, claim_token: event.claim_token, ...values };
  }

  private finishActivity(
    event: TelegramOriginRelay,
    bridgeAlias: string,
    api: TelegramApi,
    outcome: TelegramTerminalOutcome
  ): void {
    const messageId = event.origin.external_message_id;
    if (typeof messageId !== 'string') return;
    const target: TelegramActivityTarget = {
      alias: bridgeAlias,
      api,
      chatId: event.origin.conversation_id,
      messageId
    };
    try {
      this.activity?.finish(target, outcome);
    } catch {
      // Reactions are best-effort and must never change a durable relay ACK.
    }
  }

  private async process(event: TelegramOriginRelay): Promise<void> {
    const bridgeAlias = aliasFrom(event);
    const config = bridgeAlias ? this.aliases.get(bridgeAlias) : undefined;
    const api = bridgeAlias ? this.apis.get(bridgeAlias) : undefined;
    const chatId = event.origin.conversation_id;
    const interimAcknowledgement = isInterimAcknowledgement(event.payload);
    // A proactive relay does not answer an inbound message. If one ever claimed
    // to, finishActivity would place a reaction on an arbitrary message id of
    // that chat. allowed_chat_ids remains the independent second key: a
    // destination approved in the database still cannot reach a chat this bridge
    // was not configured for.
    const forgedProactiveReply = event.payload.relay_kind === 'notify'
      && event.origin.external_message_id !== undefined;
    if (!bridgeAlias || !config || !api || config.tenant_id !== event.tenant_id || event.origin.channel !== 'telegram' ||
        !config.allowed_chat_ids.includes(chatId) || forgedProactiveReply) {
      await this.repository.ack(this.acknowledgement(event, {
        status: 'dead', error: 'Telegram origin is not authorized for this tenant and alias'
      }));
      this.onMetric('egress_dead');
      return;
    }

    try {
      const chunks = telegramTextChunks(event.payload);
      if (chunks.length === 0 || (!interimAcknowledgement && isMissingFinalReply(event.payload))) {
        const diagnostic = 'Telegram relay has no visible final reply; no message was sent';
        await this.repository.ack(this.acknowledgement(event, { status: 'dead', error: diagnostic }));
        if (!interimAcknowledgement) this.finishActivity(event, bridgeAlias, api, 'failed');
        this.onMetric('egress_dead');
        return;
      }
      let blocked: string | undefined;
      for (const [index, text] of chunks.entries()) {
        const payloadHash = createHash('sha256').update(text).digest('hex');
        const effectId = `${event.event_id}:${index}`;
        let effect = await this.repository.prepareEffect({
          effect_id: effectId,
          outbox_id: event.event_id,
          tenant_id: event.tenant_id,
          bridge_alias: bridgeAlias,
          chunk_index: index,
          chunk_count: chunks.length,
          payload_hash: payloadHash
        });
        if (effect.state === 'sent') continue;
        if (effect.state === 'sending') {
          effect = await this.repository.markEffectAmbiguous(effectId, payloadHash, RESTART_AMBIGUOUS);
          this.onMetric('egress_ambiguous');
          blocked = blockedDiagnostic(effect);
          break;
        }
        if (effect.state === 'ambiguous' || effect.state === 'dead') {
          if (effect.state === 'ambiguous') this.onMetric('egress_ambiguous');
          blocked = blockedDiagnostic(effect);
          break;
        }
        await this.hooks.beforeBegin?.(effectId);
        effect = await this.repository.beginEffect(effectId, payloadHash);
        if (effect.state === 'sent') continue;
        if (effect.state !== 'sending') {
          blocked = blockedDiagnostic(effect);
          break;
        }
        try {
          await this.hooks.beforeSend?.(effectId);
        } catch (error) {
          if (error instanceof EgressCrash) throw error;
          await this.repository.resetPrepared(effectId, payloadHash);
          throw error;
        }
        let remotelyAccepted = false;
        try {
          const sent = await api.sendText(chatId, text);
          remotelyAccepted = true;
          await this.hooks.afterSend?.(effectId);
          await this.repository.completeEffect(effectId, payloadHash, sent.message_id);
        } catch (error) {
          if (error instanceof EgressCrash) throw error;
          const knownRejected = !remotelyAccepted && error instanceof TelegramApiError && error.outcomeKnown;
          if (knownRejected) {
            const canRetry = error.retryable && event.attempt < event.max_attempts;
            if (canRetry) await this.repository.resetPrepared(effectId, payloadHash);
            else {
              effect = await this.repository.markEffectDead(effectId, payloadHash, safeError(error));
              blocked = blockedDiagnostic(effect);
              break;
            }
          } else {
            effect = await this.repository.markEffectAmbiguous(
              effectId,
              payloadHash,
              remotelyAccepted
                ? 'Telegram accepted the request but local confirmation did not complete; automatic replay is disabled'
                : `${RESTART_AMBIGUOUS}: ${safeError(error)}`
            );
            if (effect.state === 'sent') continue;
            this.onMetric('egress_ambiguous');
            blocked = blockedDiagnostic(effect);
            break;
          }
          throw error;
        }
        await this.hooks.afterComplete?.(effectId);
      }
      if (blocked) {
        await this.repository.ack(this.acknowledgement(event, { status: 'dead', error: blocked }));
        if (!interimAcknowledgement) this.finishActivity(event, bridgeAlias, api, 'dead');
        this.onMetric('egress_dead');
        return;
      }
      await this.repository.ack(this.acknowledgement(event, { status: 'sent', effect_count: chunks.length }));
      if (!interimAcknowledgement) {
        this.finishActivity(event, bridgeAlias, api, relayOutcome(event.payload));
      }
      this.onMetric('egress_sent');
    } catch (error) {
      if (error instanceof EgressCrash) throw error;
      const retryable = error instanceof TelegramApiError ? error.retryable : true;
      const retry = retryable && event.attempt < event.max_attempts;
      if (retry) {
        const exponential = Math.min(300_000, this.baseRetryMs * 2 ** Math.max(0, event.attempt - 1));
        const retryAfter = error instanceof TelegramApiError && error.retryAfterMs !== undefined
          ? Math.max(exponential, error.retryAfterMs) : exponential;
        await this.repository.ack(this.acknowledgement(event, {
          status: 'retry', error: safeError(error), retry_after_ms: retryAfter
        }));
        this.onMetric('egress_retry');
      } else {
        await this.repository.ack(this.acknowledgement(event, { status: 'dead', error: safeError(error) }));
        if (!interimAcknowledgement) this.finishActivity(event, bridgeAlias, api, 'dead');
        this.onMetric('egress_dead');
      }
    }
  }

  async runOnce(): Promise<number> {
    const events = await this.repository.claim(this.workerId, this.batchSize, this.leaseMs);
    for (const event of events) await this.process(event);
    return events.length;
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    while (!signal.aborted) {
      try {
        const count = await this.runOnce();
        if (count === 0) await sleep(idleMs, signal);
      } catch (error) {
        if (error instanceof EgressCrash) throw error;
        if (!signal.aborted) await sleep(1_000, signal);
      }
    }
  }
}
