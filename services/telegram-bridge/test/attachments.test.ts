import { describe, expect, it } from 'vitest';
import { prepareTelegramAttachments } from '../src/attachments.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import type { TelegramApi, TelegramMessage, TelegramRemoteFile } from '../src/types.js';

class AttachmentTelegram implements TelegramApi {
  readonly files = new Map<string, TelegramRemoteFile>();
  readonly payloads = new Map<string, Buffer>();
  downloaded: Array<{ path: string; maxBytes: number }> = [];

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }
  async getUpdates(): Promise<[]> { return []; }
  async sendText(): Promise<{ message_id: string }> { return { message_id: '1' }; }
  async setMessageReaction(): Promise<void> {}
  async sendChatAction(): Promise<void> {}

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
    expect(result.media[0]).toMatchObject({
      kind: 'image', name: 'picture.jpg', mime_type: 'image/jpeg', file_size: 7
    });
    expect(Buffer.from(result.media[0]!.content_base64, 'base64'))
      .toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(result.media[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['image/png', 'scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])],
    ['image/webp', 'scan.webp', Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBPdata', 'binary')],
    ['application/pdf', 'report.pdf', Buffer.from('%PDF-1.7\nfixture')],
    ['text/plain', 'notes.txt', Buffer.from('hola mundo\n', 'utf8')],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml')])
    ]
  ])('accepts supported %s documents', async (mime, name, payload) => {
    const api = new AttachmentTelegram();
    api.files.set('doc', { file_id: 'doc', file_path: `documents/${name}`, file_size: payload.length });
    api.payloads.set(`documents/${name}`, payload);

    const result = await prepareTelegramAttachments(message({
      document: { file_id: 'doc', file_name: name, mime_type: mime, file_size: payload.length }
    }), api);

    expect(result.errors).toEqual([]);
    expect(result.media[0]).toMatchObject({ name, mime_type: mime, file_size: payload.length });
  });

  it('rejects unsupported, mismatched, oversized, and traversal-shaped files without downloading unsafe input', async () => {
    const api = new AttachmentTelegram();
    api.files.set('bad-mime', { file_id: 'bad-mime', file_path: 'documents/script.sh', file_size: 10 });
    api.files.set('too-big', { file_id: 'too-big', file_path: 'documents/report.pdf', file_size: 10_000_001 });
    api.files.set('traversal', { file_id: 'traversal', file_path: '../secret.txt', file_size: 3 });

    for (const document of [
      { file_id: 'bad-mime', file_name: 'script.sh', mime_type: 'text/x-shellscript', file_size: 10 },
      { file_id: 'too-big', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 10_000_001 },
      { file_id: 'traversal', file_name: '../secret.txt', mime_type: 'text/plain', file_size: 3 }
    ]) {
      const result = await prepareTelegramAttachments(message({ document }), api);
      expect(result.media).toEqual([]);
      expect(result.errors[0]).toMatch(/no admitido|excede|nombre|ruta/u);
    }
    expect(api.downloaded).toEqual([]);
  });

  it('rejects content whose magic bytes disagree with the claimed type', async () => {
    const api = new AttachmentTelegram();
    api.files.set('fake-pdf', { file_id: 'fake-pdf', file_path: 'documents/report.pdf', file_size: 9 });
    api.payloads.set('documents/report.pdf', Buffer.from('not a pdf'));

    const result = await prepareTelegramAttachments(message({
      document: { file_id: 'fake-pdf', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 9 }
    }), api);

    expect(result.media).toEqual([]);
    expect(result.errors).toEqual(['report.pdf: el contenido no coincide con application/pdf']);
  });
});
