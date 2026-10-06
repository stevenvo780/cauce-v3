import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, StoreError, type DatabasePool } from '@cauce/store';
import { FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';
import { registerConsoleReplyAttachmentRoutes } from './routes/console/reply-attachments.js';
import { consoleHumanAccess } from './console-human-authority.js';

vi.mock('./console-human-authority.js', () => ({ consoleHumanAccess: vi.fn() }));
const root = 'cccccccc-3333-4333-8333-333333333333';
const delivery = 'dddddddd-3333-4333-8333-333333333333';
const bytes = Buffer.from([0, 1, 127, 128, 255]);
const attachment = { kind: 'document', name: 'reply.mp3', mime_type: 'audio/mpeg', file_size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
const apps: FastifyInstance[] = [];
function gateway() {
  const app = Fastify(); apps.push(app);
  registerConsoleReplyAttachmentRoutes(app, { pool: {} as DatabasePool, authProvider: new FixedAuthProvider(testPrincipal()) });
  const close = vi.fn();
  vi.mocked(consoleHumanAccess).mockResolvedValue({ close, options: { signal: new AbortController().signal,
    humanAuthority: async () => ({ humanId: root, tenantId: 'Pablo', actorAlias: 'midas' }) } });
  return { app, close };
}
function download(app: FastifyInstance, attempt = '1', index = '0') {
  return app.inject({ method: 'GET', url: `/v3/console/messages/${root}/replies/${delivery}/${attempt}/attachments/${index}` });
}
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(consoleHumanAccess).mockReset(); await Promise.all(apps.splice(0).map((app) => app.close())); });
describe('canonical human reply binary route', () => {
  it.each(['image/png', 'audio/mpeg', 'audio/ogg', 'video/mp4', 'video/webm'])('returns exact bytes and safe headers for %s', async (mime) => {
    const { app, close } = gateway();
    const query = vi.spyOn(CauceRepository.prototype, 'getReplyAttachments').mockResolvedValue([{ ...attachment, mime_type: mime }]);
    const response = await download(app);
    expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(bytes);
    expect(response.headers['content-type']).toBe(mime);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(query.mock.calls[0]?.slice(0, 3)).toEqual([root, delivery, 1]);
    expect(query.mock.calls[0]?.[3].signal).toBeInstanceOf(AbortSignal);
    expect(close).toHaveBeenCalledOnce();
  });
  it.each(['-1', '1.0', '01', '2147483648', '10000000000'])('rejects an invalid attempt %s before reading', async (attempt) => {
    const { app } = gateway(); const spy = vi.spyOn(CauceRepository.prototype, 'getReplyAttachments');
    expect((await download(app, attempt)).statusCode).toBe(404); expect(spy).not.toHaveBeenCalled();
  });
  it('requires a verified human instead of an operator machine identity', async () => {
    const { app } = gateway(); vi.mocked(consoleHumanAccess).mockResolvedValue(undefined);
    const spy = vi.spyOn(CauceRepository.prototype, 'getReplyAttachments');
    expect((await download(app)).statusCode).toBe(404); expect(spy).not.toHaveBeenCalled();
  });
  it('closes authority and returns 404 when the durable snapshot rejects ownership', async () => {
    const { app, close } = gateway();
    vi.spyOn(CauceRepository.prototype, 'getReplyAttachments').mockRejectedValue(new StoreError('not_found', 'message not found or not visible'));
    const response = await download(app); expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(attachment.content_base64); expect(close).toHaveBeenCalledOnce();
  });
  it('rejects corrupt persisted media instead of returning unverified bytes', async () => {
    const { app, close } = gateway();
    vi.spyOn(CauceRepository.prototype, 'getReplyAttachments').mockResolvedValue([{ ...attachment, sha256: '0'.repeat(64) }]);
    expect((await download(app, '0')).statusCode).toBe(404); expect(close).toHaveBeenCalledOnce();
  });
});
