/**
 * Heurística de "qué está haciendo cada agente" para GET /v3/console/activity.
 *
 * Vive separada de repository.ts y como función TS pura -- exactamente el mismo motivo que
 * agentDeploymentStatus() ya usa dentro de listAgents(): en esta máquina no hay PostgreSQL, así
 * que la única parte de esta feature que se puede testear de verdad es la que decide si el
 * operador ve "todo bien" o "incendio". El SQL sólo agrega columnas; la interpretación de esas
 * columnas -- badge excluyente + flags acumulativos -- se decide acá.
 */

export interface FleetActivityThresholds {
  /** A partir de cuántas entregas en vuelo un agente se considera saturado. */
  saturation_in_flight: number;
  /** Segundos sin un ACK aplicado a partir de los cuales "sigue trabajando" deja de creerse. */
  stall_after_seconds: number;
  /** Ventana que cuenta como "ACK reciente" para acks_recent. Informativo, no decide el badge. */
  ack_recent_seconds: number;
  /** Hasta dónde mira hacia atrás la búsqueda del último ACK aplicado. */
  ack_lookback_seconds: number;
  /** Tope de entregas en vuelo detalladas por alias en in_flight_items. */
  items_per_agent: number;
}

export const DEFAULT_FLEET_ACTIVITY_THRESHOLDS: FleetActivityThresholds = {
  saturation_in_flight: 8,
  stall_after_seconds: 300,
  ack_recent_seconds: 300,
  ack_lookback_seconds: 3600,
  items_per_agent: 10
};

export const FLEET_WORK_STATES = ['idle', 'queued', 'working', 'saturated', 'stalled'] as const;
export type FleetWorkState = (typeof FLEET_WORK_STATES)[number];

export const FLEET_ACTIVITY_FLAGS = [
  'saturated', 'ack_stalled', 'overdue_acks', 'lease_expired',
  'never_connected', 'unregistered', 'queued_without_consumer'
] as const;
export type FleetActivityFlag = (typeof FLEET_ACTIVITY_FLAGS)[number];

/** Entrada mínima que necesita la heurística; es un subconjunto de la fila que devuelve el SQL
 *  de fleetActivity(), para que el test de esta función no dependa de columnas irrelevantes. */
export interface FleetActivityWorkStateInput {
  registered: boolean;
  in_flight: number;
  queued: number;
  overdue_in_flight: number;
  /** null significa "ningún ACK aplicado dentro de ack_lookback_seconds", que es la señal MÁS
   *  grave (agente colgado hace rato), nunca "recién ackeado". Tratarlo como 0 invierte el
   *  diagnóstico -- por eso el tipo es explícitamente nullable y no un número con default. */
  seconds_since_last_ack: number | null;
  /** true = lease vigente, false = lease vencido, null = nunca hubo lease (LEFT JOIN sin fila). */
  lease_online: boolean | null;
}

export interface FleetActivityWorkStateResult {
  work_state: FleetWorkState;
  flags: FleetActivityFlag[];
}

/**
 * Un solo badge (precedencia excluyente) + un array de flags (acumulativo, no excluyente).
 * El caso del incidente real -- 71 entregas en vuelo y cero progreso -- es simultáneamente
 * "saturado" Y "colgado"; el badge sólo puede mostrar una palabra, pero flags no debe perder
 * ninguna de las dos señales.
 *
 * Precedencia del badge: stalled > saturated > working > queued > idle.
 */
