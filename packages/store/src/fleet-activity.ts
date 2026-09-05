/**
 * Fleet activity heuristics and queries for GET /v3/console/activity.
 */

export interface FleetActivityThresholds {
  /** How many in-flight deliveries make an agent be considered saturated. */
  saturation_in_flight: number;
  stall_after_seconds: number; // Seconds without an applied ACK before an agent counts as stalled.
  /** Seconds window within which an ACK counts as recent. */
  ack_recent_seconds: number;
  /** Look-back window in seconds for the last applied ACK. */
  ack_lookback_seconds: number;
  /** Cap of in-flight deliveries detailed per alias in in_flight_items. */
  items_per_agent: number;
  start_after_seconds: number; // Maximum claim age before its first applied ACK is required.
}

export const DEFAULT_FLEET_ACTIVITY_THRESHOLDS: FleetActivityThresholds = {
  saturation_in_flight: 8,
  stall_after_seconds: 300,
  ack_recent_seconds: 300,
  ack_lookback_seconds: 3600,
  items_per_agent: 10,
  start_after_seconds: 60
};

export const FLEET_WORK_STATES = ['idle', 'queued', 'working', 'saturated', 'stalled'] as const;
export type FleetWorkState = (typeof FLEET_WORK_STATES)[number];

export const FLEET_ACTIVITY_FLAGS = [
  'saturated', 'ack_stalled', 'overdue_acks', 'lease_expired',
  'never_connected', 'unregistered', 'queued_without_consumer', 'claimed_not_started'
] as const;
export type FleetActivityFlag = (typeof FLEET_ACTIVITY_FLAGS)[number];

/** Minimum input needed to evaluate an agent's activity state. */
export interface FleetActivityWorkStateInput {
  registered: boolean;
  in_flight: number;
  queued: number;
  overdue_in_flight: number;
  claimed_not_started: number;
  oldest_in_flight_seconds: number | null; // null when nothing is in flight.
  oldest_claimed_not_started_without_ack_seconds: number | null;
  oldest_claimed_not_started_activity_seconds: number | null;
  /** Seconds since the last applied ACK, or null if none was recorded within the window. */
  seconds_since_last_ack: number | null;
  /** true = lease in force, false = lease expired, null = no lease recorded. */
  lease_online: boolean | null;
}

export interface FleetActivityWorkStateResult {
  work_state: FleetWorkState;
  flags: FleetActivityFlag[];
}

/**
 * Computes the primary work state and the associated diagnostic flags.
 * Badge precedence: stalled > saturated > working > queued > idle.
 */
export function agentWorkState(
  row: FleetActivityWorkStateInput,
  thresholds: FleetActivityThresholds = DEFAULT_FLEET_ACTIVITY_THRESHOLDS
): FleetActivityWorkStateResult {
  const ackIsStale = row.seconds_since_last_ack === null || row.seconds_since_last_ack > thresholds.stall_after_seconds;
  const neverAcked = row.oldest_claimed_not_started_without_ack_seconds !== null
    && row.oldest_claimed_not_started_without_ack_seconds > thresholds.start_after_seconds;
  const ownAckIsStale = row.oldest_claimed_not_started_activity_seconds !== null
    && row.oldest_claimed_not_started_activity_seconds > thresholds.stall_after_seconds;
  const noEmpieza = row.claimed_not_started > 0 && (neverAcked || ownAckIsStale);
  const stalled = noEmpieza || (row.in_flight > 0 && (row.overdue_in_flight > 0 || ackIsStale));
  const saturated = row.in_flight >= thresholds.saturation_in_flight;

  const work_state: FleetWorkState = stalled
    ? 'stalled'
    : saturated
      ? 'saturated'
      : row.in_flight > 0
        ? 'working'
        : row.queued > 0
          ? 'queued'
          : 'idle';

  const flags: FleetActivityFlag[] = [];
  if (saturated) flags.push('saturated');
  if (row.in_flight > 0 && ackIsStale) flags.push('ack_stalled');
  if (row.overdue_in_flight > 0) flags.push('overdue_acks');
  if (row.lease_online === false) flags.push('lease_expired');
  if (row.lease_online === null) flags.push('never_connected');
  if (!row.registered) flags.push('unregistered');
  if (row.in_flight === 0 && row.queued > 0) flags.push('queued_without_consumer');
  if (noEmpieza) flags.push('claimed_not_started');

  return { work_state, flags };
}

/**
 * Fleet activity aggregation query for GET /v3/console/activity.
 */
