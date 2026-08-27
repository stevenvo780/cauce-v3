# Gemini — ORDEN ACTIVA (saneo de `tests/` + tus dos gigantes restantes)

Protocolo `ordenes/00-PROTOCOLO.md`. Subagentes en paralelo (máx. 4, disjuntos). Doctrina nueva: lo muerto se BORRA con `git rm` + evidencia en el commit (git es el archivo — no hay cuarentena).

## Tarea 1 — `tests/fleet-release/`: la última suite atada a la maquinaria retirada
`pnpm test:fleet-release` invoca `python3 ops/scripts/validate-fleet-release-evidence.py` y sus `artifacts/` van commiteados como snapshot (teatro medido por la auditoría). Audita: si la suite solo valida evidencia de la maquinaria retirada → `git rm -r` de la suite + script + entrada de package.json + referencia en `scripts/test-all.mjs`, con la evidencia en el mensaje. Si algo prueba comportamiento REAL del producto, sepáralo antes a la suite que corresponda.

## Tarea 2 — Coherencia total de la matriz
1. `scripts/test-all.mjs` + `scripts/test.sh`: que `pnpm test` cuente la verdad de punta a punta (sin suites fantasma ni saltos silenciosos).
2. **Ryuk**: `scripts/test.sh` pone `TESTCONTAINERS_RYUK_DISABLED=true` sin limpieza compensatoria — es la causa de los postgres huérfanos que ya limpiamos una vez. Reactiva Ryuk o añade trap de limpieza, y pruébalo (`pnpm test:store-hardening` no debe dejar contenedores vivos al salir: `docker ps` antes/después pegado en el commit).
3. `tests/helpers/` y suites: elimina duplicación de helpers si la hay (evidencia por símbolo).

## Tarea 3 — Tus dos >800 de consola (foto final de MiniMax)
`apps/console/src/api/types.ts` (1.193) y `features/topology/hypergraph-layout.ts` (962): partir por responsabilidad, byte-puro, estándar de siempre.

## Tarea 4 — INTAKE de la matriz del integrador
Claude está corriendo la matriz pesada completa (terminal-pty, services, gateway-hardening, store-hardening). Cuando publique `ordenes/reportes/claude-matriz-tests.md`: los rojos de TUS sectores (consola, canales, tests/) los arreglas tú con la regla de siempre (prohibido debilitar aserciones; bug real de producto → reporte). Los de store/gateway son de Codex.

## Tarea 5 — Limpieza quirúrgica de comentarios de TUS sectores
`ordenes/reportes/claude-censo-comentarios-basura.md`: borra SOLO lo marcado narrativo/mutilado/ceremonial de **apps/console y terminal-relay+telegram-bridge** (la consola concentra el grueso: ~1.400 líneas, mucho JSDoc ceremonial). Conserva invariantes; sql-strings intocables. Un commit por área con conteo antes/después. (adapter-sdk es de Codex — no lo toques.)

Gate global por commit + push al cerrar + reporte ≤5 líneas.
