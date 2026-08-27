-- EL PERFIL POR ALIAS: la fuente de verdad de lo que va al fichero del arnés.
--
-- ============================================================================================
-- POR QUÉ EXISTE (medido el 2026-08-24 sobre el build DESPLEGADO, bus-v3-20260814-umbral)
-- ============================================================================================
-- Llamando a `protocolPrompt()` con 13 destinos y un rol de 1.097 caracteres, el sobre que Cauce
-- pone delante del modelo en CADA entrega mide:
--
--     sobre COMPLETO   : 11.546 caracteres
--       andamiaje fijo :  9.210   <- idéntico en CADA turno de CADA alias
--       rol del alias  :  1.106   <- idéntico en CADA turno
--       metadata JSON  :  1.168   <- esto sí cambia por entrega
--       pedido real    :     62
--     ratio            : 185 : 1
--
-- 10.316 de esos 11.546 caracteres son fijos: se retransmiten enteros en cada turno para decirle
-- al agente cosas que no cambiaron. Lo fijo tiene que vivir en el fichero que el arnés ya lee al
-- arrancar (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, el campo `agents` de
-- `~/.openclaw/openclaw.json`), generado desde la configuración de la plataforma; entre turnos
-- sólo debería viajar lo dinámico.
--
-- Esta migración es la primera mitad: DÓNDE vive lo fijo. La segunda —el compilador que lo
-- convierte en el texto de un fichero— es `@cauce/adapter-sdk/src/context/`.
--
-- ============================================================================================
-- POR QUÉ UNA TABLA NUEVA Y NO MÁS COLUMNAS EN `agents`
-- ============================================================================================
-- Hoy esa información está desperdigada en cinco sitios que no se conocen entre sí:
-- `agents.role_brief` (texto libre, tope 1200), `memberships` + `role_policies` (permisos),
-- `provider_accounts` (cuotas), `ops/manifests/*.yaml` (arnés y rutas) y ficheros sueltos dentro
-- de cada contenedor. El fichero generado tiene que concentrar las siete caras de un alias:
-- identidad y propósito, rol/responsabilidades/restricciones, permisos y acceso vía Cauce, cuotas
-- y límites, herramientas y capacidades, configuración del arnés, e instrucciones fijas.
--
-- De esas siete, sólo CUATRO se escriben a mano. Las otras tres —permisos, cuotas y configuración
-- del arnés— YA existen como hechos en `memberships`/`role_policies`, en `provider_accounts` y en
-- `agents`, y copiarlas acá como texto sería fabricar una segunda fuente de verdad que se
-- desincroniza en silencio: el permiso se revoca en `role_policies` y el fichero del contenedor
-- sigue diciendo que lo tiene. Por eso esta tabla guarda SÓLO lo autorado, y el compilador une lo
-- derivado en el momento de generar. Una tabla aparte y no columnas en `agents` porque `agents` es
-- la fila del camino caliente —la lee `claimDeliveries` en cada reclamo— y esto no se lee nunca
-- en ese camino.
--
-- ============================================================================================
-- LA UNIDAD: SE MIDE EN LAS DOS Y MANDA LA MÁS ESTRICTA
-- ============================================================================================
-- El 16-ago un alias se quedó SORDO —dejó de recibir, sin un solo error visible— porque dos capas
-- medían el mismo 1200 en unidades distintas: `char_length` de Postgres cuenta PUNTOS DE CÓDIGO y
-- `z.string().max()` de zod cuenta unidades UTF-16. Un texto de 1200 puntos de código con cien
-- emojis mide 1300 en UTF-16: la base lo guardaba, la pantalla decía «guardado», y el sobre de la
-- entrega se rechazaba entero.
--
-- La migración 020 cerró esa grieta bajando todas las capas a puntos de código. Ésta la cierra al
-- revés, y es deliberado: se mide en LAS DOS unidades y se obedece a la MÁS ESTRICTA, que es
-- siempre la UTF-16 porque `unidadesUtf16(t) >= puntosDeCodigo(t)` para todo t (un punto de código
-- del BMP vale 1 unidad, uno fuera del BMP vale 2, nunca al revés).
--
-- `cauce_utf16_units()` de abajo es esa cuenta del lado de Postgres. Comprobado contra
-- `String.length` de Node sobre 'abc', 'ñañ', un emoji suelto, una familia con ZWJ y repeticiones:
-- da EXACTAMENTE el mismo número (packages/store/test/agent-profile-postgres.test.ts).
--
-- Los números viven en `AGENT_PROFILE_LIMITS` de packages/protocol/src/agent-profile.ts, que es la
-- única copia del lado del código. Si se cambian allá, se cambian acá en el mismo lote; ésta es la
-- capa que no se puede mover sin migración, así que en un desacuerdo MANDA EL SQL.
--
-- ============================================================================================
-- CÓMO MIGRA EL TEXTO ACTUAL AL PERFIL, Y POR QUÉ `role_brief` NO SE TOCA
-- ============================================================================================
-- `agents.role_brief` sigue EXACTAMENTE como está: misma columna, mismo CHECK, mismo camino de
-- escritura (`normalizeRoleBrief` en configuration.ts) y mismo camino de lectura (`selfRoleBrief`,
-- que lo pone en `self_role` del sobre en cada reclamo). Durante la transición conviven, y el
-- sobre lo sigue mandando: ADELGAZAR `protocolPrompt()` ANTES DE QUE EL FICHERO LLEGUE AL
-- CONTENEDOR dejaría a los agentes sin la mitad de su contrato, y ésa es la fase siguiente, no
-- ésta.
--
-- El texto de hoy se SIEMBRA en `role_summary`, con una copia literal, al final de esta
-- migración. Entra siempre, y esto es la aritmética que lo prueba: `agents_role_brief_len` (020)
-- admite como mucho 1.200 PUNTOS DE CÓDIGO; el peor caso posible es que los 1.200 estén fuera del
-- BMP, que son 2.400 unidades UTF-16; el tope de `role_summary` es 4.000 y el presupuesto total es
-- 24.000. 2.400 < 4.000, así que NINGÚN `role_brief` que la base admita hoy puede ser rechazado
-- por esta tabla. La siembra no puede fallar, y por eso puede correr dentro de la misma
-- transacción que crea la tabla.
--
-- Sembrar y no dejar el perfil vacío es lo que hace que el fichero sirva desde el primer día: de
-- otro modo los quince alias empezarían con un perfil en blanco y el compilador emitiría un
-- fichero sin rol, que es peor que el que ya tienen. A partir de la siembra los dos textos derivan
-- por su cuenta: `created_at = updated_at` significa «esto todavía es la copia», y en cuanto
-- alguien edita el perfil, `updated_at` avanza y deja de serlo.

