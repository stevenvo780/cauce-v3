SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_079);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'079_host_enrollment_compatibility.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'079_host_enrollment_compatibility.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 079 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='079_host_enrollment_compatibility.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='079_host_enrollment_compatibility.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='079_host_enrollment_compatibility.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'de95bf18e9c32972a89c9c36bd57c5c8a4e948035136b69b73175d65cbc3a1c2'))
    OR (to_regclass('public.fleet_host_enrollments_pending_company_host') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='079_host_enrollment_compatibility.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 079 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE fleet_host_enrollments IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT host_id FROM fleet_host_enrollments WHERE state='pending' GROUP BY host_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'resolve cross-company pending host invitations before reverting';
  END IF;
END
$$;
DROP INDEX IF EXISTS fleet_host_enrollments_pending_company_host;
CREATE UNIQUE INDEX fleet_host_enrollments_pending_host ON fleet_host_enrollments(host_id) WHERE state='pending';
ALTER TABLE fleet_host_enrollments DROP CONSTRAINT fleet_host_enrollments_display_name_check;
ALTER TABLE fleet_host_enrollments ADD CONSTRAINT fleet_host_enrollments_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120);
ALTER TABLE fleet_host_enrollments DROP CONSTRAINT fleet_host_enrollments_notes_check;
ALTER TABLE fleet_host_enrollments ADD CONSTRAINT fleet_host_enrollments_notes_check CHECK (char_length(notes)<=2000);
DELETE FROM schema_migration_ledger WHERE version='079_host_enrollment_compatibility.sql';
DELETE FROM schema_migrations WHERE version='079_host_enrollment_compatibility.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
