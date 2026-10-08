import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@cauce/protocol';
import { applyMigrations, createPool, type DatabasePool } from '../src/db.js';
import { applyLegacyFleetAdoption, previewLegacyFleetAdoption } from '../src/fleet-adoption.js';
import { LegacyAdoptionError, type LegacyAdoptionActor, type LegacyAdoptionFacts, type LegacyAdoptionProbe, type LegacyAdoptionTarget } from '../src/fleet-adoption-contracts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
const target = { tenant_id: 'Steven', alias: 'legacy-proof' };
const actor: LegacyAdoptionActor = { tenant_id: 'Steven', alias: 'legacy-operator', subject: 'system:legacy-fleet-installer',
  authorize: async client => { await client.query('SELECT 1'); } };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('047_agent_preferences.sql'); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('legacy-adoption','Steven'),('legacy-other','Steven')");
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
    ('Steven','legacy-adoption','legacy-operator','operator'),('Steven','legacy-adoption','legacy-proof','agent'),
    ('Steven','legacy-adoption','legacy-second','agent')`);
  await pool.query("INSERT INTO agents(tenant_id,alias,harness_id) VALUES('Steven','legacy-proof','codex'),('Steven','legacy-second','codex')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('legacy-account','codex','PRIVATE_EXTERNAL_ID','Steven','env_path','CAUCE_PRIVATE_ACCOUNT_PATH',true)`);
  await applyMigrations(pool);
});
afterEach(async () => { await pool.end(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function facts(scope: LegacyAdoptionTarget = target): LegacyAdoptionFacts {
  return { source: 'measured', target: scope, runtime_key: scope.alias, harness_id: 'codex',
    placement: { host_id: 'legacy-host', mode: 'container', container_name: 'shared-proof', runtime_user: 'dev',
      home_directory: '/home/dev', state_directory: `/home/dev/.cauce/${scope.alias}`, systemd_user: 'stev' },
    primary_account_id: null, account_provider: null, account_binding_approved: false, physical_identity_sha256: 'a'.repeat(64), supervisor_fenced: true };
}
function probe(measure: (scope: LegacyAdoptionTarget) => unknown = facts, loseAt?: number): LegacyAdoptionProbe {
  return { withSupervisorFence: async (_targets, work) => {
    let checks = 0;
    return work({ measure: async scope => measure(scope), assertHeld: async () => {
      checks += 1; if (loseAt !== undefined && checks >= loseAt) throw new Error('PRIVATE_FENCE_DETAIL');
    } });
  } };
}
async function unchanged() {
  expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(0);
  expect((await pool.query("SELECT 1 FROM audit_events WHERE action='fleet.legacy_metadata_adopted'")).rowCount).toBe(0);
  expect((await pool.query<{ host_id: string | null }>("SELECT host_id FROM agents WHERE alias='legacy-proof'")).rows[0]?.host_id).toBeNull();
}
describe('durable legacy metadata adoption with PostgreSQL max1', () => {
  it('previews only missing fields without writes and leaves unknown accounts explicit', async () => {
    const result = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    expect(result).toMatchObject({ revision: 0, can_apply: true, blockers: [], rows: [{ target, patch: { host_id: 'legacy-host', runtime_mode: 'container' } }] });
    expect(result.rows[0]?.patch).not.toHaveProperty('primary_account_id'); expect(result.rows[0]?.patch).not.toHaveProperty('enabled');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_'); await unchanged(); expect(pool.totalCount).toBe(1);
  });
  it('applies under a sustained fence without changing admission, routing, sessions or a live lease', async () => {
    await pool.query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until,capabilities)
      VALUES('Steven','legacy-proof','legacy-instance',1,now()+interval '1 hour','[]')`);
    const before = (await pool.query<Record<string, unknown>>("SELECT to_jsonb(lease) AS lease FROM connection_leases lease WHERE alias='legacy-proof'")).rows[0];
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    expect(await applyLegacyFleetAdoption(pool, actor, preview, probe())).toMatchObject({ applied: true, revision: 1, state: 'configuration_backfilled' });
    const stored = (await pool.query<Record<string, unknown>>("SELECT enabled,lifecycle_state,primary_account_id,host_id,runtime_key,primary_room_id FROM agents WHERE alias='legacy-proof'")).rows[0];
    expect(stored).toEqual({ enabled: false, lifecycle_state: 'draft', primary_account_id: null, host_id: 'legacy-host', runtime_key: 'legacy-proof', primary_room_id: 'legacy-adoption' });
    expect((await pool.query<Record<string, unknown>>("SELECT to_jsonb(lease) AS lease FROM connection_leases lease WHERE alias='legacy-proof'")).rows[0]).toEqual(before);
    const audit = (await pool.query<Record<string, unknown>>("SELECT metadata FROM audit_events WHERE action='fleet.legacy_metadata_adopted'")).rows[0];
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE_|credential|external_account|\/home\/dev/u);
    expect((await pool.query('SELECT 1 FROM fleet_operations')).rowCount).toBe(0);
  });
  it('records only an explicitly approved provider binding', async () => {
    const approved = probe(scope => ({ ...facts(scope), primary_account_id: 'legacy-account', account_provider: 'codex', account_binding_approved: true }));
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], approved);
    expect(preview.rows[0]?.patch.primary_account_id).toBe('legacy-account');
    await applyLegacyFleetAdoption(pool, actor, preview, approved);
    expect((await pool.query<Record<string, unknown>>("SELECT primary_account_id FROM agents WHERE alias='legacy-proof'")).rows[0]).toEqual({ primary_account_id: 'legacy-account' });
    expect((await pool.query('SELECT 1 FROM alias_routing_ceiling')).rowCount).toBe(0);
  });
  it('refuses contradictory provider, disabled account and missing payer consent without changing account routing', async () => {
    const approved = probe(scope => ({ ...facts(scope), primary_account_id: 'legacy-account', account_provider: 'codex', account_binding_approved: true }));
    const mismatched = probe(scope => ({ ...facts(scope), primary_account_id: 'legacy-account', account_provider: 'claude', account_binding_approved: true }));
    expect((await previewLegacyFleetAdoption(pool, actor, [target], mismatched)).blockers).toContainEqual({ target, code: 'account_not_authorized' });
    await pool.query("UPDATE provider_accounts SET enabled=false WHERE id='legacy-account'");
    expect((await previewLegacyFleetAdoption(pool, actor, [target], approved)).blockers).toContainEqual({ target, code: 'account_not_authorized' });
    await pool.query("UPDATE provider_accounts SET enabled=true,payer_tenant_id='Isa',shared_with_pool=false WHERE id='legacy-account'");
    expect((await previewLegacyFleetAdoption(pool, actor, [target], approved)).blockers).toContainEqual({ target, code: 'account_not_authorized' });
    await unchanged();
  });
  it('preserves matching nonnull placement and rejects every contradictory field', async () => {
    await pool.query(`UPDATE agents SET container_name='shared-proof',runtime_user='dev',home_directory='/home/dev',
      state_directory='/home/dev/.cauce/legacy-proof' WHERE alias='legacy-proof'`);
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    expect(preview.can_apply).toBe(true); expect(preview.rows[0]?.patch).not.toHaveProperty('container_name');
    const changed = await previewLegacyFleetAdoption(pool, actor, [target], probe(scope => ({ ...facts(scope), placement: { ...facts(scope).placement, runtime_user: 'other' } })));
    expect(changed.blockers).toContainEqual({ target, code: 'contradictory_field', field: 'runtime_user' });
    await expect(applyLegacyFleetAdoption(pool, actor, changed, probe())).rejects.toBeInstanceOf(LegacyAdoptionError);
  });
  it('rejects stale revision, changed before-values and changed measured physical identity', async () => {
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    await expect(applyLegacyFleetAdoption(pool, actor, preview, probe(scope => ({ ...facts(scope), physical_identity_sha256: 'b'.repeat(64) })))).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE agents SET host_id='unexpected-host' WHERE alias='legacy-proof'");
    await expect(applyLegacyFleetAdoption(pool, actor, preview, probe())).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE agents SET host_id=NULL WHERE alias='legacy-proof'");
    await pool.query("INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary) VALUES('Steven','legacy-operator','{}','{}','Other change')");
    await expect(applyLegacyFleetAdoption(pool, actor, preview, probe())).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects runtime mismatch, ambiguous membership and identities created after the baseline', async () => {
    const mismatch = await previewLegacyFleetAdoption(pool, actor, [target], probe(scope => ({ ...facts(scope), runtime_key: 'other-key' })));
    expect(mismatch.blockers).toContainEqual({ target, code: 'runtime_identity_changed' });
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias) VALUES('Steven','legacy-other','legacy-proof')");
    expect((await previewLegacyFleetAdoption(pool, actor, [target], probe())).blockers).toContainEqual({ target, code: 'membership_ambiguous' });
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias) VALUES('Steven','legacy-adoption','new-agent')");
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,runtime_key,primary_room_id) VALUES('Steven','new-agent','codex','new-agent','legacy-adoption')");
    const created = { tenant_id: 'Steven', alias: 'new-agent' };
    expect((await previewLegacyFleetAdoption(pool, actor, [created], probe())).blockers).toContainEqual({ target: created, code: 'not_legacy_baseline' });
    await unchanged();
  });
  it('reports unmeasured, unfenced and private extra facts without exposing them', async () => {
    for (const measured of [{ ...facts(), source: 'declared' }, { ...facts(), raw_auth: 'PRIVATE_AUTH' },
      { ...facts(), primary_account_id: 'legacy-account' }, { ...facts(), account_binding_approved: true }]) {
      const result = await previewLegacyFleetAdoption(pool, actor, [target], probe(() => measured));
      expect(result.can_apply).toBe(false); expect(result.blockers).toContainEqual({ target, code: 'facts_unavailable' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_AUTH');
    }
    expect((await previewLegacyFleetAdoption(pool, actor, [target], probe(() => ({ ...facts(), supervisor_fenced: false })))).blockers)
      .toContainEqual({ target, code: 'supervisor_not_fenced' }); await unchanged();
  });
  it('blocks active jobs and fleet cohorts with exact reasons', async () => {
    await pool.query("INSERT INTO jobs(tenant_id,lane,kind,payload,status) VALUES('Steven','interactive','system.context.write.quarantine.v1','{\"alias\":\"legacy-proof\"}','running')");
    expect((await previewLegacyFleetAdoption(pool, actor, [target], probe())).blockers).toContainEqual({ target, code: 'active_context_job' });
    await pool.query("UPDATE jobs SET status='done'");
    await pool.query(`INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,idempotency_key,expected_revision)
      VALUES('Steven','legacy-operator','{}','fixture-target','fleet','legacy-host','stop','{}',$1,'adoption-active-cohort',0)`, ['a'.repeat(64)]);
    expect((await previewLegacyFleetAdoption(pool, actor, [target], probe())).blockers).toContainEqual({ target, code: 'active_fleet_cohort' });
    await unchanged();
  });
  it('blocks active deliveries without reclaiming or rewriting them', async () => {
    const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES(gen_random_uuid(),'legacy-adoption-test','Steven','legacy-adoption','legacy-operator','{}','interactive') RETURNING id`)).rows[0];
    await pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status) VALUES($1,'Steven','legacy-proof','started')", [message?.id]);
    expect((await previewLegacyFleetAdoption(pool, actor, [target], probe())).blockers).toContainEqual({ target, code: 'active_delivery' });
    expect((await pool.query<Record<string, unknown>>("SELECT status FROM deliveries WHERE recipient_alias='legacy-proof'")).rows[0]?.status).toBe('started'); await unchanged();
  });
  it('rolls back all patches, revision and audit when the supervisor fence is lost before commit', async () => {
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    await expect(applyLegacyFleetAdoption(pool, actor, preview, probe(facts, 4))).rejects.toMatchObject({ code: 'unavailable', blockers: [{ target, code: 'supervisor_not_fenced' }] });
    await unchanged();
  });
  it('reauthorizes before commit and rolls back revoked authority', async () => {
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], probe()); let authorizations = 0;
    const revoked = { ...actor, authorize: async () => { authorizations += 1; if (authorizations > 1) throw new LegacyAdoptionError('forbidden'); } };
    await expect(applyLegacyFleetAdoption(pool, revoked, preview, probe())).rejects.toMatchObject({ code: 'forbidden' }); await unchanged();
  });
  it('rejects forged patches even with a recomputed public digest and commits a batch atomically', async () => {
    const second = { tenant_id: 'Steven', alias: 'legacy-second' };
    const preview = await previewLegacyFleetAdoption(pool, actor, [target, second], probe());
    const forged = structuredClone(preview); const row = forged.rows[0]; if (!row) throw new Error('fixture row absent'); row.patch.host_id = 'forged-host';
    const { plan_sha256: _hash, ...body } = forged; forged.plan_sha256 = sha256Hex(body);
    await expect(applyLegacyFleetAdoption(pool, actor, forged, probe())).rejects.toMatchObject({ code: 'conflict' }); await unchanged();
    expect(await applyLegacyFleetAdoption(pool, actor, preview, probe())).toMatchObject({ applied: true, revision: 1 });
    expect((await pool.query("SELECT 1 FROM agents WHERE host_id='legacy-host'")).rowCount).toBe(2);
  });
  it('allows only one concurrent application of the same preview using a single-client pool', async () => {
    const preview = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    const results = await Promise.allSettled([applyLegacyFleetAdoption(pool, actor, preview, probe()), applyLegacyFleetAdoption(pool, actor, preview, probe())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(1); expect(pool.totalCount).toBe(1);
  });
  it('keeps a completed metadata backfill idempotent without inventing another revision or admission', async () => {
    const first = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    await applyLegacyFleetAdoption(pool, actor, first, probe());
    const repeated = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    expect(repeated.rows[0]?.patch).toEqual({});
    expect(await applyLegacyFleetAdoption(pool, actor, repeated, probe())).toMatchObject({ applied: false, revision: 1 });
    expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='fleet.legacy_metadata_adopted'")).rowCount).toBe(1);
  });
  it('rejects retired targets and a changed primary room without touching lifecycle', async () => {
    await pool.query("UPDATE agents SET retired_at=clock_timestamp(),lifecycle_state='retired' WHERE alias='legacy-proof'");
    const retired = await previewLegacyFleetAdoption(pool, actor, [target], probe());
    expect(retired.blockers).toContainEqual({ target, code: 'retired_identity' });
    await pool.query("UPDATE agents SET retired_at=NULL,lifecycle_state='draft',primary_room_id=NULL WHERE alias='legacy-proof'");
    expect((await previewLegacyFleetAdoption(pool, actor, [target], probe())).blockers).toContainEqual({ target, code: 'primary_membership_changed' });
    await unchanged();
  });
});
