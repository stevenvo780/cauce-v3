# Verificación de enlaces y rutas — ronda 3 minimax

Alcance: `README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/arquitectura.md`,
`docs/*.md` (top-level), READMEs de `services/*`, `packages/*`, `apps/*`, `ops/`, `ops/pty-agent/`,
`plan-reestructura/*.md`, `ordenes/**/*.md`, `_legado/README.md`.

Método: extracción de refs en código entrecomillado (`…`) y enlaces markdown (`[…](…)`),
filtrado de placeholders (`<…>`, `**`, `*`, `<dir>`, `<instancia>`, `<timestamp>`,
`<CODEX_HOME>`), rutas runtime fuera del repo (`~/.…`, `/etc/cauce-v3`, `/opt`, `/run`,
`/home`, `/proc`, `/dev`, `/usr`, `/datos/agents`, `/var`, `/v3`, `wss://`, `HOME=`),
URLs (`http://`, `mailto:`), y keywords de PostgreSQL/rutas (`LISTEN/NOTIFY`,
`route/read/control`, env=val, `@cauce/*`, `linux/amd64`). Las refs resultantes
se contrastan contra el repo y, cuando procedía, contra sus vecinas obvias.

Veredicto global: **2 correcciones aplicadas** (`apps/console/README.md`,
`docs/consola-roles-con-nombre.md`). El resto son abreviaturas, refs a runtime
o plan-documentos de trabajos en curso que se reportan a continuación.

## Tabla: rutas corregidas

| Fichero | Ruta rota | Corregida a |
|---|---|---|
| `apps/console/README.md` | `App.tsx` (L5) | `src/App.tsx` |
| `apps/console/README.md` | `features/terminal/pty-session.ts` (L5) | `src/features/terminal/pty-session.ts` |
| `apps/console/README.md` | `features/live/FicherosTab.tsx` (L7) | `src/features/live/FicherosTab.tsx` |
| `apps/console/README.md` | `api/client.ts` (L7) | `src/api/client.ts` |
| `docs/consola-roles-con-nombre.md` | `024_role_templates.sql` (L53) | `024_agent_role_templates.sql` |
| `docs/consola-roles-con-nombre.md` | `packages/store/migrations/down/024_role_templates.sql` (L120) | `packages/store/migrations/down/024_agent_role_templates.sql` |

## Tabla: rotas pendientes (decisión del integrador)

