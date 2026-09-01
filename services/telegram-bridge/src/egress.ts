import { createHash, randomUUID } from 'node:crypto';
import type { TelegramActivity, TelegramActivityTarget, TelegramTerminalOutcome } from './activity.js';
import { planArtifacts, type PlannedUpload } from './artifacts.js';
import { effectiveChatPolicy, groupRouting } from './config.js';
import type {
  BridgeMetric, TelegramAliasConfig, TelegramApi, TelegramEgressRepository,
  TelegramEffect, TelegramOriginRelay, TelegramOriginRelayAck, TelegramSendOptions,
  TelegramSendResult, TelegramUpload
} from './types.js';
import { TelegramApiError, validTelegramMessageId } from './telegram.js';
import { markdownToPlainText, markdownToTelegramHtml } from './markdown.js';
import type { TelegramLoopObserver } from './progress.js';
import { sleep } from './abort-sleep.js';
import { objectRecord } from './validation.js';

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
  leaseMs?: number;
  baseRetryMs?: number;
  hooks?: TelegramEgressHooks;
  activity?: TelegramActivity;
  onMetric?: (metric: BridgeMetric) => void;
  observer?: TelegramLoopObserver;
}

class EgressLeaseLost extends Error {
  constructor() {
    super('Telegram egress lease or durable ACK was fenced');
    this.name = 'EgressLeaseLost';
  }
}

const VISIBLE_TEXT = /[\p{L}\p{N}\p{P}\p{S}]/u;
const MISSING_FINAL_REPLY_NOTICE =
  'No pude completar una respuesta para este turno. Volvé a preguntarme para intentarlo de nuevo.';

function hasVisibleText(value: unknown): value is string {
  return typeof value === 'string' && VISIBLE_TEXT.test(value);
}

/**
 * Unwrapping of structured envelopes to extract the reply text.
 */
const ENVELOPE_KEYS = ['status', 'messages', 'artifacts', 'retryable'];

function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export function unwrapStructuredEnvelope(value: string): string | undefined {
  // Strip the code fence before searching: it is the most common wrapper around the object.
  const bare = value.trim().replace(/^```[A-Za-z0-9_-]*\r?\n/u, '').replace(/\r?\n?```$/u, '').trim();
  const opening = bare.indexOf('{');
  if (opening === -1) return value;

  const candidateObject = balancedObjectAt(bare, opening);
  if (candidateObject === undefined) return value;
  // The object must close the message: if real content remains after, this is not an envelope.
  if (bare.slice(opening + candidateObject.length).trim().length > 0) return value;

  let decoded: unknown;
  try {
    decoded = JSON.parse(candidateObject);
  } catch {
    return value;
  }
  const envelope = objectRecord(decoded);
  if (envelope === undefined || !('reply' in envelope)) return value;
  if (!ENVELOPE_KEYS.some((key) => key in envelope)) return value;

  // `reply` is what the agent meant to say; when the model wrote prose and left it null, the
  // prose before the object counts.
  if (hasVisibleText(envelope.reply)) return envelope.reply;
  const prose = bare.slice(0, opening).trim();
  // Confirmed envelope, no `reply`, no prose: there is nothing human to publish. Returning
  // `value` here would re-emit the raw JSON into the chat.
  return hasVisibleText(prose) ? prose : undefined;
}

/** Exhausted attempts never reached the agent: the person must resend. */
function textoDeEntregaMuerta(payload: Record<string, unknown>): string {
  const code = typeof payload.error_code === 'string' && payload.error_code.length > 0
    ? payload.error_code
    : typeof payload.error === 'string' ? payload.error : 'sin causa registrada';
  return 'Tu mensaje no llegó al agente: agotó los reintentos y se descartó. '
    + `Reenvíalo cuando el agente vuelva a estar disponible. (causa: ${code})`;
}

