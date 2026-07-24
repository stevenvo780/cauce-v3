# Cauce V3 — operaciones y QA

Este árbol opera exclusivamente V3. La única migración autoritativa sigue en `packages/store/migrations`; los scripts de este directorio no escriben V2.

## Composes separados

- `deploy/compose.dev.yaml`: desarrollo HTTP/WS, auth dev, PostgreSQL local aislado, dos adapters fake y profiles Telegram/shadow.
- `ops/compose.test.yaml`: QA descartable con PostgreSQL real y protocol doubles.
- `ops/compose.authentic.yaml`: los cinco binarios finales de una única imagen,
  PostgreSQL real, gateway mTLS, Telegram HTTP fake sobre TLS verificable, webhook
  HTTPS verificado y target V2 por Unix socket real.
- `deploy/compose.yaml`: producción TLS, imágenes por digest, secretos por PATH, bind privado y PostgreSQL administrado externo por defecto.
- `deploy/compose.postgres.yaml`: overlay opcional para PostgreSQL local con TLS real; no publica `5432`.

```sh
cp config/dev.env.example config/dev.env
make dev-up && make dev-health

# Producción: completar un env privado fuera del repo desde prod.env.example.
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env make prod-health
```

Producción publica solo gateway/console sobre `CAUCE_PRIVATE_BIND_IP` (default `127.0.0.1`), con health HTTPS. Gateway, consola y su upstream usan certificados montados; PostgreSQL exige `sslmode=verify-full` y CA explícita. Los adapters generados exigen `wss://`, política `production`, token/cert/CA por PATH, instance ID estable y estado en `/var/lib/cauce-v3/aliases/<alias>`. Runtime, consola y workers son non-root/read-only; los servicios persistentes tienen restart policy.

Profiles opt-in:

- `origin-relay`: worker de webhook permitido por origin/adapter;
- `telegram`: bridge nativo con cursor/poll lease y egress cercado; config, tokens `0600` y markers V2 viven en un directorio externo read-only;
- `shadow`: router Unix identity-free en modo shadow/compare/cutover más guard de side effects; cutover requiere interlock y dirección;
- `observability`: Prometheus/OTel y métricas exactas de wake/outbox/relay.

No registrar `telegram` también en `origin-relay`: serían egress workers competidores sobre el mismo outbox. Un profile con configuración/directorios vacíos falla cerrado.

## Flota declarativa

`manifests/*.yaml` contiene exactamente 12 aliases y ninguna credencial: OpenClaw `jarvis/janus/hegel/midas/seneca`, Claude `vulcano`, Hermes `argos` y Codex `dedalo/kant/kratos/salva/socrates`. OpenCode queda empaquetado para compatibilidad, pero ningún alias live depende de él. Tenant, room, origen Telegram, estado y nombres de variables `*_PATH`/`*_URL` son validados de forma exacta. `container-aliases.json` agrega el mapping exacto container/user/home/mount sin reemplazar esos manifests ni sus units host-native.
Hermes declara además solo el nombre operativo `HERMES_INFERENCE_MODEL`; su valor se resuelve en el env privado de `argos` y no se hardcodea en manifests o unidades.

```sh
make manifests
# salida: generated/systemd/cauce-v3-alias-<alias>.service
# salida adicional: generated/container-systemd/cauce-v3-container-<alias>.service
```

Los env privados `/etc/cauce-v3/aliases/<alias>.env` resuelven los placeholders. `alias-runner.sh` exige WSS, archivos legibles, wrapper absoluto y `flock` exclusivo. Ver `runbooks/alias-cutover.md`; generar unidades no inicia consumers.

Para ejecutar el adapter dentro del container existente se usa una familia separada: config no secreta root-owned en `/etc/cauce-v3/container-aliases/<alias>.env`, PKI root-owned por alias y `container-adapter-supervisor.sh`. Cada config fija directamente `BUNDLE_RELEASE` + `BUNDLE_SHA256`; no hay symlink global `current`, así que canary y rollback son independientes por alias mediante `pin-container-release.py` con CAS. El supervisor valida ID/generación, image/label, mount JSON exacto y digest activo antes de lanzar una sesión/PGID dedicada; limpia el entorno con `env -i` e inyecta solo valores no secretos y paths `*_FILE`. `OPERATIONS.sha256` cubre scripts/helper/mapping/units/examples aunque `source-digest.py` excluya `ops`. Ver `runbooks/container-adapters.md`.

