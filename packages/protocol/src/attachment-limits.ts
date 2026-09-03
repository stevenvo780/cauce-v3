export const MAX_ATTACHMENT_BYTES = 10_000_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10_000_000;
export const MAX_ATTACHMENT_MEDIA_TYPE_LENGTH = 127;
/* A relayed turn may answer with files and still forward the ones it received, so the delegation
   edge admits twice the per-message count -- and never more, whatever the fan-out. */
export const MAX_RELAY_ARTIFACTS_TOTAL = 2 * MAX_ATTACHMENTS_PER_MESSAGE;
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/* How many entries of `output.artifacts` an answer is judged by. The egress renders this prefix and
   no more, so a verdict taken over a longer one closes as `done` a response whose file the renderer
   never reaches -- and a `done` that renders nothing is a dead letter, worse for the person than
   the notice saying no final reply arrived. */
export const MAX_ARTIFACTS_CONSIDERED = 16;

/* A URL is a locator, not a payload: its ceiling is what a link may measure, never the byte budget
   an inline blob spends. Above it nothing on the egress renders the link anyway. */
export const MAX_ARTIFACT_LOCATOR_CHARACTERS = 2048;

/* The slack is the caller's: the wire schema needs the exact base64 bound, a pre-decode guard
   wants room to spare. One shared expression would change what the schema admits. */
export function base64CharacterBudget(bytes: number, slack = 4): number {
  return Math.ceil(bytes / 3) * 4 + slack;
}

/* Slack for everything that rides beside the encoded bytes in the same publish request: up to 100
   recipients, room id, idempotency key, the message text and the JSON framing of the envelope.
   256 KiB is far above any measured envelope and still bounds what one request can buffer. */
export const PUBLISH_ENVELOPE_SLACK_BYTES = 256 * 1024;

/* The HTTP publish body limit has to be derived, never inherited: Fastify's own default is an
   invisible 1 MiB that rejects an attachment this protocol declares legal, and it does so with a
   framework error code no caller can interpret. The bound is the aggregate attachment budget as it
   travels on the wire -- base64 -- plus the envelope slack above. */
export const MAX_PUBLISH_BODY_BYTES =
  base64CharacterBudget(MAX_ATTACHMENTS_TOTAL_BYTES) + PUBLISH_ENVELOPE_SLACK_BYTES;

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
