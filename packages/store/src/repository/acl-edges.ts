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
         AND (source_tenant.is_hub OR target_tenant.is_hub)
       FOR SHARE OF edge,source_tenant,target_tenant`;
}
