import {
  HUMAN_CLIENT_PROVENANCE_CAPABILITY,
  HUMAN_CLIENT_DELEGATION_CAPABILITY,
  HUMAN_MESSAGE_INITIATOR_CAPABILITY,
} from "@cauce/protocol";
import type { AdapterCapabilities } from "./types.js";

type CapabilityEncoder = (capabilities: AdapterCapabilities) => readonly string[];

function matchesCapability(value: unknown, expected: string | boolean): boolean {
  return value === expected;
}

const CAPABILITY_ENCODERS = {
  mcp_emit: (value) => matchesCapability(value.mcp_emit, true) ? ["mcp_emit"] : [],
  harness: (value) => [`harness.${value.harness}`],
  heartbeat: (value) => matchesCapability(value.heartbeat, true) ? ["heartbeat"] : [],
  routing_targets_v1: (value) => matchesCapability(value.routing_targets_v1, true) ? ["routing_targets_v1"] : [],
  renewable_delivery_claims_v1: (value) => matchesCapability(value.renewable_delivery_claims_v1, true) ? ["renewable_delivery_claims_v1"] : [],
  delegation_feedback_v1: (value) => matchesCapability(value.delegation_feedback_v1, true) ? ["delegation_feedback_v1"] : [],
  agent_identity_v1: (value) => matchesCapability(value.agent_identity_v1, true) ? ["agent_identity_v1"] : [],
  agent_profile_v1: (value) => matchesCapability(value.agent_profile_v1, true) ? ["agent_profile_v1"] : [],
  agent_profile_adoption_v1: (value) => matchesCapability(value.agent_profile_adoption_v1, true) ? ["agent_profile_adoption_v1"] : [],
  client_mailbox_v1: (value) => matchesCapability(value.client_mailbox_v1, true) ? ["client_mailbox_v1"] : [],
  conversation_work_v1: (value) => matchesCapability(value.conversation_work_v1, true) ? ["conversation_work_v1"] : [],
} satisfies Partial<Record<keyof AdapterCapabilities, CapabilityEncoder>>;

export function helloCapabilityStrings(capabilities: AdapterCapabilities, humanIsolation = false): string[] {
  return [
    ...(humanIsolation ? [HUMAN_MESSAGE_INITIATOR_CAPABILITY,
      ...(capabilities.human_message_client_provenance_v1 === true ? [HUMAN_CLIENT_PROVENANCE_CAPABILITY] : []),
      ...(capabilities.human_message_client_delegation_v1 === true ? [HUMAN_CLIENT_DELEGATION_CAPABILITY] : []),
    ] : []),
    "console_human_scope_v1",
    ...Object.values(CAPABILITY_ENCODERS).flatMap((encode) => encode(capabilities)),
  ];
}
