import { z } from 'zod';
import { ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import { HostActorSchema } from './auth-bridge-contracts.js';
import { QuotaAuthCommandSchema } from './quota-auth-contracts.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const AgentAuthFenceSchema = z.object({ operation_id: z.uuid(), session_id: z.uuid(), operation_epoch: z.number().int().nonnegative(),
  prepared_revision: z.number().int().nonnegative(), scope_sha256: Hash, expires_at: z.iso.datetime() }).strict();
export const AgentAuthPhysicalSchema = ProviderAuthRequestSchema.omit({ expected_operation_version: true, request_id: true }).extend({
  tenant_id: z.string().min(1).max(64), alias: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  runtime_key: z.string().min(1).max(128), host_scope_sha256: Hash, expected_external_account_id: z.string().min(1).max(4096),
}).strict();
export const AgentAuthBindingSchema = z.object({ fence: AgentAuthFenceSchema, physical: AgentAuthPhysicalSchema,
  actor: HostActorSchema.extend({ requestedCompany: z.string().min(1).max(64) }), request: ProviderAuthRequestSchema }).strict();
const Actions = z.union([QuotaAuthCommandSchema, z.object({ id: z.uuid(), type: z.enum(['stop','open','cleanup']) }).strict()]);
export const AgentAuthCommandSchema = z.object({ fence: AgentAuthFenceSchema, command: Actions }).strict();
export const AgentAuthEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), fence: AgentAuthFenceSchema, id: z.uuid(), ok: z.boolean(),
    method: z.enum(['device','terminal']).optional(), stopped: z.boolean().optional(),
    identity_matches: z.boolean().optional(), functional_call_verified: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('output'), fence: AgentAuthFenceSchema, sequence: z.number().int().positive(),
    data: z.string().max(5464).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }).strict(),
]);
export const AgentAuthPacketSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('exchange'), events: z.array(AgentAuthEventSchema).max(32) }).strict(),
  z.object({ action: z.literal('context'), id: z.uuid(), fence: AgentAuthFenceSchema }).strict(),
]);
export const AgentAuthExchangeSchema = z.object({ commands: z.array(AgentAuthCommandSchema).max(32),
  active_sessions: z.array(AgentAuthFenceSchema).max(1000) }).strict();
export type AgentAuthBinding = z.infer<typeof AgentAuthBindingSchema>;
export type AgentAuthCommand = z.infer<typeof AgentAuthCommandSchema>;
export type AgentAuthEvent = z.infer<typeof AgentAuthEventSchema>;
export type AgentAuthFence = z.infer<typeof AgentAuthFenceSchema>;
export type AgentAuthResult = Extract<AgentAuthEvent, { type: 'result' }>;
