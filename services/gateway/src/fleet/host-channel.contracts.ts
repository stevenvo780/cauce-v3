import { z } from 'zod';
import { AgentQuotaClaimSchema, AgentQuotaFailureCodeSchema, AgentQuotaReceiptSchema,
  FleetEvidenceSchema, FleetErrorSchema, FleetStepNameSchema } from '@cauce/protocol';
import { HostCapabilitiesSchema } from './host-channel.capabilities.js';
import { MaintenanceDeferReasonSchema } from './host-maintenance-guard.js';

const Lease = z.number().int().min(1000).max(300_000).default(30_000);
const FleetFence = z.object({ operation_id:z.uuid(),claim_token:z.uuid(),epoch:z.number().int().positive() }).strict();
const QuotaFence = z.object({ id:z.uuid(),environment_id:z.uuid(),claim_token:z.uuid(),claim_epoch:z.number().int().positive(),
  worker_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }).strict();
const HostStep = z.union([FleetStepNameSchema,z.literal('compensate')]);
const Fleet = {resource:z.literal('fleet_operation')};
const Quota = {resource:z.literal('quota_environment')};
const AgentQuota = {resource:z.literal('agent_quota')};
export const HostFleetCommandSchema = z.discriminatedUnion('action',[
  z.object({...Fleet,action:z.literal('claim'),lease_ms:Lease}).strict(),
  z.object({...Fleet,action:z.literal('renew'),claim:FleetFence,lease_ms:Lease}).strict(),
  z.object({...Fleet,action:z.enum(['execution','prepare','await_auth','host_slices']),claim:FleetFence}).strict(),
  z.object({...Fleet,action:z.literal('settle'),claim:FleetFence,evidence:FleetEvidenceSchema.optional()}).strict(),
  z.object({...Fleet,action:z.literal('start_step'),claim:FleetFence,step:FleetStepNameSchema}).strict(),
  z.object({...Fleet,action:z.literal('complete_step'),claim:FleetFence,step:FleetStepNameSchema,evidence:FleetEvidenceSchema}).strict(),
  z.object({...Fleet,action:z.literal('complete_host_step'),claim:FleetFence,step:HostStep,
    digest:z.string().regex(/^[a-f0-9]{64}$/u),evidence:FleetEvidenceSchema}).strict(),
  z.object({...Fleet,action:z.literal('host_receipts'),claim:FleetFence,step:HostStep}).strict(),
  z.object({...Fleet,action:z.literal('fail'),claim:FleetFence,error:FleetErrorSchema}).strict(),
  z.object({...Fleet,action:z.literal('compensate'),claim:FleetFence,evidence:FleetEvidenceSchema}).strict(),
]);
export const HostQuotaCommandSchema = z.discriminatedUnion('action',[
  z.object({...Quota,action:z.literal('claim'),lease_ms:Lease}).strict(),
  z.object({...Quota,action:z.literal('renew'),claim:QuotaFence,lease_ms:Lease}).strict(),
  z.object({...Quota,action:z.enum(['execution','resume_auth']),claim:QuotaFence}).strict(),
  z.object({...Quota,action:z.literal('finish'),claim:QuotaFence,result:z.record(z.string(),z.unknown()),awaiting_auth:z.boolean().default(false)}).strict(),
  z.object({...Quota,action:z.literal('fail'),claim:QuotaFence,code:z.enum(['PROVIDER_UNAVAILABLE','RUNTIME_UNAVAILABLE','STEP_FAILED','AUTH_CANCELLED']),
    detail:z.enum(['runtime_release_stale','runtime_image_stale','reader_unreadable','environment_not_running','isolation_rejected','cli_update_failed','cli_update_timed_out']).optional()}).strict(),
]);
export const HostAgentQuotaCommandSchema = z.discriminatedUnion('action',[
  z.object({...AgentQuota,action:z.literal('claim'),lease_ms:Lease}).strict(),
  z.object({...AgentQuota,action:z.literal('renew'),claim:AgentQuotaClaimSchema,lease_ms:Lease}).strict(),
  z.object({...AgentQuota,action:z.literal('execution'),claim:AgentQuotaClaimSchema}).strict(),
  z.object({...AgentQuota,action:z.literal('finish'),claim:AgentQuotaClaimSchema,receipt:AgentQuotaReceiptSchema}).strict(),
  z.object({...AgentQuota,action:z.literal('fail'),claim:AgentQuotaClaimSchema,code:AgentQuotaFailureCodeSchema}).strict(),
]);
export const HostMaintenanceCommandSchema = z.discriminatedUnion('action', [
  z.object({ resource: z.literal('host_maintenance'), action: z.literal('reconcile'),
    release_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  z.object({ resource: z.literal('host_maintenance'), action: z.literal('defer'), claim: FleetFence,
    reason: MaintenanceDeferReasonSchema }).strict(),
  z.object({ resource: z.literal('host_maintenance'), action: z.literal('prepare'), claim: FleetFence }).strict(),
  z.object({ resource: z.literal('host_maintenance'), action: z.literal('skip'), claim: FleetFence,
    reason: z.enum(['runtime_current', 'release_changed']).optional() }).strict(),
]);
export const HostChannelCommandSchema = z.discriminatedUnion('resource',[
  HostFleetCommandSchema,HostQuotaCommandSchema,HostAgentQuotaCommandSchema,HostCapabilitiesSchema,HostMaintenanceCommandSchema]);
export type HostChannelCommand = z.infer<typeof HostChannelCommandSchema>;
export type HostFleetCommand = z.infer<typeof HostFleetCommandSchema>;
export type HostQuotaCommand = z.infer<typeof HostQuotaCommandSchema>;
export type HostAgentQuotaCommand = z.infer<typeof HostAgentQuotaCommandSchema>;
export type HostMaintenanceCommand = z.infer<typeof HostMaintenanceCommandSchema>;
