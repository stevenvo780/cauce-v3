import { describe, expect, it } from 'vitest';
import {
  AgentAppearanceSchema, AgentAppearanceUpdateSchema, AgentPreferencesSchema, isAgentGlyph, isPixelIconRef,
  MAX_AGENT_FAVORITES_PER_HUMAN, PIXEL_ICON_PREFIX, pixelIconName,
} from '../src/index.js';

describe('agent glyph contract', () => {
  it.each([
    'K', 'ñ', 'Ω', '7', '🦉', '🚀', '❤\ufe0f', '👍🏽', '1\ufe0f\u20e3', '🇨🇴',
    '👩\u200d💻', '🏳\ufe0f\u200d🌈', '👨\u200d👩\u200d👧\u200d👦', 'é', 'e\u0301',
    '#\ufe0f\u20e3', 'e\u0323\u0302', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', '한', '字',
  ])('accepts the single grapheme %j', (glyph) => {
    expect(isAgentGlyph(glyph)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['two letters', 'ab'],
    ['two emoji', '🦉🚀'],
    ['space', ' '],
    ['padded letter', ' K'],
    ['no-break space', '\u00a0'],
    ['line separator', '\u2028'],
    ['control', '\u0007'],
    ['newline', 'K\n'],
    ['bidi override', '\u202eK'],
    ['zero width space', 'K\u200b'],
    ['word joiner', 'K\u2060'],
    ['byte order mark', '\ufeffK'],
    ['soft hyphen', 'K\u00ad'],
    ['tag character', '🏴\u{e0067}'],
    ['leading joiner', '\u200d🦉'],
    ['trailing joiner', '🦉\u200d'],
    ['double joiner', '👩\u200d\u200d💻'],
    ['lone combining mark', '\u0301'],
    ['lone surrogate', '\ud83e'],
    ['family followed by a person', '👨\u200d👩\u200d👧\u200d👦👨'],
    ['hangul filler', '\u3164'],
    ['hangul choseong filler', '\u115f'],
    ['halfwidth hangul filler', '\uffa0'],
    ['braille blank', '\u2800'],
    ['object replacement character', '\ufffc'],
    ['replacement character', '\ufffd'],
    ['combining grapheme joiner', 'K\u034f'],
    ['mongolian variation selector', 'K\u180b'],
    ['stacked combining marks', `a${'\u0301'.repeat(15)}`],
    ['four combining marks', `a${'\u0301'.repeat(4)}`],
    ['punctuation', '!'],
    ['plain symbol', '\u2605'],
    ['tag sequence without a cancel tag', '\u{1F3F4}\u{E0067}\u{E0062}'],
    ['tag characters after another base', 'K\u{E0067}\u{E007F}'],
    ['ignorable after a joiner', '\u{1F469}\u200d\u3164'],
  ])('rejects %s', (_label, glyph) => {
    expect(isAgentGlyph(glyph)).toBe(false);
  });

  it('caps by UTF-16 code units, not by grapheme', () => {
    const family = '👨\u200d👩\u200d👧\u200d👦';
    expect(family.length).toBe(11);
    expect(isAgentGlyph(family)).toBe(true);
    const toned = '\u{1F468}\u{1F3FD}\u200d\u{1F469}\u{1F3FD}\u200d\u{1F467}\u{1F3FD}\u200d\u{1F466}\u{1F3FD}';
    expect(toned.length).toBe(19);
    expect(isAgentGlyph(toned)).toBe(false);
  });

  it.each([null, 1, {}, ['K']])('rejects the non-string %j', (value) => {
    expect(isAgentGlyph(value)).toBe(false);
  });
});

describe('pixel icon references', () => {
  it.each(['px:robot', 'px:a', 'px:0', 'px:robot-face', 'px:git-branch', 'px:chart-bar-big', 'px:1234567890123'])('accepts %s', (ref) => {
    expect(isPixelIconRef(ref)).toBe(true);
    expect(isAgentGlyph(ref)).toBe(true);
    expect(pixelIconName(ref)).toBe(ref.slice(PIXEL_ICON_PREFIX.length));
  });

  it.each([
    ['empty name', 'px:'],
    ['too long', 'px:12345678901234'],
    ['uppercase', 'px:Robot'],
    ['space', 'px:robot face'],
    ['padded', ' px:robot'],
    ['path traversal', 'px:../x'],
    ['slash', 'px:a/b'],
    ['dot', 'px:a.b'],
    ['leading hyphen', 'px:-robot'],
    ['trailing hyphen', 'px:robot-'],
    ['double hyphen', 'px:a--b'],
    ['underscore', 'px:a_b'],
    ['newline', 'px:robot\n'],
    ['non ascii', 'px:rób'],
    ['uppercase prefix', 'PX:robot'],
  ])('rejects %s', (_label, ref) => {
    expect(isPixelIconRef(ref)).toBe(false);
    expect(isAgentGlyph(ref)).toBe(false);
    expect(pixelIconName(ref)).toBeUndefined();
  });

  it('is not a glyph that merely starts with p', () => {
    expect(pixelIconName('p')).toBeUndefined();
    expect(pixelIconName(null)).toBeUndefined();
    expect(isAgentGlyph('px')).toBe(false);
  });

  it('flows through the appearance schemas', () => {
    const body = { glyph: 'px:robot', hue: 10, style: 'pixel', expected_revision: null };
    expect(AgentAppearanceUpdateSchema.parse(body).glyph).toBe('px:robot');
    expect(AgentAppearanceUpdateSchema.safeParse({ ...body, glyph: 'px:../x' }).success).toBe(false);
  });
});

describe('agent appearance update contract', () => {
  const valid = { glyph: '🦉', hue: 210, style: 'aurora', expected_revision: null };

  it('accepts every documented style and the nullable fields', () => {
    for (const style of ['orb', 'aurora', 'pulse', 'pixel']) {
      expect(AgentAppearanceUpdateSchema.parse({ ...valid, style })).toEqual({ ...valid, style });
    }
    expect(AgentAppearanceUpdateSchema.parse({ glyph: null, hue: null, style: 'orb', expected_revision: 3 }))
      .toEqual({ glyph: null, hue: null, style: 'orb', expected_revision: 3 });
    expect(AgentAppearanceUpdateSchema.parse({ ...valid, hue: 0 }).hue).toBe(0);
    expect(AgentAppearanceUpdateSchema.parse({ ...valid, hue: 359 }).hue).toBe(359);
  });

  it.each([
    ['hue below range', { ...valid, hue: -1 }],
    ['hue above range', { ...valid, hue: 360 }],
    ['fractional hue', { ...valid, hue: 12.5 }],
    ['string hue', { ...valid, hue: '12' }],
    ['unknown style', { ...valid, style: 'neon' }],
    ['zero revision', { ...valid, expected_revision: 0 }],
    ['fractional revision', { ...valid, expected_revision: 1.5 }],
    ['missing revision', { glyph: '🦉', hue: 210, style: 'orb' }],
    ['missing style', { glyph: '🦉', hue: 210, expected_revision: null }],
    ['extra field', { ...valid, revision: 4 }],
    ['two graphemes', { ...valid, glyph: 'AB' }],
  ])('rejects %s', (_label, body) => {
    expect(AgentAppearanceUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe('agent preferences response contract', () => {
  const appearance = {
    tenant_id: 'Steven', alias: 'kant', glyph: '🦉', hue: 210, style: 'pulse', revision: 2,
    updated_at: '2026-10-06T12:00:00.000Z', updated_by: 'Alba',
  };

  it('accepts the response the gateway emits', () => {
    const body = {
      favorites: [{ tenant_id: 'Steven', alias: 'kant', created_at: '2026-10-06T12:00:00.000Z' }],
      appearances: [appearance],
    };
    expect(AgentPreferencesSchema.parse(body)).toEqual(body);
  });

  it('rejects stored rows outside the contract', () => {
    expect(AgentAppearanceSchema.safeParse({ ...appearance, revision: 0 }).success).toBe(false);
    expect(AgentAppearanceSchema.safeParse({ ...appearance, updated_by: '' }).success).toBe(false);
    const favorites = Array.from({ length: MAX_AGENT_FAVORITES_PER_HUMAN + 1 }, (_, index) => ({
      tenant_id: 'Steven', alias: `a${String(index)}`, created_at: '2026-10-06T12:00:00.000Z',
    }));
    expect(AgentPreferencesSchema.safeParse({ favorites, appearances: [] }).success).toBe(false);
  });
});
