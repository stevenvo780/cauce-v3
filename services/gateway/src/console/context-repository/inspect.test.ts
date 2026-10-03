import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextGitReader } from './git-reader.js';
import { inspectContextRepository, prepareProfileExport } from './inspect.js';
import { CONTEXT_REPOSITORY_LIMITS } from './model.js';

const executeFile = promisify(execFile);
const scope = { instance_id: 'fixture', tenant_id: 'Steven', alias: 'helper' };
const root = 'tenants/Steven/agents/helper';
const otherRoot = 'tenants/tenant-b/agents/helper';
const profilePath = `${root}/profile.json`;
const profile = {
  purpose: 'Review fixture', role_summary: null, human_brief: null,
  responsibilities: [], restrictions: [], tools: [], operating_rules: [],
};
const manifest = {
  schema_version: 1, instance_id: 'fixture', agents: [
    { tenant_id: 'Steven', alias: 'helper', source_journal: { id: '42', revision: 1 } },
    { tenant_id: 'tenant-b', alias: 'helper', source_journal: { id: '43', revision: 1 } },
  ],
};

describe('local Git context inspection with synthetic repositories', () => {
  let repositoryPath: string;
  let firstCommit: string;

  async function git(...args: string[]): Promise<string> {
    const result = await executeFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repositoryPath, env: {
        PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
    return result.stdout.trim();
  }

  async function put(path: string, content: string | Buffer): Promise<void> {
    const fullPath = join(repositoryPath, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  async function commitFixture(): Promise<string> {
    await git('add', '--all');
    await git('commit', '-m', 'Synthetic context fixture');
    return git('rev-parse', 'HEAD');
  }

  function inspect(commit = firstCommit, previousCommit?: string) {
    return inspectContextRepository({
      repositoryPath, scope, commit, ...(previousCommit === undefined ? {} : { previousCommit }),
    });
  }

  beforeEach(async () => {
    repositoryPath = await mkdtemp(join(tmpdir(), 'cauce-context-fixture-'));
    await git('init', '--template=', '--initial-branch=main');
    await put('context.json', JSON.stringify(manifest));
    await put(profilePath, JSON.stringify(profile));
    await put(`${otherRoot}/profile.json`, JSON.stringify({ ...profile, purpose: 'Private other tenant fixture' }));
    firstCommit = await commitFixture();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(repositoryPath, { recursive: true, force: true });
  });

  it('reads committed bytes and canonical profile, preserving the index, HEAD and working tree', async () => {
    const indexBefore = await readFile(join(repositoryPath, '.git/index'));
    const result = await inspect();
    expect(result.sourceState).toBe('not_observed');
    expect(result.application).toBe('not_evaluated');
    expect(result.changes).toBeNull();
    expect(result.previous).toBeNull();
    expect(result.desired.profile).toEqual({ ...profile, tenant_id: scope.tenant_id, alias: scope.alias });
    expect(result.desired.commit).toBe(firstCommit);
    expect(result.desired.tree).toBe(await git('rev-parse', 'HEAD^{tree}'));
    expect(result.desired.sourceAgent.source_journal).toEqual({ id: '42', revision: 1 });
    expect(result.desired.provenanceVerification).toBe('not_evaluated');
    const bytes = await readFile(join(repositoryPath, profilePath));
    expect(result.desired.profileSource.content).toBe(bytes.toString('utf8'));
    expect(result.desired.profileSource.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.stringify(result)).not.toContain('Private other tenant');
    expect(JSON.stringify(result)).not.toContain('tenant-b');
    expect(await readFile(join(repositoryPath, '.git/index'))).toEqual(indexBefore);
    expect(await git('rev-parse', 'HEAD')).toBe(firstCommit);
    expect(await git('status', '--porcelain')).toBe('');
  });

  it('compares canonical profile versions without exposing other tenants or mutating the checkout', async () => {
    await put(profilePath, JSON.stringify({ ...profile, purpose: 'Changed fixture' }));
    const second = await commitFixture();
    const result = await inspect(second, firstCommit);
    expect(result.changes?.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: profilePath, kind: 'modified' },
    ]);
    const profileChange = result.changes?.find((change) => change.path === profilePath);
    expect(profileChange?.before.content).toBe(JSON.stringify(profile));
    expect(profileChange?.after.content).toContain('Changed fixture');
    expect(result.previous?.commit).toBe(firstCommit);
    expect(JSON.stringify(result)).not.toContain('tenant-b');
    expect(result.application).toBe('not_evaluated');
    const rollback = await inspect(firstCommit, second);
    expect(rollback.sourceState).toBe('not_observed');
    expect(rollback.desired.profile.purpose).toBe(profile.purpose);
    expect(await git('rev-parse', 'HEAD')).toBe(second);
  });

  it('round-trips an explicit export proposal and distinguishes repeated revisions by journal id', async () => {
    const proposal = prepareProfileExport({ scope, snapshot: {
      ...profile, tenant_id: scope.tenant_id, alias: scope.alias, id: '96', revision: 1,
      operation: 'insert', actor_tenant: null, actor_alias: null, changed_at: 'synthetic',
    } });
    expect(proposal.state).toBe('content_review_required');
    expect(await git('status', '--porcelain')).toBe('');
    const changedManifest = structuredClone(manifest);
    changedManifest.agents[0] = proposal.sourceAgent;
    await put('context.json', JSON.stringify(changedManifest));
    await put(proposal.source.path, proposal.source.content);
    const exportedCommit = await commitFixture();
    const result = await inspect(exportedCommit, firstCommit);
    expect(result.desired.profile).toEqual({ ...profile, tenant_id: scope.tenant_id, alias: scope.alias });
    expect(result.desired.sourceAgent.source_journal).toEqual({ id: '96', revision: 1 });
    expect(result.previous?.sourceAgent.source_journal).toEqual({ id: '42', revision: 1 });
    expect(result.provenanceChanged).toBe(true);
    expect(result.desired.provenanceVerification).toBe('not_evaluated');
    expect(result.application).toBe('not_evaluated');
  });

  it('reports journal changes even when the profile bytes are identical', async () => {
    const changedManifest = structuredClone(manifest);
    const first = changedManifest.agents[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error('missing fixture agent');
    first.source_journal.id = '96';
    await put('context.json', JSON.stringify(changedManifest));
    const result = await inspect(await commitFixture(), firstCommit);
    expect(result.changes).toEqual([]);
    expect(result.provenanceChanged).toBe(true);
  });

  it('does not invent changes when only another tenant changed', async () => {
    await put(`${otherRoot}/profile.json`, JSON.stringify({ ...profile, purpose: 'Other tenant revised' }));
    const second = await commitFixture();
    const result = await inspect(second, firstCommit);
    expect(result.changes).toEqual([]);
    expect(result.provenanceChanged).toBe(false);
    expect(result.desired.commit).not.toBe(result.previous?.commit);
  });

  it.each([
    { instance_id: 'other', tenant_id: 'Steven', alias: 'helper' },
    { instance_id: 'fixture', tenant_id: 'missing', alias: 'helper' },
    { instance_id: 'fixture', tenant_id: 'Steven', alias: 'missing' },
  ])('rejects a missing exact scope %#', async (requestedScope) => {
    await expect(inspectContextRepository({ repositoryPath, scope: requestedScope, commit: firstCommit }))
      .rejects.toThrow('scope_unavailable');
  });

  it.each(['HEAD', 'main', 'HEAD~1', '--help', 'a'.repeat(39)])('requires a full immutable commit: %s', async (commit) => {
    await expect(inspect(commit)).rejects.toThrow('invalid_commit');
  });

  it('rejects a blob or annotated tag passed as a commit', async () => {
    const blob = await git('rev-parse', `HEAD:${profilePath}`);
    await expect(inspect(blob)).rejects.toThrow('invalid_commit');
    await git('tag', '-a', 'fixture-tag', '-m', 'Fixture');
    await expect(inspect(await git('rev-parse', 'fixture-tag'))).rejects.toThrow('invalid_commit');
  });

  it('rejects a nested repository path instead of reading its parent', async () => {
    await expect(inspectContextRepository({ repositoryPath: join(repositoryPath, 'tenants'), scope, commit: firstCommit }))
      .rejects.toThrow('invalid_repository_root');
  });

  it.each(['unstaged', 'staged', 'untracked', 'ignored'])('withholds cleanliness claims for %s files without returning working bytes', async (kind) => {
    if (kind === 'unstaged' || kind === 'staged') {
      await put(profilePath, JSON.stringify({ ...profile, purpose: 'Local unreviewed bytes' }));
      if (kind === 'staged') await git('add', profilePath);
    } else {
      if (kind === 'ignored') await put('.git/info/exclude', 'local-memory.md\n');
      await put('local-memory.md', 'Local unreviewed bytes');
    }
    const result = await inspect();
    expect(result.sourceState).toBe('not_observed');
    expect(result.desired.profile.purpose).toBe(profile.purpose);
    expect(JSON.stringify(result)).not.toContain('Local unreviewed bytes');
  });

  it('keeps working-file observation unavailable during an injected safe write', async () => {
    const reader = await ContextGitReader.open(repositoryPath);
    const original = reader.blob.bind(reader);
    vi.spyOn(ContextGitReader, 'open').mockResolvedValue(reader);
    let injected = false;
    vi.spyOn(reader, 'blob').mockImplementation(async (entry) => {
      if (!injected) {
        injected = true;
        await put('external.md', 'External writer fixture');
      }
      return original(entry);
    });
    expect((await inspect()).sourceState).toBe('not_observed');
  });

  it.each([
    'MEMORY.md', 'HEARTBEAT.md', 'memory/day.md', '.env', '.claude/settings.json', 'README.md',
    `${root}/instructions/claude/review.md`, `${root}/skills/codex/review/SKILL.md`,
  ])('rejects tracked memory, manual bodies, skills or other undeclared file %s', async (path) => {
    await put(path, 'Synthetic excluded fixture');
    await expect(inspect(await commitFixture())).rejects.toThrow('unexpected_files');
  });

  it('rejects tracked symlinks without following them', async () => {
    await rm(join(repositoryPath, profilePath));
    await symlink('/does-not-exist-fixture', join(repositoryPath, profilePath));
    await expect(inspect(await commitFixture())).rejects.toThrow('unsupported_entry');
  });

  it('rejects submodule entries without opening a submodule', async () => {
    await mkdir(join(repositoryPath, 'nested'));
    await git('-C', 'nested', 'init', '--template=', '--initial-branch=main');
    await git('update-index', '--add', '--cacheinfo', `160000,${firstCommit},nested`);
    await git('commit', '-m', 'Synthetic submodule entry');
    await expect(inspect(await git('rev-parse', 'HEAD'))).rejects.toThrow('unsupported_entry');
  });

  it('rejects executable files', async () => {
    await git('update-index', '--chmod=+x', profilePath);
    await git('commit', '-m', 'Synthetic executable entry');
    await expect(inspect(await git('rev-parse', 'HEAD'))).rejects.toThrow('unsupported_entry');
  });

  it('rejects committed blobs above the per-object bound', async () => {
    await put(profilePath, Buffer.alloc(CONTEXT_REPOSITORY_LIMITS.blobBytes + 1, 'x'));
    await expect(inspect(await commitFixture())).rejects.toThrow('size_limit');
  });

  it.each(['files', 'totalBytes'])('bounds committed files and cumulative blob size by %s', async (limit) => {
    const count = limit === 'files' ? CONTEXT_REPOSITORY_LIMITS.files : 17;
    const content = limit === 'files' ? 'x' : 'x'.repeat(CONTEXT_REPOSITORY_LIMITS.blobBytes);
    for (let index = 0; index < count; index += 1) await put(`tenants/extra/agents/a${String(index)}/profile.json`, content);
    await expect(inspect(await commitFixture())).rejects.toThrow('size_limit');
  });

  it('rejects missing declared files and malformed committed text', async () => {
    await rm(join(repositoryPath, profilePath));
    await expect(inspect(await commitFixture())).rejects.toThrow('unexpected_files');
    await put(profilePath, Buffer.from([0xff]));
    await expect(inspect(await commitFixture())).rejects.toThrow('invalid_text');
  });

  it('rejects recognized secret content anywhere in the snapshot without exposing it', async () => {
    await put(`${otherRoot}/profile.json`, JSON.stringify({
      ...profile, purpose: 'https://synthetic-user:synthetic-password@example.invalid',
    }));
    await expect(inspect(await commitFixture())).rejects.toThrow('context repository: forbidden_content');
  });

  it('rejects a baseline bound to another instance', async () => {
    await put('context.json', JSON.stringify({ ...manifest, instance_id: 'other' }));
    const otherCommit = await commitFixture();
    await expect(inspect(firstCommit, otherCommit)).rejects.toThrow('scope_unavailable');
  });

  it('ignores replacement refs and inherited Git environment overrides', async () => {
    await put(profilePath, JSON.stringify({ ...profile, purpose: 'Replacement fixture' }));
    const second = await commitFixture();
    await git('replace', firstCommit, second);
    vi.stubEnv('GIT_DIR', '/does-not-exist-fixture');
    try {
      expect((await inspect()).desired.profile.purpose).toBe(profile.purpose);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('has no process, dynamic import or network command boundary in the object reader', async () => {
    const source = await readFile(new URL('./git-reader.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/child_process|(?<![.\w])(?:execFile|spawn|exec|fetch|eval|Function)\s*\(|import\s*\(|node:(?:https?|net|tls|vm)|\brequire\s*\(|\bprocess\b/u);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1]);
    expect(imports).toEqual([
      'node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:util', 'node:zlib',
      '@cauce/protocol', './model.js',
    ]);
  });

  it('does not consult repository config or attributes, using only safe inert fixtures', async () => {
    await put('.git/config', 'synthetic invalid configuration; never parsed by the reader\n');
    await put('.gitattributes', '*.json text eol=lf\n');
    await put('.git/info/attributes', '*.json -text\n');
    const result = await inspect();
    expect(result.desired.profile.purpose).toBe(profile.purpose);
    expect(result.sourceState).toBe('not_observed');
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('withholds cleanliness despite index shortcut %s and repeated edits', async (flag) => {
    await git('update-index', flag, profilePath);
    for (const purpose of ['First local edit', 'Second local edit']) {
      await put(profilePath, JSON.stringify({ ...profile, purpose }));
      const result = await inspect();
      expect(result.sourceState).toBe('not_observed');
      expect(result.desired.profile.purpose).toBe(profile.purpose);
    }
  });

  it.each(['alternates', 'http-alternates'])('rejects %s metadata without reading its target', async (name) => {
    await put(`.git/objects/info/${name}`, 'synthetic unavailable storage\n');
    await expect(inspect()).rejects.toThrow('unsupported_object_storage');
  });

  it('rejects packed storage without unpacking or invoking Git', async () => {
    await git('gc', '--quiet');
    await expect(inspect()).rejects.toThrow('unsupported_object_storage');
  });

  it('rejects a linked-worktree metadata file', async () => {
    await rm(join(repositoryPath, '.git'), { recursive: true });
    await put('.git', 'gitdir: synthetic-unavailable-worktree\n');
    await expect(inspect()).rejects.toThrow('unsupported_object_storage');
  });

  it('rejects a changed object stored under its original identity', async () => {
    const blob = await git('rev-parse', `HEAD:${profilePath}`);
    const other = await git('rev-parse', `HEAD:${otherRoot}/profile.json`);
    const objectPath = (oid: string) => join(repositoryPath, '.git/objects', oid.slice(0, 2), oid.slice(2));
    const bytes = await readFile(objectPath(other));
    await rm(objectPath(blob));
    await writeFile(objectPath(blob), bytes);
    await expect(inspect()).rejects.toThrow('invalid_object');
  });

  it('reads SHA-256 loose objects with the same bounded profile-only contract', async () => {
    const directory = 'sha256-fixture';
    await mkdir(join(repositoryPath, directory));
    await git('-C', directory, 'init', '--template=', '--initial-branch=main', '--object-format=sha256');
    await put(`${directory}/context.json`, JSON.stringify(manifest));
    await put(`${directory}/${profilePath}`, JSON.stringify(profile));
    await put(`${directory}/${otherRoot}/profile.json`, JSON.stringify(profile));
    await git('-C', directory, 'add', '--all');
    await git('-C', directory, 'commit', '-m', 'Synthetic SHA-256 fixture');
    const commit = await git('-C', directory, 'rev-parse', 'HEAD');
    const result = await inspectContextRepository({ repositoryPath: join(repositoryPath, directory), scope, commit });
    expect(result.desired.commit).toHaveLength(64);
    expect(result.desired.tree).toHaveLength(64);
    expect(result.desired.profile.purpose).toBe(profile.purpose);
    expect(result.sourceState).toBe('not_observed');
  });
});
