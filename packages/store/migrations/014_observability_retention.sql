-- packages/store/migrations/014_observability_retention.sql
--
-- Retención de las dos tablas de observabilidad que estaban creciendo sin ninguna política.
-- Medido el 2026-07-28 sobre una base de 93 MB creada hacía 6 días: `delivery_acks` 24 MB y
-- `audit_events` 24 MB, o sea 48 MB — más de la mitad de la base entera — de datos que nadie
-- estaba podando. La causa es estructural: CADA renovación de garra escribe DOS filas, una en
-- cada tabla, y un solo harness colgado emite ~60 renovaciones por hora (17,36 h de una entrega
-- de janus = el 32,7% de todos los `delivery_acks` del día).
--
-- LA IDEA CENTRAL, y es lo que esta migración habilita: NO se retiene por edad a secas. Un ACK
-- de renovación dice "sigo vivo" y no tiene ningún valor forense pasadas unas horas; un ACK de
-- TRANSICIÓN DE ESTADO ('pasé a started', 'terminé', 'fallé') es la prueba de qué hizo el
-- sistema y hay que conservarlo mucho más. Son ~90% y ~10% del volumen respectivamente, así que
-- distinguirlos es la diferencia entre recuperar casi todo el espacio y perder el histórico.

-- ------------------------------------------------------------------------------------------
-- 1. La marca que hace posible retener por TIPO y no por edad.
--
-- Se necesita una columna porque desde la fila sola no se puede saber: un ACK de renovación y
-- el PRIMER 'started' de un intento son los dos `status='started'`. Distinguirlos a posteriori
-- pedía una función de ventana sobre la tabla entera (24 MB, y creciendo) en cada barrido.
-- Quien sí lo sabe con certeza es `ackDelivery`, que es la que eligió la rama de renovación;
-- ahí se escribe.
--
-- NO BLOQUEA. En PostgreSQL 11+ un ADD COLUMN con DEFAULT constante es un cambio de catálogo:
-- no reescribe la tabla ni toca una sola página de datos. El ACCESS EXCLUSIVE dura lo que tarda
-- el UPDATE del catálogo (microsegundos) y no escala con las 24 MB. Es la única forma de agregar
-- esta columna sin ventana de mantenimiento, y por eso el DEFAULT es obligatorio y constante.
--
-- Las filas HISTÓRICAS quedan en false, o sea clasificadas como transición. Es la respuesta
-- correcta y deliberada: de un ACK viejo no sabemos si era latido o transición, y "no sé" tiene
-- que caer del lado que CONSERVA (barato, se recupera el espacio a los 14 días por la regla de
-- edad) y no del lado que borra evidencia. No se hace backfill a propósito: inferirlo pedía
-- exactamente la función de ventana que esta columna existe para evitar, y correrla dentro de
-- la transacción de migración bloquearía la tabla entera en una base viva.
ALTER TABLE delivery_acks ADD COLUMN IF NOT EXISTS renewal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery_acks.renewal IS
  'true = latido que sólo renovó la garra (retención corta). false = transición de estado o fila anterior a 014.';

-- ------------------------------------------------------------------------------------------
-- 2. Índices para que el barrido encuentre lo viejo sin escanear la tabla.
--
-- POR QUÉ BRIN Y NO BTREE. `applyMigrations()` corre TODAS las migraciones dentro de UNA
-- transacción con un advisory lock, así que CREATE INDEX CONCURRENTLY es imposible acá (Postgres
-- lo prohíbe dentro de un bloque de transacción) y cualquier índice se construye tomando un
-- ShareLock que bloquea las ESCRITURAS mientras dura. La pregunta entonces no es "¿bloquea?"
-- sino "¿cuánto?", y ahí BRIN gana por dos órdenes de magnitud: se construye con un barrido
-- secuencial que resume rangos de bloques, sin ordenar nada y sin memoria de trabajo, mientras
-- que un btree sobre created_at tendría que ordenar las 24 MB enteras y mantener el lock todo
-- ese tiempo. Sobre estos tamaños BRIN son milisegundos.
--
-- Y encaja perfecto con el dato: las dos tablas son append-only con id bigserial, así que
-- created_at está en correlación física casi perfecta con el orden de los bloques — el caso
-- ideal de BRIN. El índice resultante son unos pocos KB, no decenas de MB como un btree, lo que
-- también importa cuando el problema que estamos resolviendo ES el tamaño.
--
-- pages_per_range=32 (en vez del default 128) acota mejor el rango de bloques que hay que leer
-- para un corte de pocas horas, que es la consulta del barrido de renovaciones.
--
-- SI ALGUNA VEZ CRECEN MUCHO: construirlos a mano con CONCURRENTLY ANTES de aplicar la
-- migración deja estos dos statements como no-op gracias al IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS delivery_acks_created_brin
  ON delivery_acks USING brin (created_at) WITH (pages_per_range = 32);
