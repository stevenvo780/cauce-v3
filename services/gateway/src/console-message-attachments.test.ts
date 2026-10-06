import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { AuthError, type Principal } from './auth.js';
import { buildTestGateway, FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';
import { registerConsoleMessageAttachmentRoutes } from './routes/console/message-attachments.js';

const id = 'cccccccc-3333-4333-8333-333333333333';
const bytes = Buffer.from([0, 1, 127, 128, 255, 10, 13]);
const attachment = {
  kind: 'document', name: 'grabación ñ.mp3', mime_type: 'audio/mpeg', file_size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64'),
};
const row = {
  id, tenant_id: 'Pablo', actor_alias: 'midas', deliveries: [], attachments: [attachment],
};
const apps: FastifyInstance[] = [];

async function gateway(rows: Record<string, unknown>[] = [row], actor: Principal = testPrincipal()) {
  const app = Fastify();
  apps.push(app);
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows, rowCount: rows.length }));
  const authProvider = new FixedAuthProvider(actor);
  registerConsoleMessageAttachmentRoutes(app, { pool: { query } as unknown as DatabasePool, authProvider });
  return { app, query, authProvider };
}

function download(app: FastifyInstance, index = '0', messageId = id) {
  return app.inject({ method: 'GET', url: `/v3/console/messages/${messageId}/attachments/${index}` });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('console inline attachment download', () => {
  it('registers the binary endpoint on the complete gateway', async () => {
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const app = await buildTestGateway({
      pool: { query } as unknown as DatabasePool,
      authProvider: new FixedAuthProvider(testPrincipal()),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET', url: `/v3/console/messages/${id}/attachments/0`, headers: { origin: 'http://localhost' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['audio/mpeg', 'audio/ogg', 'video/mp4', 'video/webm', 'image/png'])('returns exact binary bytes with %s for Blob playback', async (mime) => {
    const { app, query } = await gateway([{ ...row, attachments: [{ ...attachment, mime_type: mime }] }]);
    const response = await download(app);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(attachment.sha256);
    expect(response.headers['content-type']).toBe(mime);
    expect(response.headers['content-length']).toBe(String(bytes.length));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(response.headers['content-disposition']).toBe('attachment; filename="grabaci_n__.mp3"; filename*=UTF-8\'\'grabaci%C3%B3n%20%C3%B1.mp3');
    expect(response.body).not.toContain('content_base64');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([id, 'Pablo', 'midas']);
  });

  it.each(['agent', 'operator'] as const)('passes the authenticated %s reader without a detail lookup', async (reader) => {
    const spy = vi.spyOn(CauceRepository.prototype, 'getMessageAttachment');
    const { app, query } = await gateway([row], testPrincipal({ roles: [reader] }));
    expect((await download(app)).statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(id, 'Pablo', 'midas', reader);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('allows a recipient and rejects a nonparticipant or foreign sender despite a repository row', async () => {
    const recipient = { ...row, actor_alias: 'socrates', deliveries: [{ tenant_id: 'Pablo', alias: 'midas' }] };
    const { app } = await gateway([recipient]);
    expect((await download(app)).statusCode).toBe(200);
    for (const hidden of [
      { ...row, actor_alias: 'socrates' }, { ...row, tenant_id: 'Steven' },
      { ...row, tenant_id: 'Steven', deliveries: [{ tenant_id: 'Steven', alias: 'midas' }] },
    ]) {
      const instance = await gateway([hidden]);
      const response = await download(instance.app);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found', message: 'message not found or not visible' });
      expect(response.body).not.toContain(attachment.content_base64);
    }
  });

  it('requires login before reading bytes, even with an invalid index', async () => {
    const { app, query, authProvider } = await gateway();
    vi.spyOn(authProvider, 'authenticateHttp').mockRejectedValue(new AuthError());
    expect((await download(app)).statusCode).toBe(401);
    expect((await download(app, '4')).statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires principal read permission before any SQL', async () => {
    const { app, query } = await gateway([row], testPrincipal({ permissions: [] }));
    expect((await download(app)).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['4', '-1', '00', '01', '+0', '1.0', '1e0', '999999999999999999999', '%20', '%EF%BC%90', '0%0A', '0%0D'])('rejects invalid index %s without SQL', async (index) => {
    const { app, query } = await gateway();
    expect((await download(app, index)).statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects malformed message identifiers without a PostgreSQL cast error', async () => {
    const { app, query } = await gateway();
    expect((await download(app, '0', 'not-a-uuid')).statusCode).toBe(404);
    expect((await download(app, '0', `${id}%0A`)).statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the raw zero-based index for all four entries', async () => {
    const attachments = Array.from({ length: 4 }, (_, index) => ({ ...attachment, name: `file-${String(index)}.mp3` }));
    const { app } = await gateway([{ ...row, attachments }]);
    for (let index = 0; index < 4; index += 1) {
      const response = await download(app, String(index));
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain(`filename="file-${String(index)}.mp3"`);
    }
  });

  it('makes missing messages, indices and malformed attachments indistinguishable', async () => {
    const absent = await gateway([]);
    const missingIndex = await gateway();
    const corrupt = await gateway([{ ...row, attachments: 'legacy' }]);
    const responses = await Promise.all([download(absent.app), download(missingIndex.app, '3'), download(corrupt.app)]);
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
  });

  it.each([
    undefined, null, {}, 'legacy', [], [null], [1], [attachment, null], Array(5).fill(attachment),
    [{ ...attachment, name: '../secret' }], [{ ...attachment, name: 'x\r\nInjected: yes' }],
    [{ ...attachment, name: '\ud800.mp3' }], [{ ...attachment, name: '..' }],
    [{ ...attachment, mime_type: 'audio/mpeg\r\nX: yes' }], [{ ...attachment, mime_type: 'audio/mpeg; charset=utf8' }],
    [{ ...attachment, mime_type: 'audio/mpeg\n' }],
    [{ ...attachment, file_size: 10_000_001 }], [{ ...attachment, file_size: -1 }],
    [{ ...attachment, sha256: '0'.repeat(64) }], [{ ...attachment, sha256: attachment.sha256.toUpperCase() }],
    [{ ...attachment, content_base64: bytes.toString('base64url') }],
    [{ ...attachment, content_base64: 'AB==', file_size: 1, sha256: createHash('sha256').update(Buffer.from([0])).digest('hex') }],
    [{ ...attachment, content_base64: `${attachment.content_base64}\n` }],
    [{ ...attachment, file_size: 1 }], [{ ...attachment, extra: 'legacy' }],
    [{ kind: 'document', name: 'file', mime_type: 'audio/mpeg', file_size: 1, blob: `sha256:${'f'.repeat(64)}` }],
  ])('fails closed for malformed historical carrier %#', async (attachments) => {
    const { app } = await gateway([{ ...row, attachments }]);
    const response = await download(app);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'message not found or not visible' });
  });

  it.each(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/javascript', 'text/xml'])('forces active MIME %s to octet-stream', async (mime) => {
    const { app } = await gateway([{ ...row, attachments: [{ ...attachment, mime_type: mime }] }]);
    const response = await download(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
  });

  it('encodes quotes, percent and RFC5987 reserved punctuation in a validated filename', async () => {
    const { app } = await gateway([{ ...row, attachments: [{ ...attachment, name: 'a"%;\'()*.ogg' }] }]);
    const response = await download(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="a_______.ogg"; filename*=UTF-8\'\'a%22%25%3B%27%28%29%2A.ogg');
  });

  it('rejects aggregate inline bytes above 10 MB even when each entry fits', async () => {
    const largeBytes = Buffer.alloc(5_000_001);
    const large = { ...attachment, file_size: largeBytes.length, content_base64: largeBytes.toString('base64'),
      sha256: createHash('sha256').update(largeBytes).digest('hex') };
    const { app } = await gateway([{ ...row, attachments: [large, large] }]);
    expect((await download(app)).statusCode).toBe(404);
  });

  it('accepts the exact 10 MB inline boundary with canonical bytes and digest', async () => {
    const largeBytes = Buffer.alloc(10_000_000, 255);
    const large = { ...attachment, file_size: largeBytes.length, content_base64: largeBytes.toString('base64'),
      sha256: createHash('sha256').update(largeBytes).digest('hex') };
    const { app } = await gateway([{ ...row, attachments: [large] }]);
    const response = await download(app);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(largeBytes)).toBe(true);
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(large.sha256);
  });

  it('rejects a corrupt sibling without compacting or renumbering indices', async () => {
    const { app } = await gateway([{ ...row, attachments: [
      { ...attachment, sha256: '0'.repeat(64) }, attachment,
    ] }]);
    expect((await download(app, '1')).statusCode).toBe(404);
  });
});
