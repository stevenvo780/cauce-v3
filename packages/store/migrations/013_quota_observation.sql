-- packages/store/migrations/013_quota_observation.sql
--
-- Consumo de cuotas de las suscripciones de IA. Es el ÚNICO dato del panel que no se puede
-- derivar de esta base: lo produce `get_ai_quotas` interrogando a los CLIs (claude, codex,
-- antigravity, opencode) que viven en kratos y dentro de los contenedores de agente, no en
-- agora-storage donde corren el gateway y la consola. Por eso hay que persistirlo: un recolector
-- muestrea y publica por HTTP, y el gateway se limita a leer lo último recibido.
--
-- CUATRO tablas porque hay cuatro hechos distintos, y aplastarlos pierde justo lo que costó un
-- incidente:
--   quota_collections      una corrida del recolector. Ancla de idempotencia y de procedencia
--                          (qué host, qué versión de la herramienta). Sin ella, un reintento de
--                          red duplica puntos y la PENDIENTE de consumo — el dato que importa —
--                          miente.
--   quota_provider_reports estado del PROVEEDOR en esa corrida. Existe porque un proveedor puede
--                          reportar ok=false con CERO ventanas: si sólo guardáramos ventanas,
--                          "el CLI de claude dejó de responder" sería indistinguible de "claude
--                          no se usó", y son diagnósticos opuestos.
--   quota_window_samples   el histórico append-only: una fila por ventana (sesión/semana/mes) y
--                          por grupo/cuenta. Un proveedor tiene VARIAS ventanas y puede tener
--                          VARIAS cuentas (codex reporta hoy 'codex' al 100% y 'codex_bengalfox'
--                          al 0%): colapsar eso a un número es exactamente el error que hace
--                          creer que hay saldo cuando la cuenta que se está usando no lo tiene.
--   quota_window_state     la última muestra de cada ventana, materializada en el mismo INSERT.
--                          El panel refresca cada 60s y el camino de lectura no debe escanear el
--                          histórico ni encarecerse a medida que crece la retención.
--
-- Aditiva por construcción: nada del camino caliente (publish, claimDeliveries,
-- assertRuntimeRoute) lee ninguna de estas tablas. Sin recolector corriendo quedan vacías y el
-- panel muestra "sin muestras" en vez de inventar un cero tranquilizador.

-- ------------------------------------------------------------------------------------------
-- 0. Convivencia con la migración 012 (paused_until / paused_reason en provider_accounts).
--
-- 012 es de otro trabajo y define la SEMÁNTICA del corte de despacho; esta migración sólo
-- necesita que las columnas existan para poder alimentarlas. ADD COLUMN IF NOT EXISTS es
-- deliberadamente un no-op cuando 012 ya corrió (mismo recurso que usó 009 con
-- role_policies.allow_notify), así que el orden de aterrizaje entre las dos ramas es
-- indistinto. CONTRATO con 012: paused_until timestamptz, paused_reason text. Si 012 elige
-- otros nombres o tipos, el UPDATE de auto-pausa documentado al final rompe y hay que
-- reconciliarlo ANTES de desplegar; no hay forma de que Postgres lo avise solo.
ALTER TABLE provider_accounts ADD COLUMN IF NOT EXISTS paused_until timestamptz;
ALTER TABLE provider_accounts ADD COLUMN IF NOT EXISTS paused_reason text;

