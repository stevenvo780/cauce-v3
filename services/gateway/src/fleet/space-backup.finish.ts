import { isDeepStrictEqual } from 'node:util';
import { lockedSpaceBackup,StoreError,withTransaction,type DatabaseClient,type DatabasePool,type SpaceBackupFence,type SpaceBackupHost,type SpaceBackupRow } from '@cauce/store';
import { publishSpaceBackup,verifySpaceBackup,type SpaceBackupStorage } from './space-backup.files.js';
const ActiveIdentity=`SELECT identity.public_key FROM fleet_host_identities identity
  JOIN fleet_hosts host ON host.host_id=identity.host_id JOIN companies company ON company.id=identity.company_id
  WHERE identity.host_id=$1 AND identity.company_id=$2 AND identity.enabled AND host.enabled AND company.enabled
    AND company.retired_at IS NULL FOR NO KEY UPDATE OF identity FOR SHARE OF host`;
interface PreparedFinish {row:SpaceBackupRow;host:SpaceBackupHost;fence:SpaceBackupFence;publicKey:string}
export async function prepareSpaceBackupFinish(client:DatabaseClient,host:SpaceBackupHost,fence:SpaceBackupFence):Promise<PreparedFinish> {
  const publicKey=(await client.query<{public_key:string}>(ActiveIdentity,[host.host_id,host.company_id])).rows[0]?.public_key;
  if (publicKey===undefined) throw new StoreError('forbidden','space backup host identity is unavailable');
  return {row:await lockedSpaceBackup(client,host,fence,true),host,fence,publicKey};
}
export async function finishSpaceBackup(pool:DatabasePool,storage:SpaceBackupStorage,prepared:PreparedFinish,signal:AbortSignal) {
  const candidate=await verifySpaceBackup(storage,prepared.row,signal,false);
  return withTransaction(pool,async client=>{
    signal.throwIfAborted();
    const publicKey=(await client.query<{public_key:string}>(ActiveIdentity,[prepared.host.host_id,prepared.host.company_id])).rows[0]?.public_key;
    if (publicKey!==prepared.publicKey) throw new StoreError('forbidden','space backup host identity was replaced');
    if (!(await client.query<{available:boolean}>('SELECT cauce_lock_host_company($1) AS available',[prepared.host.company_id])).rows[0]?.available) {
      throw new StoreError('forbidden','space backup host company authority is unavailable');
    }
    const row=await lockedSpaceBackup(client,prepared.host,prepared.fence,true);
    if (!isDeepStrictEqual([row.bytes,row.received_bytes,row.sha256,row.manifest_sha256],
      [prepared.row.bytes,prepared.row.received_bytes,prepared.row.sha256,prepared.row.manifest_sha256])) throw new StoreError('conflict','space backup verification receipt changed');
    signal.throwIfAborted();
    await publishSpaceBackup(storage,row,candidate);signal.throwIfAborted();
    if (row.status!=='ready') await client.query("UPDATE space_backups SET status='ready',error=NULL,lease_until=NULL WHERE id=$1",[row.id]);
    signal.throwIfAborted();return {ready:true as const};
  });
}
