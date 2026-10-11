SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_056);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM company_office_layouts) OR EXISTS (SELECT 1 FROM console_company_preferences) THEN
    RAISE EXCEPTION 'export persisted office layouts before reverting';
  END IF;
END $$;
DROP FUNCTION cauce_runtime_grants_056();
DROP TABLE console_company_preferences;
DROP TABLE company_office_layouts;
