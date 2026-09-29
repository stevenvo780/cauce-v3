import { describe, expect, it } from 'vitest';
import {
  AttachmentsV1Schema, blobArtifactUri, blobLocator, DEFAULT_BLOB_MAX_BYTES, isBlobAttachmentEntry,
  isCarriedBlobCandidate, isDeliverableArtifactUri, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_BLOB_BYTES,
  MessageBodySchema, parseBlobArtifactUri, parseBlobLocator,
  parseCarriedBlobReference,
} from '../src/index.js';

const SHA = 'a'.repeat(64);

function inline(bytes: number, name = 'nota.txt') {
  const payload = Buffer.alloc(bytes, 1);
  return {
    kind: 'document', name, mime_type: 'text/plain', file_size: bytes,
    sha256: SHA, content_base64: payload.toString('base64'),
  };
}

describe('blob references', () => {
  it('keeps the wire ceilings: a blob may be far larger than an inline attachment', () => {
    expect(DEFAULT_BLOB_MAX_BYTES).toBe(2 * 1024 ** 3);
    expect(MAX_BLOB_BYTES).toBeGreaterThanOrEqual(8 * 1024 ** 3);
    expect(MAX_BLOB_BYTES).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
  });

  it('builds and parses the locator and the artifact uri from one digest', () => {
    expect(blobLocator(SHA)).toBe(`sha256:${SHA}`);
    expect(parseBlobLocator(`sha256:${SHA}`)).toBe(SHA);
    expect(blobArtifactUri(SHA)).toBe(`cauce-blob:sha256:${SHA}`);
    expect(parseBlobArtifactUri(`cauce-blob:sha256:${SHA}`)).toBe(SHA);
  });

  it.each([
    'sha256:', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, SHA, `md5:${SHA}`, 7, undefined,
  ])('refuses the locator %s', (value) => {
    expect(parseBlobLocator(value)).toBeUndefined();
  });

  it.each([`https://x/${SHA}`, `cauce-blob:${SHA}`, `cauce-blob:sha256:${'z'.repeat(64)}`, 'data:x'])(
    'refuses the artifact uri %s', (value) => {
      expect(parseBlobArtifactUri(value)).toBeUndefined();
    },
  );

  it('counts a blob artifact uri as deliverable, like data: and https:', () => {
    expect(isDeliverableArtifactUri(blobArtifactUri(SHA))).toBe(true);
    expect(isDeliverableArtifactUri(`cauce-blob:sha256:${'a'.repeat(63)}`)).toBe(false);
  });
});

describe('carried blob references', () => {
  const OTHER = 'b'.repeat(64);

  it('reads only the field that the recipient adapter downloads', () => {
    expect(parseCarriedBlobReference({ blob: blobLocator(SHA) }, 'attachments_v1')).toBe(SHA);
    expect(parseCarriedBlobReference({ uri: blobArtifactUri(SHA) }, 'artifacts_v1')).toBe(SHA);
    expect(parseCarriedBlobReference({ uri: blobArtifactUri(SHA) }, 'attachments_v1')).toBeUndefined();
    expect(parseCarriedBlobReference({ blob: blobLocator(SHA) }, 'artifacts_v1')).toBeUndefined();
  });

  it('refuses a blob and a uri in the same entry, even when they agree', () => {
    for (const uri of [blobArtifactUri(SHA), blobArtifactUri(OTHER)]) {
      expect(parseCarriedBlobReference({ blob: blobLocator(SHA), uri }, 'attachments_v1')).toBeUndefined();
      expect(parseCarriedBlobReference({ blob: blobLocator(SHA), uri }, 'artifacts_v1')).toBeUndefined();
    }
  });

  it('refuses declared digests that disagree with the downloaded reference', () => {
    expect(parseCarriedBlobReference({ blob: blobLocator(SHA), sha256: OTHER }, 'attachments_v1')).toBeUndefined();
    expect(parseCarriedBlobReference({ uri: blobArtifactUri(SHA), sha256: OTHER }, 'artifacts_v1')).toBeUndefined();
    expect(parseCarriedBlobReference({ uri: blobArtifactUri(SHA), declared_sha256: OTHER }, 'artifacts_v1')).toBeUndefined();
  });

  it('rejects ambiguous artifacts in a published body but keeps opaque non-blob artifacts', () => {
    expect(MessageBodySchema.safeParse({ artifacts_v1: [{
      name: 'ambiguous.txt', blob: blobLocator(SHA), uri: blobArtifactUri(OTHER),
    }] }).success).toBe(false);
    expect(MessageBodySchema.safeParse({ artifacts_v1: [{
      name: 'remote.txt', uri: 'https://example.invalid/document.txt', sha256: OTHER,
    }] }).success).toBe(true);
    expect(MessageBodySchema.safeParse({ artifacts_v1: [{
      name: 'valid.txt', uri: blobArtifactUri(SHA), declared_sha256: SHA,
    }] }).success).toBe(true);
  });

  it.each([' ', '\uFEFF', ' \uFEFF\t'])(
    'treats a blob URI with leading %j as invalid rather than an opaque artifact', (prefix) => {
      const entry = { name: 'poison.txt', uri: `${prefix}${blobArtifactUri(SHA)}`, sha256: OTHER };
      expect(isCarriedBlobCandidate(entry, 'artifacts_v1')).toBe(true);
      expect(parseCarriedBlobReference(entry, 'artifacts_v1')).toBeUndefined();
      expect(MessageBodySchema.safeParse({ artifacts_v1: [entry] }).success).toBe(false);
    },
  );
});

describe('attachments_v1 with blob entries', () => {
  const blob = {
    kind: 'document', name: 'video.mp4', mime_type: 'video/mp4',
    file_size: 1_200_000_000, blob: `sha256:${SHA}`,
  };

  it('still admits the inline shape unchanged', () => {
    const parsed = AttachmentsV1Schema.safeParse([inline(3)]);
    expect(parsed.success).toBe(true);
    expect(isBlobAttachmentEntry(inline(3))).toBe(false);
  });

  it('admits a blob entry above the inline ceiling, with no base64 at all', () => {
    const parsed = AttachmentsV1Schema.safeParse([blob]);
    expect(parsed.success).toBe(true);
    expect(isBlobAttachmentEntry(blob)).toBe(true);
  });

  it('mixes inline and blob entries and charges the aggregate budget to inline bytes only', () => {
    const parsed = AttachmentsV1Schema.safeParse([inline(MAX_ATTACHMENTS_TOTAL_BYTES - 1, 'a.txt'), blob]);
    expect(parsed.success).toBe(true);
  });

  it('refuses a blob entry whose sha256 field disagrees with its locator', () => {
    const parsed = AttachmentsV1Schema.safeParse([{ ...blob, sha256: 'b'.repeat(64) }]);
    expect(parsed.success).toBe(false);
  });

  it.each([
    ['a bad locator', { ...blob, blob: SHA }],
    ['base64 next to a locator', { ...blob, content_base64: 'QUJD' }],
    ['a size past the blob ceiling', { ...blob, file_size: MAX_BLOB_BYTES + 1 }],
    ['an image kind over a non-image type', { ...blob, kind: 'image' }],
  ])('refuses %s', (_label, entry) => {
    expect(AttachmentsV1Schema.safeParse([entry]).success).toBe(false);
  });
});
