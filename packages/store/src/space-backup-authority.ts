import type { CompanyAuthority } from './company-authority.js';
import { lockCompanyAuthority } from './company-authority.js';
import { StoreError } from './repository/errors.js';
import type { DatabaseClient } from './db.js';
import { SpaceBackupAgentSchema,type SpaceBackupAgent,type SpaceBackupRow } from './space-backup-contracts.js';
function legacyRuntimeMode(row:Record<string,unknown>):string {
  const container=row.container_name;
  return typeof container==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(container)?'legacy-container':'invalid';
}
export async function assertSpaceBackupPolicy(client:DatabaseClient,row:SpaceBackupRow):Promise<void> {
  const capability=(await client.query<{policy_sha256:string}>(`SELECT capabilities->>'policy_sha256' AS policy_sha256 FROM fleet_host_identities
    WHERE host_id=$1 AND company_id=$2 AND enabled AND (capabilities->>'space_backup'='true' OR capabilities->>'fleet_executor'='true')
      AND capabilities_seen_at>now()-interval '120 seconds'`,[row.host_id,row.company_id])).rows[0];
  if (capability?.policy_sha256!==row.policy_sha256) throw new StoreError('conflict','space backup host policy changed');
}
export function assertSpaceBackupAuthority(authority:CompanyAuthority,tenant:string):void {
  if (authority.humanId===null || !(['company_owner','company_admin','platform_admin'].includes(authority.role)
    || authority.role==='tenant_operator'&&authority.homeTenant===tenant)) throw new StoreError('forbidden','space backup control is required');
}
export async function readSpaceBackupAgent(client:DatabaseClient,company:string,tenant:string,alias:string):Promise<SpaceBackupAgent> {
  const row:unknown=(await client.query(`SELECT agent.company_id,agent.tenant_id,agent.alias,agent.runtime_key,agent.host_id,agent.harness_id,
    agent.runtime_mode,agent.container_name,agent.runtime_user,agent.home_directory,agent.state_directory,agent.systemd_user
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id AND tenant.company_id=agent.company_id
    WHERE agent.company_id=$1 AND agent.tenant_id=$2 AND agent.alias=$3 AND agent.purged_at IS NULL
      AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL FOR SHARE OF agent,tenant`,[company,tenant,alias])).rows[0];
  const candidate=row!==null&&typeof row==='object'&&!Array.isArray(row)
    &&(row as {runtime_mode?:unknown}).runtime_mode===null
    ?{...(row as Record<string,unknown>),runtime_mode:legacyRuntimeMode(row as Record<string,unknown>)}:row;
  const parsed=SpaceBackupAgentSchema.safeParse(candidate);
  if (!parsed.success) throw new StoreError('not_found','a placed space backup target is required');
  return parsed.data;
}
// Listing only needs the agent in this company: an agent not yet placed on a computer has no copies, not a missing target.
export async function assertSpaceBackupAgentExists(client:DatabaseClient,company:string,tenant:string,alias:string):Promise<void> {
  const found=(await client.query(`SELECT 1 FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id AND tenant.company_id=agent.company_id
    WHERE agent.company_id=$1 AND agent.tenant_id=$2 AND agent.alias=$3 AND agent.purged_at IS NULL
      AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL FOR SHARE OF agent,tenant`,[company,tenant,alias])).rowCount;
  if (!found) throw new StoreError('not_found','space backup agent is unavailable');
}
export async function authorizeSpaceBackupRequester(client:DatabaseClient,row:SpaceBackupRow):Promise<void> {
  await assertSpaceBackupPolicy(client,row);
  const person=(await client.query<{tenant_id:string;alias:string}>('SELECT tenant_id,alias FROM console_users WHERE id=$1',[row.requested_by])).rows[0];
  if (!person) throw new StoreError('forbidden','space backup requester is unavailable');
  const authority=await lockCompanyAuthority(client,{tenant:person.tenant_id,alias:person.alias,humanId:row.requested_by,requestedCompany:row.company_id});
  assertSpaceBackupAuthority(authority,row.tenant_id);
  if (authority.actingCompany!==row.company_id) throw new StoreError('forbidden','space backup company authority was revoked');
}
