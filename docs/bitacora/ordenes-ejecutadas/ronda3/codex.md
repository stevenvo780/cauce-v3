# Órdenes — Codex ultra · Ronda 3 (arquitectura: adapter-sdk y cierre de gateway)

Empezar al cerrar la ronda 2. Protocolo de siempre + las lecciones de tu propia revisión (`ordenes/reportes/claude-revision-46-commits.md`): al extraer módulos, reindenta, NO conviertas privados en `export`, NO inviertas jerarquías (el caso quotas-como-raíz), y un commit por módulo con mensaje que diga lo que toca.

## Tarea 1 — Al mover la maquinaria de release, llévate su séquito completo
Además de los scripts y tests ya listados (r1 T1): los 7 `ops/schemas/*.schema.json` cuyo único consumidor es esa maquinaria (`build-evidence`, `migration-integrity-evidence`, `release-candidate`, `rollback-baseline`, `release-writer-snapshot`, `test-evidence`, `testcontainers-evidence`, `verification-evidence`) y los targets/tests que queden. Al final: `git grep -l "release-candidate\|deploy-release\|pin-production"` fuera de `_legado/` debe dar solo docs.

## Tarea 2 — Carpintería de `packages/adapter-sdk` (los 4 gigantes)
Partir por responsabilidad, mudanza textualmente pura (el estándar que ya demostraste en store):
- `src/sdk/durable-store.ts` (2.060) — persistencia de entregas vs outbox de ACKs vs recovery.
- `src/shared-session/paste-runner.ts` (1.900) — detección de estado del panel vs inyección vs barrera de input.
- `src/shared-session/tmux.ts` (1.529) — wrapper de comandos vs cuarentena de panel vs parseo.
- `src/sdk/engine.ts` (1.322) — bucle WS vs dispatch de entrega vs ciclo de ACKs.
Regla dura: cero cambios de lógica; los 674 tests pasan sin editar (salvo imports). Ningún resultante >800 líneas.

## Tarea 3 — Adapters sin usuarios reales
`src/bin/hermes.ts` y `src/bin/opencode.ts` no los usa NADIE en la flota (medido en producción; `fake` lo usan los tests y se queda). Muévelos a `src/bin/experimental/` con una línea en el README del paquete, y verifica que ningún manifest/config vivo los referencia.

## Tarea 4 — Cierre del gateway (si tu r1 T4 sigue abierta)
`services/gateway/src/app.ts` (~2.700) → `routes/{core,console,health}.ts`; `terminal/plugin.ts` (~2.200) → sesiones/proxy-relay/sondas. Con `health.ts` ya destripado en r2 T4, el gateway queda entero en piezas <800 líneas.

## Tarea 5 — Verificación final de descontaminación de tu sector
`wc -l` de todo `.ts` de `packages/store/src`, `packages/adapter-sdk/src` y `services/gateway/src`: ningún fichero >1.000 líneas (excepto los que justifiques por cohesión en una línea). Pega la lista en el reporte.

Gate completo por commit + push al cerrar + reporte ≤5 líneas.
