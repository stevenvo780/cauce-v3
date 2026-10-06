import { AgentBehaviorPolicyV1Schema } from "@cauce/protocol";
import type { AgentBehaviorPolicyV1 } from "@cauce/protocol";
import { AdapterError } from "./errors.js";
import type { Delivery } from "./types.js";

interface ConsumerPolicyContext {
  readonly tenant_id: string;
  readonly room_id: string;
  readonly self_alias: string;
  readonly routing_targets: readonly { readonly tenant_id: string; readonly alias: string; readonly online: boolean }[];
}

export function validatedBehaviorPolicy(
  candidate: unknown,
  context: ConsumerPolicyContext,
): AgentBehaviorPolicyV1 | undefined {
  if (candidate === undefined) return undefined;
  const parsed = AgentBehaviorPolicyV1Schema.safeParse(candidate);
  if (!parsed.success) throw new AdapterError("INVALID_BEHAVIOR_POLICY", "Behavior policy is invalid", false);
  const policy = parsed.data;
  if (policy.scope.tenant_id !== context.tenant_id || policy.scope.room_id !== context.room_id
    || policy.scope.alias !== context.self_alias) {
    throw new AdapterError("INVALID_BEHAVIOR_POLICY", "Behavior policy consumer scope differs", false);
  }
  for (const recipient of Object.values(policy.escalation ?? {})) {
    if (recipient === undefined) continue;
    if (!context.routing_targets.some((target) => target.tenant_id === recipient.tenant_id
      && target.alias === recipient.alias)) {
      throw new AdapterError("INVALID_BEHAVIOR_POLICY", "Behavior policy target is absent from routing inventory", false);
    }
  }
  return policy;
}

export function behaviorPolicyFromDelivery(
  delivery: Delivery, ownTenantId: string | undefined, ownRoom: string | undefined,
  ownAlias?: string,
): AgentBehaviorPolicyV1 | undefined {
  return validatedBehaviorPolicy(delivery.behavior_policy, {
    tenant_id: ownTenantId ?? delivery.tenant_id, room_id: ownRoom ?? delivery.room_id,
    self_alias: ownAlias ?? delivery.recipient_alias, routing_targets: delivery.routing_targets ?? [],
  });
}
