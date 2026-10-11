import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonicalContextFiles, contextDigest, contextRepositoryPrefix, type ContextGitSink, type ContextVersion } from './context-version-model.js';

const execute = promisify(execFile);
export class ContextGitBroker implements ContextGitSink {
  constructor(private readonly repositoryRoot: string) {
    if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot || repositoryRoot === '/') {
      throw new Error('context repository root must be an absolute canonical directory');
    }
  }
  private async root(): Promise<void> {
    const root = await lstat(this.repositoryRoot);
    const metadata = await lstat(join(this.repositoryRoot, '.git'));
    if (!root.isDirectory() || !metadata.isDirectory() || await realpath(this.repositoryRoot) !== this.repositoryRoot
      || (root.mode & 0o077) !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error('context repository must be private and have real Git metadata');
    }
  }
  private async git(args: readonly string[], input?: string, index?: string): Promise<string> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    env.GIT_TERMINAL_PROMPT = '0'; env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_AUTHOR_NAME = 'Cauce context broker'; env.GIT_AUTHOR_EMAIL = 'context-broker@cauce.invalid';
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME; env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
    if (index !== undefined) env.GIT_INDEX_FILE = index;
    const pending = execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', this.repositoryRoot, ...args], {
      env, timeout: 20_000, maxBuffer: 2_097_152, encoding: 'utf8',
    });
    if (input !== undefined) { pending.child.stdin?.end(input); }
    return (await pending).stdout.trim();
  }
  async commit(version: ContextVersion): Promise<string> {
    await this.root();
    const files = canonicalContextFiles(version.files);
    if (contextDigest(files) !== version.digest) throw new Error('context content digest differs');
    const prefix = contextRepositoryPrefix(version);
    const marker = `Cauce-Version: ${prefix}@${String(version.version)}:${version.digest}`;
    const existing = await this.git(['log', '--all', '--fixed-strings', `--grep=${marker}`, '--format=%H', '-1']).catch(() => '');
    if (/^[a-f0-9]{40,64}$/u.test(existing)) return existing;
    const directory = await mkdtemp(join(this.repositoryRoot, '.git', 'context-index-'));
    const index = join(directory, 'index');
    try {
      const parent = await this.git(['rev-parse', '--verify', 'refs/heads/main']).catch(() => '');
      await this.git(parent === '' ? ['read-tree', '--empty'] : ['read-tree', parent], undefined, index);
      const tracked = await this.git(['ls-files', '-z', '--', prefix], undefined, index);
      for (const path of tracked.split('\0').filter(Boolean)) await this.git(['update-index', '--force-remove', '--', path], undefined, index);
      const metadata = JSON.stringify({ company_id: version.company_id, tenant_id: version.tenant_id, alias: version.alias,
        version: version.version, digest: version.digest, source: version.source, restored_from: version.restored_from,
        actor_human_id: version.actor_human_id, actor_alias: version.actor_alias, created_at: version.created_at });
      for (const file of [...files, { path: '.cauce-version.json', content: metadata }]) {
        const blob = await this.git(['hash-object', '-w', '--stdin'], file.content);
        await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${prefix}/${file.path}`], undefined, index);
      }
      const tree = await this.git(['write-tree'], undefined, index);
      const commit = await this.git(['commit-tree', tree, ...(parent === '' ? [] : ['-p', parent])],
        `Context ${String(version.version)} ${createHash('sha256').update(prefix).digest('hex').slice(0, 16)}\n\n${marker}\n`);
      await this.git(['update-ref', 'refs/heads/main', commit, parent === '' ? '0'.repeat(commit.length) : parent]);
      return commit;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async push(commit: string): Promise<void> {
    await this.root();
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('context push commit is invalid');
    await this.git(['merge-base', '--is-ancestor', commit, 'refs/heads/main']);
    await this.git(['push', '--porcelain', 'origin', 'refs/heads/main:refs/heads/main']);
  }
}
