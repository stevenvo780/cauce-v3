# Índice de lo retirado del árbol (borrado el 27-08-2026 — git es el archivo)


Todo lo aquí listado se BORRÓ del árbol de trabajo. Recuperación: `git log --all --diff-filter=AD -- "_legado/*"` para hallar los commits, `git show <commit>:<ruta>` para el contenido, o el bundle `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`.
Código medido como **nunca usado en producción** o **reemplazado por otra cosa**. Se mueve aquí para
sacarlo de la vista y del build; **no se borra todavía** — la tala definitiva la decide el dueño.
Nada de este directorio se compila, lintea ni testea (los generadores pueden leerlo para producir
estado en otra ruta: `ops/scripts/generate-container-units.py --rootless` no toca `contingentes/`).

## Índice por origen

### 1. `services/` — servicios completos nunca desplegados (origen: purga 27-08)

Servicios enteros movidos desde `services/` por la auditoría del 2026-08-27
(commit `daf2162`). Ninguno corrió en este host; sus `package.json`, código y tests viven aquí
para conservarlos por si la decisión de resucitar se revierte.

| Fichero / familia | Tamaño | Evidencia (una línea) | Detalle |
|---|---|---|---|
| `services/shadow-router/` (src + test + node_modules) | 9 ficheros TS, ~2K líneas | Router de transición V2→V3; sus 4 tablas `shadow_*` con 0 filas en 5 semanas; herramienta de migración de un solo uso | `_legado/services/shadow-router/CONFIGURATION.md`; censo `plan-reestructura/censo-contingentes.md` |
| `services/relay-worker/` (src + test + node_modules) | 7 ficheros TS, ~2K líneas | Puente de egress paralelo a `telegram-bridge`; sustituido por él; target de Prometheus cayó 3,5 días con alerta sin receptor | `_legado/services/relay-worker/CONFIGURATION.md` |

Nota: ambos incluyen `node_modules/.vite/vitest/...` (artefactos de caché de vitest previos al
movimiento, no se borran para no invalidar el estado del bundle).

### 2. `rollback-bridge/` + `compose.rollback-bridge.yaml` — esquema V2→V3 con patch gigante (origen: purga 27-08)

Reconstruía un commit viejo contra el esquema actual vía un patch de **13.321 líneas**
(`rollback-bridge-schema029.patch`). El registro de imágenes (`build.json` con `RepoDigest`) ya
resuelve lo mismo con tags. El parche es referenciado desde `plan-reestructura/00-LEEME.md` solo
como "lo que NO debe haber".

| Fichero / familia | Evidencia | Detalle |
|---|---|---|
| `rollback-bridge/build.sh`, `publish.sh`, `test.sh`, `metadata.json`, `publish.test.mjs` | Productor + validador + publicador del artefacto `rollback-bridge`; sin uso tras retirar el esquema | `rollback-bridge/` |
| `rollback-bridge/rollback-bridge-schema029.patch` (13.321 líneas) | El patch reconstruido; único del estilo "squash viejo contra esquema actual"; prohibido editar (`plan-reestructura/00-LEEME.md`) | `plan-reestructura/00-LEEME.md` L34 |
| `compose.rollback-bridge.yaml` | Compose del productor + validador; declaraba `relay-worker` y `shadow-router` | Se reescribe en `plan-reestructura/31` |

### 3. `ops-scripts/` — maquinaria de release retirada (origen: purga 27-08 + refinamientos rondas 4/6)

25 ficheros de la "maquinaria de release": 19 movidos en `daf2162`/`bf63fbc`,
sus tests partidos o movidos en `da1b4af`, `validate-terminal-release.py` retirado en `d0ae77b`
y cinco residuos finales incorporados después.
**~19.589 líneas**; **0 despliegues logrados en su historia**; su gate exigía evidencia imposible
(digest que caduca con cualquier commit). Se reemplaza por `deploy/deploy.sh` simple
(`plan-reestructura/31-despliegue-simple.md`).

