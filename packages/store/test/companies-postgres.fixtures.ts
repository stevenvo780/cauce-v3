import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../src/index.js';

export async function seedCompanyActors(pool: DatabasePool): Promise<void> {
  await pool.query("INSERT INTO companies(id,name) VALUES('praxis','Praxis')");
  await pool.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('PraxisHub','praxis',true),('PraxisTeam','praxis',false)");
  for (const [tenant, room, alias] of [['Steven', 'company-humanizar', 'company_admin'],
    ['PraxisHub', 'company-praxis', 'company_admin'], ['PraxisTeam', 'company-team', 'team_agent']]) {
    await pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, tenant]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,true,'codex','company-fixture','dev','/home/dev','/home/dev/.cauce')`, [tenant, alias]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator')", [tenant, room, alias]);
  }
}
export async function seedCompanyHuman(pool: DatabasePool, tenant: string): Promise<string> {
  const id = randomUUID(); const email = `${id}@example.test`;
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Company operator','operator',$4,'company_admin')`, [id, email, '$scrypt$' + 'x'.repeat(48), tenant]);
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,$2,'company_admin','operator',ARRAY['read','control'])`, [id, tenant]);
  return id;
}
export async function linkCompanies(pool: DatabasePool): Promise<void> {
  const id = await seedCompanyHuman(pool, 'Steven');
  await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [id]);
  await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [id]);
  await pool.query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
    VALUES('Steven','PraxisHub',true,true,true,true),('PraxisHub','Steven',true,true,true,true)`);
}

export async function seedCompanyFanin(pool: DatabasePool): Promise<string> {
  const message = async (tenant: string, room: string, body: Record<string, unknown>): Promise<string> => {
    const row = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES($1,'company-fanin',$2,$3,'company_admin',$4::jsonb,'batch') RETURNING id`,
    [randomUUID(), tenant, room, JSON.stringify(body)])).rows[0];
    if (!row) throw new Error('fixture message absent'); return row.id;
  };
  const delivery = async (id: string, tenant: string): Promise<string> => {
    const row = (await pool.query<{ id: string }>(`INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,terminal_at)
      VALUES($1,$2,'company_admin','done',now()) RETURNING id`, [id, tenant])).rows[0];
    if (!row) throw new Error('fixture delivery absent'); return row.id;
  };
  const root = await message('Steven', 'company-humanizar', { text: 'Company fanout' });
  const source = await delivery(root, 'Steven');
  const child = await message('Steven', 'company-humanizar', { text: 'Company branch' });
  const target = await delivery(child, 'PraxisHub');
  const response = await message('PraxisHub', 'company-praxis', { type: 'agent.response', from_alias: 'company_admin',
    text: 'Foreign branch result', correlation: { root_message_id: root, child_delivery_id: target,
      response_to_delivery_id: source, parent_delivery_id: target } });
  const returned = await delivery(response, 'Steven');
  await pool.query(`INSERT INTO agent_output_materializations(source_delivery_id,source_attempt,output_index,
    source_message_id,source_tenant,source_alias,target_tenant,target_alias,target_ref_hash,body_hash,status,
    produced_message_id,produced_delivery_id,request_id,trace_id,hop_count,hop_budget,correlation)
    VALUES($1,1,0,$2,'Steven','company_admin','PraxisHub','company_admin',repeat('a',64),repeat('a',64),
      'materialized',$3,$4,$5,'company-fanin',1,8,$6::jsonb)`,
  [source, root, child, target, randomUUID(), JSON.stringify({ root_message_id: root })]);
  await pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,message_id,delivery_id,metadata)
    VALUES('PraxisHub','company_admin','agent_output.response','allow',$1,$2,$3::jsonb)`,
  [response, returned, JSON.stringify({ child_delivery_id: target, source_delivery_id: source })]);
  return root;
}
