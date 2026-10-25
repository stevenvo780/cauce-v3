import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository,SPACE_BACKUP_HOST_BODY_BYTES,StoreError,assertSpaceBackupByteCapacity,claimSpaceBackup,lockedSpaceBackup,spaceBackupOutstandingBytes,type SpaceBackupRow,type DatabasePool } from '@cauce/store';
import { SpaceBackupHostCommandSchema } from './space-backup.contracts.js';
import { appendSpaceBackup,expireSpaceBackupCopies,spaceBackupHasCapacity,type SpaceBackupStorage } from './space-backup.files.js';
import { finishSpaceBackup,prepareSpaceBackupFinish } from './space-backup.finish.js';
import { replyError } from '../routes/shared.js';
import { safeBackupFailure } from './space-backup.failure.js';
export function registerSpaceBackupHostRoutes(app:FastifyInstance,pool:DatabasePool,storage:SpaceBackupStorage):void {
  const identity=new HostEnrollmentRepository(pool);
  app.post('/v3/fleet/hosts/:host_id/space-backups',{bodyLimit:SPACE_BACKUP_HOST_BODY_BYTES},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie!==undefined) throw new StoreError('forbidden','space backup host channels cannot use browser cookies');
      const {host_id}=z.object({host_id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)}).strict().parse(request.params);
      const command=SpaceBackupHostCommandSchema.parse(z.object({payload:z.unknown()}).parse(request.body).payload);
      if (command.action==='finish') {
        const prepared=await identity.request(host_id,'POST',`/v3/fleet/hosts/${host_id}/space-backups`,request.body,
          async(client,host)=>prepareSpaceBackupFinish(client,host,command.claim));
        const abort=new AbortController();const stop=()=>{if (!reply.raw.writableFinished) abort.abort();};
        request.raw.once('aborted',stop);reply.raw.once('close',stop);
        try {return await finishSpaceBackup(pool,storage,prepared,abort.signal);}
        finally {request.raw.off('aborted',stop);reply.raw.off('close',stop);}
      }
      return await identity.request(host_id,'POST',`/v3/fleet/hosts/${host_id}/space-backups`,request.body,async(client,host)=>{
        if (command.action==='claim') {
          const expired=(await client.query<SpaceBackupRow>('SELECT id,claim_epoch FROM space_backups WHERE expires_at<=now()')).rows;
          await expireSpaceBackupCopies(storage,expired);const claim=await claimSpaceBackup(client,host);
          if (claim) await expireSpaceBackupCopies(storage,[claim]);return {claim};
        }
        if (command.action==='begin') await assertSpaceBackupByteCapacity(client,host.company_id,storage);
        const row=await lockedSpaceBackup(client,host,command.claim,command.action==='finish');
        if (command.action==='fail') {
          await client.query("UPDATE space_backups SET status='failed',error=$2,lease_until=NULL WHERE id=$1",[row.id,command.error]);
          if (command.failure) await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,company_id,action,decision,metadata)
            VALUES($1,$2,$3,'space.backup.failed','info',$4::jsonb)`,[row.tenant_id,row.alias,row.company_id,
            JSON.stringify({id:row.id,tenant_id:row.tenant_id,alias:row.alias,host_id:row.host_id,
              claim_epoch:row.claim_epoch,component:'backup',error:command.error,failure:safeBackupFailure(command.failure)})]);
          return {failed:true};
        }
        if (command.action==='begin') {
          if (row.bytes!==null&&(row.bytes!==command.bytes||row.sha256!==command.sha256||row.manifest_sha256!==command.manifest_sha256)) throw new StoreError('conflict','space backup upload receipt changed');
          if (!await spaceBackupHasCapacity(storage,command.bytes-row.received_bytes,await spaceBackupOutstandingBytes(client,row.id))) return {error:'INSUFFICIENT_SPACE'};
          await client.query('UPDATE space_backups SET bytes=$2,sha256=$3,manifest_sha256=$4 WHERE id=$1',[row.id,command.bytes,command.sha256,command.manifest_sha256]);return {offset:row.received_bytes};
        }
        if (command.action==='append') {
          const offset=await appendSpaceBackup(storage,row,command.offset,Buffer.from(command.data,'base64'));
          await client.query("UPDATE space_backups SET received_bytes=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",[row.id,offset]);return {offset};
        }
        await client.query("UPDATE space_backups SET lease_until=now()+interval '60 seconds' WHERE id=$1",[row.id]);return {renewed:true};
      });
    } catch(error) {
      if (error instanceof z.ZodError) return reply.code(400).send({error:'invalid_request',message:'invalid space backup command'});
      if (error instanceof StoreError) {replyError(reply,error);return;}
      return reply.code(503).send({error:'space_backup_unavailable',message:'No se pudo verificar la copia del espacio.'});
    }
  });
}
