import Fastify,{type FastifyInstance} from 'fastify';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll,afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ConfigurationRepository,FleetOperationsRepository,type DatabasePool,type FleetOperationClaim} from '@cauce/store';
import {preparePostgresSuite} from '../../../../packages/store/test/postgres-suite.js';
import {startTestCaseDatabase,startTestDatabase,type EmptyTestDatabase,type TestDatabase} from '../../../../tests/helpers/postgres.js';
import {registerHostChannelRoutes} from './host-channel.routes.js';
import {channelCapabilities,channelCompany,channelHost,channelPacket,companySource} from './host-channel.fixtures.js';
import {HostChannelFleetSource,SignedHostChannel} from './signed-source.js';
import {FleetExecutor} from './executor.js';
import {performHostCommand} from './host-command.js';

let database:TestDatabase|undefined;let current:EmptyTestDatabase|undefined;let pool:DatabasePool;let app:FastifyInstance;
let directory:string;let runtime:ChildProcess|undefined;
preparePostgresSuite(import.meta.url,async()=>{database=await startTestDatabase();},120_000);
beforeEach(async()=>{
  if(!database)throw new Error('test database absent');current=await startTestCaseDatabase(database);pool=current.pool;
  directory=await mkdtemp('/var/tmp/cauce-signed-executor-');app=Fastify();registerHostChannelRoutes(app,pool);
});
afterEach(async()=>{
  if(runtime?.exitCode===null&&runtime.signalCode===null){const exited=once(runtime,'exit');runtime.kill('SIGKILL');await exited;}
  runtime=undefined;await app.close();await current?.close();current=undefined;await rm(directory,{recursive:true,force:true});
});
afterAll(async()=>{if(database){await database.pool.end();await database.container.stop();}});
async function signedStopFixture(slug:string) {
  const company=await channelCompany(pool,slug);const host=await channelHost(pool,company);
  const gateway=await app.listen({host:'127.0.0.1',port:0});
  const identity=(await pool.query<{enrollment_id:string;key_fingerprint:string}>(
    'SELECT enrollment_id,key_fingerprint FROM fleet_host_identities WHERE host_id=$1',[host.host_id])).rows[0];
  if(!identity)throw new Error('enrolled identity absent');
  await writeFile(join(directory,'identity.json'),JSON.stringify({...identity,host_id:host.host_id,company_id:host.company_id,
    gateway,state:'enrolled',executor_ready:false}),{mode:0o600});
  await writeFile(join(directory,'private.pem'),host.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const channel=await SignedHostChannel.load(directory);
  expect(await channel.request('POST',`/v3/fleet/hosts/${host.host_id}/channel`,channelCapabilities())).toMatchObject({executor_ready:true});
  for(const [alias,key] of [['resume_target','resume-target'],['other_agent','other-agent']] as const) {
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')",[company.hub.id,alias]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,runtime_key,harness_id,host_id,runtime_mode,container_name,runtime_user,
      home_directory,state_directory,systemd_user,primary_room_id,primary_account_id,enabled,lifecycle_state)
      VALUES($1,$2,$3,$4,'codex',$5,'native',$4,'dev','/home/dev',$6,'stev','office',$7,true,'ready')`,
    [company.hub.id,alias,company.company.id,key,host.host_id,`/home/dev/.cauce/${key}`,`${slug}-account`]);
  }
  const repository=new FleetOperationsRepository(pool);const source=new HostChannelFleetSource(channel);const subject=`console:${company.user.id}`;
  return {company,host,gateway,repository,source,subject,
    enqueue:(alias:string,revision:number)=>repository.enqueue(company.hub.id,'owner',{kind:'stop',
      target:{resource:'agent',tenant_id:company.hub.id,alias},parameters:{},expected_revision:revision,
      idempotency_key:`signed-${slug}-${alias}`},subject)};
}
type StopFixture=Awaited<ReturnType<typeof signedStopFixture>>;
async function stopClaim(fixture:StopFixture,id:string):Promise<FleetOperationClaim> {
  const claim=await fixture.source.claim('signed-stop-worker',fixture.host.host_id);
  if(!claim)throw new Error('signed stop claim absent');
  expect(claim.operation.id).toBe(id);return claim;
}
async function failedStop(fixture:StopFixture) {
  const operation=await fixture.enqueue('resume_target',0);const claim=await stopClaim(fixture,operation.id);
  const prepared=await fixture.source.prepare(claim);
  await fixture.source.startStep(claim,'stop');
  const failed=await fixture.source.fail(claim,{code:'STEP_FAILED',step:'stop',retryable:true});
  expect(failed).toMatchObject({id:operation.id,status:'failed',desired_revision:prepared.operation.desired_revision});
  expect(failed.steps.find(step=>step.name==='fence')?.status).toBe('succeeded');
  expect(failed.steps.find(step=>step.name==='stop')?.status).toBe('failed');
  return failed;
}
async function completeStopWithTestEvidence(fixture:StopFixture,claim:FleetOperationClaim) {
  for(const [step,evidence] of [['stop',{stopped_verified:true}],['artifacts',{artifact_sha256:'a'.repeat(64)}]] as const) {
    await fixture.source.startStep(claim,step);await fixture.source.completeStep(claim,step,evidence);
  }
  return fixture.source.settle(claim);
}
async function signedExecutionResponse(fixture:StopFixture,claim:FleetOperationClaim) {
  return fetch(`${fixture.gateway}/v3/fleet/hosts/${fixture.host.host_id}/channel`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(channelPacket(fixture.host,{resource:'fleet_operation',action:'execution',
      claim:{operation_id:claim.operation.id,claim_token:claim.claim_token,epoch:claim.epoch}}))});
}
describe('outbound signed fleet executor through real HTTP and a closed local subprocess',()=>{
  it('stops an isolated live process and commits its artifact and durable lifecycle exactly once',async()=>{
    const company=await channelCompany(pool,'executor');const host=await channelHost(pool,company);
    const gateway=await app.listen({host:'127.0.0.1',port:0});
    const identity=(await pool.query<{enrollment_id:string;key_fingerprint:string}>('SELECT enrollment_id,key_fingerprint FROM fleet_host_identities WHERE host_id=$1',[host.host_id])).rows[0];
    if(!identity)throw new Error('enrolled identity absent');
    await writeFile(join(directory,'identity.json'),JSON.stringify({...identity,host_id:host.host_id,company_id:host.company_id,gateway,state:'enrolled',executor_ready:false}),{mode:0o600});
    await writeFile(join(directory,'private.pem'),host.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const channel=await SignedHostChannel.load(directory);
    const receipt=await channel.request('POST',`/v3/fleet/hosts/${host.host_id}/channel`,channelCapabilities());
    expect(receipt).toMatchObject({executor_ready:true});
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office','process_agent','agent')",[company.hub.id]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,runtime_key,harness_id,host_id,runtime_mode,container_name,runtime_user,
      home_directory,state_directory,systemd_user,primary_room_id,primary_account_id,enabled,lifecycle_state)
      VALUES($1,'process_agent','executor','process-agent','codex',$2,'native','process-agent','dev','/home/dev','/home/dev/.cauce/process-agent','stev','office','executor-account',true,'ready')`,
    [company.hub.id,host.host_id]);
    runtime=spawn(process.execPath,['--eval','setInterval(() => {}, 1000)'],{stdio:'ignore'});await once(runtime,'spawn');
    const exited=once(runtime,'exit');if(!runtime.pid)throw new Error('isolated process did not start');
    const policy=join(directory,'policy.json');const executable=join(directory,'executor.py');const artifact=join(directory,'artifact.json');
    await writeFile(policy,JSON.stringify({pid:runtime.pid,host_id:host.host_id,artifact,log:join(directory,'effects.jsonl')}),{mode:0o600});
    await writeFile(executable,`import hashlib,json,os,signal,sys,time
p=json.load(open(sys.argv[2]));x=json.load(sys.stdin);step=sys.argv[-1]
assert x['fleet_scope']['host_id']==p['host_id']
assert all(a['host_id']==p['host_id'] for a in x['snapshot']['agents'])
assert step in ('stop','artifacts')
if step=='stop':
 os.kill(p['pid'],signal.SIGTERM)
 for i in range(100):
  try: os.kill(p['pid'],0)
  except ProcessLookupError: break
  time.sleep(.01)
 else: raise RuntimeError('isolated process did not stop')
 evidence={'stopped_verified':True}
else:
 body=json.dumps(x['snapshot'],sort_keys=True).encode();open(p['artifact'],'wb').write(body)
 evidence={'artifact_sha256':hashlib.sha256(body).hexdigest()}
with open(p['log'],'a') as log:log.write(json.dumps({'step':step,'operation_id':x['operation_id']})+'\\n')
print(json.dumps({'evidence':evidence}))
`,{mode:0o600});
    const repository=new FleetOperationsRepository(pool);
    const operation=await repository.enqueue(company.hub.id,'owner',{kind:'stop',target:{resource:'agent',tenant_id:company.hub.id,alias:'process_agent'},
      expected_revision:0,idempotency_key:'signed-process-stop',parameters:{}},`console:${company.user.id}`);
    const source=new HostChannelFleetSource(channel);
    const executor=new FleetExecutor(source,{host:host.host_id,worker:'isolated-worker',perform:(step,execution,signal)=>
      performHostCommand({python:'/usr/bin/python3',executable,policyFile:policy,timeoutMs:5000},step,execution,signal)});
    expect(await executor.runOnce()).toBe(true);
    expect((await repository.get(company.hub.id,'owner',operation.id,`console:${company.user.id}`)).status).toBe('succeeded');
    await exited;expect(runtime.signalCode).toBe('SIGTERM');
    expect((await pool.query('SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2',[company.hub.id,'process_agent'])).rows)
      .toEqual([{enabled:false,lifecycle_state:'draft'}]);
    expect(JSON.parse(await readFile(artifact,'utf8')) as unknown).toMatchObject({agents:[{alias:'process_agent',enabled:false}]});
    expect(await executor.runOnce()).toBe(false);
    expect((await readFile(join(directory,'effects.jsonl'),'utf8')).trim().split('\n').map(row=>(JSON.parse(row) as {step:string}).step)).toEqual(['stop','artifacts']);
  });
  it('resumes the same prepared failed stop after another agent advances the company revision',async()=>{
    const fixture=await signedStopFixture('stop-resume');const failed=await failedStop(fixture);
    if(failed.desired_revision===null)throw new Error('failed stop was not prepared');
    const unrelated=await fixture.enqueue('other_agent',failed.desired_revision);
    const otherClaim=await stopClaim(fixture,unrelated.id);await fixture.source.prepare(otherClaim);
    const otherSettled=await completeStopWithTestEvidence(fixture,otherClaim);
    expect(otherSettled.status).toBe('succeeded');expect(otherSettled.desired_revision).toBeGreaterThan(failed.desired_revision);
    const resumed=await fixture.repository.resume(fixture.company.hub.id,'owner',failed.id,failed.version,fixture.subject);
    expect(resumed).toMatchObject({id:failed.id,status:'queued',request_sha256:failed.request_sha256,
      expected_revision:failed.expected_revision,desired_revision:failed.desired_revision});
    expect(resumed.version).toBeGreaterThan(failed.version);
    const resumedClaim=await stopClaim(fixture,resumed.id);
    const response=await signedExecutionResponse(fixture,resumedClaim);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({operation:{id:failed.id,status:'running'},
      request:{kind:'stop',expected_revision:failed.expected_revision}});
    expect((await fixture.source.execution(resumedClaim)).operation).toMatchObject({id:failed.id,request_sha256:failed.request_sha256});
    await fixture.source.prepare(resumedClaim);
    const settled=await completeStopWithTestEvidence(fixture,resumedClaim);
    expect(settled).toMatchObject({id:failed.id,status:'succeeded',request_sha256:failed.request_sha256,expected_revision:failed.expected_revision});
    expect((await pool.query('SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2',
      [fixture.company.hub.id,'resume_target'])).rows).toEqual([{enabled:false,lifecycle_state:'draft'}]);
  });
  it.each(['before resume','after resume'] as const)('rejects a changed sealed target %s without authorizing host execution',async phase=>{
    const fixture=await signedStopFixture('stop-slice');const failed=await failedStop(fixture);
    if(failed.desired_revision===null)throw new Error('failed stop was not prepared');
    const resumed=phase==='after resume'
      ?await fixture.repository.resume(fixture.company.hub.id,'owner',failed.id,failed.version,fixture.subject):undefined;
    await new ConfigurationRepository(pool).apply(fixture.company.hub.id,'owner',{resource:'agent',action:'update',
      tenant_id:fixture.company.hub.id,alias:'resume_target',value:{display_name:'Changed sealed target'}},false,
    failed.desired_revision,companySource(fixture.company));
    if(!resumed) {
      await expect(fixture.repository.resume(fixture.company.hub.id,'owner',failed.id,failed.version,fixture.subject))
        .rejects.toMatchObject({code:'conflict'});
      expect((await fixture.repository.get(fixture.company.hub.id,'owner',failed.id,fixture.subject)).status).toBe('failed');
      return;
    }
    const claim=await stopClaim(fixture,resumed.id);const response=await signedExecutionResponse(fixture,claim);
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'conflict'});
    await expect(fixture.source.execution(claim)).rejects.toThrow('Signed host channel could not be verified');
    await expect(fixture.source.prepare(claim)).rejects.toThrow('Signed host channel could not be verified');
    expect((await fixture.repository.get(fixture.company.hub.id,'owner',failed.id,fixture.subject)).steps.find(step=>step.name==='stop')?.status).toBe('failed');
  });
  it('keeps the exact revision check for an operation claimed before preparation and sealing',async()=>{
    const fixture=await signedStopFixture('stop-unsealed');const operation=await fixture.enqueue('resume_target',0);
    const claim=await stopClaim(fixture,operation.id);
    await new ConfigurationRepository(pool).apply(fixture.company.hub.id,'owner',{resource:'agent',action:'update',
      tenant_id:fixture.company.hub.id,alias:'other_agent',value:{display_name:'Unrelated change before preparation'}},false,0,companySource(fixture.company));
    const response=await signedExecutionResponse(fixture,claim);
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'conflict'});
    await expect(fixture.source.prepare(claim)).rejects.toThrow('Signed host channel could not be verified');
    const unchanged=await fixture.repository.get(fixture.company.hub.id,'owner',operation.id,fixture.subject);
    expect(unchanged).toMatchObject({id:operation.id,desired_revision:null,request_sha256:operation.request_sha256,
      expected_revision:operation.expected_revision});
    expect(unchanged.steps.every(step=>step.status==='pending')).toBe(true);
  });
});
