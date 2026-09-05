import type { Origin, OutboxAckWithEffectCount, Tenant } from '@cauce/protocol';

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
  /** Seconds. Only voice/audio/video/video_note send it. */
  duration?: number;
}

export interface TelegramRemoteFile extends TelegramFile {
  file_path: string;
}

export interface PreparedTelegramAttachment {
  kind: 'image' | 'document';
  name: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  content_base64: string;
}

/**
 * Wire shapes below mirror what Telegram already sends. `parseUpdate` casts the raw
 * record without validating anything inside `message`, so every field here is untrusted
 * input: consumers must re-validate before using a value (ids through `id()`, free text
 * through `safeText`/`safeInline`, entity offsets inside the addressing resolver).
 */
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramEntity {
  /** 'mention' | 'text_mention' | 'bot_command' | ... */
  type: string;
  /** Offset in UTF-16 code units over the raw text. */
  offset: number;
  length: number;
  /** Only present on `text_mention`. */
  user?: TelegramUser;
}

export interface TelegramReplyTo {
  message_id: number;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  /** Anonymous group admin or channel post. Present without a human `from`. */
  sender_chat?: { id: number };
  via_bot?: TelegramUser;
  chat: { id: number; type: string };
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  media_group_id?: string;
  reply_to_message?: TelegramReplyTo;
  photo?: TelegramFile[];
  document?: TelegramFile;
  audio?: TelegramFile;
  video?: TelegramFile;
  voice?: TelegramFile;
  video_note?: TelegramFile;
  animation?: TelegramFile;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramIdentity {
  id: string;
  username?: string;
}

export interface TelegramSendResult {
  message_id: string;
}

export const TELEGRAM_ACTIVITY_REACTIONS = ['👀', '🤔', '👍', '👎'] as const;
export type TelegramReactionEmoji = typeof TELEGRAM_ACTIVITY_REACTIONS[number];
export type TelegramChatAction = 'typing';

/**
 * Optional threading hints for a single outbound message. Both ids are Telegram
 * message ids as strings; the transport validates them and silently drops an invalid
 * one rather than turning a sendable reply into a dead effect.
 */
export interface TelegramSendOptions {
  reply_to_message_id?: string;
  message_thread_id?: string;
  /**
   * `html` makes Telegram render bold, code and quotes instead of showing the raw markup.
   * Absent = plain text, which is how this bridge has always behaved.
   */
  parse_mode?: 'html';
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export interface TelegramBotCommandScope {
  readonly type: 'all_private_chats';
}

/** A file ready to upload. Bytes are already validated by `planArtifacts`. */
export interface TelegramUpload {
  readonly kind: 'photo' | 'document';
  readonly name: string;
  readonly mime_type: string;
  readonly bytes: Buffer;
  /** Short text that Telegram shows below the file. */
  readonly caption?: string;
}

export interface TelegramApi {
  getIdentity(): Promise<TelegramIdentity>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  getFile(fileId: string): Promise<TelegramRemoteFile>;
  downloadFile(filePath: string, maxBytes: number): Promise<Buffer>;
  sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<TelegramSendResult>;
  /**
   * Byte uploads. OPTIONAL on purpose.
   *
   * The invariant of this service is that an attachment cannot cost the text: if a
   * `TelegramApi` implementation does not know how to upload files, egress detects it and sends a
   * line explaining why it did not happen, instead of breaking the delivery. Declaring them
   * required would make that failure surface as a compile-time type error and a runtime
   * exception, which is exactly the opposite of what is needed here.
   */
  sendPhoto?(chatId: string, upload: TelegramUpload, options?: TelegramSendOptions): Promise<TelegramSendResult>;
  sendDocument?(chatId: string, upload: TelegramUpload, options?: TelegramSendOptions): Promise<TelegramSendResult>;
  setMyCommands?(
    commands: readonly TelegramBotCommand[],
    scope?: TelegramBotCommandScope
  ): Promise<void>;
  setMessageReaction(
    chatId: string,
    messageId: string,
    reaction: TelegramReactionEmoji,
    signal?: AbortSignal
  ): Promise<void>;
  sendChatAction(chatId: string, action: TelegramChatAction, signal?: AbortSignal): Promise<void>;
}

export interface BridgeRecipient {
  tenant_id: Tenant;
  alias: string;
}

/** How a bot decides whether a group message is for it. */
export type TelegramChatMode = 'mention' | 'always' | 'off';

/**
 * Which conversation the authenticated session key is derived from.
 * `user` reproduces the legacy key byte for byte and stays the default.
 */
export type SessionScope = 'user' | 'chat' | 'thread';

export interface TelegramThreadPolicyConfig {
  thread_id: string;
  mode?: TelegramChatMode;
  allowed_user_ids?: readonly string[];
  /** Absent inherits the chat entry; `null` removes the host; a string must be the owning alias. */
  default_alias?: string | null;
  session_scope?: SessionScope;
  reply_to_origin?: boolean;
}

export interface TelegramChatPolicyConfig {
  chat_id: string;
  mode: TelegramChatMode;
  /** Absent means "inherit the alias-wide allowlist"; present narrows it further. */
  allowed_user_ids?: readonly string[];
  default_alias?: string | null;
  session_scope: SessionScope;
  reply_to_origin: boolean;
  threads: readonly TelegramThreadPolicyConfig[];
}

/** Thread-merged policy handed to the pure addressing resolver. */
export interface TelegramChatPolicy {
  chat_id: string;
  thread_id: string;
  mode: TelegramChatMode;
  allowed_user_ids?: readonly string[] | undefined;
  /** Present only when this alias is the declared host of the scope. */
  default_alias?: string | undefined;
  session_scope: SessionScope;
  reply_to_origin: boolean;
}

export interface TelegramAliasConfig {
  alias: string;
  tenant_id: Tenant;
  room_id: string;
  token_file: string;
  v2_shutdown_marker_file: string;
  /** Telegram @username of this bot, without '@'. Required once any alias declares `chats`. */
  bot_username?: string;
  allowed_user_ids: readonly string[];
  allowed_chat_ids: readonly string[];
  /**
   * Per-chat participation, and the opt-in switch for group routing.
   *
   * ABSENT (`undefined`) means the alias never opted in: every group keeps the pre-routing
   * behaviour driven by `allowed_chat_ids` alone, which is what makes a code-before-config
   * rollout safe. PRESENT (even as `[]`) opts the alias into default-deny: a group without a
   * matching entry is denied on ingress and on egress.
   */
  chats?: readonly TelegramChatPolicyConfig[];
  recipients: readonly BridgeRecipient[];
  poll_timeout_seconds: number;
  poll_lease_ms: number;
  operator_commands?: boolean;
  operator_user_ids?: readonly string[];
}

export interface TelegramBridgeConfig {
  aliases: readonly TelegramAliasConfig[];
}

export interface PollLease {
  bot_id: string;
  owner_id: string;
  epoch: number;
  lease_until: Date;
}

export interface TelegramCursorRepository {
  initializeCursor(botId: string, tenantId: Tenant, alias: string): Promise<void>;
  acquirePollLease(botId: string, ownerId: string, leaseMs: number): Promise<PollLease | undefined>;
  renewPollLease(lease: PollLease, leaseMs: number): Promise<PollLease | undefined>;
  cursor(lease: PollLease): Promise<number>;
  advanceCursor(lease: PollLease, nextUpdateId: number): Promise<void>;
}

export interface TelegramIngressMessage {
  bot_id: string;
  update_id: number;
  tenant_id: Tenant;
  alias: string;
  room_id: string;
  recipients: readonly BridgeRecipient[];
  body: Record<string, unknown>;
  origin: Origin;
  session_id: string;
  /**
   * The update was authored by a PERSON, which is what earns the reserved human priority band.
   *
   * It is derived, never configured: the poller only reaches here after `accepted()` matched
   * `allowed_user_ids` — the operator-maintained allowlist of the humans this bot serves — and the
   * flag additionally requires `from.is_bot !== true`. Both facts come from the alias config and
   * the Telegram wire record, so no alias, chat or user id is written into the code.
   */
  human: boolean;
}

export interface TelegramIngress {
  publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }>;
}

export interface TelegramOriginRelay {
  event_id: string;
  attempt: number;
  max_attempts: number;
  claim_token: string;
  tenant_id: Tenant;
  adapter: string;
  origin: Origin;
  payload: Record<string, unknown>;
}

export type TelegramOriginRelayAck = OutboxAckWithEffectCount;

export type EffectState = 'prepared' | 'sending' | 'sent' | 'ambiguous' | 'dead';

export interface TelegramEffect {
  effect_id: string;
  outbox_id: string;
  tenant_id: Tenant;
  bridge_alias: string;
  chunk_index: number;
  chunk_count: number;
  payload_hash: string;
  state: EffectState;
  provider_message_id?: string;
  diagnostic?: string;
  diagnosed_at?: Date;
  replay_count: number;
  replayed_at?: Date;
}

export type TelegramEffectInput = Omit<
  TelegramEffect,
  'state' | 'provider_message_id' | 'diagnostic' | 'diagnosed_at' | 'replay_count' | 'replayed_at'
>;

export interface TelegramEgressRepository {
  claim(workerId: string, limit: number, leaseMs: number): Promise<TelegramOriginRelay[]>;
  /** Extend only the exact still-live attempt/claim token before another remote side effect. */
  renew(event: TelegramOriginRelay, leaseMs: number): Promise<boolean>;
  ack(acknowledgement: TelegramOriginRelayAck): Promise<void>;
  prepareEffect(effect: TelegramEffectInput): Promise<TelegramEffect>;
  beginEffect(effectId: string, payloadHash: string): Promise<TelegramEffect>;
  resetPrepared(effectId: string, payloadHash: string): Promise<void>;
  completeEffect(effectId: string, payloadHash: string, providerMessageId: string): Promise<void>;
  markEffectAmbiguous(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect>;
  markEffectDead(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect>;
  getEffect(effectId: string): Promise<TelegramEffect | undefined>;
  /**
   * Explicit operator action. It never replays sent or in-flight effects, and the caller must
   * supply a control-authorized actor plus an explicit acknowledgement that Telegram may already
   * have accepted the effect.
   */
  manualReplayEffect(
    chunkIndex: number,
    payloadHash: string,
    reason: string,
    actorTenant: Tenant,
    actorAlias: string,
    duplicateRiskAcknowledged: boolean,
    requestId: string,
    deadLetterId: string,
    incidentEvidenceSha256: string,
    expectedReplayCount: number
  ): Promise<TelegramEffect>;
}

export type BridgeMetric =
  | 'updates_allowed' | 'updates_denied' | 'updates_duplicate' | 'poll_fenced' | 'poll_error'
  | 'updates_unaddressed' | 'updates_echo_suppressed' | 'updates_mention_unserved'
  | 'updates_suppressed_bot' | 'updates_via_bot'
  | 'updates_chat_denied' | 'updates_chat_disabled' | 'updates_conflict'
  | 'updates_kind_suppressed'
  | 'group_config_degraded'
  | 'egress_sent' | 'egress_retry' | 'egress_dead' | 'egress_ambiguous' | 'egress_fenced'
  | 'egress_loop_error'
  // Telegram rejected the HTML and the message went out as plain text. If this counter climbs,
  // the markdown conversion is producing something Telegram will not accept and must be looked at.
  | 'egress_format_downgraded'
  // Attachments. `uploaded` are bytes that reached the chat; `listed` are artifacts that could
  // only be named (link or agent path); `upload_failed` is an upload Telegram rejected and that
  // ended up as a text line. If `listed` is high and `uploaded` is zero, agents are still
  // returning paths instead of bytes and the work is not done.
  | 'egress_attachment_uploaded' | 'egress_attachment_listed' | 'egress_attachment_upload_failed'
  // At least one secret was redacted in an incoming message before persisting it.
  | 'ingress_secret_redacted'
  | 'operator_command_ok' | 'operator_command_error';
