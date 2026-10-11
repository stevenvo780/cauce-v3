import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StoreError,SpaceBackupRepository,SpaceBackupTargetSchema,type DatabasePool } from '@cauce/store';
import { AuthError,AuthorizationError,type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { replyError } from '../routes/shared.js';
import { openSpaceBackupDownload,type SpaceBackupStorage } from '../fleet/space-backup.files.js';
export function registerSpaceBackupConsoleRoutes(app:FastifyInstance,provider:AuthProvider,pool:DatabasePool,storage:SpaceBackupStorage):void {
  const repository=new SpaceBackupRepository(pool);
  const base='/v3/console/spaces/:tenant_id/:alias/backups';
  for (const action of ['create','read','download'] as const) {
    app.route({method:action==='create'?'POST':'GET',url:action==='create'?base:`${base}/:id${action==='download'?'/download':''}`,bodyLimit:8192,
      handler:async(request,reply)=>{
        reply.header('Cache-Control','no-store');
        try {
          if (action==='create'&&provider instanceof PasswordAuthProvider) await provider.requireCsrf(request);
          const params=(action==='create'?SpaceBackupTargetSchema:SpaceBackupTargetSchema.safeExtend({id:z.uuid()})).parse(request.params);
          const access=await consoleHumanAccess(provider,request,reply,'read');if (!access) throw new AuthorizationError('a console session is required');
          try {
            const source=access.companyAuthority.bind(access);
            if (action==='create') return await reply.code(202).send(await repository.enqueue(source,params.tenant_id,params.alias,request.body));
            const id=z.object({id:z.uuid()}).parse(request.params).id;
            if (action==='read') return await repository.get(source,params.tenant_id,params.alias,id);
            const file=await repository.scoped(source,params.tenant_id,params.alias,id,async row=>({row,file:await openSpaceBackupDownload(storage,row)}));
            reply.header('Content-Type','application/zip').header('Content-Length',String(file.row.bytes))
              .header('Content-Disposition',`attachment; filename="space-${params.alias.replace(/[^A-Za-z0-9_-]/gu,'_')}-${id}.zip"`)
              .header('X-Cauce-Archive-Sha256',file.row.sha256).header('X-Cauce-Manifest-Sha256',file.row.manifest_sha256);
            return await reply.send(file.file.createReadStream({autoClose:true}));
          } finally {access.close();}
        } catch(error) {
          if (error instanceof z.ZodError) return reply.code(400).send({error:'invalid_request',message:'invalid space backup request'});
          if (error instanceof StoreError||error instanceof AuthError||error instanceof AuthorizationError) {replyError(reply,error);return;}
          return reply.code(503).send({error:'space_backup_unavailable',message:'No se pudo descargar la copia del espacio.'});
        }
      }});
  }
}
