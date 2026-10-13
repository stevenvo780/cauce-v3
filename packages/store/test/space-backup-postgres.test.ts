import { createHash,randomBytes,randomUUID,sign } from 'node:crypto';
import { chmod,mkdir,mkdtemp,readFile,rm,truncate,writeFile } from 'node:fs/promises';
import { tmpdir,userInfo } from 'node:os';
import { join } from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import { afterAll,afterEach,beforeEach,describe,expect,it } from 'vitest';
import { SPACE_BACKUP_MAX_BYTES,SpaceBackupRepository,hostRequestMessage,type DatabaseClient,type DatabasePool,type RegisteredCompany,type SpaceBackupClaim } from '../src/index.js';
import { startTestCaseDatabase,startTestDatabase,type EmptyTestDatabase,type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { channelCapabilities,channelCompany,channelHost,channelPost,companySource,type ChannelHost } from '../../../services/gateway/src/fleet/host-channel.fixtures.js';
import { registerHostChannelRoutes } from '../../../services/gateway/src/fleet/host-channel.routes.js';
import { registerSpaceBackupHostRoutes } from '../../../services/gateway/src/fleet/space-backup.routes.js';
import { registerSpaceBackupConsoleRoutes } from '../../../services/gateway/src/console/space-backup.routes.js';
import { openSpaceBackupDownload,verifySpaceBackup,type SpaceBackupStorage } from '../../../services/gateway/src/fleet/space-backup.files.js';
import { SpaceBackupHost } from '../../../services/gateway/src/fleet/space-backup.host.js';
import { SignedHostChannel } from '../../../services/gateway/src/fleet/signed-source.js';
import { invokeSpaceBackupHelper } from '../../../services/gateway/src/fleet/space-backup.process.js';
import { PasswordAuthProvider,registerPasswordAuth } from '../../../services/gateway/src/password-auth.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { createConsoleSecurityHook } from '../../../services/gateway/src/console-security.js';
import { boundedProviderReceipt } from '../../../services/gateway/src/fleet/provider-login.js';

let database:TestDatabase|undefined;let current:EmptyTestDatabase|undefined;let pool:DatabasePool;let admin:DatabasePool;
let north:RegisteredCompany;let south:RegisteredCompany;let host:ChannelHost;let other:ChannelHost;let app:FastifyInstance;
let root:string;let storage:SpaceBackupStorage;let policyFile:string;let cookie:string;let csrf:string;let passwordHash:string|undefined;
const password='space-backup-fixture-password';const projectRoot=new URL('../../../',import.meta.url).pathname.replace(/\/$/u,'');
const base=()=>`/v3/console/spaces/${north.hub.id}/worker/backups`;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
preparePostgresSuite(import.meta.url,async()=>{database=await startTestDatabase();},120_000);
beforeEach(async()=>{
  if(!database) throw new Error('database absent');current=await startTestCaseDatabase(database);pool=current.pool;admin=current.adminPool;
  north=await channelCompany(pool,'backup-north');south=await channelCompany(pool,'backup-south');host=await channelHost(pool,north);other=await channelHost(pool,south);
  root=await mkdtemp(join(tmpdir(),'cauce-space-backup-'));storage={directory:join(root,'copies'),projectRoot};
  const owner=userInfo();const roots=Object.fromEntries(['state','runtime','pki','tokens','identities'].map(name=>[name,join(root,name)]));
  for(const directory of Object.values(roots)) await mkdir(directory,{mode:0o700});
  const state=join(roots.runtime??'','worker');await mkdir(state,{mode:0o700});await mkdir(join(state,'space'),{mode:0o700});
  for(const name of ['context','projects','config','logs']) await mkdir(join(state,'space',name),{mode:0o700});
  await writeFile(join(state,'space/projects/work.txt'),Buffer.alloc(100_000,65),{mode:0o600});
  await writeFile(join(state,'space/config/context-state.json'),JSON.stringify({company_id:north.company.id,tenant_id:north.hub.id,alias:'worker',runtime_key:'worker'}),{mode:0o600});
  await writeFile(join(state,'space/config/auth.json'),'synthetic-secret-never-exported',{mode:0o600});
  await writeFile(join(state,'space/logs/ignored.log'),'unexported',{mode:0o600});
  await admin.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,company_id,host_id,runtime_key,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user)
    VALUES($1,'worker','codex',false,$2,$3,'worker','native',$4,$5,$6,$7,$5)`,[north.hub.id,north.company.id,host.host_id,`host:${host.host_id}`,owner.username,owner.homedir,state]);
  policyFile=join(root,'policy.json');const policy={schemaVersion:1,host_id:host.host_id,executor_user:owner.username,roots,
    native:[{runtime_user:owner.username,systemd_user:owner.username,home_directory:owner.homedir,state_root:roots.runtime}],containers:{},profiles:{},hooks:{},bundles:{codex:{}}};
  const policyBytes=JSON.stringify(policy);await writeFile(policyFile,policyBytes,{mode:0o600});
  passwordHash??=await hashPassword(password,{cost:1024,blockSize:8,parallelism:1});await admin.query('UPDATE console_users SET password_hash=$1',[passwordHash]);
  const provider=new PasswordAuthProvider({users:new PostgresConsoleUserStore(pool),signingKey:Buffer.alloc(32,84)});
  app=Fastify();app.addHook('onRequest',createConsoleSecurityHook());registerPasswordAuth(app,provider);registerHostChannelRoutes(app,pool);
  registerSpaceBackupHostRoutes(app,pool,storage);registerSpaceBackupConsoleRoutes(app,provider,pool,storage);
  expect((await channelPost(app,host,{...channelCapabilities(),policy_sha256:digest(policyBytes)})).statusCode).toBe(200);
  const login=await app.inject({method:'POST',url:'/v3/auth/login',headers:{origin:'http://localhost'},payload:{email:north.user.email,password}});
  expect(login.statusCode).toBe(200);const header=login.headers['set-cookie'];const text=Array.isArray(header)?header[0]:header;
  cookie=text?.split(';',1)[0]??'';csrf=login.json<{csrf_token:string}>().csrf_token;
});
afterEach(async()=>{await app.close();await current?.close();current=undefined;await rm(root,{recursive:true,force:true});});
afterAll(async()=>{if(database){await database.pool.end();await database.container.stop();}});
function post(payload:Record<string,unknown>,headers:Record<string,string>={}) {return app.inject({method:'POST',url:base(),payload,headers:{cookie,origin:'http://localhost','x-csrf-token':csrf,...headers}});}
function hostPacket(target:ChannelHost,payload:Record<string,unknown>) {
  const path=`/v3/fleet/hosts/${target.host_id}/space-backups`;
  const packet={host_id:target.host_id,company_id:target.company_id,issued_at:Date.now(),nonce:randomUUID().replaceAll('-','').repeat(2),payload,proof:''};
  packet.proof=sign(null,Buffer.from(hostRequestMessage('POST',path,packet)),target.keys.privateKey).toString('base64');return {path,packet};
}
async function command(payload:Record<string,unknown>,target=host) {const {path,packet}=hostPacket(target,payload);return app.inject({method:'POST',url:path,payload:packet});}
async function createClaim() {
  const response=await post({idempotency_key:`space-${randomUUID()}`});expect(response.statusCode).toBe(202);
  const id=response.json<{id:string}>().id;const responseClaim=await command({action:'claim'});expect(responseClaim.statusCode).toBe(200);
  return {id,claim:responseClaim.json<{claim:SpaceBackupClaim}>().claim};
}
const fence=(claim:SpaceBackupClaim)=>({id:claim.id,claim_token:claim.claim_token,claim_epoch:claim.claim_epoch});
async function exported(claim:SpaceBackupClaim) {return await invokeSpaceBackupHelper({python:'/usr/bin/python3',projectRoot,policyFile},{action:'export',claim},new AbortController().signal) as {bytes:number;sha256:string;manifest_sha256:string};}
async function upload(claim:SpaceBackupClaim) {
  const receipt=await exported(claim);expect((await command({action:'begin',claim:fence(claim),...receipt})).json()).toEqual({offset:0});
  let offset=0;while(offset<receipt.bytes) {
    const chunk=await invokeSpaceBackupHelper({python:'/usr/bin/python3',projectRoot,policyFile},{action:'read',claim,offset},new AbortController().signal) as {offset:number;data:string};
    const response=await command({action:'append',claim:fence(claim),...chunk});expect(response.statusCode).toBe(200);offset=response.json<{offset:number}>().offset;
  }
  return receipt;
}
describe('durable space backup with real PostgreSQL runtime role and signed HTTP',()=>{
  it('records the verified backup host and component without private snapshots or duplicate events',async()=>{
    const response=await post({idempotency_key:'diagnostic-backup-audit'});expect(response.statusCode).toBe(202);
    const id=response.json<{id:string}>().id;
    expect((await post({idempotency_key:'diagnostic-backup-audit'})).json<{id:string}>().id).toBe(id);
    const events=(await pool.query<{company_id:string;actor_human_id:string;metadata:Record<string,unknown>}>(
      "SELECT company_id,actor_human_id,metadata FROM audit_events WHERE action='space.backup.request' AND metadata->>'id'=$1",[id])).rows;
    expect(events).toEqual([{company_id:north.company.id,actor_human_id:north.user.id,
      metadata:{id,tenant_id:north.hub.id,alias:'worker',host_id:host.host_id,component:'backup'}}]);
    expect(JSON.stringify(events)).not.toContain(other.host_id);
    expect(JSON.stringify(events)).not.toContain('synthetic-secret-never-exported');
    expect(JSON.stringify(events)).not.toMatch(/agent_snapshot|claim_token|credential|password|cookie|policy_sha256/u);
  });
  it('runs real closed Python export through enrolled channel and downloads its verified private ZIP',async()=>{
    const created=await post({idempotency_key:'signed-full-backup'});expect(created.statusCode).toBe(202);const id=created.json<{id:string}>().id;
    expect((await post({idempotency_key:'signed-full-backup'})).json<{id:string}>().id).toBe(id);
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string') throw new Error('HTTP address absent');
    const directory=join(root,'host-identity');await mkdir(directory,{mode:0o700});
    const publicKey=host.keys.publicKey.export({type:'spki',format:'der'});
    await writeFile(join(directory,'identity.json'),JSON.stringify({enrollment_id:randomUUID(),company_id:host.company_id,host_id:host.host_id,
      gateway:`http://127.0.0.1:${String(address.port)}`,state:'enrolled',key_fingerprint:digest(publicKey),executor_ready:true}),{mode:0o600});
    await writeFile(join(directory,'private.pem'),host.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const worker=new SpaceBackupHost(await SignedHostChannel.load(directory),{python:'/usr/bin/python3',projectRoot,policyFile});
    expect(await worker.runOnce(new AbortController().signal)).toBe(true);expect(await worker.runOnce(new AbortController().signal)).toBe(false);
    const dto=(await app.inject({method:'GET',url:`${base()}/${id}`,headers:{cookie}})).json<{status:string;bytes:number;sha256:string;download_url:string}>();
    expect(dto.status).toBe('ready');const downloaded=await app.inject({method:'GET',url:dto.download_url,headers:{cookie}});
    expect(downloaded.statusCode).toBe(200);expect(downloaded.headers['content-type']).toBe('application/zip');
    expect(downloaded.rawPayload.length).toBe(dto.bytes);expect(digest(downloaded.rawPayload)).toBe(dto.sha256);
    expect(downloaded.rawPayload.includes(Buffer.from('synthetic-secret-never-exported'))).toBe(false);
    expect((await readFile(join(storage.directory,`${id}.zip`))).equals(downloaded.rawPayload)).toBe(true);
    const archive=join(root,'downloaded.zip');const restored=join(root,'restored-space');await writeFile(archive,downloaded.rawPayload,{mode:0o600});
    const restoration=await boundedProviderReceipt('/usr/bin/python3',[join(projectRoot,'ops/cli/space_archive.py'),'restore','--archive',archive,
      '--directory',restored,'--company-id',north.company.id,'--tenant-id',north.hub.id,'--alias','worker','--runtime-key','worker'],'',new AbortController().signal);
    expect(restoration).toMatchObject({state:'restored',identity:{company_id:north.company.id,tenant_id:north.hub.id,alias:'worker',runtime_key:'worker'}});
    expect(await readFile(join(restored,'projects/work.txt'))).toEqual(Buffer.alloc(100_000,65));
    await expect(readFile(join(restored,'config/auth.json'))).rejects.toThrow();await expect(readFile(join(restored,'logs/ignored.log'))).rejects.toThrow();
  });
  it('requests, physically exports and streams a copy above 32 MiB to the console, then restores it with equal hashes',async()=>{
    const large=randomBytes(33*1024*1024+4097);await writeFile(join(root,'runtime/worker/space/projects/large.bin'),large,{mode:0o600});
    const created=await post({idempotency_key:'console-large-backup'});expect(created.statusCode).toBe(202);const id=created.json<{id:string}>().id;
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string') throw new Error('HTTP address absent');
    const origin=`http://127.0.0.1:${String(address.port)}`;const directory=join(root,'host-identity');await mkdir(directory,{mode:0o700});
    await writeFile(join(directory,'identity.json'),JSON.stringify({enrollment_id:randomUUID(),company_id:host.company_id,host_id:host.host_id,gateway:origin,
      state:'enrolled',key_fingerprint:digest(host.keys.publicKey.export({type:'spki',format:'der'})),executor_ready:true}),{mode:0o600});
    await writeFile(join(directory,'private.pem'),host.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const worker=new SpaceBackupHost(await SignedHostChannel.load(directory),{python:'/usr/bin/python3',projectRoot,policyFile});
    expect(await worker.runOnce(new AbortController().signal)).toBe(true);
    const dto=(await app.inject({method:'GET',url:`${base()}/${id}`,headers:{cookie}})).json<{status:string;bytes:number;sha256:string;download_url:string}>();
    expect(dto.status).toBe('ready');expect(dto.bytes).toBeGreaterThan(32*1024*1024);
    const response=await fetch(`${origin}${dto.download_url}`,{headers:{cookie}});
    expect([response.status,response.headers.get('content-length'),response.headers.get('x-cauce-archive-sha256')]).toEqual([200,String(dto.bytes),dto.sha256]);
    const archive=join(root,'console-download.zip');const hash=createHash('sha256');const parts:Buffer[]=[];let chunks=0;
    if(!response.body) throw new Error('download body absent');
    const reader=response.body.getReader();for(let part=await reader.read();!part.done;part=await reader.read()) {hash.update(part.value);parts.push(Buffer.from(part.value));chunks++;}
    expect(chunks).toBeGreaterThan(1);expect(hash.digest('hex')).toBe(dto.sha256);await writeFile(archive,Buffer.concat(parts),{mode:0o600});
    const restored=join(root,'restored-large-space');
    const restoration=await boundedProviderReceipt('/usr/bin/python3',[join(projectRoot,'ops/cli/space_archive.py'),'restore','--archive',archive,
      '--directory',restored,'--company-id',north.company.id,'--tenant-id',north.hub.id,'--alias','worker','--runtime-key','worker'],'',new AbortController().signal);
    expect(restoration).toMatchObject({state:'restored',identity:{company_id:north.company.id,tenant_id:north.hub.id,alias:'worker',runtime_key:'worker'}});
    expect(digest(await readFile(join(restored,'projects/large.bin')))).toBe(digest(large));
    expect(digest(await readFile(join(restored,'projects/work.txt')))).toBe(digest(Buffer.alloc(100_000,65)));
    await expect(readFile(join(restored,'config/auth.json'))).rejects.toThrow();
  },240_000);
  it('requires exact CSRF, human authority and target company on create/read/download',async()=>{
    expect((await post({idempotency_key:'csrf-failed'},{'x-csrf-token':''})).statusCode).toBe(403);
    expect((await post({idempotency_key:'origin-failed'},{origin:'https://foreign.example'})).statusCode).toBe(403);
    const {id}=await createClaim();const repository=new SpaceBackupRepository(pool);
    await expect(repository.get(companySource(south),north.hub.id,'worker',id)).rejects.toMatchObject({code:'not_found'});
    expect((await app.inject({method:'GET',url:`${base()}/${id}/download`,headers:{cookie}})).statusCode).toBe(409);
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1',[north.user.id]);
    expect((await app.inject({method:'GET',url:`${base()}/${id}`,headers:{cookie}})).statusCode).toBe(403);
    expect((await post({idempotency_key:'revoked-failed'})).statusCode).toBe(403);
  });
  it('fences old epochs, other signed hosts and replays, but permits exact accepted chunk retry',async()=>{
    const {claim}=await createClaim();expect((await command({action:'renew',claim:fence(claim)},other)).statusCode).toBe(409);
    const prepared=await exported(claim);await command({action:'begin',claim:fence(claim),...prepared});
    const chunk=await invokeSpaceBackupHelper({python:'/usr/bin/python3',projectRoot,policyFile},{action:'read',claim,offset:0},new AbortController().signal) as {offset:number;data:string};
    const {path,packet}=hostPacket(host,{action:'append',claim:fence(claim),...chunk});
    expect((await app.inject({method:'POST',url:path,payload:packet})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:path,payload:packet})).statusCode).toBe(409);
    expect((await command({action:'append',claim:fence(claim),...chunk})).json()).toEqual({offset:65_536});
    expect((await command({action:'append',claim:fence(claim),offset:0,data:Buffer.alloc(65_536,66).toString('base64')})).statusCode).toBe(409);
    await admin.query('UPDATE space_backups SET received_bytes=0 WHERE id=$1',[claim.id]);
    expect((await command({action:'append',claim:fence(claim),...chunk})).json()).toEqual({offset:65_536});
    expect((await readFile(join(storage.directory,`${claim.id}.1.part`))).length).toBe(65_536);
    await admin.query("UPDATE space_backups SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.id]);
    const next=(await command({action:'claim'})).json<{claim:SpaceBackupClaim}>().claim;expect(next.claim_epoch).toBe(claim.claim_epoch+1);
    await expect(readFile(join(storage.directory,`${claim.id}.1.part`))).rejects.toThrow();
    expect((await command({action:'renew',claim:fence(claim)})).statusCode).toBe(409);
    expect((await command({action:'renew',claim:fence(next)})).json()).toEqual({renewed:true});
  });
  it('refuses placement changes and records scope-changed before a reclaimed export',async()=>{
    const {claim}=await createClaim();await admin.query("UPDATE agents SET state_directory=state_directory||'/changed' WHERE tenant_id=$1 AND alias='worker'",[north.hub.id]);
    expect((await command({action:'renew',claim:fence(claim)})).statusCode).toBe(409);
    await admin.query("UPDATE space_backups SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.id]);
    expect((await command({action:'claim'})).json()).toEqual({claim:null});
    expect((await pool.query('SELECT status,error FROM space_backups WHERE id=$1',[claim.id])).rows).toEqual([{status:'failed',error:'SCOPE_CHANGED'}]);
  });
  it('revalidates the original requester and fails a queued backup after durable permission revocation',async()=>{
    const response=await post({idempotency_key:'revoked-pending'});expect(response.statusCode).toBe(202);const id=response.json<{id:string}>().id;
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1',[north.user.id]);
    expect((await command({action:'claim'})).json()).toEqual({claim:null});
    expect((await pool.query('SELECT status,error FROM space_backups WHERE id=$1',[id])).rows).toEqual([{status:'failed',error:'SCOPE_CHANGED'}]);
  });
  it('records explicit oversized source failure through the real helper and signed host worker',async()=>{
    const response=await post({idempotency_key:'oversized-source'});expect(response.statusCode).toBe(202);const id=response.json<{id:string}>().id;
    const agent=(await pool.query<{state_directory:string}>("SELECT state_directory FROM agents WHERE tenant_id=$1 AND alias='worker'",[north.hub.id])).rows[0];
    if(!agent) throw new Error('placed agent absent');const excessive=join(agent.state_directory,'space/projects/large.dat');
    await writeFile(excessive,'',{mode:0o600});await truncate(excessive,128*1024*1024+1);
    const worker=new SpaceBackupHost({identity:host,request:async(_method,_path,payload)=>{
      const result=await command(payload);if(result.statusCode!==200) throw new Error('signed host request failed');return result.json<unknown>();
    }},{python:'/usr/bin/python3',projectRoot,policyFile});
    expect(await worker.runOnce(new AbortController().signal)).toBe(true);
    expect((await app.inject({method:'GET',url:`${base()}/${id}`,headers:{cookie}})).json()).toMatchObject({status:'failed',error:'LIMIT_EXCEEDED',download_url:null});
    await expect(readFile(join(storage.directory,`${id}.zip`))).rejects.toThrow();
  });
  it('rejects hash/manifests/size corruption and can recover finish after a filesystem rename and SQL rollback',async()=>{
    const {claim}=await createClaim();const receipt=await upload(claim);
    const row=(await pool.query<import('../src/index.js').SpaceBackupRow>('SELECT * FROM space_backups WHERE id=$1',[claim.id])).rows[0];if(!row) throw new Error('backup row absent');
    await expect(verifySpaceBackup(storage,{...row,manifest_sha256:'0'.repeat(64)})).rejects.toThrow();
    await expect(verifySpaceBackup(storage,{...row,sha256:'0'.repeat(64)})).rejects.toThrow('digest differs');
    await verifySpaceBackup(storage,row);expect((await command({action:'finish',claim:fence(claim)})).json()).toEqual({ready:true});
    expect((await command({action:'finish',claim:fence(claim)})).json()).toEqual({ready:true});
    await writeFile(join(storage.directory,`${claim.id}.zip`),Buffer.alloc(receipt.bytes,88),{mode:0o600});
    const ready={...row,status:'ready' as const};await expect(openSpaceBackupDownload(storage,ready)).rejects.toThrow('copy differs');
    expect((await command({action:'finish',claim:fence(claim)})).statusCode).toBe(409);
    expect((await app.inject({method:'GET',url:`${base()}/${claim.id}/download`,headers:{cookie}})).statusCode).toBe(409);
    expect((await command({action:'begin',claim:fence(claim),bytes:SPACE_BACKUP_MAX_BYTES+1,sha256:receipt.sha256,manifest_sha256:receipt.manifest_sha256})).statusCode).toBe(400);
  });
  it('cleans every expired epoch privately and disables expired downloads without a false ready state',async()=>{
    const {claim}=await createClaim();await mkdir(storage.directory,{mode:0o700,recursive:true});
    for(const name of [`${claim.id}.zip`,`${claim.id}.1.part`,`${claim.id}.17.part`]) await writeFile(join(storage.directory,name),'expired',{mode:0o600});
    await writeFile(join(storage.directory,'unrelated-file'),'preserved',{mode:0o600});
    await admin.query("UPDATE space_backups SET expires_at=now()-interval '1 second' WHERE id=$1",[claim.id]);
    expect((await command({action:'claim'})).json()).toEqual({claim:null});
    expect((await app.inject({method:'GET',url:`${base()}/${claim.id}`,headers:{cookie}})).json()).toMatchObject({status:'failed',error:'EXPIRED',download_url:null});
    await expect(readFile(join(storage.directory,`${claim.id}.17.part`))).rejects.toThrow();
    expect(await readFile(join(storage.directory,'unrelated-file'),'utf8')).toBe('preserved');
    const repeated=await new SpaceBackupRepository(pool).enqueue(companySource(north),north.hub.id,'worker',
      {idempotency_key:(await pool.query<{idempotency_key:string}>('SELECT idempotency_key FROM space_backups WHERE id=$1',[claim.id])).rows[0]?.idempotency_key});
    expect(repeated).toMatchObject({id:claim.id,status:'failed',error:'EXPIRED',download_url:null});
  });
  it('rejects browser cookies and closed payload extensions without consuming nonce or mutating a queue',async()=>{
    const {path,packet}=hostPacket(host,{action:'claim'});
    expect((await app.inject({method:'POST',url:path,payload:packet,headers:{cookie}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:path,payload:packet})).statusCode).toBe(200);
    expect((await command({action:'claim',source:'/private/foreign'})).statusCode).toBe(400);
    expect((await post({idempotency_key:'path-refused',source:'/private/foreign'})).statusCode).toBe(400);
  });
  it('refuses unsafe shared storage and pins fresh capability policy',async()=>{
    const repository=new SpaceBackupRepository(pool);const {claim}=await createClaim();
    await mkdir(storage.directory,{recursive:true,mode:0o700});await chmod(storage.directory,0o770);
    expect((await command({action:'claim'})).statusCode).toBe(503);await chmod(storage.directory,0o700);
    await admin.query("UPDATE fleet_host_identities SET capabilities=jsonb_set(capabilities,'{policy_sha256}',to_jsonb($2::text)) WHERE host_id=$1",[host.host_id,'e'.repeat(64)]);
    expect((await command({action:'renew',claim:fence(claim)})).statusCode).toBe(409);
    await admin.query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id=$1",[host.host_id]);
    await expect(repository.enqueue(companySource(north),north.hub.id,'worker',{idempotency_key:'host-unavailable'})).rejects.toMatchObject({code:'conflict'});
  });
  it('bounds retained company requests but preserves an existing idempotency receipt at the cap',async()=>{
    const response=await post({idempotency_key:'retention-existing'});expect(response.statusCode).toBe(202);const id=response.json<{id:string}>().id;
    await admin.query(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256)
      SELECT backup.company_id,backup.tenant_id,backup.alias,backup.host_id,backup.requested_by,'retention-'||item,backup.agent_snapshot,backup.policy_sha256
      FROM space_backups backup CROSS JOIN generate_series(1,19) item WHERE backup.id=$1`,[id]);
    expect((await post({idempotency_key:'retention-overflow'})).statusCode).toBe(409);
    expect((await post({idempotency_key:'retention-existing'})).json<{id:string}>().id).toBe(id);
  });
  it('serializes durable byte reservations and leaves global capacity for another company',async()=>{
    storage.companyMaxBytes=2*SPACE_BACKUP_MAX_BYTES;storage.globalMaxBytes=3*SPACE_BACKUP_MAX_BYTES;
    const repository=new SpaceBackupRepository(pool,storage);
    const northResult=await Promise.allSettled([0,1,2].map(index=>repository.enqueue(companySource(north),north.hub.id,'worker',
      {idempotency_key:`byte-north-${String(index)}`})));
    expect(northResult.filter(result=>result.status==='fulfilled')).toHaveLength(2);
    expect(northResult.filter(result=>result.status==='rejected')).toHaveLength(1);
    await admin.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,company_id,host_id,runtime_key,runtime_mode,container_name,
      runtime_user,home_directory,state_directory,systemd_user) SELECT $1,'worker',harness_id,false,$2,$3,'south-worker',runtime_mode,
      $4,runtime_user,home_directory,state_directory,systemd_user FROM agents WHERE tenant_id=$5 AND alias='worker'`,
    [south.hub.id,south.company.id,other.host_id,`host:${other.host_id}`,north.hub.id]);
    expect((await channelPost(app,other,{...channelCapabilities(),policy_sha256:digest(await readFile(policyFile))})).statusCode).toBe(200);
    const southResult=await Promise.allSettled([0,1].map(index=>repository.enqueue(companySource(south),south.hub.id,'worker',
      {idempotency_key:`byte-south-${String(index)}`})));
    expect(southResult.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(southResult.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect((await pool.query('SELECT company_id,count(*)::integer AS count FROM space_backups GROUP BY company_id ORDER BY company_id')).rows)
      .toEqual([{company_id:north.company.id,count:2},{company_id:south.company.id,count:1}]);
    const prior=northResult.find(result=>result.status==='fulfilled');if(prior?.status!=='fulfilled') throw new Error('reservation absent');
    const key=(await pool.query<{idempotency_key:string}>('SELECT idempotency_key FROM space_backups WHERE id=$1',[prior.value.id])).rows[0]?.idempotency_key;
    expect(await repository.enqueue(companySource(north),north.hub.id,'worker',{idempotency_key:key})).toEqual(prior.value);
  });
  it('serializes enqueue against signed begin without a lock cycle',async()=>{
    const {claim}=await createClaim();
    let release:()=>void=()=>undefined;const barrier=new Promise<void>(resolve=>{release=resolve;});
    let reached:(pid:number)=>void=()=>undefined;const holding=new Promise<number>(resolve=>{reached=resolve;});
    let paused=false;
    const gatedPool={connect:async()=>{
      const client=await pool.connect();const query=client.query.bind(client);const free=client.release.bind(client);
      const pid=(await query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if(pid===undefined) {free();throw new Error('admission backend absent');}
      client.query=(async(sql:string,parameters?:unknown[])=>{
        const result=await query(sql,parameters);
        if(!paused&&sql==='SELECT pg_advisory_xact_lock($1)'&&parameters?.[0]===783_003_060) {
          paused=true;reached(pid);await barrier;
        }
        return result;
      }) as DatabaseClient['query'];
      client.release=(error?:boolean|Error)=>{client.query=query;client.release=free;free(error);};return client;
    }} as unknown as DatabasePool;
    const admission=Fastify();admission.addHook('onRequest',createConsoleSecurityHook());
    const provider=new PasswordAuthProvider({users:new PostgresConsoleUserStore(pool),signingKey:Buffer.alloc(32,84)});
    registerSpaceBackupConsoleRoutes(admission,provider,gatedPool,storage);
    const enqueue=Promise.resolve(admission.inject({method:'POST',url:base(),payload:{idempotency_key:'enqueue-begin-barrier'},
      headers:{cookie,origin:'http://localhost','x-csrf-token':csrf}}));
    let begin:ReturnType<typeof command>|undefined;
    try {
      await expect.poll(()=>paused,{timeout:5000,interval:10}).toBe(true);
      const pid=await holding;
      begin=command({action:'begin',claim:fence(claim),bytes:100_000,sha256:'1'.repeat(64),manifest_sha256:'2'.repeat(64)});
      await expect.poll(async()=>{
        const result=await admin.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>$1 AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) AS waiting`,[pid]);
        return result.rows[0]?.waiting;
      },{timeout:5000,interval:10}).toBe(true);
      release();const admitted=await enqueue;const started=await begin;
      console.log('BACKUP_ADMISSION_BEGIN_BARRIER',JSON.stringify({enqueue:admitted.statusCode,begin:started.statusCode}));
      expect([admitted.statusCode,started.statusCode]).toEqual([202,200]);
    } finally {release();await Promise.allSettled([enqueue,begin]);await admission.close();}
  });
  it('charges ready bytes and failed partial copies while releasing expired reservations',async()=>{
    storage.companyMaxBytes=2*SPACE_BACKUP_MAX_BYTES+512*1024*1024;storage.globalMaxBytes=4*SPACE_BACKUP_MAX_BYTES;
    const {claim}=await createClaim();await upload(claim);expect((await command({action:'finish',claim:fence(claim)})).statusCode).toBe(200);
    expect((await post({idempotency_key:'quota-ready-first'})).statusCode).toBe(202);
    expect((await post({idempotency_key:'quota-ready-second'})).statusCode).toBe(202);
    expect((await post({idempotency_key:'quota-ready-third'})).statusCode).toBe(409);
    await admin.query("UPDATE space_backups SET expires_at=now()-interval '1 second' WHERE idempotency_key='quota-ready-first'");
    expect((await post({idempotency_key:'quota-after-expiry'})).statusCode).toBe(202);
    const partial=(await command({action:'claim'})).json<{claim:SpaceBackupClaim}>().claim;
    const value=await exported(partial);await command({action:'begin',claim:fence(partial),...value});
    const chunk=await invokeSpaceBackupHelper({python:'/usr/bin/python3',projectRoot,policyFile},{action:'read',claim:partial,offset:0},new AbortController().signal);
    expect((await command({action:'append',claim:fence(partial),...(chunk as {offset:number;data:string})})).statusCode).toBe(200);
    expect((await command({action:'fail',claim:fence(partial),error:'EXPORT_FAILED'})).statusCode).toBe(200);
    await admin.query("UPDATE space_backups SET expires_at=now()-interval '1 second' WHERE id<>$1",[partial.id]);
    storage.companyMaxBytes=SPACE_BACKUP_MAX_BYTES;storage.globalMaxBytes=4*SPACE_BACKUP_MAX_BYTES;
    expect((await post({idempotency_key:'quota-retained-partial'})).statusCode).toBe(409);
    expect((await readFile(join(storage.directory,`${partial.id}.${String(partial.claim_epoch)}.part`))).length).toBe(65_536);
  });
  it('rechecks reservation capacity at begin and admits large bounded receipts without ready metadata',async()=>{
    const {claim}=await createClaim();
    expect((await command({action:'begin',claim:fence(claim),bytes:96*1024*1024,sha256:'1'.repeat(64),manifest_sha256:'2'.repeat(64)})).json()).toEqual({offset:0});
    expect((await app.inject({method:'GET',url:`${base()}/${claim.id}`,headers:{cookie}})).json())
      .toMatchObject({status:'running',bytes:96*1024*1024,download_url:null});
    storage.companyMaxBytes=SPACE_BACKUP_MAX_BYTES;storage.globalMaxBytes=SPACE_BACKUP_MAX_BYTES;
    await admin.query(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256)
      SELECT company_id,tenant_id,alias,host_id,requested_by,'begin-reservation-extra',agent_snapshot,policy_sha256 FROM space_backups WHERE id=$1`,[claim.id]);
    expect((await command({action:'begin',claim:fence(claim),bytes:96*1024*1024,sha256:'1'.repeat(64),manifest_sha256:'2'.repeat(64)})).statusCode).toBe(409);
    expect((await command({action:'finish',claim:fence(claim)})).statusCode).toBe(409);
  });
  it('persists export-failed after a disk error without advertising a partial copy as ready',async()=>{
    const response=await post({idempotency_key:'disk-failure-backup'});const id=response.json<{id:string}>().id;
    const worker=new SpaceBackupHost({identity:host,request:async(_method,_path,payload)=>{
      const result=await command(payload);if(result.statusCode!==200) throw new Error('signed host request failed');return result.json<unknown>();
    }},{python:'/usr/bin/python3',projectRoot,policyFile},async(config,input,signal)=>{
      if(input.action==='read'&&Number(input.offset)>0) throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});
      return invokeSpaceBackupHelper(config,input,signal);
    });
    expect(await worker.runOnce(new AbortController().signal)).toBe(true);
    expect((await app.inject({method:'GET',url:`${base()}/${id}`,headers:{cookie}})).json())
      .toMatchObject({status:'failed',error:'EXPORT_FAILED',download_url:null});
    expect((await pool.query<{received_bytes:number}>('SELECT received_bytes FROM space_backups WHERE id=$1',[id])).rows[0]?.received_bytes).toBe(65_536);
    expect((await app.inject({method:'GET',url:`${base()}/${id}/download`,headers:{cookie}})).statusCode).toBe(409);
  });
});
