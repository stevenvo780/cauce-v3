import { createHash, randomUUID } from 'node:crypto';
import { CanonicalUuidV4Schema, ClientDelegationLabelSchema, Sha256HexSchema } from '@cauce/protocol';
import { clientConnectionReference, StoreError, type DatabaseClient, type HumanPublishProvenance,
  type ConsoleCredentialStampVerifier } from '@cauce/store';
import { z } from 'zod';
import { lockOAuthGrant } from './oauth-grant-authority.js';

const RequestSchema = z.object({ request_id: CanonicalUuidV4Schema }).strict();
export const CreateClientDelegationSchema = RequestSchema.extend({ connection_ref: Sha256HexSchema,
  label: ClientDelegationLabelSchema }).strict();
export const RenameClientDelegationSchema = RequestSchema.extend({ label: ClientDelegationLabelSchema }).strict();
export const RevokeClientDelegationSchema = RequestSchema;
export interface ClientDelegationControlOptions {
  readonly issuer: string; readonly resource: string;
  readonly verifyCredentialStamp: ConsoleCredentialStampVerifier;
}
export async function lockClientDeclarationOwner(client: DatabaseClient, humanId: string, issuer: string): Promise<void> {
  await client.query('SELECT id FROM console_users WHERE id=$1 FOR SHARE', [humanId]);
  const binding = await client.query(`SELECT id FROM human_external_identities
    WHERE human_id=$1 AND provider='oauth' AND namespace=$2 AND subject=$1::text FOR NO KEY UPDATE`,
  [humanId, issuer]);
  if (binding.rowCount !== 1) throw new StoreError('forbidden', 'client declaration owner binding is unavailable');
}
interface Binding { id: string; local_oauth_grant_id: string; label: string; revoked_at: Date | null }
interface GrantMetadata { id: string; client_id: string; created_at: Date; expires_at: Date;
  revoked: boolean; binding_id: string | null; label: string | null; last_publication_at: Date | null }
