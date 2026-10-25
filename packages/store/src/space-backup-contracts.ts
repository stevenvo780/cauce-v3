import { z } from 'zod';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
export const SPACE_BACKUP_CONTENT_BYTES=16*1024*1024*1024;
export const SPACE_BACKUP_MAX_BYTES=SPACE_BACKUP_CONTENT_BYTES+8*1024*1024+64*1024*1024;
export const SPACE_BACKUP_CHUNK_BYTES=4*1024*1024;
export const SPACE_BACKUP_CHUNK_BASE64_BYTES=4*Math.ceil(SPACE_BACKUP_CHUNK_BYTES/3);
export const SPACE_BACKUP_HOST_BODY_BYTES=8*1024*1024;
export interface SpaceBackupQuotaLimits {companyMaxBytes?:number;globalMaxBytes?:number}
export const SPACE_BACKUP_COMPANY_BYTES=4*SPACE_BACKUP_MAX_BYTES;
export const SPACE_BACKUP_GLOBAL_BYTES=16*SPACE_BACKUP_MAX_BYTES;
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
  lease_until:Date|null;created_at:Date;expires_at:Date;received_bytes:number;bytes:number|null;sha256:string|null;manifest_sha256:string|null;
}
export type SpaceBackupStoredRow=Omit<SpaceBackupRow,'received_bytes'|'bytes'>&{received_bytes:number|string;bytes:number|string|null};
export function normalizeSpaceBackupRow(row:SpaceBackupStoredRow):SpaceBackupRow {
  const bytes=(value:number|string,min:number):number=>{
    if (typeof value==='string'&&!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error('Space backup byte receipt is invalid');
    const parsed=Number(value);
    if (!Number.isSafeInteger(parsed)||parsed<min||parsed>SPACE_BACKUP_MAX_BYTES) throw new Error('Space backup byte receipt is invalid');
    return parsed;
  };
  return {...row,received_bytes:bytes(row.received_bytes,0),bytes:row.bytes===null?null:bytes(row.bytes,1)};
}
export function spaceBackupReceipt(stored:SpaceBackupStoredRow) {
  const row=normalizeSpaceBackupRow(stored);
  return {id:row.id,company_id:row.company_id,tenant_id:row.tenant_id,alias:row.alias,status:row.status,
    bytes:row.bytes,sha256:row.sha256,manifest_sha256:row.manifest_sha256,error:row.error,
    created_at:row.created_at.toISOString(),expires_at:row.expires_at.toISOString(),
    download_url:row.status==='ready'?`/v3/console/spaces/${encodeURIComponent(row.tenant_id)}/${encodeURIComponent(row.alias)}/backups/${row.id}/download`:null};
}
