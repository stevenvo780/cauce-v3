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

export type CarriedBlobField = 'attachments_v1' | 'artifacts_v1';

export function isCarriedBlobCandidate(entry: unknown, field: CarriedBlobField): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (field === 'attachments_v1') return Object.hasOwn(record, 'blob') || Object.hasOwn(record, 'uri');
  return Object.hasOwn(record, 'blob')
    || (typeof record.uri === 'string' && record.uri.trimStart().startsWith(BLOB_URI_PREFIX));
}

export function parseCarriedBlobReference(entry: unknown, field: CarriedBlobField): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  if (Object.hasOwn(record, 'blob') && Object.hasOwn(record, 'uri')) return undefined;
  const digest = field === 'attachments_v1'
    ? parseBlobLocator(record.blob)
    : parseBlobArtifactUri(record.uri);
  if (digest === undefined) return undefined;
  for (const claim of ['sha256', 'declared_sha256'] as const) {
    if (Object.hasOwn(record, claim) && record[claim] !== digest) return undefined;
  }
  return digest;
}

export function isBlobArtifactUri(uri: unknown): boolean {
  return parseBlobArtifactUri(uri) !== undefined;
}
