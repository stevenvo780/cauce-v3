import type { FleetEvidence, FleetOperationRequest, FleetStepName, FleetTarget } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool, type FleetOperationClaim } from '../src/index.js';

export async function purgeFixture(pool: DatabasePool): Promise<void> {
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('purge-admin','Steven'),('purge-owned','Steven'),('purge-unused','Steven'),('purge-foreign','Isa')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','purge-admin','purge_operator','operator')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('purge-account','codex','isolated-purge-account','Steven','env_path','CAUCE_TEST_PURGE_PROFILE_PATH',true)`);
  for (const [tenant, room] of [['Steven', 'purge-owned'], ['Isa', 'purge-foreign']] as const) {
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES($1,$2,'purge_agent','agent')`, [tenant, room]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,runtime_key,primary_room_id,host_id,runtime_mode,
      container_name,runtime_user,home_directory,state_directory,primary_account_id,lifecycle_state,retired_at)
      VALUES($1,'purge_agent','codex',false,$2,$3,'purge-host','container',$2,'dev','/home/dev','/home/dev/.cauce',$4,'retired',now())`,
    [tenant, `purge-${tenant.toLowerCase()}`, room, tenant === 'Steven' ? 'purge-account' : null]);
    await pool.query("INSERT INTO agent_profiles(tenant_id,alias,purpose,role_summary) VALUES($1,'purge_agent','Preserve authored history','Owned role')", [tenant]);
    await pool.query(`INSERT INTO egress_destinations(tenant_id,alias,handle,conversation_id,conversation_kind,allow_kinds)
      VALUES($1,'purge_agent','own','123','dm',ARRAY['task_complete'])`, [tenant]);
    await pool.query("UPDATE memberships SET enabled=false,retired_at=now(),retired_enabled=true WHERE tenant_id=$1 AND alias='purge_agent'", [tenant]);
  }
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled,retired_at,retired_enabled)
    VALUES('Steven','purge-unused','purge_agent','agent',false,now(),true)`);
  await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
    VALUES('Steven','purge_agent','purge-account','Steven','Steven')`);
  await pool.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
    VALUES('Steven','purge_agent','purge-account',1,true)`);
  await pool.query(`INSERT INTO agent_appearances(tenant_id,alias,glyph,hue,style,updated_by)
    VALUES('Steven','purge_agent','P',120,'orb','purge_operator')`);
}

export async function messageFixture(pool: DatabasePool, status = 'done'): Promise<string> {
  const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES(gen_random_uuid(),'purge-history','Steven','purge-owned','purge_agent','{"text":"Keep this history"}','interactive') RETURNING id`)).rows[0];
  if (!message) throw new Error('message fixture missing');
  await pool.query(`INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status)
    VALUES($1,'Steven','purge_agent',$2)`, [message.id, status]);
  await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,message_id)
    VALUES('Steven','purge_agent','purge_test','info',$1)`, [message.id]);
  return message.id;
}

export async function profileAdoptionFixture(pool: DatabasePool, message: string): Promise<void> {
  const documents = JSON.stringify([{ name: 'AGENTS.md', path: '/home/dev/AGENTS.md', sha: 'b'.repeat(64) }]);
  await pool.query(`INSERT INTO agent_profile_runtime_expectations(tenant_id,alias,revision,generation,documents)
    VALUES('Steven','purge_agent',1,'purge-generation',$1::jsonb)`, [documents]);
  await pool.query(`INSERT INTO agent_profile_runtime_adoptions(tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch)
    SELECT 'Steven','purge_agent',1,'purge-generation',$1::jsonb,id,1,'purge-instance',1 FROM deliveries WHERE message_id=$2`, [documents, message]);
}

export function purgeRequest(target: FleetTarget = { resource: 'agent', tenant_id: 'Steven', alias: 'purge_agent' }): FleetOperationRequest {
  return { kind: 'purge', target, expected_revision: 0, idempotency_key: 'purge-owned-agent', parameters: {} };
}

export async function preparePurge(pool: DatabasePool, target?: FleetTarget): Promise<{ repo: FleetOperationsRepository; claim: FleetOperationClaim }> {
  const repo = new FleetOperationsRepository(pool, { controllerHost: 'purge-host' });
  await repo.enqueue('Steven', 'purge_operator', purgeRequest(target));
  const claim = await repo.claim('purge-worker', 'purge-host');
  if (!claim) throw new Error('purge claim missing');
  await repo.prepare(claim);
  return { repo, claim };
}

export async function finishPurge(repo: FleetOperationsRepository, claim: FleetOperationClaim): Promise<void> {
  const evidence: [FleetStepName, FleetEvidence][] = [['stop', { stopped_verified: true }], ['revoke', { revocation_verified: true }],
    ['purge', {}], ['artifacts', { artifact_sha256: 'a'.repeat(64) }]];
  for (const [step, proof] of evidence) { await repo.startStep(claim, step); await repo.completeStep(claim, step, proof); }
  await repo.settle(claim);
}
