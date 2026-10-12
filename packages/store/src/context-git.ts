import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AliasSchema } from '@cauce/protocol';
import { assertContextTarget, canonicalContextFiles, contextDigest, contextRepositoryPrefix, type ContextGitSink,
  type ContextVersion } from './context-version-model.js';

const execute = promisify(execFile);
const BROKER = { name: 'Cauce context broker', email: 'context-broker@cauce.invalid' };
const COMMIT = /^[a-f0-9]{40,64}$/u;
const MAIN = 'refs/heads/main';
const REMOTE_MAIN = 'refs/remotes/origin/main';
interface ContextAuthor { readonly name: string; readonly email: string; readonly date: string }
interface GitOptions { readonly input?: string; readonly index?: string; readonly author?: ContextAuthor }

/** The alias that wrote the version authors its commit and the broker commits it, under a non-deliverable address. */
function contextAuthor(version: ContextVersion): ContextAuthor {
  assertContextTarget(version);
  const seconds = Math.floor(Date.parse(version.created_at) / 1000);
  if (!AliasSchema.safeParse(version.actor_alias).success || !Number.isSafeInteger(seconds)) throw new Error('context author is invalid');
  return { name: version.actor_alias, email: `${version.actor_alias}@${version.company_id}.cauce.invalid`, date: `${String(seconds)} +0000` };
}
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
  private async git(args: readonly string[], options: GitOptions = {}): Promise<string> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    // Failure causes are classified from Git's English messages.
    env.LC_ALL = 'C'; env.GIT_TERMINAL_PROMPT = '0'; env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_COMMITTER_NAME = BROKER.name; env.GIT_COMMITTER_EMAIL = BROKER.email;
    env.GIT_AUTHOR_NAME = options.author?.name ?? BROKER.name; env.GIT_AUTHOR_EMAIL = options.author?.email ?? BROKER.email;
    if (options.author) env.GIT_AUTHOR_DATE = options.author.date;
    if (options.index !== undefined) env.GIT_INDEX_FILE = options.index;
    const pending = execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', this.repositoryRoot, ...args], {
      env, timeout: 20_000, maxBuffer: 2_097_152, encoding: 'utf8',
    });
    if (options.input !== undefined) { pending.child.stdin?.end(options.input); }
    return (await pending).stdout.trim();
  }
  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  }
  private async localMain(): Promise<string> {
    return this.git(['rev-parse', '--verify', '--quiet', MAIN]).catch(() => '');
  }
  /** The remote main after a fresh fetch, or '' while the remote has no main yet. */
  private async fetchRemoteMain(): Promise<string> {
    try {
      await this.git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', `+${MAIN}:${REMOTE_MAIN}`]);
    } catch (error) {
      if (!String((error as { stderr?: unknown }).stderr).includes("couldn't find remote ref")) throw error;
      await this.git(['update-ref', '-d', REMOTE_MAIN]);
      return '';
    }
    return this.git(['rev-parse', '--verify', REMOTE_MAIN]);
  }
  async commit(version: ContextVersion): Promise<string> {
    await this.root();
    const files = canonicalContextFiles(version.files);
    if (contextDigest(files) !== version.digest) throw new Error('context content digest differs');
    const prefix = contextRepositoryPrefix(version);
    const author = contextAuthor(version);
    const marker = `Cauce-Version: ${prefix}@${String(version.version)}:${version.digest}`;
    const existing = await this.git(['log', '--all', '--fixed-strings', `--grep=${marker}`, '--format=%H', '-1']).catch(() => '');
    if (COMMIT.test(existing)) return existing;
    const local = await this.localMain();
    // An unreachable remote must not cost the local commit: push fetches again and reconciles.
    const remote = await this.fetchRemoteMain().catch(() => '');
    const parent = remote !== '' && (local === '' || await this.isAncestor(local, remote)) ? remote : local;
    const directory = await mkdtemp(join(this.repositoryRoot, '.git', 'context-index-'));
    const index = join(directory, 'index');
    try {
      await this.git(parent === '' ? ['read-tree', '--empty'] : ['read-tree', parent], { index });
      await this.clearFolder(prefix, index);
      const metadata = JSON.stringify({ company_id: version.company_id, tenant_id: version.tenant_id, alias: version.alias,
        version: version.version, digest: version.digest, source: version.source, restored_from: version.restored_from,
        actor_human_id: version.actor_human_id, actor_alias: version.actor_alias, created_at: version.created_at });
      for (const file of [...files, { path: '.cauce-version.json', content: metadata }]) {
        const blob = await this.git(['hash-object', '-w', '--stdin'], { input: file.content });
        await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${prefix}/${file.path}`], { index });
      }
      const tree = await this.git(['write-tree'], { index });
      const commit = await this.git(['commit-tree', tree, ...(parent === '' ? [] : ['-p', parent])], { author,
        input: `Context ${String(version.version)} ${createHash('sha256').update(prefix).digest('hex').slice(0, 16)}\n\n${marker}\n` });
      await this.git(['update-ref', MAIN, commit, local === '' ? '0'.repeat(commit.length) : local]);
      return commit;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private async clearFolder(prefix: string, index: string): Promise<void> {
    const tracked = await this.git(['ls-files', '-z', '--', prefix], { index });
    if (tracked !== '') await this.git(['update-index', '--force-remove', '-z', '--stdin'], { index, input: tracked });
  }
  private async changedFolders(from: string, to: string): Promise<Set<string>> {
    const paths = await this.git(['diff', '--name-only', '-z', '--no-renames', from, to]);
    return new Set(paths.split('\0').filter(Boolean).map(path => path.split('/').slice(0, 6).join('/')));
  }
  private async folderVersion(commit: string, prefix: string): Promise<number> {
    try {
      const metadata: unknown = JSON.parse(await this.git(['cat-file', 'blob', `${commit}:${prefix}/.cauce-version.json`]));
      const version = metadata !== null && typeof metadata === 'object' ? (metadata as { version?: unknown }).version : undefined;
      return typeof version === 'number' ? version : 0;
    } catch { return 0; }
  }
  /**
   * Every agent owns its folder, so the merge is decided per folder: a side that alone changed it keeps it and, when both
   * did, the higher Cauce version wins. Both histories stay reachable from the merge commit.
   */
  private async mergeRemote(remote: string, local: string): Promise<void> {
    const base = await this.git(['merge-base', remote, local]).catch(() => '');
    if (base === '') throw new Error('context history is unrelated to the remote; non-fast-forward merge refused');
    const remoteChanged = await this.changedFolders(base, remote);
    const directory = await mkdtemp(join(this.repositoryRoot, '.git', 'context-merge-'));
    const index = join(directory, 'index');
    try {
      await this.git(['read-tree', remote], { index });
      for (const prefix of await this.changedFolders(base, local)) {
        if (remoteChanged.has(prefix) && await this.folderVersion(remote, prefix) >= await this.folderVersion(local, prefix)) continue;
        await this.clearFolder(prefix, index);
        const entries = await this.git(['ls-tree', '-r', '-z', '--full-tree', local, '--', prefix]);
        if (entries !== '') await this.git(['update-index', '-z', '--index-info'], { index, input: entries });
      }
      const tree = await this.git(['write-tree'], { index });
      const merge = await this.git(['commit-tree', tree, '-p', remote, '-p', local], { input: 'Merge remote context history\n' });
      await this.git(['update-ref', MAIN, merge, local]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async push(commit: string): Promise<void> {
    await this.root();
    if (!COMMIT.test(commit)) throw new Error('context push commit is invalid');
    const remote = await this.fetchRemoteMain();
    if (remote !== '' && await this.isAncestor(commit, remote)) return;
    const local = await this.localMain();
    if (local === '' || !await this.isAncestor(commit, local)) throw new Error('context commit is not on the broker main branch');
    if (remote !== '' && !await this.isAncestor(remote, local)) await this.mergeRemote(remote, local);
    await this.git(['push', '--porcelain', 'origin', `${MAIN}:${MAIN}`]);
  }
}
