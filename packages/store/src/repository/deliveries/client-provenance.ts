import { HUMAN_MESSAGE_INITIATOR_CAPABILITY, HUMAN_CLIENT_PROVENANCE_CAPABILITY,
  HUMAN_CLIENT_DELEGATION_CAPABILITY, HumanMessageInitiatorSchema, HumanClientProvenanceSchema,
  HumanClientDelegationSchema, type DeliveryEnvelope } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { loadHumanClientProvenance } from '../../human-client-provenance.js';
import { loadHumanMessageInitiator } from '../messages/human-initiators.js';

type Projection = Pick<DeliveryEnvelope, 'human_initiator' | 'human_client_provenance' | 'human_client_delegation'>;
export async function projectHumanClientProvenance(client: DatabaseClient,
  rows: readonly { id: string; message_id: string }[], capabilities: readonly string[]): Promise<Map<string, Projection>> {
  const initiatorCap = capabilities.includes(HUMAN_MESSAGE_INITIATOR_CAPABILITY);
  const clientCap = capabilities.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY);
  const declarationCap = capabilities.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY);
  const result = new Map<string, Projection>();
  if (!initiatorCap && !clientCap && !declarationCap) return result;
  for (const row of rows) {
    const root = await loadHumanMessageInitiator(client, row.message_id);
    if (root === undefined) continue;
    const projection: Projection = {};
    if (initiatorCap) projection.human_initiator = HumanMessageInitiatorSchema.parse({
      human_id: root.humanId, tenant_id: root.tenantId, conversation_id: root.conversationId,
      root_message_id: root.rootMessageId,
    });
    if (clientCap || declarationCap) {
      const stored = await loadHumanClientProvenance(client, root.rootMessageId);
      if (clientCap) projection.human_client_provenance = HumanClientProvenanceSchema.parse({
        root_message_id: root.rootMessageId, client: stored.client,
      });
      if (declarationCap && stored.declaration) projection.human_client_delegation = HumanClientDelegationSchema.parse({
        root_message_id: root.rootMessageId, owner_human_id: stored.declaration.humanId,
        owner_tenant_id: stored.declaration.tenantId, label: stored.declaration.label,
        basis: 'owner_declared_grant', instance: 'unknown',
      });
    }
    result.set(row.id, projection);
  }
  return result;
}
