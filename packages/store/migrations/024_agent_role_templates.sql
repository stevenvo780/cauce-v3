-- Roles CON NOMBRE: una plantilla de rol reutilizable, y el diario de quién llevó cuál.
--
-- POR QUÉ. Hoy un rol no existe como cosa: es el texto suelto de `agents.role_brief` (migración
-- 020), uno por alias, escrito a mano. «orquestador», «constructor» y «operador» son los mismos
-- tres párrafos copiados en quince filas, así que corregir el rol de orquestador es corregirlo
-- nueve veces y descubrir en la décima que una copia decía otra cosa. Steven lo pidió con estas
-- palabras: «deberíamos poder crear roles como orquestar, constructor, operador etc y poder
-- cambiarlos entre agentes fácilmente».
--
-- La clave es GLOBAL y no compuesta con el tenant, por el mismo criterio que `harness_definitions`
-- y `role_policies`: una plantilla no la posee el tenant que la usa, es un objeto del catálogo que
-- se le presta a cualquier alias. Componer la clave con el tenant haría estructuralmente imposible
-- que `zeus` (Steven) y `kratos` (Miguel) lleven el MISMO rol, que es justamente lo que se pide.
--
-- ============================================================================================
-- EL TOPE HABLA UNA SOLA UNIDAD, Y LA UNIDAD ES EL PUNTO DE CÓDIGO
-- ============================================================================================
-- `brief` termina copiado literalmente en `agents.role_brief`, que viaja en el sobre de CADA
-- entrega como `self_role`. El 16-ago un alias se quedó SORDO —dejó de recibir, sin un solo error
-- visible— porque dos capas medían el mismo 1200 en unidades distintas: `char_length` de Postgres
-- cuenta PUNTOS DE CÓDIGO y `z.string().max()` cuenta unidades UTF-16. Un brief de 1200 puntos de
-- código con cien emojis mide 1300 en UTF-16: la base lo guarda, la pantalla dice «guardado» y el
-- adaptador rechaza el sobre entero.
--
-- Por eso este CHECK usa `char_length` y el número es EL MISMO 1200 de `agents_role_brief_len`
-- (migración 020). Del lado del código no hay una segunda copia del número: es
-- `ROLE_BRIEF_MAX_CODE_POINTS` en packages/protocol/src/schemas.ts, y se cuenta con
-- `countCodePoints()`, nunca con `String.length`. Si alguna vez hay que subir el tope, se sube en
-- los DOS sitios y en la MISMA unidad, o se vuelve a dejar a alguien sordo.
--
-- Un brief que no cabe en `agents.role_brief` no puede existir en el catálogo: una plantilla
-- inasignable sería una trampa que sólo explota al asignarla.

CREATE TABLE IF NOT EXISTS agent_role_templates (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  -- MISMO tope y MISMA unidad que agents_role_brief_len (020). Ver el bloque de arriba.
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 1200),
  -- Nace habilitada: una plantilla que se crea es una plantilla que se quiere usar. Retirarla es
  -- `enabled=false` y no un DELETE, para que los alias que la llevan no pierdan el vínculo ni el
  -- texto y el diario siga siendo legible.
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================================
-- QUÉ PLANTILLA LLEVA CADA ALIAS
-- ============================================================================================
-- Columna nullable sin default: operación de catálogo, no reescribe la tabla. NULL = el alias
-- tiene un rol A MEDIDA (o ninguno), que sigue siendo legítimo y es lo que tienen los 15 alias
-- hoy.
--
-- La FK nace NOT VALID por el mismo criterio que los CHECK de 008, 019 y 020: evita el escaneo
-- completo bajo ACCESS EXCLUSIVE dentro de la única transacción que aplica todas las migraciones.
-- Toda fila existente ya la satisface, porque la columna acaba de nacer NULL en todas.
--
-- ON DELETE SET NULL y no RESTRICT: borrar una plantilla no puede dejar a un alias sin identidad.
-- El TEXTO se queda en `role_brief` —el agente sigue sabiendo quién es—; lo que se pierde es el
-- vínculo con el catálogo, y el diario de abajo deja constancia de esa pérdida.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS role_template_slug text;

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_role_template_fk;
ALTER TABLE agents
  ADD CONSTRAINT agents_role_template_fk
  FOREIGN KEY (role_template_slug) REFERENCES agent_role_templates(slug) ON DELETE SET NULL
  NOT VALID;

-- Para la propagación (`UPDATE agents ... WHERE role_template_slug=$1`) y para que el ON DELETE
-- SET NULL de la FK no sea un seqscan por cada plantilla retirada.
CREATE INDEX IF NOT EXISTS agents_role_template_idx
  ON agents (role_template_slug) WHERE role_template_slug IS NOT NULL;

