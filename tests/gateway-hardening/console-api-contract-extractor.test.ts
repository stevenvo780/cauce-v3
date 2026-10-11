import { describe, expect, it } from 'vitest';
import { extractClientCalls } from './console-api-contract-extractor.js';

describe('console API route extraction from TypeScript syntax', () => {
  it('keeps method and default suffix correlated through literal helper calls', () => {
    const calls = extractClientCalls(`const path='/v3/console/people';
      function mutate(id: string, method: string, suffix='') { return request<unknown>(\`\${path}/\${id}\${suffix}\`, {method}); }
      mutate(person,'PATCH',''); mutate(person,'DELETE'); mutate(person,'POST','/restore');`);
    expect(calls).toEqual([{ method: 'PATCH', path: '/v3/console/people/1' },
      { method: 'DELETE', path: '/v3/console/people/1' }, { method: 'POST', path: '/v3/console/people/1/restore' }]);
    expect(calls).not.toContainEqual({ method: 'POST', path: '/v3/console/people/1' });
    expect(calls.some(call => call.path.includes('/11'))).toBe(false);
  });
  it('preserves an optional query fragment instead of creating a new revision route segment', () => {
    const calls = extractClientCalls(`function tramo(page: Page | undefined) { const text=query.toString(); return text.length===0 ? '' : \`?\${text}\`; }
      request('/v3/console/tenants/1/agents/1/perfil/revisions'+tramo(page));`);
    expect(calls).toEqual([{ method: 'GET', path: '/v3/console/tenants/1/agents/1/perfil/revisions' },
      { method: 'GET', path: '/v3/console/tenants/1/agents/1/perfil/revisions?1' }]);
  });
  it('finds literal routes inside generic request calls and expands every finite generic action', () => {
    const calls = extractClientCalls(`function control<T extends 'cancel' | 'resume'>(action:T) {
      return request<Result<string>>(\`/v3/console/fleet/operations/1/\${action}\`, {method:'POST'}); }`);
    expect(calls).toEqual([{ method: 'POST', path: '/v3/console/fleet/operations/1/cancel' },
      { method: 'POST', path: '/v3/console/fleet/operations/1/resume' }]);
  });
  it.each(["'cancel' | string", "'cancel' | 'resume' | string"])( 'rejects open generic action unions: %s', union => {
    expect(() => extractClientCalls(`function control<T extends ${union}>(action:T) {
      return request<Outcome<T>>(\`/v3/console/fleet/operations/1/\${action}\`, {method:'POST'}); }`))
      .toThrow('route parameter union must contain only literals');
  });
  it('rejects an unresolved helper inside a generic call', () => {
    expect(() => extractClientCalls('request<Result<string>>(unknownRoute(tenant, alias));'))
      .toThrow('el extractor no supo sacar la ruta');
  });
  it('resolves literal method options and rejects opaque route or options references', () => {
    expect(extractClientCalls("const options={method:'POST'}; request('/v3/console/people',options);"))
      .toEqual([{ method: 'POST', path: '/v3/console/people' }]);
    for (const source of ['request(unknownPath);', "request('/v3/console/people',unknownOptions);",
      "request(`${missing}/preview`, {method:'POST'});",
      "const prefix=missing; request(`${prefix}/preview`, {method:'POST'});",
      "function prefix(){return missing;} request(`${prefix()}/preview`, {method:'POST'});",
      "request(flag ? '/v3/console/fleet/operations' : `${missing}/preview`, {method:'POST'});",
      "function prefix(){if(flag)return '/v3/console/fleet/operations'; return `${missing}/preview`;} request(prefix(), {method:'POST'});"]) {
      expect(() => extractClientCalls(source)).toThrow('el extractor no supo sacar la ruta');
    }
  });
  it('preserves HTTP methods through conditional body-only spreads', () => {
    const options = "{ method: 'POST', ...(input ? { body: JSON.stringify(input) } : {}) }";
    expect(extractClientCalls(`request('/v3/console/context/restore', ${options});`))
      .toEqual([{ method: 'POST', path: '/v3/console/context/restore' }]);
    expect(extractClientCalls("request('/v3/console/context', { ...(input ? { ...{ body: input } } : {}) });"))
      .toEqual([{ method: 'GET', path: '/v3/console/context' }]);
  });
  it('resolves constant aliases of the built-in route encoders', () => {
    expect(extractClientCalls("const id=encodeURIComponent; const text=String; request(`/v3/console/quota-accounts/${id(account)}?version=${text(version)}`);"))
      .toEqual([{ method: 'GET', path: '/v3/console/quota-accounts/1?version=1' }]);
  });
  it.each([
    'unknownOptions', 'input ? { body: input } : unknownOptions',
    "input ? { body: input } : { method: 'DELETE' }", '{ method }',
    "{ ...{ method: 'DELETE' } }", '{ [key]: input }', "{ ['method']: 'DELETE' }",
    "{ get method() { return 'DELETE'; } }", "{ method: 'DELETE' }",
  ])('rejects a spread that may replace the HTTP method: %s', spread => {
    expect(() => extractClientCalls(`request('/v3/console/context', { method: 'POST', ...(${spread}) });`))
      .toThrow('el extractor no supo sacar la ruta');
  });
  it.each([
    'let id=encodeURIComponent;', 'const id=unknownEncoder;',
    'const encodeURIComponent=unknownEncoder; const id=encodeURIComponent;',
    'function client(encodeURIComponent: Encoder) { const id=encodeURIComponent;',
    "import { encodeURIComponent } from './unknown-encoder'; const id=encodeURIComponent;",
    "import { encode as encodeURIComponent } from './unknown-encoder'; const id=encodeURIComponent;",
    "import encodeURIComponent from './unknown-encoder'; const id=encodeURIComponent;",
    "import * as encodeURIComponent from './unknown-encoder'; const id=encodeURIComponent;",
    "import encodeURIComponent = require('./unknown-encoder'); const id=encodeURIComponent;",
    'const { encodeURIComponent }=unknownEncoders; const id=encodeURIComponent;',
    'const { encode: encodeURIComponent }=unknownEncoders; const id=encodeURIComponent;',
    'const { encoders: { encodeURIComponent } }=unknownEncoders; const id=encodeURIComponent;',
    'const [encodeURIComponent]=unknownEncoders; const id=encodeURIComponent;',
    'function client({ encodeURIComponent }: Encoders) { const id=encodeURIComponent;',
    'const id=encodeURIComponent; const encodeURIComponent=unknownEncoder;',
    'class encodeURIComponent {} const id=encodeURIComponent;',
    'const adjacent=(encodeURIComponent: Encoder) => {}; const id=encodeURIComponent;',
    "import { String } from './unknown-encoder'; const id=String;",
  ])('rejects mutable, unknown or shadowed encoder aliases: %s', declaration => {
    const end = declaration.startsWith('function') ? '}' : '';
    expect(() => extractClientCalls(declaration + ' request(`/v3/console/quota-accounts/${id(account)}`);' + end))
      .toThrow('el extractor no supo sacar la ruta');
  });
});
