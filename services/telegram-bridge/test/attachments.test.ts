import { describe, expect, it } from 'vitest';
import { prepareTelegramAttachments } from '../src/attachments.js';
import { TelegramPoller } from '../src/poller.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import type {
  PollLease, TelegramApi, TelegramEntity, TelegramMessage, TelegramRemoteFile, TelegramUpdate
} from '../src/types.js';
import {
  config, DeduplicatingIngress, FakeTelegram, MemoryCursorRepository, noopActivity,
  noopObserver
} from './bridge-fixtures.js';

class AttachmentTelegram implements TelegramApi {
  readonly files = new Map<string, TelegramRemoteFile>();
  readonly payloads = new Map<string, Buffer>();
  downloaded: { path: string; maxBytes: number }[] = [];

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }
  async getUpdates(): Promise<[]> { return []; }
  async sendText(): Promise<{ message_id: string }> { return { message_id: '1' }; }
  async setMessageReaction(): Promise<void> { /* noop */ }
  async sendChatAction(): Promise<void> { /* noop */ }

  async getFile(fileId: string): Promise<TelegramRemoteFile> {
    const file = this.files.get(fileId);
    if (!file) throw new Error('missing fixture');
    return file;
  }

  async downloadFile(path: string, maxBytes: number): Promise<Buffer> {
    this.downloaded.push({ path, maxBytes });
    const payload = this.payloads.get(path);
    if (!payload) throw new Error('missing fixture payload');
    return payload;
  }
}

function message(overrides: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 1,
    from: { id: 101 },
    chat: { id: 201, type: 'private' },
    ...overrides
  };
}

describe('Telegram attachment preparation', () => {
  it('uses getFile plus the authenticated file endpoint without exposing the token in errors', async () => {
    const token = '123456:abcdefghijklmnopqrstuvwxyz_ABCDE';
    const urls: string[] = [];
    const client = new TelegramHttpClient({
      token,
      apiBase: 'https://telegram.invalid',
      fetcher: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        if (url.endsWith('/getFile')) {
          return new Response(JSON.stringify({
            ok: true,
            result: { file_id: 'photo-id', file_path: 'photos/photo.jpg', file_size: 7 }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
          status: 200, headers: { 'content-length': '7' }
        });
      }
    });

    const remote = await client.getFile('photo-id');
    const payload = await client.downloadFile(remote.file_path, 10);

    expect(remote).toMatchObject({ file_path: 'photos/photo.jpg', file_size: 7 });
    expect(payload).toHaveLength(7);
    expect(urls).toEqual([
      `https://telegram.invalid/bot${token}/getFile`,
      `https://telegram.invalid/file/bot${token}/photos/photo.jpg`
    ]);

    const rejecting = new TelegramHttpClient({
      token,
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response(JSON.stringify({ ok: false, error_code: 400 }), {
        status: 400, headers: { 'content-type': 'application/json' }
      })
    });
    const error = await rejecting.getFile('photo-id').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String(error)).not.toContain(token);

    const interrupted = new TelegramHttpClient({
      token,
      apiBase: 'https://telegram.invalid',
      fetcher: async () => { throw new Error('network down'); }
    });
    await expect(interrupted.getFile('photo-id')).rejects.toMatchObject({ retryable: true });
  });

  it('rejects oversized and traversal-shaped files without downloading unsafe input', async () => {
    const api = new AttachmentTelegram();
    api.files.set('too-big', { file_id: 'too-big', file_path: 'documents/report.pdf', file_size: 10_000_001 });
    api.files.set('traversal', { file_id: 'traversal', file_path: '../secret.txt', file_size: 3 });

    for (const document of [
      { file_id: 'too-big', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 10_000_001 },
      { file_id: 'traversal', file_name: '../secret.txt', mime_type: 'text/plain', file_size: 3 }
    ]) {
      const result = await prepareTelegramAttachments(message({ document }), api);
      expect(result.media).toEqual([]);
      expect(result.errors[0]).toMatch(/excede|nombre|ruta/u);
    }
    expect(api.downloaded).toEqual([]);
  });
});

class CountingCursors extends MemoryCursorRepository {
  readonly advances: number[] = [];

