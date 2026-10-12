import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DatabasePool } from '../src/index.js';
import { ContextGitBroker } from '../src/context-git.js';
import { nativeContextDirectory, seedAgentContextHistory, type ContextSeedResult } from '../src/context-seed.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { contextRepositoryPrefix } from '../src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const execute = promisify(execFile);
const platform = fileURLToPath(new URL('../../../ops/cli/cauce-platform', import.meta.url));
const gitEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'zz-canary-seed', GIT_AUTHOR_EMAIL: 'zz-canary-seed@cauce.invalid',
  GIT_COMMITTER_NAME: 'zz-canary-seed', GIT_COMMITTER_EMAIL: 'zz-canary-seed@cauce.invalid',
};
const git = async (directory: string, args: string[]) =>
  (await execute('git', ['-C', directory, ...args], { env: gitEnvironment, encoding: 'utf8', timeout: 20_000 })).stdout.trim();

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let directory: string;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await seedSyntheticCompanyContexts(current.adminUrl);
  await current.adminPool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,retired_at) VALUES
    ('ContextAlpha','zz-canary-seed-empty','codex',false,NULL),('ContextAlpha','zz-canary-seed-retired','codex',false,now())`);
  await current.adminPool.query(`INSERT INTO agent_profiles(tenant_id,alias,role_summary,revision,updated_at)
    VALUES('ContextAlpha','zz-canary-seed-retired','Retired agent',1,now())`);
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-seed-')); await chmod(directory, 0o700);
});
afterEach(async () => { await current?.close(); current = undefined; await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function natives(files: Record<string, string>): Promise<string> {
  const root = join(directory, 'natives');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
  }
  return root;
}
async function versions() {
  return (await pool.query<{ company_id: string; alias: string; version: string; source: string; actor_alias: string;
    actor_human_id: string | null; paths: string[] }>(`SELECT company_id,alias,version,source,actor_alias,actor_human_id,
    ARRAY(SELECT file->>'path' FROM jsonb_array_elements(files) file ORDER BY 1) AS paths
    FROM agent_context_versions ORDER BY company_id,tenant_id,alias,version`)).rows;
}
// The bundle seeds other companies (the humanizar context director, without a profile); only the fixture ones are asserted.
const states = (results: readonly ContextSeedResult[]) => results.filter(result => result.company_id.startsWith('context_'))
  .map(result => [result.company_id, result.alias, result.state, result.version]);

describe('context history seed for the real agents', () => {
  it('records version 1 of every active agent from its profile and natives, queues it for Git and never repeats it', async () => {
    const root = await natives({
      'ContextAlpha/director/context/mission.md': 'Coordinate the alpha company.',
      'ContextAlpha/director/directives/native-directive.md': 'Answer in Spanish.',
      'ContextAlpha/director/context/profile.json': '{"tenant_id":"ContextAlpha","alias":"director","purpose":"stale disk copy"}',
      'ContextAlpha/director/projects/ignored.md': 'Outside the versioned roots.',
      'ContextAlpha/zz-canary-seed-retired/context/mission.md': 'Retired agents are not seeded.',
    });
    const planned = await seedAgentContextHistory(pool, { natives: nativeContextDirectory(root), dryRun: true });
    expect(states(planned)).toEqual([['context_alpha', 'director', 'planned', 1], ['context_alpha', 'zz-canary-seed-empty', 'empty', 0],
      ['context_beta', 'director', 'planned', 1]]);
    expect(await versions()).toEqual([]);

    const seeded = await seedAgentContextHistory(pool, { natives: nativeContextDirectory(root) });
    expect(states(seeded)).toEqual([['context_alpha', 'director', 'seeded', 1], ['context_alpha', 'zz-canary-seed-empty', 'empty', 0],
      ['context_beta', 'director', 'seeded', 1]]);
    expect(seeded.map(result => result.digest)).toEqual(planned.map(result => result.digest));
    expect(seeded.filter(result => !result.company_id.startsWith('context_')).map(result => result.state)).not.toContain('seeded');
    const recorded = await versions();
    expect(recorded).toEqual([
      { company_id: 'context_alpha', alias: 'director', version: '1', source: 'native', actor_alias: 'director', actor_human_id: null,
        paths: ['context/mission.md', 'context/profile.json', 'directives/native-directive.md'] },
      { company_id: 'context_beta', alias: 'director', version: '1', source: 'profile', actor_alias: 'director', actor_human_id: null,
        paths: ['context/profile.json'] },
    ]);
    const profile = (await pool.query<{ content: string }>(`SELECT file->>'content' AS content FROM agent_context_versions,
      jsonb_array_elements(files) file WHERE company_id='context_alpha' AND file->>'path'='context/profile.json'`)).rows[0];
    expect(profile?.content).not.toContain('stale disk copy');
    expect((await pool.query('SELECT company_id,alias,version,state FROM agent_context_outbox ORDER BY company_id')).rows).toEqual([
      { company_id: 'context_alpha', alias: 'director', version: '1', state: 'pending' },
      { company_id: 'context_beta', alias: 'director', version: '1', state: 'pending' },
    ]);

    const again = await seedAgentContextHistory(pool, { natives: nativeContextDirectory(root) });
    expect(states(again)).toEqual([['context_alpha', 'director', 'existing', 1], ['context_alpha', 'zz-canary-seed-empty', 'empty', 0],
      ['context_beta', 'director', 'existing', 1]]);
    expect(await versions()).toEqual(recorded);

    const remote = join(directory, 'origin.git'); const repository = join(directory, 'broker');
    await git(directory, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await git(directory, ['init', '--quiet', '--initial-branch=main', repository]); await chmod(repository, 0o700);
    await git(repository, ['remote', 'add', 'origin', remote]);
    const broker = new ContextGitBroker(repository);
    let state = 'pending';
    for (let round = 0; round < 4 && state !== 'idle'; round += 1) state = (await processContextOutbox(pool, { git: broker })).state;
    expect(state).toBe('idle');
    expect((await pool.query("SELECT count(*)::integer AS synced FROM agent_context_outbox WHERE state='synced'")).rows).toEqual([{ synced: 2 }]);
    const folders = await git(remote, ['ls-tree', '-r', '--name-only', 'refs/heads/main']);
    for (const company of ['context_alpha', 'context_beta']) {
      const prefix = contextRepositoryPrefix({ company_id: company, tenant_id: company === 'context_alpha' ? 'ContextAlpha' : 'ContextBeta', alias: 'director' });
      expect(folders.split('\n')).toEqual(expect.arrayContaining([`${prefix}/.cauce-version.json`, `${prefix}/context/profile.json`]));
    }
    expect(await git(remote, ['log', '--format=%an', 'refs/heads/main'])).toBe('director\ndirector');
    expect(states(await seedAgentContextHistory(pool, {})).map(state => state[2])).toEqual(['existing', 'empty', 'existing']);
    expect(await versions()).toEqual(recorded);
  });

  it('refuses natives behind links or outside the allowed paths before writing anything', async () => {
    const root = await natives({ 'ContextAlpha/director/context/mission.md': 'Mission.' });
    await symlink('/etc/hostname', join(root, 'ContextAlpha/director/context/linked.md'));
    await expect(seedAgentContextHistory(pool, { natives: nativeContextDirectory(root) })).rejects.toThrow('native context file is not allowed');
    await rm(join(root, 'ContextAlpha/director/context/linked.md'));
    await writeFile(join(root, 'ContextAlpha/director/context/notes.docx'), 'binary');
    await expect(seedAgentContextHistory(pool, { natives: nativeContextDirectory(root) })).rejects.toThrow('native context file is not allowed');
    await rm(join(root, 'ContextAlpha/director/context/notes.docx'));
    await rm(join(root, 'ContextAlpha/director/context'), { recursive: true });
    await symlink(join(directory, 'natives'), join(root, 'ContextAlpha/director/context'));
    await expect(seedAgentContextHistory(pool, { natives: nativeContextDirectory(root) })).rejects.toThrow('not a real directory');
    expect(await versions()).toEqual([]);
  });

  it('runs through cauce platform: simulates without writing and a repeated seed adds no version', async () => {
    if (!current) throw new Error('case database unavailable');
    const environment = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: current.adminUrl };
    const run = async (...args: string[]) => JSON.parse((await execute('bash', [platform, 'contexto', 'sembrar', '--empresa', 'context_beta', ...args],
      { env: environment, encoding: 'utf8', timeout: 60_000 })).stdout) as { simulated: boolean; summary: Record<string, number> };
    expect(await run('--simular')).toMatchObject({ simulated: true, summary: { seeded: 0, planned: 1, existing: 0, empty: 0 } });
    expect(await versions()).toEqual([]);
    expect(await run()).toMatchObject({ simulated: false, summary: { seeded: 1, planned: 0, existing: 0, empty: 0 } });
    const recorded = await versions();
    expect(recorded.map(row => [row.company_id, row.alias, row.version])).toEqual([['context_beta', 'director', '1']]);
    expect(await run()).toMatchObject({ summary: { seeded: 0, existing: 1 } });
    expect(await versions()).toEqual(recorded);
    await expect(execute('bash', [platform, 'contexto', 'sembrar', '--empresa', 'Bad Id'], { env: environment, encoding: 'utf8' }))
      .rejects.toMatchObject({ code: 2 });
  });
});
