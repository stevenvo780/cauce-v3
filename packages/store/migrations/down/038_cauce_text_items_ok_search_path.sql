-- Devuelve el cuerpo de 026: la llamada vuelve a ir sin cualificar.
-- Revertir REINTRODUCE el fallo de restauración con `search_path` vacío; existe por simetría del
-- juego de migraciones, no porque haya motivo para usarlo.

SELECT pg_advisory_xact_lock(783_003_026);

CREATE OR REPLACE FUNCTION cauce_text_items_ok(items text[], max_units integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(items, '{}'::text[])) AS item
      WHERE item !~ '\S' OR cauce_utf16_units(item) > max_units
    )
  $$;
