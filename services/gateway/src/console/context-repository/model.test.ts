import type { ProfileRevisionEntry } from '@cauce/store';
import * as protocol from '@cauce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareProfileExport } from './inspect.js';
import {
  admitContextText, CONTEXT_REPOSITORY_LIMITS, parseContextManifest, parseSourceProfile,
  validateContextScope,
} from './model.js';

const scope = { instance_id: 'fixture', tenant_id: 'tenant-a', alias: 'helper' };
const agent = { tenant_id: 'tenant-a', alias: 'helper', source_journal: { id: '42', revision: 1 } };
const manifest = { schema_version: 1, instance_id: 'fixture', agents: [agent] };
const profile = {
  purpose: '  Review fixtures  ', role_summary: null, human_brief: null,
  responsibilities: [' Check scope ', ''], restrictions: [], tools: [], operating_rules: [],
};
const snapshot: ProfileRevisionEntry = {
  ...profile, tenant_id: 'tenant-a', alias: 'helper', id: '42', revision: 1, operation: 'insert',
  actor_tenant: 'private-actor-tenant', actor_alias: 'private-actor', changed_at: 'private-timestamp',
};

describe('context repository profile admission and export proposals', () => {
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

  it('prepares exactly seven fields for explicit content review, excluding derived and audit data', () => {
    const input = { ...snapshot, permissions: { control: true }, quotas: ['private-quota'], runtime_memory: 'private-memory' };
    const before = structuredClone(input);
    const result = prepareProfileExport({ scope, snapshot: input });
    expect(JSON.parse(result.source.content)).toEqual({ ...profile, purpose: 'Review fixtures', responsibilities: ['Check scope'] });
    expect(result.sourceAgent).toEqual(agent);
    expect(result.scope).toEqual(scope);
    expect(result.state).toBe('content_review_required');
    expect(result.application).toBe('not_evaluated');
    expect(result.source.path).toBe('tenants/tenant-a/agents/helper/profile.json');
    expect(result.source.bytes).toBe(Buffer.byteLength(result.source.content));
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(input).toEqual(before);
  });

  it('keeps journal identity when an alias is recreated at revision one', () => {
    const old = prepareProfileExport({ scope, snapshot });
    const recreated = prepareProfileExport({ scope, snapshot: { ...snapshot, id: '96', revision: 1 } });
    expect(recreated.source.sha256).toBe(old.source.sha256);
    expect(recreated.sourceAgent.source_journal).toEqual({ id: '96', revision: 1 });
    expect(recreated.sourceAgent).not.toEqual(old.sourceAgent);
  });

  it.each([
    { id: '' }, { id: '0' }, { id: '9223372036854775808' }, { revision: 0 },
    { revision: 1.5 }, { operation: 'delete' as const }, { tenant_id: 'tenant-b' }, { alias: 'other' },
  ])('rejects an invalid, deleted or wrong-scope journal snapshot %#', (override) => {
    expect(() => prepareProfileExport({ scope, snapshot: { ...snapshot, ...override } })).toThrow();
  });

  it('requires review even for private prose without a recognizable secret pattern', () => {
    const result = prepareProfileExport({ scope, snapshot: { ...snapshot, purpose: 'Internal business notes' } });
    expect(result.state).toBe('content_review_required');
  });

  it.each(['../other', 'UPPER', '', '/root', 'a/b', 'id_rsa'])('rejects unsafe scope %j', (alias) => {
    expect(() => { validateContextScope({ ...scope, alias }); }).toThrow();
  });

  it.each([
    { schema_version: 2 }, { instance_id: '../outside' }, { extra: true },
    { agents: [] }, { agents: [agent, agent] }, { agents: [{ tenant_id: 'tenant-a', alias: 'helper' }] },
    { agents: [{ ...agent, source_journal: { id: '42', revision: 0 } }] },
    { agents: [{ ...agent, source_journal: { id: '0', revision: 1 } }] },
    { agents: [{ ...agent, documents: [] }] },
    { agents: [{ ...agent, instructions: 'manual body' }] },
    { agents: [{ ...agent, skills: ['review'] }] },
  ])('rejects unsupported manifest fields or missing immutable provenance %#', (override) => {
    expect(() => parseContextManifest(JSON.stringify({ ...manifest, ...override }))).toThrow();
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
    expect(() => prepareProfileExport({ scope, snapshot: { ...snapshot, purpose: synthetic } }))
      .toThrow('context repository: forbidden_content');
  });

  it('reports malformed JSON and missing fields without echoing content', () => {
    expect(() => parseContextManifest('{"private fixture')).toThrow('context repository: invalid_json');
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
    expect(() => prepareProfileExport({ scope, snapshot: { ...snapshot, purpose: synthetic } }))
      .toThrow('forbidden_content');
  });

  it.each(['purpose', 'pur\\u0070ose'])('rejects duplicate decoded profile key %s before returning original bytes', (key) => {
    const text = JSON.stringify(profile).replace('"purpose":', `"${key}":"discarded synthetic value","purpose":`);
    expect(() => parseSourceProfile(text, agent)).toThrow('duplicate_json_key');
  });

  it('rejects duplicate nested provenance keys and permits identical keys in separate objects', () => {
    const nested = JSON.stringify(manifest).replace('"id":"42"', '"id":"41","id":"42"');
    expect(() => parseContextManifest(nested)).toThrow('duplicate_json_key');
    expect(parseContextManifest(JSON.stringify({
      ...manifest, agents: [agent, { ...agent, alias: 'other' }],
    })).agents).toHaveLength(2);
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
  const result = prepareProfileExport({ scope: canonical, snapshot: { ...snapshot, ...canonical } });
  expect(result.source.path).toBe('tenants/Steven/agents/socrates/profile.json');
  expect(parseContextManifest(JSON.stringify({ ...manifest, agents: [result.sourceAgent] })).agents[0]?.tenant_id)
    .toBe('Steven');
  expect(() => prepareProfileExport({ scope: { ...canonical, tenant_id: 'steven' },
    snapshot: { ...snapshot, ...canonical } })).toThrow('scope_unavailable');
});

it.each(['../Steven', '/Steven', 'Steven/a', 'Steven\\a', 'Steven%2fa', '0tenant', 'id_rsa'])(
  'rejects unsafe and noncanonical tenant %j', (tenant_id) => {
    expect(() => { validateContextScope({ ...scope, tenant_id }); }).toThrow();
  },
);

it('rejects digit-prefixed aliases according to the canonical protocol', () => {
  expect(() => { validateContextScope({ ...scope, alias: '0helper' }); }).toThrow();
});


it('admits explicitly Git-authored v2 without manufacturing source journal provenance', () => {
  expect(parseContextManifest(JSON.stringify({ ...manifest, schema_version: 2,
    agents: [{ tenant_id: agent.tenant_id, alias: agent.alias, source_journal: null }] })))
    .toEqual({ schema_version: 2, instance_id: 'fixture', agents: [{ tenant_id: agent.tenant_id, alias: agent.alias, source_journal: null }] });
});

it.each([
  { schema_version: 1, source_journal: null },
  { schema_version: 2, source_journal: agent.source_journal },
  { schema_version: 2, source_journal: undefined },
  { schema_version: 2, source_journal: { kind: 'git_authored' } },
  { schema_version: 3, source_journal: null },
])('refuses crossed, omitted or invented manifest provenance: %j', ({ schema_version, source_journal }) => {
  expect(() => parseContextManifest(JSON.stringify({ ...manifest, schema_version, agents: [{ ...agent, source_journal }] }))).toThrow();
});

it('rejects mixed v2 journal claims and authority attributes', () => {
  for (const extra of [{ actor: 'operator' }, { source_kind: 'git_authored' }, { repositoryPath: '/caller' }]) {
    expect(() => parseContextManifest(JSON.stringify({ ...manifest, schema_version: 2,
      agents: [{ ...agent, source_journal: null, ...extra }] }))).toThrow('invalid_schema');
  }
  expect(() => parseContextManifest(JSON.stringify({ ...manifest, schema_version: 2,
    agents: [{ ...agent, source_journal: null }, { ...agent, alias: 'other' }] }))).toThrow('invalid_provenance');
});
