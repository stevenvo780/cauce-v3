export type ConfigResource =
  | 'tenant' | 'room' | 'membership' | 'acl_edge' | 'harness' | 'role_policy'
  /** Singleton hub-only de visibilidad de cadena: sólo admite `update` sobre el id `default`. */
  | 'chain_policy'
  /** Allowlist de egress proactivo: es configuración versionada, no dato de runtime. */
  | 'egress_destination';
/**
 * Recursos del registro de agentes y del pool de suscripciones (migración
 * `packages/store/migrations/010_agent_account_registry.sql`). Son hub-only: `authorizeMutation`
 * no los agregó a la lista de self-service, así que un tenant no-hub recibe 403.
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
  /** Singleton `default` de la política de visibilidad de cadena (migración 008). */
  chain_policies?: Record<string, unknown>[] | null;
  /** Allowlist de egress proactivo (migración 009). */
  egress_destinations?: Record<string, unknown>[] | null;
  /**
   * Registro de agentes y pool de cuentas. Las cuatro claves son opcionales a propósito: un
   * gateway anterior a la migración 010 no las publica, y eso NO es lo mismo que una lista vacía.
   * La UI distingue "clave ausente" (dato no disponible) de "lista vacía" (cero filas conocidas).
   *
   * Cada fila de `agents` trae `role_brief` únicamente como proyección legacy de sólo lectura de
   * `agent_profiles.role_summary`. La consola nunca la escribe: el PUT canónico de Perfil hace
   * CAS, materializa el runtime y sólo después acredita `applied_revision`.
   */
  agents?: Record<string, unknown>[] | null;
  /** `credential_ref` nunca viaja acá; `external_account_id` y `credential_ref_kind` los anula el
   *  servidor para una cuenta que paga otro tenant. */
  provider_accounts?: Record<string, unknown>[] | null;
  alias_routing_ceiling?: Record<string, unknown>[] | null;
  agent_account_bindings?: Record<string, unknown>[] | null;
  /** Copia diagnóstica de sólo lectura; las escrituras usan la API canónica de Perfil. */
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
