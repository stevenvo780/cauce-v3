/**
 * Secret redaction on ingestion before persisting.
 */

export type RedactionKind =
  | 'uri_credentials'
  | 'authorization'
  | 'bearer_token'
  | 'telegram_bot_token'
  | 'api_key'
  | 'jwt'
  | 'private_key';

export interface RedactionResult {
  readonly value: string;
  /** Families found, sorted, and deduplicated. Empty = nothing was touched. */
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
}

/** The mark both the agent and the human see. Deliberately self-explanatory and in Spanish. */
const MARK = '[secreto-redactado]';
const URI_MARK = '[credencial-redactada]';

interface Rule {
  readonly kind: RedactionKind;
  readonly pattern: RegExp;
  /**
   * Returns the replacement, or `undefined` to leave the text intact (anti-false-positive guard).
   *
   * Groups arrive as a list WITH the gaps: an optional group that did not match is
   * `undefined` and keeps its position. Filtering them would shift indices and make a pattern read
   * the wrong group — which is exactly how a redactor ends up masking what it should not.
   */
  replace(match: string, groups: readonly (string | undefined)[]): string | undefined;
}

/** A real token mixes letters and digits; a human-language word does not. */
function looksRandom(value: string): boolean {
  return /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
}

/** Base64/base64url or with separators: never a standalone word. */
function looksLikeToken(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/u.test(value) && /[0-9._~+/=-]/u.test(value);
}

const RULES: readonly Rule[] = [
  // Full PEM block. If someone pastes a private key, there is no ambiguity.
  {
    kind: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,20000}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
    replace: () => `${MARK} (llave privada)`
  },
  /**
   * URI with embedded credentials: the case we measured.
   *
   * The scheme and host are kept on purpose. The agent almost always needs to know WHAT the
   * human was connecting to in order to help them; what cannot remain on disk is the user/password
   * pair. Redacting the whole URI would turn a useful message into a hieroglyph.
   *
   * `[^\s/@:]` in the user and `[^\s/@]` in the password are what stop a normal URL from matching:
   * in `https://github.com/a/b` the first group cannot cross the `/`, so there is no `:` to close
   * and the pattern dies before touching anything.
   */
  {
    kind: 'uri_credentials',
    pattern: /\b([a-z][a-z0-9+.-]{1,31}):\/\/([^\s/@:]{1,128}):([^\s/@]{1,256})@/giu,
    replace: (_match, groups) => `${groups[0] ?? ''}://${URI_MARK}@`
  },
  /**
   * Authorization header in either of its written forms (`:` from HTTP, `=` from .env).
   *
   * With a declared scheme (`Bearer`, `Basic`, …) there is no ambiguity and 8 chars suffice:
   * `Authorization: Basic dXNlcjpwYXNz` is 12 and a complete credential. Without a scheme the
   * shape guard is needed, or "Authorization: responsabilidades" —a 17-letter Spanish word—
   * would end up redacted.
   */
  {
    kind: 'authorization',
    pattern: /\b(authorization)(\s*[:=]\s*)(["']?)(?:(bearer|basic|token|digest)[ \t]+)?([^\s"',;]{8,4096})/giu,
    replace: (_match, groups) => {
      const [name, separator, quote, scheme, secret] = groups;
      if (scheme === undefined && !looksLikeToken(secret ?? '')) return undefined;
      return `${name ?? ''}${separator ?? ''}${quote ?? ''}${scheme === undefined ? '' : `${scheme} `}${MARK}`;
    }
  },
  // Standalone `Bearer <token>`, with no header in front: how a token gets pasted into a chat.
  {
    kind: 'bearer_token',
    pattern: /\b(bearer)[ \t]+([A-Za-z0-9._~+/=-]{16,4096})/giu,
    replace: (_match, groups) =>
      (looksLikeToken(groups[1] ?? '') ? `${groups[0] ?? ''} ${MARK}` : undefined)
  },
  /**
   * Telegram bot token. This is the secret that costs the most here: with it, anyone reads and
   * writes as the alias in ALL its chats. The format is `<numeric id>:<35 base64url characters>`.
   */
  {
    kind: 'telegram_bot_token',
    pattern: /\b[0-9]{6,20}:[A-Za-z0-9_-]{30,200}\b/gu,
    replace: (match) => {
      const secret = match.slice(match.indexOf(':') + 1);
      return looksRandom(secret) ? MARK : undefined;
    }
  },
  // JWT: the three dot-separated parts, starting with the `eyJ` of the base64 `{"`.
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/gu,
    replace: () => MARK
  },
  /**
   * Proprietary-prefix credentials.
   */
  {
    kind: 'api_key',
    pattern: new RegExp([
      '\\bsk-ant-[A-Za-z0-9_-]{20,200}',
      '\\bsk-[A-Za-z0-9]{32,200}',
      '\\bgh[pousr]_[A-Za-z0-9]{30,255}',
      '\\bgithub_pat_[A-Za-z0-9_]{40,255}',
      '\\bAKIA[0-9A-Z]{16}\\b',
      '\\bASIA[0-9A-Z]{16}\\b',
      '\\bxox[abprs]-[A-Za-z0-9-]{15,255}',
      '\\bnpg_[A-Za-z0-9]{12,255}',
      '\\bAIza[0-9A-Za-z_-]{35}',
      '\\bglpat-[A-Za-z0-9_-]{20,255}'
    ].join('|'), 'gu'),
    replace: () => MARK
  }
];

