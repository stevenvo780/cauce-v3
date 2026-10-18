import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetEvidence, FleetOperationRequest, FleetStepName, FleetTarget } from '@cauce/protocol';
import { ConfigurationRepository, FleetOperationsRepository, type DatabasePool, type FleetOperationClaim } from '../src/index.js';
import { aggregateHostEvidence } from '../src/repository/fleet-operation-hosts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PURGE_ACTOR_SUBJECT, purgeAuthority, purgeFixture } from './fleet-purge-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database); pool = current.pool; await purgeFixture(pool, current.adminPool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const TARGET: FleetTarget = { resource: 'tenant', tenant_id: 'EquipoSintetico' };

async function seedEquipo(): Promise<{ pendingMessage: string; doneMessage: string }> {
  await pool.query("INSERT INTO tenants(id,display_name,company_id) VALUES('EquipoSintetico','Equipo Sintetico','humanizar')");
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('grp.sintetico','EquipoSintetico')");
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
    ('EquipoSintetico','grp.sintetico','agente_sintetico','agent'),('EquipoSintetico','grp.sintetico','legado_sintetico','agent')`);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,runtime_key,primary_room_id,host_id,runtime_mode,
      container_name,runtime_user,home_directory,state_directory,systemd_user,lifecycle_state)
    VALUES('EquipoSintetico','agente_sintetico','codex',true,'sintetico-key','grp.sintetico','purge-host','container',
      'sintetico-ctr','dev','/home/dev','/home/dev/.cauce','stev','ready')`);
  await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES('EquipoSintetico','legado_sintetico','codex',false)");
  await pool.query("INSERT INTO agent_profiles(tenant_id,alias,purpose) VALUES('EquipoSintetico','agente_sintetico','Equipo sintetico')");
  const insertMessage = async (trace: string): Promise<string> => (await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES(gen_random_uuid(),$1,'EquipoSintetico','grp.sintetico','agente_sintetico','{}','interactive') RETURNING id`, [trace])).rows[0]?.id ?? '';
  const doneMessage = await insertMessage('sintetico-cerrado');
  const pendingMessage = await insertMessage('sintetico-pendiente');
  await pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status) VALUES($1,'EquipoSintetico','agente_sintetico','done')", [doneMessage]);
  await pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status) VALUES($1,'EquipoSintetico','agente_sintetico','pending')", [pendingMessage]);
  await pool.query("INSERT INTO audit_events(tenant_id,actor_alias,action,decision,message_id) VALUES('EquipoSintetico','agente_sintetico','equipo_test','info',$1)", [doneMessage]);
  await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant,enabled) VALUES('EquipoSintetico','Steven',true) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant,enabled) VALUES('Steven','EquipoSintetico',true) ON CONFLICT DO NOTHING");
  const session = (await pool.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]?.id ?? '';
  await pool.query(`INSERT INTO terminal_sessions(id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
      operator_id,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,expires_at,relay_instance_id)
    VALUES($1,$1,digest('sintetico','sha256'),digest('sintetico','sha256'),1,'operador-sintetico','Steven:kant',
      'EquipoSintetico','agente_sintetico','sintetico-ctr','shell',digest('ticket','sha256'),'prueba',now()+interval '1 hour',$2)`, [session, 'a'.repeat(64)]);
  if (!current) throw new Error('test database missing');
  await current.adminPool.query('CREATE TABLE deliveries_bak_replay_20260812 (id uuid, tenant_id text, recipient_tenant text)');
  await current.adminPool.query('CREATE TABLE respaldo_role_brief_20260814 (id int, tenant_id text)');
  await pool.query("INSERT INTO deliveries_bak_replay_20260812(id,tenant_id) VALUES(gen_random_uuid(),'EquipoSintetico')");
  await pool.query("INSERT INTO respaldo_role_brief_20260814(id,tenant_id) VALUES(1,'EquipoSintetico')");
  return { pendingMessage, doneMessage };
}

async function currentRevision(): Promise<number> {
  const snapshot = await new ConfigurationRepository(pool).get('Steven', 'purge_operator', purgeAuthority);
  return typeof snapshot.revision === 'number' ? snapshot.revision : 0;
}

async function runOperation(repo: FleetOperationsRepository, request: FleetOperationRequest): Promise<void> {
  request.expected_revision = await currentRevision();
  await repo.enqueue('Steven', 'purge_operator', request, PURGE_ACTOR_SUBJECT);
  const claim: FleetOperationClaim | null = await repo.claim('equipo-worker', 'purge-host');
  if (!claim) throw new Error('equipo claim missing');
  await repo.prepare(claim);
  const evidence: Partial<Record<FleetStepName, FleetEvidence>> = {
    stop: { stopped_verified: true }, revoke: { revocation_verified: true },
    purge: { stopped_verified: true, revocation_verified: true }, artifacts: { artifact_sha256: 'a'.repeat(64) },
  };
  for (const step of claim.operation.steps) {
    if (step.name === 'fence' || step.name === 'prepare' || step.status === 'succeeded') continue;
    const proof = evidence[step.name];
    if (!proof) throw new Error(`missing equipo evidence for ${step.name}`);
    await repo.startStep(claim, step.name);
    if (claim.request.target.resource === 'agent') { await repo.completeStep(claim, step.name, proof); continue; }
    for (const slice of await repo.hostSlices(claim)) await repo.completeHostStep(claim, step.name, slice.host_id, slice.target_sha256, proof);
    await repo.completeStep(claim, step.name, aggregateHostEvidence(step.name, await repo.hostReceipts(claim, step.name)));
  }
  await repo.settle(claim);
}

describe('retirar y purgar un equipo con historial', () => {
  it('retire ends pending work, revokes ACL and sessions; purge then preserves history and ignores backups', async () => {
    const { pendingMessage, doneMessage } = await seedEquipo();
    const repo = new FleetOperationsRepository(pool, { controllerHost: 'purge-host' });

    const configDeps = await new ConfigurationRepository(pool).getDependencies('Steven', 'purge_operator',
      { resource: 'tenant', action: 'delete', id: 'EquipoSintetico' }, 0, purgeAuthority);
    expect(configDeps.dependencies.map(dependency => dependency.type)).not.toContain('deliveries_bak_replay_20260812');
    expect(configDeps.dependencies.map(dependency => dependency.type)).not.toContain('respaldo_role_brief_20260814');
    expect(configDeps.can_delete).toBe(false);

    const blockedPurge = await repo.preview('Steven', 'purge_operator',
      { kind: 'purge', target: TARGET, parameters: {}, expected_revision: 0, idempotency_key: 'equipo-purge-early' }, PURGE_ACTOR_SUBJECT);
    expect(blockedPurge.can_apply).toBe(false);
    expect(blockedPurge.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'purge.blocked.deliveries', blocking: true })]));
    expect(blockedPurge.dependencies.map(dependency => dependency.type)).not.toContain('purge.preserve.deliveries_bak_replay_20260812');
    expect(blockedPurge.dependencies.map(dependency => dependency.type)).not.toContain('purge.preserve.respaldo_role_brief_20260814');

    await runOperation(repo, { kind: 'retire', target: TARGET, parameters: {}, expected_revision: 0, idempotency_key: 'equipo-retire-1' });
    expect((await pool.query("SELECT enabled,retired_at IS NOT NULL AS retired FROM tenants WHERE id='EquipoSintetico'")).rows[0])
      .toEqual({ enabled: false, retired: true });
    expect((await pool.query<{ status: string }>('SELECT status FROM deliveries WHERE message_id=$1', [pendingMessage])).rows[0]?.status).toBe('dead');
    expect((await pool.query<{ status: string }>('SELECT status FROM deliveries WHERE message_id=$1', [doneMessage])).rows[0]?.status).toBe('done');
    expect((await pool.query<{ revoked: boolean }>("SELECT revoked_at IS NOT NULL AS revoked FROM terminal_sessions WHERE tenant_id='EquipoSintetico'")).rows[0]?.revoked).toBe(true);
    expect((await pool.query("SELECT enabled FROM acl_edges WHERE from_tenant='EquipoSintetico' OR to_tenant='EquipoSintetico' ORDER BY from_tenant")).rows)
      .toEqual([{ enabled: false }, { enabled: false }]);
    expect((await pool.query("SELECT enabled FROM agents WHERE tenant_id='EquipoSintetico' ORDER BY alias")).rows)
      .toEqual([{ enabled: false }, { enabled: false }]);

    const cleanPurge = await repo.preview('Steven', 'purge_operator',
      { kind: 'purge', target: TARGET, parameters: {}, expected_revision: await currentRevision(), idempotency_key: 'equipo-purge-clean' }, PURGE_ACTOR_SUBJECT);
    expect(cleanPurge.can_apply).toBe(true);
    expect(cleanPurge.dependencies.some(dependency => dependency.blocking)).toBe(false);
    expect(cleanPurge.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'purge.preserve.messages', blocking: false })]));

    await runOperation(repo, { kind: 'purge', target: TARGET, parameters: {}, expected_revision: 0, idempotency_key: 'equipo-purge-1' });
    expect((await pool.query<{ purged: boolean }>("SELECT purged_at IS NOT NULL AS purged FROM tenants WHERE id='EquipoSintetico'")).rows[0]?.purged).toBe(true);
    expect((await pool.query<{ purged: boolean }>("SELECT purged_at IS NOT NULL AS purged FROM rooms WHERE tenant_id='EquipoSintetico' AND id='grp.sintetico'")).rows[0]?.purged).toBe(true);
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='EquipoSintetico'")).rowCount).toBe(0);
    expect((await pool.query<{ purged: boolean }>("SELECT purged_at IS NOT NULL AS purged FROM agents WHERE tenant_id='EquipoSintetico' AND alias='agente_sintetico'")).rows[0]?.purged).toBe(true);
    expect((await pool.query("SELECT 1 FROM memberships WHERE tenant_id='EquipoSintetico' AND alias='legado_sintetico'")).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM messages WHERE id=$1', [doneMessage])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM messages WHERE id=$1', [pendingMessage])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM audit_events WHERE message_id=$1', [doneMessage])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM deliveries_bak_replay_20260812 WHERE tenant_id='EquipoSintetico'")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM respaldo_role_brief_20260814 WHERE tenant_id='EquipoSintetico'")).rowCount).toBe(1);
  });
});