  override async advanceCursor(lease: PollLease, nextUpdateId: number): Promise<void> {
    this.advances.push(nextUpdateId);
    await super.advanceCursor(lease, nextUpdateId);
  }
}

function jpeg(size: number): Buffer {
  const payload = Buffer.alloc(size);
  payload.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return payload;
}

function album(
  api: FakeTelegram,
  updateId: number,
  groupId: string,
  options: {
    size?: number; caption?: string; chatId?: number; entities?: TelegramEntity[];
    fromId?: number; withoutChat?: boolean;
  } = {}
): TelegramUpdate {
  const { size = 32, caption, chatId = 201, entities, fromId = 101, withoutChat = false } = options;
  const fileId = `alb-${String(updateId)}`;
  const path = `photos/${fileId}.jpg`;
  api.files.set(fileId, { file_id: fileId, file_path: path, file_size: size });
  api.filePayloads.set(path, jpeg(size));
  const message: TelegramMessage = {
    message_id: updateId + 100,
    from: { id: fromId },
    chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
    media_group_id: groupId,
    ...(caption === undefined ? {} : { caption }),
    ...(entities === undefined ? {} : { caption_entities: entities }),
    photo: [{ file_id: fileId, file_size: size }]
  };
  if (withoutChat) delete (message as { chat?: unknown }).chat;
  return { update_id: updateId, message };
}

function poller(
  api: FakeTelegram,
  repository: MemoryCursorRepository,
  ingress: DeduplicatingIngress
): TelegramPoller {
  return new TelegramPoller({
    activity: noopActivity(), observer: noopObserver(),
    config: config(), botId: '900001', api, repository, ingress
  });
}

describe('álbumes de Telegram', () => {
  it('coalesce tres fotos en UN mensaje de bus con tres adjuntos y un solo avance de cursor', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 10, 'ALB', { caption: 'mirá estas tres' }),
      album(api, 11, 'ALB'),
      album(api, 12, 'ALB')
    );
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();
    const bridge = poller(api, repository, ingress);

    await bridge.runOnce();
    await bridge.runOnce();

    expect(ingress.calls).toHaveLength(1);
    const body = ingress.calls[0]?.body;
    expect(body?.attachments_v1).toHaveLength(3);
    expect(body?.caption).toBe('mirá estas tres');
    expect(ingress.calls[0]?.update_id).toBe(10);
    expect(repository.advances).toEqual([13]);
  });

  it('un reinicio con el álbum a medio juntar no lo pierde ni lo duplica', async () => {
    const api = new FakeTelegram();
    api.updates.push(album(api, 20, 'REI', { caption: 'tres fotos' }), album(api, 21, 'REI'), album(api, 22, 'REI'));
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();

    await poller(api, repository, ingress).runOnce();
    expect(ingress.calls).toHaveLength(0);
    expect(repository.advances).toEqual([]);
    expect(repository.next).toBe(0);

    repository.expire();
    const reiniciado = poller(api, repository, ingress);
    await reiniciado.runOnce();
    await reiniciado.runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.body.attachments_v1).toHaveLength(3);
    expect(repository.advances).toEqual([23]);
  });

  it('descarta el miembro que declara otro chat y otro remitente en vez de darle la identidad del epígrafe', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 60, 'MIX', { caption: 'legítimo' }),
      album(api, 61, 'MIX', { chatId: -999_999, fromId: 66_666 })
    );
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();
    const metrics: string[] = [];
    const suppressed: { chat_id: string; update_id: number; reason: string }[] = [];
    const bridge = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(), botId: '900001', api, repository, ingress,
      onMetric: (metric) => metrics.push(metric),
      onSuppressed: (record) => suppressed.push(record)
    });

    await bridge.runOnce();
    await bridge.runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.origin.conversation_id).toBe('201');
    expect(ingress.calls[0]?.body.attachments_v1).toHaveLength(1);
    expect(metrics).toContain('updates_denied');
    expect(suppressed).toMatchObject([{ chat_id: '-999999', update_id: 61, reason: 'chat_not_allowed' }]);
    expect(repository.advances).toEqual([62]);
  });
});
