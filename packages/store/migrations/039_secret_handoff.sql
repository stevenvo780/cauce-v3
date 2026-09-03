-- Traspaso sellado de credenciales agente→agente (D6 del programa v3.1).
--
-- Lo que esta migración NO guarda es lo importante: aquí nunca entra un secreto en claro. El
-- emisor sella en su propio proceso con X25519 + AES-256-GCM (`@cauce/protocol/sealing`) y el
-- gateway sólo almacena bytes que no puede abrir: no tiene la mitad privada de nadie. Un volcado
-- de esta tabla, un backup filtrado o un operador con acceso a la base ven ciphertext y metadatos
-- de ruteo, jamás el valor. Por eso tampoco hay columna `value`, `plaintext` ni `hint`: si no
-- existe la columna, no hay dónde equivocarse.
--
-- Aditiva por construcción: dos tablas nuevas, ninguna fila reescrita, ningún objeto existente
-- tocado. Con las tablas vacías el sistema se comporta exactamente como antes.

-- 783_003_003 serializa contra el runner de migraciones; 783_003_039 es la sección crítica de
-- este juego de tablas. Ambos son de transacción: se sueltan solos al COMMIT o al ROLLBACK.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_039);

-- La mitad PÚBLICA que cada alias publica para que le puedan sellar. Nunca la privada: esa vive
-- en el contenedor del alias y no tiene camino hasta aquí.
--
-- La clave primaria incluye `key_id` porque la rotación es make-before-break: el alias publica la
-- clave nueva, y sólo cuando ya está publicada deja de usar la vieja. Sobrescribir la fila haría
-- ilegible todo lo sellado en vuelo.
CREATE TABLE IF NOT EXISTS agent_sealing_keys (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  key_id text NOT NULL,
  -- Una sola suite, nombrada. Un `algorithm` libre invitaría a negociar cifrado por fila, que es
  -- exactamente la superficie que este diseño no quiere tener.
  algorithm text NOT NULL CONSTRAINT agent_sealing_keys_algorithm CHECK (algorithm = 'x25519'),
  -- Los 32 bytes crudos de la clave X25519, no su SPKI ni su base64: el largo es parte del tipo.
  public_key bytea NOT NULL
    CONSTRAINT agent_sealing_keys_public_key CHECK (octet_length(public_key) = 32),
  not_after timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias, key_id),
  -- Dar de baja un alias retira sus claves con él: una clave de sellado sin dueño no significa
  -- nada y sólo serviría para que el próximo que reutilice el nombre herede material ajeno.
  CONSTRAINT agent_sealing_keys_agent_fk
    FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE
);

-- Un traspaso concreto. Vive como mucho 24 h, se lee UNA vez y se barre poco después de
-- resolverse: lo que queda en disco es lo que el techo del alta cuenta.
CREATE TABLE IF NOT EXISTS secret_handoffs (
  id uuid PRIMARY KEY,
  from_tenant text NOT NULL,
  from_alias text NOT NULL,
  to_tenant text NOT NULL,
  to_alias text NOT NULL,
  -- El NOMBRE del secreto, no su valor: «ANTHROPIC_API_KEY», no la clave. Es lo único legible de
  -- la fila y lo único que puede aparecer en una auditoría.
  label text NOT NULL
    CONSTRAINT secret_handoffs_label CHECK (label <> '' AND length(label) <= 120),
  sealed bytea NOT NULL,
  sealing_key_id text NOT NULL,
  ephemeral_public bytea NOT NULL
    CONSTRAINT secret_handoffs_ephemeral_public CHECK (octet_length(ephemeral_public) = 32),
  nonce bytea NOT NULL CONSTRAINT secret_handoffs_nonce CHECK (octet_length(nonce) = 12),
  expires_at timestamptz NOT NULL,
  read_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- La caducidad es un techo de la BASE, no una cortesía de la aplicación: un traspaso que nadie
  -- recoge deja de ser recogible pase lo que pase con el código que lo creó.
  CONSTRAINT secret_handoffs_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '24 hours'
  ),
  CONSTRAINT secret_handoffs_from_fk
    FOREIGN KEY (from_tenant, from_alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE,
  CONSTRAINT secret_handoffs_to_fk
    FOREIGN KEY (to_tenant, to_alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE
);

-- La lista de pendientes de un destinatario, sin recorrer su historial entero. `expires_at` va
-- DENTRO del índice, detrás de la clave de orden: la caducidad es un filtro de las dos consultas
-- del buzón y sin ella cada fila caducada que el índice sigue conteniendo se lee del montón sólo
-- para descartarla. Con ella el filtro se resuelve en el índice y la basura no se paga.
CREATE INDEX IF NOT EXISTS secret_handoffs_pending_idx
  ON secret_handoffs (to_tenant, to_alias, created_at, expires_at)
  WHERE read_at IS NULL AND revoked_at IS NULL;

-- El techo del alta cuenta lo CREADO para un destinatario en las últimas 24 h, esté vivo o no:
-- contar sólo lo vivo dejaba que un emisor eligiera una caducidad de milisegundos y escribiera
-- filas que el recuento no volvía a ver y el disco sí. Ese recuento no lo puede servir un índice
-- parcial por vivacidad, así que lleva el suyo, completo.
CREATE INDEX IF NOT EXISTS secret_handoffs_recipient_window_idx
  ON secret_handoffs (to_tenant, to_alias, created_at);

-- La barrida de retención al escribir recorre por antigüedad y se lleva lo ya RESUELTO (leído,
-- revocado o caducado) desde hace más que la gracia corta. Sin este índice esa barrida sería un
-- recorrido secuencial en cada concesión; con él es un prefijo del índice y un LIMIT.
CREATE INDEX IF NOT EXISTS secret_handoffs_created_idx ON secret_handoffs (created_at);

-- Tirantes y cinturón sobre la marca de lectura única. Es REDUNDANTE hoy contra la clave
-- primaria y se sabe: `id` ya es único, así que este índice no puede rechazar nada que la clave
-- primaria acepte. Existe para que cualquier cambio futuro que ensanche la identidad de un
-- traspaso (una reemisión, un intento) falle ruidosamente aquí en vez de permitir en silencio dos
-- lecturas de un mismo secreto.
--
-- La garantía REAL de lectura única no es este índice: es el UPDATE condicional
--   UPDATE secret_handoffs SET read_at=now()
--    WHERE id=$1 AND read_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING ...
-- ejecutado en UNA transacción. Bajo READ COMMITTED el segundo lector se bloquea en la fila,
-- reevalúa el WHERE con `read_at` ya escrito y devuelve cero filas. Comprobar antes y escribir
-- después dejaría la ventana que este UPDATE no tiene.
CREATE UNIQUE INDEX IF NOT EXISTS secret_handoffs_read_once_idx
  ON secret_handoffs (id) WHERE read_at IS NOT NULL;
