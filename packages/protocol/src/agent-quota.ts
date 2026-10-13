import { z } from 'zod';
import { AliasSchema, TenantSchema } from './schemas.js';
import { QuotaProviderReportSchema } from './schemas/quotas.js';

export const AgentQuotaQuerySchema = z.object({
  expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
}).strict();
export const AgentQuotaFailureCodeSchema = z.enum(['PROVIDER_UNAVAILABLE', 'RUNTIME_UNAVAILABLE', 'STEP_FAILED']);
export const AgentQuotaClaimSchema = z.object({
  id: z.uuid(), tenant_id: TenantSchema, alias: AliasSchema, claim_token: z.uuid(),
  claim_epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), worker_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
}).strict();
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const AgentQuotaAgentSnapshotSchema = z.object({
  operation_id: z.uuid(), expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  company_id: identifier, tenant_id: TenantSchema, alias: AliasSchema, harness_id: identifier, host_id: identifier,
  runtime_mode: z.literal('container'), container_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  runtime_user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u),
  home_directory: z.string().min(1).max(4096), state_directory: z.string().min(1).max(4096),
  runtime_key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), systemd_user: z.string().nullable(), primary_account_id: identifier.nullable(),
}).strict();
export const AgentQuotaExecutionSchema = z.object({
  operation_id: z.uuid(), action: z.literal('query'), agent: AgentQuotaAgentSnapshotSchema,
}).strict().refine(value => value.operation_id === value.agent.operation_id, 'operation identity differs');
const envelope = {
  operation_id: z.uuid(), tenant: TenantSchema, alias: AliasSchema, host_id: identifier,
  container_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  harness: z.string().min(1).max(64), captured_at: z.iso.datetime({ offset: true }),
};
export const AgentQuotaReceiptSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('measured'), provider: z.enum(['claude', 'codex', 'grok']),
    identity_hash: z.string().regex(/^[a-f0-9]{64}$/u), provider_report: QuotaProviderReportSchema,
    observation_status: z.enum(['ok', 'error']) }).strict(),
  z.object({ ...envelope, status: z.literal('unsupported'), reason: z.literal('quota_reader_unavailable') }).strict(),
]);
export type AgentQuotaClaim = z.infer<typeof AgentQuotaClaimSchema>;
export type AgentQuotaExecution = z.infer<typeof AgentQuotaExecutionSchema>;
export type AgentQuotaReceipt = z.infer<typeof AgentQuotaReceiptSchema>;
export type AgentQuotaFailureCode = z.infer<typeof AgentQuotaFailureCodeSchema>;
