/**
 * Third-party content sanitisation and confusable-name detection.
 */

import type { TelegramUser } from './types.js';

// Detecting control characters IS the goal: this regex sanitises free text controlled by third
// parties (names, usernames, reply excerpts) before it reaches the harness's prompt.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]+', 'gu');

/**
 * Invisible code points: zero width (U+200B-U+200D, U+FEFF), bidirectional overrides and
 * isolates (U+061C, U+200E/F, U+202A-E, U+2066-9), and the interlinear annotation controls.
 *
 * Removed rather than replaced by a space so they cannot pad a name to look like separate words.
 */
// Written as explicit \u escapes (not literal glyphs) so the pattern survives copy/paste and
// diffing without depending on invisible bytes in the source file itself.
const INVISIBLE_CHARACTERS =
  new RegExp('[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'gu');

/**
 * Combining marks and formatting. They are erased for the skeleton (not for the displayed name):
 * `\p{M}` covers accents, diacritics and the dot that `toLowerCase()` adds to Turkish İ;
 * `\p{Cf}` is the safety net in case some text that did not pass through `safeInline` reaches here
 * (bidi and zero-width were already stripped by `INVISIBLE_CHARACTERS`).
 */
const SKELETON_NOISE = /[\p{M}\p{Cf}]/gu;

/** Word separator for token comparison: anything that is not a letter or a digit. */
const SKELETON_SEPARATORS = /[^\p{L}\p{N}]+/gu;

/** [latin prototype, confusables that collapse onto it]. See the header comment. */
const CONFUSABLE_TABLE: readonly (readonly [string, string])[] = [
  // CYRILLIC A / GREEK ALPHA / LATIN ALPHA / SMALL CAPITAL A
  ['a', '\u0430\u03b1\u0251\u1d00'],
  // CYRILLIC VE / CYRILLIC SOFT SIGN / GREEK BETA / SMALL CAPITAL B
  ['b', '\u0432\u044c\u03b2\u0299'],
  // CYRILLIC ES / GREEK LUNATE SIGMA / SMALL CAPITAL C / ROMAN NUMERAL 100
  ['c', '\u0441\u03f2\u1d04\u217d'],
  // CYRILLIC KOMI DE / SMALL CAPITAL D / ROMAN NUMERAL 500
  ['d', '\u0501\u1d05\u217e'],
  // CYRILLIC IE / CYRILLIC UKRAINIAN IE / GREEK EPSILON / SMALL CAPITAL E / ESTIMATED SIGN
  ['e', '\u0435\u0454\u03b5\u1d07\u212e'],
  // GREEK DIGAMMA
  ['f', '\u03dd'],
  // LATIN SCRIPT G / ARMENIAN CO
  ['g', '\u0261\u0581'],
  // CYRILLIC SHHA / ARMENIAN HO / SMALL CAPITAL H
  ['h', '\u04bb\u0570\u029c'],
  // CYRILLIC I / CYRILLIC YI / GREEK IOTA / LATIN DOTLESS I / SMALL CAPITAL I / ROMAN NUMERAL 1
  ['i', '\u0456\u0457\u03b9\u0131\u026a\u2170'],
  // CYRILLIC JE / GREEK YOT / LATIN DOTLESS J
  ['j', '\u0458\u03f3\u0237'],
  // CYRILLIC KA / GREEK KAPPA / SMALL CAPITAL K
  ['k', '\u043a\u03ba\u1d0b'],
  // CYRILLIC PALOCHKA / ROMAN NUMERAL 50 / SMALL CAPITAL L
  ['l', '\u04cf\u217c\u029f'],
  // CYRILLIC EM / ROMAN NUMERAL 1000 / SMALL CAPITAL M
  ['m', '\u043c\u217f\u1d0d'],
  // CYRILLIC PE / GREEK ETA / SMALL CAPITAL N
  ['n', '\u043f\u03b7\u0274'],
  // CYRILLIC O / GREEK OMICRON / GREEK SIGMA / ARMENIAN OH / SMALL CAPITAL O
  ['o', '\u043e\u03bf\u03c3\u0585\u1d0f'],
  // CYRILLIC ER / GREEK RHO / GREEK RHO SYMBOL / SMALL CAPITAL P
  ['p', '\u0440\u03c1\u03f1\u1d18'],
  // CYRILLIC QA
  ['q', '\u051b'],
  // CYRILLIC GHE / SMALL CAPITAL R
  ['r', '\u0433\u0280'],
  // CYRILLIC DZE  <- the S from the report: the uppercase U+0405 folds here
  ['s', '\u0455'],
  // CYRILLIC TE / GREEK TAU / SMALL CAPITAL T
  ['t', '\u0442\u03c4\u1d1b'],
  // GREEK UPSILON / GREEK MU (the MICRO SIGN U+00B5 decomposes into it) / SMALL CAPITAL U
  ['u', '\u03c5\u03bc\u1d1c'],
  // GREEK NU / CYRILLIC IZHITSA / SMALL CAPITAL V / ROMAN NUMERAL 5
  ['v', '\u03bd\u0475\u1d20\u2174'],
  // CYRILLIC WE / GREEK OMEGA / SMALL CAPITAL W
  ['w', '\u051d\u03c9\u1d21'],
  // CYRILLIC HA / GREEK CHI / ROMAN NUMERAL 10
  ['x', '\u0445\u03c7\u2179'],
  // CYRILLIC U / CYRILLIC STRAIGHT U / GREEK GAMMA / SMALL CAPITAL Y
  ['y', '\u0443\u04af\u03b3\u028f'],
  // GREEK ZETA (the uppercase U+0396 folds here) / SMALL CAPITAL Z
  ['z', '\u03b6\u1d22'],
  // LATIN SHARP S: toLowerCase() leaves it as is; the real case-folding splits it into "ss"
  ['ss', '\u00df']
];

const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_TABLE.flatMap(([prototype, sources]) => Array.from(sources).map((source) => [source, prototype] as const))
);

