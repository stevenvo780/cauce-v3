import type { HarnessRequestContext } from "../../contracts/harness.js";
import type { Delivery } from "../types.js";
import { behaviorPolicyFromDelivery } from "../behavior-policy.js";
import { routingTargetsFromDelivery, selfRoleFromDelivery } from "./delivery-context.js";

export function deliveryHarnessContext(
  delivery: Delivery, ownTenantId: string | undefined, ownRoom: string | undefined,
  ownAlias: string | undefined, mcpEmit: boolean, humanInitiator: HarnessRequestContext["human_initiator"],
): HarnessRequestContext {
  const messageType = typeof delivery.body.type === "string" ? delivery.body.type : "request";
  const context: HarnessRequestContext = {
      ...(!mcpEmit ? {} : { mcp_emit: true }),
      ...(humanInitiator === undefined ? {} : { human_initiator: humanInitiator }),
      self_alias: delivery.recipient_alias,
      sender_alias: delivery.actor_alias,
      sender_tenant_id: delivery.tenant_id,
      tenant_id: ownTenantId ?? delivery.tenant_id,
      room_id: ownRoom ?? delivery.room_id,
      channel: delivery.authenticated_context?.channel
        ?? delivery.origin?.channel
        ?? "cauce",
      agent_message: messageType === "agent.message"
        || messageType === "agent.response"
        || messageType === "agent.fanin",
      message_type: messageType,
      routing_targets: routingTargetsFromDelivery(delivery),
      ...selfRoleFromDelivery(delivery),
      ...(delivery.profile_runtime_contract === undefined
        ? {}
        : { native_profile_contract: delivery.profile_runtime_contract }),
    };
  const policy = behaviorPolicyFromDelivery(delivery, ownTenantId, ownRoom, ownAlias);
  return policy === undefined ? context : { ...context, behavior_policy: policy };
}
