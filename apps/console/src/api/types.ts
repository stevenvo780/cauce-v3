export type DeliveryState =
  | 'pending'
  | 'leased'
  | 'accepted'
  | 'started'
  | 'done'
  | 'failed'
  | 'retry'
  | 'dead';

export type JobLane = 'interactive' | 'batch';
export type CapabilityState = 'available' | 'degraded' | 'unavailable' | 'unknown';
export type ConsolePermission =
  | 'message.publish' | 'delivery.replay' | 'job.create' | 'config.write' | 'config.rollback'
  | 'ultimate-terminal.connect';

export interface ConsoleAuthState {
  /** null means the selected legacy auth mode has no BFF session facade. */
  authenticated: boolean | null;
  subject?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
  expires_at?: string | null;
  csrf_token?: string | null;
  reason?: string | null;
}

/** Server-derived RBAC snapshot. Missing permissions are UNKNOWN, never implicitly allowed. */
export interface ConsoleAccess {
  subject?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
  observed_at?: string | null;
  reason?: string | null;
}

/** Fields here are observations signed/derived by the server, never client authority. */
export interface PresenceLease {
  tenant_id?: string | null;
  alias?: string | null;
  instance_id?: string | null;
  epoch?: number | null;
  capabilities?: string[] | null;
  last_heartbeat_at?: string | null;
  lease_expires_at?: string | null;
  lease_until?: string | null;
  online?: boolean | null;
}

export interface SystemStatus {
  version?: string | null;
  auth_provider?: string | null;
  online?: number | null;
  queued?: number | null;
  dead_letters?: number | null;
  outbox_pending?: number | null;
  presence?: PresenceLease[] | null;
}

