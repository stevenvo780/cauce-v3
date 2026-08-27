# Gemini — ORDEN ACTIVA (deudas REALES verificadas + blindaje de tu suite PTY)

La revisión ola 3 (`ordenes/reportes/claude-revision-ola3.md`) midió qué se ejecutó de verdad: tu suite PTY es buena (mordida probada por mutación) pero tiene huecos CRÍTICOS, y dos encargos anteriores NUNCA aterrizaron (runbooks, limpieza de comentarios). Esta orden es explícita — nada de "si quedó pendiente": TODO esto está pendiente.

## Tarea 1 (CRÍTICA, seguridad) — Blindar tu suite PTY
1. **Fijar las listas por LITERAL**: hoy nadie pina la lista blanca de gobierno ni `NEVER_SERVE` — ampliar la blanca a `settings.json` deja las 225 en verde mientras el agente REESCRIBE `~/.claude/settings.json` (ejecución arbitraria). Tests nuevos que asertan las listas contra literales escritos en el test (cambiar la constante = rojo), en las dos direcciones (crecer la blanca / encoger NEVER_SERVE).
2. **Entorno determinista**: la suite da 3 ERROR + 3 FAIL con umask 0002 o TERM raro — los tests fijan su propio entorno (umask/TERM en setUp). Y pytest NO existe en el host: el invocador oficial es `python3 -m unittest discover -s ops/pty-agent`.
3. **Cobertura de `reap_orphan_agents`** (el arreglo del bucle de expulsión, hoy con CERO tests): docker fake — mata solo los del alias con guarda de nombre, no toca al legítimo, tolera lista vacía.
4. **`READ_ALLOWED_BASENAMES` es código muerto** con comentario de invariante: o se usa de verdad o `git rm` de la constante con evidencia.
5. **Engancharla al gate**: `"test:pty": "python3 -m unittest discover -s ops/pty-agent"` en package.json, añadido a `scripts/test-all.mjs` (respeta assertMatrixIsComplete) y como paso de la CI.

## Tarea 2 — Los runbooks DE VERDAD (tu Parte C, jamás ejecutada)
0 de 14 están reescritos (verificado por grep). Hazla tal como se especificó (≤80 líneas, "Cuándo usar / Pasos / Verificar efecto / Deshacer", comandos verificados) e incorpora los comandos-ya-inexistentes que lista el reporte §runbooks. Un commit por runbook.

## Tarea 3 — La limpieza de comentarios DE VERDAD (jamás ejecutada por nadie)
Tabla del censo (`ordenes/reportes/claude-censo-comentarios-basura.md`): tu parte consola (~1.400) + canales + services (192). El trinquete de `lint:calidad` vigila densidad; tras tu limpieza aviso yo para bajar el baseline.

## Tarea 4 — Restos "authentic" (pequeña, precisa)
`compose.sh`, `fault-compose.sh` y `systemd-stack.sh` siguen aceptando `authentic` cuando compose-files.sh ya lo rechaza — `ops/scripts/fault-compose.test.sh` está ROJO (RC=1, 4 casos). Retira el caso en los tres + test en verde. (El stage huérfano del Dockerfile es de FASE 3 — no lo toques.)

## Tarea 5 — Los >800 NO-Codex del baseline (`scripts/calidad-base.json`)
De tus sectores o tierra de nadie razonable: tests grandes restantes, `ops/pty-agent/rollout-pty.py` (1.220), `ops/scripts/update-alias-config.py` (1.244) — byte-puro, con tu suite PTY como red. NO toques `cauce_pty_agent.py` ni `cauce-container-runtime.py` (vuelan en producción; justificados hasta FASE 3).

Gate global por commit + push al cerrar cada tarea + reporte ≤5 líneas por tarea.
