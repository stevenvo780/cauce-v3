DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM human_message_client_provenance)
     OR EXISTS (SELECT 1 FROM human_oauth_client_delegations)
     OR EXISTS (SELECT 1 FROM human_client_delegation_operations) THEN
    RAISE EXCEPTION 'rollback preserves human client history; populated provenance schema cannot be removed';
  END IF;
END;
$$;
DROP TABLE human_message_client_provenance;
DROP TABLE human_client_delegation_operations;
DROP TABLE human_oauth_client_delegations;
DROP FUNCTION preserve_human_client_records();
ALTER TABLE cauce_oauth_grants DROP CONSTRAINT cauce_oauth_grants_provenance_owner;
