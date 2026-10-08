SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_050);

CREATE TABLE fleet_hosts (
  host_id text PRIMARY KEY CHECK (host_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  controller_status text NOT NULL DEFAULT 'unknown' CHECK (controller_status IN ('unknown','reachable','unreachable')),
  controller_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON fleet_hosts TO cauce_gateway;
  END IF;
END;
$$;
