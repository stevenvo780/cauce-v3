import { describe, expect, it } from 'vitest';
import { deterministicUuidFromSha256 } from '../src/index.js';

const GOLDEN_VECTORS = [
  ['', 'e3b0c442-98fc-5c14-9afb-f4c8996fb924'],
  ['cauce', '6c4b181d-9cf6-585e-aa61-4143676aa22c'],
  ['request:telegram:900001:42', '4bc7b08c-978d-5246-b406-33b1d4045022'],
  ['agent-fanin:11111111-1111-4111-8111-111111111111', '7062afdd-b0a5-5e34-9b3c-66e8072b1667'],
  ['á🚀\0x', 'd805142d-d2ee-5227-862e-1b72cdf50426'],
] as const;

describe('deterministic UUID from SHA-256', () => {
  it.each(GOLDEN_VECTORS)('preserves the historical bytes for %j', (value, expected) => {
    expect(deterministicUuidFromSha256(value)).toBe(expected);
  });

  it.each(GOLDEN_VECTORS)('keeps the historical UUID v5 and RFC variant bits for %j', (value) => {
    const uuid = deterministicUuidFromSha256(value);
    expect(uuid[14]).toBe('5');
    expect(Number.parseInt(uuid[19] ?? '', 16) >> 2).toBe(2);
  });
});
