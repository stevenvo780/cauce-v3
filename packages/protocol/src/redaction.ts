/* Secret redaction. The switch is a parameter, never an environment read: the bridge keeps its
   ingress off by default while the gateway redacts on by default, and both share these rules. */

export type RedactionKind =
  | 'uri_credentials'
  | 'authorization'
  | 'bearer_token'
  | 'telegram_bot_token'
  | 'api_key'
  | 'jwt'
  | 'private_key';

export interface RedactionOptions {
  readonly enabled: boolean;
}

export type RedactionUnscannedReason = 'value_length' | 'character_budget' | 'node_budget';

/** One bound and what it left out: characters for the two length bounds, nodes for the node one. */
export interface RedactionUnscannedPart {
  readonly reason: RedactionUnscannedReason;
  readonly count: number;
}

/** What the bounds left out of the scan. A sanitizer that cannot name its own blind spot is not
    one: absent means everything was read, present means the caller must log it or reject. Every
    bound that fired is in `reasons` -- reporting only the first hides the second blind spot. */
export interface RedactionUnscanned {
  /** The single bound that fired, or `mixed` when more than one did. */
  readonly reason: RedactionUnscannedReason | 'mixed';
  /** The parts added up. Units differ per reason, so act on `reasons`, not on this alone. */
  readonly count: number;
  readonly reasons: readonly RedactionUnscannedPart[];
}

export interface RedactionResult {
  readonly value: string;
  /** Families found, sorted, and deduplicated. Empty = nothing was touched. */
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
  readonly unscanned?: RedactionUnscanned;
}

/** The mark both the agent and the human see. Deliberately self-explanatory and in Spanish. */
export const REDACTION_MARK = '[secreto-redactado]';
export const REDACTION_URI_MARK = '[credencial-redactada]';

interface Rule {
  readonly kind: RedactionKind;
  readonly pattern: RegExp;
  /* Returns the replacement, or `undefined` to leave the text intact (anti-false-positive guard).
     Groups arrive WITH the gaps: an unmatched optional group is `undefined` and keeps its position,
     and filtering them would make a pattern read the wrong group. */
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
  {
    kind: 'private_key',
    /* `-(?!----)` keeps the hyphen of a `Proc-Type` header and aborts on the next `-----BEGIN`, so a
       header flood costs one attempt, not 20 000; a body carrying a five-dash run is given up. */
    pattern: /-----BEGIN (?:[A-Z0-9 ]{1,64} )?PRIVATE KEY-----(?:[^-]|-(?!----)){0,20000}?-----END (?:[A-Z0-9 ]{1,64} )?PRIVATE KEY-----/gu,
    replace: () => `${REDACTION_MARK} (llave privada)`
  },
  /* Scheme and host are kept: only the user/password pair must not stay on disk. `[^\s/@:]` in the
     user is what stops a normal URL: in `https://github.com/a/b` the group cannot cross the `/`,
     so there is no `:` to close and the pattern dies before touching anything. */
  {
    kind: 'uri_credentials',
    pattern: /\b([a-z][a-z0-9+.-]{1,31}):\/\/([^\s/@:]{1,128}):([^\s/@]{1,256})@/giu,
    replace: (_match, groups) => `${groups[0] ?? ''}://${REDACTION_URI_MARK}@`
  },
  /* Both written forms (`:` from HTTP, `=` from .env). With a declared scheme 8 characters suffice;
     without one the shape guard is needed, or "Authorization: responsabilidades" gets redacted. */
  {
    kind: 'authorization',
    pattern: /\b(authorization)(\s{0,64}[:=]\s{0,64})(["']?)(?:(bearer|basic|token|digest)[ \t]+)?([^\s"',;]{8,4096})/giu,
    replace: (_match, groups) => {
      const [name, separator, quote, scheme, secret] = groups;
      if (scheme === undefined && !looksLikeToken(secret ?? '')) return undefined;
      return `${name ?? ''}${separator ?? ''}${quote ?? ''}${scheme === undefined ? '' : `${scheme} `}${REDACTION_MARK}`;
    }
  },
  {
    kind: 'bearer_token',
    pattern: /\b(bearer)[ \t]+([A-Za-z0-9._~+/=-]{16,4096})/giu,
    replace: (_match, groups) =>
      (looksLikeToken(groups[1] ?? '') ? `${groups[0] ?? ''} ${REDACTION_MARK}` : undefined)
  },
  /* `<numeric id>:<35 base64url characters>`: with it anyone reads and writes as the alias. */
  {
    kind: 'telegram_bot_token',
    pattern: /\b[0-9]{6,20}:[A-Za-z0-9_-]{30,200}\b/gu,
    replace: (match) => {
      const secret = match.slice(match.indexOf(':') + 1);
      return looksRandom(secret) ? REDACTION_MARK : undefined;
    }
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/gu,
    replace: () => REDACTION_MARK
  },
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
    replace: () => REDACTION_MARK
  }
];

/** Scan window: no regex ever runs over more characters than this, which is the ReDoS bound. A
    longer value is walked window by window instead of being waved through unread. */
export const MAX_SCANNED_CHARACTERS = 256 * 1024;

/** Longest text a single rule can match, and therefore the overlap two windows must share for a
    secret sitting on the seam to fall whole inside one of them. Every quantifier of every rule is
    bounded so this is a real ceiling: the widest is `private_key` (20 000 of body plus its two
    markers of at most 91 each), and no rule may be added whose match can grow past it. */
export const MAX_RULE_MATCH_CHARACTERS = 20 * 1024;

/** Ceiling for one value: the work is linear in the length, so an absurd text still has to stop
    somewhere. It sits far above any real paste, and whatever is left beyond it travels verbatim
    AND is reported. */
export const MAX_SCANNED_VALUE_CHARACTERS = 1024 * 1024;

/** Node budget of one deep walk. It replaces the old depth cap: depth costs nothing on an
    explicit stack, and what bounds the work is how many nodes are visited. */
export const MAX_SCANNED_NODES = 100_000;

/** Character budget of one deep walk, and the only bound on its total cost: the per-value ceiling
    bounds one string and the node budget bounds how many, but a body of many big values multiplies
    both. It sits above any real paste and far below what a body limit admits, so a crafted payload
    cannot buy seconds of the shared event loop; the remainder travels verbatim AND is reported. */
export const MAX_SCANNED_TOTAL_CHARACTERS = 4 * 1024 * 1024;

const WINDOW_STEP = MAX_SCANNED_CHARACTERS - MAX_RULE_MATCH_CHARACTERS;

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: RedactionKind;
}

