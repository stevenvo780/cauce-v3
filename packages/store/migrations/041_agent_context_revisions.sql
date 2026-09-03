-- El DIARIO del contexto de un alias: qué decía su perfil en cada versión y qué fichero de
-- gobierno se le reescribió (W5 del programa v3.1).
--
-- POR QUÉ. Hoy el perfil vivo se puede leer y el `agent_profile.desired` de `audit_events` dice
-- QUE cambió, pero no QUÉ decía antes. Restaurar una versión anterior exige tener esa versión, y
-- la única que existía era el `role_summary` recortado que `agent_role_brief_history` (024)
-- guarda de rebote — un campo de los siete. Con el diario completo, restaurar es releer una fila
-- y volver a pasarla por el PUT canónico con su CAS; sin él, es reescribir de memoria.
--
-- 783_003_003 serializa contra el runner de migraciones; 783_003_041 es la sección crítica de
-- este juego. Ambos son de transacción: se sueltan solos al COMMIT o al ROLLBACK.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_041);

-- ============================================================================================
-- SIN FOREIGN KEY A `agents` NI A `agent_profiles`, A PROPÓSITO
-- ============================================================================================
-- Es la misma decisión explícita de 024 para `agent_role_brief_history`, y por el mismo motivo:
-- un `ON DELETE CASCADE` se llevaría por delante exactamente la prueba que esta tabla existe
-- para conservar. 026:173 declara el contraste a propósito — `agent_profiles` SÍ cascadea porque
-- guarda configuración vigente de alguien que existe; el diario guarda el pasado y tiene que
-- sobrevivir a la baja del alias.
--
-- SIN CHECK de longitud sobre los siete campos, también como 024: esta tabla guarda el PASADO, y
-- un tope de hoy aplicado a un valor histórico convertiría un cambio de tope en un borrado de
-- historia.
CREATE TABLE IF NOT EXISTS agent_profile_revisions (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  -- La revisión que tenía la fila al anotarse. No es única: un alias dado de baja y vuelto a dar
  -- de alta empieza otra vez en 1, y esa repetición es un hecho del pasado, no una violación.
  revision bigint NOT NULL CHECK (revision > 0),
  -- Distingue el nacimiento del perfil de su última versión antes del borrado. Sin esta columna
  -- una fila de `delete` y una de `insert` con los mismos siete campos serían indistinguibles.
  operation text NOT NULL CHECK (operation IN ('insert','update','delete')),
  purpose text,
  role_summary text,
  human_brief text,
  responsibilities text[],
  restrictions text[],
  tools text[],
  operating_rules text[],
  -- Quién lo hizo, cuando el camino que escribe lo declara con `SET LOCAL cauce.actor_*`. NULL
  -- significa «no consta», nunca «nadie»: inventar un actor sería peor que no tenerlo.
  actor_tenant text,
  actor_alias text,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS agent_profile_revisions_alias_idx
  ON agent_profile_revisions (tenant_id, alias, id DESC);

-- ============================================================================================
-- EL DIARIO DE FICHEROS GUARDA HUELLA, NUNCA CUERPO
-- ============================================================================================
-- Las escrituras de documentos no están hoy en ninguna lista de poda de retención (014), así que
-- guardar cuerpos sería comprometer al dueño con un coste de almacenamiento que nadie decidió y
-- con una copia del `CLAUDE.md` de cada alias fuera de su contenedor. Aquí sólo entran SHA y
-- metadatos; que ninguna columna pueda contener un cuerpo lo sostiene la BASE con los CHECK de
-- forma de abajo, no la palabra del proceso que inserta.
CREATE TABLE IF NOT EXISTS agent_document_revisions (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  path text NOT NULL CHECK (left(path, 1) = '/' AND char_length(path) BETWEEN 2 AND 4096),
  -- NULL sólo cuando la escritura dejó el fichero ausente; cualquier otra cosa que no sea un
  -- digest canónico se rechaza, y un cuerpo nunca lo es.
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  actor_tenant text,
  actor_alias text,
  written_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS agent_document_revisions_alias_idx
  ON agent_document_revisions (tenant_id, alias, kind, id DESC);

-- ============================================================================================
-- EL TRIGGER ANOTA TAMBIÉN LA CREACIÓN
-- ============================================================================================
-- `agent_profiles_manage_revision` (028) es BEFORE UPDATE y no sirve para esto: se saltaría en
-- silencio la CREACIÓN del perfil (`AgentProfileStore.replace` con `expectedRevision === null`),
-- que es justo la primera versión contra la que uno quiere diferenciar. Éste es AFTER INSERT OR
-- UPDATE OR DELETE y anota las tres.
--
-- Un UPDATE que no toca ninguno de los siete campos no deja fila: `applied_revision` avanza por
-- cada ACK del runtime y un diario que anote cada ACK no se puede leer. Ese avance ya tiene su
-- propia fila en `audit_events` (`agent_profile.applied`).
CREATE OR REPLACE FUNCTION cauce_agent_profile_context_journal() RETURNS trigger AS $$
DECLARE
  fila agent_profiles%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.purpose, NEW.role_summary, NEW.human_brief, NEW.responsibilities,
    NEW.restrictions, NEW.tools, NEW.operating_rules
  ) IS NOT DISTINCT FROM ROW(
    OLD.purpose, OLD.role_summary, OLD.human_brief, OLD.responsibilities,
    OLD.restrictions, OLD.tools, OLD.operating_rules
  ) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN fila := OLD; ELSE fila := NEW; END IF;
  INSERT INTO agent_profile_revisions(
    tenant_id, alias, revision, operation, purpose, role_summary, human_brief,
    responsibilities, restrictions, tools, operating_rules, actor_tenant, actor_alias
  ) VALUES (
    fila.tenant_id, fila.alias, fila.revision, lower(TG_OP), fila.purpose, fila.role_summary,
    fila.human_brief, fila.responsibilities, fila.restrictions, fila.tools, fila.operating_rules,
    NULLIF(current_setting('cauce.actor_tenant', true), ''),
    NULLIF(current_setting('cauce.actor_alias', true), '')
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_profiles_journal_context ON agent_profiles;
CREATE TRIGGER agent_profiles_journal_context
  AFTER INSERT OR UPDATE OR DELETE ON agent_profiles
  FOR EACH ROW EXECUTE FUNCTION cauce_agent_profile_context_journal();
