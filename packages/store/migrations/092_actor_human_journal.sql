SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_092);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

ALTER TABLE agent_profile_revisions
  ADD COLUMN actor_human_id uuid REFERENCES console_users(id) ON DELETE RESTRICT;
ALTER TABLE agent_document_revisions
  ADD COLUMN actor_human_id uuid REFERENCES console_users(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION cauce_agent_profile_context_journal() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp
AS $$
DECLARE
  fila agent_profiles%ROWTYPE;
  humano text;
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
  humano := current_setting('cauce.actor_human_id', true);
  INSERT INTO agent_profile_revisions(
    tenant_id, alias, revision, operation, purpose, role_summary, human_brief,
    responsibilities, restrictions, tools, operating_rules, actor_tenant, actor_alias,
    actor_human_id
  ) VALUES (
    fila.tenant_id, fila.alias, fila.revision, lower(TG_OP), fila.purpose, fila.role_summary,
    fila.human_brief, fila.responsibilities, fila.restrictions, fila.tools, fila.operating_rules,
    NULLIF(current_setting('cauce.actor_tenant', true), ''),
    NULLIF(current_setting('cauce.actor_alias', true), ''),
    CASE
      WHEN humano ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN humano::uuid
      ELSE NULL
    END
  );
  RETURN NULL;
END;
$$;

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
