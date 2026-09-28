-- El almacén de blobs: los bytes de un fichero grande viven en disco, direccionados por sha256, y
-- aquí queda sólo lo que un mensaje necesita saber de ellos.
--
-- POR QUÉ. Un adjunto viaja inline en base64 dentro de `messages.body` hasta 10 MB; un fichero de
-- 1 GB no cabe en un jsonb, ni en la memoria de cada salto, ni en un frame de WebSocket. Por
-- referencia, el mensaje lleva el digest y el gateway sirve los bytes en streaming. Esta tabla es
-- el índice de ese disco: quién subió qué, cuánto pesa, y cuándo se usó por última vez, que es lo
-- único que necesita una purga honesta.
--
-- Sin FOREIGN KEY a `agents`: el blob sobrevive a la baja del alias que lo subió, igual que el
-- mensaje que lo referencia. `last_used_at` avanza con cada lectura; un blob que nadie lee en N
-- días es candidato a purga, decisión que toma un script, nunca esta tabla.
--
-- 783_003_003 serializa contra el runner de migraciones; 783_003_042 es la sección crítica de
-- este juego. Ambos son de transacción: se sueltan solos al COMMIT o al ROLLBACK.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_042);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes > 0),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 127),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  tenant_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- La purga pregunta «¿qué no se usa desde X?»: el índice es sobre la fecha, no sobre el digest.
CREATE INDEX IF NOT EXISTS blobs_last_used_at_idx ON blobs (last_used_at);