/**
 * Minimum name length that is compared against an alias.
 *
 * Below three characters a match stops meaning anything: any short nickname would collide with
 * anything else and the warning would lose all its value through saturation.
 */
const MIN_RESERVED_NAME_LENGTH = 3;

/** Length ceilings. A name is not a message: truncating is part of the defence. */
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_USERNAME_LENGTH = 32;

export function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const characters = Array.from(value.split('\u0000').join(''));
  if (characters.length === 0) return undefined;
  return characters.slice(0, limit).join('');
}

/**
 * Sanitiser for attacker-controlled free text (display names, usernames, reply excerpts).
 *
 * Beyond `safeText`'s NUL stripping it removes every C0/C1 control character, every invisible
 * formatting code point, and collapses whitespace, so a hostile value cannot forge the
 * line-oriented delimiters the harness prompt is built from. It does NOT neutralise instructions:
 * the value is delivered inside an explicitly untrusted, clearly delimited block, and never
 * reaches `origin.metadata`, which the harness renders as TRUSTED ORIGIN CONTEXT.
 */
export function safeInline(value: unknown, limit: number): string | undefined {
  const cleaned = safeText(value, limit * 4);
  if (cleaned === undefined) return undefined;
  const collapsed = cleaned
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (collapsed.length === 0) return undefined;
  return Array.from(collapsed).slice(0, limit).join('');
}

/**
 * Confusable skeleton: two strings that RENDER the same must yield the same skeleton.
 *
 * Only used to compare against the fleet's reserved names and to show the agent what was compared
 * against. It never replaces the human-written name: the displayed name is theirs, sanitised, not
 * their skeleton.
 */
export function confusableSkeleton(value: string): string {
  const folded = value.normalize('NFKD').toLowerCase().replace(SKELETON_NOISE, '');
  let mapped = '';
  for (const character of folded) mapped += CONFUSABLES.get(character) ?? character;
  return mapped.normalize('NFD').replace(SKELETON_NOISE, '');
}

/**
 * Does this name render like that of someone on the fleet?
 *
 * It compares the full skeleton and also each individual token, because "Ζeus (support)" is the
 * same attempt as "Ζeus". It intentionally does NOT match by substring: "kanta" is not an attempt
 * to impersonate `kant`, and a warning that fires with normal names becomes noise and stops being
 * read — which is exactly how the warning that actually mattered gets lost.
 */
export function reservedNameHit(value: string, reserved: Iterable<string>): string | undefined {
  const skeleton = confusableSkeleton(value);
  if (skeleton.length === 0) return undefined;
  const tokens = new Set(skeleton.split(SKELETON_SEPARATORS).filter((token) => token.length > 0));
  if (tokens.size === 0) return undefined;
  for (const name of reserved) {
    const target = confusableSkeleton(name);
    if (target.length < MIN_RESERVED_NAME_LENGTH) continue;
    if (skeleton === target || tokens.has(target)) return name;
  }
  return undefined;
}

/** Impersonation suspicion: which name it mimics, by which field, and with which skeleton it was detected. */
export interface ImpersonationSuspicion {
  readonly collides_with: string;
  readonly field: 'display_name' | 'username';
  readonly normalized: string;
}

export interface UntrustedAuthor {
  /** Absent when Telegram did not send a usable name or username. */
  readonly author: Record<string, unknown> | undefined;
  readonly impersonation: ImpersonationSuspicion | undefined;
}

/**
 * UNVERIFIED identity of the human who wrote the message, ready for the untrusted block.
 *
 * `display_name` is free text chosen by the sender; `username` is the Telegram @, which Telegram
 * does force to be unique and ASCII but which can still be called `zeus_oficial`. Both are
 * compared against the fleet's reserved names: the impersonation vector is to pose as another
 * agent or as the install's owner.
 */
export function untrustedAuthor(
  from: TelegramUser | undefined,
  reserved: Iterable<string>
): UntrustedAuthor {
  const username = safeInline(from?.username, MAX_USERNAME_LENGTH);
  const displayName = safeInline(from?.first_name, MAX_DISPLAY_NAME_LENGTH);
  const author = {
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { display_name: displayName })
  };
  if (Object.keys(author).length === 0) return { author: undefined, impersonation: undefined };
  // The visible name first: it is the one seen in the chat and the cheapest to forge.
  const byDisplayName = displayName === undefined ? undefined : reservedNameHit(displayName, reserved);
  const byUsername = username === undefined ? undefined : reservedNameHit(username, reserved);
  const impersonation: ImpersonationSuspicion | undefined =
    byDisplayName !== undefined && displayName !== undefined
      ? { collides_with: byDisplayName, field: 'display_name', normalized: confusableSkeleton(displayName) }
      : byUsername !== undefined && username !== undefined
        ? { collides_with: byUsername, field: 'username', normalized: confusableSkeleton(username) }
        : undefined;
  return { author, impersonation };
}
