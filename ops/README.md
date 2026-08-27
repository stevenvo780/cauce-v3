# Cauce V3 — operaciones y QA

Este árbol opera exclusivamente V3. La única migración autoritativa sigue en `packages/store/migrations`; los scripts de este directorio no escriben V2.

## Composes separados

- `deploy/compose.dev.yaml`: desarrollo HTTP/WS, auth dev, PostgreSQL local aislado, dos adapters fake y profiles Telegram/shadow.
- `ops/compose.test.yaml`: QA descartable con PostgreSQL real y protocol doubles.
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

`container-aliases.json` es el inventario declarativo único del release y no contiene credenciales.
`manifests/*.yaml`, los units y sus ejemplos se derivan de su conjunto exacto de aliases; los
validadores rechazan cualquier alta, baja o cambio de tenant/room/harness aplicado sólo en una
capa. OpenCode queda empaquetado para compatibilidad, pero ningún alias declarado depende de él.
Tenant, room, origen Telegram, estado y nombres de variables `*_PATH`/`*_URL` son validados de
forma exacta. PostgreSQL sigue siendo el registro de intención live y debe superar el gate de
paridad antes de desplegar; nunca se interpreta un alta en DB como prueba de que el runtime existe.
Hermes declara además sólo el nombre operativo `HERMES_INFERENCE_MODEL`; su valor se resuelve en el entorno privado autorizado y no se hardcodea en manifests o unidades.

```sh
make manifests
# salida: generated/systemd/cauce-v3-alias-<alias>.service
# salida adicional: generated/container-systemd/cauce-v3-container-<alias>.service
```

Los env privados `/etc/cauce-v3/aliases/<alias>.env` resuelven los placeholders. `alias-runner.sh` exige WSS, archivos legibles, wrapper absoluto y `flock` exclusivo. Ver `runbooks/alias-cutover.md`; generar unidades no inicia consumers.

Para ejecutar el adapter dentro del container existente se usa una familia separada: config no secreta root-owned en `/etc/cauce-v3/container-aliases/<alias>.env`, PKI root-owned por alias y `container-adapter-supervisor.sh`. Cada config fija directamente `BUNDLE_RELEASE` + `BUNDLE_SHA256`; no hay symlink global `current`, así que canary y rollback son independientes por alias mediante `pin-container-release.py` con CAS. El supervisor valida ID/generación, image/label, mount JSON exacto y digest activo antes de lanzar una sesión/PGID dedicada; limpia el entorno con `env -i` e inyecta solo valores no secretos y paths `*_FILE`. `OPERATIONS.sha256` cubre scripts/helper/mapping/units/examples; los dominios `runtime`/`console` de `source-digest.py` siguen excluyendo `ops`, mientras `verification` cubre el árbol operacional vivo. Ver `runbooks/container-adapters.md`.

## QA y evidencia

```sh
make validate
make test-real       # HTTP/WS/PostgreSQL auténticos; harnesses son protocol doubles
make test-doubles    # contrato mock + adapters con ejecutables fake
make smoke-cli       # 5 CLIs auténticas: solo --version/--help, no prompt
```

### Dominios de `source-digest.py`

Cada evidencia se ata al digest de **exactamente** lo que puede cambiar su resultado. Cubrir de más
invalida evidencia cara sin causa y empuja a falsificarla; cubrir de menos produce evidencia que no
prueba lo que dice. `source-digest.py --domain <dominio>` emite:

| Dominio | Cubre | Respalda |
|---------|-------|----------|
| `runtime` | manifiestos raíz + `packages/` + `services/` + `deploy/` | identidad de fuentes runtime registrada por Testcontainers |
| `console` | manifiestos raíz + `apps/console/` + `deploy/` | identidad de fuentes de la imagen consola |
| `testcontainers` | E2E, helper PostgreSQL, runner, schema y validador Testcontainers | `harnessDigest` de la evidencia Testcontainers |
| `verification` | tests, orquestación y fuentes operacionales ejecutadas o inspeccionadas | cierre del gate global |
| `full` | unión de los cuatro; **default** si nadie declara dominio | fallback estricto para callers sin dominio |

`apps/console` **no** está en `runtime`: no hay camino causal desde la consola hasta la imagen
runtime (el stage `runtime` del Dockerfile nunca copia consola, `production-dependencies` excluye
`@cauce/console`, `tsconfig.build.json` no compila consola y la consola no importa `@cauce/*`). El
grafo de dependencias sigue cubierto porque `pnpm-lock.yaml` y `pnpm-workspace.yaml` permanecen en
`runtime`. Consecuencia práctica: un cambio exclusivo de consola no relabela la identidad runtime
de la evidencia Testcontainers.

El `harnessDigest` de Testcontainers usa el dominio `testcontainers`; `verification` toma además el
árbol `ops/harness/` completo. `ops/tests/source-digest-domains.test.mjs` fija la forma del recorte y
corre dentro de `make validate`.

Un fallo de `gateway-process-kill` o `postgres-container-kill` **no** es señal de fraude: son
sensibles a CPU y flakean en hosts cargados (comprobado con corrida de control). El remedio legítimo
es volver a correr la suite; el gate nombra el mecanismo y lo aclara en el mensaje.

Las clases no se mezclan: `protocol-double` nunca acredita transporte productivo y `smoke-cli` no
acredita ejecución de prompts. El wrapper Testcontainers conserva cada corrida bajo
`artifacts/testcontainers/<timestamp>` y cubre JSON/JUnit con `SHA256SUMS`.

La suite QA `compose-authentic`/`runtime-authentic` y la maquinaria de evidencia de release se
retiraron porque dependían de servicios ya eliminados. No existe en este árbol un reemplazo que
acredite binarios/imágenes finales; ver `el historial de git (--diff-filter=AD)`.

## Seguridad y recuperación

- No versionar URLs, tokens, certificados, cookies, sesiones ni outputs de collectors.
- En Compose standalone verificar que el backend respete `uid/gid/mode` de secrets;
  si usa bind mounts, preparar ownership/ACL para UID 1000 (runtime) o 101
  (consola) sin volver el archivo legible para otros usuarios del host.
- Producción exige PostgreSQL `sslmode=verify-full`; readiness confirma `pg_stat_ssl.ssl=true`.
- Backup/restore aceptan `DATABASE_URL_FILE`, verifican TLS/checksum y no operan V2.
- Rollback de schema es restore hacia DB V3 nueva; no hay down migrations.
- CSP permite a xterm solo atributos de estilo inline (`style-src-attr`), sin abrir scripts inline.

## Snapshot histórico de Telegram bridge V3

> La evidencia privada conserva fecha, host, aliases, releases y métricas exactas. Se observó un
> único bridge saludable, selector acumulativo y preflight secret-free de metadata. El corte
> también observó V2 drenado para su alcance, pero no acredita el presente: `poll_fenced` estable
> no prueba ausencia de V2. Antes de un release se repiten el gate V2 y los round-trips por alias.
> Las advertencias operativas vigentes están en `runbooks/telegram-cutover.md`; el incidente y
> su remediación detallada permanecen en evidencia privada no versionada.
