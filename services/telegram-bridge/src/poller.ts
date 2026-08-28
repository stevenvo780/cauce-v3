import { randomUUID } from 'node:crypto';
import type { Origin } from '@cauce/protocol';
import type { TelegramActivity } from './activity.js';
import type {
  AddressingDecision, AddressingSelf, FleetDirectory, SuppressionReason
} from './addressing.js';
import { isFleetBot, resolveAddressing, telegramThreadId } from './addressing.js';
import { effectiveChatPolicy, groupRouting } from './config.js';
import {
  conversationId,
  id,
  isPrivateChatId,
  isRequestConflict,
  logJsonLine,
  normalizedBody,
  privateContext,
  session,
  suppressionMetric,
  telegramSessionId,
  type BodyContext,
} from './ingress-body.js';
import type { TelegramLoopObserver } from './progress.js';
import { TelegramApiError } from './telegram.js';
import { sleep } from './abort-sleep.js';
import type { TranscriptionConfig } from './transcription.js';
import type {
  BridgeMetric, PollLease, SessionScope, TelegramAliasConfig,
  TelegramApi, TelegramChatPolicy, TelegramCursorRepository, TelegramIngress,
  TelegramMessage, TelegramUpdate
} from './types.js';
import { safeInline, safeText, untrustedAuthor } from './untrusted.js';

export { normalizedBody, telegramSessionId, type BodyContext };

export interface TelegramPollerOptions {
  config: TelegramAliasConfig;
  botId: string;
  api: TelegramApi;
  repository: TelegramCursorRepository;
  ingress: TelegramIngress;
  activity?: TelegramActivity;
  ownerId?: string;
  onMetric?: (metric: BridgeMetric) => void;
  observer?: TelegramLoopObserver;
  /** Usernames/bot ids of the whole fleet. Defaults to a directory holding only this bot. */
  fleet?: FleetDirectory;
  /** Verified `getMe` username of this bot, used to match `@self` mentions. */
  botUsername?: string;
  /**
   * Aliases that can answer in a given (chat, thread), derived from the COMPLETE config file.
   * Omitting it keeps echo suppression fleet-wide, which is only correct for a single-alias
   * deployment; `main.ts` always supplies it.
   */
  participants?: (chatId: string, threadId: string) => ReadonlySet<string>;
  /** Structured audit sink for suppressed group updates. Defaults to a stderr JSON line. */
  onSuppressed?: (record: SuppressedUpdate) => void;
  /**
   * Servicio de transcripción para las notas de voz. Sin esto el puente sigue funcionando: los
   * audios llegan como hasta ahora, con su metadata y un aviso de que no se pudieron escuchar.
   */
  transcription?: TranscriptionConfig;
}

/**
 * One suppressed group update, recorded BEFORE the cursor advances.
 *
 * Telegram's getUpdates cursor is destructive: once advanced, an update can never be requested
 * again. The unlabelled `/metrics` counters cannot say WHICH chat went quiet, so a routing mistake
 * (a typo in `default_alias`, a `mode:"off"` left behind, a renamed username) would discard traffic
 * invisibly and irreversibly. This record is ids and enums only — no message text, no display
 * name — so it stays safe to emit to the container log.
 */
export interface SuppressedUpdate {
  readonly event: 'telegram_group_update_suppressed';
  readonly alias: string;
  readonly tenant_id: string;
  readonly chat_id: string;
  readonly thread_id: string;
  readonly update_id: number;
  readonly message_id: number;
  readonly reason: SuppressionReason;
  readonly group_routing: 'legacy' | 'scoped';
  readonly chat_configured: boolean;
}

function logSuppressedUpdate(record: SuppressedUpdate): void {
  logJsonLine({ ...record });
}


