# Órdenes — OpenCode/MiniMax · Ronda 4 (ejecutar la cuarentena del censo)

Protocolo: `ordenes/00-PROTOCOLO.md`. Directo a main; **commit con pathspec** (`git commit <rutas> -m ...`); push al cerrar. Contexto: `plan-reestructura/censo-contingentes.md` (censo + refutación doble de cada ítem).

## Tarea 1 — Mover a `_legado/contingentes/` (git mv, conservando la subruta)
Ejemplo: `ops/security/seccomp-userns.json` → `_legado/contingentes/ops/security/seccomp-userns.json`.

```
ops/cli/cauce-panel-guard
ops/cli/cauce-tmux-panel
ops/security/                                   (directorio entero: 2 ficheros)
ops/console-login/patch-caddy-lista-blanca.py
ops/ai-live/                                    (directorio entero: 4 ficheros)
ops/container-runtime/salva-container-keepalive.sh
ops/config/cauce-ops.env.example
ops/config/e2e.env.example
ops/observability/agent-health-metrics.prom
ops/observability/alerts-agent-health.yaml
ops/observability/otel-collector.upstream.example.yaml
ops/schemas/rollback-bridge.schema.json
ops/generated/container-systemd/*               (TODO excepto el subdirectorio rootless/, que es el vivo)
scripts/verify.sh
packages/adapter-sdk/docs/ADDING-HARNESS.md
```

## Tarea 2 — Los 4 de `ops/scripts` (re-verificar in situ ANTES de mover; Codex trabaja al lado)
Para CADA uno: `systemctl list-unit-files 'cauce-*'` + `systemctl --user list-unit-files 'cauce-*'` + `git grep <basename>` fuera de sí mismo. Si CERO instalación y CERO llamador vivo → mover; si aparece algo → NO mover y reportar:
```
ops/scripts/guard-check.sh
ops/scripts/retire-session-host.sh
ops/scripts/selftest-postgres.sh
ops/scripts/smoke-authentic-restarts.sh
```
(`quota-collector.py` NO se toca — override del integrador, ver censo.)

## Tarea 3 — Borrar residuos no trackeados (rm, no git)
```
ops/cli/cauce.bak-login-20260823T000500Z
ops/container-runtime/__pycache__/
ops/tests/__pycache__/
ops/artifacts/predeploy-20260825/
```
`packages/protocol/dist-test/`: si `git ls-files packages/protocol/dist-test` devuelve algo → `git rm -r`; si no → `rm -r`.

## Tarea 4 — Cierre
1. Añade a `_legado/README.md` una sección `## contingentes (censo 2026-08-27)` con la lista movida y una línea: "evidencia por fichero en plan-reestructura/censo-contingentes.md".
2. Gate: `pnpm typecheck && pnpm lint` en verde Y ADEMÁS `python3 ops/scripts/generate-container-units.py --rootless --output /tmp/gen-test && python3 ops/scripts/validate-manifests.py` con rc=0 (los generadores acaban de repararse; no los vuelvas a romper — si algún fichero movido reaparece como "missing operational input", quita su entrada de la lista en `ops/scripts/container_ops_digest.py` como se hizo en 42b044a).
3. `git commit` con pathspec, `git push origin main`, reporte ≤5 líneas.
