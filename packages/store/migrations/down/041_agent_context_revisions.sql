-- Retira el diario del contexto de un alias.
--
-- Lleva la misma disciplina que `down/035`: se niega si hay una migración posterior anotada y se
-- niega si ya hay filas de evidencia. Un diario existe para conservar prueba, así que bajarlo con
-- filas dentro no sería un rollback, sería un borrado de historia con otro nombre.
--
-- Como en todo el juego, el rollback de verdad de la base es el backup; esto existe para que el
-- juego de migraciones tenga inversa probada.

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_041);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations WHERE version>'041_agent_context_revisions.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 041 while a later migration is present';
  END IF;

  IF EXISTS (SELECT 1 FROM agent_profile_revisions)
     OR EXISTS (SELECT 1 FROM agent_document_revisions) THEN
    RAISE EXCEPTION 'cannot downgrade schema 041 after context journal evidence has been recorded';
  END IF;
END
$$;

-- El trigger primero: si cayera después del DROP de la tabla, cualquier escritura de perfil
-- ocurrida entre ambos pasos fallaría contra una relación que ya no existe.
DROP TRIGGER IF EXISTS agent_profiles_journal_context ON agent_profiles;
DROP FUNCTION IF EXISTS cauce_agent_profile_context_journal();

DROP TABLE IF EXISTS agent_profile_revisions;
DROP TABLE IF EXISTS agent_document_revisions;

DELETE FROM schema_migrations WHERE version='041_agent_context_revisions.sql';
