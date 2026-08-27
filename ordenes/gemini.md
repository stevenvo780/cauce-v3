# Gemini — ORDEN ACTIVA (sesión nueva: NO necesitas historial; todo está aquí)

ARRANQUE (siempre, en este orden): (1) `git pull`; (2) lee `ordenes/00-PROTOCOLO.md` completo; (3) lee esta orden entera; (4) VERIFICA con comandos qué está hecho ya — no confíes en memoria de nadie. Reglas clave: directo a main, commit con pathspec, `git add` solo tus rutas, prohibido clean/reset/stash/ramas, gate global `pnpm typecheck && pnpm lint && pnpm test:unit` (usuario normal, NO root). **Lanza 4 subagentes en paralelo** con ficheros disjuntos; solo tú commiteas; push al cerrar cada tarea.

ESTADO VERIFICADO al escribir esto (27-08): NADA de lo siguiente está hecho (0/14 runbooks con el formato nuevo; sin tests de listas fijadas; comentarios sin limpiar; fault-compose.test.sh en ROJO). Si al verificar algo YA está verde, sáltalo y dilo en el reporte.

## Tarea 1 (CRÍTICA, seguridad) — Blindar la suite PTY (`ops/pty-agent/tests/`)
1. Tests que fijen POR LITERAL la lista blanca de gobierno y `NEVER_SERVE` de `ops/pty-agent/cauce_pty_agent.py` (hoy: ampliar la blanca a `settings.json` deja 225 verdes mientras el agente puede REESCRIBIR `~/.claude/settings.json`). Ambas direcciones: crecer blanca = rojo; encoger NEVER_SERVE = rojo.
2. Entorno determinista en setUp (umask 0022, TERM=xterm): hoy hay 3 ERROR + 3 FAIL según el host. Invocador oficial: `python3 -m unittest discover -s ops/pty-agent` (pytest NO existe aquí).
3. Cobertura de `reap_orphan_agents` (en `ops/pty-agent/cauce-pty-launcher.sh`) con docker fake: mata solo huérfanos del alias con guarda de nombre, respeta al legítimo, tolera vacío.
4. `READ_ALLOWED_BASENAMES` (constante muerta con comentario de invariante): usarla de verdad o `git rm` con evidencia.
5. Engánchala al gate: script `"test:pty"` en package.json + entrada en `scripts/test-all.mjs` (respeta su assertMatrixIsComplete) + paso en `.github/workflows/ci.yml`.

## Tarea 2 — Runbooks (14 ficheros de `ops/runbooks/`)
Reescribir CADA uno: ≤80 líneas, secciones fijas "Cuándo usar / Pasos / Verificar efecto / Deshacer", cada comando verificado (ejecútalo si es de solo lectura; márcalo si muta), sin narrativa ni fechas. Los comandos-ya-inexistentes están listados en `ordenes/reportes/claude-revision-ola3.md` §runbooks. Un commit por runbook.

## Tarea 3 — Limpieza quirúrgica de comentarios (consola + canales + services)
Tabla por fichero en `ordenes/reportes/claude-censo-comentarios-basura.md`: borra SOLO narrativo/mutilado/ceremonial (consola ~1.400 líneas; services 192), conserva invariantes compactados, PROHIBIDO tocar comentarios dentro de template literals SQL. Conteo antes/después en cada commit.

## Tarea 4 — Restos "authentic"
`ops/scripts/{compose.sh,fault-compose.sh,systemd-stack.sh}` aún aceptan `authentic`; `ops/scripts/fault-compose.test.sh` está ROJO (RC=1). Retirar el caso en los tres + test en verde.

## Tarea 5 — Los >800 no-Codex (`scripts/calidad-base.json`)
Tests grandes restantes de consola/canales/tests, `ops/pty-agent/rollout-pty.py`, `ops/scripts/update-alias-config.py`: partir byte-puro. NO tocar `cauce_pty_agent.py` ni `cauce-container-runtime.py` (producción).

Reporte final ≤5 líneas por tarea, con evidencia (comandos+salidas), y `git push origin main`.
