import { createHash } from 'node:crypto';
import { VersionedContextSchema, hasGovernanceSensitivePathSegment, hasUnsafeTextCodePoint, redactSecrets, type VersionedContext } from '@cauce/protocol';

export function canonicalVersionedContext(value: unknown): VersionedContext {
  const context = VersionedContextSchema.parse(value);
  const files = [...context.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (createHash('sha256').update(JSON.stringify(files)).digest('hex') !== context.digest
    || new Set(files.map(file => file.path)).size !== files.length
    || files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 1_048_576
    || files.some(file => {
      const scan = redactSecrets(file.content, { enabled: true });
      return scan.count > 0 || scan.unscanned !== undefined || file.path.split('/').some(hasGovernanceSensitivePathSegment)
        || hasUnsafeTextCodePoint(file.content.replace(/[\n\r\t]/gu, ''));
    })) throw new Error('versioned context digest or content is unsafe');
  return { ...context, files };
}
