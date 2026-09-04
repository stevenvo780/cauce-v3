import { randomUUID } from 'node:crypto';
import { logEvent, type Origin } from '@cauce/protocol';
import type { TelegramActivity } from './activity.js';
import type {
  AddressingDecision, AddressingSelf, FleetDirectory, SuppressionReason
} from './addressing.js';
import { isFleetBot, resolveAddressing, telegramThreadId } from './addressing.js';
import { effectiveChatPolicy, groupRouting } from './config.js';
import {
  id,
  isPrivateChatId,
  isRequestConflict,
  normalizedBody,
  privateContext,
  session,
  suppressionMetric,
  telegramSessionId,
  type AttachmentScreenMeta,
  type BodyContext,
  type PreparedAttachments,
} from './ingress-body.js';
import {
  AlbumAddressing, albumMessage, batchMembers, captionMember, lastUpdateId, MediaGroupBuffer,
  mediaGroupId, messageChatId, prepareMediaGroupAttachments, splitOwnMembers, updateKind,
  updateMessage, type AlbumKey, type UpdateKind
} from './media-group.js';
import { handleOperatorCommand } from './operator-commands/handler.js';
import type { OperatorActions } from './operator-commands/dispatch.js';
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

interface TelegramPollerOptions {
  config: TelegramAliasConfig;
  botId: string;
  api: TelegramApi;
  repository: TelegramCursorRepository;
  ingress: TelegramIngress;
  activity: TelegramActivity;
  ownerId?: string;
  onMetric?: (metric: BridgeMetric) => void;
  observer: TelegramLoopObserver;
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
   * Transcription service for voice notes. Without it the bridge keeps working: the audio
   * messages arrive as before, with their metadata and a notice that they could not be heard.
   */
  transcription?: TranscriptionConfig;
  operatorActions?: OperatorActions;
}

/**
 * One suppressed update, recorded BEFORE the cursor advances. Only a group carries the `group` name.
 *
 * Telegram's getUpdates cursor is destructive: once advanced, an update can never be requested again. The unlabelled
 * `/metrics` counters cannot say WHICH chat went quiet, so a routing mistake (a typo in `default_alias`, a
 * `mode:"off"` left behind, a renamed username) would discard traffic invisibly and irreversibly. This record is ids
 * and enums only — no message text, no display name — so it stays safe to emit to the container log.
 */
interface SuppressedUpdate {
  readonly event: 'telegram_group_update_suppressed' | 'telegram_update_suppressed';
  readonly alias: string;
  readonly tenant_id: string;
  readonly chat_id: string;
  readonly thread_id: string;
  readonly update_id: number;
  readonly message_id: number;
  readonly reason: MemberRefusal | 'update_kind';
  readonly kind?: UpdateKind;
  readonly group_routing: 'legacy' | 'scoped';
  readonly chat_configured: boolean;
}

interface AcceptedMember {
  readonly message: TelegramMessage;
  readonly chatId: string;
  readonly userId: string;
}

/* `album_mismatch` is the one refusal `resolveAddressing` cannot name: the member is addressed, or forgivably
   uncaptioned, but its chat, user or topic is not the album's, so the primary's frame would MOVE it. */
type MemberRefusal = SuppressionReason | 'album_mismatch';

type DroppedMember =
  | { readonly screened: false }
  | { readonly screened: true; readonly member: AcceptedMember; readonly reason: MemberRefusal };

/* The ONE refusal an album's remembered decision may override: it means "this member carries no caption of its own",
   the very loss the coalescer exists to remove. Every other refusal — thread policy, anonymous sender, inline bot,
   bot author, a caption addressed to another fleet alias — is a live judgement on the member's own message. */
const UNCAPTIONED_REFUSAL: SuppressionReason = 'not_addressed';

interface PublishFrame {
  readonly chatId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly group: boolean;
  readonly bucket: string;
  readonly context: BodyContext | undefined;
  readonly scope: SessionScope;
}

function logSuppressedUpdate(record: SuppressedUpdate): void {
  const { event, ...fields } = record;
  logEvent(event, fields);
}


