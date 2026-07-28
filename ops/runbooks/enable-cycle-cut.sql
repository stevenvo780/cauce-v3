-- Encendido del guarda de ciclo (agent_chain_policies.cycle_cut_enabled).
--
-- NO EJECUTAR HASTA QUE LA IMAGEN CON EL RESPALDO DE visited_path ESTÉ DESPLEGADA.
-- Antes de este parche el guarda estaba CIEGO: `visited_path` se reiniciaba en largo 1 en cada
-- salto que perdía la fila del padre, así que `visitedPathAvailable && cycle_cut_enabled` se
-- evaluaba pero `visitedPath.includes(destino)` nunca podía ser verdadero. Encenderlo sobre la
-- imagen vieja da cero cortes y falsa sensación de protección.
--
-- Orden obligatorio:
--   1. desplegar la imagen con el respaldo (gateway, dispatcher, relay-worker, telegram-bridge);
--   2. esperar a que drenen las cadenas viejas (no traen visited_path en la correlación del
--      cuerpo y por eso degradan a la conducta actual: no cortan). Un turno de cadena basta;
--   3. recién entonces correr el paso 2 de abajo.

-- Paso 0 — verificación previa: la columna tiene que existir (migración 008).
--          Si devuelve 'f', el guarda queda apagado por código y encenderlo no hace nada.
SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = to_regclass('public.agent_output_materializations')
    AND attname = 'visited_path' AND NOT attisdropped
) AS visited_path_present;

-- Paso 1 — verificación de que el respaldo YA está corriendo en la imagen desplegada.
--          Debe devolver filas con corr_has_vp = true y vp_len creciendo con hop_count.
--          Si vp_len sigue en 1 con hop_count alto, la imagen vieja sigue sirviendo tráfico:
--          NO encender.
SELECT hop_count,
       coalesce(array_length(visited_path, 1), 0) AS vp_len,
       (correlation ? 'hop_count')   AS corr_has_hop,
       (correlation ? 'visited_path') AS corr_has_vp
FROM agent_output_materializations
WHERE status = 'materialized'
  AND created_at > now() - interval '1 hour'
ORDER BY created_at DESC
LIMIT 20;

-- Paso 2 — el encendido. Una sola fila, id='default'.
BEGIN;
UPDATE agent_chain_policies
   SET cycle_cut_enabled = true,
       updated_at = now()
 WHERE id = 'default';
-- Debe decir UPDATE 1. Si dice UPDATE 0, la fila 'default' no existe y falta la 008.
SELECT id, progress_relay_enabled, progress_relay_max_events, cycle_cut_enabled, updated_at
  FROM agent_chain_policies WHERE id = 'default';
COMMIT;

-- Paso 3 — vigilancia. Todo corte queda como fila durable y como audit_event, nunca como
--          excepción, así que un falso positivo se ve enseguida y se revierte sin desplegar.
SELECT source_tenant, source_alias, hop_count, count(*) AS cortes
  FROM agent_output_materializations
 WHERE status = 'rejected' AND rejection_code = 'cycle_detected'
   AND created_at > now() - interval '1 hour'
 GROUP BY 1, 2, 3
 ORDER BY cortes DESC;

-- FRENO DE EMERGENCIA — apagar es una mutación de configuración auditada, no un rollback de
-- código, y tiene efecto en el siguiente ACK sin reiniciar ningún servicio.
--   UPDATE agent_chain_policies SET cycle_cut_enabled = false, updated_at = now()
--    WHERE id = 'default';
--
-- Alternativa preferida al SQL crudo: el plano de control ya expone esta política como recurso
-- administrable con preview/apply/rollback auditado
-- (`resource: 'chain_policy', action: 'update', id: 'default', value: { cycle_cut_enabled: true }`),
-- y sólo la acepta de un operador de tenant hub. Usar esa vía deja rastro de quién la cambió;
-- este archivo es el respaldo para cuando el plano de control no esté disponible.