-- ------------------------------------------------------------------------------------------
-- 1. La corrida del recolector.
CREATE TABLE IF NOT EXISTS quota_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Host donde corrieron los CLIs. Es parte de la clave natural porque dos hosts pueden estar
  -- logueados con suscripciones DISTINTAS bajo el mismo nombre de proveedor.
  host text NOT NULL CHECK (host ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  -- Identidad autenticada que publicó, derivada del certificado y nunca del cuerpo. Queda
  -- registrada porque estas filas pueden pausar suscripciones pagas: hay que poder responder
  -- quién publicó la muestra que cortó el despacho.
  collector_tenant text NOT NULL REFERENCES tenants(id),
  collector_alias text NOT NULL CHECK (collector_alias ~ '^[a-z][a-z0-9_-]{0,63}$'),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL CHECK (schema_version BETWEEN 1 AND 999),
  app_version text CHECK (app_version IS NULL OR length(app_version) BETWEEN 1 AND 64),
  provider_count integer NOT NULL DEFAULT 0 CHECK (provider_count BETWEEN 0 AND 32),
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count BETWEEN 0 AND 512),
  -- Idempotencia del recolector: un reintento de red reenvía LA MISMA corrida y no debe duplicar
  -- la serie. El POST responde 202 con duplicate=true y no escribe nada.
  -- El tenant entra en la clave a proposito. `host` es una cadena que declara el RECOLECTOR, y
  -- dos tenants que casualmente (o deliberadamente) declaren el mismo host compartirian fila: uno
  -- pisaria las muestras del otro y, peor, heredaria su vinculo con las cuentas. El aislamiento no
  -- puede depender de que nadie repita un nombre de host.
  UNIQUE (collector_tenant, host, captured_at),
  -- captured_at lo pone el recolector, o sea un reloj que no controlamos. Una corrida "del
  -- futuro" desordena el histórico en silencio y envenena cualquier cálculo de velocidad de
  -- consumo; que falle el INSERT es infinitamente preferible.
  CONSTRAINT quota_collections_not_from_the_future
    CHECK (captured_at <= received_at + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS quota_collections_recent_idx ON quota_collections (received_at DESC);

-- ------------------------------------------------------------------------------------------
-- 2. Estado por proveedor dentro de una corrida.
CREATE TABLE IF NOT EXISTS quota_provider_reports (
  collection_id uuid NOT NULL REFERENCES quota_collections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  -- ok=false con cero ventanas es información, no ausencia de información.
  ok boolean NOT NULL,
  available boolean NOT NULL DEFAULT false,
  kind text CHECK (kind IS NULL OR length(kind) BETWEEN 1 AND 64),
  source text CHECK (source IS NULL OR length(source) BETWEEN 1 AND 64),
  plan text CHECK (plan IS NULL OR length(plan) BETWEEN 1 AND 64),
  note text CHECK (note IS NULL OR length(note) <= 512),
  -- El propio proveedor ya calcula cuál es su ventana limitante teniendo en cuenta el ruteo
  -- entre grupos (codex: 'codex' agotado pero 'codex_bengalfox' libre => 100 efectivo). Se
  -- guarda tal cual: recalcularlo acá sería reimplementar la herramienta y divergir de ella.
  effective_remaining_percent numeric(5,2)
    CHECK (effective_remaining_percent IS NULL OR effective_remaining_percent BETWEEN 0 AND 100),
  observed_at timestamptz,
  available_groups jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(available_groups) = 'array'),
  limiting_groups jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(limiting_groups) = 'array'),
  PRIMARY KEY (collection_id, provider)
);

