-- Un solo rol por identidad: `agent_profiles.role_summary` es la fuente canónica.
--
-- Antes de esta migración convivían dos textos editables para el mismo hecho:
--
--   * `agent_profiles.role_summary`: el rol rico que viaja en `hello_ack` y se escribe en el
--     fichero del arnés;
--   * `agents.role_brief`: el rol corto que `claimDeliveries()` copiaba a `self_role`.
--
-- La 026 los sembró iguales, pero dejó que evolucionaran por separado. Un guardado podía cambiar
-- lo que el agente leía al arrancar sin cambiar la identidad de cada entrega, o al revés. Desde
-- acá `role_summary` manda. `role_brief` se conserva únicamente como PROYECCIÓN compatible para
-- imágenes y vistas anteriores: trim + los primeros 1.200 puntos de código, exactamente la misma
-- operación que `clampToRoleBriefLimit()` en `@cauce/protocol`.
--
-- Las escrituras legacy siguen funcionando durante la retirada: escribir `agents.role_brief`
-- actualiza explícitamente `agent_profiles.role_summary` en la misma transacción. No hay una
-- ventana confirmada en la que uno se haya guardado y el otro no. Las plantillas de la 024 hacen
-- lo mismo: asignarlas por `agents` actualiza el perfil, y editar el brief de una plantilla
-- propaga ambos lados a todos sus portadores.
--
-- RECONCILIACIÓN INICIAL. Cuando ya hay perfil, el perfil gana aunque su rol sea NULL: NULL es la
-- decisión explícita «sin rol», no permiso para revivir un texto legacy. Sólo un alias SIN fila de
-- perfil se siembra desde `role_brief`. Después se deriva la proyección para todas las filas.

