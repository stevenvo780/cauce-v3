import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_NEVER_SERVE_BASENAMES,
  GOVERNANCE_NEVER_SERVE_SUFFIXES,
  governanceSensitiveBasenameKind,
  hasGovernanceSensitivePathSegment,
  MAX_CODEX_PROJECT_DOC_BYTES,
  parseCodexProjectDocumentConfig,
} from '../src/index.js';

const valid = {
  harness: 'codex',
  maxBytes: 65_536,
  fallbackFilenames: ['TEAM.md', 'LOCAL.md'],
} as const;

describe('Codex project document configuration authority', () => {
  it('classifies sensitive names and path segments case-insensitively', () => {
    for (const basename of GOVERNANCE_NEVER_SERVE_BASENAMES) {
      expect(governanceSensitiveBasenameKind(basename.toUpperCase()), basename)
        .toBe('forbidden_basename');
    }
    for (const suffix of GOVERNANCE_NEVER_SERVE_SUFFIXES) {
      expect(governanceSensitiveBasenameKind(`private${suffix.toUpperCase()}`), suffix)
        .toBe('credential_suffix');
    }
    expect(governanceSensitiveBasenameKind('TEAM.md')).toBeUndefined();
    expect(hasGovernanceSensitivePathSegment('/workspace/.ENV/manual.md')).toBe(true);
    expect(hasGovernanceSensitivePathSegment('/workspace/docs/TEAM.md')).toBe(false);
  });

  it('accepts the complete bounded projection', () => {
    expect(parseCodexProjectDocumentConfig(valid)).toEqual({
      maxBytes: 65_536,
      fallbackFilenames: ['TEAM.md', 'LOCAL.md'],
    });
    expect(parseCodexProjectDocumentConfig({
      ...valid,
      maxBytes: MAX_CODEX_PROJECT_DOC_BYTES,
      fallbackFilenames: [],
    })).toEqual({ maxBytes: MAX_CODEX_PROJECT_DOC_BYTES, fallbackFilenames: [] });
  });

  it.each([
    { ...valid, harness: 'claude' },
    { ...valid, maxBytes: true },
    { ...valid, maxBytes: 0 },
    { ...valid, maxBytes: MAX_CODEX_PROJECT_DOC_BYTES + 1 },
    { ...valid, fallbackFilenames: undefined },
    { ...valid, fallbackFilenames: Array.from({ length: 17 }, () => 'TEAM.md') },
    { ...valid, fallbackFilenames: ['../TEAM.md'] },
    { ...valid, fallbackFilenames: ['secret.PEM'] },
    { ...valid, fallbackFilenames: ['Auth.Json'] },
    { ...valid, fallbackFilenames: ['Agents.MD'] },
    { ...valid, fallbackFilenames: ['AGENTS.Override.MD'] },
    { ...valid, fallbackFilenames: ['TEAM\u202e.md'] },
    { ...valid, fallbackFilenames: ['TEAM\u0085.md'] },
    { ...valid, fallbackFilenames: ['TEAM.md', 'team.md'] },
  ])('rejects an incomplete, unsafe or ambiguous projection %#', (input) => {
    expect(parseCodexProjectDocumentConfig(input)).toBeUndefined();
  });
});
