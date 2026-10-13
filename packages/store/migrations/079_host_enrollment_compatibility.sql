SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_079);
LOCK TABLE fleet_host_enrollments IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_host_enrollments
    WHERE char_length(btrim(display_name)) NOT BETWEEN 1 AND 80 OR char_length(notes)>500) THEN
    RAISE EXCEPTION 'resolve host invitations exceeding fleet host limits before migrating';
  END IF;
END
$$;
ALTER TABLE fleet_host_enrollments DROP CONSTRAINT fleet_host_enrollments_display_name_check;
ALTER TABLE fleet_host_enrollments ADD CONSTRAINT fleet_host_enrollments_display_name_check
  CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80);
ALTER TABLE fleet_host_enrollments DROP CONSTRAINT fleet_host_enrollments_notes_check;
ALTER TABLE fleet_host_enrollments ADD CONSTRAINT fleet_host_enrollments_notes_check CHECK (char_length(notes)<=500);
DROP INDEX fleet_host_enrollments_pending_host;
CREATE UNIQUE INDEX fleet_host_enrollments_pending_company_host ON fleet_host_enrollments(company_id,host_id) WHERE state='pending';