/* Matches of one rule over the whole value, as absolute ranges. A match ending exactly on the
   right edge of a non-final window is dropped: it may be a truncation of a longer one, and the
   next window -- which overlaps by the longest possible match -- sees it whole. */
function ruleMatches(rule: Rule, value: string, limit: number): Replacement[] {
  const found: Replacement[] = [];
  for (let from = 0; from < limit; from += WINDOW_STEP) {
    const to = Math.min(from + MAX_SCANNED_CHARACTERS, limit);
    const window = value.slice(from, to);
    const last = to === limit;
    rule.pattern.lastIndex = 0;
    for (let hit = rule.pattern.exec(window); hit !== null; hit = rule.pattern.exec(window)) {
      const text = hit[0];
      if (text.length === 0) break;
      const start = from + hit.index;
      const end = start + text.length;
      const replacement = rule.replace(text, hit.slice(1));
      if (replacement === undefined || (!last && end === to)) continue;
      if (start >= (found.at(-1)?.end ?? 0)) found.push({ start, end, text: replacement, kind: rule.kind });
    }
    if (to === limit) break;
  }
  return found;
}

/* Earlier rules win: a candidate overlapping an accepted range is dropped, which is what the old
   pass got from running each rule over the text the previous one had already rewritten. */
function mergeMatches(accepted: readonly Replacement[], candidates: readonly Replacement[]): Replacement[] {
  const merged: Replacement[] = [];
  let taken = 0;
  let next = 0;
  let end = 0;
  for (const candidate of candidates) {
    for (
      let entry = accepted[taken];
      entry !== undefined && entry.start <= candidate.start;
      entry = accepted[taken]
    ) {
      merged.push(entry);
      end = Math.max(end, entry.end);
      taken += 1;
    }
    next = accepted[taken]?.start ?? Number.MAX_SAFE_INTEGER;
    if (candidate.start >= end && candidate.end <= next) {
      merged.push(candidate);
      end = candidate.end;
    }
  }
  return [...merged, ...accepted.slice(taken)];
}

function applyMatches(value: string, matches: readonly Replacement[]): string {
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += value.slice(cursor, match.start) + match.text;
    cursor = match.end;
  }
  return out + value.slice(cursor);
}

/** `'1'` turns redaction on, `'0'` off; an absent variable leaves the caller's default. */
export function redactionEnabledFromEnv(
  env: NodeJS.ProcessEnv, name: string, defaultOn: boolean
): boolean {
  const raw = env[name];
  if (raw === '1') return true;
  if (raw === '0') return false;
  return defaultOn;
}

