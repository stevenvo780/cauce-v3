import { withTransaction,type DatabaseClient,type DatabasePool } from './db.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { assertSpaceBackupAgentExists,assertSpaceBackupAuthority,readSpaceBackupAgent } from './space-backup-authority.js';
import { SPACE_BACKUP_COMPANY_BYTES,SPACE_BACKUP_GLOBAL_BYTES,SPACE_BACKUP_MAX_BYTES,
  SpaceBackupRequestSchema,spaceBackupReceipt,type SpaceBackupQuotaLimits,type SpaceBackupRow } from './space-backup-contracts.js';
function limits(value:SpaceBackupQuotaLimits) {
  const company=value.companyMaxBytes??SPACE_BACKUP_COMPANY_BYTES;const global=value.globalMaxBytes??SPACE_BACKUP_GLOBAL_BYTES;
  if (![company,global].every(amount=>Number.isSafeInteger(amount)&&amount>=SPACE_BACKUP_MAX_BYTES)||company>global) throw new Error('Space backup byte limits are invalid');
  return {company,global};
}
export async function assertSpaceBackupByteCapacity(client:DatabaseClient,companyId:string,options:SpaceBackupQuotaLimits={},additional=0):Promise<void> {
  const quota=limits(options);await client.query('SELECT pg_advisory_xact_lock($1)',[783_003_060]);
  const usage=(await client.query<{company:string;global:string}>(`SELECT
    COALESCE(sum(reserved) FILTER (WHERE company_id=$1),0)::text AS company,COALESCE(sum(reserved),0)::text AS global
    FROM (SELECT company_id,CASE WHEN status IN ('pending','running') THEN $2::bigint
      ELSE COALESCE(bytes,received_bytes)::bigint END AS reserved FROM space_backups WHERE expires_at>now()) active`,
  [companyId,SPACE_BACKUP_MAX_BYTES])).rows[0];
  if (Number(usage?.company??0)+additional>quota.company) throw new StoreError('conflict','space backup company byte reservation limit reached');
  if (Number(usage?.global??0)+additional>quota.global) throw new StoreError('conflict','space backup global byte reservation limit reached');
}
export class SpaceBackupRepository {
  constructor(readonly pool:DatabasePool,readonly quota:SpaceBackupQuotaLimits={}) {limits(quota);}
  enqueue(source:CompanyAuthoritySource,tenant:string,alias:string,value:unknown) {
    const input=SpaceBackupRequestSchema.parse(value);
    return withTransaction(this.pool,async client=>{
      const authority=await source(client);assertSpaceBackupAuthority(authority,tenant);
      const agent=await readSpaceBackupAgent(client,authority.actingCompany,tenant,alias);
      const capability=(await client.query<{policy_sha256:string}>(`SELECT identity.capabilities->>'policy_sha256' AS policy_sha256
        FROM fleet_host_identities identity JOIN fleet_hosts host ON host.host_id=identity.host_id AND host.company_id=identity.company_id
        WHERE identity.host_id=$1 AND identity.company_id=$2 AND identity.enabled AND host.enabled
          AND identity.capabilities_seen_at>now()-interval '120 seconds' AND identity.capabilities->>'fleet_executor'='true' FOR SHARE OF identity,host`,
        [agent.host_id,authority.actingCompany])).rows[0];
      await client.query('SELECT pg_advisory_xact_lock($1)',[783_003_060]);
      await client.query(`UPDATE space_backups SET status='failed',error='EXPIRED',lease_until=NULL
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND idempotency_key=$4 AND expires_at<=now()`,
      [authority.actingCompany,tenant,alias,input.idempotency_key]);
      const previous=(await client.query<SpaceBackupRow>('SELECT * FROM space_backups WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND idempotency_key=$4',
        [authority.actingCompany,tenant,alias,input.idempotency_key])).rows[0];
      if (previous) return spaceBackupReceipt(previous);
      await assertSpaceBackupByteCapacity(client,authority.actingCompany,this.quota,SPACE_BACKUP_MAX_BYTES);
      if (!capability) throw new StoreError('conflict','space backup host is unavailable');
      const pending=(await client.query<{count:string}>('SELECT count(*)::text AS count FROM space_backups WHERE company_id=$1 AND expires_at>now()',[authority.actingCompany])).rows[0];
      if (Number(pending?.count??0)>=20) throw new StoreError('conflict','space backup company retention limit reached');
      const global=(await client.query<{count:string}>('SELECT count(*)::text AS count FROM space_backups WHERE expires_at>now()')).rows[0];
      if (Number(global?.count??0)>=200) throw new StoreError('conflict','space backup global retention limit reached');
      const row=(await client.query<SpaceBackupRow>(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[authority.actingCompany,tenant,alias,agent.host_id,authority.humanId,input.idempotency_key,JSON.stringify(agent),capability.policy_sha256])).rows[0];
      if (!row) throw new StoreError('conflict','space backup was not persisted');
      await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,company_id,actor_human_id,action,decision,metadata)
        VALUES($1,$2,$3,$4,'space.backup.request','allow',$5::jsonb)`,[authority.homeTenant,authority.alias,authority.actingCompany,authority.humanId,JSON.stringify({id:row.id,tenant_id:tenant,alias,host_id:row.host_id,component:'backup'})]);
      return spaceBackupReceipt(row);
    });
  }
  list(source:CompanyAuthoritySource,tenant:string,alias:string) {
    return withTransaction(this.pool,async client=>{
      const authority=await source(client);assertSpaceBackupAuthority(authority,tenant);
      await assertSpaceBackupAgentExists(client,authority.actingCompany,tenant,alias);
      await client.query("UPDATE space_backups SET status='failed',error='EXPIRED',lease_until=NULL WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND expires_at<=now()",
        [authority.actingCompany,tenant,alias]);
      const rows=(await client.query<SpaceBackupRow>('SELECT * FROM space_backups WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY created_at DESC,id DESC',
        [authority.actingCompany,tenant,alias])).rows;
      return rows.map(spaceBackupReceipt);
    });
  }
  remove(source:CompanyAuthoritySource,tenant:string,alias:string,id:string,removeCopy:(row:SpaceBackupRow)=>Promise<void>):Promise<void> {
    return withTransaction(this.pool,async client=>{
      const authority=await source(client);assertSpaceBackupAuthority(authority,tenant);
      await readSpaceBackupAgent(client,authority.actingCompany,tenant,alias);
      await client.query('SELECT pg_advisory_xact_lock($1)',[783_003_060]);
      const row=(await client.query<SpaceBackupRow>('SELECT * FROM space_backups WHERE id=$1 AND company_id=$2 AND tenant_id=$3 AND alias=$4 FOR UPDATE',
        [id,authority.actingCompany,tenant,alias])).rows[0];
      if (!row) throw new StoreError('not_found','space backup is unavailable');
      await removeCopy(row);
      await client.query('DELETE FROM space_backups WHERE id=$1',[row.id]);
      await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,company_id,actor_human_id,action,decision,metadata)
        VALUES($1,$2,$3,$4,'space.backup.delete','allow',$5::jsonb)`,[authority.homeTenant,authority.alias,authority.actingCompany,authority.humanId,
        JSON.stringify({id:row.id,tenant_id:tenant,alias,host_id:row.host_id,component:'backup'})]);
    });
  }
  async scoped<T>(source:CompanyAuthoritySource,tenant:string,alias:string,id:string,work:(row:SpaceBackupRow,client:DatabaseClient)=>Promise<T>):Promise<T> {
    return withTransaction(this.pool,async client=>{
      const authority=await source(client);assertSpaceBackupAuthority(authority,tenant);
      await readSpaceBackupAgent(client,authority.actingCompany,tenant,alias);
      await client.query("UPDATE space_backups SET status='failed',error='EXPIRED',lease_until=NULL WHERE id=$1 AND company_id=$2 AND tenant_id=$3 AND alias=$4 AND expires_at<=now()",[id,authority.actingCompany,tenant,alias]);
      const row=(await client.query<SpaceBackupRow>('SELECT * FROM space_backups WHERE id=$1 AND company_id=$2 AND tenant_id=$3 AND alias=$4 FOR SHARE',
        [id,authority.actingCompany,tenant,alias])).rows[0];
      if (!row) throw new StoreError('not_found','space backup is unavailable');
      return work(row,client);
    });
  }
  get(source:CompanyAuthoritySource,tenant:string,alias:string,id:string) {return this.scoped(source,tenant,alias,id,async row=>spaceBackupReceipt(row));}
}
