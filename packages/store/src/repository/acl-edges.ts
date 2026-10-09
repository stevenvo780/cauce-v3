export function hubStarRouteSql(source: string, target: string, lockLink = false): string {
  const link = lockLink ? `cauce_lock_company_link(${source}.company_id,${target}.company_id)`
    : `EXISTS (SELECT 1 FROM company_links link
        WHERE (link.company_a=${source}.company_id AND link.company_b=${target}.company_id)
           OR (link.company_a=${target}.company_id AND link.company_b=${source}.company_id))`;
  return `((${source}.company_id=${target}.company_id AND (${source}.is_hub OR ${target}.is_hub))
    OR (${source}.company_id<>${target}.company_id AND ${source}.is_hub AND ${target}.is_hub
      AND ${link}))`;
}

/** Hub-anchored cross-tenant edge predicate, locked in the caller's transaction. The permission
 * column is a closed union because it is interpolated into the statement, never bound. */
export function hubEdgeExistsSql(
  permissionColumn: 'allow_route' | 'allow_control',
  fromParameter: number,
  toParameter: number
): string {
  return `SELECT 1 FROM acl_edges edge
       JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
       JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
       WHERE edge.from_tenant=$${String(fromParameter)} AND edge.to_tenant=$${String(toParameter)}
         AND edge.enabled AND edge.${permissionColumn}
         AND source_tenant.enabled AND target_tenant.enabled
         AND ${hubStarRouteSql('source_tenant', 'target_tenant', true)}
       FOR SHARE OF edge,source_tenant,target_tenant`;
}

export function tenantReadableSql(readerExpression: string, ownerExpression: string): string {
  const edge = (permission: 'allow_read' | 'allow_route', from: string, to: string): string =>
    `EXISTS (SELECT 1 FROM acl_edges edge
       JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
       JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
       WHERE edge.from_tenant=${from} AND edge.to_tenant=${to}
         AND edge.enabled AND edge.${permission}
         AND source_tenant.enabled AND target_tenant.enabled
         AND ${hubStarRouteSql('source_tenant', 'target_tenant')})`;
  return `(${ownerExpression}=${readerExpression} OR (`
    + `${edge('allow_read', readerExpression, ownerExpression)} AND `
    + `${edge('allow_route', ownerExpression, readerExpression)}))`;
}

export const chainGateOriginTenantSql = `COALESCE(NULLIF(gate.origin->'metadata'->>'bridge_tenant',''),
  (SELECT root_message.tenant_id FROM messages root_message WHERE root_message.id=gate.root_message_id))`;
