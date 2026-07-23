# Cauce V3

Monorepo canónico de mensajería multi-tenant durable. Es aislado de V2: no reemplaza, modifica ni reinicia servicios vivos.

## Componentes

- `packages/protocol`: schemas Zod V3 (`3.0`) y payload público sin identidad.
- `packages/store`: schema SQL definitivo, migrator transaccional y repositorio PostgreSQL.
- `packages/adapter-sdk`: SDK durable y ejecutables Hermes/OpenCode/Claude/Codex/fake; traduce el delivery/ACK canónico sin protocolo paralelo.
- `services/gateway`: HTTP/WS, auth boundary, fencing, facades `/v3/console/*`.
- `services/dispatcher`: retries/DLQ, job handlers registrados y fairness transaccional `interactive`/`batch`.
- `services/relay-worker`: leases outbox cercados, HTTPS allowlist/pinning, retries y DLQ de return-route.
- `services/telegram-bridge`: polling/egress Telegram cercado, cursor durable, allowlists y protección anti doble respuesta.
- `services/shadow-router`: inbox/mappings V2↔V3 idempotentes por Unix socket; shadow/compare sin side effects y cutover con interlock.
- `apps/console`: React/Vite, same-origin, mocks solo para unit tests.
- `deploy/compose.yaml`: runtime productivo TLS con migrator, gateway, dispatcher, consola y profiles opt-in de relay, Telegram y shadow.
- `ops`: QA real/contract, artefactos JSON/JUnit/SHA, runbooks y fault injection guardado.

## Invariantes

- PostgreSQL es la única fuente durable: mensajes no terminales nunca se eliminan.
- Un consumer por `(tenant, alias)`; heartbeat, epoch y delivery claim quedan cercados.
- ACK monotónico `accepted → started → done|failed`; cada evento exige `event_id+attempt+claim_token`, y un `event_id` repetido nunca aplica otra transición.
- Cada claim tiene deadline fijo; producción usa `CAUCE_ACK_DEADLINE_MS=600000` y exige `ACK_TIMEOUT_MS >= CAUCE_ACK_DEADLINE_MS`. Heartbeats y ACK `started` no lo extienden.
- Actor, tenant, session, channel y origin se derivan del `AuthProvider`; el body público es `strict` y rechaza esos campos.
- ACL default-deny: interno al tenant y cruces explícitos tenant↔Steven; tenant↔tenant está impedido también por constraint SQL.
- `CAUCE_DEV_AUTH=1` es explícito y solo funciona fuera de producción. Sin proveedor productivo el gateway no arranca (fail-closed).
- Configuración mutable usa revisión optimista, transacción, preview/dry-run, audit e inversa rollback; ACL y roles nuevos nacen default-deny.

## Requisitos y verificación

Node 22+, pnpm 11+ y Docker/Testcontainers para integración/E2E:

```sh
pnpm install --frozen-lockfile
pnpm prepare
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:services
pnpm test:integration
pnpm test:e2e
pnpm build
```

`pnpm test:e2e` levanta PostgreSQL real con migraciones `001..006`, gateway y dispatcher; ejecuta `ops/harness/runner.mjs` contra HTTP/WS reales y escribe `ops/artifacts/real/{report.json,junit.xml,SHA256SUMS}` sin casos falsamente skipped. También prueba dos adapters fake como procesos, reinicia gateway y PostgreSQL reales y deja evidencia separada en `ops/artifacts/restarts`. `pnpm qa:contract` usa exclusivamente el doble y declara `mode=mock`. El gate exige cero skips en evidencia real/restarts.

## API pública autenticada

- `GET /health/live`, `GET /health/ready`
- `GET /v3/status`
- `POST /v3/messages` o `/v3/publish`: `{room_id,recipients,body,idempotency_key,lane,priority}`
- `GET /v3/messages/:messageId`
- `POST /v3/connections/hello`, `/v3/query`, `/v3/heartbeat`, `/v3/ack`
- `GET /v3/ws`: primer frame `hello` V3; la identidad declarada debe coincidir con el principal autenticado.
- `/v3/console/{access,topology,messages,queues,jobs,adapters,audit,origin-relays,observability}` y replay controlado de DLQ.
- `GET /v3/console/config`, `POST /config/changes` y `POST /config/revisions/:id/rollback` para CRUD versionado de tenants, rooms, memberships, ACL, harnesses y policies.

La consola nunca envía actor/session/channel/origin. En desarrollo puede compilarse con `VITE_CAUCE_DEV_AUTH=1` y una identidad no secreta; ese modo no es producción.

## Deploy aislado

Crear un env privado fuera del repositorio con `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `NODE_ENV` y el provider elegido. Demo: `CAUCE_DEV_AUTH=1` fuera de producción. Producción: `CAUCE_AUTH_PROVIDER=oidc|mtls|token-file`; OIDC usa issuer/audience/JWKS HTTPS, mTLS usa CA cliente + mapa de fingerprints, y el piloto token-file usa una ruta a JSON que contiene **solo hashes SHA-256 y principals**, nunca tokens. Producción exige paths de cert/key TLS del gateway y PostgreSQL `sslmode=verify-full` con `PGSSLROOTCERT`.

```sh
docker compose --env-file /ruta/privada/cauce.env -f deploy/compose.yaml up --build -d --wait
```

No hay credenciales hardcodeadas. Cookie de consola esperada: `__Host-cauce_session`, `Secure`, `HttpOnly`, `SameSite=Strict`, emitida por el autenticador/ingress; Cauce valida same-origin/Origin para CSRF. Los healthchecks consultan PostgreSQL y endpoints de readiness; todos los procesos manejan `SIGTERM`. `origin-relay`, `telegram` y `shadow` son profiles separados y fail-closed; Telegram usa un directorio externo read-only de config/token/markers, y shadow usa directorios Unix privados sin leer V2.

## Diseño y operación

- ADRs: `docs/adr/`
- Threat model: `docs/threat-model.md`
- Shadow V2→V3: `docs/migration-plan.md`
- Runbooks: `ops/runbooks/`
