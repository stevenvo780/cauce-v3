import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentQuotaInvalidatedError, AgentQuotaOperationsRepository, FleetOperationError, FleetOperationsRepository, HostEnrollmentRepository, HostId, QuotaOperationsRepository, StoreError,
  lockFleetRevision, publicFleetOperation, type DatabaseClient, type DatabasePool, type FleetOperationClaim, type FleetOperationRow } from '@cauce/store';
import { AuthError, AuthorizationError } from '../auth.js';
import { replyError } from '../routes/shared.js';
import { HostChannelCommandSchema, type HostAgentQuotaCommand, type HostFleetCommand, type HostQuotaCommand } from './host-channel.contracts.js';
import { hostFleetExecution } from './host-channel.execution.js';
import { recordHostCapabilities } from './host-channel.capabilities.js';
import { readFleetProviderAccounts } from './accounts.js';

const Params = z.object({host_id:HostId}).strict();
interface HostIdentity {host_id:string;company_id:string}
export interface HostChannelOptions { controllerHost?:string; coordinatorEnabled?:boolean; coordinatorHosts?:readonly string[] }
async function fleetClaim(client:DatabaseClient,identity:HostIdentity,
  fence:{operation_id:string;claim_token:string;epoch:number}):Promise<FleetOperationClaim> {
  await lockFleetRevision(client);
  const row=(await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE id=$1 AND executor_host=$2 AND company_id=$3
    AND claim_token=$4 AND epoch=$5 AND worker_id IS NOT NULL FOR UPDATE`,
  [fence.operation_id,identity.host_id,identity.company_id,fence.claim_token,fence.epoch])).rows[0];
  if (!row?.worker_id) throw new StoreError('forbidden','fleet operation is outside the authenticated host scope');
  return {operation:publicFleetOperation(row),request:row.request,worker_id:row.worker_id,claim_token:fence.claim_token,epoch:fence.epoch};
}
async function fleetCommand(repository:FleetOperationsRepository,client:DatabaseClient,identity:HostIdentity,command:HostFleetCommand):Promise<unknown> {
  const fleet=repository.forTransaction(client);
  if (command.action==='claim') {
    const claim=await fleet.claim(`host-${identity.host_id}`,identity.host_id,command.lease_ms,identity.company_id);
    if (claim) await fleetClaim(client,identity,{operation_id:claim.operation.id,claim_token:claim.claim_token,epoch:claim.epoch});
    return {claim};
  }
  const claim=await fleetClaim(client,identity,command.claim);
  switch(command.action) {
    case 'renew':return {renewed:await fleet.renew(claim,command.lease_ms)};
    case 'execution':return hostFleetExecution(client,identity,claim);
    case 'prepare':await fleet.prepare(claim);return hostFleetExecution(client,identity,claim);
    case 'await_auth':return fleet.awaitAuth(claim);
    case 'settle':return fleet.settle(claim);
    case 'host_slices':return (await fleet.hostSlices(claim)).filter(slice=>slice.host_id===identity.host_id);
    case 'host_receipts':return (await fleet.hostReceipts(claim,command.step)).filter(receipt=>receipt.host_id===identity.host_id);
    case 'start_step':return fleet.startStep(claim,command.step);
    case 'complete_step':return fleet.completeStep(claim,command.step,command.evidence);
    case 'complete_host_step':return fleet.completeHostStep(claim,command.step,identity.host_id,command.digest,command.evidence);
    case 'fail':return fleet.fail(claim,command.error);
    case 'compensate':return fleet.compensate(claim,command.evidence);
  }
}
async function quotaCommand(repository:QuotaOperationsRepository,client:DatabaseClient,identity:HostIdentity,command:HostQuotaCommand):Promise<unknown> {
  const quota=repository.forTransaction(client);
  if (command.action==='claim') {
    const claim=await quota.claim(`host-${identity.host_id}`,identity.host_id,command.lease_ms);
    if (claim) await quota.assertHostScopeInTransaction(client,claim,identity);
    return {claim};
  }
  await quota.assertHostScopeInTransaction(client,command.claim,{...identity,allowTerminal:command.action==='finish'||command.action==='fail'});
  switch(command.action) {
    case 'renew':return {renewed:await quota.renew(command.claim,command.lease_ms)};
    case 'execution':return quota.execution(command.claim);
    case 'resume_auth':return {resumed:await quota.resumeAuthentication(command.claim)};
    case 'finish':return quota.finish(command.claim,command.result,command.awaiting_auth);
    case 'fail':await quota.fail(command.claim,command.code,command.detail);return {operation_id:command.claim.id,status:'failed'};
  }
}
export function registerHostChannelRoutes(app:FastifyInstance,pool:DatabasePool,options:HostChannelOptions={}):void {
  const identity=new HostEnrollmentRepository(pool); const fleet=new FleetOperationsRepository(pool,options); const quota=new QuotaOperationsRepository(pool);
  const agentQuota=new AgentQuotaOperationsRepository(pool);
  app.post('/v3/fleet/hosts/:host_id/channel',{bodyLimit:262_144},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie!==undefined) throw new AuthorizationError('host channels cannot use a browser session');
      const {host_id}=Params.parse(request.params);
      const result=await identity.request(host_id,'POST',`/v3/fleet/hosts/${host_id}/channel`,request.body,async(client,verified)=>{
        const packet=request.body as {payload:unknown}; const command=HostChannelCommandSchema.parse(packet.payload);
        if (command.resource==='host') return recordHostCapabilities(client,verified,command);
        if (command.resource==='agent_quota') {
          try { return await agentQuotaCommand(agentQuota,client,verified,command); }
          catch(error) { if (error instanceof AgentQuotaInvalidatedError) return {agent_quota_invalidated:true}; throw error; }
        }
        return command.resource==='fleet_operation'?fleetCommand(fleet,client,verified,command):quotaCommand(quota,client,verified,command);
      });
      if (result && typeof result==='object' && 'agent_quota_invalidated' in result && result.agent_quota_invalidated===true) {
        throw new StoreError('conflict','agent quota execution authority or placement changed');
      }
      return result;
    } catch(error) {
      if (error instanceof z.ZodError) return reply.code(400).send({error:'invalid_request',message:'invalid typed host channel command'});
      if (error instanceof FleetOperationError) return reply.code({forbidden:403,conflict:409,not_found:404,invalid_input:422}[error.code])
        .send({error:error.code,message:error.message});
      if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) {replyError(reply,error);return;}
      return reply.code(503).send({error:'host_channel_unavailable',message:'host operation could not be verified'});
    }
  });
}

async function agentQuotaCommand(repository:AgentQuotaOperationsRepository,client:DatabaseClient,
  identity:HostIdentity,command:HostAgentQuotaCommand):Promise<unknown> {
  const quota=repository.forTransaction(client);
  if (command.action==='claim') {
    const claim=await quota.claim(`host-${identity.host_id}`,identity.host_id,command.lease_ms,identity.company_id);
    if (claim) await quota.assertHostScopeInTransaction(client,claim,identity);
    return {claim};
  }
  await quota.assertHostScopeInTransaction(client,command.claim,{...identity,allowTerminal:command.action==='finish'||command.action==='fail'});
  switch(command.action) {
    case 'renew':return {renewed:await quota.renew(command.claim,command.lease_ms)};
    case 'execution': {
      const execution = await quota.execution(command.claim);
      const trusted_accounts = await readFleetProviderAccounts(client, [execution.agent]);
      return { ...execution, trusted_accounts };
    }
    case 'finish':return quota.finish(command.claim,command.receipt);
    case 'fail':await quota.fail(command.claim,command.code);return {operation_id:command.claim.id,status:'failed'};
  }
}
