# Contexto del repositorio para agentes

Cauce V3: bus de mensajería durable entre agentes de IA en CLI (Claude Code, Codex, OpenClaw) de 4 tenants, con consola web de operador y puente Telegram (el canal más usado). PostgreSQL es la única fuente durable; el gateway expone HTTP/WS; la entrega es *pull* por WebSocket desde el adapter de cada agente (el "dispatcher" NO reparte: es el segador de reintentos).

**HAY PRODUCCIÓN VIVA en esta máquina** (contenedores `cauce-v3-prod-*`, timers systemd `cauce-*`). No la toques: ni reiniciar, ni escribir en su base, ni desplegar. El despliegue es exclusivamente FASE 3 con el dueño (`plan-reestructura/31`).

## Mapa del árbol

- `packages/protocol` — schemas Zod del wire 3.0; se compila primero (`pnpm prepare:runtime`)
- `packages/store` — SQL, migraciones 001–037 y repositorio PostgreSQL (prod está en la 024)
- `packages/adapter-sdk` — conecta un CLI real a Cauce (sesión tmux + ACK durable)
- `packages/mcp-fleet-monitor` — MCP de observación de flota (escrito; sin registrar en ningún alias)
- `services/gateway | dispatcher | terminal-relay | telegram-bridge` — los 4 servicios vivos
- `apps/console` — SPA React del operador
- `ops/` — systemd, pty-agent (terminal dentro de cada contenedor), scripts operativos
- `_legado/` — cuarentena de código sin uso: NO compilar, NO importar, NO usarlo como contexto
- `plan-reestructura/` y `ordenes/` — el plan vigente y tu orden de trabajo
- `docs/bitacora/` — histórico congelado, no confiable como estado actual

## Reglas (las completas: `ordenes/00-PROTOCOLO.md`)

1. Trabaja SOLO en tu sector (tabla del protocolo), DIRECTO en `main` — **prohibido crear ramas** (decisión del dueño: aquí las ramas fueron el cementerio). `git add` solo por rutas propias; nunca `git add -A`, `git add .` ni `commit -a`.
2. Gate por commit: `pnpm typecheck && pnpm lint` en verde (hoy lo están; deben seguir).
3. `git mv` en commits separados de cualquier edición de contenido. Commits ≤20 ficheros.
4. Comentarios: solo restricciones que el código no puede expresar. Prohibido narrar historia, fechar, citar incidentes o personas — los comentarios-ensayo de este repo llegaron a MENTIR y envenenaron a los modelos que los leían.
5. Nada está "hecho" sin pegar la salida del gate. Un despliegue no está hecho sin mostrar el efecto real.
6. Planes nuevos: máximo 100 líneas. Reportes: máximo 5 líneas de prosa.
7. Subagentes: úsalos para lo paralelizable, con ficheros DISJUNTOS por subagente, tope 4, profundidad 1, y solo el proceso principal commitea (sección "Subagentes" del protocolo).

## NO TOCAR (sin excepción)

`packages/store/migrations/**` · cualquier `*.patch` · `deploy/**` · `/etc/cauce-v3` · `/opt` · la base de datos productiva · contenedores y unidades systemd · `_legado/**` (salvo Codex por su orden) · secretos y credenciales.

## Historia mínima que necesitas saber

Este repo quemó ~120B tokens en agosto-2026 porque los agentes escribían features completas y las declaraban hechas sin desplegarlas ni probarlas contra el sistema real, y porque el fan-out sin dueño por fichero produjo hasta 10 versiones paralelas del mismo archivo. El 27-08 se purgó todo a `main` único (archivo de rescate: `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`). No repitas el patrón: sector propio, gate, efecto demostrado.
