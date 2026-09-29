import { describe, expect, it } from 'vitest';
import { referencedBlobDigests } from '../src/repository/blob-carry.js';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NESTED = 'c'.repeat(64);

describe('blob references carried by a delivery', () => {
  it('grants only structured top-level references that actually travel', () => {
    expect(referencedBlobDigests({
      text: `cauce-blob:sha256:${OTHER}`,
      attachments_v1: [
        { blob: `sha256:${SHA}` },
        { blob: 'sha256:invalid' },
      ],
      artifacts_v1: [
        { uri: `cauce-blob:sha256:${SHA}` },
        { uri: `cauce-blob:sha256:${OTHER}` },
        { uri: 'https://example.invalid/documento' },
      ],
      fanin_data_v1: { responses: [{ artifacts: [{ uri: `cauce-blob:sha256:${NESTED}` }] }] },
    })).toEqual([SHA, OTHER]);
  });

  it('ignores malformed containers and bare digests', () => {
    expect(referencedBlobDigests({
      artifacts_v1: [{ sha256: SHA }, null, [], { uri: `cauce-blob:sha256:${SHA}extra` }],
      attachments_v1: 'not an array',
    })).toEqual([]);
  });

  it('does not grant Pablo a Steven blob when artifacts_v1 combines Pablo blob with Steven uri', () => {
    expect(referencedBlobDigests({ artifacts_v1: [{
      name: 'foreign.txt', blob: `sha256:${SHA}`, uri: `cauce-blob:sha256:${OTHER}`,
    }] })).toEqual([]);
  });

  it('refuses ambiguous attachment refs and mismatched declared digests', () => {
    expect(referencedBlobDigests({
      attachments_v1: [{ blob: `sha256:${SHA}`, uri: `cauce-blob:sha256:${OTHER}` }],
      artifacts_v1: [{ uri: `cauce-blob:sha256:${SHA}`, declared_sha256: OTHER }],
    })).toEqual([]);
  });
});
