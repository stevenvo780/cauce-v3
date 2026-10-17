import { access, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '@cauce/store';
import { contextRepositoryPrefix } from '../../packages/store/src/context-version-model.js';
import { cleanupAggregate } from '../helpers/cleanup-failure.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { createDrill, git, type ContextGitDrill, type OutboxEvidence } from './failure-drill-context-git.fixtures.js';
import { sweepDatabaseFleet } from './failure-drill-ssh.fixtures.js';

let database: TestDatabase | undefined;
const drills: ContextGitDrill[] = [];

beforeAll(async () => {
  database = await startTestDatabase({ requireOwnedContainer: true });
  process.stdout.write(`failure-drill-context-git owned PostgreSQL ${database.container.getId()}\n`);
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const drill of drills) {
    try {
      try {
        const prefix = basename(drill.directory);
        const sweep = await sweepDatabaseFleet(drill.database.pool, drill.directory, prefix, prefix);
        expect(sweep.exitCode).toBe(0); expect(sweep.report.clean).toBe(true);
      } finally { await drill.close(); }
      await expect(access(drill.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      process.stdout.write(`failure-drill-context-git removed ${drill.directory}\n`);
    } catch (error) { failures.push(error); }
  }
  if (database) {
    try { await database.pool.end(); }
    catch (error) { failures.push(error); }
    if (database.adminPool !== database.pool) {
      try { await database.adminPool.end(); }
      catch (error) { failures.push(error); }
    }
    try { await database.container.stop(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw cleanupAggregate(failures, 'owned Git drill cleanup failed');
});

async function fixture(): Promise<ContextGitDrill> {
  if (!database) throw new Error('owned PostgreSQL is unavailable');
  const drill = await createDrill(database);
  drills.push(drill);
  return drill;
}

describe('context broker with real Git processes and durable PostgreSQL state', () => {
  it('keeps a rejected commit and reaches durable Git synced after the remote accepts its retry', async () => {
    const drill = await fixture();
    const content = 'A context write whose first push must be rejected.';
    await drill.write(drill.first, content);
    const hook = join(drill.remote, 'hooks', 'pre-receive');
    await writeFile(hook, "#!/bin/sh\nprintf '%s\\n' 'owned context failure drill rejects this push' >&2\nexit 1\n", { mode: 0o700 });
    const failed = await drill.process(drill.first);
    expect(failed).toMatchObject({ state: 'error', version: 1, error: 'context_push_failed' });
    const before = await drill.outbox(drill.first);
    expect(before).toMatchObject({ state: 'error', pushed_at: null, last_error: 'context_push_failed', attempts: 1 });
    expect(before.git_commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(await drill.remoteHead()).toBe(drill.initialCommit);
    expect((await drill.read(drill.first)).sync).toMatchObject({ state: 'error', pushed_at: null });
    if (!before.git_commit) throw new Error('rejected real commit was not retained');
    expect(await git(drill.firstRepository, ['cat-file', '-t', before.git_commit])).toBe('commit');

    await rm(hook);
    await drill.retry(drill.first);
    expect(await drill.process(drill.first)).toMatchObject({ state: 'pending', version: 1 });
    const after = await drill.outbox(drill.first);
    expect(after).toMatchObject({ state: 'synced', git_commit: before.git_commit, last_error: null, attempts: 2 });
    expect(after.pushed_at).toBeInstanceOf(Date);
    expect(await drill.remoteHead()).toBe(before.git_commit);
    expect(await drill.remoteContent(drill.first)).toBe(content);
    const snapshot = await drill.read(drill.first);
    expect(snapshot.sync).toMatchObject({ state: 'synced', git_commit: before.git_commit });
    expect(snapshot.application).toMatchObject({ state: 'pending' });
    expect(snapshot.applied_version).toBe(0);
    expect((await drill.audit()).map(row => [row.state, row.error_code])).toEqual([
      ['error', 'context_push_failed'], ['synced', null],
    ]);
    process.stdout.write(`failure-drill-context-git recovered ${JSON.stringify({ commit: before.git_commit,
      git_state: snapshot.sync.state, runtime_state: snapshot.application.state, attempts: after.attempts })}\n`);
  });

  describe('two writers with a real non-fast-forward rejection after the remote advanced', () => {
    const firstContent = 'The first real broker writer publishes this context.';
    const secondContent = 'The second real broker writer must retain its rejected context.';
    let rejectedSnapshot: ContextSnapshot;
    let rejectedHistory: string[];
    let secondSnapshot: ContextSnapshot;
    let firstCommit: string;
    let secondCommit: string;
    let retry: OutboxEvidence;
    let history: string[];
    let mergeParents: string[];

    beforeAll(async () => {
      const drill = await fixture();
      await Promise.all([drill.write(drill.first, firstContent), drill.write(drill.second, secondContent)]);
      expect(await git(drill.firstRepository, ['rev-parse', 'refs/heads/main'])).toBe(drill.initialCommit);
      expect(await git(drill.secondRepository, ['rev-parse', 'refs/heads/main'])).toBe(drill.initialCommit);
      await drill.freezeSecondFetch();
      expect(await drill.process(drill.first)).toMatchObject({ state: 'pending', version: 1 });
      const first = await drill.outbox(drill.first);
      expect(first.state).toBe('synced');
      if (!first.git_commit) throw new Error('first writer did not publish a real commit');
      firstCommit = first.git_commit;
      expect(await drill.remoteContent(drill.first)).toBe(firstContent);

      expect(await drill.process(drill.second)).toMatchObject({ state: 'error', error: 'context_git_non_fast_forward' });
      const rejected = await drill.outbox(drill.second);
      expect(rejected).toMatchObject({ state: 'error', pushed_at: null,
        last_error: 'context_git_non_fast_forward', attempts: 1 });
      if (!rejected.git_commit) throw new Error('second writer lost its rejected real commit');
      secondCommit = rejected.git_commit;
      const rejectedPath = `${secondCommit}:${contextRepositoryPrefix(drill.second)}/context/mission.md`;
      expect(await git(drill.secondRepository, ['show', rejectedPath])).toBe(secondContent);
      rejectedSnapshot = await drill.read(drill.second);
      rejectedHistory = (await drill.remoteHistory()).split('\n');
      expect(await drill.remoteHead()).toBe(firstCommit);

      await drill.thawSecondFetch();
      await drill.retry(drill.second);
      expect(await drill.process(drill.second)).toMatchObject({ state: 'pending', version: 1 });
      retry = await drill.outbox(drill.second);
      secondSnapshot = await drill.read(drill.second);
      history = (await drill.remoteHistory()).split('\n');
      mergeParents = (await git(drill.remote, ['rev-list', '--parents', '-n', '1', 'refs/heads/main'])).split(' ').slice(1);
      expect(await drill.remoteContent(drill.first)).toBe(firstContent);
      expect(await drill.remoteContent(drill.second)).toBe(secondContent);
      expect((await drill.audit()).map(row => [row.target_alias, row.state, row.error_code])).toEqual([
        [drill.first.alias, 'synced', null],
        [drill.second.alias, 'error', 'context_git_non_fast_forward'],
        [drill.second.alias, 'synced', null],
      ]);
      process.stdout.write(`failure-drill-context-git reconciled ${JSON.stringify({ first_commit: firstCommit,
        rejected_commit: secondCommit, merge_parents: mergeParents, git_state: secondSnapshot.sync.state,
        attempts: retry.attempts, remote_contains_rejected_commit: history.includes(secondCommit) })}\n`);
    });

    it('retains the rejected commit and never reports synced while the second writer is rejected', () => {
      expect(rejectedSnapshot.sync).toMatchObject({ state: 'error', git_commit: secondCommit, pushed_at: null,
        last_error: 'context_git_non_fast_forward' });
      expect(rejectedSnapshot.files).toContainEqual({ path: 'context/mission.md', content: secondContent });
      expect(rejectedSnapshot.application.state).toBe('pending');
      expect(rejectedHistory).toContain(firstCommit);
      expect(rejectedHistory).not.toContain(secondCommit);
    });

    it('reconciles both writers on retry and reaches synced without losing a commit', () => {
      expect(retry).toMatchObject({ state: 'synced', git_commit: secondCommit, last_error: null, attempts: 2 });
      expect(retry.pushed_at).toBeInstanceOf(Date);
      expect(secondSnapshot.sync).toMatchObject({ state: 'synced', git_commit: secondCommit });
      expect(history).toContain(firstCommit);
      expect(history).toContain(secondCommit);
      expect(mergeParents).toEqual([firstCommit, secondCommit]);
    });
  });
});
