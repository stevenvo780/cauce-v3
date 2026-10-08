import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliSharedSessionSpec, loadSharedSessionConfig } from '../src/shared-session/config.js';
import { withoutLifecycleIdentity } from '../src/shared-session/tmux/identity.js';

test('physical runtime keys isolate shared sessions without changing the caller wire identity', () => {
  const wireAlias = 'same_alias';
  const env = { HOME: '/home/dev', CODEX_HOME: '/home/dev/.codex-one', CAUCE_SHARED_SESSION: '1', CAUCE_RUNTIME_KEY: 'tenant-one-agent' };
  const loaded = loadSharedSessionConfig('codex', wireAlias, '/state/tenant-one-agent', env);
  assert.equal(loaded?.alias, 'tenant-one-agent');
  assert.equal(loaded?.configDirectory, '/home/dev/.codex-one');
  assert.equal(cliSharedSessionSpec('codex', wireAlias, '/workspace', '/home/dev', env).alias, 'tenant-one-agent');
  assert.equal(loadSharedSessionConfig('codex', wireAlias, '/state/two', { ...env, CAUCE_RUNTIME_KEY: 'tenant-two-agent' })?.alias, 'tenant-two-agent');
  assert.equal(wireAlias, 'same_alias');
});
test('legacy aliases keep their shared session identity and malformed physical keys are rejected', () => {
  assert.equal(loadSharedSessionConfig('codex', 'legacy_alias', '/state', { CAUCE_SHARED_SESSION: '1', HOME: '/home/dev' })?.alias, 'legacy_alias');
  for (const key of ['../other', 'Upper', 'wire_alias', 'one\nother', 'a'.repeat(65)]) {
    assert.throws(() => loadSharedSessionConfig('codex', 'wire', '/state', { CAUCE_SHARED_SESSION: '1', HOME: '/home/dev', CAUCE_RUNTIME_KEY: key }));
  }
});
test('the tmux server does not retain a previous runtime key', () => {
  assert.equal(withoutLifecycleIdentity({ CAUCE_RUNTIME_KEY: 'previous-one', CODEX_HOME: '/profile' }).CAUCE_RUNTIME_KEY, undefined);
});
