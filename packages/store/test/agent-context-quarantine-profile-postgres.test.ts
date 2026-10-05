import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyAgentProfile } from '@cauce/protocol';
import { AgentProfileRepository, CauceRepository, type DatabasePool, type ReserveContextWriteInput } from '../src/index.js';
import { withTransaction } from '../src/db.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase;
let pool: DatabasePool;
let profiles: AgentProfileRepository;
let repository: CauceRepository;
let started = false;
const actor = { tenant_id: 'Steven', alias: 'argos' };
const profile = { ...emptyAgentProfile('Steven', 'argos'), role_summary: 'Desired runtime role' };
function reservation(overrides: Partial<ReserveContextWriteInput> = {}): ReserveContextWriteInput {
  return { operationId: randomUUID(), token: randomUUID(), generation: randomUUID(), tenantId: 'Steven', alias: 'argos',
    writer: { runtimeGeneration: 'runtime-a', containerId: 'container-a', writerInstanceId: randomUUID() },
    expectedRevision: null, expectedExpectation: null,
    documents: [{ name: 'CLAUDE.md', path: '/home/dev/.claude/CLAUDE.md', beforeSha: null, targetSha: 'a'.repeat(64) }],
    updateDesired: async (client) => { await profiles.replaceInTransaction(client, profile, null, actor); }, ...overrides };
}
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase(); pool = database.pool; started = true;
  profiles = new AgentProfileRepository(pool); repository = new CauceRepository(pool);
  console.info('owned-quarantine-profile-postgres', database.container.getId());
}, 120_000);
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/tmp/argos')`);
});
afterAll(async () => {
  if (!started) return;
  const results = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = results.filter((item) => item.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned profile Postgres cleanup failed');
  console.info('owned-quarantine-profile-postgres-stopped', database.container.getId());
});
describe('profile replacement inside durable context reservation', () => {
  it('creates the first profile and its audit together with a single winning reservation', async () => {
    const results = await Promise.allSettled([repository.reserveContextWrite(reservation()), repository.reserveContextWrite(reservation())]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const winner = results.find((item) => item.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('missing reservation');
    expect(winner.value.before.revision).toBeNull(); expect(winner.value.after.revision).toBe(1);
    expect((await profiles.readWithPresence('Steven', 'argos')).perfil).toEqual(profile);
    const audit = await pool.query<{ metadata: unknown }>(`SELECT metadata FROM audit_events WHERE action='agent_profile.desired'`);
    expect(audit.rows).toHaveLength(1); expect(audit.rows[0]?.metadata).toMatchObject({ desired_revision: 1, expected_revision: null });
  });
  it.each(['repository', 'caller transaction'] as const)('fences %s replacement before any desired or journal mutation', async (entry) => {
    await profiles.replace(profile, null, actor);
    const { updateDesired, ...input } = reservation({ expectedRevision: 1 });
    void updateDesired;
    await repository.reserveContextWrite(input);
    const snapshot = async () => ({
      profile: (await pool.query('SELECT to_jsonb(profile) AS value FROM agent_profiles profile')).rows,
      revisions: (await pool.query('SELECT to_jsonb(revision) AS value FROM agent_profile_revisions revision ORDER BY id')).rows,
      audit: (await pool.query('SELECT to_jsonb(event) AS value FROM audit_events event ORDER BY id')).rows,
      jobs: (await pool.query('SELECT to_jsonb(job) AS value FROM jobs job ORDER BY id')).rows,
    });
    const before = await snapshot();
    const changed = { ...profile, role_summary: 'Must not replace quarantined desired context' };
    const replacement = entry === 'repository'
      ? profiles.replace(changed, 1, actor)
      : withTransaction(pool, (client) => profiles.replaceInTransaction(client, changed, 1, actor));
    await expect(replacement).rejects.toThrow('context write quarantine fences admission');
    expect(await snapshot()).toEqual(before);
  });
  it('rolls profile, revision journal and audit back when reservation insertion fails', async () => {
    const request = reservation();
    const previousJournal = (await pool.query('SELECT id FROM agent_profile_revisions ORDER BY id')).rows;
    await pool.query(`INSERT INTO jobs(id,tenant_id,kind,lane,status,payload) VALUES($1,'Steven','other','interactive','done','{}')`, [request.operationId]);
    await expect(repository.reserveContextWrite(request)).rejects.toThrow();
    expect((await profiles.readWithPresence('Steven', 'argos')).exists).toBe(false);
    expect((await pool.query('SELECT id FROM agent_profile_revisions ORDER BY id')).rows).toEqual(previousJournal);
    expect((await pool.query("SELECT id FROM audit_events WHERE action='agent_profile.desired'")).rows).toHaveLength(0);
  });
  it('uses the caller transaction without nested BEGIN or autonomous audit persistence', async () => {
    await expect(withTransaction(pool, async (client) => {
      await profiles.replaceInTransaction(client, profile, null, actor);
      expect((await client.query('SELECT alias FROM agent_profiles')).rows).toHaveLength(1);
      expect((await pool.query('SELECT alias FROM agent_profiles')).rows).toHaveLength(0);
      throw new Error('caller rollback');
    })).rejects.toThrow('caller rollback');
    expect((await profiles.readWithPresence('Steven', 'argos')).exists).toBe(false);
  });
  it('preserves revision CAS and source receipt replay in the same transaction', async () => {
    await profiles.replace(profile, null, actor);
    const latest = await pool.query<{ id: string }>('SELECT id::text FROM agent_profile_revisions ORDER BY id DESC LIMIT 1');
    const source = { source_kind: 'git_authored' as const, application_id: 'b'.repeat(64), expected_journal_id: latest.rows[0]?.id ?? '',
      instance_id: 'fixture', commit: 'c'.repeat(40), tree: 'd'.repeat(40), profile_sha256: 'e'.repeat(64), operator_id: 'fixture-operator' };
    await withTransaction(pool, async (client) => {
      const next = await profiles.replaceInTransaction(client, { ...profile, role_summary: 'Updated role' }, 1, actor, source);
      expect(next.revision).toBe(2);
      const replay = await profiles.replaceInTransaction(client, profile, 1, actor, source);
      expect(replay.revision).toBe(2); expect(replay.source_receipt).toEqual({ application_id: source.application_id, revision: 2 });
      await expect(profiles.replaceInTransaction(client, profile, 1, actor)).rejects.toThrow('revision changed');
    });
    expect((await pool.query("SELECT id FROM audit_events WHERE action='agent_profile.desired'")).rows).toHaveLength(2);
  });
  it('keeps invalid source and expected revision rejected before mutation', async () => {
    await expect(withTransaction(pool, (client) => profiles.replaceInTransaction(client, profile, 0, actor))).rejects.toThrow('expected profile revision');
    await expect(profiles.replace(profile, null, actor, { source_kind: 'git_authored', application_id: '', expected_journal_id: '', instance_id: '', commit: '', tree: '', profile_sha256: '', operator_id: '' })).rejects.toThrow('source guard');
    expect((await profiles.readWithPresence('Steven', 'argos')).exists).toBe(false);
  });
});
