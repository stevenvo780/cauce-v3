import { z } from 'zod';
import { hasUnsafeTextCodePoint } from '../content-safety.js';
import { AliasSchema, TenantSchema } from './core.js';

export const AGENT_APPEARANCE_STYLES = ['orb', 'aurora', 'pulse', 'pixel'] as const;
export const MAX_AGENT_FAVORITES_PER_HUMAN = 200;
export const MAX_AGENT_GLYPH_UTF16_UNITS = 16;
export const MAX_AGENT_APPEARANCE_AUTHOR_LENGTH = 256;
export const MAX_AGENT_GLYPH_COMBINING_MARKS = 3;
export const PIXEL_ICON_PREFIX = 'px:';

const PIXEL_ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ZERO_WIDTH_JOINER = '\u200d';
const EMOJI_VARIATION_SELECTORS = /[\ufe0e\ufe0f]/gu;
const GLYPH_BASE = /^[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const GLYPH_TAIL = /^(?:[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]|\u200d)*$/u;
const COMBINING_MARK = /\p{M}/gu;
const IGNORABLE_CODE_POINT = /\p{Default_Ignorable_Code_Point}/u;
/** Subdivision flags (England, Scotland, Wales) are the only sequences that need tag characters. */
const TAG_FLAG = /^\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}$/u;
const KEYCAP = /^[#*0-9]\ufe0f?\u20e3$/u;

let graphemes: Intl.Segmenter | undefined;

function graphemeCount(value: string): number {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const segment of graphemes.segment(value)) {
    if (segment.segment.length > 0) count += 1;
    if (count > 1) break;
  }
  return count;
}

/** Name of a pixel icon reference (`px:robot` gives `robot`), or `undefined` when the value is not one. */
export function pixelIconName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_AGENT_GLYPH_UTF16_UNITS || !value.startsWith(PIXEL_ICON_PREFIX)) return undefined;
  const name = value.slice(PIXEL_ICON_PREFIX.length);
  return PIXEL_ICON_NAME.test(name) ? name : undefined;
}

export function isPixelIconRef(value: unknown): value is string {
  return pixelIconName(value) !== undefined;
}

/**
 * A pixel icon reference or one visible grapheme whose base is a letter, a digit or an emoji. Invisible fillers (Hangul
 * fillers, combining grapheme joiner) are default-ignorable and refused; ZWJ and emoji variation
 * selectors are the only ignorable code points kept, and only inside an emoji sequence. Combining
 * marks are capped so stacked marks cannot paint outside the avatar.
 */
export function isAgentGlyph(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AGENT_GLYPH_UTF16_UNITS) return false;
  if (value.startsWith(PIXEL_ICON_PREFIX)) return isPixelIconRef(value);
  if (TAG_FLAG.test(value) || KEYCAP.test(value)) return true;
  if (!GLYPH_BASE.test(value)) return false;
  const base = value.codePointAt(0) ?? 0;
  if (!GLYPH_TAIL.test(value.slice(base > 0xffff ? 2 : 1))) return false;
  if (value.endsWith(ZERO_WIDTH_JOINER) || value.includes(ZERO_WIDTH_JOINER + ZERO_WIDTH_JOINER)) return false;
  const visible = value.replaceAll(ZERO_WIDTH_JOINER, '').replace(EMOJI_VARIATION_SELECTORS, '');
  if (IGNORABLE_CODE_POINT.test(visible) || hasUnsafeTextCodePoint(visible)) return false;
  if ((visible.match(COMBINING_MARK)?.length ?? 0) > MAX_AGENT_GLYPH_COMBINING_MARKS) return false;
  return graphemeCount(value) === 1;
}

export const AgentAppearanceStyleSchema = z.enum(AGENT_APPEARANCE_STYLES);
export const AgentGlyphSchema = z.string().refine(isAgentGlyph, {
  message: 'glyph must be a pixel icon reference (px:name) or a single visible grapheme of at most 16 UTF-16 code units',
});
export const AgentHueSchema = z.number().int().min(0).max(359);
export const AgentAppearanceRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const AgentAppearanceUpdateSchema = z.object({
  glyph: AgentGlyphSchema.nullable(),
  hue: AgentHueSchema.nullable(),
  style: AgentAppearanceStyleSchema,
  expected_revision: AgentAppearanceRevisionSchema.nullable(),
}).strict();

export const AgentFavoriteSchema = z.object({
  tenant_id: TenantSchema,
  alias: AliasSchema,
  created_at: z.string(),
}).strict();

export const AgentAppearanceSchema = z.object({
  tenant_id: TenantSchema,
  alias: AliasSchema,
  glyph: AgentGlyphSchema.nullable(),
  hue: AgentHueSchema.nullable(),
  style: AgentAppearanceStyleSchema,
  revision: AgentAppearanceRevisionSchema,
  updated_at: z.string(),
  updated_by: z.string().min(1).max(MAX_AGENT_APPEARANCE_AUTHOR_LENGTH),
}).strict();

export const AgentPreferencesSchema = z.object({
  favorites: z.array(AgentFavoriteSchema).max(MAX_AGENT_FAVORITES_PER_HUMAN),
  appearances: z.array(AgentAppearanceSchema),
}).strict();

export const AGENT_PREFERENCE_ERRORS = {
  favoriteLimit: 'favorite_limit_reached',
  revisionConflict: 'revision_conflict',
  humanSessionRequired: 'unauthorized',
} as const;

export type AgentAppearanceStyle = z.infer<typeof AgentAppearanceStyleSchema>;
export type AgentAppearanceUpdate = z.infer<typeof AgentAppearanceUpdateSchema>;
export type AgentFavorite = z.infer<typeof AgentFavoriteSchema>;
export type AgentAppearance = z.infer<typeof AgentAppearanceSchema>;
export type AgentPreferences = z.infer<typeof AgentPreferencesSchema>;
