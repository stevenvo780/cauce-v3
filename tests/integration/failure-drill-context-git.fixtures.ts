import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { lockCompanyAuthority, type DatabaseClient, type ContextSnapshot, type ContextTarget } from '@cauce/store';
import { ContextGitBroker } from '../../packages/store/src/context-git.js';
import { ContextVersionStore } from '../../packages/store/src/context-version.js';
import { processContextOutbox } from '../../packages/store/src/context-version-worker.js';
import { contextRepositoryPrefix } from '../../packages/store/src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { startTestCaseDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const execute = promisify(execFile);
const gitEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Cauce failure drill', GIT_AUTHOR_EMAIL: 'failure-drill@cauce.invalid',
  GIT_COMMITTER_NAME: 'Cauce failure drill', GIT_COMMITTER_EMAIL: 'failure-drill@cauce.invalid',
};

export async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-c', 'credential.helper=', '-C', directory, ...args],
    { env: gitEnvironment, encoding: 'utf8', timeout: 20_000, maxBuffer: 2_097_152 });
  return stdout.trim();
}

export interface OutboxEvidence {
  alias: string; version: string; state: string; git_commit: string | null; pushed_at: Date | null;
  last_error: string | null; attempts: number;
}

export class ContextGitDrill {
  readonly first: ContextTarget;
  readonly second: ContextTarget;
  readonly firstBroker: ContextGitBroker;
  readonly secondBroker: ContextGitBroker;
  readonly store: ContextVersionStore;
  constructor(readonly database: EmptyTestDatabase, readonly directory: string,
    readonly remote: string, readonly firstRepository: string, readonly secondRepository: string,
    readonly initialCommit: string, private readonly humanId: string) {
    this.first = { company_id: 'context_alpha', tenant_id: 'ContextAlpha', alias: 'zz-canary-drill-git-a' };
    this.second = { ...this.first, alias: 'zz-canary-drill-git-b' };
    this.firstBroker = new ContextGitBroker(firstRepository);
    this.secondBroker = new ContextGitBroker(secondRepository);
    this.store = new ContextVersionStore(database.pool);
  }
  authority = (client: DatabaseClient) => lockCompanyAuthority(client,
    { tenant: this.first.tenant_id, alias: 'owner', humanId: this.humanId });
  write(target: ContextTarget, content: string): Promise<ContextSnapshot> {
    return this.store.write(this.authority, target.tenant_id, target.alias,
      { expected_version: 0, source: 'cli', files: [{ path: 'context/mission.md', content }] });
  }
  read(target: ContextTarget): Promise<ContextSnapshot> {
    return this.store.read(this.authority, target.tenant_id, target.alias);
  }
  retry(target: ContextTarget): Promise<ContextSnapshot> {
    return this.store.retry(this.authority, target.tenant_id, target.alias);
  }
  process(target: ContextTarget) {
    return processContextOutbox(this.database.pool,
      { git: target.alias === this.first.alias ? this.firstBroker : this.secondBroker }, target);
  }
  async outbox(target: ContextTarget): Promise<OutboxEvidence> {
    const row = (await this.database.pool.query<OutboxEvidence>(`SELECT alias,version,state,git_commit,pushed_at,last_error,attempts
      FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY version DESC LIMIT 1`,
    [target.company_id, target.tenant_id, target.alias])).rows[0];
    if (!row) throw new Error('owned context outbox is missing');
    return row;
  }
  async audit() {
    return (await this.database.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action='context.sync' ORDER BY id")).rows.map(row => row.metadata);
  }
  /** The second broker keeps pushing to the real remote but fetches a copy frozen now: the remote advances behind its back. */
  async freezeSecondFetch(): Promise<void> {
    const frozen = join(this.directory, 'zz-canary-drill-git-frozen.git');
    await git(this.directory, ['clone', '--quiet', '--mirror', this.remote, frozen]);
    await git(this.secondRepository, ['remote', 'set-url', 'origin', frozen]);
    await git(this.secondRepository, ['remote', 'set-url', '--push', 'origin', this.remote]);
  }
  async thawSecondFetch(): Promise<void> {
    await git(this.secondRepository, ['remote', 'set-url', 'origin', this.remote]);
    await git(this.secondRepository, ['config', '--unset', 'remote.origin.pushurl']);
  }
  remoteHead(): Promise<string> { return git(this.remote, ['rev-parse', 'refs/heads/main']); }
  remoteHistory(): Promise<string> { return git(this.remote, ['rev-list', 'refs/heads/main']); }
  remoteContent(target: ContextTarget): Promise<string> {
    return git(this.remote, ['show', `refs/heads/main:${contextRepositoryPrefix(target)}/context/mission.md`]);
  }
  async close(): Promise<void> {
    try { await this.database.close(); }
    finally { await rm(this.directory, { recursive: true, force: true }); }
  }
}

export async function createDrill(database: TestDatabase): Promise<ContextGitDrill> {
  const current = await startTestCaseDatabase(database);
  let directory: string | undefined;
  try {
    const contexts = await seedSyntheticCompanyContexts(current.adminUrl);
    const owner = contexts[0];
    if (!owner) throw new Error('owned context company is missing');
    await current.adminPool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled)
      VALUES($1,'zz-canary-drill-git-a','codex',false),($1,'zz-canary-drill-git-b','codex',false)`, [owner.tenant_id]);
    directory = await mkdtemp(join(tmpdir(), 'zz-canary-drill-git-'));
    await chmod(directory, 0o700);
    const remote = join(directory, 'zz-canary-drill-git-origin.git');
    const firstRepository = join(directory, 'zz-canary-drill-git-writer-a');
    const secondRepository = join(directory, 'zz-canary-drill-git-writer-b');
    await git(directory, ['init', '--bare', '--initial-branch=main', remote]);
    await git(directory, ['init', '--initial-branch=main', firstRepository]);
    await chmod(firstRepository, 0o700);
    await git(firstRepository, ['commit', '--allow-empty', '-m', 'Initialize owned context drill']);
    await git(firstRepository, ['remote', 'add', 'origin', remote]);
    await git(firstRepository, ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await git(directory, ['clone', remote, secondRepository]);
    await chmod(secondRepository, 0o700);
    return new ContextGitDrill(current, directory, remote, firstRepository, secondRepository,
      await git(remote, ['rev-parse', 'refs/heads/main']), owner.human_id);
  } catch (error) {
    try { await current.close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}
