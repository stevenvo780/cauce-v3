import Fastify,{type FastifyInstance} from 'fastify';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll,afterEach,beforeEach,describe,expect,it} from 'vitest';
import {FleetOperationsRepository,type DatabasePool} from '@cauce/store';
import {preparePostgresSuite} from '../../../../packages/store/test/postgres-suite.js';
import {startTestCaseDatabase,startTestDatabase,type EmptyTestDatabase,type TestDatabase} from '../../../../tests/helpers/postgres.js';
import {registerHostChannelRoutes} from './host-channel.routes.js';
import {channelCapabilities,channelCompany,channelHost} from './host-channel.fixtures.js';
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
});
