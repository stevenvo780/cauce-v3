import { describe, expect, it } from 'vitest';
import { hasUnsafeTextCodePoint, isValidUtf8Text } from '../src/index.js';

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