-- ------------------------------------------------------------------------------------------
-- 3. El histórico append-only. Es lo que contesta "¿a qué velocidad estamos quemando la
--    semana?", que es la pregunta del incidente: cuando alguien vio el 100% ya era tarde. Un
--    único último valor no puede contestarla por definición.
CREATE TABLE IF NOT EXISTS quota_window_samples (
  collection_id uuid NOT NULL REFERENCES quota_collections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  -- La CUENTA/GRUPO dentro del proveedor. Normalización obligatoria del recolector:
  -- group_key = window.limitId ?? 'default'. Es lo que separa 'codex' de 'codex_bengalfox'.
  group_key text NOT NULL CHECK (group_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  -- La VENTANA dentro del grupo: window_key = window.key ('session', 'week_all', 'week_fable',
  -- 'codex_primary_10080', 'gemini-3.1-pro-preview', '5h', 'month'...).
  window_key text NOT NULL CHECK (window_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  -- host y captured_at están desnormalizados desde el header para que leer una serie (sparkline)
  -- no tenga que unir con quota_collections en cada punto. El FK con CASCADE mantiene la
  -- coherencia y la retención sigue siendo un solo DELETE sobre el header.
  host text NOT NULL,
  captured_at timestamptz NOT NULL,
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 64),
  -- Se guardan LOS DOS porcentajes en vez de derivar uno del otro: la herramienta es la
  -- autoridad, y un proveedor que informa sólo uno no debe quedar con el complemento inventado.
  used_percent numeric(5,2) CHECK (used_percent IS NULL OR used_percent BETWEEN 0 AND 100),
  remaining_percent numeric(5,2) CHECK (remaining_percent IS NULL OR remaining_percent BETWEEN 0 AND 100),
  -- Absolutos cuando existen (opencode informa used/limit reales: 0 de 12 en 5h).
  used_units bigint CHECK (used_units IS NULL OR used_units >= 0),
  limit_units bigint CHECK (limit_units IS NULL OR limit_units > 0),
  window_minutes integer CHECK (window_minutes IS NULL OR window_minutes > 0),
  -- Se guarda el instante absoluto, no resetInSeconds: un delta relativo deja de ser cierto
  -- apenas se persiste, y el histórico lo releería mal para siempre.
  reset_at timestamptz,
  status text CHECK (status IS NULL OR status ~ '^[a-z][a-z0-9_-]{0,31}$'),
  family text CHECK (family IS NULL OR length(family) BETWEEN 1 AND 64),
  model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),
  -- La cuenta registrada que esta ventana consume, cuando el recolector supo atarla. NULL no es
  -- un error: es un grupo todavía no registrado en provider_accounts, y el panel lo muestra como
  -- "sin atar" en vez de descartar la muestra. Descartar sería volver ciego justo al caso nuevo.
  account_id text REFERENCES provider_accounts(id),
  binding_note text CHECK (binding_note IS NULL OR length(binding_note) <= 128),
  PRIMARY KEY (collection_id, provider, group_key, window_key),
  -- Al menos un número: una fila sin ningún dato de consumo no informa nada y sólo infla la serie.
  CONSTRAINT quota_window_samples_has_a_number
    CHECK (num_nonnulls(used_percent, remaining_percent, used_units) > 0)
);
-- El índice de la sparkline: exactamente el orden en que se lee una serie.
CREATE INDEX IF NOT EXISTS quota_window_samples_series_idx
  ON quota_window_samples (host, provider, group_key, window_key, captured_at DESC);
CREATE INDEX IF NOT EXISTS quota_window_samples_account_idx
  ON quota_window_samples (account_id, captured_at DESC) WHERE account_id IS NOT NULL;