| Fichero | Evidencia (una línea) |
|---|---|
| `ops-scripts/deploy-release.sh` | Orquestador de release; gate imposible (build-evidence, source-digest, 3 rondas, etc.) |
| `ops-scripts/release-candidate.py` (la pieza central) | Generador + validador del "release-candidate"; rc=1 permanente por evidencia caduca |
| `ops-scripts/release-build.sh`, `release-gate.sh`, `release-writer-state.py`, `release-console.sh` | Familia del release-candidate: build, gate, rotación de writer |
| `ops-scripts/pin-production-release.py`, `rollback-baseline.py`, `rollback.sh`, `restore.sh`, `cutover-rollback.sh`, `migrate.sh`, `bootstrap-prod-env.py`, `fleet-gate-mode.sh` | Soporte del flujo release→production→rollback→restore; todo gira alrededor del artefacto "release-candidate" |
| `ops-scripts/produce-rollback-bridge-evidence.py`, `validate-release-evidence.py`, `validate-rollback-bridge-evidence.py`, `validate-terminal-release.py` | Validadores de evidencia del release; consumidores exclusivos de la maquinaria anterior |
| `ops-scripts/capture-release-writer-snapshot.sh` | Captura del estado del writer; consumido solo por `release-writer-state.py` y los validadores |
| `ops-scripts/verification-rounds.mjs` | Las "3 rondas" (frozen/lint/typecheck/build + 3 rondas + fleet/Testcontainers/mock); su caller `pnpm verify:three-rounds` fue retirado del árbol vivo |
| `ops-scripts/fleet-parity.sh`, `fleet-parity.py`, `source-hygiene.py`, `migration-integrity-gate.sh`, `reconcile-stale-console-outbox.sh` | Residuos cuyo único caller ejecutable era la familia anterior; los wrappers de producción habían quedado además bloqueados por la política read-only de Compose |

`ops-schemas/` conserva los seis esquemas consumidos exclusivamente por esa familia:
`build-evidence`, `release-candidate`, `release-writer-snapshot`, `rollback-baseline` y
`verification-evidence`, además de `migration-integrity-evidence`. Los esquemas de tests y
operaciones activas permanecen vivos.

Detalle: `_legado/README.md` sección "Pendiente de mover aquí" de rondas previas (en
`ordenes/ronda1/codex.md` y `ordenes/ronda2/codex.md`); `docs/bitacora/plan-ejecutado/12-cuarentena-legado.md`
L15 (cifra "17.686 líneas"; la cifra actual es 19.589 tras los refinamientos posteriores).

Los targets y scripts de paquete que apuntaban a esta familia, y la validación que ejecutaba
sus tests dedicados, fueron retirados del árbol vivo.

### 4. `basura/` — auditorías históricas del 2026-Q3 (origen: reorganización de docs/bitacora)

4 informes de auditoría previos a la purga del 27-08. Mantenidos por valor histórico
(reconstrucción del razonamiento que llevó a la cuarentena actual); ninguno describe el estado
presente.

| Fichero | Tamaño | Evidencia |
|---|---|---|
| `basura/ARQUITECTURA_DETALLADA.md` | ~440 líneas | Auditoría de arquitectura pre-purga; describe el sistema en su forma anterior a la cuarentena |
| `basura/INFORME_ARCHIVOS_INCONEXOS_Y_BASURA.md` | ~140 líneas | Inventario de "ficheros sin uso" previo a la cuarentena; muchas recomendaciones ya ejecutadas |
| `basura/INFORME_COMENTARIOS_HISTORICOS_Y_LIMPIEZA.md` | ~? líneas | Censo de comentarios narrativos; realizado para la poda del 27-08 |
| `basura/PLAN-DIRECTIVE-CONTENT-LECTURA.md` | ~600 líneas | Plan de feature cancelada; conservado solo por valor histórico |

Detalle: discusión del razonamiento en `docs/bitacora/` si se necesita contexto.

### 5. `contingentes/` — 68 ficheros del censo 2026-08-27 (origen: ronda 4 minimax + ronda 6 minimax)

Moveriles de la Tarea 1+Tarea 2+Tarea 3 de `ordenes/ronda4/opencode-minimax.md` (52 ficheros del
censo inicial) más los 13 de la ronda 6 (`a959c46` + `90f690c` + `c9d87f3` + `0f77d25`): 6 schemas
sin consumidor, 5 tests huérfanos, 4 scripts sin invocador real, y `Dockerfile`+`.dockerignore` de
`ops/harness` sin construir. La subruta se conserva exactamente para que el plan y los runbooks
sigan siendo localizables (`ops/cli/...`, `ops/security/...`, etc.). Evidencia por fichero en
`plan-reestructura/censo-contingentes.md`.

