-- Arriendo del control de la TUI (D3 del programa v3.1).
--
-- Mientras un operador tiene tomada la terminal de un alias, las entregas de ese alias se
-- ENCOLAN. No se fallan, no se reencolan, no se marcan de ninguna manera: el arriendo es una
-- condición de NO SELECCIÓN en el predicado de `claimOne`, así que las filas siguen `pending`
-- con su `available_at` y su `attempt` intactos y, al soltar el control, se toman en el mismo
-- orden en que estaban. Fallarlas sería perder el turno de un humano por escribir en una TUI.
--
-- Aditiva salvo por un CHECK que se ENSANCHA: `harness_rw` es un valor nuevo de `mode`, ningún
-- valor anterior deja de ser válido y ninguna fila se reescribe. Con la tabla de arriendos vacía
-- el sistema se comporta exactamente como antes.

-- 783_003_003 serializa contra el runner de migraciones; 783_003_040 es la sección crítica de
-- este juego. Ambos son de transacción: se sueltan solos al COMMIT o al ROLLBACK.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_040);

-- 011 declaró el CHECK del modo EN LÍNEA, así que su nombre lo puso PostgreSQL y no está escrito
-- en ningún sitio. Se resuelve por catálogo —el único CHECK de una sola columna sobre `mode`— en
-- vez de adivinar `terminal_sessions_mode_check`: si el nombre no fuese ese, el DROP fallaría y
-- la migración dejaría el modo escribible sin admitir.
DO $$
DECLARE
  nombre text;
BEGIN
  SELECT restriccion.conname INTO nombre
    FROM pg_constraint restriccion
    JOIN pg_attribute columna
      ON columna.attrelid=restriccion.conrelid
     AND columna.attname='mode'
     AND columna.attnum=ANY(restriccion.conkey)
   WHERE restriccion.conrelid='terminal_sessions'::regclass
     AND restriccion.contype='c'
     AND array_length(restriccion.conkey,1)=1
     AND restriccion.conname<>'terminal_sessions_mode_check_v2';
  IF nombre IS NOT NULL THEN
    EXECUTE format('ALTER TABLE terminal_sessions DROP CONSTRAINT %I', nombre);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='terminal_sessions'::regclass
       AND conname='terminal_sessions_mode_check_v2'
  ) THEN
    ALTER TABLE terminal_sessions
      ADD CONSTRAINT terminal_sessions_mode_check_v2
      CHECK (mode IN ('shell','harness','harness_rw'));
  END IF;
END
$$;

-- La ventana de prórroga de TUI-06 va en su propia columna. `consumed_at` NO se toca: alimenta
-- `sessionState`/`occupies_slot` en session-control.ts y el modelo de plazas de la consola, y
-- moverlo reescribiría en silencio la contabilidad de plazas.
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS window_extended_to timestamptz;

CREATE TABLE IF NOT EXISTS terminal_control_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES terminal_sessions(id),
  tenant_id text NOT NULL,
  alias text NOT NULL,
  operator_id text NOT NULL,
  reason text NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  -- Un navegador que muere sin soltar no puede callar a un alias para siempre. La BASE acota la
  -- ventana —positiva y con techo— y `takeControlHold` suelta como `expired` los arriendos
  -- vencidos del alias antes de insertar el suyo, dentro de la misma transacción: el índice de un
  -- solo arriendo vivo no sabe de caducidad, así que la plaza la libera el camino de toma.
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  released_reason text,
  CONSTRAINT terminal_control_holds_window_ck CHECK (expires_at>taken_at),
  -- Techo de 12 h: la prórroga de TUI-06 se apoya en este CHECK, no en la palabra del proceso que
  -- extiende. Un arriendo sin tope calla la cola entera de un alias con todas las filas `pending`,
  -- que es la forma de fallo menos visible del sistema.
  CONSTRAINT terminal_control_holds_ceiling_ck CHECK (expires_at<=taken_at+interval '12 hours'),
  -- Quién calló a qué agente y por qué: una fila soltada sin motivo, o soltada antes de tomarse,
  -- no es rastro de auditoría.
  CONSTRAINT terminal_control_holds_release_ck CHECK (
    released_at IS NULL OR (released_reason IS NOT NULL AND released_at>=taken_at)
  )
);

-- Un solo arriendo vivo por alias, y el mismo índice que resuelve el NOT EXISTS del camino
-- caliente: un índice parcial gemelo no único sobre las mismas columnas no filtraría ni una fila
-- más y sólo costaría escrituras.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_control_holds_one_active_idx
  ON terminal_control_holds (tenant_id, alias) WHERE released_at IS NULL;

-- El historial de una sesión concreta al cerrarla o auditarla.
CREATE INDEX IF NOT EXISTS terminal_control_holds_session_idx
  ON terminal_control_holds (session_id, taken_at);
