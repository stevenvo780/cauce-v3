import { z } from 'zod';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
export const SPACE_BACKUP_MAX_BYTES=32*1024*1024;
export const SPACE_BACKUP_CHUNK_BYTES=64*1024;
const Identifier=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const Path=z.string().max(4096).regex(/^\/(?:[^\p{Cc}\\]+)$/u).refine(value=>!value.split('/').slice(1).some(part=>part==='.'||part==='..'||part===''));
export const SpaceBackupTargetSchema=z.object({tenant_id:TenantSchema,alias:AliasSchema}).strict();
export const SpaceBackupRequestSchema=z.object({idempotency_key:z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)}).strict();
export const SpaceBackupHash=z.string().regex(/^[a-f0-9]{64}$/u);
export const SpaceBackupAgentSchema=z.object({company_id:Identifier,tenant_id:TenantSchema,alias:AliasSchema,
  runtime_key:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),host_id:Identifier,harness_id:Identifier,
  runtime_mode:z.enum(['native','container']),container_name:z.string().min(1).max(128),runtime_user:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u),
  home_directory:Path,state_directory:Path,systemd_user:z.string().nullable(),
}).strict();
export const SpaceBackupFenceSchema=z.object({id:z.uuid(),claim_token:z.uuid(),claim_epoch:z.number().int().positive()}).strict();
export const SpaceBackupClaimSchema=SpaceBackupFenceSchema.safeExtend({company_id:Identifier,tenant_id:TenantSchema,alias:AliasSchema,
  host_id:Identifier,policy_sha256:SpaceBackupHash,agent_snapshot:SpaceBackupAgentSchema});
export type SpaceBackupClaim=z.infer<typeof SpaceBackupClaimSchema>;
export type SpaceBackupFence=z.infer<typeof SpaceBackupFenceSchema>;
export type SpaceBackupAgent=z.infer<typeof SpaceBackupAgentSchema>;
export interface SpaceBackupRow {
  id:string;company_id:string;tenant_id:string;alias:string;host_id:string;requested_by:string;idempotency_key:string;
  policy_sha256:string;agent_snapshot:SpaceBackupAgent;status:'pending'|'running'|'ready'|'failed';
  error:'HOST_UNAVAILABLE'|'SCOPE_CHANGED'|'EXPORT_FAILED'|'EXPIRED'|'LIMIT_EXCEEDED'|null;claim_token:string|null;claim_epoch:number;
  lease_until:Date|null;expires_at:Date;received_bytes:number;bytes:number|null;sha256:string|null;manifest_sha256:string|null;
}
export function spaceBackupReceipt(row:SpaceBackupRow) {
  return {id:row.id,company_id:row.company_id,tenant_id:row.tenant_id,alias:row.alias,status:row.status,
    bytes:row.bytes,sha256:row.sha256,manifest_sha256:row.manifest_sha256,error:row.error,
    download_url:row.status==='ready'?`/v3/console/spaces/${encodeURIComponent(row.tenant_id)}/${encodeURIComponent(row.alias)}/backups/${row.id}/download`:null};
}
