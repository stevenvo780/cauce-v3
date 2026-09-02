import { describe, expect, it } from 'vitest';
import { prepareTelegramAttachments } from '../src/attachments.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import type { TelegramApi, TelegramMessage, TelegramRemoteFile } from '../src/types.js';

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
