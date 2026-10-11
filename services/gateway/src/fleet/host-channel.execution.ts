import { FleetOperationError, lockFleetClaim, lockFleetRevision, loadFleetHostScope, preparedState, publicFleetOperation,
  type DatabaseClient, type FleetOperationClaim } from '@cauce/store';
import type { FleetExecution } from './executor.js';
import { readFleetProviderAccounts, scopedFleetProviderAgents } from './accounts.js';
import { trustedFleetBaseline } from './baseline.js';
import { fleetHostInputs, fleetHostPacket } from './coordinator.js';

interface Identity { host_id:string;company_id:string }
interface Agent extends Record<string,unknown> {tenant_id:string;alias:string;host_id:string;runtime_key:string|null}
export async function hostFleetExecution(client:DatabaseClient,identity:Identity,claim:FleetOperationClaim):Promise<FleetExecution> {
  const row=await lockFleetClaim(client,claim,true);
  await lockFleetRevision(client,row.status==='cancelling'?undefined:Number(row.desired_revision??row.expected_revision));
  const prepared=await preparedState(client,row.id);
  const agents=(await client.query<Agent>(`SELECT tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,
    state_directory,runtime_key,primary_room_id,lifecycle_state,host_id,runtime_mode,systemd_user,primary_account_id,model_id,reasoning_effort
    FROM agents WHERE company_id=$1 AND host_id=$2 AND purged_at IS NULL ORDER BY tenant_id,alias FOR SHARE`,
  [identity.company_id,identity.host_id])).rows;
  if (agents.length>1000) throw new FleetOperationError('conflict','host fleet snapshot exceeds its bound');
  const memberships=(await client.query<Record<string,unknown>>(`SELECT member.tenant_id,member.alias,member.room_id,member.role,member.enabled
    FROM memberships member JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
    JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id JOIN tenants tenant ON tenant.id=member.tenant_id
    WHERE agent.company_id=$1 AND agent.host_id=$2 AND agent.purged_at IS NULL AND room.purged_at IS NULL AND tenant.purged_at IS NULL
    ORDER BY member.tenant_id,member.alias,member.room_id`,[identity.company_id,identity.host_id])).rows;
  const purged=(await client.query<{runtime_key:string}>(`SELECT DISTINCT runtime_key FROM agents
    WHERE company_id=$1 AND host_id=$2 AND purged_at IS NOT NULL AND runtime_key IS NOT NULL ORDER BY runtime_key`,
  [identity.company_id,identity.host_id])).rows.map(agent=>agent.runtime_key);
  const companyTenants=new Set((await client.query<{id:string}>('SELECT id FROM tenants WHERE company_id=$1',[identity.company_id])).rows.map(tenant=>tenant.id));
  if (!companyTenants.has(row.target.tenant_id) || prepared.fenced_targets.some(target=>!companyTenants.has(target.tenant_id))
      || prepared.previous_agents.some(agent=>!companyTenants.has(String(agent.tenant_id)))) {
    throw new FleetOperationError('forbidden','prepared fleet scope is outside the authenticated company');
  }
  const roles=(await client.query<{role:string}>('SELECT role FROM role_policies ORDER BY role')).rows;
  const snapshot={agents:await trustedFleetBaseline(client,agents),memberships,rolePolicies:roles,purgedRuntimeKeys:purged};
  const previous=prepared.previous_agents.filter(agent=>agent.host_id===identity.host_id);
  const execution:FleetExecution={operation:publicFleetOperation(row),request:row.request,...prepared,
    previous_agents:await trustedFleetBaseline(client,previous),snapshot};
  if (row.desired_revision===null) {
    const targets=agents.map(agent=>({tenant_id:agent.tenant_id,alias:agent.alias}));
    Object.assign(execution,fleetHostInputs(targets,execution));
    execution.trusted_accounts=await readFleetProviderAccounts(client,scopedFleetProviderAgents(row.request,targets,previous,snapshot.agents));
    return execution;
  }
  const slice=await loadFleetHostScope(client,row,identity.host_id);
  execution.trusted_accounts=await readFleetProviderAccounts(client,scopedFleetProviderAgents(row.request,slice.targets,previous,snapshot.agents));
  const packet=fleetHostPacket(execution,slice,claim);
  if (row.request.kind==='restore' && row.target.resource!=='agent') packet.global_desired_memberships=prepared.desired_memberships;
  return packet;
}