export class TelegramPoller {
  private readonly config: TelegramAliasConfig;
  private readonly botId: string;
  private readonly api: TelegramApi;
  private readonly repository: TelegramCursorRepository;
  private readonly ingress: TelegramIngress;
  private readonly activity: TelegramActivity;
  private readonly ownerId: string;
  private readonly onMetric: (metric: BridgeMetric) => void;
  private readonly observer: TelegramLoopObserver;
  private readonly fleet: FleetDirectory;
  private readonly self: AddressingSelf;
  private readonly participants: ((chatId: string, threadId: string) => ReadonlySet<string>) | undefined;
  private readonly onSuppressed: (record: SuppressedUpdate) => void;
  private readonly transcription: TranscriptionConfig | undefined;
  private readonly operatorActions: OperatorActions | undefined;
  /**
   * Names under which an outsider could try to impersonate a known identity.
   *
   * It comes from the fleet directory that `main.ts` already builds from the deployed config file — aliases and
   * @usernames of the bots — plus this bridge's alias and tenant. NONE of them is hardcoded here: a new alias is
   * covered by the same deployment that registers it, and this module is not a fifth source of truth for the alias map.
   */
  private readonly reservedNames: ReadonlySet<string>;
  private currentLease: PollLease | undefined;
  private readonly buffer = new MediaGroupBuffer();
  private readonly albumAddressing = new AlbumAddressing<AddressingDecision>();

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
    this.operatorActions = options.operatorActions;
    // Reserved fleet names for impersonation detection in groups.
    this.reservedNames = new Set([
      ...this.fleet.byUsername.keys(),
      ...this.fleet.byUsername.values(),
      ...this.fleet.byBotId.values(),
      options.config.alias
    ]);
  }

  private markPollFenced(): void {
    this.onMetric('poll_fenced');
    this.observer.pollCycleFenced(this.config.alias);
  }

  /**
   * Coarse, legacy allowlist filter. Unchanged from the original `allowed()`: it still only looks
   * at message_id, chat id, user id and the two alias-wide allowlists, so a private chat that is
   * accepted today is accepted here too.
   */
  private accepted(update: TelegramUpdate): AcceptedMember | undefined {
    const message = updateKind(update) === 'message' ? update.message : undefined;
    if (!message || !Number.isSafeInteger(message.message_id)) return undefined;
    const chatId = messageChatId(message);
    const userId = id(message.from?.id);
    if (!chatId || !userId) return undefined;
    if (!this.config.allowed_chat_ids.includes(chatId) || !this.config.allowed_user_ids.includes(userId)) return undefined;
    return { message, chatId, userId };
  }

  /** The one audit record of a consumed but unpublished update, always emitted BEFORE the cursor moves. */
  private auditSuppressed(
    update: TelegramUpdate,
    message: TelegramMessage,
    chatId: string,
    threadId: string,
    reason: MemberRefusal | 'update_kind',
    kind: UpdateKind
  ): void {
    if (kind === 'message' && isPrivateChatId(chatId)) return;
    try {
      this.onSuppressed({
        event: isPrivateChatId(chatId) ? 'telegram_update_suppressed' : 'telegram_group_update_suppressed',
        alias: this.config.alias,
        tenant_id: this.config.tenant_id,
        chat_id: chatId,
        thread_id: threadId,
        update_id: update.update_id,
        message_id: message.message_id,
        reason,
        ...(kind === 'message' ? {} : { kind }),
        group_routing: groupRouting(this.config),
        chat_configured: effectiveChatPolicy(this.config, chatId, threadId) !== undefined
      });
    } catch {
      // The trace is best effort; it must never wedge the poller on this update.
    }
  }

  /**
   * Leaves a trace of the group updates that `accepted()` discards before they reach the resolver.
   */
  private reportSilentDrop(update: TelegramUpdate): void {
    const kind = updateKind(update);
    const message = updateMessage(update);
    if (!message || !Number.isSafeInteger(message.message_id)) return;
    const chatId = messageChatId(message);
    if (chatId === undefined) return;
    // Order matters: an anonymous message ALSO fails the user allowlist (Telegram signs it as GroupAnonymousBot),
    // so asking about the user first would hide the real reason behind a 'user_denied' that explains nothing.
    const reason: MemberRefusal | 'update_kind' = kind !== 'message' ? 'update_kind'
      : message.sender_chat !== undefined ? 'anonymous_sender'
        : id(message.from?.id) === undefined ? 'no_author'
          : !this.config.allowed_chat_ids.includes(chatId) ? 'chat_not_allowed'
            : 'user_denied';
    this.auditSuppressed(update, message, chatId, telegramThreadId(message), reason, kind);
  }

  private rejectMember(update: TelegramUpdate): void {
    this.reportSilentDrop(update);
    this.onMetric(updateKind(update) === 'message' ? 'updates_denied' : 'updates_kind_suppressed');
  }

  /** A screened member the album does not carry: its own message, its own live reason, its own metric. */
  private refuseMember(update: TelegramUpdate, member: AcceptedMember, reason: MemberRefusal): void {
    this.auditSuppressed(
      update, member.message, member.chatId, telegramThreadId(member.message), reason, 'message'
    );
    this.onMetric(reason === 'album_mismatch' ? 'updates_denied' : suppressionMetric(reason));
  }

  private resolve(message: TelegramMessage, chatId: string, threadId: string): AddressingDecision {
    return resolveAddressing({
      message,
      self: this.self,
      fleet: this.fleet,
      policy: effectiveChatPolicy(this.config, chatId, threadId),
      groupRouting: groupRouting(this.config),
      ...(this.participants === undefined ? {} : { participants: this.participants(chatId, threadId) })
    });
  }

  /** The `AlbumKey` rule for one screened member: the refusal to audit, or `undefined` when it belongs. */
  private memberRefusal(member: AcceptedMember, album: AlbumKey): MemberRefusal | undefined {
    const threadId = telegramThreadId(member.message);
    const live = this.resolve(member.message, member.chatId, threadId);
    if (!live.addressed && live.reason !== UNCAPTIONED_REFUSAL) return live.reason;
    return member.chatId === album.chatId && member.userId === album.userId && threadId === album.threadId
      ? undefined
      : 'album_mismatch';
  }

  /**
   * Non-textual, authenticated facts about the human and the replied-to message. Only ids and booleans live here
   * because this object ends up inside `origin.metadata`, which the harness renders as trusted context. Every
   * free-text field stays in the body.
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
   * Sanitised, explicitly untrusted identity of the author and of the quoted message. Rendered inside the fenced
   * UNTRUSTED block of the prompt, never inside `origin.metadata`.
   *
   * `scope: 'private'` drops the quoted message excerpt: in a DM the quoted message is almost always the agent's own
   * previous reply, and feeding its own text back in as UNTRUSTED is noise that helps no one. What the private
   * channel lacked was knowing WHO the human is, which is the author.
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

  private attachmentMeta(): AttachmentScreenMeta {
    return { alias: this.config.alias, tenant_id: this.config.tenant_id };
  }

  private async tryOperatorCommand(
    message: TelegramMessage,
    chatId: string,
    userId: string,
    updateId: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.operatorActions === undefined) return false;
    let handled: { reply: string; command: string } | undefined;
    let failed = false;
    try {
      const result = await handleOperatorCommand({
        config: this.config,
        botId: this.botId,
        userId,
        privateChat: isPrivateChatId(chatId),
        text: message.text,
        entities: message.entities,
        updateId,
        botUsername: this.self.username,
        actions: this.operatorActions
      });
      if (result.kind === 'ignored') return false;
      handled = { reply: result.reply, command: result.command };
      if (result.failed) {
        failed = true;
        this.onMetric('operator_command_error');
        logEvent('telegram_operator_command_failed', {
          alias: this.config.alias,
          tenant_id: this.config.tenant_id,
          command: result.command
        });
      }
    } catch (error) {
      failed = true;
      this.onMetric('operator_command_error');
      logEvent('telegram_operator_command_failed', {
        alias: this.config.alias,
        tenant_id: this.config.tenant_id,
        error_name: error instanceof Error ? error.name : undefined
      });
      handled = {
        reply: 'El comando reventó antes de contestarte. No publiqué nada al agente.',
        command: 'error'
      };
    }
    signal?.throwIfAborted();
    try {
      await this.api.sendText(chatId, handled.reply, {
        reply_to_message_id: String(message.message_id)
      });
      if (!failed) this.onMetric('operator_command_ok');
    } catch {
      if (!failed) this.onMetric('operator_command_error');
      logEvent('telegram_operator_command_reply_failed', {
        alias: this.config.alias,
        tenant_id: this.config.tenant_id,
        command: handled.command
      });
    }
    return true;
  }

  private async publish(
    updateId: number,
    message: TelegramMessage,
    prepared: PreparedAttachments | undefined,
    frame: PublishFrame,
    signal?: AbortSignal
  ): Promise<void> {
    const origin: Origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: frame.chatId,
      external_message_id: String(message.message_id),
      relay: [],
      metadata: {
        bridge_alias: this.config.alias,
        bridge_tenant: this.config.tenant_id,
        chat_type: safeText(message.chat.type, 32) ?? 'unknown',
        ...(frame.group ? this.originContext(message, frame.userId, frame.threadId, frame.bucket) : {})
      }
    };
    const body = await normalizedBody(
      message,
      updateId,
      this.api,
      frame.context,
      this.transcription,
      undefined,
      () => { this.onMetric('ingress_secret_redacted'); },
      this.attachmentMeta(),
      prepared
    );
    // Attachment and voice preparation may await remote reads. Shutdown before the durable
    // publish is still side-effect free; once publish starts, cursor advancement must finish.
    signal?.throwIfAborted();
    let result: { duplicate: boolean };
    try {
      result = await this.ingress.publish({
        bot_id: this.botId,
        update_id: updateId,
        tenant_id: this.config.tenant_id,
        alias: this.config.alias,
        room_id: this.config.room_id,
        recipients: this.config.recipients,
        body,
        origin,
        session_id: session(frame.scope, this.botId, frame.chatId, frame.userId, frame.threadId),
        // `accepted()` already proved `userId` is on this alias's `allowed_user_ids`, the operator-maintained
        // allowlist of the people this bot serves. The extra `is_bot` test matters for PRIVATE chats, where
        // `resolveAddressing` deliberately skips its bot-author guard (P0.b runs before P0.d) so that a DM a human
        // sent through a bot keeps working. Failing it here never drops the update — it only denies the human band.
        human: message.from?.is_bot !== true
      });
    } catch (error) {
      if (!isRequestConflict(error)) throw error;
      // idempotency_key is content-free (bot_id+update_id): a conflict proves this update_id is
      // already durable under a body a non-deterministic transcription retry won't match again.
      this.onMetric('updates_conflict');
      result = { duplicate: true };
    }
    if (!result.duplicate && !signal?.aborted) {
      try {
        this.activity.begin({
          alias: this.config.alias,
          api: this.api,
          chatId: frame.chatId,
          messageId: String(message.message_id)
        });
      } catch {
        // Telegram activity is visual only; durable ingress publication already won.
      }
    }
    this.onMetric(result.duplicate ? 'updates_duplicate' : 'updates_allowed');
  }

  private async process(
    batch: readonly TelegramUpdate[],
    current: PollLease,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const consumed = lastUpdateId(batch);
    // The primary is chosen among the members that PASS the allowlist, not by whoever carries the caption: a foreign
    // caption member used to take the whole batch down with it, dragging allowlisted members away with no audit record.
    const screened = new Map<TelegramUpdate, AcceptedMember>();
    for (const update of batch) {
      const member = this.accepted(update);
      if (member !== undefined) screened.set(update, member);
    }
    const primary = captionMember(batch.filter((update) => screened.has(update)));
    const accepted = primary === undefined ? undefined : screened.get(primary);
    if (!accepted || primary === undefined) {
      this.albumAddressing.forget();
      for (const update of batch) this.rejectMember(update);
      signal?.throwIfAborted();
      await this.repository.advanceCursor(current, consumed + 1);
      return;
    }
    const { message, chatId, userId } = accepted;
    const threadId = telegramThreadId(message);
    const policy: TelegramChatPolicy | undefined = effectiveChatPolicy(this.config, chatId, threadId);
    const albumKey: AlbumKey = { id: mediaGroupId(primary), chatId, userId, threadId };
    const { own, refused } = splitOwnMembers(batch, primary, (update): DroppedMember | undefined => {
      const member = screened.get(update);
      if (member === undefined) return { screened: false };
      const reason = this.memberRefusal(member, albumKey);
      return reason === undefined ? undefined : { screened: true, member, reason };
    });
    for (const { update, reason } of refused) {
      if (reason.screened) this.refuseMember(update, reason.member, reason.reason);
      else this.rejectMember(update);
    }
    const live = this.resolve(message, chatId, threadId);
    const decision: AddressingDecision = live.addressed || live.reason !== UNCAPTIONED_REFUSAL
      ? live
      : this.albumAddressing.recall(albumKey) ?? live;
    this.albumAddressing.remember(albumKey, decision);
    if (!decision.addressed) {
      // Consumed without publishing — no delivery row, no wake, no model quota — and audited
      // BEFORE advanceCursor, because past the cursor no update can ever be fetched again.
      for (const update of own) {
        this.auditSuppressed(
          update, updateMessage(update) ?? message, chatId, decision.thread_id, decision.reason, 'message'
        );
        this.onMetric(suppressionMetric(decision.reason));
      }
      signal?.throwIfAborted();
      await this.repository.advanceCursor(current, consumed + 1);
      return;
    }
    // `legacy` publishes exactly what the pre-routing bridge published: no thread, no bucket, no
    // untrusted block, and the legacy `user`-scoped session key.
    const group = decision.reason !== 'private' && decision.reason !== 'legacy';
    /**
     * P8: the DM also carries the human's identity, and `legacy` still carries nothing.
     *
     * `legacy` is a GROUP of an alias that never declared `chats`: its escape hatch is to publish byte-for-byte what
     * it published before the routing change, and adding the untrusted block would break that. The private channel
     * has no such debt: today the agent just sees a chat number, nothing more.
     */
    const context: BodyContext | undefined = group
      ? { threadId, bucket: decision.bucket, untrusted: this.untrustedContext(message, 'group') }
      : decision.reason === 'private'
        ? privateContext(this.untrustedContext(message, 'private'))
        : undefined;
    const frame: PublishFrame = {
      chatId,
      userId,
      threadId,
      group,
      bucket: decision.bucket,
      context,
      scope: policy?.session_scope ?? 'user'
    };
    // The primary names the album: the idempotency key (bot_id + update_id) and `external_message_id`
    // must point at the same message, or a replay names two different updates.
    const updateId = primary.update_id;
    if (own.length === 1 && await this.tryOperatorCommand(message, chatId, userId, updateId, signal)) {
      signal?.throwIfAborted();
      await this.repository.advanceCursor(current, consumed + 1);
      return;
    }
    if (own.length === 1) {
      await this.publish(updateId, message, undefined, frame, signal);
    } else {
      const members = batchMembers(own);
      const album = await prepareMediaGroupAttachments(members, this.api, updateId, this.attachmentMeta());
      const folded = albumMessage(members, primary);
      if (album.fits && folded !== undefined) {
        await this.publish(updateId, folded, album.combined, frame, signal);
      } else {
        for (const member of album.members) {
          await this.publish(member.update.update_id, member.message, member.prepared, frame, signal);
        }
      }
    }
    await this.repository.advanceCursor(current, consumed + 1);
  }

  private async processWithLeaseHeartbeat(
    batch: readonly TelegramUpdate[],
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
      await this.process(batch, current, signal);
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

  private async runBatch(
    batch: readonly TelegramUpdate[],
    current: PollLease,
    signal?: AbortSignal
  ): Promise<PollLease | undefined> {
    const renewed = await this.repository.renewPollLease(current, this.config.poll_lease_ms);
    if (!renewed) {
      this.currentLease = undefined;
      this.markPollFenced();
      return undefined;
    }
    this.currentLease = renewed;
    const after = await this.processWithLeaseHeartbeat(batch, renewed, signal);
    if (!after) return undefined;
    this.currentLease = after;
    // This is real per-update progress.  Lease renewal by itself must not keep health green
    // while the same update is hung forever.
    this.observer.pollCycleHeartbeat(this.config.alias);
    return after;
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    let current = this.currentLease
      ? await this.repository.renewPollLease(this.currentLease, this.config.poll_lease_ms)
      : await this.repository.acquirePollLease(this.botId, this.ownerId, this.config.poll_lease_ms);
    if (!current) {
      this.currentLease = undefined;
      this.buffer.discard();
      this.albumAddressing.forget();
      this.markPollFenced();
      return 0;
    }
    this.currentLease = current;
    this.buffer.beginCycle();
    const offset = await this.repository.cursor(current);
    if (signal?.aborted) return 0;
    const updates = await this.api.getUpdates(offset, this.config.poll_timeout_seconds, signal);
    let live = true;
    for (const update of updates) {
      if (signal?.aborted) break;
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      if (this.buffer.holds(update.update_id)) continue;
      for (const batch of this.buffer.accept(update, Date.now())) {
        const after = await this.runBatch(batch, current, signal);
        if (!after) {
          live = false;
          break;
        }
        current = after;
      }
      if (!live) break;
    }
    if (live && !signal?.aborted) {
      const settled = this.buffer.settled(Date.now());
      if (settled !== undefined && !await this.runBatch(settled, current, signal)) live = false;
    }
    if (!live || signal?.aborted === true) {
      this.buffer.discard();
      this.albumAddressing.forget();
    }
    return updates.length;
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.observer.pollCycleStarted(this.config.alias);
      try {
        const count = await this.runOnce(signal);
        this.observer.pollCycleSucceeded(this.config.alias, count);
        failures = 0;
        if (count === 0) await sleep(idleMs, signal);
      } catch (error) {
        // An operator-requested shutdown is not a failed poll. The cursor remains at the last
        // completely handled update, so the first unhandled update is replayed after restart.
        if ((signal as unknown as { aborted: boolean }).aborted) break;
        this.observer.pollCycleFailed(this.config.alias);
        this.onMetric('poll_error');
        failures += 1;
        // Error log entry for the polling cycle.
        logEvent('telegram_poll_error', {
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
