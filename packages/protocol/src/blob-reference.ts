/* A file too large to ride inline travels BY REFERENCE: the bytes live in the gateway's blob
   store, content-addressed by sha256, and the message carries only the digest. Two spellings of
   the same reference exist because two fields carry it: an `attachments_v1` entry names its
   locator in `blob` (`sha256:<hex>`), and an agent artifact names it in `uri`
   (`cauce-blob:sha256:<hex>`), where every other artifact keeps its scheme. */

/** What the wire admits for one blob; the gateway enforces its own, smaller, configured cap. */
export const MAX_BLOB_BYTES = 16 * 1024 ** 3;
/** The gateway's cap when `CAUCE_BLOB_MAX_BYTES` says nothing. */
export const DEFAULT_BLOB_MAX_BYTES = 2 * 1024 ** 3;
export const BLOB_LOCATOR_PREFIX = 'sha256:';
export const BLOB_URI_PREFIX = 'cauce-blob:sha256:';

const HEX_SHA256 = /^[a-f0-9]{64}$/u;

function digestAfter(prefix: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  const digest = value.slice(prefix.length);
  return HEX_SHA256.test(digest) ? digest : undefined;
}

export function blobLocator(sha256: string): string {
  return `${BLOB_LOCATOR_PREFIX}${sha256}`;
}

export function parseBlobLocator(value: unknown): string | undefined {
  return digestAfter(BLOB_LOCATOR_PREFIX, value);
}

export function blobArtifactUri(sha256: string): string {
  return `${BLOB_URI_PREFIX}${sha256}`;
}

export function parseBlobArtifactUri(uri: unknown): string | undefined {
  return digestAfter(BLOB_URI_PREFIX, uri);
}

export function isBlobArtifactUri(uri: unknown): boolean {
  return parseBlobArtifactUri(uri) !== undefined;
}
