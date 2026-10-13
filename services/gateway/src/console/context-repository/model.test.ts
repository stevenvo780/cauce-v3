import * as protocol from '@cauce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitContextText, CONTEXT_REPOSITORY_LIMITS, parseJson, parseSourceProfile,
  sourceProfilePath, validateContextScope,
} from './model.js';

const scope = { instance_id: 'fixture', tenant_id: 'tenant-a', alias: 'helper' };
const agent = { tenant_id: 'tenant-a', alias: 'helper' };
const profile = {
  purpose: '  Review fixtures  ', role_summary: null, human_brief: null,
  responsibilities: [' Check scope ', ''], restrictions: [], tools: [], operating_rules: [],
};

describe('context repository profile admission', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('uses the canonical normalizer without importing derived permissions or duplicated identity', () => {
    expect(parseSourceProfile(JSON.stringify(profile), agent)).toEqual({
      ...profile, tenant_id: 'tenant-a', alias: 'helper', purpose: 'Review fixtures',
      responsibilities: ['Check scope'],
    });
    for (const extra of [{ allow_control: true }, { tenant_id: 'tenant-b' }, { alias: 'other' }]) {
      expect(() => parseSourceProfile(JSON.stringify({ ...profile, ...extra }), agent)).toThrow('invalid_schema');
    }
    expect(() => parseSourceProfile(JSON.stringify({ ...profile, purpose: 'x'.repeat(2001) }), agent))
      .toThrow('invalid_profile');
  });

  it.each(['../other', 'UPPER', '', '/root', 'a/b', 'id_rsa'])('rejects unsafe scope %j', (alias) => {
    expect(() => { validateContextScope({ ...scope, alias }); }).toThrow();
  });

  it.each([
    Buffer.from([0xff]), Buffer.from('a\0b'), Buffer.alloc(CONTEXT_REPOSITORY_LIMITS.blobBytes + 1, 'a'),
  ])('rejects invalid or oversized bytes %#', (content) => {
    expect(() => admitContextText(content)).toThrow();
  });

  it('rejects recognized synthetic secrets in free text and escaped JSON without echoing them', () => {
    const synthetic = 'https://fixture-user:fixture-password@example.invalid/path';
    expect(() => admitContextText(Buffer.from(synthetic))).toThrow('context repository: forbidden_content');
    const escaped = JSON.stringify({ ...profile, purpose: synthetic })
      .replace('https:', 'https\\u003a').replace('fixture-user:', 'fixture-user\\u003a');
    expect(() => parseSourceProfile(escaped, agent)).toThrow('context repository: forbidden_content');
  });

  it('reports malformed JSON and missing fields without echoing content', () => {
    expect(() => parseJson('{"private fixture')).toThrow('context repository: invalid_json');
    expect(() => parseSourceProfile('{}', agent)).toThrow('invalid_schema');
  });

  it.each(['\t', '\n', '\r\n'])('scans decoded whitespace in authorization-like synthetic text %#', (space) => {
    const synthetic = `Authorization:${space}Bearer fixture0123456789token`;
    for (const body of [
      { ...profile, purpose: synthetic },
      { ...profile, responsibilities: [synthetic] },
    ]) {
      expect(() => parseSourceProfile(JSON.stringify(body), agent)).toThrow('forbidden_content');
    }
  });

  it.each(['purpose', 'pur\\u0070ose'])('rejects duplicate decoded profile key %s before returning original bytes', (key) => {
    const text = JSON.stringify(profile).replace('"purpose":', `"${key}":"discarded synthetic value","purpose":`);
    expect(() => parseSourceProfile(text, agent)).toThrow('duplicate_json_key');
  });

  it('rejects duplicate nested keys and permits identical keys in separate objects', () => {
    expect(() => parseJson('{"items":[{"id":"41","id":"42"}]}')).toThrow('duplicate_json_key');
    expect(parseJson('{"items":[{"id":"42"},{"id":"43"}]}'))
      .toEqual({ items: [{ id: '42' }, { id: '43' }] });
    expect(parseSourceProfile(JSON.stringify({ ...profile, purpose: 'Literal {"key": "value"}' }), agent).purpose)
      .toBe('Literal {"key": "value"}');
  });

  it('fails closed when the shared decoded-value scanner reports incomplete coverage', () => {
    vi.spyOn(protocol, 'redactSecretsDeep').mockImplementation((value) => ({
      value, count: 0, kinds: [], unscanned: { reason: 'node_budget', count: 1, reasons: [{ reason: 'node_budget', count: 1 }] },
    }));
    expect(() => parseSourceProfile(JSON.stringify(profile), agent)).toThrow('forbidden_content');
  });
});

it('preserves canonical tenant casing in identity and paths', () => {
  const canonical = { ...scope, tenant_id: 'Steven', alias: 'socrates' };
  expect(() => { validateContextScope(canonical); }).not.toThrow();
  expect(sourceProfilePath(canonical)).toBe('tenants/Steven/agents/socrates/profile.json');
  expect(parseSourceProfile(JSON.stringify(profile), canonical)).toMatchObject({ tenant_id: 'Steven', alias: 'socrates' });
});

it.each(['../Steven', '/Steven', 'Steven/a', 'Steven\\a', 'Steven%2fa', '0tenant', 'id_rsa'])(
  'rejects unsafe and noncanonical tenant %j', (tenant_id) => {
    expect(() => { validateContextScope({ ...scope, tenant_id }); }).toThrow();
  },
);

it('rejects digit-prefixed aliases according to the canonical protocol', () => {
  expect(() => { validateContextScope({ ...scope, alias: '0helper' }); }).toThrow();
});
