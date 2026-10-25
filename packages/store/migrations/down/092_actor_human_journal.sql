SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_092);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'092_actor_human_journal.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'092_actor_human_journal.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 092 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='092_actor_human_journal.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='092_actor_human_journal.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='092_actor_human_journal.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'ce4a59a20b0a663c0333a22a99dc5c716256b7388a7aa16da8d56b90fe01770f')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 092 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agent_profile_revisions, agent_document_revisions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_profile_revisions WHERE actor_human_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM agent_document_revisions WHERE actor_human_id IS NOT NULL) THEN
    RAISE EXCEPTION 'clear recorded human authors before reverting schema 092';
  END IF;
END
$$;

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
ALTER FUNCTION cauce_agent_profile_context_journal() SET search_path=pg_catalog,public,pg_temp;

ALTER TABLE agent_profile_revisions DROP COLUMN actor_human_id;
ALTER TABLE agent_document_revisions DROP COLUMN actor_human_id;

DELETE FROM schema_migration_ledger WHERE version='092_actor_human_journal.sql';
DELETE FROM schema_migrations WHERE version='092_actor_human_journal.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