export function agentWorkState(
  row: FleetActivityWorkStateInput,
  thresholds: FleetActivityThresholds = DEFAULT_FLEET_ACTIVITY_THRESHOLDS
): FleetActivityWorkStateResult {
  const ackIsStale = row.seconds_since_last_ack === null || row.seconds_since_last_ack > thresholds.stall_after_seconds;
  const stalled = row.in_flight > 0 && (row.overdue_in_flight > 0 || ackIsStale);
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
  // ack_stalled requiere trabajo en curso: un agente idle hace horas no está "colgado", está
  // tranquilo. Sin esta guarda, salva (idle, último ACK hace 799s) se marcaría como colgado.
  if (row.in_flight > 0 && ackIsStale) flags.push('ack_stalled');
  if (row.overdue_in_flight > 0) flags.push('overdue_acks');
  if (row.lease_online === false) flags.push('lease_expired');
  if (row.lease_online === null) flags.push('never_connected');
  if (!row.registered) flags.push('unregistered');
  if (row.in_flight === 0 && row.queued > 0) flags.push('queued_without_consumer');

  return { work_state, flags };
}

/**
 * SQL de GET /v3/console/activity, exportada como texto (en vez de vivir inline en
 * repository.ts) por dos razones: (1) es la superficie de lectura más ancha de la consola --
 * agrega los cinco tenants en un solo payload -- así que su contrato "nunca selecciona cuerpos"
 * necesita un test que lo pueda verificar sin levantar Postgres, y una constante exportada es lo
 * único que un test puede inspeccionar como texto; (2) documenta en un solo lugar por qué NO
 * hay ninguna función de ventana ni ningún FOR SHARE/FOR UPDATE acá: Postgres rechaza al
 * parsear cualquier combinación de las dos cosas, así que el recorte "las N entregas más viejas
 * por agente" sale de un LATERAL con ORDER BY ... LIMIT.
 *
 * Es de sólo lectura: no hay nada que proteger de una escritura concurrente (un panel quiere
 * una foto, no una foto que congele el despacho mientras la saca).
 *
 * NUNCA selecciona m.body, d.result, d.last_error ni m.origin->>'conversation_id': no es un
 * filtro posterior que alguien pueda saltear, el dato no entra al result set. Sólo se expone el
 * adaptador de origen ('telegram','bus'), que es un identificador acotado y no contenido.
 *
 * Parámetros: $1 tenant del actor autenticado, $2 ack_recent_seconds, $3 ack_lookback_seconds,
 * $4 items_per_agent (tope de entregas detalladas por alias).
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
         min(o.ack_deadline_at)  FILTER (WHERE o.status IN ('leased','accepted','started')) AS nearest_ack_deadline_at,
         max(o.attempt)          FILTER (WHERE o.status IN ('leased','accepted','started'))::int AS max_attempt
    FROM open_deliveries o
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
       w.nearest_ack_deadline_at,
       w.max_attempt,
       EXTRACT(EPOCH FROM (now() - w.oldest_claimed_at))::int AS oldest_in_flight_seconds,
       ack.last_ack_at,
       COALESCE(ack.acks_recent, 0)       AS acks_recent,
       -- NULL acá significa "ningún ACK aplicado dentro de $3 segundos", NO "recién ackeado".
       -- La UI tiene que renderizarlo como UNKNOWN / ">1 h", jamás como 0.
       EXTRACT(EPOCH FROM (now() - ack.last_ack_at))::int      AS seconds_since_last_ack,
       COALESCE(inflight.items, '[]'::jsonb)                   AS in_flight_items,
       (COALESCE(w.in_flight, 0) > $4)                         AS in_flight_items_truncated
  FROM participants p
  LEFT JOIN agents ag              ON ag.tenant_id    = p.tenant_id AND ag.alias    = p.alias
  LEFT JOIN connection_leases lease ON lease.tenant_id = p.tenant_id AND lease.alias = p.alias
  LEFT JOIN work w                 ON w.tenant_id     = p.tenant_id AND w.alias     = p.alias
  LEFT JOIN ack_activity ack       ON ack.tenant_id   = p.tenant_id AND ack.alias   = p.alias
  LEFT JOIN LATERAL (
    -- Las $4 entregas en vuelo MÁS VIEJAS, que son las que interesan cuando algo se colgó.
    -- Acotado por alias y no globalmente: con 41 en vuelo el payload sigue siendo legible y el
    -- contador in_flight ya dice la verdad completa.
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
 ORDER BY p.tenant_id, p.alias;
`;
