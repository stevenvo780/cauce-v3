# _legado — cuarentena

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

20 ficheros de la "maquinaria de release": 19 movidos en `bf63fbc`/`da1b4af` y
`validate-terminal-release.py` retirado en `d0ae77b`.
**~19.049 líneas**; **0 despliegues logrados en su historia**; su gate exigía evidencia imposible
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

Detalle: `_legado/README.md` sección "Pendiente de mover aquí" de rondas previas (en
`ordenes/ronda1/codex.md` y `ordenes/ronda2/codex.md`); `plan-reestructura/12-cuarentena-legado.md`
L15 (cifra "17.686 líneas"; la cifra actual es 19.049 tras los refinamientos posteriores).

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

### 5. `contingentes/` — 52 ficheros del censo 2026-08-27 (origen: ronda 4 minimax)

Moveriles de la Tarea 1+Tarea 2+Tarea 3 de `ordenes/ronda4/opencode-minimax.md`. La subruta se
conserva exactamente para que el plan y los runbooks sigan siendo localizables
(`ops/cli/...`, `ops/security/...`, etc.). Evidencia por fichero en
`plan-reestructura/censo-contingentes.md`.

| Subruta | Ficheros | Por qué está aquí |
|---|---|---|
| `contingentes/ops/ai-live/` (4) | `cauce-ai-live`, `.service`, `.timer`, `cdp.py` | Bridge de IA↔navegador vía CDP; cero consumidores en este host |
| `contingentes/ops/cli/` (2) | `cauce-panel-guard`, `cauce-tmux-panel` | Binarios del panel y tmux por alias; fuentes para `/usr/local/sbin/cauce-*` en la TORRE; el censo no las vio (las 3 unidades que las invocaban fueron movidas por el integrador en `36c6465`) |
| `contingentes/ops/config/` (2) | `cauce-ops.env.example`, `e2e.env.example` | Plantillas de entorno nunca leídas en caliente; los reales viven fuera del repo |
| `contingentes/ops/console-login/` (1) | `patch-caddy-lista-blanca.py` | Parche puntual de la lista blanca de Caddy; corrido una vez en el VPS; sin invocación automatizada |
| `contingentes/ops/container-runtime/` (1) | `salva-container-keepalive.sh` | Hook de keepalive para contenedores; sin servicio que lo invoque en este host |
| `contingentes/ops/generated/container-systemd/` (32) | 15 `.service` + 2 SHA + 15 `.env.example` | Plantillas generadas para modo system/root; el vivo es `rootless/` (en `ops/generated/container-systemd/rootless/`); regenerar en `/tmp` da diff=0 contra lo checked-in |
| `contingentes/ops/observability/` (3) | `agent-health-metrics.prom`, `alerts-agent-health.yaml`, `otel-collector.upstream.example.yaml` | Prom/Alertmanager/Otel no montados por ningún contenedor vivo (D2 del dossier FASE 3) |
| `contingentes/ops/schemas/` (1) | `rollback-bridge.schema.json` | Schema del productor retirado; roto en 3 tests reales (`tests/unit/rollback-baseline.test.ts`, `tests/unit/source-digest-closure.test.ts`, `ops/tests/source-digest-domains.test.mjs`) — 2 ya movidos a `_legado/tests/` por el integrador |
| `contingentes/ops/scripts/` (3) | `retire-session-host.sh`, `selftest-postgres.sh`, `smoke-authentic-restarts.sh` | Helpers de retirada/diagnóstico; cero llamador vivo confirmado por re-verificación in situ (Codex lo confirmó) |
| `contingentes/ops/security/` (2) | `README-seccomp.md`, `seccomp-userns.json` | Perfil seccomp para openclaw; ningún contenedor lo aplica |
| `contingentes/ops/systemd/` (3) | `cauce-v3-panel-guard.service`, `.timer`, `cauce-v3-tmux@.service` | Units que invocan los binarios de `contingentes/ops/cli/`; el censo no las vio; el integrador las movió aquí en `36c6465` |
| `contingentes/packages/adapter-sdk/docs/` (1) | `ADDING-HARNESS.md` | Guía para añadir un harness al SDK; los 3 binarios vivos (`openclaw`, `claude`, `codex`) ya están integrados |
| `contingentes/scripts/` (1) | `verify.sh` | Helper de verificación sin llamador en este repo |

### 6. `tests/` — cobertura de las piezas retiradas (origen: ronda 4 + ronda 5 integrador)

24 tests que cubrían las piezas en cuarentena. Si la pieza se revive, los tests vuelven con ella
por subruta espejada. **No se ejecutan** (no están en `validate.sh`, `package.json`, `Makefile`).

