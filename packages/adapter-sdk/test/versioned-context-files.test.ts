import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalVersionedContext, deliveredVersionedContext } from '../src/context/versioned-context-files.js';

type File = { path: string; content: string };
function version(files: File[], digestFiles = [...files].sort((a, b) => a.path < b.path ? -1 : 1)) {
  return { company_id: 'context_alpha', tenant_id: 'Steven', alias: 'zeus', version: 2,
    digest: createHash('sha256').update(JSON.stringify(digestFiles)).digest('hex'), files };
}

test('a delivered version reads by shape, sizes and digest even when a stricter local rule would refuse its content', () => {
  const files = [{ path: 'context/notes/token.md', content: `token ghp_${'a1B2'.repeat(9)}` },
    { path: 'context/auth.json', content: '{}' }, { path: 'context/hidden.md', content: 'zero\u200bwidth' }];
  const delivered = deliveredVersionedContext(version(files));
  assert.deepEqual(delivered.files.map(file => file.path), ['context/auth.json', 'context/hidden.md', 'context/notes/token.md']);
  for (const file of files) assert.throws(() => canonicalVersionedContext(version([file])), /content is unsafe/u);
});

test('a delivered version still fails on a digest, duplicate path or total size it does not match', () => {
  const file = { path: 'context/mission.md', content: 'Mission.' };
  assert.throws(() => deliveredVersionedContext(version([file], [{ ...file, content: 'Other.' }])), /digest or shape/u);
  assert.throws(() => deliveredVersionedContext(version([file, { ...file }])), /digest or shape/u);
  const large = Array.from({ length: 5 }, (_, index) => ({ path: `context/large-${String(index)}.md`, content: 'x'.repeat(262_144) }));
  assert.throws(() => deliveredVersionedContext(version(large)), /digest or shape/u);
  assert.throws(() => deliveredVersionedContext({ ...version([file]), files: [{ path: 'context/../escape.md', content: 'x' }] }));
});
