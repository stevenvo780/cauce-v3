-- Consultas del grafo de agentes — PROBADAS contra prod (cauce-v3-prod-postgres-1) 2026-08-22.
-- Refresco previsto: 20 s. Coste medido con EXPLAIN (ANALYZE, BUFFERS) al pie de cada bloque.
-- $1 = tenant a acotar (NULL = toda la flota).

-- ============================================================================
-- 1) NODOS  — 10.4 ms / 1104 buffers hoy; 0.3 ms con el indice de terminal_at
-- ============================================================================
WITH inflight AS (
  SELECT d.recipient_tenant AS tenant_id, d.recipient_alias AS alias,
         count(*) AS inflight_n,
         min(COALESCE(d.execution_started_at, d.claimed_at, d.created_at)) AS busy_since
  FROM deliveries d
  WHERE d.status IN ('leased','accepted','started')     -- usa deliveries_inflight_by_recipient_idx
  GROUP BY 1,2
),
waiting AS (
  SELECT d.recipient_tenant AS tenant_id, d.recipient_alias AS alias, count(*) AS waiting_n
  FROM deliveries d
  WHERE d.status IN ('pending','retry')                 -- usa deliveries_claim_idx (index-only)
  GROUP BY 1,2
),
closed24 AS (
  SELECT d.recipient_tenant AS tenant_id, d.recipient_alias AS alias,
         count(*) FILTER (WHERE d.status = 'done')              AS done_24h,
         count(*) FILTER (WHERE d.status IN ('failed','dead'))  AS failed_24h
  FROM deliveries d
  WHERE d.terminal_at > now() - interval '24 hours'
  GROUP BY 1,2
)
SELECT a.tenant_id, a.alias, a.display_name, a.enabled, a.container_name,
       a.max_concurrent_deliveries, mem.room_id,
       COALESCE(i.inflight_n,0) AS inflight_n,
       i.busy_since,
       CASE WHEN i.inflight_n IS NULL THEN NULL
            ELSE round(extract(epoch FROM (now()-i.busy_since))/60)::int END AS busy_min,
       COALESCE(w.waiting_n,0)  AS waiting_n,     -- "cuantos esperan turno detras"
       COALESCE(c.done_24h,0)   AS done_24h,      -- tamano del nodo
       COALESCE(c.failed_24h,0) AS failed_24h,
       CASE WHEN i.inflight_n IS NULL                       THEN 'libre'   -- gris
            WHEN now()-i.busy_since < interval '3 minutes'  THEN 'verde'
            WHEN now()-i.busy_since < interval '15 minutes' THEN 'ambar'
            ELSE 'rojo' END AS estado
FROM agents a
LEFT JOIN LATERAL (
  SELECT m.room_id FROM memberships m
  WHERE m.tenant_id=a.tenant_id AND m.alias=a.alias AND m.enabled
  ORDER BY m.room_id LIMIT 1
) mem ON true
LEFT JOIN inflight i ON i.tenant_id=a.tenant_id AND i.alias=a.alias
LEFT JOIN waiting  w ON w.tenant_id=a.tenant_id AND w.alias=a.alias
LEFT JOIN closed24 c ON c.tenant_id=a.tenant_id AND c.alias=a.alias
WHERE ($1::text IS NULL OR a.tenant_id = $1)
ORDER BY a.tenant_id, a.alias;

-- ============================================================================
-- 2) ARISTAS de delegacion — 18.7 ms / 2174 buffers hoy; 7.2 ms con indice de created_at
--    'dir' separa la ida (agent.message) de la vuelta (agent.response): sin eso
--    cada par sale duplicado en ambos sentidos.
-- ============================================================================
SELECT m.tenant_id                                     AS src_tenant,
       COALESCE(m.body->>'from_alias', m.actor_alias)  AS src_alias,
       d.recipient_tenant                              AS dst_tenant,
       d.recipient_alias                               AS dst_alias,
       CASE WHEN m.body->>'type' = 'agent.response' THEN 'vuelta' ELSE 'ida' END AS dir,
       count(*)                                                            AS total_24h,
       count(*) FILTER (WHERE d.status IN ('leased','accepted','started')) AS en_vuelo,  -- flecha AZUL
       count(*) FILTER (WHERE d.status IN ('pending','retry'))             AS en_cola,
       count(*) FILTER (WHERE d.status IN ('failed','dead'))               AS fallidas,
       max(d.created_at)                                                   AS ultima
