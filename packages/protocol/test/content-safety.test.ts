import { describe, expect, it } from 'vitest';
import { hasUnsafeTextCodePoint, isSafeBasename, isStrictUtcIso8601, isValidUtf8Text } from '../src/index.js';

describe('content safety authority', () => {
  it.each([
    '\u0000', '\u001f', '\u007f', '\u009f', '\u061c', '\u200b', '\u200f',
    '\u2028', '\u202e', '\u2060', '\u206f', '\ufeff', '\ufff9', '\ufffb',
  ])('rejects unsafe code point %j', (value) => {
    expect(hasUnsafeTextCodePoint(value)).toBe(true);
  });

  it.each(['plain text', 'áéíóú', 'emoji 🚀', '/', '\\'])('accepts safe text %j', (value) => {
    expect(hasUnsafeTextCodePoint(value)).toBe(false);
  });

  it.each([
    new Uint8Array(),
    Buffer.from('texto válido', 'utf8'),
    Uint8Array.from([0xf0, 0x9f, 0x9a, 0x80]),
  ])('accepts valid UTF-8 bytes %#', (payload) => {
    expect(isValidUtf8Text(payload)).toBe(true);
  });

  it.each([
    Uint8Array.from([0x61, 0x00, 0x62]),
    Uint8Array.from([0x80]),
    Uint8Array.from([0xc0, 0xaf]),
    Uint8Array.from([0xc3, 0x28]),
    Uint8Array.from([0xed, 0xa0, 0x80]),
    Uint8Array.from([0xf0, 0x9f, 0x9a]),
    Uint8Array.from([0xf4, 0x90, 0x80, 0x80]),
  ])('rejects nulls or malformed UTF-8 bytes %#', (payload) => {
    expect(isValidUtf8Text(payload)).toBe(false);
  });
});

describe('strict UTC instants', () => {
  it.each([
    '2026-09-02T10:00:00Z',
    '2026-09-02T10:00:00.123Z',
    '2026-09-02T10:00:00.123456789Z',
  ])('accepts the UTC instant %j', (value) => {
    expect(isStrictUtcIso8601(value, 64)).toBe(true);
  });

  it.each([
    '2026-02-30T00:00:00Z',
    '2026-09-02T10:00:00+00:00',
    '2026-09-02T10:00:00',
    '2026-09-02 10:00:00Z',
    '2026-13-02T10:00:00Z',
    undefined,
    5,
  ])('rejects the instant %j', (value) => {
    expect(isStrictUtcIso8601(value, 64)).toBe(false);
  });

  it('caps the candidate in bytes', () => {
    expect(isStrictUtcIso8601('2026-09-02T10:00:00Z', 19)).toBe(false);
    expect(isStrictUtcIso8601('2026-09-02T10:00:00Z', 20)).toBe(true);
  });
});

describe('safe basenames', () => {
  it.each(['a.txt', 'informe con espacios y acentos.txt', 'volcado', '\u{1F680}'.repeat(64) + '.txt'])(
    'accepts the basename %j',
    (value) => {
      expect(isSafeBasename(value)).toBe(true);
    },
  );

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a'.repeat(256), 'report\u202Efdp.exe', undefined, 5])(
    'rejects the basename %j',
    (value) => {
      expect(isSafeBasename(value)).toBe(false);
    },
  );

  it('counts UTF-16 code units, not bytes', () => {
    const emoji = '\u{1F680}'.repeat(64) + '.txt';
    expect(emoji.length).toBe(132);
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(260);
    expect(isSafeBasename(emoji, { maxLength: 255 })).toBe(true);
    expect(isSafeBasename(emoji, { maxLength: 131 })).toBe(false);
  });
});
