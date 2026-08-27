# Verificación de enlaces y rutas — ronda 5 minimax (post-mudanzas de ronda 4)

Alcance: `README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/arquitectura.md`,
`docs/*.md` (top-level), READMEs de `services/*`, `packages/*`, `apps/*`, `ops/`, `ops/pty-agent/`,
`plan-reestructura/*.md`, `ordenes/**/*.md`, `_legado/README.md`,
runbooks en `ops/runbooks/*.md` que cita paths de `ops/`.

Método: extraer refs en código entrecomillado y enlaces markdown sobre los targets anteriores;
contrastar contra el árbol vivo. Las refs intencionales (planes que describen "el antes", refs a
artefactos borrados que el doc prohíbe explícitamente, abreviaturas de tabla/celda, paths runtime
fuera del repo) **no se corrigen** — ya documentadas en `ordenes/reportes/minimax-enlaces.md` (ronda 3)
y se mantienen vigentes.

Veredicto global: **2 ficheros corregidos** (`docs/arquitectura.md`,
`ops/console-login/README.md`). El resto: refs intencionales o runtime que ya quedaron
clasificadas en rondas anteriores. Adicionalmente, se reportan refs rotas en código
producto/test ajenos al sector de MiniMax para que el dueño las asigne.

## Tabla: correcciones aplicadas

| Fichero | Ruta obsoleta | Corregida a | Por qué |
|---|---|---|---|
| `docs/arquitectura.md` L31 | "`packages/store/src/repository.ts` … 11K líneas — Codex lo está partiendo" | "`packages/store/src/repository.ts` (fachada) + `repository/{messages,outbox,jobs,config,observability,quotas}.ts` … ~5,8K líneas; 6 módulos extraídos; siguen dentro: deliveries, agents, fencing" | El particionado es un hecho: 6 de 8 módulos extraídos (commits `6d7cc07`, `b3c588`, `bb9331b`, `c3b7fc9`, `78d80d9`, `72a8cce`); "11K" es del plan, no del repo actual |
| `docs/arquitectura.md` L40 | "`apps/console/src/features/terminal/pty-session.ts` … el cliente WS" | "`apps/console/src/features/terminal/pty-connection.ts` (orquestador: `pty-session.ts`)" | El WS (`new WebSocket`, `openSocket`, `startViewerHeartbeat`, `stopHandshake/Reconnect`) vive en `pty-connection.ts` desde el particionado de `pty-session.ts` (`1ca3312`); `pty-session.ts` los compone con `pty-input/output/theme/types` |
| `ops/console-login/README.md` L328 | "—están en `ops/console-login/` como referencia—" | "—estaban en `ops/console-login/` y el script del parche ahora vive en `_legado/contingentes/ops/console-login/patch-caddy-lista-blanca.py` (censo 2026-08-27; sin uso en este host)—" | El script `patch-caddy-lista-blanca.py` se movió a `_legado/` en `0380cb2` |
| `ops/console-login/README.md` L446 | "`ops/console-login/patch-caddy-lista-blanca.py`" | "`_legado/contingentes/ops/console-login/patch-caddy-lista-blanca.py` (censo 2026-08-27); ya no se conserva copia activa en `ops/console-login/`" | Idem |

## Tabla: refs rotas vivas que NO se corrigen (fuera de sector de MiniMax)

