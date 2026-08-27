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
  observer?: TelegramLoopObserver;
}

class EgressLeaseLost extends Error {
  constructor() {
    super('Telegram egress lease or durable ACK was fenced');
    this.name = 'EgressLeaseLost';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

const VISIBLE_TEXT = /[\p{L}\p{N}\p{P}\p{S}]/u;
const MISSING_FINAL_REPLY_NOTICE =
  'No pude completar una respuesta para este turno. Volvé a preguntarme para intentarlo de nuevo.';

function hasVisibleText(value: unknown): value is string {
  return typeof value === 'string' && VISIBLE_TEXT.test(value);
}

/**
 * Desenvoltura de sobres estructurados para extraer el texto de respuesta.
 */
const ENVELOPE_KEYS = ['status', 'messages', 'artifacts', 'retryable'];

function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
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
  // Se quita la valla de código antes de buscar: es la envoltura más común alrededor del objeto.
  const bare = value.trim().replace(/^```[A-Za-z0-9_-]*\r?\n/u, '').replace(/\r?\n?```$/u, '').trim();
  const opening = bare.indexOf('{');
  if (opening === -1) return value;

  const candidateObject = balancedObjectAt(bare, opening);
  if (candidateObject === undefined) return value;
  // El objeto tiene que cerrar el mensaje: si después queda contenido real, esto no es un sobre.
  if (bare.slice(opening + candidateObject.length).trim().length > 0) return value;

  let decoded: unknown;
  try {
    decoded = JSON.parse(candidateObject);
  } catch {
    return value;
  }
  const envelope = object(decoded);
  if (envelope === undefined || !('reply' in envelope)) return value;
  if (!ENVELOPE_KEYS.some((key) => key in envelope)) return value;

  // `reply` es lo que el agente quiso decir. Cuando viene vacío —pasa cuando el modelo escribió su
  // mensaje como prosa y dejó el campo en null— vale la prosa que quedó delante del objeto.
  if (hasVisibleText(envelope.reply)) return envelope.reply;
  const prose = bare.slice(0, opening).trim();
  // Sobre confirmado, sin `reply` y sin prosa: no hay nada humano que publicar. Devolver `value`
  // acá volvería a soltar el JSON crudo en el chat.
  return hasVisibleText(prose) ? prose : undefined;
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
  // Se recorren en orden de preferencia y no con un `find`: si el candidato preferido resulta ser
  // un sobre vacío, desarmarlo no deja texto, y quedarse con él publicaría un mensaje en blanco
  // habiendo un candidato peor pero legible más abajo (típicamente `result.text`).
  for (const value of values) {
    if (!hasVisibleText(value)) continue;
    const unwrapped = unwrapStructuredEnvelope(value);
    if (hasVisibleText(unwrapped)) return unwrapped;
  }
  return undefined;
}

/**
 * El texto que se publica, ya troceado a la medida de Telegram.
 *
 * `footer` es el bloque de adjuntos que arma `planArtifacts`. Va PEGADO al texto y no como mensaje
 * aparte por dos razones: viaja con la misma fila durable que la respuesta —así no puede llegar la
 * lista sin la respuesta ni al revés— y no gasta una notificación más en el teléfono de nadie.
 *
 * Cuando no hay respuesta pero sí adjuntos, el pie ES el mensaje: publicar lo que el agente produjo
 * vale mucho más que el silencio que había hasta ahora.
 */
export function telegramTextChunks(payload: Record<string, unknown>, footer = ''): string[] {
  // MISSING_FINAL_REPLY es una etiqueta de control, no contenido. Ningún campo del payload ni el
  // footer se interpreta en esa rama: pueden contener diagnóstico interno, un sobre roto o
  // artifacts controlados por el arnés. La salida es exactamente una constante conocida.
  if (isMissingFinalReply(payload)) return [MISSING_FINAL_REPLY_NOTICE];
  const original = candidate(payload);
  const value = original === undefined
    ? (footer === '' ? undefined : footer.trim())
    : `${original}${footer}`;
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
 * Una pieza de la respuesta: un trozo de texto o un archivo.
 *
 * Las dos comparten la misma secuencia de `telegram_egress_effects` (índices 0..n-1) porque el ACK
 * del repositorio verifica que existan TODOS los índices y que todos estén `sent`. Numerar los
 * adjuntos aparte rompería esa verificación y dejaría la entrega colgada.
 */
type EgressPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'upload'; readonly upload: PlannedUpload };

/**
 * Identidad durable de la pieza: texto sin prefijo (`sha256(texto)`) para idempotencia histórica,
 * o descriptor con prefijo `artifact:` para adjuntos.
 */
function pieceHash(piece: EgressPiece): string {
  const material = piece.kind === 'text'
    ? piece.text
    : `artifact:${piece.upload.kind}:${piece.upload.name}:${piece.upload.sha256}`;
  return createHash('sha256').update(material).digest('hex');
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
  private readonly observer: TelegramLoopObserver | undefined;

  constructor(options: TelegramEgressWorkerOptions) {
    this.repository = options.repository;
    this.aliases = new Map(options.aliases.map((entry) => [entry.alias, entry]));
    this.apis = options.apis;
    this.workerId = options.workerId ?? `telegram-egress:${randomUUID()}`;
    // Compatibility accepts the old batch option, but a claim is always incremental. A remote
    // send must never wait in memory behind leases that started at the same instant.
    this.batchSize = 1;
    this.leaseMs = options.leaseMs ?? 90_000;
    this.baseRetryMs = options.baseRetryMs ?? 500;
    this.hooks = options.hooks ?? {};
    this.activity = options.activity;
    this.onMetric = options.onMetric ?? (() => undefined);
    this.observer = options.observer;
    if ((options.batchSize !== undefined && options.batchSize < 1) ||
        !Number.isInteger(this.leaseMs) || this.leaseMs < 1_000 ||
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
   * Envía el texto con formato, y si Telegram lo rechaza vuelve a intentar en plano.
   *
   * Los agentes escriben markdown —encabezados, negritas, tablas, bloques de código— y el puente
   * lo mandaba sin `parse_mode`, así que Telegram lo mostraba literal: el informe llegaba al
   * teléfono con `##` y `**` sueltos por todos lados. Convertirlo a HTML lo hace legible.
   *
   * El reintento en plano es la parte que importa: si la conversión produjera HTML que Telegram
   * no acepta, el mensaje se perdería por un problema de FORMATO, que es exactamente el peor
   * final posible. Un 400 de parseo no es reintentable en el sentido del outbox (reenviar lo
   * mismo daría el mismo 400), pero sí lo es enviando otra cosa: el mismo contenido sin etiquetas.
   * Así el humano siempre recibe su respuesta, en el peor caso sin adornos.
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
      // Sólo se degrada ante un rechazo CONOCIDO del contenido: un fallo de red o un resultado
      // ambiguo tiene que seguir su camino normal, o se duplicaría un mensaje ya entregado.
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

  /**
   * Sube un adjunto, y si no se puede, DICE por qué en el chat.
   *
   * La cadena es foto → documento → línea de texto, y existe para sostener el invariante duro de
   * este servicio: cada pieza planificada produce SIEMPRE un mensaje de Telegram. Si una subida
   * fallida no produjera ninguno, su fila de `telegram_egress_effects` no llegaría nunca a `sent`,
   * el ACK exige que TODAS lo estén (`repository.ack`), y la entrega entera —la respuesta del
   * agente incluida— terminaría en `dead` por culpa de un archivo. Un adjunto es un campo
   * accesorio: no puede costar el turno.
   *
   * El degradado a documento cubre el caso más común de rechazo de `sendPhoto`: Telegram limita
   * las dimensiones y la relación de aspecto de una foto, no sólo su peso. Como documento, la
   * misma imagen entra.
   *
   * Sólo se degrada ante un rechazo CONOCIDO (`outcomeKnown && !retryable`). Un fallo de red o un
   * resultado ambiguo sigue el camino normal, o se subiría dos veces algo que la persona ya tiene.
   */
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
    // A proactive relay does not answer an inbound message. If one ever claimed
    // to, finishActivity would place a reaction on an arbitrary message id of
    // that chat. allowed_chat_ids remains the independent second key: a
    // destination approved in the database still cannot reach a chat this bridge
    // was not configured for.
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
      // En MISSING_FINAL_REPLY no se inspecciona NI se planifica el payload: incluso un artifact
      // data:/http:/file: es entrada no confiable y la respuesta debe ser una sola pieza fija.
      const missingFinalReply = isMissingFinalReply(event.payload);
      let pieces: EgressPiece[];
      if (missingFinalReply) {
        pieces = [{ kind: 'text', text: MISSING_FINAL_REPLY_NOTICE }];
      } else {
        // Los adjuntos se planifican ANTES de trocear: el pie que resume lo que no viajó forma
        // parte del texto, y los bytes que sí viajan son piezas más de la misma secuencia durable.
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
        const effectId = `${event.event_id}:${index}`;
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
    const events = await this.repository.claim(this.workerId, this.batchSize, this.leaseMs);
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
        if (!signal.aborted) await sleep(1_000, signal);
      }
    }
  }
}
