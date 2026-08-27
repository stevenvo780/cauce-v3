-- Usuarios humanos de la consola: login con correo + contraseña (scrypt) y sesión JWT.
-- Complementa la autenticación mTLS de agentes con identidad individual para auditoría.

CREATE TABLE IF NOT EXISTS console_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Correo original y normalizado a minúsculas para unicidad.
  email text NOT NULL,
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  password_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT console_users_email_len CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT console_users_email_shape CHECK (email LIKE '%_@_%'),
  CONSTRAINT console_users_email_normalized_matches
    CHECK (email_normalized = lower(email)),
  -- Roles permitidos: operator o reader.
  CONSTRAINT console_users_role_check CHECK (role IN ('operator','reader')),
  CONSTRAINT console_users_alias_shape CHECK (alias ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT console_users_display_name_len CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT console_users_password_hash_shape CHECK (password_hash LIKE '$scrypt$%'),
  CONSTRAINT console_users_password_hash_len CHECK (char_length(password_hash) BETWEEN 40 AND 512)
);

CREATE UNIQUE INDEX IF NOT EXISTS console_users_email_normalized_key
  ON console_users (email_normalized);

-- Índice de búsqueda para usuarios activos por correo normalizado.
CREATE INDEX IF NOT EXISTS console_users_active_idx
  ON console_users (email_normalized) WHERE active;
