# Gateway hardening configuration

Production fails closed unless a production `AuthProvider` is configured. `CAUCE_AUTH_PROVIDER=oidc`
enables the console BFF. In addition to issuer/audience/JWKS, it requires:

- `CAUCE_OIDC_ISSUER`: exact token issuer.
- `CAUCE_OIDC_AUDIENCE`: required audience.
- `CAUCE_OIDC_JWKS_URL`: HTTPS JWKS endpoint.
- `CAUCE_OIDC_AUTHORIZATION_URL`, `CAUCE_OIDC_TOKEN_URL`: HTTPS OIDC endpoints.
- `CAUCE_OIDC_CLIENT_ID`, `CAUCE_OIDC_REDIRECT_URI`: code-flow client and exact HTTPS callback.
- `CAUCE_OIDC_SESSION_KEY_FILE`: file containing 32 random bytes (or their hex/base64 encoding).
- Optional `CAUCE_OIDC_CLIENT_SECRET_FILE`, never a secret value in an environment variable.

The BFF uses Authorization Code + S256 PKCE and verifies both ID and access tokens against JWKS.
OAuth access/refresh tokens stay in the server-side session; the browser receives only an opaque
`__Host-cauce_session` cookie (`HttpOnly; Secure; SameSite=Strict`) and an in-memory CSRF value.
Login state is single-use and browser-bound by a short-lived `__Host-cauce_login` Lax cookie so the
OIDC top-level redirect can complete. Callback always generates a new session identifier.

Migration `006_oidc_sessions_and_telegram_effect_safety.sql` owns the default durable table
(override the safe unqualified table name with `CAUCE_OIDC_SESSION_TABLE`). Payloads are
AES-256-GCM encrypted and keys are SHA-256 digests; startup fails if the table is missing:

```sql
CREATE TABLE gateway_oidc_sessions (
  kind text NOT NULL CHECK (kind IN ('login', 'session')),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  encrypted_payload bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, key_hash)
);
CREATE INDEX gateway_oidc_sessions_expiry_idx ON gateway_oidc_sessions (expires_at);
```

Verified tokens must contain `sub`, `exp`, `tenant_id`, `alias`, `sid`, `channel`,
`roles`, and `permissions`. Optional `origin` must match the protocol origin schema.
Valid roles are `agent`, `operator`, and `adapter`; permissions are independently
granted as `route`, `read`, and `control`.
Los claims son un límite superior: memberships/role policies de PostgreSQL se vuelven
a consultar durante publish, consola y cada operación de lease/heartbeat/query/ACK,
por lo que una revocación runtime corta la autorización sin confiar solo en el token.

`CAUCE_DEV_AUTH=1` enables identity headers only when `NODE_ENV` is not
`production`. Never expose this mode on a shared network. Production always requires
delivery/outbox ACK claims; attempting to disable them fails startup.

`CAUCE_ACK_DEADLINE_MS` is the positive deadline assigned when either HTTP or
WebSocket claims a delivery. The source fallback is 30000 ms for compatibility,
while the production compose declares 600000 ms explicitly for slow LLM work.
Dispatcher `ACK_TIMEOUT_MS` must be equal to or greater than the same
`CAUCE_ACK_DEADLINE_MS`; incoherent or non-integer values fail startup.

Este documento afirmaba hasta hoy que el plazo "no lo extienden los `started`
repetidos". Es FALSO y era el bug: cada `started` aplicado lo empuja
`CAUCE_ACK_DEADLINE_MS` hacia adelante, sin límite. Un harness colgado que sigue
latiendo se renueva para siempre y es invisible al reaper, que sólo mira plazos
vencidos. Medido el 2026-07-27: una entrega de janus se sostuvo 17,36 h
emitiendo ~60 ACKs/hora y aportó el 32,7% de todos los `delivery_acks` del día.

## Techo de vida total de una entrega

