export type MemberOffReason =
  | 'not_registered'
  | 'agent_disabled'
  | 'membership_disabled'
  | 'agent_and_membership_disabled';

export interface RoomMember {
  alias?: string | null;
  role?: string | null;
  /** Routing membership state. */
  enabled?: boolean | null;
  /** Whether the same tenant/alias exists in the canonical agents registry. */
  registered?: boolean | null;
  agent_enabled?: boolean | null;
  harness_id?: string | null;
  display_name?: string | null;
  off_reason?: MemberOffReason | null;
}

export interface TenantNode {
  id?: string | null;
  label?: string | null;
  rooms?: Array<{
    id?: string | null;
    label?: string | null;
    members?: RoomMember[] | null;
  }> | null;
}

export interface AclEdge {
  from_tenant?: string | null;
  to_tenant?: string | null;
  enabled?: boolean | null;
  policy?: string | null;
  allow_route?: boolean | null;
  allow_read?: boolean | null;
  allow_control?: boolean | null;
}

export interface TopologySnapshot {
  observed_at?: string | null;
  tenants?: TenantNode[] | null;
  acl_edges?: AclEdge[] | null;
}
