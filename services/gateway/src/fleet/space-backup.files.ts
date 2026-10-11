import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat,mkdir,open,readdir,realpath,rename,unlink } from 'node:fs/promises';
import { isAbsolute,join,resolve } from 'node:path';
import { StoreError,SPACE_BACKUP_MAX_BYTES,type SpaceBackupRow } from '@cauce/store';
import { assertLoginPins,boundedProviderReceipt } from './provider-login.js';
export interface SpaceBackupStorage {directory:string;projectRoot:string;python?:string}
export async function prepareSpaceBackupDirectory(options:SpaceBackupStorage):Promise<void> {
  const path=options.directory;
  if (!isAbsolute(path)||resolve(path)!==path||path==='/') throw new Error('Space backup storage must be a canonical directory');
  await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);
  if (!info.isDirectory()||info.uid!==process.geteuid?.()||(info.mode&0o077)!==0||await realpath(path)!==path) throw new Error('Space backup storage must be private');
}
export function spaceBackupPath(options:SpaceBackupStorage,row:Pick<SpaceBackupRow,'id'|'claim_epoch'>,ready=false):string {
  return join(options.directory,ready?`${row.id}.zip`:`${row.id}.${String(row.claim_epoch)}.part`);
}
async function privateFile(path:string,flags:number) {
  const file=await open(path,flags|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  const info=await file.stat();
  if (!info.isFile()||info.uid!==process.geteuid?.()||info.nlink!==1||(info.mode&0o077)!==0||info.size>SPACE_BACKUP_MAX_BYTES) {
    await file.close();throw new StoreError('conflict','space backup copy is unverified');
  }
  return file;
}
export async function appendSpaceBackup(options:SpaceBackupStorage,row:SpaceBackupRow,offset:number,bytes:Buffer):Promise<number> {
  await prepareSpaceBackupDirectory(options);
  if (row.bytes===null||offset+bytes.byteLength>row.bytes||offset>row.received_bytes) throw new StoreError('conflict','space backup chunk is outside its receipt');
  const file=await privateFile(spaceBackupPath(options,row),constants.O_RDWR|constants.O_CREAT);
  try {
    if (offset<row.received_bytes) {
      if (offset+bytes.length>row.received_bytes) throw new StoreError('conflict','space backup retry overlaps unaccepted bytes');
      const existing=Buffer.alloc(bytes.length);const read=await file.read(existing,0,existing.length,offset);
      if (read.bytesRead!==bytes.length||!existing.equals(bytes)) throw new StoreError('conflict','space backup retry differs');
      return row.received_bytes;
    }
    const info=await file.stat();if (info.size<offset) throw new StoreError('conflict','space backup durable copy is incomplete');
    await file.truncate(offset);let written=0;
    while(written<bytes.length) {const result=await file.write(bytes,written,bytes.length-written,offset+written);written+=result.bytesWritten;}
    await file.sync();return offset+bytes.length;
  } finally {await file.close();}
}
export async function verifySpaceBackup(options:SpaceBackupStorage,row:SpaceBackupRow):Promise<void> {
  await prepareSpaceBackupDirectory(options);
  if (row.bytes===null||row.sha256===null||row.manifest_sha256===null||row.received_bytes!==row.bytes) throw new StoreError('conflict','space backup is incomplete');
  let candidate=spaceBackupPath(options,row);
  const info=await lstat(candidate).catch((error:unknown)=>{if (error instanceof Error&&'code' in error&&error.code==='ENOENT') return null;throw error;});
  if (info===null) candidate=spaceBackupPath(options,row,true);
  const file=await privateFile(candidate,constants.O_RDONLY);
  try {
    if ((await file.stat()).size!==row.bytes) throw new StoreError('conflict','space backup byte receipt differs');
    const hash=createHash('sha256');const chunk=Buffer.alloc(65_536);
    for (;;) {const read=await file.read(chunk,0,chunk.length,null);if (!read.bytesRead) break;hash.update(chunk.subarray(0,read.bytesRead));}
    if (hash.digest('hex')!==row.sha256) throw new StoreError('conflict','space backup digest differs');
  } finally {await file.close();}
  const directory=join(options.projectRoot,'ops/cli');const pins:Record<string,string>={};
  for (const name of ['space_backup_validate.py','space_archive.py']) {
    const path=join(directory,name);const source=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {pins[path]=createHash('sha256').update(await source.readFile()).digest('hex');} finally {await source.close();}
  }
  await assertLoginPins(pins);
  const receipt=await boundedProviderReceipt(options.python??'/usr/bin/python3',[join(directory,'space_backup_validate.py')],
    JSON.stringify({archive:candidate,identity:{company_id:row.company_id,tenant_id:row.tenant_id,alias:row.alias,runtime_key:row.agent_snapshot.runtime_key},manifest_sha256:row.manifest_sha256}),new AbortController().signal,60_000);
  if (JSON.stringify(receipt)!==JSON.stringify({verified:true})) throw new StoreError('conflict','space backup manifest could not be verified');
  if (candidate!==spaceBackupPath(options,row,true)) await rename(candidate,spaceBackupPath(options,row,true));
}
export async function openSpaceBackupDownload(options:SpaceBackupStorage,row:SpaceBackupRow) {
  await prepareSpaceBackupDirectory(options);
  if (row.status!=='ready'||row.bytes===null||row.sha256===null) throw new StoreError('conflict','space backup is not ready');
  const file=await privateFile(spaceBackupPath(options,row,true),constants.O_RDONLY);
  try {
    const before=await file.stat();if (before.size!==row.bytes) throw new StoreError('conflict','space backup copy differs');
    const hash=createHash('sha256');const chunk=Buffer.alloc(65_536);let offset=0;
    for (;;) {const read=await file.read(chunk,0,chunk.length,offset);if (!read.bytesRead) break;hash.update(chunk.subarray(0,read.bytesRead));offset+=read.bytesRead;}
    const after=await file.stat();
    if (hash.digest('hex')!==row.sha256||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==after.size) throw new StoreError('conflict','space backup copy differs');
    return file;
  } catch(error) {await file.close();throw error;}
}
export async function expireSpaceBackupCopies(options:SpaceBackupStorage,rows:Pick<SpaceBackupRow,'id'|'claim_epoch'>[]):Promise<void> {
  await prepareSpaceBackupDirectory(options);
  const names=await readdir(options.directory);
  for (const row of rows) for (const name of names) {
    if (name===`${row.id}.zip`||name.startsWith(`${row.id}.`)&&/^\d+\.part$/u.test(name.slice(row.id.length+1))) {
      await unlink(join(options.directory,name)).catch((error:unknown)=>{if (!(error instanceof Error&&'code' in error&&error.code==='ENOENT')) throw error;});
    }
  }
}