-- ============================================================================================
-- EL DIARIO: CAMBIAR DE ROL NO PUEDE PERDER EL ANTERIOR
-- ============================================================================================
-- Una fila por cada cambio del rol declarado de un alias, venga de donde venga.
--
-- SIN FOREIGN KEY, a propósito y en las dos direcciones:
--   * a `agents`, porque un ON DELETE CASCADE se llevaría por delante exactamente la prueba que
--     esta tabla existe para guardar — dar de baja un alias borraría la historia de lo que fue.
--     Es la lección de «el DELETE que parece igual arrastra la prueba por CASCADE».
--   * a `agent_role_templates`, porque el diario tiene que seguir siendo legible después de que
--     una plantilla se borre: «el 22-ago llevaba `orquestar`» es cierto aunque `orquestar` ya no
--     exista.
--
-- SIN CHECK de longitud sobre los briefs: esta tabla guarda el PASADO. Si algún día el tope
-- cambia, un valor histórico que ya no cumpliría el tope de hoy tiene que poder seguir estando —
-- un CHECK acá convertiría un cambio de tope en un borrado de historia.
CREATE TABLE IF NOT EXISTS agent_role_brief_history (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert','update','delete')),
  previous_brief text,
  previous_template_slug text,
  new_brief text,
  new_template_slug text,
  -- Quién lo hizo, cuando el camino que escribe lo declara con `SET LOCAL cauce.actor_*`. Es
  -- NULL para cualquier UPDATE crudo contra la base y para la mutación de configuración, que no
  -- declara nada: ahí el «quién» vive en `config_revisions`, correlacionable por `changed_at`.
  -- NULL significa «no consta», nunca «nadie»; inventar un actor sería peor que no tenerlo.
  actor_tenant text,
  actor_alias text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_role_brief_history_alias_idx
  ON agent_role_brief_history (tenant_id, alias, id DESC);

-- ============================================================================================
-- LA COHERENCIA LA SOSTIENE LA BASE, NO EL QUE ESCRIBE
-- ============================================================================================
-- INVARIANTE: si `role_template_slug` no es NULL, entonces `role_brief` es EXACTAMENTE el `brief`
-- de esa plantilla.
--
-- Sin esta garantía la columna sería una etiqueta que miente: la pantalla de configuración ya
-- edita `agents.role_brief` por su propio camino (`configuration.ts`, mutación `agent/update`) y
-- no sabe nada de plantillas, así que un operador que retoca el texto de `zeus` a mano dejaría a
-- `zeus` marcado como «orquestador» con un texto que ya no es el de la plantilla. Esa etiqueta
-- falsa es peor que no tener etiqueta: la consola mostraría un rol compartido donde ya no lo hay.
--
-- Se resuelve en un trigger BEFORE y no en el código porque el código NO es un único camino: son
-- la mutación de configuración, estos métodos nuevos, los rollback de revisión y cualquier
-- UPDATE de mantenimiento. La base es el único sitio por donde pasan todos.
--
-- Editar un brief a mano DESVINCULA el alias de la plantilla (slug -> NULL) y le deja el texto.
-- Es la respuesta correcta: el alias sigue teniendo su rol, y deja de figurar como que lleva uno
-- del catálogo que ya no lleva.
CREATE OR REPLACE FUNCTION cauce_agents_role_template_coherence() RETURNS trigger AS $$
DECLARE
  brief_de_la_plantilla text;
BEGIN
  IF NEW.role_template_slug IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT brief INTO brief_de_la_plantilla
    FROM agent_role_templates WHERE slug = NEW.role_template_slug;
  IF brief_de_la_plantilla IS NULL OR NEW.role_brief IS DISTINCT FROM brief_de_la_plantilla THEN
    NEW.role_template_slug := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_role_template_coherence ON agents;
CREATE TRIGGER agents_role_template_coherence
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_agents_role_template_coherence();

-- El diario también se escribe en la base y no en el código, por el mismo motivo: un cambio de
-- identidad que entre por un camino que nadie previó tiene que quedar anotado igual. Un diario
-- que se pueda esquivar no es un diario.
--
-- Devuelve NULL (es AFTER, el valor se descarta) y no inserta nada cuando ni el brief ni el slug
-- cambiaron: la tabla `agents` se actualiza por muchos motivos que no son la identidad, y un
-- diario que anota cada `enabled=false` no se puede leer.
CREATE OR REPLACE FUNCTION cauce_agents_role_brief_journal() RETURNS trigger AS $$
DECLARE
  brief_anterior text := NULL;
  slug_anterior text := NULL;
  brief_nuevo text := NULL;
  slug_nuevo text := NULL;
  id_tenant text;
  id_alias text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    brief_anterior := OLD.role_brief;
    slug_anterior := OLD.role_template_slug;
    id_tenant := OLD.tenant_id;
    id_alias := OLD.alias;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    brief_nuevo := NEW.role_brief;
    slug_nuevo := NEW.role_template_slug;
    id_tenant := NEW.tenant_id;
    id_alias := NEW.alias;
  END IF;
  IF brief_anterior IS NOT DISTINCT FROM brief_nuevo
     AND slug_anterior IS NOT DISTINCT FROM slug_nuevo THEN
    RETURN NULL;
  END IF;
  INSERT INTO agent_role_brief_history(
    tenant_id, alias, operation, previous_brief, previous_template_slug,
    new_brief, new_template_slug, actor_tenant, actor_alias
  ) VALUES (
    id_tenant, id_alias, lower(TG_OP), brief_anterior, slug_anterior,
    brief_nuevo, slug_nuevo,
    NULLIF(current_setting('cauce.actor_tenant', true), ''),
    NULLIF(current_setting('cauce.actor_alias', true), '')
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_role_brief_journal ON agents;
CREATE TRIGGER agents_role_brief_journal
  AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_agents_role_brief_journal();
