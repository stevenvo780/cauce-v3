import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createHash } from 'node:crypto';
import { ContextFilesSchema, ContextRejectedError, ContextUpdateSchema, canonicalContextFiles, contextCommitIdentity, contextDigest,
  contextProjectionBytes, contextRepositoryPrefix, contextVersionDiff, harnessContextMaxBytes, storedContextFiles,
  versionableContextFiles } from './context-version-model.js';
import { StoreError } from './repository/errors.js';

function rejection(value: unknown, maxBytes = 65_536): ContextRejectedError {
  try { versionableContextFiles(value, maxBytes); } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    expect(error).not.toBeInstanceOf(ZodError);
    if (error instanceof ContextRejectedError) return error;
  }
  throw new Error('context was accepted');
}
const file = (content: string) => [{ path: 'context/notes/a.md', content }];

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
    expect(rejection([{ path, content: 'safe' }]).reason).toBe('context_invalid_files');
  });
  it('refuses duplicates and recognized credentials with a typed reason that never carries the value', () => {
    const secret = `Authorization: Bearer ${'A1'.repeat(20)}`;
    expect(ContextFilesSchema.safeParse(file(secret)).success).toBe(false);
    const refused = rejection(file(secret));
    expect(refused).toMatchObject({ code: 'invalid_input', reason: 'context_secret_detected', paths: ['context/notes/a.md'] });
    expect(JSON.stringify({ message: refused.message, paths: refused.paths })).not.toContain('A1A1');
    expect(() => canonicalContextFiles([{ path: 'context/a.md', content: 'a' }, { path: 'context/a.md', content: 'b' }])).toThrow();
    expect(rejection([{ path: 'context/a.md', content: 'a' }, { path: 'context/a.md', content: 'b' }]).reason).toBe('context_invalid_files');
  });
  it.each([
    ['a private key header without its end marker', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA'],
    ['a project-scoped OpenAI key', `OPENAI=sk-proj-${'Ab3_-'.repeat(8)}`],
    ['a short GitHub token', `token ghp_${'a1B2'.repeat(6)}`],
    ['a fine-grained GitHub token', `github_pat_${'11ABCDEFG0'.repeat(3)}`],
    ['a GitLab token', `glpat-${'xY9_'.repeat(6)}`],
    ['a Slack token', 'xoxb-1234567890-abcdef'],
    ['an AWS key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a literal AWS secret', `aws_secret_access_key = ${'wJalrXUtnFEMI/K7MDENG+'.repeat(2)}`],
    ['an npm auth token', '//registry.npmjs.org/:_authToken=abcd1234efgh'],
    ['a URL with user information', 'postgres://cauce:hunter22@db.internal:5432/cauce'],
    ['a literal password assignment', 'password: "correct-horse"'],
    ['a JWT', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.')],
  ])('blocks %s instead of redacting it', (_label, content) => {
    expect(rejection(file(`Context line.\n${content}\n`)).reason).toBe('context_secret_detected');
    expect(ContextFilesSchema.safeParse(file(content)).success).toBe(false);
  });
  it.each([
    'Usa la variable de entorno ${NPM_TOKEN} en _authToken=${NPM_TOKEN}.',
    'password: ${DB_PASSWORD}',
    'Clona https://github.com/stevenvo780/cauce-agent-contexts y revisa la tarea task-management-dashboard.',
    'Authorization: responsabilidades del agente.',
  ])('keeps ordinary prose and environment references versionable: %s', content => {
    expect(versionableContextFiles(file(content), 65_536)).toEqual(file(content));
  });
  it('refuses invisible formatting and oversized documents with their own reasons', () => {
    expect(rejection(file('Equipo 👨‍👩‍👧 listo')).reason).toBe('context_unsafe_text');
    expect(rejection(file(`‮gnirts`)).reason).toBe('context_unsafe_text');
    expect(rejection(file('x'.repeat(262_145)))).toMatchObject({ reason: 'context_too_large', paths: ['context/notes/a.md'] });
  });
  it('refuses a version above the harness document limit with its measured size', () => {
    const fits = file('x'.repeat(65_536 - contextProjectionBytes(file(''))));
    expect(versionableContextFiles(fits, 65_536)).toEqual(fits);
    const over = file(`${fits[0]?.content ?? ''}x`);
    expect(rejection(over)).toMatchObject({ reason: 'context_harness_limit', limit: { bytes: 65_537, max_bytes: 65_536 } });
    expect(rejection(over).message).toContain('65537 bytes for a limit of 65536 bytes');
  });
  it('reads stored history by shape, sizes and digest only, so a stricter rule never makes it unreadable', () => {
    const secret = file(`OPENAI=sk-proj-${'Ab3_-'.repeat(8)}`);
    expect(storedContextFiles(secret, contextDigest(secret))).toEqual(secret);
    const governed = [{ path: 'context/auth.json', content: '{}' }];
    expect(storedContextFiles(governed, contextDigest(governed))).toEqual(governed);
  });
  it.each([
    ['a digest that differs from its files', file('stored'), contextDigest(file('other'))],
    ['a path outside the context layout', [{ path: 'context/.env/secret.md', content: 'x' }], undefined],
    ['a file above the size bound', file('x'.repeat(262_145)), undefined],
    ['a duplicate path', [...file('a'), ...file('b')], undefined],
    ['a value that is no file list', { path: 'context/a.md' }, undefined],
  ])('reports %s as an unreadable version, never a ZodError', (_label, value, digest) => {
    try { storedContextFiles(value, digest ?? contextDigest(Array.isArray(value) ? value : [])); } catch (error) {
      expect(error).toBeInstanceOf(ContextRejectedError);
      expect(error).toMatchObject({ reason: 'context_version_unreadable', paths: [] });
      return;
    }
    throw new Error('stored version was read');
  });
  it('uses the conservative context limit for an unknown harness', () => {
    expect(harnessContextMaxBytes(null)).toBe(65_536);
    expect(harnessContextMaxBytes('constructor')).toBe(65_536);
  });
  it('keeps homonymous agent paths company scoped', () => {
    const one = contextRepositoryPrefix({ company_id: 'alpha', tenant_id: 'Alpha', alias: 'director' });
    const two = contextRepositoryPrefix({ company_id: 'beta', tenant_id: 'Beta', alias: 'director' });
    expect(one).not.toEqual(two);
  });
});

