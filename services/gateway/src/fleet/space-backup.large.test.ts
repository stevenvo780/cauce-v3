import { mkdtemp,open,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { normalizeSpaceBackupRow,SPACE_BACKUP_CHUNK_BYTES,SPACE_BACKUP_MAX_BYTES,type SpaceBackupStoredRow } from '@cauce/store';
import { SpaceBackupHostCommandSchema } from './space-backup.contracts.js';
import { appendSpaceBackup,spaceBackupHasCapacity,spaceBackupPath } from './space-backup.files.js';
let directory:string|undefined;
afterEach(async()=>{if(directory) await rm(directory,{recursive:true,force:true});directory=undefined;});
function row(received_bytes:number|string=0,bytes:number|string|null=null):SpaceBackupStoredRow {
  return {id:'ab000000-0000-4000-8000-000000000002',company_id:'north',tenant_id:'North',alias:'worker',host_id:'north-host',
    requested_by:'ab000000-0000-4000-8000-000000000004',idempotency_key:'large-copy',policy_sha256:'a'.repeat(64),status:'running',
    error:null,claim_token:'ab000000-0000-4000-8000-000000000003',claim_epoch:1,lease_until:new Date(),created_at:new Date(),expires_at:new Date(),
    received_bytes,bytes,sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64),agent_snapshot:{company_id:'north',tenant_id:'North',alias:'worker',runtime_key:'worker',
      host_id:'north-host',harness_id:'codex',runtime_mode:'native',container_name:'host:north-host',runtime_user:'dev',home_directory:'/home/dev',state_directory:'/home/dev/state/worker',systemd_user:'dev'}};
}
it('converts PostgreSQL bigint receipts exactly and rejects invalid or excessive byte counters',()=>{
  expect(SPACE_BACKUP_MAX_BYTES).toBe(17_255_366_656);
  expect(normalizeSpaceBackupRow(row('3221225472','17255366656'))).toMatchObject({received_bytes:3*1024**3,bytes:SPACE_BACKUP_MAX_BYTES});
  for(const value of ['-1','1e3','01','9007199254740993',String(SPACE_BACKUP_MAX_BYTES+1)]) {
    expect(()=>normalizeSpaceBackupRow(row(value,'17255366656'))).toThrow('invalid');
  }
});
it('accepts a 4 MiB chunk at a bigint offset and rejects decoded or malformed base64 excess',()=>{
  const fence={id:row().id,claim_token:row().claim_token,claim_epoch:1};
  const command={action:'append',claim:fence,offset:3*1024**3,data:Buffer.alloc(SPACE_BACKUP_CHUNK_BYTES,90).toString('base64')};
  expect(SpaceBackupHostCommandSchema.parse(command)).toEqual(command);
  for(const data of [Buffer.alloc(SPACE_BACKUP_CHUNK_BYTES+1,90).toString('base64'),'AA=A','AAA','A===']) {
    expect(SpaceBackupHostCommandSchema.safeParse({...command,data}).success).toBe(false);
  }
});
it('writes sparse offsets above signed int32 without truncating their numeric position',async()=>{
  directory=await mkdtemp(join(tmpdir(),'cauce-backup-large-'));const storage={directory,projectRoot:process.cwd()};
  const offset=3*1024**3;const current=row(String(offset),String(offset+4));const path=spaceBackupPath(storage,current);
  const file=await open(path,'wx',0o600);try {await file.truncate(offset);} finally {await file.close();}
  expect(await appendSpaceBackup(storage,current,offset,Buffer.from('test'))).toBe(offset+4);
  expect((await stat(path)).size).toBe(offset+4);
  const read=await open(path,'r');try {const bytes=Buffer.alloc(4);await read.read(bytes,0,4,offset);expect(bytes.toString()).toBe('test');} finally {await read.close();}
});
it('subtracts concurrent storage reservations from actual free capacity before an upload',async()=>{
  directory=await mkdtemp(join(tmpdir(),'cauce-backup-capacity-'));const storage={directory,projectRoot:process.cwd()};
  expect(await spaceBackupHasCapacity(storage,1,0n)).toBe(true);
  expect(await spaceBackupHasCapacity(storage,1,2n**100n)).toBe(false);
});