CREATE INDEX IF NOT EXISTS audit_events_created_brin
  ON audit_events USING brin (created_at) WITH (pages_per_range = 32);

-- ------------------------------------------------------------------------------------------
-- CONTRATO DEL BARRIDO (no es DDL; vive en `CauceRepository.pruneObservability` y lo llama el
-- tick del dispatcher cada `CAUCE_RETENTION_INTERVAL_MS`). Va documentado acá porque las
-- ventanas son la parte que un operador va a querer cambiar sin leer TypeScript.
--
--   delivery_acks, renewal=true    6 h   (CAUCE_RETENTION_ACK_RENEWAL_MS)
--   delivery_acks, resto          14 d   (CAUCE_RETENTION_ACK_MS)
--   audit_events, renovaciones     6 h   (CAUCE_RETENTION_AUDIT_RENEWAL_MS)
--   audit_events, resto           30 d   (CAUCE_RETENTION_AUDIT_MS)
--
-- `audit_events` tiene ventana MÁS LARGA que `delivery_acks` (30 d contra 14 d) y no es un
-- descuido: un ACK es telemetría de transporte, mientras que un audit_event contesta "quién
-- autorizó qué y con qué decisión", que es lo que se necesita semanas después cuando alguien
-- pregunta por qué un mensaje se entregó —o no— a determinado alias.
--
-- Las renovaciones de `audit_events` SÍ se identifican en las filas históricas, sin columna
-- nueva y sin backfill: la rama de renovación de `ackDelivery` viene escribiendo
-- `metadata->>'lease_renewed'='true'` desde antes de este parche, y es el ÚNICO lugar que lo
-- escribe. O sea que el backlog de 24 MB de audit_events se puede podar desde el primer
-- barrido, a diferencia del de delivery_acks, que espera a la regla de edad.
--
-- Cada DELETE es su propio statement, acotado por `id IN (SELECT id ... LIMIT n)` y con n
-- configurable (CAUCE_RETENTION_BATCH, 5.000). Nunca hay un DELETE ilimitado, nunca se toma un
-- lock de tabla: sólo locks de fila sobre las n filas del lote, que además son las más viejas y
-- por lo tanto las que nadie está leyendo. Se usa `id` y no `ctid` porque el id es la clave
-- primaria y no se mueve; el ctid sí puede moverse entre la subconsulta y el DELETE.
--
-- ------------------------------------------------------------------------------------------
-- REVERSIÓN. Esta migración es reversible sin pérdida de datos ni ventana de mantenimiento:
--
--   DROP INDEX CONCURRENTLY IF EXISTS delivery_acks_created_brin;
--   DROP INDEX CONCURRENTLY IF EXISTS audit_events_created_brin;
--   ALTER TABLE delivery_acks DROP COLUMN IF EXISTS renewal;
--   DELETE FROM schema_migrations WHERE version = '014_observability_retention.sql';
--
-- (DROP COLUMN también es catálogo puro: marca la columna como borrada sin reescribir la tabla.
-- Los tres statements van FUERA de una transacción por el CONCURRENTLY.)
--
-- Lo que la reversión NO deshace, y hay que decirlo: las filas que el barrido ya borró. Por eso
-- el barrido se apaga con `CAUCE_RETENTION_INTERVAL_MS=0` —que es la palanca de emergencia real,
-- efectiva en el reinicio siguiente y sin tocar el esquema— y revertir el DDL es el segundo
-- paso, no el primero.