describe('context commit identity', () => {
  const human = '11111111-1111-4111-8111-111111111111';
  const email = `persona-${createHash('sha256').update(human).digest('hex').slice(0, 12)}@acme.cauce.invalid`;
  it('keeps the alias when no person wrote the version', () => {
    expect(contextCommitIdentity({ company_id: 'acme', actor_alias: 'kant', actor_human_id: null, actor_name: 'Steven' }))
      .toEqual({ name: 'kant', email: 'kant@acme.cauce.invalid', trailer: null });
    expect(contextCommitIdentity({ company_id: 'acme', actor_alias: 'kant', actor_human_id: '', actor_name: null }).trailer)
      .toBeNull();
  });
  it('signs a person with the visible name, a non-routable hash and the alias trailer', () => {
    const identity = contextCommitIdentity({
      company_id: 'acme', actor_alias: 'kant', actor_human_id: human, actor_name: 'Steven\n<admin>',
    });
    expect(identity).toEqual({ name: 'Steven admin', email, trailer: 'Cauce-Actor-Alias: kant' });
    expect(identity.email).not.toContain(human);
    expect(identity.email).not.toContain('@example');
    expect(contextCommitIdentity({ company_id: 'acme', actor_alias: 'kant', actor_human_id: human, actor_name: ' < > ' }).name)
      .toBe('persona');
  });
});
