import { ClientDelegationLabelSchema, ClientProvenanceWireSchema } from '@cauce/protocol';

export interface ConsoleClientOrigin {
  readonly client: ReturnType<typeof ClientProvenanceWireSchema.parse>;
  readonly delegation_label: string | null;
}

export function messageClientOrigin(value: unknown): ConsoleClientOrigin | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const origin = value as Record<string, unknown>;
  if (Object.keys(origin).length !== 2 || !Object.hasOwn(origin, 'client')
      || !Object.hasOwn(origin, 'delegation_label')) return null;
  const client = ClientProvenanceWireSchema.safeParse(origin.client);
  const label = ClientDelegationLabelSchema.nullable().safeParse(origin.delegation_label);
  if (!client.success || !label.success || (client.data.kind === 'unknown' && label.data !== null)) return null;
  return { client: client.data, delegation_label: label.data };
}

export function messageClientOriginSql(viewerTenant: '$1' | '$2'): string {
  return `CASE WHEN m.auth_channel='human-mcp' AND m.tenant_id=${viewerTenant} THEN
    COALESCE((SELECT jsonb_build_object('client',CASE WHEN g.id IS NULL
      THEN jsonb_build_object('kind','unknown') ELSE jsonb_build_object(
        'kind','oauth_client','verification','local_grant','issuer',g.issuer,
        'client_id',g.client_id,'instance','unknown') END,
      'delegation_label',CASE WHEN g.id IS NULL THEN NULL ELSE d.label END)
      FROM human_message_client_provenance p
      LEFT JOIN cauce_oauth_grants g ON g.id=p.local_oauth_grant_id
        AND g.human_id=p.initiating_human_id AND g.tenant_id=p.initiating_tenant_id
      LEFT JOIN human_oauth_client_delegations d ON d.id=p.delegation_binding_id
        AND d.local_oauth_grant_id=g.id AND d.human_id=p.initiating_human_id
        AND d.tenant_id=p.initiating_tenant_id
      WHERE p.root_message_id=m.id AND p.initiating_tenant_id=m.tenant_id),
      jsonb_build_object('client',jsonb_build_object('kind','unknown'),'delegation_label',NULL))
    ELSE NULL END AS client_origin`;
}
