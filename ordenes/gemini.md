# Gemini — ORDEN ACTIVA (cierre de tu paquete + intake)

Protocolo de siempre; subagentes a fondo.

## Tarea 1 — Lo que quede de tu paquete de extensión (verifícalo, no lo asumas)
1. **Parte A (tests >800)**: `find apps/console services/terminal-relay services/telegram-bridge tests -name "*.test.*" -not -path "*/node_modules/*" | xargs wc -l | awk '$1>600'` — lo que siga ahí, pártelo (aserciones intocables).
2. **Limpieza de comentarios consola+canales** si no la cerraste: tabla del censo, ~1.400 líneas en consola; conteos antes/después por commit.
3. **Parte D (vista /ayuda)** si no existe.

## Tarea 2 — Intake de la revisión ola 3 (cuando aparezca `ordenes/reportes/claude-revision-ola3.md`)
Lo tuyo probable: calidad de la suite PTY (si algún test resulta tautológico → darle dientes) y runbooks (si algún comando citado falló verificación → corregir el texto).

## Tarea 3 — Deuda menor acumulada de tus sectores en reportes previos
Barre `ordenes/reportes/claude-revision-46-commits.md` y `claude-revision-ola2.md` (hallazgos "menor" de consola/canales aún sin dueño ejecutado: grupos @media gemelos partidos, PtyEntry, etc.) y ciérralos con evidencia por commit.

Gate global + push al cerrar + reporte ≤5 líneas.