-- ============================================================================================
-- LA MEDIDA
-- ============================================================================================
-- Longitud en UNIDADES UTF-16, que es lo que cuenta `String.length` de JS.
--
-- La cuenta es «puntos de código + los que están fuera del BMP», que es la definición: cada punto
-- de código del BMP ocupa 1 unidad y cada uno fuera del BMP ocupa 2. El segundo sumando cuenta los
-- de fuera del BMP borrándolos y mirando cuánto encogió el texto.
--
-- IMMUTABLE es honesto: `char_length` y `regexp_replace` lo son, y el resultado depende sólo de la
-- entrada. Hace falta que lo sea para poder usarla en un CHECK.
--
-- AL BAJARLA: la base protege el orden sola. PostgreSQL registra en `pg_depend` la dependencia
-- entre un CHECK y la función que invoca, así que un `DROP FUNCTION` con la tabla todavía en pie
-- falla con `2BP01` en vez de dejar constraints apuntando al vacío. El `down/` borra igualmente la
-- tabla ANTES que las funciones, que es el único orden que la base acepta.
CREATE OR REPLACE FUNCTION cauce_utf16_units(t text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN t IS NULL THEN 0 ELSE
      char_length(t) + (char_length(t) - char_length(regexp_replace(t, '[\U00010000-\U0010FFFF]', '', 'g')))
    END
  $$;

-- Todos los elementos de una lista son VISIBLES y entran en `max_units`.
--
-- «Visible» es `~ '\S'` y no `<> ''`: un elemento de tres espacios pasaría el segundo y en el
-- fichero generado sería una viñeta vacía, que le enseña al agente que el sistema no sabe la
-- respuesta. La guarda de TypeScript los DESCARTA antes de llegar acá —un renglón en blanco es un
-- accidente de edición, no una intención— y este CHECK es la red para lo que entre por un INSERT
-- a mano.
--
-- Un array NULL o vacío es válido: no tener herramientas declaradas es un estado legítimo.
CREATE OR REPLACE FUNCTION cauce_text_items_ok(items text[], max_units integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(items, '{}'::text[])) AS item
      WHERE item !~ '\S' OR cauce_utf16_units(item) > max_units
    )
  $$;

