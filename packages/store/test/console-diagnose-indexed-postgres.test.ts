import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';

const PASSWORD = 'diagnostic-index-fixture-password';
const TIME = '2025-01-01T00:00:00Z';
const TABLES = ['audit_events','messages','deliveries','terminal_sessions','fleet_operations',
  'fleet_operation_events','agent_context_outbox','agent_context_versions','space_backups'] as const;
const MAX_EXAMINED_PER_RELATION = 128;
interface Chain { trace: string; message: string; delivery: string; session: string; operation: string; backup: string }
interface Diagnosis { items: { type: string; id: string; company_id: string }[]; truncated: boolean }
interface CapturedQuery { text: string; values: unknown[] }
interface QueryReader { calls: () => readonly (readonly unknown[])[]; offset: number; restore: () => void }
interface PlanMetrics { examined: Record<string, number>; indexes: Set<string>; scanned: Set<string> }
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let app: FastifyInstance | undefined; let pool: DatabasePool; let passwordHash: string | undefined; let cookie: string;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let chains: Chain[];
const readers = new Map<DatabaseClient,QueryReader>();

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database,'database')); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD,{ cost:1024,blockSize:8,parallelism:1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1',[passwordHash]);
  const trace = `zz-canary-indexed-${randomUUID()}`; chains = [];
  for (let index=0; index<fixtures.length; index++) chains.push(await seedChain(index,trace));
  app = await buildTestGateway({ pool,repository:new CauceRepository(pool),
    authProvider:new PasswordAuthProvider({ users:new PostgresConsoleUserStore(pool),signingKey:Buffer.alloc(32,43) }) });
  const login = await server().inject({ method:'POST',url:'/v3/auth/login',headers:{ origin:'http://localhost' },
    payload:{ email:`${identity().company_id}@dev.example`,password:PASSWORD } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie'];
  cookie = requireValue(Array.isArray(cookies) ? cookies[0] : cookies,'cookie').split(';',1)[0] ?? '';
  pool.on('acquire',observeClient);
});
afterEach(async () => {
  pool.removeListener('acquire',observeClient);
  for (const reader of readers.values()) reader.restore(); readers.clear();
  await app?.close(); app=undefined; await current?.close(); current=undefined;
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function server() { return requireValue(app,'gateway'); }
function admin() { return requireValue(current,'case database').adminPool; }
function identity(index=0) { return requireValue(fixtures[index],'identity'); }
function chain(index=0) { return requireValue(chains[index],'chain'); }
function observeClient(client: DatabaseClient): void {
  if (readers.has(client)) return;
  const spy = vi.spyOn(client,'query');
  readers.set(client,{ calls:()=>spy.mock.calls,offset:0,restore:()=>spy.mockRestore() });
}
function takeRounds(): CapturedQuery[] {
  const captured: CapturedQuery[]=[];
  for (const reader of readers.values()) {
    const calls=reader.calls();
    for (const call of calls.slice(reader.offset)) {
      if (typeof call[0]==='string' && call[0].trimStart().startsWith('WITH')
          && call[0].includes('SELECT node_key,at,refs,data,metadata FROM nodes') && Array.isArray(call[1])) {
        captured.push({ text:call[0],values:Array.from(call[1] as readonly unknown[]) });
      }
    }
    reader.offset=calls.length;
  }
  return captured;
}
async function seedChain(index: number,trace: string): Promise<Chain> {
  const value=identity(index); const host=`zz-canary-indexed-${index}`;
  const ids={ trace,message:randomUUID(),delivery:randomUUID(),session:randomUUID(),operation:randomUUID(),backup:randomUUID() };
  await admin().query('INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES($1,$1,$2)',[host,value.company_id]);
  await admin().query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,actor_human_id,actor_alias,created_at)
    VALUES($1,$2,$3,1,'[]'::jsonb,repeat('c',64),'ui',$4,'owner',$5)`,[value.company_id,value.tenant_id,value.alias,value.human_id,TIME]);
  await admin().query('INSERT INTO agent_context_state(company_id,tenant_id,alias,desired_version) VALUES($1,$2,$3,1)',
    [value.company_id,value.tenant_id,value.alias]);
  await admin().query("INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version,state) VALUES($1,$2,$3,1,'synced')",
    [value.company_id,value.tenant_id,value.alias]);
  await admin().query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,created_at)
    VALUES($1,$2,$3,$4,'context-room','owner','{}'::jsonb,'interactive',$5)`,[ids.message,randomUUID(),trace,value.tenant_id,TIME]);
  await admin().query(`INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias,context_version,context_digest,created_at)
    VALUES($1,$2,$3,$4,1,repeat('c',64),$5)`,[ids.delivery,ids.message,value.tenant_id,value.alias,TIME]);
  await admin().query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,container,mode,ticket_sha256,
    reason,trace_id,issued_at,expires_at,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id)
    VALUES($1,$2,true,'indexed-fixture',$3,$4,'indexed-fixture','shell',$5,'fixture',$6,$7,$7::timestamptz+interval '1 hour',$1,$5,$5,1,repeat('a',64))`,
    [ids.session,value.human_id,value.tenant_id,value.alias,Buffer.alloc(32,7),trace,TIME]);
  await admin().query(`INSERT INTO fleet_operations(id,company_id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,
    request,request_hash,idempotency_key,expected_revision,status,created_at)
    VALUES($1::uuid,$2,$3,'owner','{}'::jsonb,$1::text,$1::text,$4,'start','{}'::jsonb,repeat('a',64),$1::text,0,'succeeded',$5)`,
    [ids.operation,value.company_id,value.tenant_id,host,TIME]);
  await admin().query("INSERT INTO fleet_operation_events(operation_id,version,event,created_at) VALUES($1,0,'succeeded',$2)",[ids.operation,TIME]);
  await admin().query(`INSERT INTO space_backups(id,company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256,created_at)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$1::text,'{}'::jsonb,repeat('a',64),$7)`,
    [ids.backup,value.company_id,value.tenant_id,value.alias,host,value.human_id,TIME]);
  await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,message_id,delivery_id,action,decision,metadata,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'delivery.chain','info',$7::jsonb,$8)`,[value.company_id,value.tenant_id,value.alias,trace,ids.message,ids.delivery,
    JSON.stringify({ operation_id:ids.operation,session_id:ids.session,backup_id:ids.backup,delivery_id:ids.delivery }),TIME]);
  await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,action,decision,metadata,created_at)
    VALUES($1,$2,$3,'context.sync','info',$4::jsonb,$5)`,[value.company_id,value.tenant_id,value.alias,
    JSON.stringify({ target_tenant:value.tenant_id,target_alias:value.alias,version:1 }),TIME]);
  return ids;
}
async function growHistory(start: number,count: number): Promise<void> {
  const value=identity(); const prefix=`zz-canary-history-${start}-`; const host='zz-canary-indexed-0';
  await admin().query(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,created_at)
    SELECT gen_random_uuid(),$1||n,$2,'context-room','owner','{}'::jsonb,'interactive',
      $3::timestamptz+CASE WHEN n%2=0 THEN interval '1 day' ELSE interval '-1 day' END FROM generate_series(1,$4::int) n`,
    [prefix,value.tenant_id,TIME,count]);
  await admin().query(`INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,created_at)
    SELECT id,$2,$3,created_at FROM messages WHERE trace_id LIKE $1`,[`${prefix}%`,value.tenant_id,value.alias]);
  await admin().query(`INSERT INTO terminal_sessions(id,operator_id,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,
    trace_id,issued_at,expires_at,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id)
    SELECT gen_random_uuid(),$1,'indexed-history',$2,$3,'indexed-history','shell',$4,'history',$5||n,$6,
      $6::timestamptz+interval '1 hour',gen_random_uuid(),$4,$4,1,repeat('a',64) FROM generate_series(1,$7::int) n`,
    [value.human_id,value.tenant_id,value.alias,Buffer.alloc(32,7),prefix,TIME,count]);
  await admin().query(`INSERT INTO fleet_operations(company_id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,
    request,request_hash,idempotency_key,expected_revision,status,created_at)
    SELECT $1,$2,'owner','{}'::jsonb,$3||n,$3||n,$4,'start','{}'::jsonb,repeat('a',64),$3||n,0,'succeeded',$5
      FROM generate_series(1,$6::int) n`,[value.company_id,value.tenant_id,prefix,host,TIME,count]);
  await admin().query(`INSERT INTO fleet_operation_events(operation_id,version,event,created_at)
    SELECT id,0,'succeeded',created_at FROM fleet_operations WHERE target_key LIKE $1`,[`${prefix}%`]);
  await admin().query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,actor_human_id,actor_alias,created_at)
    SELECT $1,$2,$3,n,'[]'::jsonb,repeat('c',64),'ui',$4,'owner',$5 FROM generate_series($6::int,$7::int) n`,
    [value.company_id,value.tenant_id,value.alias,value.human_id,TIME,start+1,start+count]);
  await admin().query(`INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version)
    SELECT company_id,tenant_id,alias,version FROM agent_context_versions WHERE company_id=$1 AND tenant_id=$2 AND alias=$3
      AND version BETWEEN $4 AND $5`,[value.company_id,value.tenant_id,value.alias,start+1,start+count]);
  await admin().query(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256,created_at)
    SELECT $1,$2,$3,$4,$5,$6||n,'{}'::jsonb,repeat('a',64),$7 FROM generate_series(1,$8::int) n`,
    [value.company_id,value.tenant_id,value.alias,host,value.human_id,prefix,TIME,count]);
  await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,action,decision,metadata,created_at)
    SELECT $1,$2,$3,$4||n,'context.sync','info',jsonb_build_object('target_tenant',$2::text,'target_alias',$3::text,
      'version',$5::int+n,'session_id',gen_random_uuid(),'operation_id',gen_random_uuid(),'backup_id',gen_random_uuid(),'delivery_id',gen_random_uuid()),$6
      FROM generate_series(1,$7::int) n`,[value.company_id,value.tenant_id,value.alias,prefix,start,TIME,count]);
  for (const table of TABLES) await admin().query(`ANALYZE ${table}`);
}
function planMetrics(value: unknown): PlanMetrics {
  const metrics: PlanMetrics={ examined:{},indexes:new Set(),scanned:new Set() };
  function visit(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value as unknown[]) visit(item); return; }
    if (value===null || typeof value!=='object') return;
    const node=value as Record<string,unknown>;
    const relation=node['Relation Name']; const loops=node['Actual Loops']; const type=node['Node Type'];
    if (typeof relation==='string' && TABLES.some(table=>table===relation) && typeof loops==='number' && loops>0) {
      const measure=(key: string) => typeof node[key]==='number' ? node[key] : 0;
      metrics.examined[relation]=(metrics.examined[relation] ?? 0)+loops*(measure('Actual Rows')+measure('Rows Removed by Filter')+measure('Rows Removed by Index Recheck'));
      if (type==='Seq Scan') metrics.scanned.add(relation);
    }
    if (typeof node['Index Name']==='string' && typeof loops==='number' && loops>0) metrics.indexes.add(node['Index Name']);
    for (const child of Object.values(node)) if (child!==null && typeof child==='object') visit(child);
  }
  visit(value); return metrics;
}
async function diagnoseAndExplain(id: string,kind: string,scale: number,expectedStatus=200): Promise<Record<string,number>> {
  takeRounds();
  const response=await server().inject({ method:'GET',url:`/v3/console/diagnose/${encodeURIComponent(id)}`,headers:{ cookie } });
  expect(response.statusCode,response.body).toBe(expectedStatus);
  if (expectedStatus===200) {
    const body=response.json<Diagnosis>();
    expect(body.truncated).toBe(false); expect(body.items).toHaveLength(9);
    expect(new Set(body.items.map(item=>item.type))).toEqual(new Set(['audit','message','delivery','session','operation','operation_event','context','backup']));
    expect(body.items.every(item=>item.company_id===identity().company_id)).toBe(true);
    for (const foreign of Object.values(chain(1)).filter(value=>value!==chain().trace)) expect(response.body).not.toContain(foreign);
  }
  const rounds=takeRounds(); expect(rounds.length).toBeGreaterThan(0);
  const peak: Record<string,number>={};
  for (const [round,query] of rounds.entries()) {
    const result=await pool.query<{ 'QUERY PLAN':unknown }>(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.text}`,query.values);
    const plan=result.rows[0]?.['QUERY PLAN']; const metrics=planMetrics(plan);
    console.info('DIAGNOSTIC_FRONTIER_METRICS',JSON.stringify({ scale,kind,round,examined:metrics.examined,indexes:[...metrics.indexes],sequential:[...metrics.scanned] }));
    if ((scale===6000 && kind==='trace') || metrics.scanned.size>0) {
      console.info('DIAGNOSTIC_FRONTIER_EXPLAIN',JSON.stringify({ scale,kind,round,plan }));
    }
    expect([...metrics.scanned],`${kind} round ${String(round)} scanned history`).toEqual([]);
    for (const [relation,examined] of Object.entries(metrics.examined)) {
      expect(examined,`${kind} round ${String(round)} examined ${relation}`).toBeLessThanOrEqual(MAX_EXAMINED_PER_RELATION);
      peak[relation]=Math.max(peak[relation] ?? 0,examined);
    }
  }
  return peak;
}
describe('indexed diagnostic frontier with signed HTTP and real PostgreSQL',()=>{
  it('keeps every history branch bounded as the active company grows from 1500 to 6000 unrelated rows',async()=>{
    await growHistory(1,1500);
    const initial: Record<string,number>={};
    for (const kind of ['trace','message','delivery','session','operation','backup'] as const) {
      const peak=await diagnoseAndExplain(chain()[kind],kind,1500);
      for (const [relation,examined] of Object.entries(peak)) initial[relation]=Math.max(initial[relation] ?? 0,examined);
    }
    await growHistory(1501,4500);
    const enlarged: Record<string,number>={};
    for (const kind of ['trace','message','delivery','session','operation','backup'] as const) {
      const peak=await diagnoseAndExplain(chain()[kind],kind,6000);
      for (const [relation,examined] of Object.entries(peak)) enlarged[relation]=Math.max(enlarged[relation] ?? 0,examined);
    }
    for (const table of TABLES) {
      expect(initial[table],`${table} must be exercised`).toBeGreaterThan(0);
      expect(enlarged[table] ?? Infinity,`${table} work must not track history size`).toBeLessThanOrEqual((initial[table] ?? 0)*2+16);
    }
    for (const kind of ['message','delivery','session','operation','backup'] as const) await diagnoseAndExplain(chain(1)[kind],`foreign-${kind}`,6000,404);
    await diagnoseAndExplain(randomUUID(),'missing',6000,404);
  });
});
