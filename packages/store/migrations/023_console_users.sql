-- Usuarios humanos de la consola: login con correo + contraseña y sesión JWT.
--
-- POR QUÉ EXISTE ESTA TABLA (medido el 2026-08-06 sobre el despliegue real):
-- el único control de acceso humano a `consola.elenxos.com` es el `basic_auth` de Caddy —una
-- contraseña compartida, sin identidad, sin cierre de sesión y sin vencimiento— y tanto Caddy
-- como nginx inyectan `X-Cauce-Operator: steven` FIJO. Consecuencia medible: `audit_events`
-- dice `steven` entre quien entre, y sacarle el acceso a una persona obliga a cambiarle la
-- contraseña a todas. Esta tabla es la que le pone nombre propio a cada fila de auditoría.
--
-- NO ES UNA TABLA DE AGENTES. Los agentes siguen entrando por mTLS con su certificado de
-- cliente y no tocan nada de acá: el login humano se SUMA, no reemplaza. Por eso el usuario
-- lleva `tenant_id`/`alias`: es la identidad de Cauce que la persona asume al operar, y toda su
-- autorización real la sigue acotando `memberships`/`role_policies` (el gateway intersecta los
-- permisos del usuario con los que la base le concede a ese tenant/alias, así que un rol mal
-- puesto acá no puede escalar por encima de lo que la base ya permitía).
--
-- QUÉ NO GUARDA: contraseñas. `password_hash` es un derivado scrypt (RFC 7914, la
-- implementación de OpenSSL que trae Node) en formato PHC `$scrypt$n=...,r=...,p=...$sal$hash`.
-- El CHECK de abajo no valida criptografía —no puede— pero sí impide que una fila con la
-- contraseña en claro entre por un `INSERT` a mano: cualquier valor que no empiece por
-- `$scrypt$` es rechazado por la base. Es la última red antes de un error humano.
--
-- `password_changed_at` es la revocación barata: los JWT emitidos ANTES de esa marca dejan de
-- valer sin necesidad de una tabla de sesiones ni de una lista de revocación. Cambiar la
-- contraseña cierra todas las sesiones abiertas. `active=false` las cierra también, porque el
-- gateway relee la fila en CADA request y no se cree lo que dice el token.

CREATE TABLE IF NOT EXISTS console_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Se guarda tal cual lo escribió la persona, y aparte la forma normalizada que es la que
  -- lleva el índice único: si no, `Steven@X` y `steven@x` serían dos cuentas distintas para la
  -- misma persona y el login sería una lotería de mayúsculas.
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
  -- Dos roles y nada más. `operator` opera (publica, cancela, abre terminales); `reader` sólo
  -- mira. Todo lo demás (quién llega a qué agente) ya lo decide `memberships`, y duplicar esa
  -- decisión acá sería tener dos verdades que se pueden contradecir.
  CONSTRAINT console_users_role_check CHECK (role IN ('operator','reader')),
  CONSTRAINT console_users_alias_shape CHECK (alias ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT console_users_display_name_len CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT console_users_password_hash_shape CHECK (password_hash LIKE '$scrypt$%'),
  CONSTRAINT console_users_password_hash_len CHECK (char_length(password_hash) BETWEEN 40 AND 512)
);

CREATE UNIQUE INDEX IF NOT EXISTS console_users_email_normalized_key
  ON console_users (email_normalized);

-- El login busca por correo normalizado y sólo entre las cuentas vivas; la revalidación de
-- sesión busca por id. Las dos rutas quedan cubiertas por la única y por la PK.
CREATE INDEX IF NOT EXISTS console_users_active_idx
  ON console_users (email_normalized) WHERE active;
