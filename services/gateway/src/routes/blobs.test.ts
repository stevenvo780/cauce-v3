import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StoreError } from '@cauce/store';
import { buildGateway } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';
import { fakePool, fakeRepository } from '../test-support/gateway-doubles.js';

const MAX_BYTES = 1_024;
const DEV = { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'zeus' };
const OCTET = { ...DEV, 'content-type': 'application/octet-stream', 'x-cauce-blob-name': 'demo.bin' };

const apps: FastifyInstance[] = [];
const directories: string[] = [];

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function gateway(options: { readonly permissions?: readonly ('read' | 'route')[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-blobs-'));
  directories.push(directory);
  const registered = new Map<string, { bytes: number; media_type: string; name: string }>();
  const registerBlob = vi.fn(async (input: { sha256: string; bytes: number; mediaType: string; name: string; tenantId: string; createdBy: string }) => {
    const existing = registered.get(input.sha256);
    if (existing !== undefined && existing.bytes !== input.bytes) throw new StoreError('conflict', 'size differs');
    registered.set(input.sha256, { bytes: input.bytes, media_type: input.mediaType, name: input.name });
    const now = new Date();
    return {
      sha256: input.sha256, bytes: input.bytes, media_type: input.mediaType, name: input.name,
      tenant_id: input.tenantId, created_by: input.createdBy, created_at: now, last_used_at: now,
    };
  });
  const findBlob = vi.fn(async (digest: string) => {
    const entry = registered.get(digest);
    if (entry === undefined) return undefined;
    const now = new Date();
    return { sha256: digest, ...entry, tenant_id: 'Steven', created_by: 'zeus', created_at: now, last_used_at: now };
  });
  const repository = fakeRepository();
  repository.registerBlob = registerBlob;
  repository.findBlob = findBlob;
  const app = await buildGateway({
    pool: fakePool(),
    authProvider: DevOnlyAuthProvider.forTests(options.permissions === undefined ? {} : {
      roles: ['operator'], permissions: options.permissions,
    }),
    repository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    outboxPollMs: 60_000,
    consoleOrigins: ['http://localhost'],
    logger: false,
    blobs: { directory, maxBytes: MAX_BYTES },
  });
  await app.ready();
  apps.push(app);
  return { app, directory, registerBlob, findBlob };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (directories.length > 0) await rm(directories.pop() ?? '', { recursive: true, force: true });
});

describe('PUT /v3/blobs', () => {
  it('streams the bytes to disk under their sha256 and registers the blob for the caller', async () => {
    const { app, directory, registerBlob } = await gateway();
    const bytes = Buffer.from('hola mundo, esto es un blob', 'utf8');
    const response = await app.inject({
      method: 'PUT', url: '/v3/blobs', payload: bytes,
      headers: { ...OCTET, 'x-cauce-blob-media-type': 'text/plain' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      sha256: sha(bytes), bytes: bytes.length, media_type: 'text/plain', name: 'demo.bin',
      blob: `sha256:${sha(bytes)}`, uri: `cauce-blob:sha256:${sha(bytes)}`,
    });
    expect(await readFile(join(directory, sha(bytes)))).toEqual(bytes);
    expect(registerBlob).toHaveBeenCalledWith({
      sha256: sha(bytes), bytes: bytes.length, mediaType: 'text/plain', name: 'demo.bin',
      tenantId: 'Steven', createdBy: 'zeus',
    });
    expect(await readdir(join(directory, 'tmp'))).toEqual([]);
  });

  it('defaults the media type and refuses an unsafe name', async () => {
    const { app } = await gateway();
    const ok = await app.inject({ method: 'PUT', url: '/v3/blobs', payload: Buffer.from('x'), headers: OCTET });
    expect(ok.json().media_type).toBe('application/octet-stream');
    const bad = await app.inject({
      method: 'PUT', url: '/v3/blobs', payload: Buffer.from('x'), headers: { ...OCTET, 'x-cauce-blob-name': '../etc/passwd' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses a declared length past the cap before reading a byte', async () => {
    const { app, directory, registerBlob } = await gateway();
    const response = await app.inject({
      method: 'PUT', url: '/v3/blobs', payload: Buffer.alloc(MAX_BYTES + 1, 7), headers: OCTET,
    });
    expect(response.statusCode).toBe(413);
    expect(registerBlob).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(['tmp']);
    expect(await readdir(join(directory, 'tmp'))).toEqual([]);
  });

  it('stops a chunked upload at the cap and leaves no partial file behind', async () => {
    const { app, directory, registerBlob } = await gateway();
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(300, 1));
    const response = await app.inject({
      method: 'PUT', url: '/v3/blobs', payload: Readable.from(chunks), headers: OCTET,
    });
    expect(response.statusCode).toBe(413);
    expect(registerBlob).not.toHaveBeenCalled();
    expect(await readdir(join(directory, 'tmp'))).toEqual([]);
  });

  it('refuses bytes whose digest is not the one the caller declared', async () => {
    const { app, registerBlob } = await gateway();
    const response = await app.inject({
      method: 'PUT', url: '/v3/blobs', payload: Buffer.from('abc'),
      headers: { ...OCTET, 'x-cauce-blob-sha256': 'f'.repeat(64) },
    });
    expect(response.statusCode).toBe(409);
    expect(registerBlob).not.toHaveBeenCalled();
  });

  it('demands authentication and the route permission', async () => {
    const anonymous = await gateway();
    const noIdentity = await anonymous.app.inject({
      method: 'PUT', url: '/v3/blobs', payload: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' },
    });
    expect(noIdentity.statusCode).toBe(401);
    const reader = await gateway({ permissions: ['read'] });
    const forbidden = await reader.app.inject({ method: 'PUT', url: '/v3/blobs', payload: Buffer.from('x'), headers: OCTET });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('GET /v3/blobs/:sha256', () => {
  async function upload(app: FastifyInstance, bytes: Buffer) {
    const response = await app.inject({
      method: 'PUT', url: '/v3/blobs', payload: bytes, headers: { ...OCTET, 'x-cauce-blob-media-type': 'video/mp4' },
    });
    expect(response.statusCode).toBe(201);
    return sha(bytes);
  }

  it('serves the whole blob with its type, size and name, touching last_used_at', async () => {
    const { app, findBlob } = await gateway();
    const bytes = Buffer.from('0123456789', 'utf8');
    const digest = await upload(app, bytes);
    const response = await app.inject({ method: 'GET', url: `/v3/blobs/${digest}`, headers: DEV });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['content-length']).toBe('10');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-disposition']).toContain('demo.bin');
    expect(findBlob).toHaveBeenCalledWith(digest);
  });

  it('serves a byte range as 206 with Content-Range', async () => {
    const { app } = await gateway();
    const digest = await upload(app, Buffer.from('0123456789', 'utf8'));
    const response = await app.inject({ method: 'GET', url: `/v3/blobs/${digest}`, headers: { ...DEV, range: 'bytes=2-4' } });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('234');
    expect(response.headers['content-range']).toBe('bytes 2-4/10');
    const tail = await app.inject({ method: 'GET', url: `/v3/blobs/${digest}`, headers: { ...DEV, range: 'bytes=7-' } });
    expect(tail.body).toBe('789');
    const beyond = await app.inject({ method: 'GET', url: `/v3/blobs/${digest}`, headers: { ...DEV, range: 'bytes=10-12' } });
    expect(beyond.statusCode).toBe(416);
  });

  it('answers 404 for an unknown or malformed digest and 403 without the read permission', async () => {
    const { app } = await gateway();
    expect((await app.inject({ method: 'GET', url: `/v3/blobs/${'e'.repeat(64)}`, headers: DEV })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v3/blobs/not-a-digest', headers: DEV })).statusCode).toBe(404);
    const router = await gateway({ permissions: ['route'] });
    const digest = await upload(router.app, Buffer.from('abc'));
    expect((await router.app.inject({ method: 'GET', url: `/v3/blobs/${digest}`, headers: DEV })).statusCode).toBe(403);
  });
});
