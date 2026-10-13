import { QuotaOperationsRepository } from '@cauce/store';
import type { V4Person } from './v4-console-real-browser.helpers.js';
import type { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

type ConsoleFixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
type DatabasePool = ConsoleFixture['database']['pool'];
type QuotaAction = 'create' | 'delete';

export function quotaCanaryPerson(label: string, run: string, password?: string): V4Person {
  return {
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    password: password ?? `Canary-${run}-${label}-passphrase-42`,
    company: { name: `zz-canary-${label}-${run}`, slug: `zz-canary-${label}-${run}` },
  };
}

export async function seedQuotaCompanyAdmin(pool: DatabasePool, owner: V4Person, run: string): Promise<V4Person> {
  const ownerRow = (await pool.query<{ id: string; tenant_id: string }>(
    'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0];
  if (!ownerRow) throw new Error('quota canary owner was not registered');

  const admin = quotaCanaryPerson('admin', run, owner.password);
  const alias = `zz-canary-admin-${run}`;
  const runtimeUser = `zz-canary-${run}`;
  const adminRow = (await pool.query<{ id: string }>(`INSERT INTO console_users
    (email,email_normalized,password_hash,display_name,role,tenant_id,alias,company_id)
    SELECT $1,lower($1),owner.password_hash,$2,'operator',owner.tenant_id,$3,owner.company_id
      FROM console_users owner WHERE owner.id=$4 RETURNING id::text`,
  [admin.email, admin.name, alias, ownerRow.id])).rows[0];
  if (!adminRow) throw new Error('quota canary administrator was not created');

  await pool.query(`INSERT INTO agents
    (tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
    SELECT tenant_id,$2,'codex',$2,true,$3,$4,$5,$6,company_id FROM console_users WHERE id=$1`,
  [adminRow.id, alias, `zz-canary-agent-${run}`, runtimeUser, `/srv/zz-canary-${run}`, `/srv/zz-canary-${run}/state`]);
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'operator')", [ownerRow.tenant_id, alias]);
  await pool.query(`INSERT INTO human_tenant_memberships
    (human_id,tenant_id,actor_alias,role,permissions,enabled,company_id)
    SELECT $1,$2,$3,'operator',ARRAY['route','read','control','notify']::text[],true,company_id
      FROM console_users WHERE id=$1`, [adminRow.id, ownerRow.tenant_id, alias]);
  await pool.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
    SELECT company_id,$1,'admin','import',$2 FROM console_users WHERE id=$2`, [adminRow.id, ownerRow.id]);
  return admin;
}

export async function finishQuotaOperation(pool: DatabasePool, run: string, hostId: string, action: QuotaAction): Promise<string> {
  const worker = new QuotaOperationsRepository(pool);
  const claim = await worker.claim(`zz-canary-${run}`, hostId);
  if (!claim) throw new Error(`quota ${action} operation was not claimable`);
  const execution = await worker.execution(claim);
  if (execution.action !== action) throw new Error(`expected quota ${action} operation, received ${execution.action}`);
  const receipt = action === 'create'
    ? { runtime_verified: true }
    : { stopped_verified: true, profile_removed_verified: true };
  await worker.finish(claim, receipt);
  return claim.environment_id;
}
