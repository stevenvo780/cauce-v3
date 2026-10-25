import { execFile } from 'node:child_process';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { SPACE_BACKUP_CHUNK_BYTES,SPACE_BACKUP_HOST_BODY_BYTES } from '@cauce/store';
import { SpaceBackupHostCommandSchema } from '../../services/gateway/src/fleet/space-backup.contracts.js';
import { startNginxMcpFixture,type NginxMcpFixture,type NginxResponse } from './mcp-nginx-mtls.fixtures.js';
const TASK='c171b-copias-grandes-1025';const run=randomUUID().slice(0,8);const prefix=`zz-canary-${TASK}-ingress-${run}`;
const evidence=join(process.cwd(),'.delegados/v4/recibos',TASK,`ingress-${run}`);const execute=promisify(execFile);
let fixture:NginxMcpFixture|undefined;let directory:string|undefined;
const statuses:Record<string,unknown>={};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function receipt(name:string,value:unknown) {await writeFile(join(evidence,`${name}.json`),JSON.stringify(value,null,2)+'\n');}
function active():NginxMcpFixture {if(!fixture) throw new Error('Backup ingress fixture is not initialized');return fixture;}
async function docker(args:string[]):Promise<string> {
  const result=await execute('docker',args,{encoding:'utf8',timeout:10_000,maxBuffer:64*1024});return result.stdout.trim();
}
function post(origin:string,path:string,body:string) {
  return active().requestNginx(origin,path,{method:'POST',headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))},body});
}
function boundedResponse(response:NginxResponse) {
  const bytes=Buffer.byteLength(response.body);expect(bytes).toBeLessThanOrEqual(4096);
  return {status:response.status,content_type:response.headers['content-type'],response_bytes:bytes,response_sha256:hash(response.body)};
}
function unsignedAppend(host:string):string {
  const payload=SpaceBackupHostCommandSchema.parse({action:'append',claim:{id:randomUUID(),claim_token:randomUUID(),claim_epoch:1},
    offset:0,data:Buffer.alloc(SPACE_BACKUP_CHUNK_BYTES,90).toString('base64')});
  return JSON.stringify({company_id:`zz-canary-${run}`,host_id:host,issued_at:Date.now(),nonce:randomBytes(32).toString('hex'),payload});
}
function exactBody(bytes:number):string {const start='{"padding":"';const end='"}';return start+'x'.repeat(bytes-start.length-end.length)+end;}
beforeAll(async()=>{
  await mkdir(evidence,{recursive:true});directory=await mkdtemp(join(tmpdir(),`${prefix}-`));
  const previous=process.env.CAUCE_SPACE_BACKUP_DIRECTORY;process.env.CAUCE_SPACE_BACKUP_DIRECTORY=join(directory,'copies');
  try {fixture=await startNginxMcpFixture({passwordAuth:true});}
  finally {if(previous===undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;else process.env.CAUCE_SPACE_BACKUP_DIRECTORY=previous;}
  const own=active();
  const source={task:TASK,run,prefix,owner:own.owner,owner_label:'cauce.test.owner',suite_label:'mcp-nginx-mtls',
    networkName:own.networkName,networkId:own.networkId,dockerContainerIds:own.dockerContainerIds,postgresContainerId:own.postgresContainerId,
    nginxImage:own.nginxImage,sourceConfigPath:own.sourceConfigPath,sourceConfigSha256:own.sourceConfigSha256,
    runtimeConfigSha256:own.runtimeConfigSha256,testAdaptations:own.testAdaptations,tlsPublicHashes:own.tlsPublicHashes,
    assertion_scope:'ingress body limits and negative host authentication; successful upload is covered by the direct gateway browser suite'};
  await receipt('source',source);console.info('BACKUP_NGINX_SOURCE',JSON.stringify(source));
},240_000);
afterAll(async()=>{
  const failures:unknown[]=[];const cleanup:Record<string,unknown>={task:TASK,run,fixture_started:fixture!==undefined,fixture_closed:false};
  try {
    if(fixture) {
      const own=fixture;try {await own.close();cleanup.fixture_closed=true;} catch(error) {failures.push(error);}
      try {
        const ids=[...own.dockerContainerIds,own.postgresContainerId];
        const containers=await Promise.all(ids.map(async id=>({id,remaining:await docker(['ps','-aq','--no-trunc','--filter',`id=${id}`])})));
        const ownerContainers=await docker(['ps','-aq','--no-trunc','--filter',`label=cauce.test.owner=${own.owner}`]);
        const ownerNetworks=await docker(['network','ls','-q','--no-trunc','--filter',`label=cauce.test.owner=${own.owner}`]);
        const network=await docker(['network','ls','-q','--no-trunc','--filter',`id=${own.networkId}`]);
        cleanup.owner=own.owner;cleanup.containers=containers;cleanup.owner_containers=ownerContainers;cleanup.owner_networks=ownerNetworks;cleanup.network_remaining=network;
        expect(containers.every(item=>item.remaining==='')).toBe(true);expect(ownerContainers).toBe('');expect(ownerNetworks).toBe('');expect(network).toBe('');
      } catch(error) {failures.push(error);}
    }
  } finally {
    if(directory) {try {await rm(directory,{recursive:true,force:true});cleanup.backup_directory_removed=true;} catch(error) {failures.push(error);}}
    cleanup.failure_count=failures.length;
    await receipt('statuses',statuses);await receipt('cleanup',cleanup);console.info('BACKUP_NGINX_CLEANUP',JSON.stringify(cleanup));
  }
  if(failures.length) throw new AggregateError(failures,'Backup Nginx ingress cleanup or resource proof failed');
},120_000);
describe('large backup blocks through the real Nginx mTLS ingress',()=>{
  const host=`zz-canary-ingress-${run}`;const path=`/v3/fleet/hosts/${host}/space-backups`;
  it('passes a valid 4 MiB append body to gateway host authentication and rejects its absent signature',async()=>{
    const own=active();const body=unsignedAppend(host);expect(Buffer.byteLength(body)).toBeGreaterThan(5*1024*1024);
    expect(Buffer.byteLength(body)).toBeLessThan(SPACE_BACKUP_HOST_BODY_BYTES);
    const before=(await own.database.pool.query<{count:number}>('SELECT count(*)::integer AS count FROM space_backups')).rows[0]?.count;
    const response=await post(own.primaryOrigin,path,body);
    const after=(await own.database.pool.query<{count:number}>('SELECT count(*)::integer AS count FROM space_backups')).rows[0]?.count;
    statuses.unsigned_append={...boundedResponse(response),request_bytes:Buffer.byteLength(body),request_sha256:hash(body),backup_rows_before:before,backup_rows_after:after};
    expect([400,403]).toContain(response.status);expect(response.headers['content-type']).toMatch(/application\/json/u);
    expect(JSON.parse(response.body) as unknown).toMatchObject({error:response.status===400?'invalid_request':'forbidden'});
    expect(before).toBeTypeOf('number');expect(after).toBe(before);
  },15_000);
  it('rejects a backup request one byte over 8 MiB before gateway authentication',async()=>{
    const own=active();const body=exactBody(SPACE_BACKUP_HOST_BODY_BYTES+1);expect(Buffer.byteLength(body)).toBe(SPACE_BACKUP_HOST_BODY_BYTES+1);
    const response=await post(own.primaryOrigin,path,body);statuses.backup_over_limit={...boundedResponse(response),request_bytes:Buffer.byteLength(body)};
    expect(response.status).toBe(413);
  },15_000);
  it('keeps the default 1 MiB body cap on an unrelated v3 route',async()=>{
    const own=active();const body=exactBody(1024*1024+1);const response=await post(own.primaryOrigin,`/v3/zz-canary-${run}`,body);
    statuses.other_route_over_limit={...boundedResponse(response),request_bytes:Buffer.byteLength(body)};expect(response.status).toBe(413);
  },15_000);
  it('requires the trusted upstream gateway CA on the backup location',async()=>{
    const own=active();const response=await post(own.wrongCaOrigin,path,JSON.stringify({payload:{action:'claim'}}));
    statuses.wrong_gateway_ca=boundedResponse(response);expect(response.status).toBe(502);
    expect(await own.nginxLogs('wrong-ca')).toMatch(/upstream SSL certificate verify error.*self-signed certificate in certificate chain/iu);
  },15_000);
});