-- ============================================================================================
-- LA TABLA
-- ============================================================================================
-- Los CHECK nacen VÁLIDOS y no NOT VALID, al revés que en 008, 019 y 020, y por el mismo criterio
-- que los hacía nacer NOT VALID allá: NOT VALID existe para evitar el escaneo completo de una
-- tabla que YA TIENE filas bajo ACCESS EXCLUSIVE. Ésta nace vacía en la misma transacción, así que
-- no hay nada que escanear y validarlos no cuesta nada. La siembra del final SÍ los atraviesa,
-- que es exactamente lo que se quiere: un NOT VALID no la habría eximido igualmente, porque
-- NOT VALID sólo perdona a las filas preexistentes y nunca a las que se insertan.
CREATE TABLE IF NOT EXISTS agent_profiles (
  tenant_id text NOT NULL,
  alias text NOT NULL,

  -- 1. IDENTIDAD Y PROPÓSITO. NULL = no declarado, y el compilador OMITE la sección entera en vez
  -- de emitir un encabezado vacío. Es la lección del SOUL.md de fábrica de `iza`: una identidad
  -- equivocada —o hueca— es peor que ninguna.
  purpose text,

  -- 2. ROL. Sucesor de `agents.role_brief`, con sitio para el detalle que en 1.200 no cabía.
  -- Convive con él durante la transición; ver el bloque de arriba.
  role_summary text,
  responsibilities text[] NOT NULL DEFAULT '{}',
  restrictions text[] NOT NULL DEFAULT '{}',

  -- 3. SU HUMANO: quién es y cómo tratarlo. El arnés `openclaw` lee un `USER.md` aparte —uno de
  -- los siete Markdown medidos el 2026-08-24— y ninguna de las otras columnas responde eso. Sin
  -- esta columna el generador tendría que deducir el humano del `tenant_id`, o sea inventarle a un
  -- agente cómo tratar a una persona. NULL = no declarado, y entonces `USER.md` no se siembra.
  human_brief text,

  -- 5. HERRAMIENTAS Y CAPACIDADES: sólo la parte AUTORADA. Las capacidades del arnés salen de
  -- `harness_definitions.capabilities` y las une el compilador.
  tools text[] NOT NULL DEFAULT '{}',

  -- 7. INSTRUCCIONES FIJAS DE FUNCIONAMIENTO, las de ESTE alias. Las de toda la flota son del
  -- compilador, no de la fila: repetirlas quince veces sería el problema que `role_brief` ya tuvo.
  operating_rules text[] NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, alias),

  -- ON DELETE CASCADE, al revés que `agent_role_brief_history`, y la diferencia es qué guarda cada
  -- una. El diario guarda PRUEBA de lo que un alias fue, y por eso tiene que sobrevivir a su baja
  -- (la lección del DELETE que arrastra la prueba por CASCADE). Esta tabla guarda CONFIGURACIÓN
  -- VIGENTE de un alias que existe: sin el alias no significa nada, y dejarla huérfana sería
  -- guardar el perfil de alguien que ya no está para que se lo encuentre el próximo que reutilice
  -- el nombre.
  FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE,

  -- Los topes por campo, en unidades UTF-16. Espejan AGENT_PROFILE_LIMITS.
  CONSTRAINT agent_profiles_purpose_len CHECK (
    purpose IS NULL OR cauce_utf16_units(purpose) BETWEEN 1 AND 2000
  ),
  CONSTRAINT agent_profiles_role_summary_len CHECK (
    role_summary IS NULL OR cauce_utf16_units(role_summary) BETWEEN 1 AND 4000
  ),
  CONSTRAINT agent_profiles_human_brief_len CHECK (
    human_brief IS NULL OR cauce_utf16_units(human_brief) BETWEEN 1 AND 2000
  ),

  -- Cardinalidad y tope por elemento, lista por lista. Están separados del presupuesto total a
  -- propósito: el error que devuelve la base nombra el campo, y una pantalla que dice «sobra en
  -- herramientas» sirve; una que dice «no entra» sobre siete campos, no.
  CONSTRAINT agent_profiles_responsibilities_count CHECK (coalesce(array_length(responsibilities,1),0) <= 64),
  CONSTRAINT agent_profiles_responsibilities_items CHECK (cauce_text_items_ok(responsibilities, 1000)),
  CONSTRAINT agent_profiles_restrictions_count CHECK (coalesce(array_length(restrictions,1),0) <= 64),
  CONSTRAINT agent_profiles_restrictions_items CHECK (cauce_text_items_ok(restrictions, 1000)),
  CONSTRAINT agent_profiles_tools_count CHECK (coalesce(array_length(tools,1),0) <= 64),
  CONSTRAINT agent_profiles_tools_items CHECK (cauce_text_items_ok(tools, 1000)),
  CONSTRAINT agent_profiles_operating_rules_count CHECK (coalesce(array_length(operating_rules,1),0) <= 64),
  CONSTRAINT agent_profiles_operating_rules_items CHECK (cauce_text_items_ok(operating_rules, 1000)),

  -- EL TECHO DEL BLOQUE GENERADO. Es el que de verdad importa y por eso existe además de los topes
  -- por campo: sin él, cuatro listas llenas dan 256.000 unidades con cada campo «dentro de su
  -- tope», y el fichero del contenedor deja de caber en la ventana del modelo.
  --
  -- `array_to_string(x,'')` concatena, y la longitud UTF-16 es aditiva sobre la concatenación, así
  -- que esto es exactamente la suma de las longitudes de los elementos. Es la MISMA suma, en el
  -- mismo orden, que hace `agentProfileUnits()` en packages/protocol/src/agent-profile.ts.
  CONSTRAINT agent_profiles_budget CHECK (
    cauce_utf16_units(coalesce(purpose,''))
    + cauce_utf16_units(coalesce(role_summary,''))
    + cauce_utf16_units(coalesce(human_brief,''))
    + cauce_utf16_units(array_to_string(responsibilities,''))
    + cauce_utf16_units(array_to_string(restrictions,''))
    + cauce_utf16_units(array_to_string(tools,''))
    + cauce_utf16_units(array_to_string(operating_rules,''))
    <= 24000
  )
);

-- ============================================================================================
-- LA SIEMBRA: el `role_brief` de hoy se copia al perfil
-- ============================================================================================
-- Copia LITERAL, sin reformatear: lo que el operador escribió es lo que el agente venía leyendo, y
-- «mejorarlo» acá le cambiaría la identidad a quince alias sin que nadie lo pidiera.
--
-- `ON CONFLICT DO NOTHING` la hace idempotente: si esta migración se re-aplicara sobre una base
-- que ya tiene perfiles, no pisa ninguno. No puede fallar por longitud; la aritmética está arriba.
INSERT INTO agent_profiles (tenant_id, alias, role_summary)
SELECT tenant_id, alias, btrim(role_brief)
  FROM agents
 WHERE role_brief IS NOT NULL AND btrim(role_brief) <> ''
ON CONFLICT (tenant_id, alias) DO NOTHING;
