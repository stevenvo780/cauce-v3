SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_064);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'064_company_context_anchor.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'064_company_context_anchor.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 064 while a later migration is present';
  END IF;
END
$$;
DROP FUNCTION cauce_ensure_context_director_anchor(text,text,text,bigint,text);
DELETE FROM schema_migration_ledger WHERE version='064_company_context_anchor.sql';
DELETE FROM schema_migrations WHERE version='064_company_context_anchor.sql';
