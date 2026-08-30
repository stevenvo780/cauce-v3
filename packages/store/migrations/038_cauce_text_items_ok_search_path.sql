-- El CHECK de `agent_profiles` dejó de poder RESTAURARSE el 2026-08-28, y no se notó hasta que el
-- respaldo llevaba 18 h en rojo.
--
-- `pg_dump` emite, por seguridad, `SELECT pg_catalog.set_config('search_path', '', false)`. Con la
-- ruta de búsqueda VACÍA, la llamada SIN CUALIFICAR a `cauce_utf16_units(item)` que vive dentro del
-- cuerpo de `cauce_text_items_ok` (026, línea 126) no resuelve, aunque la función exista como
-- `public.cauce_utf16_units`. El error resultante —«function cauce_utf16_units(text) does not
-- exist ... CONTEXT: SQL function "cauce_text_items_ok" during inlining»— PARECE un problema de
-- ORDEN del dump y no lo es: pg_restore respeta las secciones y la función ya está creada cuando
-- corre el COPY. Lo que falta es el esquema en la ruta, no la función.
--
-- Por qué apareció ese día y no antes: el CHECK se evalúa POR FILA, y `agent_profiles` no tenía
-- ninguna hasta que entró el perfil de `salva`. El primer COPY con datos fue el primero que
-- disparó la evaluación. El defecto llevaba latente desde 026.
--
-- Se cualifica la llamada y NADA MÁS. La alternativa —`ALTER FUNCTION ... SET search_path`—
-- también resolvería, pero una función SQL con cláusula SET deja de ser INLINEABLE, y el propio
-- mensaje de error muestra que hoy se inlinea: cambiaría el plan del CHECK en cada INSERT para
-- arreglar algo que se arregla con un prefijo.

SELECT pg_advisory_xact_lock(783_003_026);

CREATE OR REPLACE FUNCTION cauce_text_items_ok(items text[], max_units integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(items, '{}'::text[])) AS item
      WHERE item !~ '\S' OR public.cauce_utf16_units(item) > max_units
    )
  $$;
