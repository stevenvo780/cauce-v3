import type { DeliveryState, JobLane } from './deliveries';

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
