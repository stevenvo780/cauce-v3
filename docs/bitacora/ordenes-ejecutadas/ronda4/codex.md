# Órdenes — Codex ultra · Ronda 4 (PRIMERO lo saltado: los bloqueantes de despliegue)

Tu carpintería de store/gateway fue excelente (repository 42 líneas, app 408). Pero **saltaste la ronda 2 completa y son BLOQUEANTES de FASE 3** (verificado: el regex catastrófico sigue en `packages/protocol/src/schemas.ts`, no existe `CAUCE_FANIN_FOOTER`, el parche opaco sin auditar). Orden estricto:

## Tarea 1 (CRÍTICA) — Regex de base64
`ordenes/ronda2/codex.md` Tarea 1, tal cual: portar el arreglo del commit `a9ad652` + test con payload ≥5MB. Sin esto, desplegar desde main reproduce el incidente del 6-ago (poller en bucle infinito).

## Tarea 2 — Pie de fan-in tras flag
`ordenes/ronda2/codex.md` Tarea 2, tal cual (default APAGADO + test).

## Tarea 3 — Auditar y portar `store-repository.js`
`ordenes/ronda2/codex.md` Tarea 3, tal cual. Ojo: los ficheros de store cambiaron de sitio (repository/*.ts) — diffea contra el BUILD, no contra rutas viejas.

## Tarea 4 — `health.ts` (sigue en 1.375 líneas)
`ordenes/ronda2/codex.md` Tarea 4, tal cual.

## Tarea 5 — Los 4 gigantes de adapter-sdk (tu ronda 3 Tarea 2, pendiente)
`durable-store.ts` (2.060), `paste-runner.ts` (1.900), `tmux.ts` (1.529), `engine.ts` (1.322) — mudanza byte-pura, 674 tests sin editar, nada >800 líneas.

## Tarea 6 — Cierre y verificación
`wc -l` de todo tu sector: lista de lo que quede >800 líneas con justificación de una línea. Hallazgos del integrador sobre esta ola: revisa `ordenes/reportes/` (llega hoy) y arregla lo tuyo.

Gate por commit (YA GLOBAL): `pnpm typecheck && pnpm lint && pnpm test:unit` — la consola quedó 107/107 y test:unit entra al gate para todos. Push al cerrar + reporte ≤5 líneas.