## QA y evidencia

```sh
make validate
make test-real       # HTTP/WS/PostgreSQL auténticos; harnesses son protocol doubles
make test-doubles    # contrato mock + adapters con ejecutables fake
make smoke-cli       # 5 CLIs auténticas: solo --version/--help, no prompt
make test-compose-authentic # release-class: final binaries + restart/fencing/effects
make test-runtime-authentic # fallback docker-run; nunca habilita release
pnpm verify:three-rounds     # frozen/lint/typecheck/build + 3 rondas + fleet/Testcontainers/mock
pnpm evidence:release-candidate
```

Las clases no se mezclan: `protocol-double` nunca incrementa contadores
`real`/`authentic`, y `smoke-cli` no acredita ejecución de prompts. Unitarios y
Testcontainers se archivan fuera de `artifacts/compose-authentic`; el wrapper de
Testcontainers conserva cada corrida bajo `artifacts/testcontainers/<timestamp>`
sin sobrescribir evidencia runtime. Cada reporte runtime exige `criticalSkipped`,
`mechanism`, `evidenceClass`, `imageDigest`, `sourceDigest` y timestamps explícitos,
y JSON/JUnit quedan cubiertos por `SHA256SUMS`.

`artifacts/release-candidate/` contiene `sourceDigest`, `report.json`, `junit.xml` y
`SHA256SUMS`. El reporte separa deliberadamente `gates.codeRuntime` de
`gates.releaseHost`: un runtime-authentic local puede cerrar el primero, pero nunca
convierte la ausencia de Compose v2, build autorizado, publicación por digest,
credenciales privadas o evidencia distribuida de hosts en un release aprobado.

`make release-gate` falla si falta Docker Compose v2, `docker build`, build
evidence actual, hashes, las 12 unidades systemd exactas o evidencia
`compose-authentic` del mismo image/source digest. Exige cero skips críticos y
los mecanismos `gateway-process-kill` y `postgres-container-kill`. El fallback
`runtime-authentic` sirve para desarrollo sin Compose, pero nunca para release.
`release-build` usa `--pull` por defecto; `CAUCE_RELEASE_PULL=0` solo permite una
construcción diagnóstica con bases cacheadas y no reemplaza el build del release host.

## Seguridad y recuperación

- No versionar URLs, tokens, certificados, cookies, sesiones ni outputs de collectors.
- En Compose standalone verificar que el backend respete `uid/gid/mode` de secrets;
  si usa bind mounts, preparar ownership/ACL para UID 1000 (runtime) o 101
  (consola) sin volver el archivo legible para otros usuarios del host.
- Producción exige PostgreSQL `sslmode=verify-full`; readiness confirma `pg_stat_ssl.ssl=true`.
- Backup/restore aceptan `DATABASE_URL_FILE`, verifican TLS/checksum y no operan V2.
- Rollback de schema es restore hacia DB V3 nueva; no hay down migrations.
- CSP permite a xterm solo atributos de estilo inline (`style-src-attr`), sin abrir scripts inline.

## Estado live 2026-07-23 — Telegram bridge V3

> **Nota (2026-07-23):** Bridge productivo único `cauce-v3-prod-telegram-bridge-1`
> sobre `agora-storage`, `healthy`, `RestartCount=0`, readiness aliases = **12**.
> Selector acumulativo activo sobre los 12 manifest (selector siempre
> acumulativo; selector vacío activa todos — para apagar, **STOP** explícito del
> perfil, no recreate con `CAUCE_TELEGRAM_ALIASES=""`); preflight secret-free PASS
> (sólo metadata, no formato/contenido del token); V2 Telegram = 0 sobre los 4
> pendientes iniciales de watchdog (`socrates`=connector, `kratos`=native,
> `salva`=native, `vulcano`=connector); `janus` post-remediación 2026-07-23 vía
> CLI oficial (`channels.telegram.enabled=false`, hot reload, sin restart).
> Métricas agregadas (sin labels por alias) — `poll_fenced` estable no prueba
> ausencia de V2. Detalle operativo, advertencias e incidente/remediación:
> `runbooks/telegram-cutover.md` §"Advertencias operativas" y §"Estado live
> verificado 2026-07-23", y
> `../../docs/handoffs/HANDOFF-CAUCE-V3-TELEGRAM-CUTOVER-2026-07-23.md` §8
> (Incidente y remediación).
