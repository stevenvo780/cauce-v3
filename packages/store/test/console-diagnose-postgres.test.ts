import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';

interface Identity { company_id: string; tenant_id: string; alias: string; human_id: string; room_id?: string }
interface Chain extends Identity { trace: string; operation: string; session: string; delivery: string; backup: string; message: string; event: string; unrelated: string }
interface DiagnosisItem { type: string; id: string; at: string; company_id: string; tenant_id: string | null; alias: string | null; host_id: string | null; component: string; action?: string; summary?: string | null }
interface Diagnosis { id: string; company_id: string; items: DiagnosisItem[]; truncated: boolean }
const PASSWORD = 'diagnose-http-fixture-password'; const ORIGIN = 'http://localhost';
const PRIVATE = 'zz-canary-diagnose-private-data'; const TIME = '2025-01-01T00:00:00.000Z';
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: readonly Identity[]; let chains: Chain[]; let app: FastifyInstance | undefined;
let passwordHash: string | undefined; let cookie: string; let csrf: string;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  chains = [];
  for (const value of fixtures) chains.push(await seedChain(value));
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 29) });
  app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: provider });
  await login();
});
afterEach(async () => { await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function identity(index = 0) { const value = fixtures[index]; if (!value) throw new Error('identity unavailable'); return value; }
function chain(index = 0) { const value = chains[index]; if (!value) throw new Error('chain unavailable'); return value; }
function server() { if (!app) throw new Error('gateway unavailable'); return app; }
function admin() { if (!current) throw new Error('case database unavailable'); return current.adminPool; }
function sessionCookie(response: LightMyRequestResponse) {
  const headers = response.headers['set-cookie']; const header = Array.isArray(headers) ? headers[0] : headers;
  if (!header) throw new Error('session cookie unavailable');
  return header.split(';', 1)[0] ?? '';
}
async function login(index = 0) {
  const response = await server().inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email: `${identity(index).company_id}@dev.example`, password: PASSWORD } });
  expect(response.statusCode).toBe(200); cookie = sessionCookie(response); csrf = response.json<{ csrf_token: string }>().csrf_token;
}
function diagnose(id: string, authorized = true) { return server().inject({ method: 'GET', url: `/v3/console/diagnose/${encodeURIComponent(id)}`,
  headers: authorized ? { cookie } : {} }); }