export class TelegramPoller {
  private readonly config: TelegramAliasConfig;
  private readonly botId: string;
  private readonly api: TelegramApi;
  private readonly repository: TelegramCursorRepository;
  private readonly ingress: TelegramIngress;
  private readonly activity: TelegramActivity | undefined;
  private readonly ownerId: string;
  private readonly onMetric: (metric: BridgeMetric) => void;
  private readonly observer: TelegramLoopObserver | undefined;
  private readonly fleet: FleetDirectory;
  private readonly self: AddressingSelf;
  private readonly participants: ((chatId: string, threadId: string) => ReadonlySet<string>) | undefined;
  private readonly onSuppressed: (record: SuppressedUpdate) => void;
  private readonly transcription: TranscriptionConfig | undefined;
  /**
   * Nombres por los que un desconocido podría intentar hacerse pasar.
   *
   * Sale del directorio de la flota que ya arma `main.ts` con el archivo de config desplegado
   * —alias y @usernames de los bots— más el alias y el tenant de este puente. NINGUNO está escrito
   * en el código: un alias nuevo queda cubierto por el mismo despliegue que lo da de alta, y este
   * módulo no es una quinta fuente de verdad del mapa de alias que haya que recordar actualizar.
   */
  private readonly reservedNames: ReadonlySet<string>;
  private currentLease: PollLease | undefined;

  constructor(options: TelegramPollerOptions) {
    this.config = options.config;
    this.botId = options.botId;
    this.api = options.api;
    this.repository = options.repository;
    this.ingress = options.ingress;
    this.activity = options.activity;
    this.ownerId = options.ownerId ?? `telegram-poller:${randomUUID()}`;
    this.onMetric = options.onMetric ?? (() => undefined);
    this.observer = options.observer;
    const username = options.botUsername ?? options.config.bot_username;
    this.fleet = options.fleet ?? {
      byUsername: new Map(username === undefined ? [] : [[username.toLowerCase(), options.config.alias]]),
      byBotId: new Map([[options.botId, options.config.alias]])
    };
    this.self = {
      bot_id: options.botId,
      alias: options.config.alias,
      tenant_id: options.config.tenant_id,
      ...(username === undefined ? {} : { username })
    };
    this.participants = options.participants;
    this.onSuppressed = options.onSuppressed ?? logSuppressedUpdate;
    this.transcription = options.transcription;
    // Nombres reservados de la flota para detección de suplantación en grupos.
    this.reservedNames = new Set([
      ...this.fleet.byUsername.keys(),
      ...this.fleet.byUsername.values(),
      ...this.fleet.byBotId.values(),
      options.config.alias
    ]);
  }

  private markPollFenced(): void {
    this.onMetric('poll_fenced');
    this.observer?.pollCycleFenced(this.config.alias);
  }

  /**
   * Coarse, legacy allowlist filter. Unchanged from the original `allowed()`: it still only looks
   * at message_id, chat id, user id and the two alias-wide allowlists, so a private chat that is
   * accepted today is accepted here too.
   */
  private accepted(update: TelegramUpdate): {
    message: TelegramMessage; chatId: string; userId: string;
  } | undefined {
    const message = update.message;
    if (!message || !Number.isSafeInteger(message.message_id)) return undefined;
    const chatId = conversationId(message.chat.id);
    const userId = id(message.from?.id);
    if (!chatId || !userId) return undefined;
    if (!this.config.allowed_chat_ids.includes(chatId) || !this.config.allowed_user_ids.includes(userId)) return undefined;
    return { message, chatId, userId };
  }

  /**
   * Deja rastro de los updates de grupo que `accepted()` descarta antes de llegar al resolutor.
   */
  private reportSilentDrop(update: TelegramUpdate): void {
    const message = update.message;
    if (!message || !Number.isSafeInteger(message.message_id)) return;
    const chatId = conversationId(message.chat.id);
    if (chatId === undefined || isPrivateChatId(chatId)) return;
    // El orden importa: un mensaje anónimo TAMBIÉN falla el allowlist de usuario (Telegram lo firma
    // como GroupAnonymousBot), así que si se preguntara primero por el usuario el motivo real
    // quedaría escondido detrás de un 'user_denied' que no explica nada.
    const reason: SuppressionReason =
      message.sender_chat !== undefined ? 'anonymous_sender'
        : id(message.from?.id) === undefined ? 'no_author'
          : !this.config.allowed_chat_ids.includes(chatId) ? 'chat_not_allowed'
            : 'user_denied';
    const threadId = telegramThreadId(message);
    try {
      this.onSuppressed({
        event: 'telegram_group_update_suppressed',
        alias: this.config.alias,
        tenant_id: this.config.tenant_id,
        chat_id: chatId,
        thread_id: threadId,
        update_id: update.update_id,
        message_id: message.message_id,
        reason,
        group_routing: groupRouting(this.config),
        chat_configured: effectiveChatPolicy(this.config, chatId, threadId) !== undefined
      });
    } catch {
      // El rastro es best effort; jamás puede trabar el poller en este update.
    }
  }

