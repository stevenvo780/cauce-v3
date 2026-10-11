import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { HostEnrollmentRepository, hostEnrollmentMessage, hostRequestMessage, lockCompanyAuthority, registerCompany,
  type CompanyAuthoritySource, type DatabasePool, type RegisteredCompany } from '@cauce/store';
import type { FleetOperationRequest } from '@cauce/protocol';
import type { FastifyInstance } from 'fastify';
import type { HostCapabilities } from './host-channel.capabilities.js';

export interface ChannelHost {host_id:string;company_id:string;keys:ReturnType<typeof generateKeyPairSync>}
export const companySource=(company:RegisteredCompany):CompanyAuthoritySource=>client=>lockCompanyAuthority(client,
  {tenant:company.hub.id,alias:'owner',humanId:company.user.id});
export async function channelCompany(pool:DatabasePool,slug:string):Promise<RegisteredCompany> {
  const company=await registerCompany(pool,{email:`${slug}@example.test`,name:slug,passwordHash:'$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==',company:{slug,name:slug}});
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$1,$2,'env_path','CAUCE_CHANNEL_TEST_PROFILE_PATH',true)`,[`${slug}-account`,company.hub.id]);
  return company;
}
export async function channelHost(pool:DatabasePool,company:RegisteredCompany,id=`${company.company.id}-host`):Promise<ChannelHost> {
  const repository=new HostEnrollmentRepository(pool);const keys=generateKeyPairSync('ed25519');
  const invitation=await repository.invite(companySource(company),{host_id:id,display_name:id});
  await repository.claim(invitation.enrollment_id,{invitation_token:invitation.invitation_token,
    public_key:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),
    proof:sign(null,Buffer.from(hostEnrollmentMessage(invitation)),keys.privateKey).toString('base64')});
  return {host_id:id,company_id:company.company.id,keys};
}
export function channelPacket(host:ChannelHost,payload:Record<string,unknown>,nonce=randomBytes(32).toString('hex')) {
  const packet={host_id:host.host_id,company_id:host.company_id,issued_at:Date.now(),nonce,payload,proof:''};
  packet.proof=sign(null,Buffer.from(hostRequestMessage('POST',`/v3/fleet/hosts/${host.host_id}/channel`,packet)),host.keys.privateKey).toString('base64');
  return packet;
}
export function channelPost(app:FastifyInstance,host:ChannelHost,payload:Record<string,unknown>) {
  return app.inject({method:'POST',url:`/v3/fleet/hosts/${host.host_id}/channel`,payload:channelPacket(host,payload)});
}
export function channelCapabilities():HostCapabilities {
  return {resource:'host',action:'capabilities',schemaVersion:1,executor_version:'channel-test',policy_sha256:'a'.repeat(64),
    fleet_executor:true,quota_executor:true,quota_providers:['codex'],quota_provider_actions:{codex:['create','authenticate','query','update_cli','delete']},templates:[{template_id:'codex-container',provider:'codex',harness_id:'codex',
      runtime_user:'dev',mode:'container',home_directory:'/home/dev',state_root:'/home/dev/.cauce',container_prefix:'cauce-'}]};
}
export function channelCreate(company:RegisteredCompany,host:ChannelHost,alias:string,revision=0):FleetOperationRequest {
  return {kind:'create',target:{resource:'agent',tenant_id:company.hub.id,alias},expected_revision:revision,idempotency_key:`channel-${alias}`,
    parameters:{runtime_key:alias,harness_id:'codex',primary_room_id:'office',primary_account_id:`${company.company.id}-account`,
      memberships:[{room_id:'office',role:'agent'}],placement:{host_id:host.host_id,mode:'container',container_name:`cauce-${alias}`,
        runtime_user:'dev',home_directory:'/home/dev',state_directory:`/home/dev/.cauce/${alias}`}}};
}
