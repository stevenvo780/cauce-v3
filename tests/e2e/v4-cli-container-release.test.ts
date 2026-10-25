import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseCommand, startContainerReleaseFixture } from './v4-cli-container-release.helpers.js';

let fixture: Awaited<ReturnType<typeof startContainerReleaseFixture>> | undefined;
function active() { if (!fixture) throw new Error('owned container release fixture unavailable'); return fixture; }

beforeAll(async () => { fixture = await startContainerReleaseFixture(); }, 1_500_000);
afterAll(async () => { await fixture?.close(); }, 180_000);

describe.sequential('platform contenedor with the official release runtime and PostgreSQL verify-full', () => {
  it('refuses an unrelated CA before writing native context', async () => {
    const current = active();
    expect((await current.pool.query("SELECT 1 FROM agent_context_versions WHERE company_id='context_beta'")).rowCount).toBe(0);
    const rejected = await current.invoke(true);
    expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('Siembra interrumpida');
    expect((await current.pool.query("SELECT 1 FROM agent_context_versions WHERE company_id='context_beta'")).rowCount).toBe(0);
    expect((await current.pool.query("SELECT 1 FROM agent_context_outbox WHERE company_id='context_beta'")).rowCount).toBe(0);
    await current.receipt('wrong-ca', { rejected: true, versions: 0, outbox: 0, provider_accounts_used: false });
  });

  it('simulates, seeds and rereads one native version from the hardened real Compose one-off idempotently', async () => {
    const current = active();
    const simulated = await current.invoke(false, true);
    expect(simulated.code, simulated.stderr).toBe(0);
    expect(JSON.parse(simulated.stdout) as unknown).toMatchObject({ simulated: true, summary: { planned: 1, seeded: 0 } });
    expect((await current.pool.query("SELECT 1 FROM agent_context_versions WHERE company_id='context_beta'")).rowCount).toBe(0);
    const lock = await current.pool.connect();
    let applying: ReturnType<typeof current.invoke> | undefined;
    let observed: Awaited<ReturnType<typeof current.observeOneoff>>;
    try {
      await lock.query('BEGIN');
      await lock.query("SELECT 1 FROM agents WHERE tenant_id='ContextBeta' AND alias='director' FOR UPDATE");
      applying = current.invoke();
      await expect.poll(async () => { observed = await current.observeOneoff(); return observed !== undefined; }, { timeout: 20_000 }).toBe(true);
      expect(observed).toMatchObject({ image: current.imageId, user: '1000:1000', readonly: true, network: current.network });
      expect(observed?.cap_drop).toContain('ALL');
      expect(observed?.security_opt.some(option => option.startsWith('no-new-privileges'))).toBe(true);
      for (const target of ['/run/cauce/nativos', '/run/secrets/database_url', '/run/secrets/postgres_ca', '/app/ops/cli/context_seed.mjs']) {
        expect(observed?.mounts.find(mount => mount.Destination === target)).toMatchObject({ RW: false });
      }
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    const seeded = await applying; expect(seeded.code, seeded.stderr).toBe(0);
    expect(JSON.parse(seeded.stdout) as unknown).toMatchObject({ simulated: false, summary: { seeded: 1 } });
    const versions = await current.pool.query<{ alias: string; version: number; source: string; files: { path: string; content: string }[] }>(
      "SELECT alias,version::integer,source,files FROM agent_context_versions WHERE company_id='context_beta'");
    expect(versions.rows).toEqual([expect.objectContaining({ alias: 'director', version: 1, source: 'native' })]);
    expect(versions.rows[0]?.files).toEqual(expect.arrayContaining([{ path: 'context/mission.md', content: current.marker }]));
    expect((await current.pool.query("SELECT state FROM agent_context_outbox WHERE company_id='context_beta'")).rows).toEqual([{ state: 'pending' }]);
    const repeated = await current.invoke(); expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout) as unknown).toMatchObject({ summary: { seeded: 0, existing: 1 } });
    expect((await current.pool.query("SELECT 1 FROM agent_context_versions WHERE company_id='context_beta'")).rowCount).toBe(1);
    const logs = await releaseCommand('docker', ['logs', current.postgresId]); expect(logs.code).toBe(0);
    const encrypted = (logs.stdout + logs.stderr).split('\n').filter(line => line.includes('application_name=cauce-context-seed') && line.includes('SSL enabled'));
    expect(encrypted.length).toBeGreaterThanOrEqual(3);
    await current.receipt('context-seed', { simulated_without_effect: true, seeded: 1, native_file_verified: true, outbox: 'pending',
      repeated_without_new_version: true, hardened_oneoff: observed, encrypted_seed_connections: encrypted, git_publication_verified: false });
  });
});
