import { MAX_ATTACHMENT_NAME_LENGTH } from './attachment-limits.js';
export function hasUnsafeTextCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb)
    ) {
      return true;
    }
  }
  return false;
}

export function isValidUtf8Text(payload: Uint8Array): boolean {
  if (payload.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return true;
  } catch {
    return false;
  }
}

const STRICT_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;

/* The cap is BYTES, as in every copy this replaces. */
export function isStrictUtcIso8601(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) return false;
  const match = STRICT_UTC_PATTERN.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const date = new Date(value);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

/* The cap is UTF-16 code units, not bytes: a name of CJK or emoji characters is admissible on the
   wire and only the on-disk name of a consumer needs a byte budget. */
export function isSafeBasename(
  value: unknown,
  options: { readonly maxLength?: number } = {},
): value is string {
  if (typeof value !== 'string') return false;
  const maxLength = options.maxLength ?? MAX_ATTACHMENT_NAME_LENGTH;
  return value.length > 0 && value.length <= maxLength &&
    value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') &&
    !hasUnsafeTextCodePoint(value);
}