function reference(options: ClientDelegationControlOptions, owner: HumanPublishProvenance, id: string): string {
  return clientConnectionReference(options.issuer, options.resource, owner.humanId, owner.tenantId, id);
}
export async function listClientDelegations(client: DatabaseClient, owner: HumanPublishProvenance,
  options: ClientDelegationControlOptions) {
  const ownerName = await clientOwnerName(client, owner.humanId);
  const grants = await client.query<GrantMetadata>(`SELECT g.id,g.client_id,g.created_at,g.expires_at,
    EXISTS(SELECT 1 FROM cauce_oauth_grant_revocations v WHERE v.grant_id=g.id) AS revoked,
    d.id AS binding_id,d.label,(SELECT max(p.created_at) FROM human_message_client_provenance p
      WHERE p.local_oauth_grant_id=g.id) AS last_publication_at
    FROM cauce_oauth_grants g LEFT JOIN human_oauth_client_delegations d
      ON d.local_oauth_grant_id=g.id AND d.revoked_at IS NULL
    WHERE g.human_id=$1 AND g.tenant_id=$2 AND g.issuer=$3 AND g.resource=$4
    ORDER BY g.created_at DESC,g.id LIMIT 101`, [owner.humanId, owner.tenantId, options.issuer, options.resource]);
  return { items: grants.rows.slice(0, 100).map((grant) => ({
    connection_ref: reference(options, owner, grant.id), client_id: grant.client_id,
    created_at: grant.created_at.toISOString(), expires_at: grant.expires_at.toISOString(), revoked: grant.revoked,
    binding_id: grant.binding_id, label: grant.label,
    display_label: grant.label === null ? null : `${grant.label} por cuenta de ${ownerName}`, basis: 'owner_declared_grant', instance: 'unknown',
    last_publication_at: grant.last_publication_at?.toISOString() ?? null,
    last_use_at: null, last_use_observed: false,
  })), truncated: grants.rows.length > 100 };
}
async function clientOwnerName(client: DatabaseClient, humanId: string): Promise<string> {
  const row = (await client.query<{ display_name: string }>('SELECT display_name FROM console_users WHERE id=$1', [humanId])).rows[0];
  if (!row) throw new StoreError('forbidden', 'client declaration owner is unavailable');
  return row.display_name;
}
async function resolveTarget(client: DatabaseClient, owner: HumanPublishProvenance,
  options: ClientDelegationControlOptions, operation: 'create' | 'rename' | 'revoke', target: string) {
  if (operation !== 'create') {
    const binding = (await client.query<Binding>(`SELECT id,local_oauth_grant_id,label,revoked_at
      FROM human_oauth_client_delegations WHERE id=$1 AND human_id=$2 AND tenant_id=$3`,
    [target, owner.humanId, owner.tenantId])).rows[0];
    if (!binding) throw new StoreError('not_found', 'client declaration is not visible');
    return { grantId: binding.local_oauth_grant_id, binding };
  }
  const matches = (await client.query<{ id: string }>(`SELECT id FROM cauce_oauth_grants
    WHERE human_id=$1 AND tenant_id=$2 AND issuer=$3 AND resource=$4`,
  [owner.humanId, owner.tenantId, options.issuer, options.resource])).rows
    .filter((grant) => reference(options, owner, grant.id) === target);
  if (matches.length !== 1 || !matches[0]) throw new StoreError('not_found', 'client connection is not visible');
  return { grantId: matches[0].id, binding: undefined };
}
export async function mutateClientDelegation(client: DatabaseClient, owner: HumanPublishProvenance,
  options: ClientDelegationControlOptions, input: {
    operation: 'create' | 'rename' | 'revoke'; requestId: string; target: string; label?: string;
  }): Promise<Record<string, unknown>> {
  const requestHash = createHash('sha256').update(JSON.stringify([
    'cauce-v3:client-declaration:v1', input.operation, input.target, input.label ?? null,
  ])).digest('hex');
  const prior = (await client.query<{ request_hash: string; response: Record<string, unknown> }>(
    `SELECT request_hash,response FROM human_client_delegation_operations
     WHERE human_id=$1 AND tenant_id=$2 AND request_id=$3 FOR SHARE`,
    [owner.humanId, owner.tenantId, input.requestId])).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new StoreError('conflict', 'client declaration request key was reused');
    return prior.response;
  }
  const { grantId, binding } = await resolveTarget(client, owner, options, input.operation, input.target);
  if (input.operation !== 'revoke') {
    await lockOAuthGrant(client, grantId, options.issuer, options.resource, owner.humanId, options.verifyCredentialStamp);
    ClientDelegationLabelSchema.parse(input.label);
  }
  const grant = await client.query(`SELECT id FROM cauce_oauth_grants
    WHERE id=$1 AND human_id=$2 AND tenant_id=$3 AND issuer=$4 AND resource=$5 FOR NO KEY UPDATE`,
  [grantId, owner.humanId, owner.tenantId, options.issuer, options.resource]);
  if (grant.rowCount !== 1) throw new StoreError('not_found', 'client connection is not visible');
  const active = (await client.query<Binding>(`SELECT id,local_oauth_grant_id,label,revoked_at
    FROM human_oauth_client_delegations WHERE local_oauth_grant_id=$1 AND revoked_at IS NULL FOR UPDATE`,
  [grantId])).rows[0];
  if ((input.operation === 'create' && active !== undefined)
      || (input.operation !== 'create' && (!binding || active?.id !== binding.id))) {
    throw new StoreError('conflict', 'client declaration changed');
  }
  if (active) await client.query(`UPDATE human_oauth_client_delegations SET revoked_at=clock_timestamp()
    WHERE id=$1 AND revoked_at IS NULL`, [active.id]);
  const bindingId = input.operation === 'revoke' ? active?.id : randomUUID();
  if (input.operation !== 'revoke') await client.query(`INSERT INTO human_oauth_client_delegations
    (id,local_oauth_grant_id,human_id,tenant_id,declared_by_human_id,label) VALUES($1,$2,$3,$4,$3,$5)`,
  [bindingId, grantId, owner.humanId, owner.tenantId, input.label]);
  const ownerName = await clientOwnerName(client, owner.humanId);
  const label = input.operation === 'revoke' ? active?.label : input.label;
  const response = { binding_id: bindingId, connection_ref: reference(options, owner, grantId),
    owner_human_id: owner.humanId, owner_tenant_id: owner.tenantId,
    label, display_label: `${label ?? ''} por cuenta de ${ownerName}`,
    basis: 'owner_declared_grant', instance: 'unknown', revoked: input.operation === 'revoke' };
  await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,metadata)
    VALUES($1,$2,$3,'allow',$4,$5::jsonb)`, [owner.tenantId, owner.actorAlias,
    `mcp.client_delegation.${input.operation}`, input.requestId, JSON.stringify({ ...response,
      previous_binding_id: active?.id ?? null })]);
  await client.query(`INSERT INTO human_client_delegation_operations
    (human_id,tenant_id,request_id,request_hash,operation,response) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [owner.humanId, owner.tenantId, input.requestId, requestHash, input.operation, JSON.stringify(response)]);
  return response;
}
