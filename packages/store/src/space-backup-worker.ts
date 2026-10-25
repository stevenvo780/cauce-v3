import { isDeepStrictEqual } from 'node:util';
import type { DatabaseClient } from './db.js';
import { StoreError } from './repository/errors.js';
import { authorizeSpaceBackupRequester,readSpaceBackupAgent } from './space-backup-authority.js';
import { normalizeSpaceBackupRow,SpaceBackupClaimSchema,type SpaceBackupFence,type SpaceBackupRow,type SpaceBackupStoredRow } from './space-backup-contracts.js';
export interface SpaceBackupHost {host_id:string;company_id:string}
export async function claimSpaceBackup(client:DatabaseClient,host:SpaceBackupHost) {
  await client.query("UPDATE space_backups SET status='failed',error='EXPIRED',lease_until=NULL WHERE host_id=$1 AND company_id=$2 AND expires_at<=now() AND status IN ('pending','running')",[host.host_id,host.company_id]);
  const stored=(await client.query<SpaceBackupStoredRow>(`SELECT * FROM space_backups WHERE host_id=$1 AND company_id=$2 AND expires_at>now()
    AND (status='pending' OR status='running' AND lease_until<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[host.host_id,host.company_id])).rows[0];
  if (!stored) return null;
  const row=normalizeSpaceBackupRow(stored);
  try {await authorizeSpaceBackupRequester(client,row);
    if (!isDeepStrictEqual(await readSpaceBackupAgent(client,row.company_id,row.tenant_id,row.alias),row.agent_snapshot)) throw new StoreError('conflict','space backup scope changed');
  } catch(error) {
    if (!(error instanceof StoreError)) throw error;
    await client.query("UPDATE space_backups SET status='failed',error='SCOPE_CHANGED',lease_until=NULL WHERE id=$1",[row.id]);return null;
  }
  const claimed=(await client.query<SpaceBackupRow>(`UPDATE space_backups SET status='running',claim_token=gen_random_uuid(),claim_epoch=claim_epoch+1,
    lease_until=now()+interval '60 seconds',received_bytes=0,bytes=NULL,sha256=NULL,manifest_sha256=NULL WHERE id=$1 RETURNING *`,[row.id])).rows[0];
  if (!claimed) throw new StoreError('conflict','space backup lease was not acquired');
  return SpaceBackupClaimSchema.parse({id:claimed.id,claim_token:claimed.claim_token,claim_epoch:claimed.claim_epoch,
    company_id:claimed.company_id,tenant_id:claimed.tenant_id,alias:claimed.alias,host_id:claimed.host_id,
    policy_sha256:claimed.policy_sha256,agent_snapshot:claimed.agent_snapshot});
}
export async function lockedSpaceBackup(client:DatabaseClient,host:SpaceBackupHost,fence:SpaceBackupFence,allowReady=false):Promise<SpaceBackupRow> {
  const stored=(await client.query<SpaceBackupStoredRow>(`SELECT * FROM space_backups WHERE id=$1 AND host_id=$2 AND company_id=$3 AND claim_token=$4 AND claim_epoch=$5
    AND (status='running' AND lease_until>now() OR $6::boolean AND status='ready') AND expires_at>now() FOR UPDATE`,[fence.id,host.host_id,host.company_id,fence.claim_token,fence.claim_epoch,allowReady])).rows[0];
  if (!stored) throw new StoreError('conflict','space backup lease was replaced');
  const row=normalizeSpaceBackupRow(stored);
  await authorizeSpaceBackupRequester(client,row);
  if (!isDeepStrictEqual(await readSpaceBackupAgent(client,row.company_id,row.tenant_id,row.alias),row.agent_snapshot)) throw new StoreError('conflict','space backup scope changed');
  return row;
}
