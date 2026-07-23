import { createHash, randomUUID } from 'node:crypto';
import type { Origin } from '@cauce/protocol';
import type {
  BridgeMetric, PollLease, TelegramAliasConfig, TelegramApi, TelegramCursorRepository,
  TelegramFile, TelegramIngress, TelegramMessage, TelegramUpdate
} from './types.js';
import { TelegramApiError } from './telegram.js';

export interface TelegramPollerOptions {
  config: TelegramAliasConfig;
  botId: string;
  api: TelegramApi;
  repository: TelegramCursorRepository;
  ingress: TelegramIngress;
  ownerId?: string;
  onMetric?: (metric: BridgeMetric) => void;
}

function id(value: unknown): string | undefined {
  return Number.isSafeInteger(value) ? String(value) : undefined;
}

function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const characters = [...value.split('\u0000').join('')];
  if (characters.length === 0) return undefined;
  return characters.slice(0, limit).join('');
}

function safeFile(file: TelegramFile | undefined, kind: string): Record<string, unknown> | undefined {
  if (!file || typeof file.file_id !== 'string' || file.file_id.length > 512 || file.file_id.length === 0) return undefined;
  return {
    kind,
    file_id: file.file_id,
    ...(typeof file.file_unique_id === 'string' && file.file_unique_id.length <= 256
      ? { file_unique_id: file.file_unique_id } : {}),
    ...(Number.isSafeInteger(file.file_size) && Number(file.file_size) >= 0
      ? { file_size: file.file_size } : {}),
    ...(typeof file.mime_type === 'string' && file.mime_type.length <= 128
      ? { mime_type: file.mime_type } : {})
  };
}

function media(message: TelegramMessage): Record<string, unknown>[] {
  const result: Array<Record<string, unknown> | undefined> = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) result.push(safeFile(message.photo.at(-1), 'photo'));
  result.push(safeFile(message.document, 'document'));
  result.push(safeFile(message.audio, 'audio'));
  result.push(safeFile(message.video, 'video'));
  result.push(safeFile(message.voice, 'voice'));
  result.push(safeFile(message.animation, 'animation'));
  return result.filter((entry): entry is Record<string, unknown> => entry !== undefined).slice(0, 8);
}

function normalizedBody(message: TelegramMessage, updateId: number): Record<string, unknown> {
  const attachments = media(message);
  return {
    type: 'telegram.message',
    update_id: updateId,
    message_id: message.message_id,
    chat_type: safeText(message.chat.type, 32) ?? 'unknown',
    ...(safeText(message.text, 4_096) === undefined ? {} : { text: safeText(message.text, 4_096) }),
    ...(safeText(message.caption, 1_024) === undefined ? {} : { caption: safeText(message.caption, 1_024) }),
    ...(attachments.length === 0 ? {} : { media: attachments })
  };
}

function session(botId: string, chatId: string, userId: string): string {
  return `tg-${createHash('sha256').update(`${botId}:${chatId}:${userId}`).digest('hex')}`;
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

export class TelegramPoller {
  private readonly config: TelegramAliasConfig;
  private readonly botId: string;
  private readonly api: TelegramApi;
  private readonly repository: TelegramCursorRepository;
  private readonly ingress: TelegramIngress;
  private readonly ownerId: string;
  private readonly onMetric: (metric: BridgeMetric) => void;
  private currentLease: PollLease | undefined;

  constructor(options: TelegramPollerOptions) {
    this.config = options.config;
    this.botId = options.botId;
    this.api = options.api;
    this.repository = options.repository;
    this.ingress = options.ingress;
    this.ownerId = options.ownerId ?? `telegram-poller:${randomUUID()}`;
    this.onMetric = options.onMetric ?? (() => undefined);
  }

  private allowed(update: TelegramUpdate): {
    message: TelegramMessage; chatId: string; userId: string;
  } | undefined {
    const message = update.message;
    if (!message || !Number.isSafeInteger(message.message_id)) return undefined;
    const chatId = id(message.chat?.id);
    const userId = id(message.from?.id);
    if (!chatId || !userId) return undefined;
    if (!this.config.allowed_chat_ids.includes(chatId) || !this.config.allowed_user_ids.includes(userId)) return undefined;
    return { message, chatId, userId };
  }

  private async process(update: TelegramUpdate, current: PollLease): Promise<void> {
    const accepted = this.allowed(update);
    if (!accepted) {
      this.onMetric('updates_denied');
      await this.repository.advanceCursor(current, update.update_id + 1);
      return;
    }
    const origin: Origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: accepted.chatId,
      external_message_id: String(accepted.message.message_id),
      relay: [],
      metadata: {
        bridge_alias: this.config.alias,
        chat_type: safeText(accepted.message.chat.type, 32) ?? 'unknown'
      }
    };
    const result = await this.ingress.publish({
      bot_id: this.botId,
      update_id: update.update_id,
      tenant_id: this.config.tenant_id,
      alias: this.config.alias,
      room_id: this.config.room_id,
      recipients: this.config.recipients,
      body: normalizedBody(accepted.message, update.update_id),
      origin,
      session_id: session(this.botId, accepted.chatId, accepted.userId)
    });
    this.onMetric(result.duplicate ? 'updates_duplicate' : 'updates_allowed');
    await this.repository.advanceCursor(current, update.update_id + 1);
  }

  async runOnce(): Promise<number> {
    let current = this.currentLease
      ? await this.repository.renewPollLease(this.currentLease, this.config.poll_lease_ms)
      : await this.repository.acquirePollLease(this.botId, this.ownerId, this.config.poll_lease_ms);
    if (!current) {
      this.currentLease = undefined;
      this.onMetric('poll_fenced');
      return 0;
    }
    this.currentLease = current;
    const offset = await this.repository.cursor(current);
    const updates = await this.api.getUpdates(offset, this.config.poll_timeout_seconds);
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      const renewed = await this.repository.renewPollLease(current, this.config.poll_lease_ms);
      if (!renewed) {
        this.currentLease = undefined;
        this.onMetric('poll_fenced');
        break;
      }
      current = renewed;
      this.currentLease = current;
      await this.process(update, current);
    }
    return updates.length;
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const count = await this.runOnce();
        failures = 0;
        if (count === 0) await sleep(idleMs, signal);
      } catch (error) {
        failures += 1;
        const exponential = Math.min(60_000, 1_000 * 2 ** Math.min(6, failures - 1));
        const delay = error instanceof TelegramApiError && error.retryAfterMs !== undefined
          ? Math.max(exponential, error.retryAfterMs) : exponential;
        if (!signal.aborted) await sleep(delay, signal);
      }
    }
  }
}

export { normalizedBody };
