# Verificación de runbooks vivos — ronda 2 minimax

Comando único usado: `ls ops/runbooks/`, `ls ops/scripts/`, `ls ops/systemd/`, `ls ops/tests/`, `ls ops/manifests/`, `ls deploy/`, `ls services/`, `ls packages/store/migrations/`, `grep -rn 'shadow-router\|relay-worker' services/ packages/ deploy/ ops/`, sobre `main` (`7590d44`).

Estado actual relevante para contrastar:

- `services/` vivos: `dispatcher`, `gateway`, `telegram-bridge`, `terminal-relay`. **No** existen `services/relay-worker/` ni `services/shadow-router/` (están en `_legado/services/`, declarado en `_legado/README.md`).
- `deploy/compose.yaml` y `deploy/Dockerfile` siguen declarando `relay-worker` y `shadow-router` (problema conocido, reescritura en `plan-reestructura/31`).
- `ops/manifests/*.yaml` tiene **15** alias (argos, atlas, dedalo, hegel, iza, janus, jarvis, kant, kratos, midas, salva, seneca, socrates, vulcano, **zeus**).
- `ops/scripts/` contiene todos los `.py`/`.sh`/`.mjs` citados por los runbooks (`cutover.sh`, `cutover-rollback.sh`, `canary.sh`, `preflight.sh`, `pin-container-release.py`, `quota-collector.py`, `fleet-watchdog.py`, `host-backup.sh`, `host-backup-monitor.sh`, `telegram-cutover-preflight.py`, `generate-telegram-config.py`, `provision-alertmanager-config.py`, `release-gate.sh`, `backup.sh`, `restore.sh`, `container-adapter-supervisor.sh`, `validate-manifests.py`, `generate-units.py`, `generate-container-units.py`, `container_ops_digest.py`).
- `ops/systemd/` contiene todos los units y timers citados, incluidos `cauce-v3-watchdog@.{service,timer}`, `cauce-v3-reconciler@.{service,timer}`, `cauce-v3-host-backup.{service,timer}`, `cauce-v3-host-backup-monitor.{service,timer}`, `cauce-v3-quota-collector.{service,timer}`, `cauce-v3-backup-alert@.service`, `cauce-v3-compose@.service`.
- `packages/store/migrations/` contiene 005 (channel_bridges), 008 (agent_chain_visibility con `visited_path` y `cycle_cut_enabled`), 013 (quota_observation) — los citados por los runbooks.
- `services/telegram-bridge/src/config.ts` y `services/gateway/src/` existen; `tests/gateway-hardening/identity-rotation.test.ts` existe.
- Ningún runbook vivo referencia `_legado/` explícitamente (limpio).

## Tabla por runbook

| Runbook | Veredicto | Detalle |
|---|---|---|
| `alerting.md` | Vigente | `ops/observability/alertmanager.yaml`, `provision-alertmanager-config.py`, paths `/etc/cauce-v3/...` externos. |
| `alias-cutover.md` | Vigente con caveat | Scripts/units citados existen. Menciona "V2 sigue autoritativo" / "V2 = 0 antes de cutover": la separación V2/V3 ya no se ejecuta salvo como rollback (en `_legado/rollback-bridge/`); la dual-stack ya no es operativa, solo de rollback. |
| `authentication.md` | Desactualizado en 1 línea | L128–129: "`relay_provider_module` en el import del relay worker" — `services/relay-worker` está en `_legado/` desde la cuarentena; el secret/env ya no existe en runtime. |
| `backup-restore.md` | Vigente | Scripts (`backup.sh`, `restore.sh`, `host-backup.sh`, `host-backup-monitor.sh`, `ut-nexus-backup*.py`) y units existen; referencia `agora-storage`/`nass-stev` (infra externa). |
| `container-adapters.md` | Vigente | 15 manifests, 15 units generadas, scripts (`generate-container-units.py`, `container_ops_digest.py`, `container-adapter-supervisor.sh`, `pin-container-release.py`) existen. |
| `e2e-integration.md` | Desactualizado en 1 línea | L27: "`binarios finales gateway/dispatcher/**relay-worker**/telegram-bridge/**shadow-router**`". Ambos están en `_legado/`; `ops/compose.authentic.yaml` los declara pero `services/*/dist/main.js` no se construye. La clase QA `test-compose-authentic` está rota hasta `plan-reestructura/31`. |
| `encender-un-alias.md` | Vigente | Runbook operativo del CLI `cauce` (externo al repo) y del contenedor `cauce-v3-prod-telegram-bridge-1`; no cita paths del repo. |
| `fleet-watchdog.md` | Desactualizado en 1 lista | L15: "Expected aliases (14)" enumera 14 nombres pero omite `zeus`. La flota real son 15 (ver `ops/manifests/`). El script funciona; solo el conteo/lista del doc está desfasado. |
| `ha.md` | Vigente (condicional) | Describe una topología HA **aún no ejecutada**; menciona `test-compose-authentic` (roto, ver arriba) como evidencia exigible. La sección "Ensayo obligatorio" sigue siendo referencia correcta de qué probar antes de promover. |
| `incident.md` | Vigente | Triage genérico; rutas (`/health/live`, `/health/ready`, métricas) existen en gateway. |
| `quota-collector.md` | Vigente | `ops/scripts/quota-collector.py`, `ops/config/quota-collector*.example`, `ops/systemd/cauce-v3-quota-collector.{service,timer}`, `ops/pty-agent/cauce_pty_agent.py`, migration 013, `ops/tests/test_quota_collector.py` — todos existen. |
| `systemd.md` | Vigente | `cauce-v3-compose@.service` (template) usa `systemd-stack.sh` ✓; `release-gate.sh` ✓; `deploy/compose.dev.yaml` ✓. |
| `telegram-cutover.md` | Desactualizado en 1 línea | L15: "No toca `apps/console`, `packages/**`, `ops/container-*`, **`services/relay-worker`**". `services/relay-worker` está en `_legado/`; el sector ya no existe. El resto del runbook (migration 005, `telegram-cutover-preflight.py`, `generate-telegram-config.py`, `config.ts`) está vigente. |
| `enable-cycle-cut.sql` | Vigente | Migration 008 (`008_agent_chain_visibility.sql`) define `agent_chain_policies.cycle_cut_enabled` y `agent_output_materializations.visited_path`; las queries del archivo son correctas. |

## Resumen ejecutivo

- 9 vigentes sin cambios (`alerting`, `backup-restore`, `container-adapters`, `encender-un-alias`, `ha`, `incident`, `quota-collector`, `systemd`, `enable-cycle-cut.sql`).
- 2 vigentes con caveat (`alias-cutover.md`: dual-stack V2/V3 ya no es operativa salvo como rollback; `ha.md`: cita una QA rota como evidencia exigible).
- 4 desactualizados en una sola línea cada uno (`authentication.md`, `e2e-integration.md`, `fleet-watchdog.md`, `telegram-cutover.md`), todos por referencias colgadas a `relay-worker` / `shadow-router` o por una lista de aliases incompleta.
- 0 deberían ir a bitácora. Ninguno describe la cuarentena ni la supresión de la maquinaria de release como tema central; sólo arrastran referencias rotas a componentes que están en `_legado/`.

Recomendación al integrador: correcciones de 1–2 líneas cada una en los 4 desactualizados. No mover ninguno a bitácora.