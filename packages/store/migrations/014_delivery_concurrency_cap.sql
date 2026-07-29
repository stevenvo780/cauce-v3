-- packages/store/migrations/014_delivery_concurrency_cap.sql
--
-- Techo de concurrencia por agente: no entregar más de lo que se puede ejecutar.
--
-- EL HALLAZGO. No existía ningún límite de concurrencia en todo el camino. El gateway reclamaba
-- de a 20 por drain (limit=undefined => default 20 de QueryDeliveriesSchema), el adaptador las
-- aceptaba todas fire-and-forget, y el harness ejecuta UNA por sessionKey (el mutex de
-- packages/adapter-sdk/src/harnesses/shared.ts, reserveSession). El resultado medido: argos
-- llegó a tener 92 entregas "en vuelo" ejecutando 2. Con más de 20 hermanas ocupadas la espera
-- mediana fue de 3 HORAS y el 73% murió sin ejecutarse jamás.
--
-- Por qué morían y no simplemente esperaban: una entrega reclamada arranca su ack_deadline_at.
-- El reloj corre mientras la entrega hace cola detrás del mutex del harness, no mientras se
-- ejecuta. Reclamar 20 para ejecutar 2 no es "adelantar trabajo", es GASTAR los intentos de 18
-- entregas contra un cronómetro que empezó a correr sin que nadie las mirara: retryStaleDeliveries
-- las vence, les suma attempt, y a los max_attempts las manda a dead. El backlog no se encolaba,
-- se incineraba.
--
-- LA FORMA DEL ARREGLO. El límite tiene que vivir donde vive la verdad sobre el agente, y esa es
-- la fila de `agents`: es la misma tabla que ya dice qué harness lo corre y en qué contenedor.
-- Ponerlo en configuración del gateway lo haría global (un solo número para 15 agentes con
-- harnesses distintos) y ponerlo en el adaptador lo haría inauditable desde la base.
--
-- DEFAULT 2 y no 1: es la concurrencia REAL medida. El mutex del harness serializa por sessionKey,
-- así que un agente ejecuta 1 a la vez por sesión, pero 2 permite que la siguiente entrega esté ya
-- en manos del adaptador cuando la actual termina — sin ese 1 de holgura cada transición paga un
-- round-trip de wake + claim. Más que 2 vuelve a la conducta que rompió producción.
--
-- ADD COLUMN ... DEFAULT es metadata-only desde PostgreSQL 11: no reescribe la tabla y las 15 filas
-- vivas leen 2 sin un UPDATE. No hay ventana en la que un agente quede sin techo.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrent_deliveries integer DEFAULT 2;

-- NULL = sin techo. Es la salida de emergencia deliberada: si este cambio estrangula a un agente
-- que de verdad puede paralelizar (o si hay que desactivar el techo en caliente sin desplegar),
-- un UPDATE a NULL lo devuelve exactamente a la conducta anterior. Sin esa salida, el único
-- rollback de un límite mal calibrado sería un deploy.
--
-- ADD CONSTRAINT no acepta IF NOT EXISTS, así que la idempotencia se consigue mirando pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_max_concurrent_deliveries_sane'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_max_concurrent_deliveries_sane
      CHECK (max_concurrent_deliveries IS NULL OR max_concurrent_deliveries BETWEEN 1 AND 100);
  END IF;
END
$$;

-- INTEGRACIÓN 2026-07-29: el techo acota el CUPO GENERAL, no el total en vuelo. La reserva
-- humana del gateway (CAUCE_HUMAN_RESERVED_DELIVERIES, default 2) queda por encima, igual que
-- ya estaba por encima de CAUCE_MAX_INFLIGHT_DELIVERIES. Motivo: el techo existe porque el mutex
-- del harness serializa por sessionKey, y desde los carriles de sesión el tráfico humano tiene
-- sessionKey distinta del agente-a-agente — una entrega humana admitida por la reserva se
-- ejecuta en paralelo, no hace cola. Si el techo (2) se aplicara al total, dos delegaciones en
-- vuelo dejarían la reserva humana permanentemente inalcanzable. Peor caso combinado: esto + la
-- reserva humana.
COMMENT ON COLUMN agents.max_concurrent_deliveries IS
  'Entregas no terminales (leased/accepted/started) que este agente puede tener a la vez por el '
  'CUPO GENERAL. claimDeliveries acota su límite general a max(0, esto - en_vuelo). La reserva '
  'humana del gateway es aditiva por encima de este techo. NULL = sin techo.';

-- ------------------------------------------------------------------------------------------
-- El índice que sostiene el conteo de en-vuelo.
--
-- claimDeliveries pasa a contar, por cada drain, las entregas no terminales del alias. Eso es
-- camino caliente y no puede degradarse a un scan de `deliveries`.
--
-- Los índices que ya existían NO sirven para esto:
--   deliveries_claim_idx     su predicado es status IN ('pending','retry') — el conjunto opuesto.
--   deliveries_inflight_idx  el predicado es el correcto, pero encabeza por (ack_deadline_at,
--                            claimed_at): para contar un alias hay que recorrerlo entero.
--
-- Producción tiene además deliveries_open_by_recipient_idx, que sí cubriría la consulta — pero
-- viene de 013_quota_observation.sql, un archivo que está en la IMAGEN desplegada y NO en este
-- árbol. Depender de él sería atar el plan de una consulta caliente a una migración que este
-- repositorio no contiene: una base creada desde este árbol no lo tendría. Por eso el índice
-- propio, y por eso IF NOT EXISTS.
--
-- El costo de escritura es despreciable porque el índice es PARCIAL sobre el conjunto en vuelo:
-- hoy son 2 filas en toda la flota, ~92 en el pico del incidente. Insertar una entrega 'pending'
-- no lo toca; sólo lo tocan las transiciones pending->leased y leased->terminal, una vez cada una
-- por ciclo de vida.
CREATE INDEX IF NOT EXISTS deliveries_inflight_by_recipient_idx
  ON deliveries (recipient_tenant, recipient_alias)
  WHERE status IN ('leased', 'accepted', 'started');