| Fichero | Línea | Ref rota | Por qué no la toca MiniMax | Sector |
|---|---|---|---|---|
| `ops/scripts/source-digest.py` | 150, 158 | `"ops/compose.rollback-bridge.yaml"`, `"ops/rollback-bridge"` en `VERIFICATION_OPERATIONAL_INPUTS` | El fichero `ops/compose.rollback-bridge.yaml` se movió a `_legado/compose.rollback-bridge.yaml` (`9181afc`) y `ops/rollback-bridge/` a `_legado/rollback-bridge/` (anterior a ronda 4). El manifest debería excluir las entradas; de lo contrario `pnpm verify:three-rounds` se intentará hashear archivos que no están y fallará. | Codex (`ops/scripts/`) |
| `ops/tests/source-digest-domains.test.mjs` | 116, 126, 128 | `'ops/compose.rollback-bridge.yaml'`, `'ops/schemas/rollback-bridge.schema.json'` en listas de "sentinels" | Mismo origen: ambos se movieron a `_legado/`. El test falla (verificado en `ordenes/reportes/claude-revision-46-commits.md` §roturas). El integrador (`36c6465`) ya movió 2 tests a `_legado/tests/` (rollback-baseline, source-digest-closure); este sigue sin tocar. | Codex (`ops/tests/`) |
| `ops/scripts/restore.sh` (no existe) | refs en `ops/runbooks/backup-restore.md` L27, L177 | `./scripts/restore.sh` | `restore.sh` se movió a `_legado/ops-scripts/restore.sh` antes de ronda 4; los runbooks siguen citándolo. La ref es operativa y necesita reemplazo por el equivalente de `deploy/` (FASE 3). | Codex (`ops/runbooks/`) |
| `package.json` raíz | `"evidence:release-candidate": "python3 ops/scripts/release-candidate.py"` | `ops/scripts/release-candidate.py` | `release-candidate.py` se movió a `_legado/ops-scripts/` antes de ronda 4 (commit `daf2162`); `pnpm evidence:release-candidate` fallará. No es de ronda 4 (pre-existente) pero sale al barrido. | Codex (release) |

## Tabla: refs intencionales / runtime / pre-existentes (no son rotas)

Las marcadas con "(ronda 3)" ya se documentaron en `ordenes/reportes/minimax-enlaces.md` y siguen vigentes tras ronda 4:

| Fichero | Ref | Por qué se deja |
|---|---|---|
| `_legado/README.md` L14 | `deploy/deploy.sh` | Plan FASE 3, no creado aún (ronda 3) |
| `docs/terminal-pty.md` L251 | `ops/runbooks/rollback.md` | Sigue faltando; el único rollback.md vive en `docs/bitacora/` (ronda 3) |
| `docs/consola-roles-con-nombre.md` L3 | "PENDIENTE, no implementado" | Sigue mintiendo sobre el presente; decisión del integrador (ronda 3) |
| `docs/bitacora/plan-ejecutado/13-carpinteria-backend.md` | `repository/{deliveries,agents}.ts` | Plan parcial; esas extracciones NO se han hecho aún (estados actuales en `repository.ts`) |
| `plan-reestructura/00-LEEME.md` | `ops/rollback-bridge/rollback-bridge-schema029.patch`, `limpieza/comentarios-20260827` | Refs a "lo que no debe haber", intencionales (ronda 3) |
| `docs/bitacora/plan-ejecutado/12-cuarentena-legado.md` | `services/shadow-router`, `services/relay-worker`, `ops/rollback-bridge/` | Piezas que se movieron A `_legado/`; refs al "antes", intencionales (ronda 3) |
| `ordenes/ronda1/codex.md` L7 | `deploy.py`, `existing-gate.sh`, `untracked-emergency-gate.py` | Informe histórico de auditoría; ninguno existe hoy (ronda 3) |
| `ordenes/ronda1/opencode-minimax.md` L9–22 | `ops/cli/cauce-panel-guard`, `ops/scripts/retire-session-host.sh` etc. | Esa misma orden PIDE moverlos; las refs son el "antes" de la mudanza, intencionales |
| `ordenes/reportes/claude-revision-46-commits.md` | refs a `ops/schemas/rollback-bridge.schema.json` en sites ahora en `_legado/` | Reporte del integrador fechado al HEAD post-ronda-4; las refs describen la rotura detectada, intencionales |
| `apps/console/README.md` L5 | `src/features/terminal/pty-session.ts` | El fichero existe (308 líneas tras el particionado); sigue siendo el orquestador |
| `services/gateway/README.md` L15 | "ordenes/ronda1/codex.md, tareas 3–4" | La tarea existe y la partición está hecha (`services/gateway/src/{console,terminal}/`) |

## Resumen ejecutivo

- **4 correcciones** aplicadas en 2 ficheros (round 5 vs ronda 3, donde fueron 6).
- **4 refs rotas vivas** detectadas en código/test, fuera del sector de MiniMax — se reportan a Codex.
- **0 paths runtime productivamente vivos** quedaron mal referenciados (los runtime siguen correctos).
- Las 2 correcciones se limitan a `.md` (gate no necesario); commit con pathspec.