import { describe, expect, it } from 'vitest';
import { prepareTelegramAttachments } from '../src/attachments.js';
import { batchMembers, prepareMediaGroupAttachments } from '../src/media-group.js';
import { TelegramPoller } from '../src/poller.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import type {
  PollLease, TelegramApi, TelegramEntity, TelegramMessage, TelegramRemoteFile, TelegramUpdate
} from '../src/types.js';
import {
  config, DeduplicatingIngress, FakeTelegram, GROUP_CHAT_ID, MemoryCursorRepository, noopActivity,
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

  it('downloads the largest photo and carries validated content with a safe name and MIME', async () => {
    const api = new AttachmentTelegram();
    api.files.set('large', { file_id: 'large', file_path: 'photos/picture.jpg', file_size: 7 });
    api.payloads.set('photos/picture.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

    const result = await prepareTelegramAttachments(message({
      photo: [
        { file_id: 'small', file_size: 4 },
        { file_id: 'large', file_size: 7 }
      ]
    }), api);

    expect(result.errors).toEqual([]);
    expect(result.media).toHaveLength(1);
    const media = result.media[0];
    expect(media).toMatchObject({
      kind: 'image', name: 'picture.jpg', mime_type: 'image/jpeg', file_size: 7
    });
    expect(Buffer.from(media?.content_base64 ?? '', 'base64'))
      .toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(media?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['image/png', 'scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])],
    ['image/webp', 'scan.webp', Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBPdata', 'binary')],
    ['application/pdf', 'report.pdf', Buffer.from('%PDF-1.7\nfixture')],
    ['text/plain', 'notes.txt', Buffer.from('hola mundo\n', 'utf8')],
    // Accepts the mime variants for markdown.
    ['text/markdown', 'TECLAS-RPG-DOS-ALMAS.md', Buffer.from('# teclas\n- w: arriba\n', 'utf8')],
    ['text/x-markdown', 'notas.md', Buffer.from('# titulo\n', 'utf8')],
    ['text/plain', 'plano.md', Buffer.from('texto plano en un .md\n', 'utf8')],
    ['text/csv', 'ventas.csv', Buffer.from('fecha,total\n2026-08-04,10\n', 'utf8')],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml')])
    ],
    ['application/x-sh', 'desplegar.sh', Buffer.from('#!/bin/sh\nexit 0\n', 'utf8')],
    ['application/zip', 'evidencia.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9])],
    ['video/mp4', 'captura.mp4', Buffer.from('\u0000\u0000\u0000\u0018ftypmp42', 'binary')],
    ['application/vnd.sqlite3', 'cauce.db', Buffer.from('SQLite format 3\u0000', 'binary')],
    ['application/gzip', 'volcado.tar.gz', Buffer.from([0x1f, 0x8b, 0x08, 0x00])],
    ['image/svg+xml', 'diagrama.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')],
    ['text/plain', 'informe con acentos y espacios.txt', Buffer.from('ñandú\n', 'utf8')]
  ])('accepts any %s document', async (mime, name, payload) => {
    const api = new AttachmentTelegram();
    const remote = 'documents/file_42';
    api.files.set('doc', { file_id: 'doc', file_path: remote, file_size: payload.length });
    api.payloads.set(remote, payload);

    const result = await prepareTelegramAttachments(message({
      document: { file_id: 'doc', file_name: name, mime_type: mime, file_size: payload.length }
    }), api);

    expect(result.errors).toEqual([]);
    expect(result.media[0]).toMatchObject({ name, mime_type: mime, file_size: payload.length });
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

  it('rejects a name carrying bidi control characters', async () => {
    const api = new AttachmentTelegram();
    api.files.set('bidi', { file_id: 'bidi', file_path: 'documents/report.pdf', file_size: 3 });

    const result = await prepareTelegramAttachments(message({
      document: { file_id: 'bidi', file_name: 'report\u202Efdp.exe', mime_type: 'application/pdf', file_size: 3 }
    }), api);

    expect(result.media).toEqual([]);
    expect(result.errors[0]).toMatch(/nombre/u);
    expect(api.downloaded).toEqual([]);
  });

  it('carries content whose bytes disagree with the claimed type, naming what the bytes are', async () => {
    const api = new AttachmentTelegram();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    api.files.set('fake-pdf', { file_id: 'fake-pdf', file_path: 'documents/report.pdf', file_size: 9 });
    api.payloads.set('documents/report.pdf', png);

    const result = await prepareTelegramAttachments(message({
      document: { file_id: 'fake-pdf', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 9 }
    }), api);

    expect(result.errors).toEqual([]);
    expect(result.media[0]).toMatchObject({ kind: 'image', name: 'report.pdf', mime_type: 'image/png' });
  });

  it('names a file that arrives with no usable type from its extension, or as a plain stream', async () => {
    const api = new AttachmentTelegram();
    const payload = Buffer.from('contenido cualquiera');
    api.files.set('sin-tipo', { file_id: 'sin-tipo', file_path: 'documents/notas.md', file_size: payload.length });
    api.payloads.set('documents/notas.md', payload);
    api.files.set('sin-nada', { file_id: 'sin-nada', file_path: 'documents/volcado', file_size: payload.length });
    api.payloads.set('documents/volcado', payload);

    const conExtension = await prepareTelegramAttachments(message({
      document: { file_id: 'sin-tipo', file_name: 'notas.md', file_size: payload.length }
    }), api);
    expect(conExtension.media[0]).toMatchObject({ kind: 'document', mime_type: 'text/markdown' });

    const sinNada = await prepareTelegramAttachments(message({
      document: { file_id: 'sin-nada', file_name: 'volcado', file_size: payload.length }
    }), api);
    expect(sinNada.media[0]).toMatchObject({ kind: 'document', mime_type: 'application/octet-stream' });
  });

  it('strips the parameters Telegram may append to a declared type', async () => {
    const api = new AttachmentTelegram();
    const payload = Buffer.from('hola\n', 'utf8');
    api.files.set('param', { file_id: 'param', file_path: 'documents/notas.txt', file_size: payload.length });
    api.payloads.set('documents/notas.txt', payload);

    const result = await prepareTelegramAttachments(message({
      document: { file_id: 'param', file_name: 'notas.txt', mime_type: 'text/plain; charset=utf-8', file_size: payload.length }
    }), api);

    expect(result.media[0]).toMatchObject({ mime_type: 'text/plain' });
  });

  it('takes a video and an animation, which used to leave only a trace of metadata', async () => {
    const api = new AttachmentTelegram();
    const payload = Buffer.from('\u0000\u0000\u0000\u0018ftypmp42rest', 'binary');
    api.files.set('vid', { file_id: 'vid', file_path: 'videos/clip.mp4', file_size: payload.length });
    api.payloads.set('videos/clip.mp4', payload);
    api.files.set('gif', { file_id: 'gif', file_path: 'animations/meme.mp4', file_size: payload.length });
    api.payloads.set('animations/meme.mp4', payload);

    const video = await prepareTelegramAttachments(message({
      video: { file_id: 'vid', file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: payload.length }
    }), api);
    expect(video.media[0]).toMatchObject({ kind: 'document', name: 'clip.mp4', mime_type: 'video/mp4' });

    const animation = await prepareTelegramAttachments(message({
      animation: { file_id: 'gif', file_name: 'meme.mp4', mime_type: 'video/mp4', file_size: payload.length }
    }), api);
    expect(animation.media[0]).toMatchObject({ kind: 'document', name: 'meme.mp4' });
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

  it('en modo mención el álbum entero viaja: los miembros sin epígrafe ya no mueren sin destinatario', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 40, 'MEN', {
        chatId: GROUP_CHAT_ID,
        caption: '@kant_bot mirá',
        entities: [{ type: 'mention', offset: 0, length: 9 }]
      }),
      album(api, 41, 'MEN', { chatId: GROUP_CHAT_ID }),
      album(api, 42, 'MEN', { chatId: GROUP_CHAT_ID })
    );
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();
    const metrics: string[] = [];
    const bridge = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config({
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [{
          chat_id: String(GROUP_CHAT_ID), mode: 'mention', session_scope: 'user',
          reply_to_origin: true, threads: []
        }]
      }),
      botId: '900001', api, repository, ingress,
      onMetric: (metric) => metrics.push(metric)
    });

    await bridge.runOnce();
    await bridge.runOnce();

    expect(metrics).toEqual(['updates_allowed']);
    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.body.attachments_v1).toHaveLength(3);
    expect(repository.advances).toEqual([43]);
  });

  it('publica los miembros por separado cuando el álbum entero no entra en el tope agregado', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 30, 'GRANDE', { size: 6_000_000, caption: 'dos pesadas' }),
      album(api, 31, 'GRANDE', { size: 6_000_000 })
    );
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();
    const bridge = poller(api, repository, ingress);

    await bridge.runOnce();
    await bridge.runOnce();

    expect(ingress.calls).toHaveLength(2);
    expect(ingress.calls[0]?.body.attachments_v1).toHaveLength(1);
    expect(ingress.calls[1]?.body.attachments_v1).toHaveLength(1);
    expect(repository.advances).toEqual([32]);
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

  it('un miembro sin chat no revienta el ciclo ni congela el cursor', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 70, 'ROTO', { caption: 'una buena' }),
      album(api, 71, 'ROTO', { withoutChat: true })
    );
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();
    const bridge = poller(api, repository, ingress);

    await bridge.runOnce();
    await bridge.runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.body.attachments_v1).toHaveLength(1);
    expect(repository.next).toBe(72);
  });

  it('un álbum de seis fotos publica también los miembros de la tanda de continuación', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 50, 'SEIS', {
        chatId: GROUP_CHAT_ID,
        caption: '@kant_bot mirá',
        entities: [{ type: 'mention', offset: 0, length: 9 }]
      }),
      ...[51, 52, 53, 54, 55].map((updateId) => album(api, updateId, 'SEIS', { chatId: GROUP_CHAT_ID }))
    );
    const repository = new CountingCursors();
    const ingress = new DeduplicatingIngress();
    const metrics: string[] = [];
    const bridge = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config({
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [{
          chat_id: String(GROUP_CHAT_ID), mode: 'mention', session_scope: 'user',
          reply_to_origin: true, threads: []
        }]
      }),
      botId: '900001', api, repository, ingress,
      onMetric: (metric) => metrics.push(metric)
    });

    await bridge.runOnce();
    await bridge.runOnce();
    await bridge.runOnce();

    expect(metrics).toEqual(['updates_allowed', 'updates_allowed']);
    expect(ingress.calls.map((call) => (call.body.attachments_v1 as unknown[]).length)).toEqual([4, 2]);
    expect(repository.next).toBe(56);
  });
});

describe('presupuesto agregado de un álbum', () => {
  it('no recorta en silencio: el excedente hace que el álbum no entre y se publique miembro a miembro', async () => {
    const api = new FakeTelegram();
    const members = [80, 81, 82, 83, 84].map((updateId) => album(api, updateId, 'CINCO'));
    const prepared = await prepareMediaGroupAttachments(
      batchMembers(members),
      api,
      80
    );

    expect(prepared.members).toHaveLength(5);
    expect(prepared.combined.media).toHaveLength(5);
    expect(prepared.fits).toBe(false);
    expect(prepared.members.map((member) => member.update.update_id)).toEqual([80, 81, 82, 83, 84]);
  });
});
