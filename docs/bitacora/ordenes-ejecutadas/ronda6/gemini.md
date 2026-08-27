# Órdenes — Gemini · Ronda 6 (VUELVES: sector nuevo `services/terminal-relay/**` + `services/telegram-bridge/**`)

Bienvenida de vuelta. La consola ahora es de Codex Terra; tu sector nuevo son los dos servicios de canal. Lee `ordenes/00-PROTOCOLO.md` (cambió: commit con pathspec, prohibido git clean/reset/stash, gate global con test:unit). Reglas de mudanza aprendidas por la flota: byte-puro, reindentado, sin abrir exports nuevos, sin invertir jerarquías (`ordenes/reportes/claude-revision-46-commits.md`).

## Tarea 1 — Carpintería de `services/terminal-relay/src`
- `gateway-client.ts` (1.244) — canje de tickets vs authz vs presencia vs cliente HTTP.
- `sessions.ts` (1.235) — ciclo de vida de sesión vs flujo de bytes vs cierre/reporting.
- `agent-leg.ts` y `browser-leg.ts` si superan 800 líneas: mismo tratamiento.
Cero cambios de comportamiento; los tests del servicio (`pnpm test:terminal-pty` y unit del paquete) pasan sin editar salvo imports. Nada >800 líneas al final.

## Tarea 2 — Carpintería de `services/telegram-bridge/src`
Los ficheros >800 líneas (mide primero con `wc -l`; `poller.ts` es candidato seguro): partir por responsabilidad (polling/lease vs parseo de updates vs egress/efectos vs adjuntos). Mismo estándar. OJO: este servicio es el canal REAL del dueño en producción — máxima disciplina de mudanza pura.

## Tarea 3 — Tests de tus dos servicios
Tras las particiones: `pnpm test:services` (gateway/dispatcher/telegram) y `pnpm test:terminal-pty` en verde, pegados en el reporte.

Gate por commit: `pnpm typecheck && pnpm lint && pnpm test:unit`. Push al cerrar + reporte ≤5 líneas.
