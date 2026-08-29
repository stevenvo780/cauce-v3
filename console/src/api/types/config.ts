export type ConfigResource =
  | 'tenant' | 'room' | 'membership' | 'acl_edge' | 'harness' | 'role_policy'
  /** Singleton hub-only of chain visibility: it only allows `update` over the id `default`. */
  | 'chain_policy'
  /** Allowlist of proactive egress: it is versioned configuration, not runtime data. */
  | 'egress_destination';
/**
 * Resources of the agent registry and of the subscription pool (migration
 * `packages/store/migrations/010_agent_account_registry.sql`). They are hub-only:
 * `authorizeMutation` did not add them to the self-service list, so a non-hub tenant gets 403.
 */
export type RegistryConfigResource =
  | 'agent' | 'provider_account' | 'alias_routing_ceiling' | 'agent_account_binding';
export type AnyConfigResource = ConfigResource | RegistryConfigResource;
export type ConfigAction = 'create' | 'update' | 'delete';
export type ConfigMutation = Record<string, unknown> & {
  resource: AnyConfigResource;
  action: ConfigAction;
};

export interface ConfigRevision {
  id?: string | null;
  actor_tenant?: string | null;
  actor_alias?: string | null;
  operation?: ConfigMutation | null;
  summary?: string | null;
  rolled_back_revision_id?: string | null;
  created_at?: string | null;
}

export interface ConfigurationSnapshot {
  revision?: number | null;
  observed_at?: string | null;
  tenants?: Record<string, unknown>[] | null;
  rooms?: Record<string, unknown>[] | null;
  memberships?: Record<string, unknown>[] | null;
  acl_edges?: Record<string, unknown>[] | null;
  harness_definitions?: Record<string, unknown>[] | null;
  role_policies?: Record<string, unknown>[] | null;
  /** `default` singleton of the chain visibility policy (migration 008). */
  chain_policies?: Record<string, unknown>[] | null;
  /** Allowlist of proactive egress (migration 009). */
  egress_destinations?: Record<string, unknown>[] | null;
  /**
   * Agent registry and account pool. The four keys are optional on purpose: a gateway older
   * than migration 010 does not publish them, and that is NOT the same as an empty list. The
   * UI distinguishes "key absent" (data not available) from "empty list" (zero known rows).
   *
   * Each `agents` row carries `role_brief` only as a legacy read-only projection of
   * `agent_profiles.role_summary`. The console never writes it: the canonical Profile PUT
   * does CAS, materializes the runtime, and only then credits `applied_revision`.
   */
  agents?: Record<string, unknown>[] | null;
  /** `credential_ref` never travels here; `external_account_id` and `credential_ref_kind` are
   *  nulled by the server for an account paid by another tenant. */
  provider_accounts?: Record<string, unknown>[] | null;
  alias_routing_ceiling?: Record<string, unknown>[] | null;
  agent_account_bindings?: Record<string, unknown>[] | null;
  /** Diagnostic read-only copy; writes use the canonical Profile API. */
  agent_profiles?: Record<string, unknown>[] | null;
  revisions?: ConfigRevision[] | null;
}

export interface ConfigurationChangeResult {
  applied?: boolean | null;
  dry_run?: boolean | null;
  revision?: number | null;
  /** Exact causal source for rollback receipts; normal changes carry null. */
  rolled_back_revision_id?: number | null;
  summary?: string | null;
  mutation?: ConfigMutation | null;
  inverse_mutation?: ConfigMutation | null;
}