async function seedBackup(value: Identity, host: string, id: string) {
  await admin().query(`INSERT INTO space_backups(id,company_id,tenant_id,alias,host_id,requested_by,idempotency_key,
    agent_snapshot,policy_sha256,claim_token,created_at) VALUES($1::uuid,$2,$3,$4,$5,$6,$1::text,$7::jsonb,$8,$9,$10)`,
  [id,value.company_id,value.tenant_id,value.alias,host,value.human_id,JSON.stringify({ private: PRIVATE }), 'a'.repeat(64), randomUUID(),TIME]);
}
async function seedChain(value: Identity): Promise<Chain> {
  const ids = { trace: `zz-canary-diagnose-${randomUUID()}`, operation: randomUUID(), session: randomUUID(), delivery: randomUUID(),
    backup: randomUUID(), message: randomUUID(), unrelated: randomUUID() };
  const host = `zz-canary-${value.tenant_id.toLowerCase()}`;
  await admin().query('INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES($1,$1,$2) ON CONFLICT DO NOTHING', [host,value.company_id]);
  await admin().query('UPDATE agents SET host_id=$1 WHERE company_id=$2 AND tenant_id=$3 AND alias=$4', [host,value.company_id,value.tenant_id,value.alias]);
  await admin().query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,actor_human_id,actor_alias,created_at)
    VALUES($1,$2,$3,1,$4::jsonb,$5,'ui',$6,'owner',$7)`, [value.company_id,value.tenant_id,value.alias,
    JSON.stringify([{ path: 'context/mission.md', content: PRIVATE }]),'c'.repeat(64),value.human_id,TIME]);
  await admin().query('INSERT INTO agent_context_state(company_id,tenant_id,alias,desired_version) VALUES($1,$2,$3,1)',
    [value.company_id,value.tenant_id,value.alias]);
  await admin().query(`INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version,state,last_error,apply_error,git_commit)
    VALUES($1,$2,$3,1,'error','context_git_authentication_failed',$4,$5)`,
  [value.company_id,value.tenant_id,value.alias,PRIVATE,'b'.repeat(40)]);
  await admin().query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,created_at)
    VALUES($1,$2,$3,$4,$5,'owner',$6::jsonb,$6::jsonb,'interactive',$7)`,
  [ids.message,randomUUID(),ids.trace,value.tenant_id,value.room_id ?? 'context-room',JSON.stringify({ type: 'command', text: PRIVATE, token: PRIVATE }),TIME]);
  await admin().query(`INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias,last_error,result,context_version,context_digest,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8)`,
  [ids.delivery,ids.message,value.tenant_id,value.alias,PRIVATE,JSON.stringify({ output: PRIVATE, token: PRIVATE }),'c'.repeat(64),TIME]);
  await admin().query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,
    trace_id,issued_at,expires_at,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id)
    VALUES($1,$2,true,$3,$4,$5,$3,'shell',$6,$3,$7,$8,$8::timestamptz+interval '1 hour',$1,$6,$6,1,repeat('a',64))`,
  [ids.session,value.human_id,PRIVATE,value.tenant_id,value.alias,Buffer.alloc(32,7),ids.trace,TIME]);
  await admin().query(`INSERT INTO fleet_operations(id,company_id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,
    request,request_hash,idempotency_key,expected_revision,status,error,worker_id,claim_token,lease_expires_at,created_at,updated_at)
    VALUES($1::uuid,$2,$3,'owner',$4::jsonb,$1::text,$1::text,$5,'start',$6::jsonb,$7,$1::text,0,'failed',$6::jsonb,$8,$9,$10,$10,$10)`,
  [ids.operation,value.company_id,value.tenant_id,JSON.stringify({ tenant_id:value.tenant_id,alias:value.alias }),host,
    JSON.stringify({ code:'HOST_UNAVAILABLE',step:'runtime',retryable:true,private:PRIVATE,message:PRIVATE,token:PRIVATE }), 'a'.repeat(64),PRIVATE,randomUUID(),TIME]);
  const event = (await admin().query<{ id: string }>(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata,created_at)
    VALUES($1,0,'failed',$2::jsonb,$3) RETURNING id::text`, [ids.operation,JSON.stringify({ code:'STEP_FAILED',step:'verify',private:PRIVATE,token:PRIVATE }),TIME])).rows[0]?.id;
  if (!event) throw new Error('operation event unavailable');
  await seedBackup(value,host,ids.backup); await seedBackup(value,host,ids.unrelated);
  await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,delivery_id,message_id,action,decision,metadata,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'delivery.chain','info',$7::jsonb,$8)`, [value.company_id,value.tenant_id,value.alias,ids.trace,ids.delivery,ids.message,
    JSON.stringify({ operation_id:ids.operation,session_id:ids.session,backup_id:ids.backup,delivery_id:ids.delivery,message_id:ids.message,
      target_tenant:value.tenant_id,target_alias:value.alias,version:1,host_id:host,component:'delivery',token:PRIVATE,
      payload:{secret:PRIVATE},cause:PRIVATE }),TIME]);
  await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,action,decision,metadata,created_at)
    VALUES($1,$2,$3,'context.sync','info',$4::jsonb,$5)`,[value.company_id,value.tenant_id,value.alias,
    JSON.stringify({ target_tenant:value.tenant_id,target_alias:value.alias,version:1,host_id:host,component:'context',
      error_code:'context_git_authentication_failed',token:PRIVATE }),TIME]);
  return { ...value,...ids,event };
}
function assertChain(response: LightMyRequestResponse, id: string, expected = chain()) {
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  const body = response.json<Diagnosis>();
  expect(body).toMatchObject({ id,company_id:expected.company_id,truncated:false });
  expect(new Set(body.items.map(item => item.type))).toEqual(new Set(['audit','delivery','message','session','operation','operation_event','context','backup']));
  expect(body.items.every(item => item.company_id===expected.company_id && item.tenant_id===expected.tenant_id)).toBe(true);
  for (const [type,rowId] of [['delivery',expected.delivery],['message',expected.message],['session',expected.session],
    ['operation',expected.operation],['operation_event',expected.event],['backup',expected.backup]]) {
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ type,id:rowId })]));
  }
  expect(body.items.some(item => item.id===expected.unrelated)).toBe(false);
  expect(body.items.find(item=>item.type==='audit' && item.action==='context.sync')?.summary).toContain('context_git_authentication_failed');
  expect(body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({type:'operation',id:expected.operation,error_code:'HOST_UNAVAILABLE',step:'runtime'}),
    expect.objectContaining({type:'operation_event',id:expected.event,error_code:'STEP_FAILED',step:'verify'}),
  ]));
  expect(body.items.every(item => typeof item.component==='string' && item.component.length>0)).toBe(true);
  expect(body.items.some(item => item.host_id===`zz-canary-${expected.tenant_id.toLowerCase()}`)).toBe(true);
  const keys = body.items.map(item => `${item.at}\u0000${item.type}\u0000${item.id}`);
  expect(keys).toEqual([...keys].sort());
  expect(response.body).not.toContain(PRIVATE);
  for (const key of ['ticket_sha256','request_sha256','browser_owner_sha256','claim_token','agent_snapshot','files','worker_id','console_subject']) {
    expect(response.body).not.toContain(`"${key}"`);
  }
  return body;
}

