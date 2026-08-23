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
  | 'config.rollback' | 'ultimate-terminal.connect';

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

export interface CancelResult {
  delivery_id?: string | null;
  state?: DeliveryState | null;
  cancelled?: boolean | null;
  cancelled_from_state?: DeliveryState | null;
  parent_notice?: string | null;
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
   * Cada fila de `agents` trae `role_brief`: el rol declarado que el adaptador antepone al
   * contrato (`Tu rol: ...`). Es `string | null` — NULL significa "sin rol declarado", que no es
   * lo mismo que la cadena vacía: el store convierte '' en NULL antes de guardar porque el CHECK
   * de la base exige longitud >= 1. Se escribe con la mutación
   * `{ resource: 'agent', action: 'update', tenant_id, alias, value: { role_brief } }`, que deja
   * su inversa en `config_revisions`; el tope es 1200 PUNTOS DE CÓDIGO, no `String.length`.
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
  bytes?: number | null;
  modified_at?: string | null;
  /** El texto del fichero, si el servidor lo publica. Sin él sólo se puede listar, no cotejar. */
  text?: string | null;
  /** true si el servidor recortó el texto: lo que se ve NO es el fichero entero. */
  truncated?: boolean | null;
}

/** El índice de la memoria de un agente. Índice, no contenido: es lo que pidió Steven. */
export interface AgentMemoryIndex {
  root?: string | null;
  /** Cuántas entradas hay DE VERDAD, aunque `entries` venga recortado. */
  total?: number | null;
  truncated?: boolean | null;
  entries?: Array<{
    path?: string | null;
    bytes?: number | null;
    modified_at?: string | null;
  }> | null;
}

export interface AgentDirective {
  /**
   * false = este gateway no publica el endpoint. NO significa «el agente no tiene ficheros»:
   * significa que no se miró. La pantalla tiene que decir una cosa y no la otra.
   */
  publicado: boolean;
  /** Por qué no se pudo leer, cuando `publicado` es false. */
  motivo?: string;
  observed_at?: string | null;
  container_id?: string | null;
  files?: AgentDirectiveFile[] | null;
  memory?: AgentMemoryIndex | null;
}
