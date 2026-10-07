import { describe, expect, it } from 'vitest';
import {
  AgentBehaviorPolicyV1Schema, AgentBehaviorPolicyConfigMutationSchema,
  DeliveryEnvelopeSchema,
} from '../src/index.js';

const policy = {
  version: 1, revision: '42', scope: { tenant_id: 'CompanyA', room_id: 'support', alias: 'operator' },
  coordination_mode: 'executor', fanin_receipt_mode: 'technical',
  escalation: { infrastructure: { tenant_id: 'CompanyA', alias: 'infrastructure' } },
  supervision_notice: { issuer_alias: 'coordinator', issuer_session_id: 'session', egress_handle: 'human.dm' },
};

describe('trusted behavior policy wire', () => {
  it('accepts arbitrary scoped company identifiers and rejects unknown fields at every level', () => {
    expect(AgentBehaviorPolicyV1Schema.parse(policy)).toEqual(policy);
    for (const value of [
      { ...policy, inferred_role: 'coordinator' },
      { ...policy, scope: { ...policy.scope, origin: 'body' } },
      { ...policy, escalation: { ...policy.escalation, stranger: {} } },
      { ...policy, supervision_notice: { ...policy.supervision_notice, channel: 'external' } },
    ]) expect(AgentBehaviorPolicyV1Schema.safeParse(value).success).toBe(false);
  });

  it('does not let an editor set the consumer scope or the durable revision', () => {
    expect(AgentBehaviorPolicyConfigMutationSchema.safeParse({
      resource: 'agent_behavior_policy', action: 'create', ...policy.scope, value: policy,
    }).success).toBe(false);
  });

  it('keeps the old strict delivery shape and rejects a new policy on a previous schema', () => {
    const legacySchema = DeliveryEnvelopeSchema.omit({ behavior_policy: true }).strict();
    const id = 'b02fb29a-2b13-44a8-8d10-5a1d5992e55b';
    const delivery = {
      type: 'delivery', version: '3.0', delivery_id: id, event_id: id, message_id: id,
      request_id: id, trace_id: 'trace', epoch: 1, attempt: 1, claim_token: id,
      ack_deadline_at: '2026-10-06T00:00:00.000Z', tenant_id: 'CompanyA', room_id: 'support',
      actor_alias: 'coordinator', recipient_alias: 'operator', body: { text: 'work' },
    };
    expect(legacySchema.safeParse(delivery).success).toBe(true);
    expect(DeliveryEnvelopeSchema.safeParse({ ...delivery, behavior_policy: policy }).success).toBe(true);
    expect(legacySchema.safeParse({ ...delivery, behavior_policy: policy }).success).toBe(false);
  });
});