CREATE OR REPLACE FUNCTION cauce_role_summary_to_brief(summary text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      WHEN summary IS NULL OR btrim(summary) = '' THEN NULL
      ELSE substring(btrim(summary) FROM 1 FOR 1200)
    END
  $$;

-- La revisión del perfil es PROPIA del perfil. No comparte el contador global de
-- `config_revisions`: dos editores del mismo alias comparan exactamente el recurso que están
-- editando y una mutación ajena no vuelve obsoleto su borrador.
--
-- `applied_revision` separa lo deseado en Postgres de lo que el runtime acreditó haber escrito.
-- NULL significa «nunca hubo un ACK acreditable». Una revisión anterior significa «el disco
-- todavía corresponde a una versión vieja». Sólo el camino gateway -> relay -> agente la avanza.
ALTER TABLE agent_profiles
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS applied_revision bigint;

ALTER TABLE agent_profiles
  DROP CONSTRAINT IF EXISTS agent_profiles_revision_positive;
ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_revision_positive CHECK (revision > 0);
ALTER TABLE agent_profiles
  DROP CONSTRAINT IF EXISTS agent_profiles_applied_revision_valid;
ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_applied_revision_valid
  CHECK (applied_revision IS NULL OR (applied_revision > 0 AND applied_revision <= revision));

CREATE OR REPLACE FUNCTION cauce_agent_profile_revision_guard() RETURNS trigger AS $$
BEGIN
  IF ROW(
    NEW.purpose, NEW.role_summary, NEW.human_brief, NEW.responsibilities,
    NEW.restrictions, NEW.tools, NEW.operating_rules
  ) IS DISTINCT FROM ROW(
    OLD.purpose, OLD.role_summary, OLD.human_brief, OLD.responsibilities,
    OLD.restrictions, OLD.tools, OLD.operating_rules
  ) THEN
    -- El contenido anterior puede seguir aplicado; no se inventa que la revisión nueva llegó al
    -- disco. Conservar el número viejo permite distinguir atraso conocido de estado desconocido.
    NEW.revision := OLD.revision + 1;
    NEW.applied_revision := OLD.applied_revision;
  ELSIF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'agent profile revision is managed by Cauce'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_profiles_revision_managed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_profiles_manage_revision ON agent_profiles;
CREATE TRIGGER agent_profiles_manage_revision
  BEFORE UPDATE ON agent_profiles
  FOR EACH ROW EXECUTE FUNCTION cauce_agent_profile_revision_guard();

-- Un rol de sólo espacios podía entrar por SQL directo aunque el borde TypeScript lo normalizara
-- a NULL. Se normaliza antes de validar la nueva invariante para que la migración sea aplicable a
-- cualquier estado producido por la 026, no sólo al producido por la consola.
UPDATE agent_profiles
   SET role_summary=NULL, updated_at=now()
 WHERE role_summary IS NOT NULL AND btrim(role_summary)='';

ALTER TABLE agent_profiles
  DROP CONSTRAINT IF EXISTS agent_profiles_role_summary_visible;
ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_role_summary_visible
  CHECK (role_summary IS NULL OR role_summary ~ '\S') NOT VALID;
ALTER TABLE agent_profiles VALIDATE CONSTRAINT agent_profiles_role_summary_visible;

INSERT INTO agent_profiles (tenant_id, alias, role_summary)
SELECT agent.tenant_id, agent.alias, btrim(agent.role_brief)
  FROM agents agent
  LEFT JOIN agent_profiles profile
    ON profile.tenant_id=agent.tenant_id AND profile.alias=agent.alias
 WHERE profile.tenant_id IS NULL
   AND cauce_role_summary_to_brief(agent.role_brief) IS NOT NULL
ON CONFLICT (tenant_id, alias) DO NOTHING;

-- El enlace de plantilla sólo sigue siendo cierto si el rol canónico COMPLETO coincide. Que los
-- primeros 1.200 caracteres coincidan no alcanza: un `role_summary` rico puede compartir el
-- prefijo y, aun así, no ser esa plantilla.
UPDATE agents agent
   SET role_brief=cauce_role_summary_to_brief(profile.role_summary),
       role_template_slug=CASE
         WHEN EXISTS (
           SELECT 1 FROM agent_role_templates template
            WHERE template.slug=agent.role_template_slug
              AND template.brief=profile.role_summary
         ) THEN agent.role_template_slug
         ELSE NULL
       END,
       updated_at=now()
  FROM agent_profiles profile
 WHERE profile.tenant_id=agent.tenant_id AND profile.alias=agent.alias
   AND (
     agent.role_brief IS DISTINCT FROM cauce_role_summary_to_brief(profile.role_summary)
     OR agent.role_template_slug IS DISTINCT FROM CASE
       WHEN EXISTS (
         SELECT 1 FROM agent_role_templates template
          WHERE template.slug=agent.role_template_slug
            AND template.brief=profile.role_summary
       ) THEN agent.role_template_slug
       ELSE NULL
     END
   );

-- Perfil -> proyección legacy. `pg_trigger_depth()` corta únicamente el rebote originado por la
-- traducción legacy de abajo; una escritura canónica directa siempre entra con profundidad 1.
CREATE OR REPLACE FUNCTION cauce_sync_profile_role_to_agent() RETURNS trigger AS $$
DECLARE
  projected text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE agents
       SET role_brief=NULL, role_template_slug=NULL, updated_at=now()
     WHERE tenant_id=OLD.tenant_id AND alias=OLD.alias
       AND (role_brief IS NOT NULL OR role_template_slug IS NOT NULL);
    RETURN NULL;
  END IF;

  projected := cauce_role_summary_to_brief(NEW.role_summary);
  UPDATE agents agent
     SET role_brief=projected,
         role_template_slug=CASE
           WHEN EXISTS (
             SELECT 1 FROM agent_role_templates template
              WHERE template.slug=agent.role_template_slug
                AND template.brief=NEW.role_summary
           ) THEN agent.role_template_slug
           ELSE NULL
         END,
         updated_at=now()
   WHERE agent.tenant_id=NEW.tenant_id AND agent.alias=NEW.alias
     AND (
       agent.role_brief IS DISTINCT FROM projected
       OR agent.role_template_slug IS DISTINCT FROM CASE
         WHEN EXISTS (
           SELECT 1 FROM agent_role_templates template
            WHERE template.slug=agent.role_template_slug
              AND template.brief=NEW.role_summary
         ) THEN agent.role_template_slug
         ELSE NULL
       END
     );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_profiles_project_role ON agent_profiles;
CREATE TRIGGER agent_profiles_project_role
  AFTER INSERT OR UPDATE OF role_summary OR DELETE ON agent_profiles
  FOR EACH ROW EXECUTE FUNCTION cauce_sync_profile_role_to_agent();

-- Escritura legacy -> fuente canónica. En un INSERT sin brief no se fabrica una fila vacía; en un
-- UPDATE a NULL sí se borra el rol canónico, conservando las demás caras del perfil.
CREATE OR REPLACE FUNCTION cauce_sync_agent_role_to_profile() RETURNS trigger AS $$
DECLARE
  canonical text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  canonical := cauce_role_summary_to_brief(NEW.role_brief);
  IF canonical IS NULL THEN
    IF TG_OP = 'UPDATE' THEN
      UPDATE agent_profiles
         SET role_summary=NULL, updated_at=now()
       WHERE tenant_id=NEW.tenant_id AND alias=NEW.alias
         AND role_summary IS NOT NULL;
    END IF;
    RETURN NULL;
  END IF;

  INSERT INTO agent_profiles (tenant_id, alias, role_summary)
  VALUES (NEW.tenant_id, NEW.alias, canonical)
  ON CONFLICT (tenant_id, alias) DO UPDATE
    SET role_summary=EXCLUDED.role_summary, updated_at=now()
  WHERE agent_profiles.role_summary IS DISTINCT FROM EXCLUDED.role_summary;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_translate_legacy_role ON agents;
CREATE TRIGGER agents_translate_legacy_role
  AFTER INSERT OR UPDATE OF role_brief ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_sync_agent_role_to_profile();

-- Una plantilla es todavía una entrada legacy de 1.200 caracteres, pero ya no puede cambiar por
-- detrás del perfil. La propagación ocurre AFTER para que el trigger de coherencia de la 024 vea
-- el brief NUEVO de la plantilla y conserve el slug de sus portadores.
CREATE OR REPLACE FUNCTION cauce_sync_role_template_to_profiles() RETURNS trigger AS $$
BEGIN
  IF NEW.brief IS NOT DISTINCT FROM OLD.brief THEN
    RETURN NULL;
  END IF;

  UPDATE agent_profiles profile
     SET role_summary=NEW.brief, updated_at=now()
    FROM agents agent
   WHERE agent.role_template_slug=NEW.slug
     AND profile.tenant_id=agent.tenant_id AND profile.alias=agent.alias
     AND profile.role_summary IS DISTINCT FROM NEW.brief;

  UPDATE agents
     SET role_brief=NEW.brief, updated_at=now()
   WHERE role_template_slug=NEW.slug
     AND role_brief IS DISTINCT FROM NEW.brief;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_role_templates_propagate_profile ON agent_role_templates;
CREATE TRIGGER agent_role_templates_propagate_profile
  AFTER UPDATE OF brief ON agent_role_templates
  FOR EACH ROW EXECUTE FUNCTION cauce_sync_role_template_to_profiles();
