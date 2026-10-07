import {
  HumanClientDelegationSchema,
  HumanClientProvenanceSchema,
  HumanMessageInitiatorSchema,
} from "@cauce/protocol";
import type { Delivery } from "../types.js";
import { AdapterError } from "../errors.js";

export type ValidatedClientProvenance = Readonly<ReturnType<typeof HumanClientProvenanceSchema.parse>>;
export type ValidatedClientDelegation = Readonly<ReturnType<typeof HumanClientDelegationSchema.parse>>;
export type HumanInitiator = Readonly<ReturnType<typeof HumanMessageInitiatorSchema.parse>>;

function invalid(message: string): never {
  throw new AdapterError("INVALID_DELIVERY", message, false);
}

function rootMatchesInitiator(rootMessageId: string, initiator: HumanInitiator): boolean {
  return rootMessageId.toLowerCase() === initiator.root_message_id.toLowerCase();
}

function hasProvenance(delivery: Delivery): boolean {
  return Object.hasOwn(delivery, "human_client_provenance");
}

function hasDelegation(delivery: Delivery): boolean {
  return Object.hasOwn(delivery, "human_client_delegation");
}

export function clientProvenanceFromDelivery(
  delivery: Delivery,
  initiator: HumanInitiator | undefined,
): ValidatedClientProvenance | null {
  if (!hasProvenance(delivery)) return null;
  const parsed = HumanClientProvenanceSchema.safeParse(delivery.human_client_provenance);
  if (!parsed.success) invalid("Delivery human_client_provenance is malformed");
  if (initiator === undefined) invalid("human_client_provenance requires a human initiator");
  if (!rootMatchesInitiator(parsed.data.root_message_id, initiator)) {
    invalid("human_client_provenance root_message_id does not match the human initiator");
  }
  return Object.freeze({ ...parsed.data, client: Object.freeze(parsed.data.client) });
}

export function clientDelegationFromDelivery(
  delivery: Delivery,
  initiator: HumanInitiator | undefined,
): ValidatedClientDelegation | null {
  if (!hasDelegation(delivery)) return null;
  const parsed = HumanClientDelegationSchema.safeParse(delivery.human_client_delegation);
  if (!parsed.success) invalid("Delivery human_client_delegation is malformed");
  if (initiator === undefined) invalid("human_client_delegation requires a human initiator");
  if (!rootMatchesInitiator(parsed.data.root_message_id, initiator)) {
    invalid("human_client_delegation root_message_id does not match the human initiator");
  }
  if (parsed.data.owner_human_id.toLowerCase() !== initiator.human_id.toLowerCase()) {
    invalid("human_client_delegation owner_human_id does not match the human initiator");
  }
  if (parsed.data.owner_tenant_id !== initiator.tenant_id) {
    invalid("human_client_delegation owner_tenant_id does not match the human initiator tenant");
  }
  return Object.freeze({ ...parsed.data });
}

export interface ClientIdentitySidecar {
  readonly clientProvenance: ValidatedClientProvenance | null;
  readonly clientDelegation: ValidatedClientDelegation | null;
}

export function resolveClientIdentitySidecar(
  delivery: Delivery,
  initiator: HumanInitiator | undefined,
): ClientIdentitySidecar {
  return {
    clientProvenance: clientProvenanceFromDelivery(delivery, initiator),
    clientDelegation: clientDelegationFromDelivery(delivery, initiator),
  };
}

export interface ClientIdentityExecuteFields {
  readonly clientProvenance?: ValidatedClientProvenance;
  readonly clientDelegation?: ValidatedClientDelegation;
}

export function clientIdentitySidecarFields(
  delivery: Delivery,
  initiator: HumanInitiator | undefined,
  ownTenantId: string | undefined,
): ClientIdentityExecuteFields {
  if ((hasProvenance(delivery) || hasDelegation(delivery))
      && (ownTenantId === undefined || initiator?.tenant_id !== ownTenantId)) {
    invalid("Client metadata requires the configured recipient tenant to match the human initiator");
  }
  const sidecar = resolveClientIdentitySidecar(delivery, initiator);
  return {
    ...(sidecar.clientProvenance === null ? {} : { clientProvenance: sidecar.clientProvenance }),
    ...(sidecar.clientDelegation === null ? {} : { clientDelegation: sidecar.clientDelegation }),
  };
}
