import { z } from 'zod';
import { AliasSchema, TenantSchema, RuntimeKeySchema } from '@cauce/protocol';

export const BootstrapPhaseSchema = z.enum(['bootstrap', 'normal']);
const HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const AccountSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const EffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().optional();
export const BootstrapCreateSchema = z.object({
  operation_id: z.uuid(), phase: BootstrapPhaseSchema, action: z.enum(['profile', 'verify']),
  nonce: HexSchema, account_id: AccountSchema, profile_revision: RevisionSchema,
}).strict();
export const BootstrapClaimSchema = z.object({
  operation_id: z.uuid(), phase: BootstrapPhaseSchema, runtime_key: RuntimeKeySchema,
}).strict();
export const BootstrapDocumentSchema = z.object({
  name: z.enum(['AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md']),
  sha256: HexSchema, native_revision: RevisionSchema.nullable(),
}).strict();
export const BootstrapDescriptorSchema = BootstrapCreateSchema.extend({
  probe_id: z.uuid(), tenant_id: TenantSchema, alias: AliasSchema, runtime_key: RuntimeKeySchema,
  harness_id: AccountSchema, model_id: z.string().min(1).max(128).nullable(),
  reasoning_effort: EffortSchema,
  deadline: z.iso.datetime(), prompt: z.string().min(1).max(512),
  documents: z.array(BootstrapDocumentSchema).min(1).max(6),
}).strict();
export const BootstrapAckSchema = z.object({
  operation_id: z.uuid(), phase: BootstrapPhaseSchema, runtime_key: RuntimeKeySchema,
  nonce: HexSchema, claim_token: HexSchema, account_id: AccountSchema,
  profile_revision: RevisionSchema, harness_id: AccountSchema, model_id: z.string().min(1).max(128).nullable(),
  reasoning_effort: EffortSchema,
  documents: z.array(BootstrapDocumentSchema).min(1).max(6),
  reply: z.string().max(128).nullable(), harness_started: z.boolean(),
}).strict();
export const BootstrapReceiptSchema = z.object({
  probe: BootstrapDescriptorSchema, state: z.enum(['pending', 'claimed', 'succeeded']),
  proof: BootstrapAckSchema.omit({ claim_token: true }).nullable(),
}).strict();
export type BootstrapPhase = z.infer<typeof BootstrapPhaseSchema>;
export type BootstrapCreate = z.infer<typeof BootstrapCreateSchema>;
export type BootstrapDescriptor = z.infer<typeof BootstrapDescriptorSchema>;
export type BootstrapDocument = z.infer<typeof BootstrapDocumentSchema>;
export type BootstrapAck = z.infer<typeof BootstrapAckSchema>;
export type BootstrapReceipt = z.infer<typeof BootstrapReceiptSchema>;
export interface BootstrapIdentity { tenant_id: string; alias: string }
export const BootstrapRecordSchema = z.object({
  probe: BootstrapDescriptorSchema, state: BootstrapReceiptSchema.shape.state, proof: BootstrapReceiptSchema.shape.proof,
  epoch: z.string().regex(/^[0-9]+$/u), worker_id: z.string().min(1).max(256), worker_claim_hash: HexSchema,
  claim_hash: HexSchema.optional(), claim_expires_at: z.iso.datetime().optional(),
}).strict();
export type BootstrapRecord = z.infer<typeof BootstrapRecordSchema>;
export class BootstrapError extends Error {
  constructor(readonly code: 'forbidden' | 'conflict' | 'not_found' | 'invalid_request' | 'unverified') {
    super(`bootstrap ${code}`); this.name = 'BootstrapError';
  }
}
export function bootstrapPrompt(nonce: string): string {
  return `Responde únicamente CAUCE_BOOTSTRAP_${nonce}. No uses herramientas ni envíes mensajes.`;
}