export const FLEET_ACTIVITY_QUERY = `
WITH visible_tenants AS (
  -- Misma regla default-deny que topology() y listAgents(): el propio tenant, más cualquier
  -- tenant al que el actor tenga una arista ACL allow_read habilitada.
  SELECT t.id AS tenant_id
    FROM tenants t
   WHERE t.id = $1
      OR EXISTS (SELECT 1 FROM acl_edges e
                  WHERE e.from_tenant = $1 AND e.to_tenant = t.id
                    AND e.enabled AND e.allow_read)
),
open_deliveries AS (
  -- Sólo estados abiertos. Las terminadas (done/failed/dead) no dicen nada sobre qué está
  -- haciendo el agente AHORA y son el 99% de la tabla.
  SELECT d.id, d.message_id, d.recipient_tenant, d.recipient_alias, d.status,
         d.attempt, d.claimed_at, d.ack_deadline_at, d.available_at
    FROM deliveries d
    JOIN visible_tenants v ON v.tenant_id = d.recipient_tenant
   WHERE d.status IN ('pending','retry','leased','accepted','started')
),
unstarted_ack_activity AS (
  SELECT o.id AS delivery_id, max(k.created_at) AS last_ack_at
    FROM open_deliveries o
    LEFT JOIN delivery_acks k ON k.delivery_id = o.id AND k.attempt = o.attempt AND k.applied
   WHERE o.status IN ('leased','accepted')
   GROUP BY o.id
),
work AS (
  SELECT o.recipient_tenant AS tenant_id, o.recipient_alias AS alias,
         count(*) FILTER (WHERE o.status IN ('leased','accepted','started'))::int AS in_flight,
         count(*) FILTER (WHERE o.status = 'started')::int                        AS started,
         count(*) FILTER (WHERE o.status IN ('leased','accepted'))::int           AS claimed_not_started,
         count(*) FILTER (WHERE o.status IN ('pending','retry'))::int             AS queued,
         count(*) FILTER (WHERE o.status IN ('pending','retry')
                            AND o.available_at <= now())::int                     AS queued_ready,
         count(*) FILTER (WHERE o.status = 'retry')::int                          AS retrying,
         -- La versión durable y sin reloj-de-cliente de "colgado": el gateway ya escribió el
         -- deadline; si venció y la entrega sigue en vuelo, nadie ackeó a tiempo.
         count(*) FILTER (WHERE o.status IN ('leased','accepted','started')
                            AND o.ack_deadline_at IS NOT NULL
                            AND o.ack_deadline_at < now())::int                   AS overdue_in_flight,
         min(o.claimed_at)       FILTER (WHERE o.status IN ('leased','accepted','started')) AS oldest_claimed_at,
         min(o.claimed_at)       FILTER (WHERE o.status IN ('leased','accepted')) AS oldest_claimed_not_started_at,
         min(o.claimed_at)       FILTER (WHERE o.status IN ('leased','accepted')
                                          AND own_ack.last_ack_at IS NULL)
           AS oldest_claimed_not_started_without_ack_at,
         max(EXTRACT(EPOCH FROM (now() - COALESCE(own_ack.last_ack_at, o.claimed_at))))
           FILTER (WHERE o.status IN ('leased','accepted'))::int AS oldest_claimed_not_started_activity_seconds,
         min(o.ack_deadline_at)  FILTER (WHERE o.status IN ('leased','accepted','started')) AS nearest_ack_deadline_at,
         max(o.attempt)          FILTER (WHERE o.status IN ('leased','accepted','started'))::int AS max_attempt
    FROM open_deliveries o
    LEFT JOIN unstarted_ack_activity own_ack ON own_ack.delivery_id = o.id
   GROUP BY o.recipient_tenant, o.recipient_alias
),
ack_activity AS (
  -- LA señal de vida. Sólo ACKs APLICADOS: applied=false es un frame duplicado o fuera de orden
  -- y no prueba ningún progreso; contarlo haría pasar por sano justo al agente que reintenta
  -- el mismo ACK en loop. Acotada a $3 segundos para que el scan no recorra delivery_acks entera.
  SELECT d.recipient_tenant AS tenant_id, d.recipient_alias AS alias,
         max(k.created_at) AS last_ack_at,
         count(*) FILTER (WHERE k.created_at > now() - $2::int * interval '1 second')::int AS acks_recent
    FROM delivery_acks k
    JOIN deliveries d ON d.id = k.delivery_id
    JOIN visible_tenants v ON v.tenant_id = d.recipient_tenant
   WHERE k.applied
     AND k.created_at > now() - $3::int * interval '1 second'
   GROUP BY d.recipient_tenant, d.recipient_alias
),
participants AS (
  -- Tres orígenes unidos porque los tres mienten por separado. 'agents' es configuración y
  -- arrastra drift; un alias con 41 entregas en vuelo que nadie registró es EXACTAMENTE el caso
  -- que hay que ver, no el que hay que ocultar. 'work' aporta los que trabajan sin fila de
  -- registro; 'connection_leases' los que están conectados sin trabajo.
  SELECT a.tenant_id, a.alias FROM agents a JOIN visible_tenants v ON v.tenant_id = a.tenant_id
  UNION
  SELECT w.tenant_id, w.alias FROM work w
  UNION
  SELECT l.tenant_id, l.alias FROM connection_leases l JOIN visible_tenants v ON v.tenant_id = l.tenant_id
)
SELECT p.tenant_id,
       p.alias,
       ag.display_name,
       ag.harness_id,
       (ag.tenant_id IS NOT NULL)         AS registered,
       COALESCE(ag.enabled, false)        AS agent_enabled,
       lease.instance_id,
       lease.epoch,
       lease.last_heartbeat_at,
       lease.lease_until,
       (lease.lease_until > now())        AS lease_online,
       COALESCE(w.in_flight, 0)           AS in_flight,
       COALESCE(w.started, 0)             AS started,
       COALESCE(w.claimed_not_started, 0) AS claimed_not_started,
       COALESCE(w.queued, 0)              AS queued,
       COALESCE(w.queued_ready, 0)        AS queued_ready,
       COALESCE(w.retrying, 0)            AS retrying,
       COALESCE(w.overdue_in_flight, 0)   AS overdue_in_flight,
       w.oldest_claimed_at,
       w.oldest_claimed_not_started_at,
       w.nearest_ack_deadline_at,
       w.max_attempt,
       EXTRACT(EPOCH FROM (now() - w.oldest_claimed_at))::int AS oldest_in_flight_seconds,
       EXTRACT(EPOCH FROM (now() - w.oldest_claimed_not_started_at))::int
         AS oldest_claimed_not_started_seconds,
       EXTRACT(EPOCH FROM (now() - w.oldest_claimed_not_started_without_ack_at))::int
         AS oldest_claimed_not_started_without_ack_seconds,
       w.oldest_claimed_not_started_activity_seconds,
       ack.last_ack_at,
       COALESCE(ack.acks_recent, 0)       AS acks_recent,
       -- NULL acá significa "ningún ACK aplicado dentro de $3 segundos", NO "recién ackeado".
       -- La UI tiene que renderizarlo como UNKNOWN / ">1 h", jamás como 0.
       EXTRACT(EPOCH FROM (now() - ack.last_ack_at))::int      AS seconds_since_last_ack,
       COALESCE(inflight.items, '[]'::jsonb)                   AS in_flight_items,
       (COALESCE(w.in_flight, 0) > $4)                         AS in_flight_items_truncated,
       -- Lista de salas en las que el alias tiene membresía activa.
       COALESCE(salas.rooms, ARRAY[]::text[])                   AS rooms
  FROM participants p
  LEFT JOIN agents ag              ON ag.tenant_id    = p.tenant_id AND ag.alias    = p.alias
  LEFT JOIN connection_leases lease ON lease.tenant_id = p.tenant_id AND lease.alias = p.alias
  LEFT JOIN work w                 ON w.tenant_id     = p.tenant_id AND w.alias     = p.alias
  LEFT JOIN ack_activity ack       ON ack.tenant_id   = p.tenant_id AND ack.alias   = p.alias
  LEFT JOIN LATERAL (
    -- Entregas en vuelo más antiguas del alias (acotadas a $4).
    SELECT COALESCE(jsonb_agg(to_jsonb(top) ORDER BY top.claimed_at), '[]'::jsonb) AS items
      FROM (
        SELECT d.id                 AS delivery_id,
               d.message_id,
               m.trace_id,
               m.tenant_id          AS from_tenant,
               m.actor_alias        AS from_alias,
               m.lane,
               -- Sólo el ADAPTADOR (identificador acotado a 64 chars: 'telegram', 'bus').
               -- conversation_id identifica una conversación ajena y no sale de acá.
               m.origin->>'adapter' AS origin_adapter,
               m.created_at         AS published_at,
               d.status,
               d.attempt,
               d.claimed_at,
               d.ack_deadline_at,
               EXTRACT(EPOCH FROM (now() - d.claimed_at))::int AS seconds_in_flight,
               last_ack.created_at  AS last_ack_at,
               last_ack.status      AS last_ack_status
          FROM deliveries d
          JOIN messages m ON m.id = d.message_id
          LEFT JOIN LATERAL (
            SELECT k.created_at, k.status
              FROM delivery_acks k
             WHERE k.delivery_id = d.id AND k.applied
             ORDER BY k.created_at DESC
             LIMIT 1
          ) last_ack ON true
         WHERE d.recipient_tenant = p.tenant_id
           AND d.recipient_alias  = p.alias
           AND d.status IN ('leased','accepted','started')
         ORDER BY d.claimed_at NULLS FIRST
         LIMIT $4
      ) top
  ) inflight ON true
  LEFT JOIN LATERAL (
    -- Sólo membresías HABILITADAS: una membresía deshabilitada no coloca al alias en esa sala,
    -- y dibujarlo dentro afirmaría una pertenencia que el control plane ya retiró.
    SELECT array_agg(mem.room_id ORDER BY mem.room_id) AS rooms
      FROM memberships mem
     WHERE mem.tenant_id = p.tenant_id AND mem.alias = p.alias AND mem.enabled
  ) salas ON true
 ORDER BY p.tenant_id, p.alias;
`;
