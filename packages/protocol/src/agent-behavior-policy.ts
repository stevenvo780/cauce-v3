import { z } from 'zod';
import { AliasSchema, RecipientSchema, TenantSchema } from './schemas/core.js';
import { EgressHandleSchema } from './schemas/messages.js';

export const AGENT_BEHAVIOR_POLICY_V1_CAPABILITY = 'agent_behavior_policy_v1';

export const AgentBehaviorPolicyScopeSchema = z.object({
  tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128),
  alias: AliasSchema,
}).strict();

export const AgentBehaviorPolicyValueV1Schema = z.object({
  version: z.literal(1),
  coordination_mode: z.enum(['executor', 'coordinator']),
  escalation: z.object({
    infrastructure: RecipientSchema.optional(),
    coordinator: RecipientSchema.optional(),
  }).strict().optional(),
  fanin_receipt_mode: z.enum(['technical', 'human']),
  supervision_notice: z.object({
    issuer_alias: AliasSchema,
    issuer_session_id: z.string().min(1).max(256),
    egress_handle: EgressHandleSchema,
  }).strict().optional(),
}).strict();

export const AgentBehaviorPolicyV1Schema = AgentBehaviorPolicyValueV1Schema.extend({
  revision: z.string().regex(/^[1-9][0-9]*$/u),
  scope: AgentBehaviorPolicyScopeSchema,
}).strict();

export type AgentBehaviorPolicyV1 = z.infer<typeof AgentBehaviorPolicyV1Schema>;