| Fichero | Ruta | Por qué no se corrige |
|---|---|---|
| `_legado/README.md` L12 | `ordenes/codex.md` | Era la ruta vieja antes de `ronda1/ronda2/ronda3/`. Vive en cuarentena y su contenido habla de `codex` como asignado a la cuarentena — la dir vieja ya no existe. El ref desde dentro de `_legado/` documenta precisamente que esa organización cambió; dejarlo tal cual es coherente. |
| `_legado/README.md` L14, L19 | `deploy/deploy.sh` | No existe aún. `plan-reestructura/31` lo planifica como reemplazo simple de la maquinaria de release. FASE 3. |
| `docs/terminal-pty.md` L251 | `ops/runbooks/rollback.md` | No existe. El único `rollback.md` está en `docs/bitacora/rollback.md` (histórico) y trata del mismo tema. Pendiente de un runbook vivo o de mover el de bitácora a `ops/runbooks/`. |
| `docs/consola-roles-con-nombre.md` L3 | "PENDIENTE, no implementado" | El doc se autodeclara plan; sin embargo `packages/store/migrations/024_agent_role_templates.sql` ya existe en `main` (commit posterior a la redacción). La cabecera miente sobre el presente; el integrador decide si mover el doc a bitácora o reescribir la cabecera para reflejar lo implementado. |
| `ordenes/ronda1/codex.md` L7 | `deploy.py`, `existing-gate.sh`, `untracked-emergency-gate.py` | Se citan como ejemplos a investigar para mover a `_legado/ops-scripts/` ("verifica con `git grep` qué más pertenece al conjunto"). Ninguno de los tres existe hoy — o se movieron sin dejar rastro o nunca existieron con esos nombres exactos. La acción ya fue evaluada por Codex; el informe es histórico. |
| `plan-reestructura/13-carpinteria-backend.md` | `repository/{messages,deliveries,config,agents}.ts`, `routes/{core,console,health,legado-candidato}.ts`, `bin/experimental/`, `openclaw.js` | Plan de partición con progreso parcial: solo `repository/{outbox,jobs,observability,quotas}.ts` están extraídos. Las refs restantes son objetivos del propio plan; no son enlaces "rotos" en sentido estricto sino trabajo por hacer. |
| `plan-reestructura/14-carpinteria-consola.md` | `src/features/topology/TopologyPage.tsx`, `src/features/_grafo/`, `styles.css`, `ficheros.ts`, `pty-session.ts`, `features/terminal/`, `limpieza/comentarios-20260827` | Plan de Gemini. `TopologyPage.tsx` y `_grafo/` fueron declarados fuera de uso en ronda 2; `styles.css` y `ficheros.ts` son resabios del directorio viejo. Pendiente de reescritura del plan cuando se cierre la ronda 3 de Gemini. |
| `plan-reestructura/00-LEEME.md` | `ops/rollback-bridge/rollback-bridge-schema029.patch`, `limpieza/comentarios-20260827` | Ambos son artefactos borrados (el patch es referencia histórica a un patch grande que ya no se aplica; `limpieza/` era el tar pre-purga). El doc los lista como prohibidos — son refs a "lo que no debe haber", intencionales. |
| `plan-reestructura/11-higiene-raiz-y-worktrees.md` | `PLAN-DIRECTIVE-CONTENT-LECTURA.md`, `tmux-sesion-real.md`, `sesion-compartida-tmux.md`, `ARQUITECTURA_DETALLADA.md`, `INFORME_ARCHIVOS_INCONEXOS_Y_BASURA.md`, `INFORME_COMENTARIOS_HISTORICOS_Y_LIMPIEZA.md`, `dist/`, `rescate/`, `.git/worktrees`, `ops-evidence/`, `scripts/test.sh:14` | Casi todas son refs al estado PRE-purga (worktrees, rescates, `dist/` de builds anteriores). El doc habla del trabajo de higiene que YA SE EJECUTÓ; las refs son históricas y deben quedarse como están. |
| `plan-reestructura/12-cuarentena-legado.md` | `services/shadow-router`, `services/relay-worker`, `ops/rollback-bridge/` | Describe piezas que se mueven A `_legado/`; las refs son al "antes", no a archivos del repo en su estado actual. Intencional. |
| `plan-reestructura/31-despliegue-simple.md` | `deploy/deploy.sh`, `deploy/smoke.sh`, `deploy/HISTORIAL.md`, `migrations/down/` | Plan para FASE 3 — los paths son el "objetivo". `migrations/down/` sí existe (`packages/store/migrations/down/`); el resto se crea al desplegar. |
| `plan-reestructura/32-flota-pty-y-guardias.md` | `ops/guardias/host/`, `ops/guardias/kratos/`, `cred-guard.py`, `compose.alertmanager.yaml`, `OnFailure=cauce-alerta@%n.service` | Mix de plan FASE 3 y refs externas (`/usr/local/sbin/cauce-*`). El integrador decidirá al ejecutar el plan. |
| `plan-reestructura/33-gobierno-de-flota.md` | `ESTADO.md`, `.claude/settings`, `packages/store/migrations/**` | `ESTADO.md` no existe (es la referencia a un fichero a crear). `.claude/settings` y `packages/store/migrations/**` son paths runtime / globs, intencionales. |
| `ordenes/ronda3/opencode-minimax.md` | `ordenes/reportes/minimax-enlaces.md`, `…minimax-docs-sueltos.md`, `…minimax-residuos-host.md` | Son los reportes que esta misma ronda entrega; no existían al redactar la orden. Tras commitear este reporte + los otros dos, dejarán de ser "rotas". |

## Tabla: falsos positivos del extractor (refs abreviadas o runtime)

El extractor lista como "rotas" las siguientes refs que **sí son válidas** porque el
contexto (celda de tabla, frase anterior) ya sitúa el directorio padre, o son
ficheros runtime fuera del repo. No se corrigen.

