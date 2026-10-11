import { describe, expect, it } from 'vitest';
import { ContextUpdateSchema, canonicalContextFiles, contextDigest, contextRepositoryPrefix, contextVersionDiff } from './context-version-model.js';

describe('versionable context boundary', () => {
  it('accepts prose, sorts exact paths and includes deleted files in differences', () => {
    const files = canonicalContextFiles([{ path: 'directives/work.md', content: 'One\n\tTwo\n' }, { path: 'context/purpose.md', content: 'Purpose' }]);
    expect(files[0]?.path).toBe('context/purpose.md');
    expect(contextDigest(files)).toBe(contextDigest([...files].reverse()));
    expect(contextVersionDiff(files, [{ path: 'context/purpose.md', content: 'Edited' }])).toEqual([
      { path: 'context/purpose.md', before: 'Purpose', after: 'Edited', change: 'modified' },
      { path: 'directives/work.md', before: 'One\n\tTwo\n', after: null, change: 'deleted' },
    ]);
  });
  it.each(['context/../auth.json', 'context/auth.json', 'data/session.json', '/context/guide.md', 'context/link.pem'])('rejects forbidden path %s', path => {
    expect(() => ContextUpdateSchema.parse({ expected_version: 0, source: 'cli', files: [{ path, content: 'safe' }] })).toThrow();
  });
  it('refuses recognized credentials and duplicates without exposing their value', () => {
    const secret = `Authorization: Bearer ${'A1'.repeat(20)}`;
    expect(ContextUpdateSchema.safeParse({ expected_version: 0, source: 'ui', files: [{ path: 'context/a.md', content: secret }] }).success).toBe(false);
    expect(() => canonicalContextFiles([{ path: 'context/a.md', content: 'a' }, { path: 'context/a.md', content: 'b' }])).toThrow();
  });
  it('keeps homonymous agent paths company scoped', () => {
    const one = contextRepositoryPrefix({ company_id: 'alpha', tenant_id: 'Alpha', alias: 'director' });
    const two = contextRepositoryPrefix({ company_id: 'beta', tenant_id: 'Beta', alias: 'director' });
    expect(one).not.toEqual(two);
  });
});
