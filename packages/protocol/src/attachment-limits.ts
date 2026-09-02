export const MAX_ATTACHMENT_BYTES = 10_000_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10_000_000;
export const MAX_ATTACHMENT_MEDIA_TYPE_LENGTH = 127;
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/* The slack is the caller's: the wire schema needs the exact base64 bound, a pre-decode guard
   wants room to spare. One shared expression would change what the schema admits. */
export function base64CharacterBudget(bytes: number, slack = 4): number {
  return Math.ceil(bytes / 3) * 4 + slack;
}

/* One quantifier over a character class: a repeated group backtracks per repetition and
   overflows the regex stack around 4 M characters, below what the protocol admits. */
const CANONICAL_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export function decodeCanonicalBase64(value: unknown, maxBytes: number): Buffer | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 ||
      value.length > base64CharacterBudget(maxBytes)) {
    return undefined;
  }
  if (!CANONICAL_BASE64_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maxBytes || decoded.toString('base64') !== value) return undefined;
  return decoded;
}
