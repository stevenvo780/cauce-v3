import { describe, expect, it } from 'vitest';
import { extractClientCalls } from './console-route-helper.js';

const AGENT_PATH_FIXTURE = [
  "function agentPath(prefix: string, tenantId: string, alias: string, suffix = ''): string {",
  "  if (!tenantId || !alias) throw new Error('missing identity');",
  '  return `${prefix}/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}${suffix}`;',
  '}',
].join('\n');

describe('console helper route extraction', () => {
  it('binds prefixes, defaults and local query suffixes without losing HTTP methods', () => {
    const source = AGENT_PATH_FIXTURE + `
      request(agentPath('/v3/console/favorites', tenantId, alias), { method: 'PUT' });
      request(agentPath('/v3/console/favorites', tenantId, alias), { method: 'DELETE' });
      request(agentPath('/v3/console/agents', tenantId, alias, '/appearance'), { method: 'PUT' });
      const suffix = \`/appearance?expected_revision=\${String(expectedRevision)}\`;
      request(agentPath('/v3/console/agents', tenantId, alias, suffix), { method: 'DELETE' });
    `;
    expect(extractClientCalls(source)).toEqual([
      { method: 'PUT', path: '/v3/console/favorites/1/1' },
      { method: 'DELETE', path: '/v3/console/favorites/1/1' },
      { method: 'PUT', path: '/v3/console/agents/1/1/appearance' },
      { method: 'DELETE', path: '/v3/console/agents/1/1/appearance?expected_revision=1' },
    ]);
  });

  it('uses changed arguments, encoded identities and nested commas rather than a route allowlist', () => {
    const source = AGENT_PATH_FIXTURE + `
      request(agentPath('/v3/console/future', 'two words', 'slash/alias', '/different'), { method: 'PATCH' });
      request(agentPath('/v3/console/future', encodeURIComponent('a,b'), 'c'), { method: 'POST' });
    `;
    expect(extractClientCalls(source)).toEqual([
      { method: 'PATCH', path: '/v3/console/future/two%20words/slash%2Falias/different' },
      { method: 'POST', path: '/v3/console/future/a%252Cb/c' },
    ]);
  });

  it('resolves a shadowed suffix only inside the request lexical scope', () => {
    const source = AGENT_PATH_FIXTURE + `
      const suffix = '/outer';
      function sibling() { const suffix = '/sibling'; }
      function selected() {
        const suffix = '/selected';
        request(agentPath('/v3/console/agents', tenantId, alias, suffix));
      }
    `;
    expect(extractClientCalls(source)).toEqual([{ method: 'GET', path: '/v3/console/agents/1/1/selected' }]);
  });

  it.each([
    "request(agentPath(unknownPrefix, tenantId, alias));",
    "request(agentPath('/v3/console/agents', tenantId, alias, unknownSuffix));",
    "function sibling() { const suffix = '/hidden'; } request(agentPath('/v3/console/agents', tenantId, alias, suffix));",
    "function selected(suffix: string) { request(agentPath('/v3/console/agents', tenantId, alias, suffix)); }",
    "request(agentPath('/v3/console/agents', unknownIdentity(), alias));",
    "request(agentPath('/v3/console/agents', tenantId, alias, '/a' + suffix));",
    "function agentPath() { return '/v3/other'; } request(agentPath('/v3/console/agents', tenantId, alias));",
  ])('rejects unresolved structural bindings instead of dropping calls: %s', source => {
    expect(() => extractClientCalls(AGENT_PATH_FIXTURE + source)).toThrow('el extractor no supo sacar la ruta');
  });

  it.each([
    "function route(prefix: string) { return flag ? prefix : '/v3/hidden'; } request(route('/v3/visible'));",
    "function route(prefix: string) { if (flag) return '/v3/hidden'; return prefix; } request(route('/v3/visible'));",
    "function route(prefix: string) { return route(prefix); } request(route('/v3/visible'));",
  ])('rejects unsupported or recursive helper bodies: %s', source => {
    expect(() => extractClientCalls(source)).toThrow('el extractor no supo sacar la ruta');
  });

  it('preserves optional query helper shape instead of appending a path segment', () => {
    const source = "function query() { return flag ? '' : `?${value}`; }"
      + "request(`/v3/console/revisions${query()}`);";
    expect(extractClientCalls(source)).toEqual([{ method: 'GET', path: '/v3/console/revisions?1' }]);
    expect(() => extractClientCalls(source.replace('`?${value}`', '\'/not-a-query\''))).toThrow('el extractor no supo sacar la ruta');
  });

  it('preserves fixed literal helpers and template extensions', () => {
    const source = "function route(): string { return '/v3/console/topology'; } request(route());";
    expect(extractClientCalls(source)).toEqual([{ method: 'GET', path: '/v3/console/topology' }]);
  });

});