  /**
   * Non-textual, authenticated facts about the human and the replied-to message.
   *
   * Only ids and booleans live here because this object ends up inside `origin.metadata`, which
   * the harness renders as trusted context. Every free-text field stays in the body.
   */
  private originContext(message: TelegramMessage, userId: string, threadId: string, bucket: string):
  Record<string, unknown> {
    const reply = message.reply_to_message;
    const replyMessageId = id(reply?.message_id);
    const replyAuthorId = id(reply?.from?.id);
    return {
      ...(threadId === '0' ? {} : { thread_id: threadId }),
      addressed_by: bucket,
      author: { id: userId, is_bot: false },
      ...(reply === undefined || replyMessageId === undefined ? {} : {
        reply_to: {
          message_id: replyMessageId,
          ...(replyAuthorId === undefined ? {} : { author_id: replyAuthorId }),
          is_fleet_bot: isFleetBot(reply.from, this.fleet)
        }
      })
    };
  }

  /**
   * Sanitised, explicitly untrusted identity of the author and of the quoted message.
   * Rendered inside the fenced UNTRUSTED block of the prompt, never inside `origin.metadata`.
   *
   * `scope: 'private'` deja fuera el extracto del mensaje citado: en un DM lo citado es casi
   * siempre la respuesta anterior del propio agente, y meterle de vuelta su propio texto marcado
   * como NO CONFIABLE es ruido que no ayuda a nadie. Lo que faltaba en el privado era saber CON
   * QUIÉN habla, y eso es el autor.
   */
  private untrustedContext(
    message: TelegramMessage,
    scope: 'group' | 'private'
  ): Record<string, unknown> | undefined {
    const reply = message.reply_to_message;
    const { author, impersonation } = untrustedAuthor(message.from, this.reservedNames);
    const replyUsername = scope === 'group' ? safeInline(reply?.from?.username, 32) : undefined;
    const excerpt = scope === 'group' ? safeInline(reply?.text ?? reply?.caption, 200) : undefined;
    const replyTo = {
      ...(replyUsername === undefined ? {} : { author_username: replyUsername }),
      ...(excerpt === undefined ? {} : { excerpt })
    };
    const context = {
      ...(author === undefined ? {} : { author }),
      ...(impersonation === undefined ? {} : { impersonation_suspected: impersonation }),
      ...(Object.keys(replyTo).length === 0 ? {} : { reply_to: replyTo })
    };
    if (Object.keys(context).length === 0) return undefined;
    return context;
  }

