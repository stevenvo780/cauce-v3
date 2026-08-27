# Gemini — ORDEN ACTIVA (paquete de EXTENSIÓN: mucha superficie, dificultad moderada)

Protocolo `ordenes/00-PROTOCOLO.md`. Subagentes en paralelo (máx. 4, disjuntos) — este paquete está pensado para que los uses a fondo. COORDINACIÓN: no toques `ops/harness/authentic*` ni `ops/Makefile` (Codex está retirando la suite authentic ahora mismo).

## Parte A — Partir TODOS los ficheros de TEST >800 líneas de tus sectores
La foto final (`ordenes/reportes/minimax-foto-final.md`) lista ~20 tests >800 líneas. Mide primero (`find apps/console services/terminal-relay services/telegram-bridge tests -name "*.test.*" | xargs wc -l | sort -rn`) y parte cada uno de TUS sectores (consola, canales, tests/ generales) por bloques `describe` afines — un fichero por área temática, byte-puro (las aserciones NO se tocan), imports mínimos. Nada de tests >600 al terminar. Paraleliza: un subagente por fichero grande.

## Parte B — Suite de tests NUEVA para el agente PTY (Python) — solo tests, producto INTOCABLE
`ops/pty-agent/cauce_pty_agent.py` (2.667 líneas, vuela en producción) solo tiene tests unitarios sin socket. Escribe en `ops/pty-agent/tests/` una suite extensa con dobles (sin red real, sin docker):
1. **Framing round-trip** de TODOS los tags (0x01…0x5E): encode/decode, cabecera 5B, límite `MAX_FRAME`, session-UUID de 36B en tags de datos, truncamientos y basura → rechazo limpio.
2. **Guardas de gobierno**: `NEVER_SERVE`, realpath fuera del juego cerrado, escritura CAS (sha esperado equivocado → rechazo sin tocar disco), rollback.
3. **Ciclo de sesión** con socket fake: HELLO→ACK, modos anunciados según config, flujo TAG_STDOUT coalescido, cierre limpio.
4. Cada test con control negativo. Correr con el python del sistema (`python3 -m pytest ops/pty-agent/tests/`), verde pegado en el reporte. Si un test revela un bug REAL del agente: repórtalo en `ordenes/reportes/gemini-bugs-pty.md`, NO toques el producto.

## Parte C — Reescritura VERIFICADA de los 14 runbooks vivos
`ops/runbooks/` (alerting, alias-cutover, authentication, backup-restore, container-adapters, e2e-integration, encender-un-alias, fleet-watchdog, ha, incident, quota-collector, systemd, telegram-cutover, enable-cycle-cut.sql): reescribe cada uno como guía operativa sobria de ≤80 líneas — cada comando citado VERIFICADO (ejecutado si es de solo lectura, o marcado `[no ejecutable en verificación]` si muta), rutas comprobadas con `ls`, sin narrativa ni fechas, con la sección fija "Cuándo usar / Pasos / Cómo verificar el efecto / Cómo deshacer". Un commit por runbook. Los caveats ya anotados (dual-stack solo-rollback, QA rota hasta FASE 3) se integran en el texto.

## Parte D — Si te queda gas: pantalla de ayuda de la consola
`apps/console`: añade una vista mínima `/ayuda` (ruta + componente + test) que renderice la guía de operador: qué es cada vista en una línea y los 3 flujos básicos. Contenido desde un `.md` estático importado. Sin dependencias nuevas.

Gate global por commit (`pnpm typecheck && pnpm lint && pnpm test:unit`, usuario normal) + push al cerrar cada parte + reporte ≤5 líneas por parte.
