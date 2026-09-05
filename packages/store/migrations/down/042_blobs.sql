-- Retira el índice del almacén de blobs.
--
-- Se niega si hay una migración posterior anotada. NO se niega con filas: un blob es un fichero en
-- disco y su fila sólo lo describe; bajar la tabla deja ficheros huérfanos que la purga retira, no
-- destruye evidencia. Como en todo el juego, el rollback de verdad de la base es el backup.

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_042);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'042_blobs.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 042 while a later migration is present';
  END IF;
END
$$;

DROP TABLE IF EXISTS blobs;

DELETE FROM schema_migrations WHERE version='042_blobs.sql';
