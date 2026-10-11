import { withTransaction,type DatabaseClient,type DatabasePool } from './db.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { assertSpaceBackupAuthority,readSpaceBackupAgent } from './space-backup-authority.js';
import { SpaceBackupRequestSchema,spaceBackupReceipt,type SpaceBackupRow } from './space-backup-contracts.js';
export class SpaceBackupRepository {
  constructor(readonly pool:DatabasePool) {}
  enqueue(source:CompanyAuthoritySource,tenant:string,alias:string,value:unknown) {
    const input=SpaceBackupRequestSchema.parse(value);
    return withTransaction(this.pool,async client=>{
      const authority=await source(client);assertSpaceBackupAuthority(authority,tenant);
      const agent=await readSpaceBackupAgent(client,authority.actingCompany,tenant,alias);
      await client.query('SELECT pg_advisory_xact_lock($1)',[783_003_060]);
      await client.query(`UPDATE space_backups SET status='failed',error='EXPIRED',lease_until=NULL
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND idempotency_key=$4 AND expires_at<=now()`,
      [authority.actingCompany,tenant,alias,input.idempotency_key]);
      const previous=(await client.query<SpaceBackupRow>('SELECT * FROM space_backups WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND idempotency_key=$4',
        [authority.actingCompany,tenant,alias,input.idempotency_key])).rows[0];
      if (previous) return spaceBackupReceipt(previous);
      const capability=(await client.query<{policy_sha256:string}>(`SELECT identity.capabilities->>'policy_sha256' AS policy_sha256
        FROM fleet_host_identities identity JOIN fleet_hosts host ON host.host_id=identity.host_id AND host.company_id=identity.company_id
        WHERE identity.host_id=$1 AND identity.company_id=$2 AND identity.enabled AND host.enabled
          AND identity.capabilities_seen_at>now()-interval '120 seconds' AND identity.capabilities->>'fleet_executor'='true' FOR SHARE OF identity,host`,
        [agent.host_id,authority.actingCompany])).rows[0];
      if (!capability) throw new StoreError('conflict','space backup host is unavailable');
      const pending=(await client.query<{count:string}>('SELECT count(*)::text AS count FROM space_backups WHERE company_id=$1 AND expires_at>now()',[authority.actingCompany])).rows[0];
      if (Number(pending?.count??0)>=20) throw new StoreError('conflict','space backup company retention limit reached');
      const global=(await client.query<{count:string}>('SELECT count(*)::text AS count FROM space_backups WHERE expires_at>now()')).rows[0];
      if (Number(global?.count??0)>=200) throw new StoreError('conflict','space backup global retention limit reached');
      const row=(await client.query<SpaceBackupRow>(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[authority.actingCompany,tenant,alias,agent.host_id,authority.humanId,input.idempotency_key,JSON.stringify(agent),capability.policy_sha256])).rows[0];
      if (!row) throw new StoreError('conflict','space backup was not persisted');
      await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,company_id,actor_human_id,action,decision,metadata)
        VALUES($1,$2,$3,$4,'space.backup.request','allow',$5::jsonb)`,[authority.homeTenant,authority.alias,authority.actingCompany,authority.humanId,JSON.stringify({id:row.id,tenant_id:tenant,alias})]);
      return spaceBackupReceipt(row);
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
