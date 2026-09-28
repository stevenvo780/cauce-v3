import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  blobArtifactUri, blobLocator, isSafeBasename, isValidMediaType, MAX_ATTACHMENT_MEDIA_TYPE_LENGTH,
  MAX_BLOB_BYTES,
} from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { requirePermission, type AuthProvider } from '../auth.js';
import type { GatewayRepository } from '../app.js';
import { principal, replyError } from './shared.js';

/* Files too large to ride inline. The bytes are streamed to disk under their sha256 while the
   digest is computed in flight; nothing is buffered and nothing is base64. A digest is a
   capability: the message that carried it already crossed the delegation edge, so any principal
   with `read` who names it may fetch it, and every fetch touches `last_used_at` for the purge. */

export interface BlobStoreOptions {
  readonly directory: string;
  readonly maxBytes: number;
}

type BlobRepository = Pick<GatewayRepository, 'registerBlob' | 'findBlob'>;

const OCTET_STREAM = 'application/octet-stream';
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const TEMPORARY_DIRECTORY = 'tmp';

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function validateBlobStoreOptions(options: BlobStoreOptions): BlobStoreOptions {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_BLOB_BYTES) {
    throw new Error(`blob maxBytes must be an integer between 1 and ${String(MAX_BLOB_BYTES)}`);
  }
  if (options.directory.length === 0 || !options.directory.startsWith('/')) {
    throw new Error('blob directory must be an absolute path');
  }
  return options;
}

export async function prepareBlobDirectory(options: BlobStoreOptions): Promise<void> {
  await mkdir(join(options.directory, TEMPORARY_DIRECTORY), { recursive: true, mode: 0o700 });
}

interface Spooled {
  readonly digest: string;
  readonly bytes: number;
  readonly overflow: boolean;
}

/* Writes the request body to `path` while hashing it, never holding more than one chunk. Past the
   cap it stops WRITING and drains up to one more cap so the client receives the 413 instead of a
   reset; a body that keeps coming beyond that is cut. */
async function spool(body: AsyncIterable<Buffer>, path: string, limit: number): Promise<Spooled> {
  const hash = createHash('sha256');
  const writer = createWriteStream(path, { mode: 0o600, flags: 'wx' });
  let bytes = 0;
  let overflow = false;
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > limit) {
        overflow = true;
        if (bytes > 2 * limit) break;
        continue;
      }
      hash.update(chunk);
      if (!writer.write(chunk)) await once(writer, 'drain');
    }
  } finally {
    writer.end();
    await finished(writer);
  }
  return { digest: hash.digest('hex'), bytes, overflow };
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, first, last] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerBlobRoutes(
  app: FastifyInstance,
  options: { readonly authProvider: AuthProvider },
  repository: BlobRepository,
  blobs: BlobStoreOptions,
): void {
  const store = validateBlobStoreOptions(blobs);
  if (!app.hasContentTypeParser(OCTET_STREAM)) {
    app.addContentTypeParser(OCTET_STREAM, (_request, payload, done) => { done(null, payload); });
  }

  app.put('/v3/blobs', { bodyLimit: store.maxBytes }, async (request, reply) => {
    const temporary = join(store.directory, TEMPORARY_DIRECTORY, randomUUID());
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const declaredLength = Number(headerValue(request, 'content-length') ?? '0');
      if (Number.isSafeInteger(declaredLength) && declaredLength > store.maxBytes) {
        void reply.code(413).send({ error: 'payload_too_large', message: `blob exceeds ${String(store.maxBytes)} bytes` });
        return;
      }
      const name = headerValue(request, 'x-cauce-blob-name') ?? '';
      const mediaType = headerValue(request, 'x-cauce-blob-media-type') ?? OCTET_STREAM;
      const declaredDigest = headerValue(request, 'x-cauce-blob-sha256');
      if (!isSafeBasename(name)) throw new Error('x-cauce-blob-name must be a safe file name');
      if (mediaType.length > MAX_ATTACHMENT_MEDIA_TYPE_LENGTH || !isValidMediaType(mediaType)) {
        throw new Error('x-cauce-blob-media-type is not a valid MIME token');
      }
      if (declaredDigest !== undefined && !HEX_SHA256.test(declaredDigest)) {
        throw new Error('x-cauce-blob-sha256 must be sha256 hex');
      }
      const body = request.body;
      if (body === null || typeof body !== 'object' || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new Error(`blob uploads must be sent as ${OCTET_STREAM}`);
      }
      await mkdir(join(store.directory, TEMPORARY_DIRECTORY), { recursive: true, mode: 0o700 });
      const spooled = await spool(body as AsyncIterable<Buffer>, temporary, store.maxBytes);
      if (spooled.overflow) {
        await unlink(temporary).catch(() => undefined);
        void reply.code(413).send({ error: 'payload_too_large', message: `blob exceeds ${String(store.maxBytes)} bytes` });
        return;
      }
      const { digest, bytes } = spooled;
      if (bytes === 0) throw new Error('blob is empty');
      if (declaredDigest !== undefined && declaredDigest !== digest) {
        await unlink(temporary).catch(() => undefined);
        void reply.code(409).send({ error: 'conflict', message: 'blob bytes do not match the declared sha256' });
        return;
      }
      const final = join(store.directory, digest);
      const existing = await stat(final).catch(() => undefined);
      if (existing?.isFile() === true && existing.size === bytes) await unlink(temporary);
      else await rename(temporary, final);
      const record = await repository.registerBlob({
        sha256: digest, bytes, mediaType, name, tenantId: actor.tenant_id, createdBy: actor.alias,
      });
      void reply.code(201).send({
        sha256: record.sha256, bytes: record.bytes, media_type: record.media_type, name: record.name,
        blob: blobLocator(record.sha256), uri: blobArtifactUri(record.sha256),
      });
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      replyError(reply, error);
    }
  });

  app.get<{ Params: { sha256: string } }>('/v3/blobs/:sha256', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const digest = request.params.sha256;
      if (!HEX_SHA256.test(digest)) throw new StoreError('not_found', 'unknown blob');
      const record = await repository.findBlob(digest);
      if (record === undefined) throw new StoreError('not_found', 'unknown blob');
      const path = join(store.directory, digest);
      const file = await stat(path).catch(() => undefined);
      if (file?.isFile() !== true) throw new StoreError('not_found', 'blob bytes are not on disk');
      await sendBlob(reply, request, path, file.size, record.media_type, record.name);
    } catch (error) { replyError(reply, error); }
  });
}

async function sendBlob(
  reply: FastifyReply, request: FastifyRequest, path: string, size: number, mediaType: string, name: string,
): Promise<void> {
  const range = parseRange(headerValue(request, 'range'), size);
  void reply.header('accept-ranges', 'bytes');
  void reply.header('content-type', mediaType);
  void reply.header('content-disposition', contentDisposition(name));
  if (range === 'unsatisfiable') {
    void reply.code(416).header('content-range', `bytes */${String(size)}`).send();
    return;
  }
  if (range === undefined) {
    void reply.code(200).header('content-length', String(size));
    await reply.send(createReadStream(path));
    return;
  }
  void reply.code(206)
    .header('content-range', `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`)
    .header('content-length', String(range.end - range.start + 1));
  await reply.send(createReadStream(path, { start: range.start, end: range.end }));
}
