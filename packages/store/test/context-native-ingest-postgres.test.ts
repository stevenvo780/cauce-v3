import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockCompanyAuthority, type DatabasePool } from '../src/index.js';
import { ContextVersionStore, ingestNativeContextVersion } from '../src/context-version.js';
import type { ContextFile } from '../src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => {
  if (database) { await database.pool.end(); await database.container.stop(); }
});
function target(index = 0) { const value = fixtures[index]; if (!value) throw new Error('fixture absent'); return value; }
function source(index = 0) { const value = target(index); return (client: import('../src/db.js').DatabaseClient) =>
  lockCompanyAuthority(client, { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
const note = (content: string): ContextFile => ({ path: 'context/notes/turn.md', content });
const write = (expected = 0, files: readonly ContextFile[] = [note('Initial note.')], index = 0) =>
  store.write(source(index), target(index).tenant_id, target(index).alias, { expected_version: expected, source: 'ui', files });
const ingest = (base: number, files: readonly ContextFile[], index = 0) =>
  ingestNativeContextVersion(pool, target(index).tenant_id, target(index).alias, { base_version: base, files });
async function count(table: 'agent_context_versions' | 'agent_context_outbox' | 'audit_events', action?: string): Promise<number> {
  const row = (await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}
    WHERE company_id=$1 AND tenant_id=$2 ${table === 'audit_events' ? 'AND action=$3' : ''}`,
  [target().company_id, target().tenant_id, ...(table === 'audit_events' ? [action] : [])])).rows[0];
  if (!row) throw new Error('count unavailable');
  return row.count;
}

describe('native ingest CAS and bounded refusal auditing with real PostgreSQL', () => {
  it('records edits of seeded native OpenClaw files as the agent without changing its governed profile', async () => {
    await pool.query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2", [target().tenant_id, target().alias]);
    const initial = await write(0, [{ path: 'context/MEMORY.md', content: 'Seeded memory.' },
      { path: 'directives/AGENTS.md', content: 'Seeded manual.' }]);
    const files = initial.files.map(file => file.path === 'context/MEMORY.md' ? { ...file, content: 'Current native memory.' } : file);
    expect(await ingest(1, files)).toMatchObject({ state: 'ingested', snapshot: { version: 2, files } });
    const entry = (await pool.query<{ source: string; actor_alias: string; actor_human_id: string | null }>(`SELECT source,actor_alias,actor_human_id FROM agent_context_versions
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=2`, [target().company_id, target().tenant_id, target().alias])).rows[0];
    expect(entry).toEqual({ source: 'native', actor_alias: target().alias, actor_human_id: null });
    expect(await ingest(2, files.map(file => file.path === 'context/profile.json' ? { ...file, content: '{}' } : file)))
      .toMatchObject({ state: 'rejected', error: { reason: 'context_governed_path' } });
    expect(await ingest(2, [...files, { path: 'directives/SOUL.md', content: 'Unseeded authority.' }]))
      .toMatchObject({ state: 'rejected', error: { reason: 'context_governed_path' } });
    const server = await write(2, files.map(file => file.path === 'context/MEMORY.md' ? { ...file, content: 'Server update.' } : file));
    expect(await ingest(2, files)).toMatchObject({ state: 'conflict', desired_version: 3 });
    expect((await store.read(source(), target().tenant_id, target().alias)).files).toEqual(server.files);
  });

  it('does not admit another harness native paths or arbitrary directives', async () => {
    const initial = await write(0, [{ path: 'context/MEMORY.md', content: 'Stored memory.' },
      { path: 'directives/mission.md', content: 'Operator mission.' }]);
    for (const path of ['context/MEMORY.md', 'directives/mission.md']) {
      expect(await ingest(1, initial.files.map(file => file.path === path ? { ...file, content: 'Agent replacement.' } : file)))
        .toMatchObject({ state: 'rejected', error: { reason: 'context_governed_path', paths: [path] } });
    }
    expect(await count('agent_context_versions')).toBe(1);
  });

  it('returns the unchanged current version without duplicating its history, outbox or audit', async () => {
    const initial = await write();
    expect(await ingest(initial.version, [...initial.files].reverse())).toEqual({ state: 'ingested', snapshot: initial });
    expect(await count('agent_context_versions')).toBe(1);
    expect(await count('agent_context_outbox')).toBe(1);
    expect(await count('audit_events', 'context.version')).toBe(1);
  });

  it('serializes identical native writes and recognizes both lost-response and current-base retries', async () => {
    const initial = await write();
    const files = initial.files.map(file => file.path === note('').path ? note('Changed by the agent.') : file);
    const results = await Promise.all([ingest(1, files), ingest(1, files)]);
    expect(results).toMatchObject([{ state: 'ingested', snapshot: { version: 2 } }, { state: 'ingested', snapshot: { version: 2 } }]);
    expect(await ingest(2, files)).toMatchObject({ state: 'ingested', snapshot: { version: 2 } });
    expect(await count('agent_context_versions')).toBe(2);
    expect(await count('agent_context_outbox')).toBe(2);
    expect(await count('audit_events', 'context.version')).toBe(2);
  });

  it('checks the stale base before a governed profile candidate can change any profile byte', async () => {
    const initial = await write();
    await write(1, initial.files.map(file => file.path === note('').path ? note('Server advance.') : file));
    const before = (await pool.query('SELECT * FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
      [target().tenant_id, target().alias])).rows;
    const files = initial.files.map(file => file.path === 'context/profile.json'
      ? { ...file, content: JSON.stringify({ tenant_id: target().tenant_id, alias: target().alias, purpose: 'Untrusted replacement' }) } : file);
    expect(await ingest(1, files)).toMatchObject({ state: 'conflict', base_version: 1, desired_version: 2,
      digest_exists_in_history: false });
    expect((await pool.query('SELECT * FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
      [target().tenant_id, target().alias])).rows).toEqual(before);
    expect(await count('agent_context_versions')).toBe(2);
  });

  it('reports historical digests only within the target company, tenant and alias', async () => {
    const initial = await write();
    const second = await write(1, initial.files.map(file => file.path === note('').path ? note('Previous server note.') : file));
    const latest = await write(2, second.files.map(file => file.path === note('').path ? note('Current server note.') : file));
    expect(await ingest(1, second.files)).toMatchObject({ state: 'conflict', desired_version: 3, digest_exists_in_history: true });
    expect(await ingest(1, latest.files)).toMatchObject({ state: 'conflict', desired_version: 3, digest_exists_in_history: true });
    const foreign = await write(0, [note('Only in another company.')], 1);
    expect(await ingest(1, foreign.files)).toMatchObject({ state: 'conflict', desired_version: 3, digest_exists_in_history: false });
    const sibling = await store.write(source(), target().tenant_id, 'owner',
      { expected_version: 0, source: 'ui', files: [note('Only in another alias.')] });
    expect(await ingest(1, sibling.files)).toMatchObject({ state: 'conflict', desired_version: 3, digest_exists_in_history: false });
    expect(await count('agent_context_versions')).toBe(4);
  });

  it('coalesces simultaneous retries of the same conflict and records a changed candidate separately', async () => {
    const initial = await write();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => ingest(0, initial.files)));
    expect(outcomes.every(outcome => outcome.state === 'conflict')).toBe(true);
    expect(await count('audit_events', 'context.native_conflict')).toBe(1);
    expect(await ingest(0, [note('Another candidate.')])).toMatchObject({ state: 'conflict' });
    expect(await count('audit_events', 'context.native_conflict')).toBe(2);
    expect((await store.read(source(), target().tenant_id, target().alias)).application.last_error).toBe('native_context_conflict');
  });

  it('does not duplicate a conflict when application advances, but audits a new desired version', async () => {
    const initial = await write();
    expect(await ingest(0, initial.files)).toMatchObject({ state: 'conflict', applied_version: 0 });
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query(`UPDATE agent_context_state SET applied_version=desired_version WHERE company_id=$1 AND tenant_id=$2 AND alias=$3`,
      [target().company_id, target().tenant_id, target().alias]);
    expect(await ingest(0, initial.files)).toMatchObject({ state: 'conflict', applied_version: 1 });
    expect(await count('audit_events', 'context.native_conflict')).toBe(1);
    await write(1, initial.files.map(file => file.path === note('').path ? note('Server advance.') : file));
    expect(await ingest(0, initial.files)).toMatchObject({ state: 'conflict', desired_version: 2 });
    expect(await count('audit_events', 'context.native_conflict')).toBe(2);
  });

  it('bounds distinct refusal events per principal without sharing the allowance with other aliases or companies', async () => {
    await write(); await write(0, [note('Other company.')], 1);
    for (let index = 0; index < 24; index++) expect(await ingest(0, [note(`Candidate ${String(index)}`)]))
      .toMatchObject({ state: 'conflict' });
    expect(await count('audit_events', 'context.native_conflict')).toBe(20);
    expect(await ingest(0, [note('Independent allowance.')], 1)).toMatchObject({ state: 'conflict' });
    expect(await ingestNativeContextVersion(pool, target().tenant_id, 'owner', { base_version: 1, files: [note('Other alias.')] }))
      .toMatchObject({ state: 'conflict' });
    const events = (await pool.query<{ tenant_id: string; actor_alias: string; count: number }>(`SELECT tenant_id,actor_alias,count(*)::int AS count
      FROM audit_events WHERE action='context.native_conflict' GROUP BY tenant_id,actor_alias ORDER BY tenant_id,actor_alias`)).rows;
    expect(events).toEqual([{ tenant_id: target().tenant_id, actor_alias: target().alias, count: 20 },
      { tenant_id: target().tenant_id, actor_alias: 'owner', count: 1 },
      { tenant_id: target(1).tenant_id, actor_alias: target(1).alias, count: 1 }]);
  });

  it('shares one refusal audit allowance across governed rejections and stale-base conflicts', async () => {
    const initial = await write();
    const governed = initial.files.map(file => file.path === 'context/profile.json' ? { ...file, content: '{}' } : file);
    expect(await ingest(1, governed)).toMatchObject({ state: 'rejected', error: { reason: 'context_governed_path' } });
    for (let index = 0; index < 20; index++) expect(await ingest(0, [note(`Candidate ${String(index)}`)]))
      .toMatchObject({ state: 'conflict' });
    expect(await count('audit_events', 'context.native_rejected')).toBe(1);
    expect(await count('audit_events', 'context.native_conflict')).toBe(19);
    expect(await count('agent_context_versions')).toBe(1);
  });

  it('does not consume the current audit allowance with refusal events from an expired window', async () => {
    await write();
    await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata,created_at)
      SELECT $1,$2,'context.native_conflict','deny',$3,'{}'::jsonb,clock_timestamp()-interval '61 seconds' FROM generate_series(1,20)`,
    [target().tenant_id, target().alias, target().company_id]);
    expect(await ingest(0, [note('Fresh candidate.')])).toMatchObject({ state: 'conflict' });
    expect(await count('audit_events', 'context.native_conflict')).toBe(21);
  });
});