| Subruta | Ficheros | Por qué está aquí |
|---|---|---|
| `contingentes/` (raíz) (2) | `Dockerfile.harness-origen`, `dockerignore.harness-origen` | Origen de `ops/harness/Dockerfile`+`.dockerignore`: nadie construye esa imagen (todo el repo usa `deploy/Dockerfile`); commit `90f690c` (ronda 6) |
| `contingentes/ops/ai-live/` (4) | `cauce-ai-live`, `.service`, `.timer`, `cdp.py` | Bridge de IA↔navegador vía CDP; cero consumidores en este host |
| `contingentes/ops/cli/` (2) | `cauce-panel-guard`, `cauce-tmux-panel` | Binarios del panel y tmux por alias; fuentes para `/usr/local/sbin/cauce-*` en la TORRE; el censo no las vio (las 3 unidades que las invocaban fueron movidas por el integrador en `36c6465`) |
| `contingentes/ops/config/` (2) | `cauce-ops.env.example`, `e2e.env.example` | Plantillas de entorno nunca leídas en caliente; los reales viven fuera del repo |
| `contingentes/ops/console-login/` (1) | `patch-caddy-lista-blanca.py` | Parche puntual de la lista blanca de Caddy; corrido una vez en el VPS; sin invocación automatizada |
| `contingentes/ops/container-runtime/` (1) | `salva-container-keepalive.sh` | Hook de keepalive para contenedores; sin servicio que lo invoque en este host |
| `contingentes/ops/generated/container-systemd/` (32) | 15 `.service` + 2 SHA + 15 `.env.example` | Plantillas generadas para modo system/root; el vivo es `rootless/` (en `ops/generated/container-systemd/rootless/`); regenerar en `/tmp` da diff=0 contra lo checked-in |
| `contingentes/ops/observability/` (3) | `agent-health-metrics.prom`, `alerts-agent-health.yaml`, `otel-collector.upstream.example.yaml` | Prom/Alertmanager/Otel no montados por ningún contenedor vivo (D2 del dossier FASE 3) |
| `contingentes/ops/schemas/` (7) | `rollback-bridge.schema.json`, `dlq-no-replay-resolution.schema.json`, `dlq-reconciliation.schema.json`, `fleet-snapshot.schema.json`, `gate-snapshot.schema.json`, `physical-fleet-snapshot.schema.json`, `telegram-manual-replay.schema.json` | Schemas sin consumidor localizable en producción (Codex/Codex ronda 6 verificó los 6 nuevos en `a959c46`). El de rollback-bridge está roto en 3 tests reales (`tests/unit/rollback-baseline.test.ts`, `tests/unit/source-digest-closure.test.ts`, `ops/tests/source-digest-domains.test.mjs`) — 2 ya movidos a `_legado/tests/` por el integrador |
| `contingentes/ops/scripts/` (7) | `retire-session-host.sh`, `selftest-postgres.sh`, `smoke-authentic-restarts.sh`, `aplicar-separacion-config.sh`, `censo-config-por-alias.py`, `diff-consola-visible.py`, `preflight.sh` | Helpers de retirada/diagnóstico; cero llamador vivo confirmado por re-verificación in situ. Los 4 últimos son los de ronda 6 (`0f77d25`): la suite operativa CONFIG_POR_ALIAS queda apagada por defecto (decisión del dueño en `censo-contingentes.md`) |
| `contingentes/ops/security/` (2) | `README-seccomp.md`, `seccomp-userns.json` | Perfil seccomp para openclaw; ningún contenedor lo aplica |
| `contingentes/ops/systemd/` (3) | `cauce-v3-panel-guard.service`, `.timer`, `cauce-v3-tmux@.service` | Units que invocan los binarios de `contingentes/ops/cli/`; el censo no las vio; el integrador las movió aquí en `36c6465` |
| `contingentes/packages/adapter-sdk/docs/` (1) | `ADDING-HARNESS.md` | Guía para añadir un harness al SDK; los 3 binarios vivos (`openclaw`, `claude`, `codex`) ya están integrados |
| `contingentes/scripts/` (1) | `verify.sh` | Helper de verificación sin llamador en este repo |

Fuera de `_legado/` pero originados por la ronda 6: `ops/harness/CONTRACT.md` →
`docs/bitacora/CONTRACT-harness-2026.md` (mismo commit `90f690c`); sin hogar en
`_legado/contingentes/` porque describe un contrato del harness que el repo ya no usa pero
conserva valor histórico.

### 6. `tests/` — cobertura de las piezas retiradas (origen: ronda 4 + ronda 5 integrador + ronda 6 minimax)

33 tests que cubrían las piezas en cuarentena. Si la pieza se revive, los tests vuelven con ella
por subruta espejada. **No se ejecutan** (no están en `validate.sh`, `package.json`, `Makefile`).
Los 5 de "Contingentes operativos" vienen de la ronda 6 (`c9d87f3`).

