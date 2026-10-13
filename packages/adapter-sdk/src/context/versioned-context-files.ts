import { createHash } from 'node:crypto';
import { VersionedContextSchema, hasGovernanceSensitivePathSegment, hasUnsafeTextCodePoint, redactSecrets, type VersionedContext } from '@cauce/protocol';

/**
 * A delivered version was judged by the gateway when it was written: reading it checks only its shape, sizes and digest, so a
 * stricter local rule or a gateway and fleet version skew never makes it unreadable. The scope is the caller's to check.
 */
export function deliveredVersionedContext(value: unknown): VersionedContext {
  const context = VersionedContextSchema.parse(value);
  const files = [...context.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (createHash('sha256').update(JSON.stringify(files)).digest('hex') !== context.digest
    || new Set(files.map(file => file.path)).size !== files.length
    || files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 1_048_576) {
    throw new Error('versioned context digest or shape is invalid');
  }
  return { ...context, files };
}

/** Judges a candidate written in the space before it leaves it: no secret, credential path or invisible formatting. */
export function canonicalVersionedContext(value: unknown): VersionedContext {
  const context = deliveredVersionedContext(value);
  if (context.files.some(file => {
    const scan = redactSecrets(file.content, { enabled: true });
    return scan.count > 0 || scan.unscanned !== undefined || hasGovernanceSensitivePathSegment(file.path)
      || hasUnsafeTextCodePoint(file.content.replace(/[\n\r\t]/gu, ''));
  })) throw new Error('versioned context digest or content is unsafe');
  return context;
}