`CAUCE_DELIVERY_LEASE_CAP_MS` (default 43200000, o sea 12 h) es el tiempo máximo
que UN intento puede sostener su garra, contado desde `execution_started_at` —o
desde `claimed_at` si el adaptador no informa el arranque— e INDEPENDIENTE de
cuántas veces se renueve. Al superarlo la entrega termina en `dead` con motivo
`Lease cap exhausted: ...`, queda en `dead_letters` para replay manual y emite un
`audit_events` con `action='delivery.lease_cap'`. El motivo es deliberadamente
distinto del de `ACK timeout`: "dejó de responder" y "no deja de responder" son
diagnósticos opuestos.

Qué trabajo legítimo muere con el default: una entrega que no declara
`body.timeout_ms` y de verdad mantiene el harness corriendo más de 12 h de reloj
de pared en un solo intento. Las dos salidas, en orden de preferencia:

1. `body.timeout_ms` por mensaje (entero, 1 a 604800000 ms = 7 días, validado en
   la puerta). El techo de esa entrega pasa a ser `timeout_ms` +
   `CAUCE_DELIVERY_LEASE_CAP_GRACE_MS` (default 1800000, un plazo de ACK), y
   sirve en las dos direcciones: subirlo por encima de las 12 h, o bajarlo para
   pedir supervisión estrecha de una tarea que se sabe corta.
2. Subir `CAUCE_DELIVERY_LEASE_CAP_MS` para toda la flota.

Gateway y dispatcher leen las MISMAS variables y hay que desplegarlos con el
mismo bloque de entorno: el gateway congela el plazo en el techo (por eso el
harness deja de poder renovar) y el dispatcher recoge lo que lo superó. El techo
no puede ser menor que `CAUCE_ACK_DEADLINE_MS`; si lo es, el arranque falla.

## Retención de la observabilidad

Cada renovación de garra escribía dos filas —una en `delivery_acks`, otra en
`audit_events`— sin ninguna política de borrado: 24 MB + 24 MB sobre una base de
93 MB creada 6 días antes. El dispatcher poda cada
`CAUCE_RETENTION_INTERVAL_MS` (default 300000; `0` APAGA el barrido, y es la
palanca de emergencia), en lotes de `CAUCE_RETENTION_BATCH` filas (default 5000)
por tabla y por regla, sin lock de tabla.

Se retiene por TIPO, no sólo por edad, porque un latido no tiene valor forense
pasadas unas horas y una transición de estado sí:

| variable | default | qué borra |
| --- | --- | --- |
| `CAUCE_RETENTION_ACK_RENEWAL_MS` | 6 h | `delivery_acks` con `renewal=true` |
| `CAUCE_RETENTION_ACK_MS` | 14 d | el resto de `delivery_acks` |
| `CAUCE_RETENTION_AUDIT_RENEWAL_MS` | 6 h | `audit_events` con `metadata->>'lease_renewed'='true'` |
| `CAUCE_RETENTION_AUDIT_MS` | 30 d | el resto de `audit_events` |

`audit_events` tiene ventana más larga que `delivery_acks` a propósito: un ACK es
telemetría de transporte, un audit_event contesta "quién autorizó qué", que es la
pregunta que aparece semanas después. Una ventana de renovaciones más larga que
su ventana general hace fallar el arranque.

`CAUCE_CONSOLE_ORIGINS` is an optional comma-separated list of exact console
origins. Without it, console requests must be same-origin with the gateway Host.
Unsafe console requests require a matching `Origin`; cross-site browser requests
are rejected before authentication.

`CAUCE_AUTH_PROVIDER=token-file` and `mtls` remain supported. The mTLS data listener always uses
`requestCert: true` and `rejectUnauthorized: true`; it maps only Node-verified peer certificates
and ignores forwarded certificate headers. In mTLS mode `/health/*` is removed from that listener.
A health-only HTTP listener binds exclusively to `127.0.0.1` on `CAUCE_HEALTH_PORT` (default 8081)
for mTLS and every production provider, so a local orchestrator probe can reach
liveness/readiness without making any data route public.

Producción requiere HTTPS para el gateway y PostgreSQL `sslmode=verify-full` con
`PGSSLROOTCERT` absoluto. Readiness confirma además `pg_stat_ssl.ssl=true`.

No signing keys, bearer tokens, client private keys, or database credentials belong
in these files. Supply secrets through the deployment's encapsulated secret system.
