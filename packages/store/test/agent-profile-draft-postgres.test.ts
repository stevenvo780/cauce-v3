import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyAgentProfile } from '@cauce/protocol';
import { AgentProfileRepository } from '../src/agent-profile.js';
import type { AgentProfileDraftActor } from '../src/repository/agent-profile-draft.js';
import type { DatabasePool } from '../src/db.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestDatabase, startTestCaseDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let repository: AgentProfileRepository; let actor: AgentProfileDraftActor;
const profile = { ...emptyAgentProfile('Steven', 'draft-target'), purpose: 'Prepared purpose' };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('fixture database absent'); current = await startTestCaseDatabase(database); pool = current.pool;
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES('Steven','draft-owner','codex',true,'ws-draft-owner','dev','/home/dev','/home/dev/.cauce'),
      ('Steven','draft-target','codex',false,'ws-draft-target','dev','/home/dev','/home/dev/.cauce')`);
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('draft-hub','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','draft-hub','draft-owner','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('draft@example.test','draft@example.test',$1,'Draft','operator','Steven','draft-owner') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('fixture human absent');
  await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','draft-owner','operator',ARRAY['read','control'])", [human.id]);
  actor = { tenant_id: 'Steven', alias: 'draft-owner', subject: `console:${human.id}`, reason: 'Preparar el agente antes de iniciarlo',
    humanAuthority: async () => ({ humanId: human.id, tenantId: 'Steven', actorAlias: 'draft-owner' }) };
  repository = new AgentProfileRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('disabled profile drafts on real PostgreSQL', () => {
  it('prepares desired with CAS while preserving disabled state and the absence of runtime ACK', async () => {
    const desired = await repository.prepareDraft(profile, null, actor);
    expect(desired).toMatchObject({ exists: true, revision: 1, applied_revision: null, perfil: profile });
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='draft-target'")).rows[0]?.enabled).toBe(false);
    expect((await pool.query('SELECT 1 FROM agent_profile_runtime_expectations')).rowCount).toBe(0);
    await expect(repository.replace(profile, 1, actor)).rejects.toMatchObject({ code: 'disabled' });
    await expect(repository.markApplied('Steven', 'draft-target', 1, actor)).rejects.toMatchObject({ code: 'disabled' });
  });
  it('preserves the previous applied revision until a later enabled runtime actually acknowledges', async () => {
    await pool.query("UPDATE agents SET enabled=true WHERE alias='draft-target'");
    await repository.replace(profile, null, actor); await repository.markApplied('Steven', 'draft-target', 1, actor);
    await pool.query("UPDATE agents SET enabled=false WHERE alias='draft-target'");
    const desired = await repository.prepareDraft({ ...profile, purpose: 'Second purpose' }, 1, actor);
    expect(desired.revision).toBe(2); expect(desired.applied_revision).toBe(1);
    await expect(repository.prepareDraft({ ...profile, purpose: 'Stale' }, 1, actor)).rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.readWithPresence('Steven', 'draft-target')).perfil.purpose).toBe('Second purpose');
  });
  it('refuses an enabled or retired target and a disabled tenant without profile changes', async () => {
    await pool.query("UPDATE agents SET enabled=true WHERE alias='draft-target'");
    await expect(repository.prepareDraft(profile, null, actor)).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE agents SET enabled=false,retired_at=clock_timestamp() WHERE alias='draft-target'");
    await expect(repository.prepareDraft(profile, null, actor)).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE agents SET retired_at=NULL WHERE alias='draft-target'; UPDATE tenants SET enabled=false WHERE id='Steven'");
    await expect(repository.prepareDraft(profile, null, actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.readWithPresence('Steven', 'draft-target')).exists).toBe(false);
  });
  it('requires the current human cookie, exact actor and effective control membership under the lock', async () => {
    expect(await repository.canPrepareDraft(actor, 'Steven', 'draft-target')).toBe(true);
    await expect(repository.prepareDraft(profile, null, { ...actor, humanAuthority: async () => { throw new Error('PRIVATE_COOKIE'); } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.prepareDraft(profile, null, { ...actor, subject: 'console:00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE actor_alias='draft-owner'");
    expect(await repository.canPrepareDraft(actor, 'Steven', 'draft-target')).toBe(false);
    await expect(repository.prepareDraft(profile, null, actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.readWithPresence('Steven', 'draft-target')).exists).toBe(false);
  });
  it('never allows a draft callback to claim applied or leak the authored body through audit', async () => {
    await repository.prepareDraft({ ...profile, purpose: 'SYNTHETIC_PRIVATE_PROFILE' }, null, actor);
    const audit = (await pool.query<{ action: string; metadata: Record<string, unknown> }>('SELECT action,metadata FROM audit_events ORDER BY id')).rows;
    expect(audit.map(event => event.action)).toEqual(['agent_profile.desired', 'agent_profile.draft']);
    expect(JSON.stringify(audit)).not.toContain('SYNTHETIC_PRIVATE_PROFILE');
    expect(audit[1]?.metadata).toMatchObject({ actor_subject: actor.subject, state: 'prepared_disabled', desired_revision: 1, applied_revision: null });
  });
});
