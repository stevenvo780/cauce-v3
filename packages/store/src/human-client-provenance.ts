import { createHash } from 'node:crypto';
import { ClientDelegationLabelSchema, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { StoreError } from './repository/errors.js';

export type HumanClientProvenance = Readonly<{ kind: 'unknown' }> | Readonly<{
  kind: 'oauth_client'; verification: 'local_grant'; issuer: string; clientId: string;
  grantId: string; instance: 'unknown'; delegationBindingId?: string;
}>;
export function clientConnectionReference(issuer: string, resource: string, humanId: string,
  tenantId: string, grantId: string): string {
  return createHash('sha256').update(JSON.stringify([
    'cauce-v3:oauth-client-connection:v1', issuer, resource, humanId, tenantId, grantId,
  ])).digest('hex');
}
export async function activeClientDelegation(client: DatabaseClient, grantId: string): Promise<string | undefined> {
  return (await client.query<{ id: string }>(
    `SELECT id FROM human_oauth_client_delegations
     WHERE local_oauth_grant_id=$1 AND revoked_at IS NULL FOR SHARE`, [grantId],
  )).rows[0]?.id;
}
export async function putHumanClientProvenance(client: DatabaseClient, root: {
  messageId: string; humanId: string; tenantId: string; conversationId: string;
}, provenance: HumanClientProvenance | undefined): Promise<void> {
  const local = provenance?.kind === 'oauth_client' ? provenance : undefined;
  await client.query(`INSERT INTO human_message_client_provenance(root_message_id,
    initiating_human_id,initiating_tenant_id,conversation_id,local_oauth_grant_id,delegation_binding_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [root.messageId, root.humanId, root.tenantId, root.conversationId,
    local?.grantId ?? null, local?.delegationBindingId ?? null]);
}
export async function loadHumanClientProvenance(client: DatabaseClient, rootMessageId: string): Promise<{
  client: { kind: 'unknown' } | { kind: 'oauth_client'; verification: 'local_grant';
    issuer: string; client_id: string; instance: 'unknown' };
  declaration?: { label: string; humanId: string; tenantId: Tenant };
}> {
  const row = (await client.query<{ local_oauth_grant_id: string | null; issuer: string | null;
    client_id: string | null; label: string | null; initiating_human_id: string; initiating_tenant_id: Tenant }>(
    `SELECT p.local_oauth_grant_id,g.issuer,g.client_id,d.label,
      p.initiating_human_id,p.initiating_tenant_id
     FROM human_message_client_provenance p LEFT JOIN cauce_oauth_grants g ON g.id=p.local_oauth_grant_id
     LEFT JOIN human_oauth_client_delegations d ON d.id=p.delegation_binding_id
     WHERE p.root_message_id=$1 FOR SHARE OF p`, [rootMessageId],
  )).rows[0];
  if (!row?.local_oauth_grant_id) return { client: { kind: 'unknown' } };
  if (!row.issuer || !row.client_id) throw new StoreError('conflict', 'human client provenance is inconsistent');
  return { client: { kind: 'oauth_client', verification: 'local_grant', issuer: row.issuer,
    client_id: row.client_id, instance: 'unknown' }, ...(row.label === null ? {} : {
    declaration: { label: ClientDelegationLabelSchema.parse(row.label), humanId: row.initiating_human_id,
      tenantId: row.initiating_tenant_id },
  }) };
}
