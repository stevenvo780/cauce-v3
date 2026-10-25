import { z } from 'zod';
import { SPACE_BACKUP_MAX_BYTES,SPACE_BACKUP_CHUNK_BYTES,SPACE_BACKUP_CHUNK_BASE64_BYTES,SpaceBackupFenceSchema,SpaceBackupHash } from '@cauce/store';
import { SpaceBackupFailureSchema } from './space-backup.failure.js';
export const SpaceBackupHostCommandSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('claim')}).strict(),
  z.object({action:z.enum(['renew','finish']),claim:SpaceBackupFenceSchema}).strict(),
  z.object({action:z.literal('fail'),claim:SpaceBackupFenceSchema,error:z.enum(['EXPORT_FAILED','LIMIT_EXCEEDED']),failure:SpaceBackupFailureSchema.optional()}).strict(),
  z.object({action:z.literal('begin'),claim:SpaceBackupFenceSchema,bytes:z.number().int().positive().max(SPACE_BACKUP_MAX_BYTES),
    sha256:SpaceBackupHash,manifest_sha256:SpaceBackupHash}).strict(),
  z.object({action:z.literal('append'),claim:SpaceBackupFenceSchema,offset:z.number().int().nonnegative().max(SPACE_BACKUP_MAX_BYTES),
    data:z.string().min(4).max(SPACE_BACKUP_CHUNK_BASE64_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/u)
      .refine(value=>value.length%4===0&&Buffer.byteLength(value,'base64')<=SPACE_BACKUP_CHUNK_BYTES)}).strict(),
]);
export type SpaceBackupHostCommand=z.infer<typeof SpaceBackupHostCommandSchema>;
