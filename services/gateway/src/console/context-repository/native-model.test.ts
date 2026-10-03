import { describe, expect, it } from 'vitest';
import { parseContextManifest } from './model.js';
import { parseNativeContextManifest, sourceNativeManualPath } from './native-model.js';
import { nativeManifest } from './native-test-fixtures.js';

describe('native inspection manifest boundary', () => {
  it.each(['claude', 'codex', 'openclaw'] as const)('derives the %s canonical path', (harness) => {
    const parsed = parseNativeContextManifest(JSON.stringify(nativeManifest(harness)));
    expect(parsed.schema_version).toBe(3);
    const agent = parsed.agents[0];
    if (agent === undefined) throw new Error('Missing fixture agent');
    expect(sourceNativeManualPath(agent)).toBe(
      `tenants/Steven/agents/helper/native/${harness}/${harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`);
    expect(() => parseContextManifest(JSON.stringify(nativeManifest(harness)))).toThrow('unsupported_schema');
  });
  it.each([1, 2, 4, '3', null])('rejects version %s in native inspection', (schema_version) => {
    expect(() => parseNativeContextManifest(JSON.stringify({ ...nativeManifest(), schema_version }))).toThrow('unsupported_schema');
  });
  it.each([
    { extra: true }, { agents: [] }, { agents: Array(65).fill(nativeManifest().agents[0]) },
    { agents: [nativeManifest().agents[0], nativeManifest().agents[0]] }, { instance_id: '../fixture' },
    { agents: [{ ...nativeManifest().agents[0], alias: '../helper' }] },
    { agents: [{ ...nativeManifest().agents[0], source_journal: { id: '1', revision: 1 } }] },
    { agents: [{ ...nativeManifest().agents[0], native_manual: { harness: 'other' } }] },
    { agents: [{ ...nativeManifest().agents[0], native_manual: { harness: 'claude', path: 'CLAUDE.md' } }] },
  ])('rejects extra keys, invalid identities and provenance %#', (override) => {
    expect(() => parseNativeContextManifest(JSON.stringify({ ...nativeManifest(), ...override }))).toThrow();
  });
  it('rejects duplicate JSON keys at every scope', () => {
    const json = JSON.stringify(nativeManifest());
    for (const [from, to] of [['"schema_version":3', '"schema_version":3,"schema_version":3'],
      ['"harness":"claude"', '"harness":"claude","harness":"codex"']] as const) {
      expect(() => parseNativeContextManifest(json.replace(from, to))).toThrow('duplicate_json_key');
    }
  });
  it.each([1, 2] as const)('preserves applicable schema %s', (schema_version) => {
    const manifest = { schema_version, instance_id: 'fixture', agents: [{ tenant_id: 'Steven', alias: 'helper',
      source_journal: schema_version === 1 ? { id: '42', revision: 1 } : null }] };
    expect(parseContextManifest(JSON.stringify(manifest))).toEqual(manifest);
  });
});
