import { describe, expect, it } from 'vitest';
import {
  base64CharacterBudget, decodeCanonicalBase64, MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MEDIA_TYPE_LENGTH, MAX_ATTACHMENT_NAME_LENGTH, MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from '../src/index.js';

describe('attachment limits', () => {
  it('keeps the wire values', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10_000_000);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(4);
    expect(MAX_ATTACHMENTS_TOTAL_BYTES).toBe(10_000_000);
    expect(MAX_ATTACHMENT_MEDIA_TYPE_LENGTH).toBe(127);
    expect(MAX_ATTACHMENT_NAME_LENGTH).toBe(255);
  });

  it('carries the slack the caller asks for', () => {
    expect(base64CharacterBudget(MAX_ATTACHMENT_BYTES))
      .toBe(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4);
    expect(base64CharacterBudget(MAX_ATTACHMENT_BYTES, 64))
      .toBe(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64);
    expect(base64CharacterBudget(MAX_ATTACHMENT_BYTES, 64) - base64CharacterBudget(MAX_ATTACHMENT_BYTES))
      .toBe(60);
  });
});

describe('canonical base64 decoding', () => {
  it('accepts a canonical round trip', () => {
    const payload = Buffer.from('cauce', 'utf8');
    const decoded = decodeCanonicalBase64(payload.toString('base64'), 1_000);
    expect(decoded?.toString('utf8')).toBe('cauce');
  });

  it.each([
    undefined,
    '',
    'QQ=',
    'QR==',
    'not-base64!!',
    'AAAA'.repeat(4),
  ])('rejects the non-canonical payload %j', (value) => {
    expect(decodeCanonicalBase64(value, 8)).toBeUndefined();
  });

  it('rejects content beyond the byte budget', () => {
    const payload = Buffer.alloc(10, 0x41);
    expect(decodeCanonicalBase64(payload.toString('base64'), 8)).toBeUndefined();
    expect(decodeCanonicalBase64(payload.toString('base64'), 10)?.length).toBe(10);
  });

  it('rejects a value over the character budget before decoding it', () => {
    const oversized = 'A'.repeat(base64CharacterBudget(8) + 4);
    expect(decodeCanonicalBase64(oversized, 8)).toBeUndefined();
  });
});