/** Per-value work cap: an absurd text must not hang the ingestion. */
const MAX_SCANNED_CHARACTERS = 256 * 1024;

/**
 * Switch for redaction on ingestion. Off by default.
 */
function redactionEnabled(): boolean {
  return process.env.CAUCE_TELEGRAM_REDACT_INGRESS === '1';
}

export function redactSecrets(value: string): RedactionResult {
  if (!redactionEnabled() || value.length === 0 || value.length > MAX_SCANNED_CHARACTERS) {
    return { value, kinds: [], count: 0 };
  }
  const kinds = new Set<RedactionKind>();
  let count = 0;
  let text = value;
  for (const rule of RULES) {
    // `replace` with a function: each guard decides case by case, so a pattern that triggers on
    // something innocent returns the original text instead of mangling it.
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // `String.replace` passes, after the groups, the offset (number) and the full string
      // (string). They are cut by type: the groups are `string | undefined` and keep their position.
      const end = rest.findIndex((entry) => typeof entry === 'number');
      const groups = (end === -1 ? rest : rest.slice(0, end)) as readonly (string | undefined)[];
      const replacement = rule.replace(match, groups);
      if (replacement === undefined) return match;
      kinds.add(rule.kind);
      count += 1;
      return replacement;
    });
  }
  return { value: text, kinds: [...kinds].sort(), count };
}

/**
 * Keys whose value is NOT scanned.
 *
 * `content_base64` are the bytes of an attachment already magic-validated: they can be megabytes,
 * they are not text, and none of the rules here can find anything useful inside. Scanning them
 * would only burn CPU on every photo someone sends.
 */
const OPAQUE_KEYS = new Set(['content_base64']);
const MAX_DEPTH = 8;

export interface DeepRedactionResult<T> {
  readonly value: T;
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
}

/**
 * Recursively walks an object or structure to redact secrets in every string.
 */
export function redactSecretsDeep<T>(value: T): DeepRedactionResult<T> {
  const kinds = new Set<RedactionKind>();
  let count = 0;

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') {
      const result = redactSecrets(node);
      if (result.count > 0) {
        count += result.count;
        for (const kind of result.kinds) kinds.add(kind);
      }
      return result.value;
    }
    if (depth >= MAX_DEPTH || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    const source = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      output[key] = OPAQUE_KEYS.has(key) ? entry : walk(entry, depth + 1);
    }
    return output;
  };

  return { value: walk(value, 0) as T, kinds: [...kinds].sort(), count };
}
