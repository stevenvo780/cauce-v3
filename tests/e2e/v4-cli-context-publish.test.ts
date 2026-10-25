import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git, startContextPublishFixture } from './v4-cli-context-publish.helpers.js';

interface SeedResult { readonly simulated: boolean; readonly summary: { seeded: number; planned: number; existing: number } }
interface SyncRow {
  readonly state: string; readonly git_commit: string | null; readonly pushed_at: Date | null;
  readonly last_error: string | null; readonly attempts: number;
}
const companies = [
  { company: 'context_alpha', tenant: 'ContextAlpha', mission: 'Directiva administrativa de la empresa alfa.' },
  { company: 'context_beta', tenant: 'ContextBeta', mission: 'Directiva administrativa independiente de la empresa beta.' },
] as const;
let fixture: Awaited<ReturnType<typeof startContextPublishFixture>> | undefined;
const active = () => { if (!fixture) throw new Error('context publish fixture unavailable'); return fixture; };
const prefix = (company: string, tenant: string) => `companies/${company}/tenants/${tenant}/agents/director`;

async function seed(company: string, simulate = false): Promise<SeedResult> {
  const result = await active().platform(['contexto', 'sembrar', '--empresa', company, '--nativos', active().natives, ...(simulate ? ['--simular'] : [])]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SeedResult;
}

async function sync(company: string): Promise<SyncRow> {
  const result = await active().pool.query<SyncRow>(`SELECT state,git_commit,pushed_at,last_error,attempts
    FROM agent_context_outbox WHERE company_id=$1 AND alias='director' AND version=1`, [company]);
  const row = result.rows[0]; if (!row) throw new Error('context outbox row missing'); return row;
}

async function count(table: 'agent_context_versions' | 'agent_context_outbox', company: string): Promise<number> {
  return (await active().pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table} WHERE company_id=$1`, [company])).rows[0]?.count ?? -1;
}

beforeAll(async () => { fixture = await startContextPublishFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); }, 120_000);

describe.sequential('administrative context seed with real CLI, PostgreSQL, broker and laboratory Git remote', () => {
  it('preserves an offline commit, retries publication, isolates company folders and rejects secrets without duplicate history', async () => {
    const f = active(); const [alpha, beta] = companies;
    for (const company of companies) {
      const directory = join(f.natives, company.tenant, 'director');
      await mkdir(join(directory, 'context'), { recursive: true });
      await mkdir(join(directory, 'directives'));
      await writeFile(join(directory, 'context/mission.md'), company.mission);
      await writeFile(join(directory, 'context/profile.json'), '{"purpose":"stale native profile"}');
      await writeFile(join(directory, 'directives/administrative.md'), `Empresa ${company.company}: contexto administrativo versionable.`);
      await writeFile(join(directory, 'ignored-session'), 'Non-versionable synthetic session outside the allowed roots.');
    }
    expect(await seed(alpha.company, true)).toMatchObject({ simulated: true, summary: { seeded: 0, planned: 1 } });
    expect(await count('agent_context_versions', alpha.company)).toBe(0);
    expect(await count('agent_context_outbox', alpha.company)).toBe(0);
    expect(await git(f.remote, ['for-each-ref', '--format=%(refname)'])).toBe('');

    const token = 'A1'.repeat(20); const secret = `Authorization: Bearer ${token}`; f.secrets.push(token);
    const rejectedFile = join(f.natives, beta.tenant, 'director/context/rejected.md');
    await writeFile(rejectedFile, secret);
    const rejected = await f.platform(['contexto', 'sembrar', '--empresa', beta.company, '--nativos', f.natives]);
    expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('Siembra interrumpida');
    expect(await count('agent_context_versions', beta.company)).toBe(0);
    expect(await count('agent_context_outbox', beta.company)).toBe(0);
    await rm(rejectedFile);
    expect(await seed(alpha.company)).toMatchObject({ simulated: false, summary: { seeded: 1 } });
    await expect.poll(async () => (await sync(alpha.company)).last_error, { timeout: 30_000 }).toBe('context_git_network_failed');
    const failed = await sync(alpha.company);
    expect(failed).toMatchObject({ state: 'error', pushed_at: null, last_error: 'context_git_network_failed' });
    expect(failed.git_commit).toMatch(/^[a-f0-9]{40}$/u);
    const alphaPrefix = prefix(alpha.company, alpha.tenant);
    expect(await git(f.broker, ['show', `${failed.git_commit ?? ''}:${alphaPrefix}/context/mission.md`])).toBe(alpha.mission);
    expect(await seed(alpha.company)).toMatchObject({ summary: { seeded: 0, existing: 1 } });
    expect(await count('agent_context_versions', alpha.company)).toBe(1);
    expect(await count('agent_context_outbox', alpha.company)).toBe(1);
    const pendingResponse = await f.api(`/v3/console/context/agents/${alpha.tenant}/director`);
    expect(pendingResponse.status).toBe(200);
    expect(await pendingResponse.json()).toMatchObject({ version: 1, sync: { state: 'error', git_commit: failed.git_commit, pushed_at: null } });
    await f.receipt('offline-seed', { simulation_rolled_back: true, rejected_secret: true, failed, idempotent: true,
      local_commit: await git(f.broker, ['rev-parse', 'main']) });

    await f.startRemote();
    const retried = await f.api(`/v3/console/context/agents/${alpha.tenant}/director/sync/retry`, 'POST');
    expect(retried.status).toBe(202);
    await expect.poll(async () => (await sync(alpha.company)).state, { timeout: 30_000 }).toBe('synced');
    const recovered = await sync(alpha.company);
    expect(recovered.git_commit).toBe(failed.git_commit); expect(recovered.pushed_at).not.toBeNull();
    expect(recovered.last_error).toBeNull(); expect(recovered.attempts).toBeGreaterThan(failed.attempts);
    expect(await git(f.remote, ['rev-parse', 'main'])).toBe(failed.git_commit);
    expect(await git(f.remote, ['show', `main:${alphaPrefix}/context/mission.md`])).toBe(alpha.mission);
    expect(await git(f.remote, ['rev-list', '--count', 'main'])).toBe('1');

    expect(await seed(beta.company)).toMatchObject({ summary: { seeded: 1 } });
    await expect.poll(async () => (await sync(beta.company)).state, { timeout: 30_000 }).toBe('synced');
    const published = await sync(beta.company); const paths = (await git(f.remote, ['ls-tree', '-r', '--name-only', 'main'])).split('\n');
    for (const company of companies) {
      const path = prefix(company.company, company.tenant);
      expect(paths.filter(value => value.startsWith(`${path}/`))).toEqual([
        `${path}/.cauce-version.json`, `${path}/context/mission.md`, `${path}/context/profile.json`, `${path}/directives/administrative.md`,
      ]);
      expect(await git(f.remote, ['show', `main:${path}/context/mission.md`])).toBe(company.mission);
      const canonical = await git(f.remote, ['show', `main:${path}/context/profile.json`]);
      expect(canonical).toContain('Synthetic director'); expect(canonical).not.toContain('stale native profile');
      const metadata = JSON.parse(await git(f.remote, ['show', `main:${path}/.cauce-version.json`])) as unknown;
      expect(metadata).toMatchObject({ company_id: company.company, tenant_id: company.tenant, alias: 'director', version: 1, source: 'native' });
      const stored = await f.pool.query<{ files: { path: string; content: string }[] }>(
        'SELECT files FROM agent_context_versions WHERE company_id=$1 AND version=1', [company.company]);
      expect(stored.rowCount).toBe(1);
      for (const file of stored.rows[0]?.files ?? []) {
        expect(await git(f.remote, ['show', `main:${path}/${file.path}`])).toBe(file.content);
      }
    }
    expect(paths).toHaveLength(8);
    expect(await git(f.remote, ['rev-list', '--count', 'main'])).toBe('2');
    const betaHash = await git(f.remote, ['rev-parse', 'main']);
    for (const company of companies) {
      expect(await seed(company.company)).toMatchObject({ summary: { seeded: 0, existing: 1 } });
      expect(await count('agent_context_versions', company.company)).toBe(1);
      expect(await count('agent_context_outbox', company.company)).toBe(1);
    }
    expect(await git(f.remote, ['rev-parse', 'main'])).toBe(betaHash);
    expect((await f.api(`/v3/console/context/agents/${beta.tenant}/director`)).status).toBe(404);
    const response = await f.api(`/v3/console/context/agents/${alpha.tenant}/director`);
    expect(await response.json()).toMatchObject({ version: 1, sync: { state: 'synced', git_commit: recovered.git_commit } });
    const history = await git(f.remote, ['log', '--all', '--format=raw', '--patch']); f.assertPrivate(history);
    await f.receipt('published-seed', { recovered, published, paths, commits: 2, remote_commit: betaHash,
      history, separate_company_folders: true, canonical_profiles: true, history_idempotent: true, cross_company_read_denied: true,
      runtime_application: 'not-exercised', github_authentication: 'not-exercised' });
  }, 180_000);
});