| Familia | Ficheros | Por qué está aquí |
|---|---|---|
| `tests/release-*.test.ts`, `tests/release-*.extracto.mjs`, `tests/release-*.extracto.ts`, `tests/pin-production-release.test.ts`, `tests/deploy-release.test.ts`, `tests/rollback-*.test.ts`, `tests/compose-files-release.extracto.ts`, `tests/migrate-cli-production.test.ts`, `tests/bootstrap-prod-env.test.ts`, `tests/restore-release-integrity.test.ts`, `tests/source-digest-closure.test.ts` (11) | Cobertura de la maquinaria de release retirada (sección 3) y del rollback-bridge (sección 2). 2 ya estaban en `_legado/tests/` antes; los 9 del release llegaron en `bf63fbc` y `da1b4af` |
| `tests/relay-worker.test.ts`, `tests/shadow-router-target-phase-postgres.test.ts`, `tests/shadow-inbox-fencing.extracto.ts` (3) | Cobertura de los servicios completos (sección 1) |
| `tests/container-cutover-rollback.extracto.mjs`, `tests/container-release-evidence.extracto.mjs`, `tests/container-release-pin.test.ts`, `tests/fleet-maintenance-mode.test.ts` (4) | Cobertura del flujo container-systemd no-rootless (sección 5: `contingentes/ops/generated/container-systemd/`) |
| `tests/schema-error-sanitization-release.extracto.py`, `tests/source-digest-release-wiring.extracto.mjs`, `tests/terminal-release-gate.test.ts`, `tests/test_release_writer_rotation.py` (4) | Validadores de evidencia de release y rotación de writer; sin consumidores vivos |
| `tests/compose-files-release.extracto.ts`, `tests/container-cutover-rollback.extracto.mjs` (extractos) | Piezas migradas a TS/MJS para el digest |

Detalle: ningún test de `_legado/tests/` se ejecuta desde `make validate`, `pnpm test:unit` ni
`.github/workflows/ci.yml`.

## Pendiente de mover aquí (asignado a Codex / dueño)

| Pieza | Líneas | Estado |
|---|---|---|
| 45 dudosos del censo (`plan-reestructura/censo-contingentes.md` L23–67) | n/d | Sin marcar; ronda 5 salta (Tarea 5 condicional) |
| Suite operativa CONFIG_POR_ALIAS (`ops/scripts/{aplicar-separacion-config,censo-config-por-alias,separar-config-alias,update-alias-config}.sh/.py/.mjs` + sus 5 tests) | ~600 | Apagada por defecto; sigue activa en código |

## Referencias vivas rotas a sabiendas (se resuelven en FASE 3)

| Fichero | Ref | Resuelve |
|---|---|---|
| `ops/scripts/source-digest.py` L150, L158 | `"ops/compose.rollback-bridge.yaml"`, `"ops/rollback-bridge"` en `VERIFICATION_OPERATIONAL_INPUTS` | Codex: excluir entradas o apuntar a `_legado/` |
| `ops/tests/source-digest-domains.test.mjs` L116, L126, L128 | `'ops/compose.rollback-bridge.yaml'`, `'ops/schemas/rollback-bridge.schema.json'` en sentinels | Codex: mismo arreglo |
| `ops/runbooks/backup-restore.md` L27, L177 | `./scripts/restore.sh` | `restore.sh` está en `_legado/ops-scripts/`; el runbook se reescribe en FASE 3 (`plan-reestructura/31`) |
| `deploy/compose.yaml` | declaraba `relay-worker`, `shadow-router`, `shadow-guard` (en profiles nunca encendidos) | Se reescribe en FASE 3 (`plan-reestructura/31`); hoy ya está canónico (`00f8e6e`) |
| `ops/scripts/stack-health.sh`, `fault-compose.sh`, `smoke-runtime-authentic.sh`, `tests/unit/relay-telegram-observability.test.ts` | mencionan los servicios por nombre de compose (strings), no por import | Siguen funcionando; el ref sigue siendo válido como cadena literal |

## Cómo recuperar cualquier cosa

Todo el repo previo a la purga de ramas del 2026-08-27 (146 ramas locales, 134 remotas, worktrees)
está archivado en:
- `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle` — `git bundle`, historia completa. Ej.: `git fetch <bundle> consola/editor-directiva-20260823:recuperada/editor`
- `/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz` — copia cruda de los 7 worktrees que tenían trabajo sin commitear (ese trabajo también quedó commiteado en ramas dentro del bundle).

Para revivir cualquier pieza: `git mv _legado/<ruta> <ruta-original>` y resolver las refs vivas
rotas de la tabla anterior. La subruta espejada (`ops/...`, `services/...`, `tests/...`) hace que
las búsquedas por basename sigan funcionando.
