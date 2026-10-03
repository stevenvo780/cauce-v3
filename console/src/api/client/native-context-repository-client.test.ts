import { vi } from 'vitest';
import { nativeContextRepositoryClient } from './native-context-repository-client';
import type { RequestFn } from './system-client';

const COMMIT = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const ROOT = 'tenants/Steven/agents/helper';
const profile = { tenant_id: 'Steven', alias: 'helper', purpose: null, role_summary: null, human_brief: null,
  responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
function file(path: string, content = 'manual', hash = 'c') { return { path, content, bytes: new TextEncoder().encode(content).length, sha256: hash.repeat(64) }; }
function snapshot(commit = COMMIT, harness = 'codex') {
  return { scope: { tenant_id: 'Steven', alias: 'helper', instance_id: 'fixture' }, commit, tree: 'd'.repeat(40), profile: { ...profile },
    profileSource: file(`${ROOT}/profile.json`, JSON.stringify(profile)),
    manualSource: file(`${ROOT}/native/${harness}/${harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`),
    sourceAgent: { tenant_id: 'Steven', alias: 'helper', source_journal: null, native_manual: { harness } } };
}
function response() { return { tenant_id: 'Steven', alias: 'helper', desired: snapshot(), previous: null as ReturnType<typeof snapshot> | null,
  changes: null as unknown, sourceState: 'not_observed', application: 'not_evaluated', applySupported: false }; }
function client(value: unknown) {
  const request = vi.fn(async () => value) as unknown as RequestFn;
  return { request, inspect: (previous?: string) => nativeContextRepositoryClient(request).inspectNativeContextRepository('Steven', 'helper', 'fixture', COMMIT, previous) };
}
it.each(['claude', 'codex', 'openclaw'])('reads %s only through GET without cache', async (harness) => {
  const value = response(); value.desired = snapshot(COMMIT, harness);
  const { request, inspect } = client(value);
  expect((await inspect()).desired.manualSource).toEqual(value.desired.manualSource);
  expect(request).toHaveBeenCalledWith(expect.stringContaining(`/native-inspect?commit=${COMMIT}`), { method: 'GET', cache: 'no-store' });
});
it.each([
  (v: ReturnType<typeof response>) => { v.alias = 'other'; },
  (v: ReturnType<typeof response>) => { v.desired.scope.instance_id = 'other'; },
  (v: ReturnType<typeof response>) => { v.desired.scope.tenant_id = 'other'; },
  (v: ReturnType<typeof response>) => { v.desired.profile.alias = 'other'; },
  (v: ReturnType<typeof response>) => { v.desired.sourceAgent.alias = 'other'; },
  (v: ReturnType<typeof response>) => { v.desired.commit = BEFORE; },
  (v: ReturnType<typeof response>) => { v.desired.manualSource.path = `${ROOT}/native/codex/AGENTS.override.md`; },
  (v: ReturnType<typeof response>) => { v.desired.manualSource.bytes = 3; },
  (v: ReturnType<typeof response>) => { v.desired.sourceAgent.native_manual.harness = 'unknown'; },
  (v: ReturnType<typeof response>) => { v.applySupported = true; },
  (v: ReturnType<typeof response>) => { v.application = 'applied'; },
  (v: ReturnType<typeof response>) => { v.previous = snapshot(BEFORE); },
  (v: ReturnType<typeof response>) => { v.changes = []; },
])('rejects mismatched identity, source or state %#', async (mutate) => {
  const value = response(); mutate(value);
  await expect(client(value).inspect()).rejects.toMatchObject({ code: 'invalid_native_context_repository' });
});
it('rejects missing identity and extra data instead of passing another agent through', async () => {
  for (const value of [{ ...response(), tenant_id: undefined }, { ...response(), agents: [snapshot()] },
    { ...response(), desired: { ...snapshot(), scope: {} } }, { ...response(), desired: { ...snapshot(), sourceAgent: {} } }]) {
    await expect(client(value).inspect()).rejects.toMatchObject({ code: 'invalid_native_context_repository' });
  }
});
it('compares exact previous commit and represents changed harness as removal plus addition', async () => {
  const value = response(); value.previous = snapshot(BEFORE, 'claude');
  value.changes = [
    { path: value.previous.manualSource.path, kind: 'removed', before: value.previous.manualSource, after: null },
    { path: value.desired.manualSource.path, kind: 'added', before: null, after: value.desired.manualSource },
  ];
  const { inspect, request } = client(value);
  expect((await inspect(BEFORE)).changes).toHaveLength(2);
  expect(request).toHaveBeenCalledWith(expect.stringContaining(`previous_commit=${BEFORE}`), expect.anything());
  value.previous.scope.alias = 'other';
  await expect(inspect(BEFORE)).rejects.toThrow();
});
it('rejects changed diff text, absent comparison, duplicates and foreign paths', async () => {
  const value = response();
  await expect(client(value).inspect(BEFORE)).rejects.toThrow();
  value.previous = snapshot(BEFORE); value.previous.manualSource = file(value.previous.manualSource.path, 'before', 'e');
  const change = { path: value.desired.manualSource.path, kind: 'modified', before: value.previous.manualSource, after: value.desired.manualSource };
  for (const changes of [[], [change, change], [{ ...change, path: 'foreign' }], [{ ...change, after: { ...change.after, content: 'tampered' } }]]) {
    value.changes = changes; await expect(client(value).inspect(BEFORE)).rejects.toThrow();
  }
  value.changes = [change]; expect((await client(value).inspect(BEFORE)).changes).toHaveLength(1);
});
it('rejects incomplete commits before requesting', async () => {
  const request = vi.fn() as unknown as RequestFn;
  await expect(nativeContextRepositoryClient(request).inspectNativeContextRepository('Steven', 'helper', 'fixture', 'aaaa')).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
