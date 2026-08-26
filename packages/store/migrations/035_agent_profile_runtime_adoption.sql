-- A profile is applied only after one real, fenced delivery consumed the exact files measured for
-- the current container generation. Disk-write ACKs remain expectations; they are never promoted
-- to behavioral evidence by themselves.

SELECT pg_advisory_xact_lock(783_003_006);

-- PostgreSQL CHECK expressions cannot contain a subquery, so the exact JSON shape lives in one
-- immutable predicate shared by both tables. Application validation is not a substitute: these
-- rows are the durable source used to call a profile "applied" after restarts and rollbacks.
CREATE FUNCTION cauce_profile_runtime_documents_valid(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  document jsonb;
  document_count integer;
BEGIN
  IF jsonb_typeof(candidate) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  document_count := jsonb_array_length(candidate);
  IF document_count NOT BETWEEN 1 AND 7 THEN
    RETURN false;
  END IF;
  FOR document IN SELECT value FROM jsonb_array_elements(candidate) LOOP
    IF jsonb_typeof(document) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(document)) <> 3
       OR NOT document ?& ARRAY['name','path','sha']
       OR (document->>'name') !~ '^[A-Za-z0-9._-]{1,128}$'
       OR char_length(document->>'path') NOT BETWEEN 1 AND 4096
       OR left(document->>'path', 1) <> '/'
       OR regexp_replace(document->>'path', '^.*/', '') <> document->>'name'
       OR (document->>'sha') !~ '^[a-f0-9]{64}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT value->>'name') = document_count
                  AND count(DISTINCT value->>'path') = document_count
            FROM jsonb_array_elements(candidate));
END
$$;

CREATE TABLE agent_profile_runtime_expectations (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  generation text NOT NULL CHECK (generation <> '' AND char_length(generation) <= 128),
  documents jsonb NOT NULL
    CONSTRAINT agent_profile_runtime_expectations_documents_valid
    CHECK (cauce_profile_runtime_documents_valid(documents)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, alias),
  FOREIGN KEY (tenant_id, alias)
    REFERENCES agent_profiles(tenant_id, alias) ON DELETE CASCADE
);

CREATE TABLE agent_profile_runtime_adoptions (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  generation text NOT NULL CHECK (generation <> '' AND char_length(generation) <= 128),
  documents jsonb NOT NULL
    CONSTRAINT agent_profile_runtime_adoptions_documents_valid
    CHECK (cauce_profile_runtime_documents_valid(documents)),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt > 0),
  instance_id text NOT NULL CHECK (instance_id <> '' AND char_length(instance_id) <= 128),
  epoch bigint NOT NULL CHECK (epoch > 0),
  adopted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, alias, revision, generation),
  UNIQUE (delivery_id),
  FOREIGN KEY (tenant_id, alias)
    REFERENCES agent_profiles(tenant_id, alias) ON DELETE CASCADE
);

-- History is intentionally retained when the current expectation advances, so this cannot be a
-- permanent FK. At insertion time, however, the evidence must match the exact locked expectation;
-- the trigger makes direct SQL and future writers obey the same invariant as the repository.
CREATE FUNCTION cauce_profile_runtime_adoption_matches_expectation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_profile_runtime_expectations expectation
     WHERE expectation.tenant_id=NEW.tenant_id
       AND expectation.alias=NEW.alias
       AND expectation.revision=NEW.revision
       AND expectation.generation=NEW.generation
       AND expectation.documents=NEW.documents
  ) THEN
    RAISE EXCEPTION 'runtime profile adoption does not match the current expectation'
      USING ERRCODE='23514', CONSTRAINT='agent_profile_runtime_adoptions_expectation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_profile_runtime_adoptions_expectation_guard
BEFORE INSERT OR UPDATE ON agent_profile_runtime_adoptions
FOR EACH ROW EXECUTE FUNCTION cauce_profile_runtime_adoption_matches_expectation();

COMMENT ON TABLE agent_profile_runtime_expectations IS
  'Exact disk evidence which a capability-aware delivery must consume; never an applied ACK.';
COMMENT ON TABLE agent_profile_runtime_adoptions IS
  'Behavioral ACK from a real fenced delivery after adapter-side exact document matching.';