describe('company scoped diagnosis through a signed human session and real PostgreSQL', () => {
  it.each(['trace','operation','session','delivery','backup'] as const)('reconstructs the complete chain from a %s identifier', async kind => {
    const id = chain()[kind]; assertChain(await diagnose(id),id);
  });
  it('normalizes UUID identifiers while preserving exact trace identifiers', async () => {
    const id = chain().operation.toUpperCase(); assertChain(await diagnose(id),id);
    expect((await diagnose(chain().trace.toUpperCase())).statusCode).toBe(404);
  });
  it('rejects every foreign company identifier without disclosing existence', async () => {
    for (const kind of ['trace','operation','session','delivery','backup'] as const) expect((await diagnose(chain(1)[kind])).statusCode).toBe(404);
    expect((await diagnose(randomUUID())).statusCode).toBe(404);
    expect([401,403]).toContain((await diagnose(chain().trace,false)).statusCode);
  });
  it('scopes a shared trace before discovering related identifiers', async () => {
    await admin().query('UPDATE messages SET trace_id=$1 WHERE id=$2',[chain().trace,chain(1).message]);
    await admin().query('UPDATE terminal_sessions SET trace_id=$1 WHERE id=$2',[chain().trace,chain(1).session]);
    await admin().query('UPDATE audit_events SET trace_id=$1 WHERE delivery_id=$2',[chain().trace,chain(1).delivery]);
    const body = assertChain(await diagnose(chain().trace),chain().trace);
    expect(JSON.stringify(body)).not.toContain(chain(1).operation);
    expect(JSON.stringify(body)).not.toContain(chain(1).session);
    expect(JSON.stringify(body)).not.toContain(chain(1).backup);
  });
  it('does not use matching agent identity as an unrelated backup connection', async () => {
    const response = await diagnose(chain().unrelated); expect(response.statusCode).toBe(200);
    const body = response.json<Diagnosis>();
    expect(body.items).toEqual([expect.objectContaining({ type:'backup',id:chain().unrelated })]);
  });
  it('keeps context history as a leaf instead of joining another conversation on the same version', async () => {
    const value=chain(); const other={ message:randomUUID(),delivery:randomUUID(),trace:`zz-canary-other-flow-${randomUUID()}` };
    await admin().query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,created_at)
      VALUES($1,$2,$3,$4,'context-room','owner',$5::jsonb,'interactive',$6)`,
    [other.message,randomUUID(),other.trace,value.tenant_id,JSON.stringify({type:'command',text:PRIVATE}),TIME]);
    await admin().query(`INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias,context_version,context_digest,created_at)
      VALUES($1,$2,$3,$4,1,$5,$6)`,[other.delivery,other.message,value.tenant_id,value.alias,'c'.repeat(64),TIME]);
    const adopted=(await admin().query<{id:string}>(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,delivery_id,action,decision,metadata,created_at)
      VALUES($1,$2,$3,$4,$5,'context.adopted','allow',$6::jsonb,$7) RETURNING id::text`,
    [value.company_id,value.tenant_id,value.alias,other.trace,other.delivery,JSON.stringify({delivery_id:other.delivery,
      target_tenant:value.tenant_id,target_alias:value.alias,version:1,component:'context'}),TIME])).rows[0]?.id;
    if(!adopted) throw new Error('adoption event unavailable');
    const response=await diagnose(value.delivery); const body=assertChain(response,value.delivery);
    expect(body.items.some(item=>item.id===other.delivery || item.id===other.message || (item.type==='audit' && item.id===adopted))).toBe(false);
    expect(response.body).not.toContain(other.trace);
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({type:'audit',action:'context.sync'})]));
  });
  it('omits unknown error codes and steps without returning their raw metadata', async () => {
    await admin().query('UPDATE fleet_operations SET error=$1::jsonb WHERE id=$2',
      [JSON.stringify({code:PRIVATE,step:PRIVATE,message:PRIVATE}),chain().operation]);
    const event=(await admin().query<{id:string}>(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata,created_at)
      VALUES($1,1,'failed',$2::jsonb,$3) RETURNING id::text`,[chain().operation,JSON.stringify({code:PRIVATE,step:PRIVATE,token:PRIVATE}),TIME])).rows[0]?.id;
    if(!event) throw new Error('unknown error event unavailable');
    const response=await diagnose(chain().operation); expect(response.statusCode).toBe(200);
    const body=response.json<Diagnosis>();
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({type:'operation',id:chain().operation,error_code:null,step:null}),
      expect.objectContaining({type:'operation_event',id:event,error_code:null,step:null})]));
    expect(response.body).not.toContain(PRIVATE);
  });
  it('bounds a large trace and reports truncation with deterministic ordering', async () => {
    const value=identity(); const trace=`zz-canary-large-trace-${randomUUID()}`;
    await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,action,decision,metadata,created_at)
      SELECT $1,$2,$3,$4,'delivery.note','info','{"component":"delivery","state":"pending"}'::jsonb,$5
      FROM generate_series(1,501)`,[value.company_id,value.tenant_id,value.alias,trace,TIME]);
    const first=await diagnose(trace); expect(first.statusCode).toBe(200);
    const body=first.json<Diagnosis>(); expect(body.truncated).toBe(true); expect(body.items).toHaveLength(500);
    expect(new Set(body.items.map(item=>item.id)).size).toBe(500);
    expect(body.items.every(item=>item.company_id===value.company_id && item.type==='audit')).toBe(true);
    const ids=body.items.map(item=>BigInt(item.id)); const firstId=ids[0];
    if(firstId===undefined) throw new Error('first diagnostic event unavailable');
    expect(ids).toEqual(Array.from({length:500},(_,index)=>firstId+BigInt(index)));
    const again=await diagnose(trace); expect(again.statusCode).toBe(200); expect(again.json<Diagnosis>().items).toEqual(body.items);
  });
  it('rejects unsupported query filters and control characters in identifiers', async () => {
    const query=await server().inject({method:'GET',url:`/v3/console/diagnose/${chain().trace}?company_id=context_beta`,headers:{cookie}});
    expect(query.statusCode).toBe(422);
    expect((await diagnose('zz-canary\ninvalid')).statusCode).toBe(422);
  });
  it('reports runtime adoption failure independently from successful Git synchronization', async () => {
    const value=identity();
    await admin().query(`UPDATE agent_context_outbox SET state='synced',last_error=NULL,applied_at=NULL,
      apply_error='context_runtime_verification_failed' WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=1`,
    [value.company_id,value.tenant_id,value.alias]);
    const response=await diagnose(chain().delivery); expect(response.statusCode).toBe(200);
    expect(response.json<Diagnosis>().items).toEqual(expect.arrayContaining([expect.objectContaining({
      type:'context',state:'synced',error_code:null,application_state:'error',application_error_code:'context_runtime_verification_failed',
    })]));
    expect(response.body).not.toContain(PRIVATE);
  });
  it.each([['256 ASCII characters','t'.repeat(256)],['an encoded slash path','zz-canary/audit/trace']])(
    'accepts %s as a trace identifier through the actual HTTP router',async(_label,trace)=>{
      await admin().query('UPDATE messages SET trace_id=$1 WHERE id=$2',[trace,chain().message]);
      await admin().query('UPDATE terminal_sessions SET trace_id=$1 WHERE id=$2',[trace,chain().session]);
      await admin().query('UPDATE audit_events SET trace_id=$1 WHERE delivery_id=$2',[trace,chain().delivery]);
      assertChain(await diagnose(trace),trace);
      expect((await diagnose('t'.repeat(257))).statusCode).toBe(422);
    });
  it('connects a backup only to its actual request audit when no synthetic bridge exists',async()=>{
    const value=chain();
    await admin().query("DELETE FROM audit_events WHERE action='delivery.chain' AND delivery_id=$1",[value.delivery]);
    const audit=(await admin().query<{id:string}>(`INSERT INTO audit_events(tenant_id,actor_alias,company_id,actor_human_id,action,decision,metadata,created_at)
      VALUES($1,'owner',$2,$3,'space.backup.request','allow',$4::jsonb,$5) RETURNING id::text`,
    [value.tenant_id,value.company_id,value.human_id,JSON.stringify({id:value.backup,tenant_id:value.tenant_id,alias:value.alias}),TIME])).rows[0]?.id;
    if(!audit) throw new Error('backup audit unavailable');
    const response=await diagnose(value.backup); expect(response.statusCode).toBe(200);
    const body=response.json<Diagnosis>();
    expect(body.items).toHaveLength(2);
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({type:'backup',id:value.backup}),
      expect.objectContaining({type:'audit',id:audit,action:'space.backup.request'})]));
    expect(response.body).not.toContain(value.delivery);
    expect(response.body).not.toContain(value.unrelated);
  });
  it('connects an operation to its event foreign keys without inventing other workflow links',async()=>{
    const value=chain();
    await admin().query("DELETE FROM audit_events WHERE action='delivery.chain' AND delivery_id=$1",[value.delivery]);
    const response=await diagnose(value.operation); expect(response.statusCode).toBe(200);
    const body=response.json<Diagnosis>();
    expect(body.items).toHaveLength(2);
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({type:'operation',id:value.operation}),
      expect.objectContaining({type:'operation_event',id:value.event})]));
    for(const id of [value.session,value.backup,value.delivery]) expect(response.body).not.toContain(id);
  });
  it('uses terminal trace and session_id audit references without a synthetic cross-component bridge',async()=>{
    const value=chain();
    const trace=`trace-${randomUUID()}`;
    await admin().query("DELETE FROM audit_events WHERE action='delivery.chain' AND delivery_id=$1",[value.delivery]);
    await admin().query('UPDATE terminal_sessions SET trace_id=$1 WHERE id=$2',[trace,value.session]);
    const audit=(await admin().query<{id:string}>(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,action,decision,metadata,created_at,trace_id)
      VALUES($1,$2,'owner','terminal.session.request','allow',$3::jsonb,$4,$5) RETURNING id::text`,
    [value.company_id,value.tenant_id,JSON.stringify({session_id:value.session,mode:'shell'}),TIME,trace])).rows[0]?.id;
    if(!audit) throw new Error('terminal audit unavailable');
    const response=await diagnose(value.session); expect(response.statusCode).toBe(200);
    const body=response.json<Diagnosis>();
    expect(new Set(body.items.map(item=>item.type))).toEqual(new Set(['session','audit']));
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({type:'session',id:value.session}),
      expect.objectContaining({type:'audit',id:audit,action:'terminal.session.request'})]));
    for(const id of [value.operation,value.backup,value.unrelated,value.delivery,value.message]) expect(response.body).not.toContain(id);
    expect(response.body).not.toContain(PRIVATE);
  });
  it('revalidates revoked human authority on a still signed session', async () => {
    assertChain(await diagnose(chain().trace),chain().trace);
    await admin().query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1',[identity().human_id]);
    expect((await diagnose(chain().trace)).statusCode).toBe(403);
  });
  it('limits platform administrators to their signed active company', async () => {
    await admin().query('INSERT INTO platform_admins(human_id) VALUES($1)',[identity().human_id]); await login();
    assertChain(await diagnose(chain().trace),chain().trace);
    expect((await diagnose(chain(1).trace)).statusCode).toBe(404);
    const switched = await server().inject({ method:'POST',url:'/v3/auth/session/company',
      headers:{cookie,origin:ORIGIN,'x-csrf-token':csrf},payload:{company_id:identity(1).company_id} });
    expect(switched.statusCode).toBe(200); cookie = sessionCookie(switched);
    assertChain(await diagnose(chain(1).trace),chain(1).trace,chain(1));
    expect((await diagnose(chain().trace)).statusCode).toBe(404);
  });
  it('keeps tenant readers in their home tenant even within the same company', async () => {
    const home = identity(); const sibling = { ...home,tenant_id:'ContextAlphaSibling',room_id:'context-sibling-room' };
    await admin().query('INSERT INTO tenants(id,company_id) VALUES($1,$2)',[sibling.tenant_id,sibling.company_id]);
    await admin().query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)',[sibling.room_id,sibling.tenant_id]);
    await admin().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name) VALUES($1,'owner','fake','Owner'),($1,'director','fake','Director')`,[sibling.tenant_id]);
    await admin().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,'owner','operator'),($1,$2,'director','agent')",[sibling.tenant_id,sibling.room_id]);
    const siblingChain = await seedChain(sibling);
    await admin().query(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES('diagnose-reader@example.test','diagnose-reader@example.test',$1,'Reader','reader',$2,'owner')`,[passwordHash,home.tenant_id]);
    const reader = (await admin().query<{ id:string }>("SELECT id FROM console_users WHERE email_normalized='diagnose-reader@example.test'")).rows[0]?.id;
    if (!reader) throw new Error('reader unavailable');
    await admin().query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,$2,'owner','reader',ARRAY['read'])",[reader,home.tenant_id]);
    const response = await server().inject({ method:'POST',url:'/v3/auth/login',headers:{origin:ORIGIN},
      payload:{email:'diagnose-reader@example.test',password:PASSWORD} });
    expect(response.statusCode).toBe(200); cookie=sessionCookie(response);
    assertChain(await diagnose(chain().trace),chain().trace);
    for (const kind of ['trace','operation','session','delivery','backup'] as const) expect((await diagnose(siblingChain[kind])).statusCode).toBe(404);
  });
});
