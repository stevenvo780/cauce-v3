import type { Origin, Tenant } from '@cauce/protocol';

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
  /** Segundos. Sólo lo mandan voice/audio/video/video_note. */
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
   * `html` hace que Telegram renderice negritas, código y citas en vez de mostrar el marcado
   * crudo. Ausente = texto plano, que es como se comportó siempre este puente.
   */
  parse_mode?: 'html';
}

export interface TelegramApi {
  getIdentity(): Promise<TelegramIdentity>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  getFile(fileId: string): Promise<TelegramRemoteFile>;
  downloadFile(filePath: string, maxBytes: number): Promise<Buffer>;
  sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<TelegramSendResult>;
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

export interface TelegramOriginRelayAck {
  event_id: string;
  attempt: number;
  claim_token: string;
  status: 'sent' | 'retry' | 'dead';
  error?: string;
  retry_after_ms?: number;
  /** Required for sent ACKs. The repository verifies every durable chunk before ACKing. */
  effect_count?: number;
}

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
  ack(acknowledgement: TelegramOriginRelayAck): Promise<void>;
  prepareEffect(effect: TelegramEffectInput): Promise<TelegramEffect>;
  beginEffect(effectId: string, payloadHash: string): Promise<TelegramEffect>;
  resetPrepared(effectId: string, payloadHash: string): Promise<void>;
  completeEffect(effectId: string, payloadHash: string, providerMessageId: string): Promise<void>;
  markEffectAmbiguous(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect>;
  markEffectDead(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect>;
  getEffect(effectId: string): Promise<TelegramEffect | undefined>;
  /** Explicit operator action. It never replays sent or in-flight effects. */
  manualReplayEffect(effectId: string, payloadHash: string, reason: string): Promise<TelegramEffect>;
}

export type BridgeMetric =
  | 'updates_allowed' | 'updates_denied' | 'updates_duplicate' | 'poll_fenced'
  | 'updates_unaddressed' | 'updates_echo_suppressed' | 'updates_mention_unserved'
  | 'updates_suppressed_bot' | 'updates_via_bot'
  | 'updates_chat_denied' | 'updates_chat_disabled' | 'updates_conflict'
  | 'group_config_degraded'
  | 'egress_sent' | 'egress_retry' | 'egress_dead' | 'egress_ambiguous'
  // Telegram rechazó el HTML y el mensaje salió en texto plano. Si este contador sube, la
  // conversión de markdown está generando algo que Telegram no acepta y hay que mirarla.
  | 'egress_format_downgraded';
