import { TELEGRAM_ACTIVITY_REACTIONS } from './types.js';
import type {
  TelegramApi, TelegramChatAction, TelegramIdentity, TelegramMessage, TelegramReactionEmoji,
  TelegramRemoteFile, TelegramSendOptions, TelegramSendResult, TelegramUpdate
} from './types.js';

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const ACTIVITY_REACTIONS = new Set<string>(TELEGRAM_ACTIVITY_REACTIONS);

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly outcomeKnown = true
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramHttpClientOptions {
  token: string;
  fetcher?: typeof fetch;
  apiBase?: string;
  requestTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TelegramApiError('Telegram returned malformed JSON', true);
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TelegramApiError(`Telegram returned invalid ${name}`, true);
  return Number(value);
}

export function validTelegramChatId(value: string): boolean {
  if (!/^-?[1-9][0-9]{0,19}$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= -9_223_372_036_854_775_808n && parsed <= 9_223_372_036_854_775_807n;
}

export function validTelegramMessageId(value: string): boolean {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function parseUpdate(value: unknown): TelegramUpdate {
  const row = record(value);
  const update: TelegramUpdate = { update_id: safeInteger(row.update_id, 'update_id') };
  if (row.message !== undefined) update.message = record(row.message) as unknown as TelegramMessage;
  return update;
}

export class TelegramHttpClient implements TelegramApi {
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;

  constructor(options: TelegramHttpClientOptions) {
    if (!/^[0-9]{6,20}:[A-Za-z0-9_-]{20,200}$/.test(options.token)) throw new Error('invalid Telegram token');
    this.fetcher = options.fetcher ?? fetch;
    const base = options.apiBase ?? 'https://api.telegram.org';
    if (!/^https:\/\//.test(base) && process.env.NODE_ENV !== 'test') throw new Error('Telegram API base must use HTTPS');
    this.endpoint = `${base.replace(/\/$/, '')}/bot${options.token}`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 65_000;
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<T> {
    let response: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      response = await this.fetcher(`${this.endpoint}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: externalSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([externalSignal, timeoutSignal])
      });
    } catch {
      throw new TelegramApiError('Telegram request outcome is unknown', false, undefined, false);
    }
    let decoded: TelegramResponse<T>;
    try {
      decoded = await response.json() as TelegramResponse<T>;
    } catch {
      // A successful HTTP status with an unreadable body may already represent an accepted
      // sendMessage. Retrying it automatically can duplicate a human-visible reply.
      throw new TelegramApiError(
        'Telegram returned malformed JSON',
        !response.ok && response.status >= 500,
        undefined,
        !response.ok
      );
    }
    if (response.ok && decoded.ok && decoded.result !== undefined) return decoded.result;
    if (response.ok) {
      throw new TelegramApiError('Telegram successful response had no result', false, undefined, false);
    }
    const retryAfter = decoded.parameters?.retry_after;
    const retryAfterMs = Number.isInteger(retryAfter) && Number(retryAfter) > 0
      ? Math.min(3_600_000, Number(retryAfter) * 1_000)
      : undefined;
    const code = decoded.error_code ?? response.status;
    const retryable = code === 429 || code >= 500;
    throw new TelegramApiError(`Telegram API returned ${code}`, retryable, retryAfterMs, true);
  }

  async getIdentity(): Promise<TelegramIdentity> {
    const result = record(await this.call<unknown>('getMe', {}));
    const id = result.id;
    if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new TelegramApiError('Telegram returned invalid bot identity', false);
    return {
      id: String(id),
      ...(typeof result.username === 'string' ? { username: result.username } : {})
    };
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const result = await this.call<unknown[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      limit: 100,
      allowed_updates: ['message']
    });
    if (!Array.isArray(result)) throw new TelegramApiError('Telegram returned invalid updates', true);
    return result.map(parseUpdate).sort((left, right) => left.update_id - right.update_id);
  }

  async getFile(fileId: string): Promise<TelegramRemoteFile> {
    if (fileId.length < 1 || fileId.length > 512) throw new TelegramApiError('invalid Telegram file id', false);
    let raw: unknown;
    try {
      raw = await this.call<unknown>('getFile', { file_id: fileId });
    } catch (error) {
      // Unlike sendMessage, getFile is read-only: an unknown transport outcome is always safe to retry.
      if (error instanceof TelegramApiError && !error.outcomeKnown) {
        throw new TelegramApiError('Telegram getFile request failed', true);
      }
      throw error;
    }
    const result = record(raw);
    if (typeof result.file_id !== 'string' || typeof result.file_path !== 'string') {
      throw new TelegramApiError('Telegram returned invalid file metadata', true);
    }
    const fileSize = result.file_size;
    if (fileSize !== undefined && (!Number.isSafeInteger(fileSize) || Number(fileSize) < 0)) {
      throw new TelegramApiError('Telegram returned invalid file size', true);
    }
    return {
      file_id: result.file_id,
      file_path: result.file_path,
      ...(typeof result.file_unique_id === 'string' ? { file_unique_id: result.file_unique_id } : {}),
      ...(fileSize === undefined ? {} : { file_size: Number(fileSize) })
    };
  }

  async downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TelegramApiError('invalid download limit', false);
    if (filePath.length < 1 || filePath.length > 1_024 || filePath.startsWith('/') ||
        filePath.includes('\\') || filePath.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/u.test(filePath)) {
      throw new TelegramApiError('invalid Telegram file path', false);
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint.replace('/bot', '/file/bot')}/${filePath}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch {
      throw new TelegramApiError('Telegram file download failed', true);
    }
    if (!response.ok) {
      throw new TelegramApiError(
        `Telegram file download returned ${response.status}`,
        response.status === 429 || response.status >= 500
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new TelegramApiError('Telegram file exceeds configured limit', false);
    }
    if (response.body === null) throw new TelegramApiError('Telegram file response had no body', true);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new TelegramApiError('Telegram file exceeds configured limit', false);
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError('Telegram file download was interrupted', true);
    }
    return Buffer.concat(chunks, total);
  }

  async sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<TelegramSendResult> {
    if (!validTelegramChatId(chatId)) throw new TelegramApiError('invalid Telegram destination', false);
    if (text.length === 0 || [...text].length > 4_096) throw new TelegramApiError('Telegram text exceeds safe limit', false);
    // `external_message_id` is a free string of up to 256 chars read back from durable outbox
    // rows, so it can be old or foreign. A malformed id must never turn a perfectly sendable
    // reply into a 400 (and therefore a dead effect): drop the hint and send the message loose.
    const threadId = options?.message_thread_id;
    const replyTo = options?.reply_to_message_id;
    const raw = await this.call<unknown>('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      // Sin parse_mode Telegram muestra el marcado crudo (`##`, `**`, las vallas de código) en
      // medio del texto, que es como llegaban los informes de la flota hasta el 2026-07-27.
      ...(options?.parse_mode === 'html' ? { parse_mode: 'HTML' } : {}),
      ...(threadId !== undefined && validTelegramMessageId(threadId)
        ? { message_thread_id: Number(threadId) } : {}),
      ...(replyTo !== undefined && validTelegramMessageId(replyTo)
        // allow_sending_without_reply keeps a deleted original from making the chunk dead forever.
        ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {})
    });
    let result: Record<string, unknown>;
    try {
      result = record(raw);
    } catch {
      throw new TelegramApiError('Telegram accepted sendMessage with a malformed result', false, undefined, false);
    }
    const messageId = result.message_id;
    if (!Number.isSafeInteger(messageId) || Number(messageId) < 1) {
      throw new TelegramApiError('Telegram accepted sendMessage with an invalid message id', false, undefined, false);
    }
    return { message_id: String(messageId) };
  }

  async setMessageReaction(
    chatId: string,
    messageId: string,
    reaction: TelegramReactionEmoji,
    signal?: AbortSignal
  ): Promise<void> {
    if (!validTelegramChatId(chatId)) throw new TelegramApiError('invalid Telegram reaction destination', false);
    if (!validTelegramMessageId(messageId)) throw new TelegramApiError('invalid Telegram reaction message id', false);
    if (!ACTIVITY_REACTIONS.has(reaction)) {
      throw new TelegramApiError('invalid Telegram reaction', false);
    }
    const result = await this.call<unknown>('setMessageReaction', {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji: reaction }],
      is_big: false
    }, signal);
    if (result !== true) {
      throw new TelegramApiError(
        'Telegram accepted setMessageReaction with an invalid result',
        false,
        undefined,
        false
      );
    }
  }

  async sendChatAction(
    chatId: string,
    action: TelegramChatAction,
    signal?: AbortSignal
  ): Promise<void> {
    if (!validTelegramChatId(chatId)) throw new TelegramApiError('invalid Telegram chat action destination', false);
    if (action !== 'typing') throw new TelegramApiError('invalid Telegram chat action', false);
    const result = await this.call<unknown>('sendChatAction', {
      chat_id: chatId,
      action
    }, signal);
    if (result !== true) {
      throw new TelegramApiError(
        'Telegram accepted sendChatAction with an invalid result',
        false,
        undefined,
        false
      );
    }
  }
}
