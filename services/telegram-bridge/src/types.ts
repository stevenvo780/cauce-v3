import type { Origin, Tenant } from '@cauce/protocol';

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: TelegramFile[];
  document?: TelegramFile;
  audio?: TelegramFile;
  video?: TelegramFile;
  voice?: TelegramFile;
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

export interface TelegramApi {
  getIdentity(): Promise<TelegramIdentity>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  sendText(chatId: string, text: string): Promise<TelegramSendResult>;
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

export interface TelegramAliasConfig {
  alias: string;
  tenant_id: Tenant;
  room_id: string;
  token_file: string;
  v2_shutdown_marker_file: string;
  allowed_user_ids: readonly string[];
  allowed_chat_ids: readonly string[];
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
  | 'egress_sent' | 'egress_retry' | 'egress_dead' | 'egress_ambiguous';