function candidate(payload: Record<string, unknown>): string | undefined {
  const result = objectRecord(payload.result);
  const output = objectRecord(result?.output);
  const values = [
    output?.reply, result?.reply,
    result?.text, result?.content, result?.message,
    payload.text, payload.content, payload.message,
    payload.outcome === 'dead' ? textoDeEntregaMuerta(payload) : undefined,
    typeof payload.error === 'string' ? `Error: ${payload.error}` : undefined
  ];
  // Preference order, not `find`: an empty envelope unwraps to nothing, and keeping it would
  // publish a blank message while a worse but legible candidate sits below.
  for (const value of values) {
    if (!hasVisibleText(value)) continue;
    const unwrapped = unwrapStructuredEnvelope(value);
    if (hasVisibleText(unwrapped)) return unwrapped;
  }
  return undefined;
}

/**
 * The text that gets published, already chunked to Telegram's size.
 *
 * `footer` is the attachments block `planArtifacts` builds, ATTACHED to the text and not sent
 * as a separate message for two reasons: it rides in the same durable row as the reply —so the
 * list cannot arrive without the reply or vice versa— and burns no extra notification.
 *
 * When there is no reply but there are attachments, the footer IS the message: publishing what
 * the agent produced is worth much more than the silence we had until now.
 */
