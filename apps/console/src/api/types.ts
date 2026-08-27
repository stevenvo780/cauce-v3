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
  | 'message.publish' | 'delivery.replay' | 'delivery.cancel' | 'job.create' | 'config.write'
  | 'config.rollback' | 'dlq.resolve' | 'ultimate-terminal.connect';

/**
 * `password` = el gateway pide correo y contraseña en su propio formulario (POST /v3/auth/login).
 * `redirect` = hay que mandar al navegador a /v3/auth/login (BFF OIDC). Ausente se lee como
 * `redirect`, que es como se comportaba la consola antes de que existiera el login por
 * contraseña: un gateway viejo no deja de funcionar por no conocer este campo.
 */
export type LoginMode = 'password' | 'redirect';

export interface ConsoleAuthState {
  /** null means the selected legacy auth mode has no BFF session facade. */
  authenticated: boolean | null;
  login_mode?: LoginMode | null;
  subject?: string | null;
  name?: string | null;
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

/**
 * `GET /v3/console/messages/:messageId` — el mensaje entero, con el cuerpo SIN recortar.
 *
 * `body` es `jsonb` en la base y su forma depende de quién publicó (`text` en los adaptadores,
 * `prompt` en los encargos, y filas con otra forma). Se tipa como `unknown` a propósito: la
 * consola lo interpreta en `features/terminal/cuerpo-del-mensaje.ts` y ahí está escrito qué hace
 * cuando la forma no es ninguna de las conocidas.
 */
export interface MessageDetail {
  id?: string | null;
  message_id?: string | null;
  trace_id?: string | null;
  tenant_id?: string | null;
  room_id?: string | null;
  actor_alias?: string | null;
  body?: unknown;
  lane?: JobLane | null;
  created_at?: string | null;
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

export type PublishIntentSemantics = Omit<PublishMessageInput, 'idempotency_key'>;

export interface PreparePublishIntentInput extends PublishIntentSemantics {
  /** UUIDv4 efímero por submit deliberado; nunca se persiste en el navegador. */
  intent_nonce: string;
}

export interface PublishResult {
  message_id?: string | null;
  delivery_ids?: string[] | null;
  duplicate?: boolean | null;
  request_id?: string | null;
  trace_id?: string | null;
  idempotency_key?: string | null;
  tenant_id?: string | null;
  actor_alias?: string | null;
  request_hash?: string | null;
  causal_hash?: string | null;
}

export interface DurablePublishReceipt {
  message_id: string;
  delivery_ids: string[];
  duplicate: boolean;
  request_id: string;
  trace_id: string;
  idempotency_key: string;
  tenant_id: string;
  actor_alias: string;
  request_hash: string;
  causal_hash: string;
}

export interface PreparePublishIntentResult {
  version: 1;
  state: 'prepared' | 'committed';
  idempotency_key: string;
  receipt: PublishResult | null;
}

export interface PreparePublishIntentReconciliation {
  version: 1;
  error: 'publish_intent_reconciliation_required';
  state: 'committed';
  idempotency_key: string;
  receipt: PublishResult;
}

/** The server proved that this reservation closed before any publish effect existed. */
export interface PublishIntentExpired {
  version: 1;
  error: 'publish_intent_expired';
  state: 'expired';
  idempotency_key: string;
  safe_to_resubmit: true;
}

/** A bounded server-side journal admission limit; the same nonce retry remains idempotent. */
export interface PreparePublishIntentRateLimited {
  version: 1;
  error: 'publish_intent_rate_limited';
  retry_after_seconds: number;
  safe_to_retry: true;
}

export interface ConfirmPublishIntentInput {
  idempotency_key: string;
  message_id: string;
  causal_hash: string;
}

export interface ConfirmPublishIntentResult extends ConfirmPublishIntentInput {
  version: 1;
  confirmed: true;
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

export type DlqTarget = 'delivery' | 'outbox';
export type DlqDisposition =
  | 'ambiguous'
  | 'safe_retry'
  | 'missing_final'
  | 'auth'
  | 'expected_offline'
  | 'unclassified';

/**
 * Safe schema-030 projection.  It intentionally has no payload, error, reason, origin,
 * provider/message/delivery/outbox id or body field: this is the complete browser contract.
 */
export interface DlqItem {
  target?: DlqTarget | null;
  id?: string | null;
  tenantId?: string | null;
  kind?: string | null;
  adapter?: string | null;
  disposition?: DlqDisposition | null;
  open?: boolean | null;
  actionable?: boolean | null;
  evidenceSha256?: string | null;
  attempts?: number | null;
  resolutionRule?: string | null;
  createdAt?: string | null;
  dispositionAt?: string | null;
  resolvedAt?: string | null;
  reopenCount?: number | null;
  lastReopenedAt?: string | null;
}

export interface DlqPage {
  schemaVersion?: number | null;
  items?: DlqItem[] | null;
  total?: number | null;
  truncated?: boolean | null;
  nextCursor?: string | null;
}

export interface ResolveDlqWithoutReplayInput {
  target: DlqTarget;
  id: string;
  evidenceSha256: string;
  reason: string;
  possibleDuplicateAcknowledged: boolean;
  possibleNoDeliveryAcknowledged: boolean;
}

export interface ResolveDlqWithoutReplayResult {
  schemaVersion?: number | null;
  suite?: string | null;
  phase?: 'resolved' | null;
  appliedCount?: number | null;
  alreadyApplied?: boolean | null;
  evidenceSha256?: string | null;
  reasonSha256?: string | null;
  possibleDuplicateAcknowledged?: boolean | null;
  possibleNoDeliveryAcknowledged?: boolean | null;
}

export interface ReplayResult {
  delivery_id?: string | null;
  replayed_from_delivery_id?: string | null;
  state?: DeliveryState | null;
  replayed?: boolean | null;
}

export interface CancelResult {
  delivery_id?: string | null;
  state?: DeliveryState | null;
  cancelled?: boolean | null;
  cancelled_from_state?: DeliveryState | null;
  parent_notice?: 'not_child' | 'returned' | 'denied' | 'deferred' | 'coalesced' | null;
  origin_relayed?: boolean | null;
  /** Siempre true: cancelar deja fila en `dead_letters`, o sea sigue siendo replayable. */
  replayable?: boolean | null;
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
  decision?: 'allow' | 'deny' | 'info' | null;
  request_id?: string | null;
  trace_id?: string | null;
  summary?: string | null;
}

export interface AuditPage {
  items?: AuditEvent[] | null;
  next_cursor?: string | null;
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
  tenants?: Array<Record<string, unknown>> | null;
  rooms?: Array<Record<string, unknown>> | null;
  memberships?: Array<Record<string, unknown>> | null;
  acl_edges?: Array<Record<string, unknown>> | null;
  harness_definitions?: Array<Record<string, unknown>> | null;
  role_policies?: Array<Record<string, unknown>> | null;
  /** Singleton `default` de la política de visibilidad de cadena (migración 008). */
  chain_policies?: Array<Record<string, unknown>> | null;
  /** Allowlist de egress proactivo (migración 009). */
  egress_destinations?: Array<Record<string, unknown>> | null;
  /**
   * Registro de agentes y pool de cuentas. Las cuatro claves son opcionales a propósito: un
   * gateway anterior a la migración 010 no las publica, y eso NO es lo mismo que una lista vacía.
   * La UI distingue "clave ausente" (dato no disponible) de "lista vacía" (cero filas conocidas).
   *
   * Cada fila de `agents` trae `role_brief` únicamente como proyección legacy de sólo lectura de
   * `agent_profiles.role_summary`. La consola nunca la escribe: el PUT canónico de Perfil hace
   * CAS, materializa el runtime y sólo después acredita `applied_revision`.
   */
  agents?: Array<Record<string, unknown>> | null;
  /** `credential_ref` nunca viaja acá; `external_account_id` y `credential_ref_kind` los anula el
   *  servidor para una cuenta que paga otro tenant. */
  provider_accounts?: Array<Record<string, unknown>> | null;
  alias_routing_ceiling?: Array<Record<string, unknown>> | null;
  agent_account_bindings?: Array<Record<string, unknown>> | null;
  /** Copia diagnóstica de sólo lectura; las escrituras usan la API canónica de Perfil. */
  agent_profiles?: Array<Record<string, unknown>> | null;
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

export interface ObservabilitySnapshot {
  observed_at?: string | null;
  status?: Record<string, unknown> | null;
  queues?: QueueSnapshot | null;
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
  /**
   * Salas del alias. Evita cruzar a mano contra la topología para saber dónde vive un agente.
   * Opcional: hoy el SQL de /activity no lo trae (ver fase de backend del expediente).
   */
  rooms?: string[] | null;
  /**
   * Entregas CERRADAS en las últimas 24 h. Es el tamaño del muñeco en el mapa.
   *
   * `undefined` (campo ausente) y `0` NO son lo mismo y no pueden dibujarse igual: ausente
   * significa "el servidor no informa el cierre de 24 h" y obliga a tamaño uniforme más una
   * leyenda que lo declare; 0 significa "no cerró nada", que sí es un dato y sí se dibuja chico.
   */
  closed_24h?: number | null;
  failed_24h?: number | null;
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

/**
 * Delegación agregada por par, tal como la contaría el servidor sobre una ventana.
 *
 * El extremo que el actor no puede ver llega ya reducido a un id opaco desde el store (mismo
 * vocabulario `redacted`/`opaqueNodeId` que `agentChain`): la arista NO se borra, porque un mapa
 * al que le faltan flechas miente por omisión y no hay forma de notarlo desde la pantalla.
 */
export interface FleetDelegationEdge {
  from_tenant?: string | null;
  from_alias?: string | null;
  to_tenant?: string | null;
  to_alias?: string | null;
  /** Entregas de ese par en vuelo AHORA. Es lo que pinta la flecha de azul. */
  in_flight?: number | null;
  /** Entregas de ese par en toda la ventana. Es lo que da el grosor. */
  total_window?: number | null;
  last_at?: string | null;
}

export interface FleetActivitySnapshot {
  observed_at?: string | null;
  thresholds?: FleetActivityThresholds | null;
  totals?: FleetActivityTotals | null;
  agents?: FleetActivityAgent[] | null;
  /** Opcional: hasta la fase de backend, el grosor sale sólo de las entregas en vuelo. */
  edges?: FleetDelegationEdge[] | null;
}

// ---------------------------------------------------------------------------------------------
// GET /v3/console/chains/:traceId — una cadena de delegación completa, por trace.
//
// La forma está copiada de `repository.agentChain()` (packages/store), no inventada: el endpoint
// existía en el gateway desde hace tiempo y no tenía UN SOLO consumidor en la consola. La
// visibilidad ya la resolvió el store nodo por nodo; acá no se filtra nada, sólo se dibuja.

/** Un extremo de arista: o es un agente que el actor puede ver, o es un id opaco y estable. */
export type AgentChainEndpoint =
  | {
    tenant_id?: string | null;
    alias?: string | null;
    delivery_id?: string | null;
    attempt?: number | null;
    status?: DeliveryState | null;
    terminal_at?: string | null;
    redacted?: false;
  }
  | { redacted: true; node_id: string };

export interface AgentChainNode {
  tenant_id?: string | null;
  alias?: string | null;
  hop_count?: number | null;
  delegated?: number | null;
  received?: number | null;
  open_branches?: number | null;
}

export interface AgentChainEdge {
  source: AgentChainEndpoint;
  /** `null` cuando la rama no llegó a materializarse (rechazada, o sin entrega producida). */
  target: AgentChainEndpoint | null;
  output_index?: number | null;
  state?: string | null;
  rejection_code?: string | null;
  hop_count?: number | null;
  hop_budget?: number | null;
  visited_depth?: number | null;
  /** La rama sigue viva: materializada y con el destino en un estado no terminal. */
  open?: boolean | null;
  response?: { decision?: string | null; reason?: string | null; outcome?: string | null } | null;
  root_message_id?: string | null;
  created_at?: string | null;
}

export interface AgentChainCounters {
  edges?: number | null;
  /** Aristas cuyos DOS extremos son invisibles para el actor. Se declaran, no se esconden. */
  hidden_edges?: number | null;
  redacted_endpoints?: number | null;
  open_branches?: number | null;
  rejected_branches?: number | null;
}

export interface AgentChainSnapshot {
  trace_id?: string | null;
  observed_at?: string | null;
  truncated?: boolean | null;
  nodes?: AgentChainNode[] | null;
  edges?: AgentChainEdge[] | null;
  origin_relays?: Record<string, unknown>[] | null;
  counters?: AgentChainCounters | null;
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

// ------------------------------------------------------------------------------------------
// LAS TRES CAPAS DE DIRECTIVA DE UN AGENTE
//
// Medido sobre producción el 23-ago-2026 (/workspace/DISENO-TRES-CAPAS-DE-DIRECTIVA.md): lo que
// gobierna a un alias no vive en un sitio, vive en tres, y la consola sólo veía uno.
//
//   Capa 1 · `agents.role_brief` — QUIÉN SOS y QUÉ PODÉS DECIDIR. Está en la base, viaja en cada
//            entrega, y es la única que la consola ya sabía editar. Llega por `/v3/console/config`.
//   Capa 2 · `CLAUDE.md` / `AGENTS.md` — CÓMO SE TRABAJA AQUÍ. Es un FICHERO dentro del
//            contenedor del alias, en dos niveles posibles (usuario y espacio de trabajo). Hoy
//            sólo se toca por `docker exec`, que es exactamente por lo que nadie lo mantiene:
//            janus tiene DOS a la vez y gaia no tiene NINGUNO.
//   Capa 3 · La memoria — LO QUE ESE AGENTE APRENDIÓ. `~/.claude/projects`, `~/.openclaw/memory`.
//            zeus tiene 18.212 ficheros ahí y gaia 2, y nadie lo ve desde el panel.
//
// Las capas 2 y 3 son ficheros de un contenedor, no filas de la base: el gateway tiene que
// publicarlas. Estos tipos son el contrato con el que la consola las va a leer; mientras el
// gateway no lo sirva, `getAgentDirective` devuelve `publicado: false` y la pantalla lo DICE con
// esas palabras, en vez de pintar «sin CLAUDE.md» sobre una lectura que nunca ocurrió.
// ------------------------------------------------------------------------------------------

/** Un `CLAUDE.md` / `AGENTS.md` concreto dentro del contenedor de un alias. */
export interface AgentDirectiveFile {
  path?: string | null;
  /** `user` = `~/.claude/CLAUDE.md`; `workspace` = `~/CLAUDE.md` o `/workspace/CLAUDE.md`. */
  scope?: 'user' | 'workspace' | string | null;
  /** Orden medido: Codex aplica precedencia; Claude lo expone sólo como orden de carga. */
  precedence?: number | null;
  /** Huella real para detectar manuales duplicados aunque el texto visible esté truncado. */
  sha?: string | null;
  bytes?: number | null;
  modified_at?: string | null;
  /** El texto del fichero, si el servidor lo publica. Sin él sólo se puede listar, no cotejar. */
  text?: string | null;
  /** true si el servidor recortó el texto: lo que se ve NO es el fichero entero. */
  truncated?: boolean | null;
  error?:
    | 'permission_denied' | 'invalid_path' | 'symlink_detected' | 'too_large'
    | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown' | string | null;
  reason?: string | null;
}

/** El índice de la memoria de un agente. Índice, no contenido: es lo que pidió Steven. */
export interface AgentMemoryIndexAvailable {
  root?: string | null;
  /** Total exacto; null significa que sólo se conoce `observed_at_least`. */
  total?: number | null;
  /** Límite inferior observado cuando el barrido alcanzó su cap. */
  observed_at_least?: number | null;
  truncated?: boolean | null;
  entries?: Array<{
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }> | null;
  error?: never;
  reason?: never;
}

export interface AgentMemoryIndexUnavailable {
  root?: string | null;
  total?: null;
  observed_at_least?: null;
  truncated?: null;
  entries?: null;
  error:
    | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
    | 'too_large' | 'timeout' | 'cancelled' | 'busy' | 'unavailable' | 'unknown';
  reason: string;
}

/** `error` discrimina una medición fallida; los gateways nuevos no la esconden como `null`. */
export type AgentMemoryIndex = AgentMemoryIndexAvailable | AgentMemoryIndexUnavailable;

// ------------------------------------------------------------------------------------------
// LOS FICHEROS QUE GOBIERNAN A UN AGENTE
//
// `GET /v3/console/tenants/:tenantId/agents/:alias/documents` da el INVENTARIO
// (qué fichero es cuál y dónde vive)
// y `.../documents/:kind/content` da y recibe el CONTENIDO.
//
// La honestidad de esta pantalla depende de leer bien tres campos, porque los tres significan
// cosas distintas y los tres se parecen a «no se puede»:
//
//   `facts_source`   de dónde salió la RUTA. Sólo `measured` es de fiar; el registro se equivocaba
//                    de arnés en 5 de los 14 alias, así que con cualquier otro valor la ruta es
//                    una pista y no un hecho, y no se sirve contenido.
//   `editable`       el fichero ENTERO se puede escribir.
//   `projected_fields` el fichero entero NO sale nunca, pero estos campos suyos sí. Es el caso de
//                    `openclaw.json`, que lleva `auth` y `secrets` en el mismo documento.
//
// Un documento sin `editable` y sin `projected_fields` es de sólo lectura, y `reason` dice por
// qué CON PALABRAS, que es lo que pidió Steven: un hueco explicado vale más que un botón muerto.
// ------------------------------------------------------------------------------------------

export type AgentDocumentKind =
  | 'directive' | 'tools' | 'prompts' | 'mcp' | 'identity' | 'human'
  | 'memory' | 'heartbeat' | 'configuration';

export interface AgentDocumentItem {
  kind: AgentDocumentKind;
  category?: 'manual' | 'profile' | 'configuration' | 'memory';
  label: string;
  path: string;
  format: string;
  /**
   * true = el servidor admite GET de contenido para esta fila. Es independiente de `editable`:
   * un manual de proyecto o un fichero de perfil puede abrirse en visor sin admitir PUT.
   * Ausente se trata como false para fallar cerrado durante un despliegue escalonado.
   */
  readable?: boolean;
  editable: boolean;
  reason?: string;
  warning?: string;
  projected_fields?: string[] | null;
}

export interface AgentDocumentsMap {
  /** false = este gateway no publica la ruta. NO es «este agente no tiene ficheros». */
  publicado: boolean;
  motivo?: string;
  tenant_id?: string;
  alias?: string;
  facts_source?: 'measured' | 'registry' | 'database';
  harness?: string;
  home?: string | null;
  /** Aviso de arriba del todo cuando la fuente no es una medición. */
  caveat?: string;
  items?: AgentDocumentItem[];
}

export interface AgentDocumentContent {
  tenant_id: string;
  alias: string;
  kind: AgentDocumentKind;
  path: string;
  format: string;
  /** false = el fichero todavía no existe. Se puede crear; NO es lo mismo que estar vacío. */
  exists: boolean;
  content: string;
  /** Huella de lo servido. Se devuelve al guardar para que dos personas no se pisen en silencio. */
  sha: string | null;
  bytes: number;
  editable: boolean;
  /** Un prefijo recortado se puede inspeccionar, pero nunca editar ni reemplazar. */
  truncated: boolean;
  modified_at?: string;
  /** true = lo que se ve es una PROYECCIÓN, no el fichero entero. */
  projected: boolean;
  warning?: string;
}

export interface AgentDocumentGuardado {
  /*
   * Todos son opcionales a propósito: `request<T>` sólo tipa TypeScript, no valida el JSON de un
   * gateway anterior durante un despliegue escalonado. La UI usa un type guard y sólo limpia el
   * borrador cuando TODOS acreditan aplicación.
   */
  ok?: boolean;
  state?: string;
  evidence?: string;
  path?: string;
  sha?: string;
  bytes?: number;
}

export interface AgentDirective {
  /**
   * false = este gateway no publica el endpoint. NO significa «el agente no tiene ficheros»:
   * significa que no se miró. La pantalla tiene que decir una cosa y no la otra.
   */
  publicado: boolean;
  /**
   * ¿El servidor MIDIÓ de verdad el contenedor? `publicado: true` sólo dice que la ruta existe;
   * puede contestar 200 sin haber mirado nada (sin hechos de entorno, o con rutas deducidas del
   * registro, que falla en 5 de 14 alias). Sin este campo la consola no puede distinguir «no hay
   * fichero» de «no se miró», y llegó a afirmar lo primero cuando pasaba lo segundo.
   * Los gateways anteriores no lo mandan: ahí vale la regla del `null` en `files`/`memory`.
   */
  medido?: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  manual_order?: 'codex_precedence' | 'claude_load_order' | 'workspace_only' | string | null;
  context_coverage?: 'standard_manuals' | string | null;
  context_limitations?: string[] | null;
  memory?: AgentMemoryIndex | null;
}

// ------------------------------------------------------------------------------------------
// Historial de cambios del rol declarado
// ------------------------------------------------------------------------------------------

/** Una entrada del diario: un cambio concreto del rol declarado de un alias. */
export interface RoleBriefHistoryEntry {
  id?: string | null;
  tenant_id?: string | null;
  alias?: string | null;
  /** `update`, `insert`, `delete`… lo que declare el trigger. No se asume el juego de valores. */
  operation?: string | null;
  /** El texto que había ANTES. `null` = no había rol (alta), que no es lo mismo que cadena vacía. */
  previous_brief?: string | null;
  /** El texto que quedó DESPUÉS. `null` = se borró el rol. */
  new_brief?: string | null;
  previous_template_slug?: string | null;
  new_template_slug?: string | null;
  /** Quién lo cambió. Hoy llega NULL por todos los caminos: ver el comentario de arriba. */
  actor_tenant?: string | null;
  actor_alias?: string | null;
  changed_at?: string | null;
}

export interface RoleBriefHistory {
  /**
   * false = este gateway no publica el diario. NO significa «este alias nunca cambió de rol».
   * Mismo criterio que `AgentDirective.publicado`, y por la misma razón: un negativo que nadie
   * midió no es un hecho del sistema.
   */
  publicado: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  /**
   * Las entradas tal como las mandó el servidor, SIN ordenar acá. El orden se decide en
   * `historial-rol.ts`, que es donde se puede probar: ver `entradasMasNuevasPrimero`.
   */
  entries?: RoleBriefHistoryEntry[] | null;
}

/**
 * EL PERFIL Y SU VISTA PREVIA
 * (`GET /v3/console/tenants/:tenantId/agents/:alias/perfil`).
 *
 * `ficheros` es EL TEXTO EXACTO que va a quedar en cada fichero que el arnés de ese alias lee,
 * compuesto por la MISMA función que usa el adaptador para escribirlo dentro del contenedor. Que
 * salgan de la misma función es lo que impide que la vista previa mienta: dos implementaciones del
 * mismo texto divergen a la primera corrección y el operador aprobaría un bloque distinto del que
 * acaba en el disco, sin que nada diera error.
 */
export interface AgentPerfilCampos {
  purpose: string;
  role_summary: string;
  human_brief: string;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
}

/** Forma canónica que persiste el gateway; un texto vacío se representa como `null`. */
export interface AgentPerfilValor {
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
}

export interface AgentPerfilFichero {
  nombre: string;
  /** `solo-si-falta` = es del agente (MEMORY.md, HEARTBEAT.md): si existe NO se toca. */
  politica: 'bloque-gestionado' | 'solo-si-falta';
  texto: string;
  unidades: number;
}

export interface AgentPerfil {
  /**
   * false = este gateway no publica la ruta. NO significa «este alias no tiene perfil»: significa
   * que no se miró. Mismo criterio que `AgentDirective.publicado`, y por la misma razón — un
   * negativo que nadie midió no es un hecho del sistema.
   */
  publicado: boolean;
  motivo?: string;
  tenant_id?: string;
  alias?: string;
  /** Estado durable del alias. Ausente se trata como apagado, nunca como habilitado implícito. */
  agent_enabled?: boolean;
  /** Presencia REAL de `agent_profiles`; un perfil persistido vacío sigue siendo `true`. */
  exists?: boolean;
  /** Revisión desired propia del perfil; `null` cuando todavía no existe una fila. */
  revision?: number | null;
  /** Última revisión cuyo lote completo fue acreditado por el runtime. */
  applied_revision?: number | null;
  /** Estado desired/applied calculado por el gateway, no inferido por el navegador. */
  runtime_state?:
    | 'absent' | 'pending' | 'pending_session_refresh' | 'applied' | 'disabled'
    | 'drifted' | 'runtime_unverified';
  /** Evidencia viva de ruta+SHA+generación; sin ella la UI nunca afirma aplicación. */
  runtime_verification?: {
    state: 'current' | 'drifted' | 'unverified';
    generation: string | null;
    container_id: string | null;
    observed_at: string | null;
    reason?: string;
    documents: Array<{
      name: string;
      path: string;
      expected_sha: string;
      observed_sha: string | null;
      expected_bytes: number;
      observed_bytes: number | null;
      current: boolean;
    }>;
  } | null;
  runtime_adoption?: {
    evidence: 'adapter_delivery';
    revision: number;
    generation: string;
    adopted_at: string;
    documents: Array<{ name: string; path: string; sha: string }>;
  } | null;
  runtime_reason?: string;
  /** El arnés declarado en los hechos. `null` cuando el registro no dice ninguno. */
  harness?: string | null;
  perfil: AgentPerfilValor;
  hechos?: {
    permisos: { ruta: boolean; lectura: boolean; control: boolean; notificacion: boolean };
    cuotas: Array<{ proveedor: string; cuenta: string; limite?: string }>;
    arnes: { harness: string; home: string; contenedor?: string; capacidades: string[] };
    destinos: string[];
  };
  limites?: {
    purpose: number;
    role_summary: number;
    item: number;
    items: number;
    total: number;
  };
  medida?: { unidades: number; tope: number };
  /**
   * De qué se compuso la vista previa. `fichero-vacio` significa que el servidor NO leyó el disco
   * del contenedor: lo que una persona haya escrito a mano sigue ahí y no se toca —la fusión
   * conserva lo de fuera byte a byte—, pero esta respuesta no lo ha visto y no puede enseñarlo.
   */
  base?: 'fichero-vacio' | 'runtime-medido';
  ficheros?: AgentPerfilFichero[];
  /** Por qué no hay ficheros, cuando no los hay. Un array vacío sin explicación se lee mal. */
  aviso?: string;
}

export interface AgentPerfilRuntimeAck {
  name: string;
  path: string;
  state: 'written' | 'already_current' | 'preserved';
  sha: string;
  bytes: number;
  generation: string;
  container_id: string | null;
}

/** Respuesta que permite afirmar que desired y runtime convergieron en la misma revisión. */
export interface AgentPerfilAplicado {
  ok: true;
  state: 'applied';
  tenant_id: string;
  alias: string;
  revision: number;
  applied_revision: number;
  acknowledgements: AgentPerfilRuntimeAck[];
  runtime_adoption: {
    evidence: 'adapter_delivery';
    revision: number;
    generation: string;
    adopted_at: string;
    documents: Array<{ name: string; path: string; sha: string }>;
  };
}
