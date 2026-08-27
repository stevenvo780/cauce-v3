# _legado — cuarentena

Código medido como **nunca usado en producción** (auditoría 2026-08-27). Se mueve aquí para sacarlo de la vista y del build; **no se borra todavía** — la tala definitiva la decide el dueño. Nada de este directorio se compila, lintea ni testea.

| Pieza | Evidencia de no-uso |
|---|---|
| `services/shadow-router` (+ shadow-guard) | Nunca desplegado; sus 4 tablas `shadow_*` con 0 filas en 5 semanas; herramienta de migración V2→V3 de un solo uso |
| `services/relay-worker` | Nunca desplegado; sustituido por telegram-bridge; su target de Prometheus llevaba 3,5 días caído |
| `rollback-bridge/` + `ops-scripts/{produce,validate}-rollback-bridge-evidence.py` | Reconstruía un commit viejo contra el esquema actual vía un patch de 13.691 líneas; el registro de imágenes resuelve lo mismo con tags |
| `tests/` | Los tests dedicados de las piezas de arriba |

## contingentes (censo 2026-08-27)

52 ficheros del censo de ronda 4 (29 ejecutados + 3 re-verificados de `ops/scripts/`, 4 de Tarea 3, 16 del seguimiento). Evidencia por fichero en plan-reestructura/censo-contingentes.md.

| Subruta | Ficheros movidos |
|---|---|
| `ops/ai-live/` | cauce-ai-live, .service, .timer, cdp.py |
| `ops/cli/` | cauce-panel-guard, cauce-tmux-panel |
| `ops/config/` | cauce-ops.env.example, e2e.env.example |
| `ops/console-login/` | patch-caddy-lista-blanca.py |
| `ops/container-runtime/` | salva-container-keepalive.sh |
| `ops/generated/container-systemd/` | 15 .service + 2 SHA + 15 configs (todo MENOS `rootless/`, que es el vivo) |
| `ops/observability/` | agent-health-metrics.prom, alerts-agent-health.yaml, otel-collector.upstream.example.yaml |
| `ops/schemas/` | rollback-bridge.schema.json |
| `ops/scripts/` | retire-session-host.sh, selftest-postgres.sh, smoke-authentic-restarts.sh |
| `ops/security/` | README-seccomp.md, seccomp-userns.json |
| `packages/adapter-sdk/docs/` | ADDING-HARNESS.md |
| `scripts/` | verify.sh |

`ops/scripts/guard-check.sh` NO se mueve: `/opt/cauce-v3/ops/systemd/{cauce-v3-reconciler,cauce-v3-watchdog}@.service` lo invocan como `ExecStart`.

## Pendiente de mover aquí (asignado a Codex, ver `ordenes/codex.md`)

La maquinaria de release de `ops/scripts/` (deploy-release.sh, pin-production-release.py, release-writer-state.py, release-candidate.py, release-gate.sh, release-build.sh, rollback.sh, rollback-baseline.py, verification-rounds.mjs, capture-release-writer-snapshot.sh — 17.686 líneas) con sus ~13 tests de `tests/unit/`, los targets `release-*` de `ops/Makefile`, y la parte de `ops/scripts/validate.sh` que la ejercita. Cero despliegues logrados en su historia; se reemplaza por `deploy/deploy.sh` simple (plan-reestructura/31).

## Referencias rotas a sabiendas (se resuelven en FASE 3)

- `deploy/compose.yaml` aún declara `relay-worker`, `shadow-router` y `shadow-guard` (profiles nunca encendidos en este host). Se reescribe en plan-reestructura/31.
- `ops/scripts/deploy-release.sh` referencia el productor de rollback-bridge movido — esa maquinaria entera viene aquí de todas formas.
- `ops/scripts/stack-health.sh`, `fault-compose.sh`, `smoke-runtime-authentic.sh` y `tests/unit/relay-telegram-observability.test.ts` mencionan los servicios por nombre de compose (strings), no por import: siguen funcionando.

## Cómo recuperar cualquier cosa

Todo el repo previo a la purga de ramas del 2026-08-27 (146 ramas locales, 134 remotas, worktrees) está archivado en:
- `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle` — `git bundle`, historia completa. Ej.: `git fetch <bundle> consola/editor-directiva-20260823:recuperada/editor`
- `/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz` — copia cruda de los 7 worktrees que tenían trabajo sin commitear (ese trabajo también quedó commiteado en ramas dentro del bundle).