FROM deliveries d
JOIN messages m ON m.id = d.message_id
WHERE d.created_at > now() - interval '24 hours'
  AND COALESCE(m.body->>'from_alias', m.actor_alias) <> d.recipient_alias  -- descarta el auto-envio del puente Telegram
  AND ($1::text IS NULL OR m.tenant_id = $1 OR d.recipient_tenant = $1)
GROUP BY 1,2,3,4,5
ORDER BY total_24h DESC;

-- ============================================================================
-- 3) TOOLTIP: que hace cada agente AHORA, quien se lo pidio, hace cuantos minutos,
--    y cuantos esperan turno detras — 0.27 ms, index scan puro. Sin indices nuevos.
-- ============================================================================
SELECT d.recipient_tenant AS tenant_id, d.recipient_alias AS alias,
       d.id AS delivery_id, d.status, d.attempt, d.ack_deadline_at,
       m.trace_id, m.tenant_id AS src_tenant, m.room_id,
       COALESCE(m.body->>'from_alias', m.actor_alias)              AS pedido_por,
       m.origin->'metadata'->>'bridge_alias'                       AS puente_humano,
       m.body->>'type'                                            AS tipo,
       left(COALESCE(m.body->>'text',''), 280)                    AS tarea,
       COALESCE(d.execution_started_at, d.claimed_at, d.created_at) AS desde,
       round(extract(epoch FROM (now() - COALESCE(d.execution_started_at, d.claimed_at, d.created_at)))/60)::int AS min_activo,
       (SELECT count(*) FROM deliveries q
         WHERE q.recipient_tenant = d.recipient_tenant
           AND q.recipient_alias  = d.recipient_alias
           AND q.status IN ('pending','retry'))                    AS esperan_turno
FROM deliveries d
JOIN messages m ON m.id = d.message_id
WHERE d.status IN ('leased','accepted','started')
  AND ($1::text IS NULL OR d.recipient_tenant = $1)
ORDER BY desde;

-- ============================================================================
-- 4) CADENA por trace_id — 10.2 ms / 1827 buffers hoy (SEQ SCAN de messages);
--    0.13 ms / 4 buffers con el indice de trace_id. $1 = trace_id.
-- ============================================================================
SELECT m.created_at, m.tenant_id, m.room_id,
       COALESCE(m.body->>'from_alias', m.actor_alias)          AS de,
       d.recipient_tenant || '/' || d.recipient_alias          AS para,
       m.body->>'type'                                         AS tipo,
       (m.body->'correlation'->>'hop_count')::int              AS hop,
       (m.body->'correlation'->>'hop_budget')::int             AS hop_budget,
       m.body->'correlation'->>'root_message_id'               AS root_message_id,
       m.body->'correlation'->>'parent_message_id'             AS parent_message_id,
       m.id AS message_id, d.id AS delivery_id, d.status, d.last_error,
       round(extract(epoch FROM (d.terminal_at - d.created_at)))::int AS seg,
       left(COALESCE(m.body->>'text',''), 400)                 AS texto
FROM messages m
LEFT JOIN deliveries d ON d.message_id = m.id
WHERE m.trace_id = $1
ORDER BY m.created_at, d.recipient_alias;

-- ============================================================================
-- INDICES RECOMENDADOS (ninguno existe hoy). Medidos en una transaccion revertida.
-- Tablas de 14k filas: se crean en milisegundos, pero usar CONCURRENTLY igual.
-- ============================================================================
-- CREATE INDEX CONCURRENTLY messages_trace_created_idx
--   ON messages (trace_id, created_at);                        -- cadena: 10.2ms -> 0.13ms
-- CREATE INDEX CONCURRENTLY deliveries_created_at_idx
--   ON deliveries (created_at DESC)
--   INCLUDE (message_id, recipient_tenant, recipient_alias, status);  -- aristas: 18.7ms -> 7.2ms
-- CREATE INDEX CONCURRENTLY deliveries_terminal_at_idx
--   ON deliveries (terminal_at DESC)
--   INCLUDE (recipient_tenant, recipient_alias, status)
--   WHERE terminal_at IS NOT NULL;                             -- nodos: 9.6ms -> 0.29ms