-- ------------------------------------------------------------------------------------------
-- 4. Estado actual materializado. Sin esta tabla el camino de lectura sería un DISTINCT ON
--    sobre el histórico, o sea un costo que crece con la retención para responder siempre lo
--    mismo: ~30 filas.
CREATE TABLE IF NOT EXISTS quota_window_state (
  collector_tenant text NOT NULL REFERENCES tenants(id),
  host text NOT NULL,
  provider text NOT NULL,
  group_key text NOT NULL,
  window_key text NOT NULL,
  -- ON DELETE SET NULL y NO CASCADE: podar el histórico no debe borrar el estado actual. Con
  -- CASCADE, la retención vaciaría el panel cada 30 días.
  collection_id uuid REFERENCES quota_collections(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  label text,
  used_percent numeric(5,2) CHECK (used_percent IS NULL OR used_percent BETWEEN 0 AND 100),
  remaining_percent numeric(5,2) CHECK (remaining_percent IS NULL OR remaining_percent BETWEEN 0 AND 100),
  used_units bigint,
  limit_units bigint,
  window_minutes integer,
  reset_at timestamptz,
  status text,
  family text,
  model text,
  account_id text REFERENCES provider_accounts(id),
  binding_note text,
  -- Misma razon que en quota_collections: el estado por ventana se aisla por tenant, no por el
  -- nombre de host que el recolector diga tener.
  PRIMARY KEY (collector_tenant, host, provider, group_key, window_key)
);
CREATE INDEX IF NOT EXISTS quota_window_state_account_idx
  ON quota_window_state (account_id) WHERE account_id IS NOT NULL;

-- ------------------------------------------------------------------------------------------
-- 5. Índices de apoyo para GET /v3/console/activity. La consulta hoy no tiene un índice que le
--    sirva: deliveries_claim_idx es parcial sobre ('pending','retry') y deliveries_inflight_idx
--    está ordenado por ack_deadline_at, no por destinatario.
--    OJO AL DESPLEGAR: applyMigrations() corre TODAS las migraciones en UNA transacción con un
--    advisory lock, así que CREATE INDEX CONCURRENTLY es imposible acá y este CREATE INDEX toma
--    ACCESS EXCLUSIVE sobre deliveries mientras se construye. Con el volumen actual son
--    milisegundos; si deliveries creció, construirlo CONCURRENTLY a mano ANTES de aplicar la
--    migración deja este statement como no-op gracias al IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS deliveries_open_by_recipient_idx
  ON deliveries (recipient_tenant, recipient_alias, status, claimed_at)
  WHERE status IN ('pending','retry','leased','accepted','started');
CREATE INDEX IF NOT EXISTS delivery_acks_applied_recent_idx
  ON delivery_acks (created_at DESC, delivery_id) WHERE applied;

-- ------------------------------------------------------------------------------------------
-- CONTRATO DEL CAMINO DE INGESTA (no es DDL; va en repository.ts dentro de UNA transacción,
-- documentado acá porque es la parte que puede pausar suscripciones pagas).
--
-- a) INSERT en quota_collections. Colisión con UNIQUE (host, captured_at) => 202 duplicate=true,
--    se aborta el resto sin escribir. El recolector puede reintentar sin miedo.
-- b) INSERT de quota_provider_reports y quota_window_samples.
-- c) UPSERT de quota_window_state, con guarda anti-retroceso: una corrida vieja que llega tarde
--    NO debe pisar un estado más nuevo.
--      INSERT INTO quota_window_state(...) VALUES (...)
--      ON CONFLICT (host,provider,group_key,window_key) DO UPDATE SET ...
--       WHERE quota_window_state.captured_at < EXCLUDED.captured_at;
-- d) AUTO-PAUSA. Sólo sobre cuentas ATADAS (account_id NOT NULL): un grupo sin atar no puede
--    pausar nada, que es justo lo que impide que un error de mapeo corte el despacho de otro.
--    Se pausa HASTA el reset informado por el proveedor, nunca indefinidamente: una pausa sin
--    horizonte necesita un humano para levantarla y es peor que el problema que resuelve.
--      UPDATE provider_accounts p
--         SET paused_until  = GREATEST(COALESCE(p.paused_until, now()), s.reset_at),
--             paused_reason = 'quota_exhausted:'||s.provider||'/'||s.group_key||'/'||s.window_key,
--             updated_at    = now()
--        FROM quota_window_state s
--       WHERE s.account_id = p.id AND s.collection_id = $1
--         AND (s.remaining_percent <= 0 OR s.status = 'rate-limited')
--         AND s.reset_at IS NOT NULL;
-- e) AUTO-REANUDACIÓN, con el WHERE que importa: sólo se levanta lo que se pausó
--    automáticamente. Que el recolector pise una pausa puesta a mano por un operador es
--    precisamente el bug que este LIKE evita.
--      UPDATE provider_accounts p
--         SET paused_until = NULL, paused_reason = NULL, updated_at = now()
--       WHERE p.paused_reason LIKE 'quota_exhausted:%'
--         AND NOT EXISTS (SELECT 1 FROM quota_window_state s
--                          WHERE s.account_id = p.id
--                            AND (s.remaining_percent <= 0 OR s.status = 'rate-limited'));
-- f) RETENCIÓN, 30 días, acotada para que un solo POST nunca dispare un DELETE ilimitado. El
--    CASCADE desde el header limpia reports y samples de un saque; quota_window_state sobrevive
--    por el SET NULL.
--      DELETE FROM quota_collections WHERE ctid IN (
--        SELECT ctid FROM quota_collections
--         WHERE received_at < now() - interval '30 days' ORDER BY received_at LIMIT 500);
--    Costo medido con los datos reales de hoy: 15 ventanas/corrida x 288 corridas/día
--    (cada 5 min) = ~4.3k filas/día, ~130k filas en 30 días, del orden de 15 MB con índices.
--    Es barato al lado de no poder contestar por qué se agotó una semanal.