export interface TenantNode {
  id?: string | null;
  label?: string | null;
  rooms?: Array<{
    id?: string | null;
    label?: string | null;
    members?: Array<{ alias?: string | null; enabled?: boolean | null }> | null;
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

export interface TimelineEvent {
  status: 'published' | Extract<DeliveryState, 'accepted' | 'started' | 'done' | 'failed'>;
  at?: string | null;
  attempt?: number | null;
  detail?: string | null;
}

export interface DeliveryView {
  delivery_id?: string | null;
  recipient_tenant?: string | null;
  recipient_alias?: string | null;
  status?: DeliveryState | null;
  attempt?: number | null;
  timeline?: TimelineEvent[] | null;
}

export interface MessageView {
  message_id?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  tenant_id?: string | null;
  room_id?: string | null;
  actor_alias?: string | null;
  body_preview?: string | null;
  lane?: JobLane | null;
  created_at?: string | null;
  deliveries?: DeliveryView[] | null;
}

export interface MessagePage {
  items?: MessageView[] | null;
  next_cursor?: string | null;
}

export interface PublishMessageInput {
  room_id: string;
  recipients: Array<{ tenant_id: string; alias: string }>;
  body: { text: string };
  lane: JobLane;
  priority: number;
  idempotency_key: string;
}

export interface PublishResult {
  message_id?: string | null;
  delivery_ids?: string[] | null;
  duplicate?: boolean | null;
  request_id?: string | null;
  trace_id?: string | null;
}

export interface QueueItem {
  delivery_id?: string | null;
  message_id?: string | null;
  tenant_id?: string | null;
  recipient_alias?: string | null;
  lane?: JobLane | null;
  state?: DeliveryState | null;
  attempts?: number | null;
  max_attempts?: number | null;
  available_at?: string | null;
  last_error?: string | null;
}

export interface QueueSnapshot {
  observed_at?: string | null;
  pending?: number | null;
  retrying?: number | null;
  dead?: number | null;
  items?: QueueItem[] | null;
}

export interface ReplayResult {
  delivery_id?: string | null;
  state?: DeliveryState | null;
  replayed?: boolean | null;
}

export interface JobView {
  job_id?: string | null;
  tenant_id?: string | null;
  lane?: JobLane | null;
  kind?: string | null;
  status?: 'queued' | 'running' | 'done' | 'failed' | 'dead' | null;
  priority?: number | null;
  attempts?: number | null;
  claimed_by?: string | null;
  created_at?: string | null;
}

export interface JobPage {
  items?: JobView[] | null;
}

export interface CreateJobInput {
  lane: JobLane;
  priority: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface AdapterView {
  id?: string | null;
  label?: string | null;
  state?: CapabilityState | null;
  capabilities?: string[] | null;
  protocol_version?: string | null;
  last_seen_at?: string | null;
  detail?: string | null;
}

export interface AdapterPage {
  items?: AdapterView[] | null;
}

export interface AuditEvent {
  event_id?: string | null;
  at?: string | null;
  tenant_id?: string | null;
  actor_alias?: string | null;
  action?: string | null;
  decision?: 'allow' | 'deny' | null;
  request_id?: string | null;
  trace_id?: string | null;
  summary?: string | null;
}

export interface AuditPage {
  items?: AuditEvent[] | null;
}

export type OriginRelayState = 'pending' | 'processing' | 'sent' | 'failed';

export interface OriginRelayView {
  id?: string | null;
  tenant_id?: string | null;
  adapter?: string | null;
  request_id?: string | null;
  message_id?: string | null;
  delivery_id?: string | null;
  trace_id?: string | null;
  status?: OriginRelayState | null;
  attempts?: number | null;
  created_at?: string | null;
  sent_at?: string | null;
}

export interface OriginRelayPage {
  items?: OriginRelayView[] | null;
}

export interface TerminalCapability {
  available: boolean;
  plugin_id?: string | null;
  capabilities?: string[] | null;
  websocket_path?: string | null;
  target_label?: string | null;
  reason?: string | null;
}

export type ConfigResource = 'tenant' | 'room' | 'membership' | 'acl_edge' | 'harness' | 'role_policy';
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
  tenants?: Array<Record<string, unknown>> | null;
  rooms?: Array<Record<string, unknown>> | null;
  memberships?: Array<Record<string, unknown>> | null;
  acl_edges?: Array<Record<string, unknown>> | null;
  harness_definitions?: Array<Record<string, unknown>> | null;
  role_policies?: Array<Record<string, unknown>> | null;
  /**
   * Registro de agentes y pool de cuentas. Las cuatro claves son opcionales a propósito: un
   * gateway anterior a la migración 010 no las publica, y eso NO es lo mismo que una lista vacía.
   * La UI distingue "clave ausente" (dato no disponible) de "lista vacía" (cero filas conocidas).
   */
  agents?: Array<Record<string, unknown>> | null;
  /** `credential_ref` nunca viaja acá; `external_account_id` y `credential_ref_kind` los anula el
   *  servidor para una cuenta que paga otro tenant. */
  provider_accounts?: Array<Record<string, unknown>> | null;
  alias_routing_ceiling?: Array<Record<string, unknown>> | null;
  agent_account_bindings?: Array<Record<string, unknown>> | null;
  revisions?: ConfigRevision[] | null;
}

export interface ConfigurationChangeResult {
  applied?: boolean | null;
  dry_run?: boolean | null;
  revision?: number | null;
  summary?: string | null;
  mutation?: ConfigMutation | null;
  inverse_mutation?: ConfigMutation | null;
}

export interface ObservabilitySnapshot {
  observed_at?: string | null;
  status?: Record<string, unknown> | null;
  queues?: QueueSnapshot | null;
  jobs?: JobPage | null;
  origin_relays?: OriginRelayPage | null;
}

// ---------------------------------------------------------------------------------------------
// GET /v3/console/activity — actividad en vuelo de la flota, agregada por alias. Ver
// features/activity para la derivación pura de badges y umbrales, y el SQL de referencia en el
// contrato (fleetActivity()): esta vista NUNCA trae cuerpos de mensaje, `result` ni `last_error`;
// eso queda para Messages/Chains, que ya redactan.

export type FleetWorkState = 'idle' | 'queued' | 'working' | 'saturated' | 'stalled';

/** Acumulativo y no excluyente: un agente puede estar saturado Y con ACKs detenidos a la vez. */
export type FleetActivityFlag =
  | 'saturated'
  | 'ack_stalled'
  | 'overdue_acks'
  | 'lease_expired'
  | 'never_connected'
  | 'unregistered'
  | 'queued_without_consumer';

export interface FleetActivityThresholds {
  saturation_in_flight?: number | null;
  stall_after_seconds?: number | null;
  ack_recent_seconds?: number | null;
  ack_lookback_seconds?: number | null;
  items_per_agent?: number | null;
}

/** Subconjunto de PresenceLease relevante a esta vista; misma fuente (connection_leases). */
export interface FleetActivityPresence {
  online?: boolean | null;
  instance_id?: string | null;
  epoch?: number | null;
  last_heartbeat_at?: string | null;
  lease_until?: string | null;
}

export interface FleetActivityItem {
  delivery_id?: string | null;
  message_id?: string | null;
  trace_id?: string | null;
  from_tenant?: string | null;
  from_alias?: string | null;
  lane?: JobLane | null;
  /** Sólo el adaptador de origen ('bus', 'telegram'…). Nunca conversation_id. */
  origin_adapter?: string | null;
  published_at?: string | null;
  status?: DeliveryState | null;
  attempt?: number | null;
  claimed_at?: string | null;
  ack_deadline_at?: string | null;
  seconds_in_flight?: number | null;
  last_ack_at?: string | null;
  last_ack_status?: string | null;
}

export interface FleetActivityAgent {
  tenant_id: string;
  alias: string;
  display_name?: string | null;
  harness_id?: string | null;
  /** false: el alias apareció por deliveries o por lease, no por el registro de agentes. */
  registered?: boolean | null;
  agent_enabled?: boolean | null;
  presence?: FleetActivityPresence | null;
  work_state?: FleetWorkState | null;
  flags?: FleetActivityFlag[] | null;
  in_flight?: number | null;
  started?: number | null;
  claimed_not_started?: number | null;
  queued?: number | null;
  queued_ready?: number | null;
  retrying?: number | null;
  overdue_in_flight?: number | null;
  oldest_claimed_at?: string | null;
  oldest_in_flight_seconds?: number | null;
  nearest_ack_deadline_at?: string | null;
  max_attempt?: number | null;
  last_ack_at?: string | null;
  /**
   * null significa "ningún ACK aplicado dentro de ack_lookback_seconds" — la señal MÁS grave,
   * nunca "recién ackeado". No renderizar como 0; usar formatAckAge() de features/activity.
   */
  seconds_since_last_ack?: number | null;
  acks_recent?: number | null;
  in_flight_items_truncated?: boolean | null;
  in_flight_items?: FleetActivityItem[] | null;
}

export interface FleetActivityTotals {
  agents?: number | null;
  /** Excluyente: suma a totals.agents. */
  by_state?: Partial<Record<FleetWorkState, number>> | null;
  /** Acumulativo: NO suma a totals.agents ni entre sí. */
  flagged?: Partial<Record<FleetActivityFlag, number>> | null;
  in_flight?: number | null;
  queued?: number | null;
  retrying?: number | null;
  overdue_in_flight?: number | null;
}

export interface FleetActivitySnapshot {
  observed_at?: string | null;
  thresholds?: FleetActivityThresholds | null;
  totals?: FleetActivityTotals | null;
  agents?: FleetActivityAgent[] | null;
}

// ---------------------------------------------------------------------------------------------
// GET /v3/console/quotas — última muestra de cuota por (host, proveedor, grupo, ventana), más
// sparkline de 24h. Ver features/quotas para agrupar por family (antigravity) y elegir la peor
// ventana de un grupo colapsado.

export type QuotaSeverity = 'ok' | 'warn' | 'critical' | 'exhausted' | 'unknown';

export interface QuotaHistoryPoint {
  at?: string | null;
  used_percent?: number | null;
}

export interface QuotaHistory {
  bucket_seconds?: number | null;
  points?: QuotaHistoryPoint[] | null;
}

export interface QuotaWindow {
  window_key?: string | null;
  label?: string | null;
  used_percent?: number | null;
  remaining_percent?: number | null;
  used_units?: number | null;
  limit_units?: number | null;
  window_minutes?: number | null;
  reset_at?: string | null;
  reset_in_seconds?: number | null;
  status?: string | null;
  family?: string | null;
  model?: string | null;
  severity?: QuotaSeverity | null;
  history?: QuotaHistory | null;
}

export interface QuotaGroup {
  group_key?: string | null;
  limit_id?: string | null;
  /** Ninguno de los dos viaja salvo que el actor sea el pagador — misma regla que getAgent(). */
  account_id?: string | null;
  account_label?: string | null;
  account_provider?: string | null;
  payer_tenant_id?: string | null;
  paused_until?: string | null;
  paused_reason?: string | null;
  min_remaining_percent?: number | null;
  severity?: QuotaSeverity | null;
  windows?: QuotaWindow[] | null;
}

export interface QuotaProviderReport {
  host?: string | null;
  provider?: string | null;
  /** ok=false con groups=[] es información ("el CLI dejó de responder"), no ausencia de dato. */
  ok?: boolean | null;
  available?: boolean | null;
  kind?: string | null;
  source?: string | null;
  plan?: string | null;
  note?: string | null;
  effective_remaining_percent?: number | null;
  observed_at?: string | null;
  age_seconds?: number | null;
  available_groups?: string[] | null;
  limiting_groups?: string[] | null;
  severity?: QuotaSeverity | null;
  groups?: QuotaGroup[] | null;
}

export interface QuotaCollector {
  host?: string | null;
  collector_tenant?: string | null;
  collector_alias?: string | null;
  captured_at?: string | null;
  received_at?: string | null;
  /** Frescura real: medida contra received_at (reloj del servidor), no captured_at. */
  age_seconds?: number | null;
  stale?: boolean | null;
  schema_version?: number | null;
  app_version?: string | null;
  provider_count?: number | null;
  window_count?: number | null;
}

export interface QuotaUnboundGroup {
  host?: string | null;
  provider?: string | null;
  group_key?: string | null;
  window_count?: number | null;
  reason?: string | null;
  detail?: string | null;
}

export interface QuotaPausedAccount {
  account_id?: string | null;
  provider?: string | null;
  label?: string | null;
  payer_tenant_id?: string | null;
  paused_until?: string | null;
  paused_reason?: string | null;
  /** false: pausada a mano por un operador; el recolector nunca debe pisar esa pausa. */
  automatic?: boolean | null;
}

export interface QuotaThresholds {
  stale_after_seconds?: number | null;
  warn_remaining_percent?: number | null;
  critical_remaining_percent?: number | null;
  history_window_seconds?: number | null;
  history_bucket_seconds?: number | null;
  history_max_points?: number | null;
}

export interface QuotaSnapshot {
  observed_at?: string | null;
  thresholds?: QuotaThresholds | null;
  collectors?: QuotaCollector[] | null;
  providers?: QuotaProviderReport[] | null;
  unbound_groups?: QuotaUnboundGroup[] | null;
  paused_accounts?: QuotaPausedAccount[] | null;
}