| Fichero | Refs abreviadas válidas |
|---|---|
| `docs/arquitectura.md` | `paste-runner.ts` → `packages/adapter-sdk/src/shared-session/paste-runner.ts`; `tmux.ts` → `…/shared-session/tmux.ts`; `handlers.ts` → `services/dispatcher/src/handlers.ts`; `DirectivaModal.tsx` → `apps/console/src/features/live/DirectivaModal.tsx`; `framing.ts` → `services/terminal-relay/src/framing.ts`. Tablas de celdas como `packages/adapter-sdk/src/ → paste-runner.ts`. |
| `docs/arquitectura.md` | `pty-agent/`, `systemd/`, `generated/`, `manifests/`, `guardias/`, `harness/`, `schemas/`, `observability/`, `config/`, `cli/`, `patches/`, `security/`, `openclaw-gateway/`, `container-runtime/`, `console-login/`, `ai-live/`, `private/` → todos bajo `ops/` (verificado). |
| `docs/arquitectura.md`, `services/gateway/README.md`, `packages/adapter-sdk/README.md`, etc. | `App.tsx`, `plan-reestructura/31`, etc. cuando son abreviaturas dentro de tablas o bullets. |
| `docs/consola-roles-con-nombre.md` | `configuration.ts`, `024_role_templates.sql` (ya corregido), `down/`, `areas.ts`, `roles.ts`, `RolesPanel.tsx`, `apps/console/src/api/types.ts`, `packages/adapter-sdk/src/harnesses/shared.ts:136`. Todos existen (los nombres de archivo van precedidos del path padre). |
| `docs/directiva-ficheros-del-agente.md` | `config.toml`, `openclaw.json`, `.credentials.json`, `auth.json`, `.claude.json`, `main.ts` → ficheros runtime en `~/.openclaw`, `~/.claude`, `<CODEX_HOME>`, `/home/claw`. No son paths del repo. |
| `docs/terminal-pty.md` | `pty_agent_identities.json`, `grants.json` → `/etc/cauce-v3/terminal/{pty_agent_identities,grants}.json` (runtime). |
| `ops/README.md` | `alias-runner.sh` → `ops/scripts/alias-runner.sh`; `container-adapter-supervisor.sh` → `…/scripts/…`; `pin-container-release.py`, `source-digest.py`, `build.json` → todos en `ops/{scripts,artifacts/release}/`. `artifacts/compose-authentic`, `artifacts/release-candidate/`, `report.json` son directorios de salida del release. |
| `ordenes/ronda1/codex.md` | 17 scripts `.sh`/`.py`/`.mjs` referenciados — todos en `ops/scripts/` (la inmensa mayoría siguen VIVOS, no se movieron a `_legado/`). `apps/console/src/api/client.ts:265,275` → existe. `terminal/plugin.ts` → `services/gateway/src/terminal/plugin.ts`. |
| `ordenes/ronda1/gemini.md` | `styles.css`, `ficheros.ts`, etc. → referencias dentro de `apps/console/src/`. |
| `ordenes/ronda1/opencode-minimax.md` | `basura/`, `rescate/`, `dist/`, `ops-evidence/` → refs al estado pre-purga (histórico). |
| `ordenes/ronda2/gemini.md`, `…ronda2/opencode-minimax.md` | `OperatorWorkspace.tsx`, `live.css`, etc. → refs a `apps/console/src/features/`. |
| `_legado/README.md` | `deploy/deploy.sh`, `fault-compose.sh`, `smoke-runtime-authentic.sh` → refs a scripts vivos (`ops/scripts/`) que mencionan por nombre de compose las piezas de `_legado/`. El propio README aclara que son strings, no imports. |
| `services/terminal-relay/README.md` | `pty_agent_identities.json` (runtime), `plan-reestructura/32` y `plan-reestructura/21` (forma abreviada de `plan-reestructura/32-flota-pty-y-guardias.md` y `plan-reestructura/21-correcciones-mapeadas.md`). |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `README.md`, `packages/store/README.md`, `ordenes/reportes/minimax-adr.md`, `ordenes/reportes/minimax-runbooks.md`, `plan-reestructura/*` | `plan-reestructura/31` → `plan-reestructura/31-despliegue-simple.md` (forma abreviada, ya usada en todo el repo). |

## Resumen ejecutivo

- **6 correcciones** aplicadas en 2 ficheros (commit `2b2d826`).
- **13 referencias pendientes** requieren decisión del integrador (la mayoría son
  planes a futuro o referencias históricas a artefactos borrados, intencionales).
- **El resto** son refs abreviadas (tabla/celda) o runtime (fuera del repo) — válidas.
- 0 paths de runtime productivamente vivos quedaron mal referenciados.