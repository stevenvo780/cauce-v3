import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitionFromDescriptor, executeHarnessOperation, packagedHarnessDescriptor, packagedHarnessIds, parseHarnessDescriptor } from '../src/context/harness-descriptor.js';
import { prepareSpaceLayout, SPACE_DIRECTORIES, writeSpaceContext } from '../src/context/space-layout.js';
import { validateVersionedContext } from '../src/sdk/engine/versioned-context.js';
import { protocolPrompt } from '../src/harnesses/shared/prompt.js';
import { delivery } from './engine-fixtures.js';

test('packaged descriptors guide native execution and refuse arbitrary lifecycle commands', async () => {
  for (const harness of ['codex','claude','hermes','opencode','openclaw','grok','muse','fake'] as const) {
    const descriptor = await packagedHarnessDescriptor(harness);
    assert.equal(definitionFromDescriptor(descriptor).id, harness);
    assert.throws(() => parseHarnessDescriptor({ ...descriptor, operations: { execute: 'sh -c arbitrary' } }));
  }
  const fake = await packagedHarnessDescriptor('fake');
  await assert.rejects(() => executeHarnessOperation(fake, 'authenticate', { run: async () => undefined }),
    /operations\.authenticate: operation is not declared/u);
  const proof = await executeHarnessOperation(fake, 'execute', { run: async request => request });
  assert.deepEqual(proof, { harness: 'fake', operation: 'execute', recipe: 'native-execution' });
});
test('descriptor provider data is validated with field paths and ids derive from the directory', async () => {
  assert.deepEqual(await packagedHarnessIds(),
    ['claude', 'codex', 'fake', 'grok', 'hermes', 'muse', 'openclaw', 'opencode']);
  const codex = await packagedHarnessDescriptor('codex');
  assert.deepEqual(codex.provider?.authenticate_argv, ['/usr/local/bin/codex', 'login', '--device-auth']);
  assert.equal(codex.provider?.update_package, '@openai/codex');
  const grok = await packagedHarnessDescriptor('grok');
  assert.equal(grok.operations.update, undefined);
  assert.equal(grok.provider?.fleet_module, 'fleet_provider_grok');
  assert.throws(() => parseHarnessDescriptor({ ...codex, provider: { ...codex.provider, quota_argv: ['node', 'x'] } }),
    /provider\.quota_argv\[0\]: must be an absolute executable path under \/usr\/local\/bin/u);
  assert.throws(() => parseHarnessDescriptor({ ...codex,
    provider: { ...codex.provider, authenticate_argv: ['/usr/local/bin/codex', 'login;id'] } }),
  /provider\.authenticate_argv\[1\]: contains shell metacharacters/u);
  assert.throws(() => parseHarnessDescriptor({ ...codex, provider: { ...codex.provider, update_package: '@openai/codex;id' } }),
    /provider\.update_package: must be an npm package name/u);
  assert.throws(() => parseHarnessDescriptor({ ...codex, provider: {} }),
    /provider\.authenticate_argv: required when operations\.authenticate is declared/u);
});
test('space context writes real files, preserves unmanaged prose and includes current directives in the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cauce-space-context-'));
  try {
    const layout = await prepareSpaceLayout(root);
    assert.deepEqual(Object.keys(layout), [...SPACE_DIRECTORIES]);
    await writeFile(join(root, 'AGENTS.md'), 'Existing native directions.\n');
    const files = [{ path: 'context/mission.md', content: 'Always name the company.' }];
    const context = { company_id: 'context_alpha', tenant_id: 'Steven', alias: 'zeus', version: 1,
      digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
    const written = await writeSpaceContext(root, await packagedHarnessDescriptor('codex'), context);
    assert.equal(written.state, 'written');
    assert.equal(await readFile(join(root, files[0]?.path ?? ''), 'utf8'), files[0]?.content);
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /^Existing native directions\./u);
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Always name the company/u);
    const claimed = { ...delivery('versioned'), recipient_alias: 'zeus', versioned_context: context };
    validateVersionedContext(claimed, 'Steven');
    assert.throws(() => { validateVersionedContext(claimed, 'Foreign'); });
    assert.throws(() => { validateVersionedContext({ ...claimed, versioned_context: { ...context, digest: '0'.repeat(64) } }, 'Steven'); });
    const prompt = protocolPrompt('Proceed', undefined, { self_alias: 'zeus', sender_alias: 'kant', tenant_id: 'Steven',
      room_id: 'grp.steven', channel: 'cauce', agent_message: false, message_type: 'command',
      routing_targets: [], versioned_context: context });
    assert.match(prompt, /BEGIN VERSIONED AGENT CONTEXT/u);
    assert.match(prompt, /Always name the company/u);
    assert.equal((prompt.match(/Always name the company/gu) ?? []).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('space layout rejects symlink directories before writing contexts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cauce-space-fence-'));
  const outside = await mkdtemp(join(tmpdir(), 'cauce-space-outside-'));
  try { await symlink(outside, join(root, 'context')); await assert.rejects(() => prepareSpaceLayout(root)); }
  finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('retired context files are removed by their byte receipt and local edits prevent destructive cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cauce-space-retire-'));
  const descriptor = await packagedHarnessDescriptor('codex');
  const version = (revision: number, files: { path: string; content: string }[]) => ({
    company_id: 'context_alpha', tenant_id: 'Steven', alias: 'zeus', version: revision,
    files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  });
  try {
    await writeSpaceContext(root, descriptor, version(1, [{ path: 'context/old.md', content: 'Old' }]));
    await writeSpaceContext(root, descriptor, version(2, []));
    await assert.rejects(() => readFile(join(root, 'context/old.md')), { code: 'ENOENT' });
    await writeSpaceContext(root, descriptor, version(3, [{ path: 'context/new.md', content: 'New' }]));
    await writeFile(join(root, 'context/new.md'), 'Edited locally');
    await assert.rejects(() => writeSpaceContext(root, descriptor, version(4, [{ path: 'context/new.md', content: 'Desired remote' }])), /active context file was edited locally/u);
    await assert.rejects(() => writeSpaceContext(root, descriptor, version(4, [])), /edited locally/u);
    assert.equal(await readFile(join(root, 'context/new.md'), 'utf8'), 'Edited locally');
    await assert.rejects(() => writeSpaceContext(root, descriptor, { ...version(4, []), company_id: 'foreign' }), /another context target/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
