import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, QuotaEnvironmentRepository, type DatabasePool, type FleetOperationClaim,
  type QuotaOperationClaim, type RegisteredCompany } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { HostCapabilityRegistry } from './host-channel.capabilities.js';
import { channelCapabilities, channelCompany, channelCreate, channelHost, channelPacket, channelPost, companySource, type ChannelHost } from './host-channel.fixtures.js';
import type { FleetExecution } from './executor.js';
import { configuredFleetGateway } from './gateway-config.js';

let database:TestDatabase|undefined;let current:EmptyTestDatabase|undefined;let pool:DatabasePool;let admin:DatabasePool;let app:FastifyInstance;
let north:RegisteredCompany;let south:RegisteredCompany;let host:ChannelHost;let other:ChannelHost;
preparePostgresSuite(import.meta.url,async()=>{database=await startTestDatabase();},120_000);
beforeEach(async()=>{
  if (!database) throw new Error('database absent');current=await startTestCaseDatabase(database);pool=current.pool;admin=current.adminPool;
  north=await channelCompany(pool,'north');south=await channelCompany(pool,'south');host=await channelHost(pool,north);other=await channelHost(pool,south);
  app=Fastify();registerHostChannelRoutes(app,pool);
});
afterEach(async()=>{await app.close();await current?.close();current=undefined;});
afterAll(async()=>{if(database){await database.pool.end();await database.container.stop();}});
const fence=(claim:FleetOperationClaim)=>({operation_id:claim.operation.id,claim_token:claim.claim_token,epoch:claim.epoch});
async function quotaClaim():Promise<QuotaOperationClaim> {
  const environments=new QuotaEnvironmentRepository(pool,{approvedHostIds:[host.host_id],providers:['codex']});
  await environments.create(companySource(north),{account_id:'north-account',host_id:host.host_id,label:'Quota host',idempotency_key:'channel-quota'});
  const response=await channelPost(app,host,{resource:'quota_environment',action:'claim'});expect(response.statusCode).toBe(200);
  const claim=response.json<{claim:QuotaOperationClaim}>().claim;expect(claim.worker_id).toBe(`host-${host.host_id}`);return claim;
}
async function fleetClaim():Promise<FleetOperationClaim> {
  const repository=new FleetOperationsRepository(pool);
  await repository.enqueue(north.hub.id,'owner',channelCreate(north,host,'worker'),`console:${north.user.id}`);
  const response=await channelPost(app,host,{resource:'fleet_operation',action:'claim'});expect(response.statusCode).toBe(200);
  return response.json<{claim:FleetOperationClaim}>().claim;
}
describe('signed company host channel',()=>{
  it('registers only a signed closed catalog, keeps it company scoped and expires executor readiness',async()=>{
    const registry=new HostCapabilityRegistry(pool);expect(await registry.read('north')).toEqual([]);
    const capabilities=channelCapabilities();
    expect((await channelPost(app,host,capabilities)).json()).toMatchObject({executor_ready:true,quota_executor_ready:true});
    expect((await channelPost(app,host,capabilities)).statusCode).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='fleet_host.capabilities' AND company_id='north'")).rows).toEqual([{n:1}]);
    expect((await registry.fleet('north')).placements).toMatchObject([{host_id:host.host_id,runtimes:[{provider:'codex',state_root:'/home/dev/.cauce'}]}]);
    expect(await registry.read('south')).toEqual([]);
    expect((await channelPost(app,host,{...capabilities,command:'/bin/sh'})).statusCode).toBe(400);
    expect((await channelPost(app,host,{...capabilities,templates:[{...capabilities.templates[0],state_root:'/home/dev/../root'}]})).statusCode).toBe(400);
    await admin.query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id=$1",[host.host_id]);
    expect(await registry.fleet('north')).toMatchObject({available:false,placements:[]});
  });
  it('commits quota lease, execution and verified receipt through the authenticated identity',async()=>{
    const claim=await quotaClaim();
    expect((await channelPost(app,host,{resource:'quota_environment',action:'renew',claim})).json()).toEqual({renewed:true});
    expect((await channelPost(app,host,{resource:'quota_environment',action:'execution',claim})).json()).toMatchObject({action:'create',environment:{company_id:'north',host_id:host.host_id}});
    expect((await channelPost(app,other,{resource:'quota_environment',action:'execution',claim})).statusCode).toBe(403);
    expect((await channelPost(app,host,{resource:'quota_environment',action:'finish',claim,result:{runtime_verified:true}})).json()).toMatchObject({operation_id:claim.id,status:'done'});
    expect((await pool.query('SELECT status FROM quota_environments WHERE id=$1',[claim.environment_id])).rows).toEqual([{status:'ready'}]);
  });
  it('rolls back nonce consumption with a rejected quota mutation and accepts a corrected signed retry',async()=>{
    const claim=await quotaClaim();const packet=channelPacket(host,{resource:'quota_environment',action:'finish',claim,result:{}});
    expect((await app.inject({method:'POST',url:`/v3/fleet/hosts/${host.host_id}/channel`,payload:packet})).statusCode).toBe(422);
    expect((await pool.query('SELECT nonce FROM fleet_host_request_nonces WHERE host_id=$1 AND nonce=$2',[host.host_id,packet.nonce])).rows).toEqual([]);
    expect((await pool.query('SELECT status FROM quota_environment_operations WHERE id=$1',[claim.id])).rows).toEqual([{status:'running'}]);
    const corrected=channelPacket(host,{resource:'quota_environment',action:'finish',claim,result:{runtime_verified:true}},packet.nonce);
    expect((await app.inject({method:'POST',url:`/v3/fleet/hosts/${host.host_id}/channel`,payload:corrected})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/v3/fleet/hosts/${host.host_id}/channel`,payload:corrected})).statusCode).toBe(409);
  });
  it('accepts an identical terminal receipt with a new nonce without repeating effects and rejects a different receipt or scope',async()=>{
    const claim=await quotaClaim();const payload={resource:'quota_environment',action:'finish',claim,result:{runtime_verified:true}};
    expect((await channelPost(app,host,payload)).statusCode).toBe(200);
    const before=(await pool.query<{version:number}>('SELECT version FROM quota_environments WHERE id=$1',[claim.environment_id])).rows;
    expect((await channelPost(app,host,payload)).json()).toEqual({operation_id:claim.id,status:'done'});
    expect((await pool.query<{version:number}>('SELECT version FROM quota_environments WHERE id=$1',[claim.environment_id])).rows).toEqual(before);
    expect((await channelPost(app,other,payload)).statusCode).toBe(403);
    expect((await channelPost(app,host,{...payload,claim:{...claim,claim_epoch:claim.claim_epoch+1}})).statusCode).toBe(403);
    expect((await channelPost(app,host,{...payload,result:{runtime_verified:true,cli_version:'altered'}})).statusCode).toBe(409);
    expect((await channelPost(app,host,{resource:'quota_environment',action:'fail',claim,code:'STEP_FAILED'})).statusCode).toBe(409);
    expect((await channelPost(app,host,{resource:'quota_environment',action:'execution',claim})).statusCode).toBe(403);
  });
  it('rejects browser cookies, fabricated actions and altered signatures without consuming the legitimate nonce',async()=>{
    const packet=channelPacket(host,{resource:'quota_environment',action:'claim'});const url=`/v3/fleet/hosts/${host.host_id}/channel`;
    expect((await app.inject({method:'POST',url,payload:packet,headers:{cookie:'session=browser'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,payload:{...packet,payload:{...packet.payload,lease_ms:60_000}}})).statusCode).toBe(403);
    expect((await channelPost(app,host,{resource:'fleet_operation',action:'shell',command:'echo forbidden'})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url,payload:packet})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url,payload:packet})).statusCode).toBe(409);
  });
  it('provides a host and company slice with trusted accounts and fences another host and old epoch',async()=>{
    const claim=await fleetClaim();
    expect((await channelPost(app,other,{resource:'fleet_operation',action:'execution',claim:fence(claim)})).statusCode).toBe(403);
    const before=await channelPost(app,host,{resource:'fleet_operation',action:'execution',claim:fence(claim)});expect(before.statusCode).toBe(200);
    const prepared=await channelPost(app,host,{resource:'fleet_operation',action:'prepare',claim:fence(claim)});expect(prepared.statusCode).toBe(200);
    const execution=prepared.json<FleetExecution>();
    expect(execution.trusted_accounts).toMatchObject([{id:'north-account',provider:'codex'}]);
    expect(execution.snapshot).toMatchObject({agents:[{alias:'worker',tenant_id:north.hub.id,host_id:host.host_id,fleet_baseline:false}]});
    expect(JSON.stringify(execution)).not.toMatch(/south-account|credential_ref|South|south-host/u);
    await admin.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[claim.operation.id]);
    const replacement=(await channelPost(app,host,{resource:'fleet_operation',action:'claim'})).json<{claim:FleetOperationClaim}>().claim;
    expect(replacement.epoch).toBe(claim.epoch+1);
    expect((await channelPost(app,host,{resource:'fleet_operation',action:'renew',claim:fence(claim)})).statusCode).toBe(403);
    expect((await channelPost(app,host,{resource:'fleet_operation',action:'renew',claim:fence(replacement)})).json()).toEqual({renewed:true});
  });
  it('claims both companies in parallel and keeps each execution barrier on its own company revision',async()=>{
    const repository=new FleetOperationsRepository(pool);
    await repository.enqueue(north.hub.id,'owner',channelCreate(north,host,'north-worker'),`console:${north.user.id}`);
    await repository.enqueue(south.hub.id,'owner',channelCreate(south,other,'south-worker'),`console:${south.user.id}`);
    const [northClaim,southClaim]=(await Promise.all([host,other].map(async signed=>
      (await channelPost(app,signed,{resource:'fleet_operation',action:'claim'})).json<{claim:FleetOperationClaim|null}>().claim)));
    if (!northClaim||!southClaim) throw new Error('parallel company claims absent');
    expect((await pool.query('SELECT cohort_key FROM fleet_operations ORDER BY cohort_key')).rows)
      .toEqual([{cohort_key:`fleet:north:${host.host_id}`},{cohort_key:`fleet:south:${other.host_id}`}]);
    expect((await channelPost(app,host,{resource:'fleet_operation',action:'prepare',claim:fence(northClaim)})).statusCode).toBe(200);
    await pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES($1,'owner','{"resource":"room"}','{}','south configuration write')`,[south.hub.id]);
    expect((await channelPost(app,host,{resource:'fleet_operation',action:'execution',claim:fence(northClaim)})).statusCode).toBe(200);
    expect((await channelPost(app,other,{resource:'fleet_operation',action:'prepare',claim:fence(southClaim)})).statusCode).toBe(409);
    await pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES($1,'owner','{"resource":"room"}','{}','north configuration write')`,[north.hub.id]);
    expect((await channelPost(app,host,{resource:'fleet_operation',action:'execution',claim:fence(northClaim)})).statusCode).toBe(409);
  });
  it('does not touch another company lease when the signed host claims its own queue',async()=>{
    const claim=await fleetClaim();await admin.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[claim.operation.id]);
    expect((await channelPost(app,other,{resource:'fleet_operation',action:'claim'})).json()).toEqual({claim:null});
    expect((await pool.query('SELECT claim_token::text FROM fleet_operations WHERE id=$1',[claim.operation.id])).rows).toEqual([{claim_token:claim.claim_token}]);
  });
  it('previews and enqueues a new company computer solely from its fresh signed runtime templates',async()=>{
    const gateway=await configuredFleetGateway(pool,{available:false,actions:[],placements:[]},{},
      {hostCapabilityRegistry:new HostCapabilityRegistry(pool)});
    const binding=gateway.fleetOperationsRepository;if (!binding) throw new Error('dynamic binding absent');
    const request=channelCreate(north,host,'fresh-worker');const subject=`console:${north.user.id}`;
    await expect(binding.preview(north.hub.id,'owner',request,subject)).rejects.toMatchObject({code:'forbidden'});
    expect((await channelPost(app,host,channelCapabilities())).statusCode).toBe(200);
    expect(await binding.preview(north.hub.id,'owner',request,subject)).toMatchObject({can_apply:true});
    await expect(binding.preview(south.hub.id,'owner',request,`console:${south.user.id}`)).rejects.toMatchObject({code:'forbidden'});
    if (request.kind!=='create') throw new Error('create fixture absent');
    await expect(binding.preview(north.hub.id,'owner',{...request,parameters:{...request.parameters,
      placement:{...request.parameters.placement,state_directory:'/tmp/arbitrary/fresh-worker'}}},subject)).rejects.toMatchObject({code:'forbidden'});
    expect(await binding.enqueue(north.hub.id,'owner',request,subject)).toMatchObject({status:'queued'});
  });
});