  private async process(
    update: TelegramUpdate,
    current: PollLease,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const accepted = this.accepted(update);
    if (!accepted) {
      this.reportSilentDrop(update);
      this.onMetric('updates_denied');
      signal?.throwIfAborted();
      await this.repository.advanceCursor(current, update.update_id + 1);
      return;
    }
    const { message, chatId, userId } = accepted;
    const threadId = telegramThreadId(message);
    const routing = groupRouting(this.config);
    const policy: TelegramChatPolicy | undefined = effectiveChatPolicy(this.config, chatId, threadId);
    const decision: AddressingDecision = resolveAddressing({
      message,
      self: this.self,
      fleet: this.fleet,
      policy,
      groupRouting: routing,
      ...(this.participants === undefined ? {} : { participants: this.participants(chatId, threadId) })
    });
    if (!decision.addressed) {
      // Consume the update and move the cursor without publishing: no delivery row, no wake,
      // no model quota. The only residual cost is the long poll that already happens.
      //
      // The audit record is emitted BEFORE advanceCursor because the Telegram cursor is
      // destructive: after it moves, the update cannot be fetched again from anywhere.
      if (!isPrivateChatId(chatId)) {
        try {
          this.onSuppressed({
            event: 'telegram_group_update_suppressed',
            alias: this.config.alias,
            tenant_id: this.config.tenant_id,
            chat_id: chatId,
            thread_id: decision.thread_id,
            update_id: update.update_id,
            message_id: message.message_id,
            reason: decision.reason,
            group_routing: routing,
            chat_configured: policy !== undefined
          });
        } catch {
          // The audit trail is best effort; it must never wedge the poller on this update.
        }
      }
      this.onMetric(suppressionMetric(decision.reason));
      signal?.throwIfAborted();
      await this.repository.advanceCursor(current, update.update_id + 1);
      return;
    }
    // `legacy` publishes exactly what the pre-routing bridge published: no thread, no bucket, no
    // untrusted block, and the legacy `user`-scoped session key.
    const group = decision.reason !== 'private' && decision.reason !== 'legacy';
    /**
     * P8: el DM también lleva la identidad del humano, y `legacy` sigue sin llevar nada.
     *
     * `legacy` es un GRUPO de un alias que nunca declaró `chats`: su escotilla de escape es
     * publicar byte por byte lo que publicaba antes del ruteo, y meterle el bloque untrusted la
     * rompería. El privado no tiene esa deuda: hoy el agente ve un número de chat y nada más.
     */
    const context: BodyContext | undefined = group
      ? { threadId, bucket: decision.bucket, untrusted: this.untrustedContext(message, 'group') }
      : decision.reason === 'private'
        ? privateContext(this.untrustedContext(message, 'private'))
        : undefined;
    const origin: Origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: chatId,
      external_message_id: String(message.message_id),
      relay: [],
      metadata: {
        bridge_alias: this.config.alias,
        bridge_tenant: this.config.tenant_id,
        chat_type: safeText(message.chat.type, 32) ?? 'unknown',
        ...(group ? this.originContext(message, userId, threadId, decision.bucket) : {})
      }
    };
    const scope: SessionScope = policy?.session_scope ?? 'user';
    const body = await normalizedBody(
      message,
      update.update_id,
      this.api,
      context,
      this.transcription,
      undefined,
      () => { this.onMetric('ingress_secret_redacted'); },
      { alias: this.config.alias, tenant_id: this.config.tenant_id }
    );
    // Attachment and voice preparation may await remote reads. Shutdown before the durable
    // publish is still side-effect free; once publish starts, cursor advancement must finish.
    signal?.throwIfAborted();
    let result: { duplicate: boolean };
    try {
      result = await this.ingress.publish({
        bot_id: this.botId,
        update_id: update.update_id,
        tenant_id: this.config.tenant_id,
        alias: this.config.alias,
        room_id: this.config.room_id,
        recipients: this.config.recipients,
        body,
        origin,
        session_id: session(scope, this.botId, chatId, userId, threadId),
        // `accepted()` already proved `userId` is on this alias's `allowed_user_ids`, the
        // operator-maintained allowlist of the people this bot serves. The extra `is_bot` test
        // matters for PRIVATE chats, where `resolveAddressing` deliberately skips its bot-author
        // guard (P0.b runs before P0.d) so that a DM a human sent through a bot keeps working.
        // Failing that test here never drops the update — it only denies the human band, which is
        // the conservative direction.
        human: message.from?.is_bot !== true
      });
    } catch (error) {
      if (isRequestConflict(error)) this.onMetric('updates_conflict');
      throw error;
    }
    if (!result.duplicate && !signal?.aborted) {
      try {
        this.activity?.begin({
          alias: this.config.alias,
          api: this.api,
          chatId,
          messageId: String(message.message_id)
        });
      } catch {
        // Telegram activity is visual only; durable ingress publication already won.
      }
    }
    this.onMetric(result.duplicate ? 'updates_duplicate' : 'updates_allowed');
    await this.repository.advanceCursor(current, update.update_id + 1);
  }

  private async processWithLeaseHeartbeat(
    update: TelegramUpdate,
    current: PollLease,
    signal?: AbortSignal
  ): Promise<PollLease | undefined> {
    const stop = new AbortController();
    const intervalMs = Math.max(1_000, Math.floor(this.config.poll_lease_ms / 3));
    const leaseState = { active: current, fenced: false };
    const heartbeat = (async (): Promise<void> => {
      while (!stop.signal.aborted) {
        try {
          await sleep(intervalMs, stop.signal);
        } catch {
          return;
        }
        let renewed: PollLease | undefined;
        try {
          renewed = await this.repository.renewPollLease(leaseState.active, this.config.poll_lease_ms);
        } catch {
          renewed = undefined;
        }
        if (!renewed) {
          leaseState.fenced = true;
          return;
        }
        leaseState.active = renewed;
        this.currentLease = renewed;
      }
    })();
    try {
      await this.process(update, current, signal);
    } finally {
      stop.abort();
      await heartbeat;
      if (leaseState.fenced) {
        this.currentLease = undefined;
        this.markPollFenced();
      }
    }
    if (leaseState.fenced) {
      return undefined;
    }
    return leaseState.active;
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    let current = this.currentLease
      ? await this.repository.renewPollLease(this.currentLease, this.config.poll_lease_ms)
      : await this.repository.acquirePollLease(this.botId, this.ownerId, this.config.poll_lease_ms);
    if (!current) {
      this.currentLease = undefined;
      this.markPollFenced();
      return 0;
    }
    this.currentLease = current;
    const offset = await this.repository.cursor(current);
    if (signal?.aborted) return 0;
    const updates = await this.api.getUpdates(offset, this.config.poll_timeout_seconds, signal);
    for (const update of updates) {
      if (signal?.aborted) break;
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      const renewed = await this.repository.renewPollLease(current, this.config.poll_lease_ms);
      if (!renewed) {
        this.currentLease = undefined;
        this.markPollFenced();
        break;
      }
      current = renewed;
      this.currentLease = current;
      const afterProcess = await this.processWithLeaseHeartbeat(update, current, signal);
      if (!afterProcess) break;
      current = afterProcess;
      this.currentLease = current;
      // This is real per-update progress.  Lease renewal by itself must not keep health green
      // while the same update is hung forever.
      this.observer?.pollCycleHeartbeat(this.config.alias);
    }
    return updates.length;
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.observer?.pollCycleStarted(this.config.alias);
      try {
        const count = await this.runOnce(signal);
        this.observer?.pollCycleSucceeded(this.config.alias, count);
        failures = 0;
        if (count === 0) await sleep(idleMs, signal);
      } catch (error) {
        // An operator-requested shutdown is not a failed poll. The cursor remains at the last
        // completely handled update, so the first unhandled update is replayed after restart.
        if ((signal as unknown as { aborted: boolean }).aborted) break;
        this.observer?.pollCycleFailed(this.config.alias);
        this.onMetric('poll_error');
        failures += 1;
        // Registro de error en el ciclo de polling.
        logJsonLine({
          event: 'telegram_poll_error',
          bot_id: this.botId,
          alias: this.config.alias,
          tenant_id: this.config.tenant_id,
          failures,
          error_name: error instanceof Error ? error.name : undefined,
          error_message: String(error instanceof Error ? error.message : error).slice(0, 400),
          stack: (error instanceof Error ? error.stack ?? '' : '').split('\n').slice(1, 4).join(' | ')
        });
        const exponential = Math.min(60_000, 1_000 * 2 ** Math.min(6, failures - 1));
        const delay = error instanceof TelegramApiError && error.retryAfterMs !== undefined
          ? Math.max(exponential, error.retryAfterMs) : exponential;
        await sleep(delay, signal);
      }
    }
  }
}