| Familia | Ficheros | Por qué está aquí |
|---|---|---|
| Maquinaria de release y rollback (24) | `bootstrap-prod-env`, `compose-files-release`, `container-{cutover-rollback,release-evidence,release-pin}`, `deploy-release`, `fleet-{maintenance-mode,parity}`, `migrate-cli-production`, `pin-production-release`, `release-*`, `restore-release-integrity`, `rollback-*`, `schema-error-sanitization-release`, `source-{digest-closure,digest-release-wiring,hygiene}`, `terminal-release-gate`, `test_release_writer_rotation` | Cobertura de la maquinaria retirada (sección 3) y del rollback-bridge (sección 2) |
| Servicios retirados (4) | `relay-worker`, `shadow-router-target-phase-postgres`, `shadow-inbox-fencing`, `terminal-relay-operability-shadow` | Cobertura de los servicios completos (sección 1) |
| Contingentes operativos (5) | `aplicar-separacion-config`, `test_censo_config_por_alias`, `test_dlq_cli`, `test_generate_telegram_config`, `test_telegram_cutover_preflight` | Cobertura conservada con las piezas contingentes correspondientes; ronda 6 (`c9d87f3`) verificó que ningún runner (`ops/scripts/validate.sh`, `package.json`, `ops/Makefile`) los invoca |

Detalle: ningún test de `_legado/tests/` se ejecuta desde `make validate`, `pnpm test:unit` ni
`.github/workflows/ci.yml`.

## Pendiente de mover aquí (asignado a Codex / dueño)

| Pieza | Líneas | Estado |
|---|---|---|
| 45 dudosos del censo (`plan-reestructura/censo-contingentes.md` L23–67) | n/d | Sin marcar; ronda 5 salta (Tarea 5 condicional). Algunos quedaron resueltos por las olas 2/3 (publish-intents no era legado, authentic ya quedó retirada); el censo se reescribió en `7a0f0d3` para reflejarlo |
| Restos de la suite operativa CONFIG_POR_ALIAS (`ops/scripts/{separar-config-alias,update-alias-config}.sh` y ss wrappers no usados) | ~200 | Ronda 6 (`0f77d25`) movió los 4 scripts sin invocador real (los sujetos de los 5 tests movidos). Quedan 2 piezas aún en el árbol vivo, sin tests, sin llamador; decisión del dueño |

Resuelto en la ronda actual: la suite QA `authentic` salió íntegra del árbol operativo porque
exigía `relay-worker`/`shadow-router` en una imagen que ya no los construye. Se retiraron Compose,
runners, helpers, schema, dominio de digest, targets y wiring de validación asociados.
El stage Docker huérfano `authentic-harness` queda fuera de alcance hasta FASE 3 (`deploy/**` es
sector NADIE); no conserva ningún caller vivo.

## Referencias vivas rotas a sabiendas (se resuelven en FASE 3)

| Fichero | Ref | Resuelve |
|---|---|---|
| `ops/runbooks/backup-restore.md` L27, L177 | `./scripts/restore.sh` | `restore.sh` está en `_legado/ops-scripts/`; el runbook se reescribe en FASE 3 (`plan-reestructura/31`) |
| `ops/INSTALLATION.md`; `ops/runbooks/systemd.md` | `release-gate.sh` | El gate está en `_legado/ops-scripts/`; la instalación y el runbook se reescriben en FASE 3 (`plan-reestructura/31`) |
| `ops/runbooks/systemd.md`; `ops/runbooks/alias-cutover.md`; `ops/runbooks/container-adapters.md` | `cutover-rollback.sh` | El cutover está en `_legado/ops-scripts/`; los runbooks se reescriben en FASE 3 (`plan-reestructura/31`) |
| `deploy/compose.yaml` | declaraba `relay-worker`, `shadow-router`, `shadow-guard` (en profiles nunca encendidos) | Se reescribe en FASE 3 (`plan-reestructura/31`); hoy ya está canónico (`00f8e6e`) |
| `ops/scripts/stack-health.sh`, `fault-compose.sh`, `tests/unit/relay-telegram-observability.test.ts` | mencionan los servicios por nombre de compose (strings), no por import | Siguen funcionando; el ref sigue siendo válido como cadena literal |

## Cómo recuperar cualquier cosa

Todo el repo previo a la purga de ramas del 2026-08-27 (146 ramas locales, 134 remotas, worktrees)
está archivado en:
- `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle` — `git bundle`, historia completa. Ej.: `git fetch <bundle> consola/editor-directiva-20260823:recuperada/editor`
- `/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz` — copia cruda de los 7 worktrees que tenían trabajo sin commitear (ese trabajo también quedó commiteado en ramas dentro del bundle).

Para revivir cualquier pieza: `git mv _legado/<ruta> <ruta-original>` y resolver las refs vivas
rotas de la tabla anterior. La subruta espejada (`ops/...`, `services/...`, `tests/...`) hace que
las búsquedas por basename sigan funcionando.