/* Every bound that fired, never only the first: two blind spots reported as one is the same
   defect the field exists to close. */
function unscannedReport(
  parts: readonly RedactionUnscannedPart[]
): { unscanned?: RedactionUnscanned } {
  const reasons = parts.filter((part) => part.count > 0);
  const [first] = reasons;
  if (first === undefined) return {};
  const count = reasons.reduce((total, part) => total + part.count, 0);
  return { unscanned: { reason: reasons.length === 1 ? first.reason : 'mixed', count, reasons } };
}

interface ScanOutcome {
  readonly value: string;
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
}

/* One pass over the first `limit` characters. A limit of zero reads nothing and rewrites nothing:
   that is how a walk out of budget hands the value over verbatim instead of paying for it. */
function scanValue(value: string, limit: number): ScanOutcome {
  let matches: readonly Replacement[] = [];
  for (const rule of RULES) matches = mergeMatches(matches, ruleMatches(rule, value, limit));
  const kinds = new Set<RedactionKind>();
  for (const match of matches) kinds.add(match.kind);
  return { value: applyMatches(value, matches), kinds: [...kinds].sort(), count: matches.length };
}

export function redactSecrets(value: string, options: RedactionOptions): RedactionResult {
  if (!options.enabled || value.length === 0) return { value, kinds: [], count: 0 };
  const limit = Math.min(value.length, MAX_SCANNED_VALUE_CHARACTERS);
  return {
    ...scanValue(value, limit),
    ...unscannedReport([{ reason: 'value_length', count: value.length - limit }])
  };
}

/** An attachment name reaches disk and the console, so it is scanned like any other text. */
export function redactAttachmentName(name: string, options: RedactionOptions): string {
  return redactSecrets(name, options).value;
}

/* Keys whose value is NOT scanned. `content_base64` are attachment bytes already magic-validated:
   megabytes of non-text where no rule finds anything. The blind spot is deliberate. */
const OPAQUE_KEYS = new Set(['content_base64']);

export interface DeepRedactionResult<T> {
  readonly value: T;
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
  readonly unscanned?: RedactionUnscanned;
}

interface WalkTask {
  readonly node: unknown;
  readonly place: (result: unknown) => void;
}

/**
 * Explicit stack, no recursion: depth costs nothing and no structure can overflow the call stack.
 * Every rebuilt object is `Object.create(null)`, so a `__proto__` key from a parsed payload lands
 * as an ordinary own property instead of invoking the prototype setter -- the redactor must not
 * manufacture the pollution that `JSON.parse` had safely contained, and must not drop the key.
 */
export function redactSecretsDeep<T>(value: T, options: RedactionOptions): DeepRedactionResult<T> {
  if (!options.enabled) return { value, kinds: [], count: 0 };
  const kinds = new Set<RedactionKind>();
  let count = 0;
  let overValue = 0;
  let overBudget = 0;
  let skipped = 0;
  let characters = MAX_SCANNED_TOTAL_CHARACTERS;
  let budget = MAX_SCANNED_NODES;
  let root: unknown;
  const stack: WalkTask[] = [{ node: value, place: (result) => { root = result; } }];

  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    const node = task.node;
    if (budget <= 0) {
      task.place(node);
      skipped += 1;
      continue;
    }
    budget -= 1;
    if (typeof node === 'string') {
      const ceiling = Math.min(node.length, MAX_SCANNED_VALUE_CHARACTERS);
      const limit = Math.min(ceiling, characters);
      const result = scanValue(node, limit);
      characters -= limit;
      overValue += node.length - ceiling;
      overBudget += ceiling - limit;
      count += result.count;
      for (const kind of result.kinds) kinds.add(kind);
      task.place(result.value);
      continue;
    }
    if (node === null || typeof node !== 'object') {
      task.place(node);
      continue;
    }
    if (Array.isArray(node)) {
      const output: unknown[] = [];
      task.place(output);
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node[index], place: (result) => { output[index] = result; } });
      }
      continue;
    }
    const output = Object.create(null) as Record<string, unknown>;
    task.place(output);
    for (const [key, entry] of Object.entries(node)) {
      if (OPAQUE_KEYS.has(key)) output[key] = entry;
      else stack.push({ node: entry, place: (result) => { output[key] = result; } });
    }
  }

  const unscanned = unscannedReport([
    { reason: 'value_length', count: overValue },
    { reason: 'character_budget', count: overBudget },
    { reason: 'node_budget', count: skipped }
  ]);
  return { value: root as T, kinds: [...kinds].sort(), count, ...unscanned };
}