export function telegramTextChunks(payload: Record<string, unknown>, footer = ''): string[] {
  // MISSING_FINAL_REPLY is a control tag, not content. No payload field nor the footer is
  // interpreted on that branch: they may contain internal diagnostics, a broken envelope, or
  // artifacts controlled by the harness. The output is exactly one known constant.
  if (isMissingFinalReply(payload)) return [MISSING_FINAL_REPLY_NOTICE];
  const original = candidate(payload);
  const value = original === undefined
    ? (footer === '' ? undefined : footer.trim())
    : `${original}${footer}`;
  if (value === undefined) return [];
  const source = value.split('\u0000').join('').trim();
  const characters = Array.from(source).slice(0, 65_536);
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

function originThreadId(event: TelegramOriginRelay): string {
  const value = event.origin.metadata.thread_id;
  return typeof value === 'string' && validTelegramMessageId(value) ? value : '0';
}

/**
 * Egress side of the default-deny rule, symmetric with ingress P0.e.
 *
 * A group chat (negative Telegram id) must have an explicit `chats[]` entry that is not `off`
 * before the bridge writes into it — but ONLY once the alias has opted into group routing by
 * declaring `chats` at all. An alias still on `legacy` routing keeps the pre-routing rule (the
 * alias-wide `allowed_chat_ids` check alone), which is what stops a code-before-config rollout
 * from ACKing already-generated answers as `dead`: the ingress side would have published them, so
 * denying them here would strand a real reply that the human never sees.
 */
function egressAuthorized(config: TelegramAliasConfig, chatId: string, threadId: string): boolean {
  const policy = effectiveChatPolicy(config, chatId, threadId);
  if (policy !== undefined) return policy.mode !== 'off';
  return groupRouting(config) === 'legacy' || !chatId.startsWith('-');
}

/**
 * Reply/topic hints for one chunk. Only chunk 0 quotes the original message so a long answer does
 * not produce N stacked replies. Both ids are validated again by the transport, which drops an
 * invalid hint instead of failing the send.
 */
function threadOptions(
  event: TelegramOriginRelay,
  index: number,
  threadId: string,
  replyToOrigin: boolean
): TelegramSendOptions | undefined {
  const replyTo = index === 0 && replyToOrigin ? event.origin.external_message_id : undefined;
  const options: TelegramSendOptions = {
    ...(threadId === '0' ? {} : { message_thread_id: threadId }),
    ...(typeof replyTo === 'string' && validTelegramMessageId(replyTo)
      ? { reply_to_message_id: replyTo } : {})
  };
  return Object.keys(options).length === 0 ? undefined : options;
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

/**
 * One piece of the reply: a chunk of text or a file.
 *
 * Both share the same `telegram_egress_effects` sequence (indices 0..n-1) because the repository
 * ACK verifies that ALL indices exist and that all are `sent`. Numbering attachments separately
 * would break that verification and leave the delivery hanging.
 */
type EgressPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'upload'; readonly upload: PlannedUpload };

/**
 * Durable identity of the piece: text without prefix (`sha256(text)`) for historical idempotence,
 * or a descriptor prefixed with `artifact:` for attachments.
 */
function pieceHash(piece: EgressPiece): string {
  const material = piece.kind === 'text'
    ? piece.text
    : `artifact:${piece.upload.kind}:${piece.upload.name}:${piece.upload.sha256}`;
  return createHash('sha256').update(material).digest('hex');
}


export class TelegramEgressWorker {
  private readonly repository: TelegramEgressRepository;
  private readonly aliases: ReadonlyMap<string, TelegramAliasConfig>;
  private readonly apis: ReadonlyMap<string, TelegramApi>;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly hooks: TelegramEgressHooks;
  private readonly activity: TelegramActivity | undefined;
  private readonly onMetric: (metric: BridgeMetric) => void;
  private readonly observer: TelegramLoopObserver | undefined;

  constructor(options: TelegramEgressWorkerOptions) {
    this.repository = options.repository;
    this.aliases = new Map(options.aliases.map((entry) => [entry.alias, entry]));
    this.apis = options.apis;
    this.workerId = options.workerId ?? `telegram-egress:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 90_000;
    this.baseRetryMs = options.baseRetryMs ?? 500;
    this.hooks = options.hooks ?? {};
    this.activity = options.activity;
    this.onMetric = options.onMetric ?? (() => undefined);
    this.observer = options.observer;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000 ||
        !Number.isInteger(this.baseRetryMs) || this.baseRetryMs < 1) {
      throw new Error('Telegram egress worker options are invalid');
    }
  }

  private async ensureLease(event: TelegramOriginRelay): Promise<void> {
    try {
      if (await this.repository.renew(event, this.leaseMs)) {
        this.observer?.egressCycleHeartbeat();
        return;
      }
    } catch {
      // A database error makes ownership unknowable. Fail closed exactly like a fencing result.
    }
    this.markEgressFenced();
    throw new EgressLeaseLost();
  }

  private markEgressFenced(): void {
    this.onMetric('egress_fenced');
    this.observer?.egressCycleFenced();
  }

  private async durableAck(
    event: TelegramOriginRelay,
    values: Omit<TelegramOriginRelayAck, 'event_id' | 'attempt' | 'claim_token'>
  ): Promise<void> {
    await this.ensureLease(event);
    try {
      await this.repository.ack(this.acknowledgement(event, values));
    } catch {
      this.markEgressFenced();
      throw new EgressLeaseLost();
    }
  }

  /**
   * Sends the text formatted as HTML and falls back to plain text if Telegram rejects the parse.
   */
  private async sendFormatted(
    api: TelegramApi,
    chatId: string,
    text: string,
    options: TelegramSendOptions | undefined,
    beforeRemote: () => Promise<void>
  ): Promise<TelegramSendResult> {
    const html = markdownToTelegramHtml(text);
    const conFormato: TelegramSendOptions = { ...(options ?? {}), parse_mode: 'html' };
    try {
      await beforeRemote();
      return await api.sendText(chatId, html, conFormato);
    } catch (error) {
      if (error instanceof EgressCrash) throw error;
      // Only falls back on a KNOWN rejection of the content: a network failure or an ambiguous
      // result has to follow its normal path, or a delivered message would be duplicated.
      const rechazoDeFormato = error instanceof TelegramApiError
        && error.outcomeKnown && !error.retryable;
      if (!rechazoDeFormato) throw error;
      this.onMetric('egress_format_downgraded');
      const plano = markdownToPlainText(text);
      await beforeRemote();
      return options === undefined
        ? await api.sendText(chatId, plano)
        : await api.sendText(chatId, plano, options);
    }
  }

  /** Uploads an attachment with sequential fallback (photo -> document -> text notice) on format rejections. */
  private async sendAttachment(
    api: TelegramApi,
    chatId: string,
    upload: PlannedUpload,
    options: TelegramSendOptions | undefined,
    beforeRemote: () => Promise<void>
  ): Promise<TelegramSendResult> {
    const payload: TelegramUpload = {
      kind: upload.kind,
      name: upload.name,
      mime_type: upload.mime_type,
      bytes: upload.bytes,
      caption: upload.name
    };
    const rejected = (error: unknown): boolean =>
      error instanceof TelegramApiError && error.outcomeKnown && !error.retryable;

    if (upload.kind === 'photo' && api.sendPhoto !== undefined) {
      try {
        await beforeRemote();
        const sent = await api.sendPhoto(chatId, payload, options);
        this.onMetric('egress_attachment_uploaded');
        return sent;
      } catch (error) {
        if (error instanceof EgressCrash || !rejected(error)) throw error;
      }
    }
    if (api.sendDocument !== undefined) {
      try {
        await beforeRemote();
        const sent = await api.sendDocument(chatId, { ...payload, kind: 'document' }, options);
        this.onMetric('egress_attachment_uploaded');
        return sent;
      } catch (error) {
        if (error instanceof EgressCrash || !rejected(error)) throw error;
      }
    }
    this.onMetric('egress_attachment_upload_failed');
    const aviso = `📎 No pude adjuntar «${upload.name}»: Telegram rechazó el archivo. `
      + 'Pedile al agente que lo mande más liviano o en otro formato.';
    await beforeRemote();
    return options === undefined
      ? await api.sendText(chatId, aviso)
      : await api.sendText(chatId, aviso, options);
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
    const threadId = originThreadId(event);
    // Proactive relay does not answer an inbound message. allowed_chat_ids remains the second key.
    const forgedProactiveReply = event.payload.relay_kind === 'notify'
      && event.origin.external_message_id !== undefined;
    if (!bridgeAlias || !config || !api || config.tenant_id !== event.tenant_id || event.origin.channel !== 'telegram' ||
        !config.allowed_chat_ids.includes(chatId) || !egressAuthorized(config, chatId, threadId)
        || forgedProactiveReply) {
      await this.durableAck(event, {
        status: 'dead', error: 'Telegram origin is not authorized for this tenant and alias'
      });
      this.onMetric('egress_dead');
      return;
    }

    try {
      // On MISSING_FINAL_REPLY the payload is NOT inspected NOR planned: even a data:/http:/file:
      // artifact is untrusted input and the response must be a single fixed piece.
      const missingFinalReply = isMissingFinalReply(event.payload);
      let pieces: EgressPiece[];
      if (missingFinalReply) {
        pieces = [{ kind: 'text', text: MISSING_FINAL_REPLY_NOTICE }];
      } else {
        // Attachments are planned BEFORE chunking: the footer that summarises what did not
        // travel is part of the text, and the bytes that travel are more pieces of the same row.
        const plan = planArtifacts(event.payload);
        const chunks = telegramTextChunks(event.payload, plan.footer);
        pieces = [
          ...chunks.map((text): EgressPiece => ({ kind: 'text', text })),
          ...plan.uploads.map((upload): EgressPiece => ({ kind: 'upload', upload }))
        ];
        if (plan.listed > 0) this.onMetric('egress_attachment_listed');
      }
      if (pieces.length === 0) {
        const diagnostic = 'Telegram relay has no visible final reply; no message was sent';
        await this.durableAck(event, { status: 'dead', error: diagnostic });
        if (!interimAcknowledgement) this.finishActivity(event, bridgeAlias, api, 'failed');
        this.onMetric('egress_dead');
        return;
      }
      let blocked: string | undefined;
      for (const [index, piece] of pieces.entries()) {
        const payloadHash = pieceHash(piece);
        const effectId = `${event.event_id}:${String(index)}`;
        let effect = await this.repository.prepareEffect({
          effect_id: effectId,
          outbox_id: event.event_id,
          tenant_id: event.tenant_id,
          bridge_alias: bridgeAlias,
          chunk_index: index,
          chunk_count: pieces.length,
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
        await this.ensureLease(event);
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
          const replyToOrigin = effectiveChatPolicy(config, chatId, threadId)?.reply_to_origin ?? false;
          const options = threadOptions(event, index, threadId, replyToOrigin);
          const beforeRemote = async (): Promise<void> => this.ensureLease(event);
          // Omit the argument entirely when there is nothing to thread, so any existing
          // two-parameter TelegramApi implementation keeps behaving exactly as before.
          const sent = piece.kind === 'text'
            ? await this.sendFormatted(api, chatId, piece.text, options, beforeRemote)
            : await this.sendAttachment(api, chatId, piece.upload, options, beforeRemote);
          remotelyAccepted = true;
          await this.hooks.afterSend?.(effectId);
          await this.repository.completeEffect(effectId, payloadHash, sent.message_id);
        } catch (error) {
          if (error instanceof EgressCrash) throw error;
          if (error instanceof EgressLeaseLost) {
            // Every remote call is preceded by renewal. A loss here therefore happened before a
            // call, or after a known rejection while preparing a fallback; no new effect is
            // possible. Reset when PostgreSQL is reachable, otherwise the later claimant will
            // conservatively diagnose the stranded `sending` row as ambiguous.
            await this.repository.resetPrepared(effectId, payloadHash).catch(() => undefined);
            throw error;
          }
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
        await this.durableAck(event, { status: 'dead', error: blocked });
        if (!interimAcknowledgement) this.finishActivity(event, bridgeAlias, api, 'dead');
        this.onMetric('egress_dead');
        return;
      }
      await this.durableAck(event, { status: 'sent', effect_count: pieces.length });
      if (!interimAcknowledgement) {
        this.finishActivity(event, bridgeAlias, api, relayOutcome(event.payload));
      }
      this.onMetric('egress_sent');
    } catch (error) {
      if (error instanceof EgressCrash) throw error;
      if (error instanceof EgressLeaseLost) return;
      const retryable = error instanceof TelegramApiError ? error.retryable : true;
      const retry = retryable && event.attempt < event.max_attempts;
      if (retry) {
        const exponential = Math.min(300_000, this.baseRetryMs * 2 ** Math.max(0, event.attempt - 1));
        const retryAfter = error instanceof TelegramApiError && error.retryAfterMs !== undefined
          ? Math.max(exponential, error.retryAfterMs) : exponential;
        await this.durableAck(event, {
          status: 'retry', error: safeError(error), retry_after_ms: retryAfter
        });
        this.onMetric('egress_retry');
      } else {
        await this.durableAck(event, { status: 'dead', error: safeError(error) });
        if (!interimAcknowledgement) this.finishActivity(event, bridgeAlias, api, 'dead');
        this.onMetric('egress_dead');
      }
    }
  }

  async runOnce(): Promise<number> {
    const events = await this.repository.claim(this.workerId, 1, this.leaseMs);
    for (const event of events) await this.process(event);
    return events.length;
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    while (!signal.aborted) {
      this.observer?.egressCycleStarted();
      try {
        const count = await this.runOnce();
        this.observer?.egressCycleSucceeded(count);
        if (count === 0) await sleep(idleMs, signal);
      } catch (error) {
        this.observer?.egressCycleFailed();
        this.onMetric('egress_loop_error');
        if (error instanceof EgressCrash) throw error;
        await sleep(1_000, signal);
      }
    }
  }
}
