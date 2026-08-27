# El "dúplex" del CLI cauce: diagnóstico real (27-08 noche, Opus + ssh a kratos)

## El reporte de duplicados estaba mal diagnosticado
`diff` sin comentarios entre `ops/cli/cauce` (565 líneas) y `ops/guardias/cauce-kratos.sh` (568) = **VACÍO**: cero código divergido, solo 2 bloques de comentario con 28 minutos de vida (el recorte de `2a22107` que `2a1a6e1` revirtió solo en guardias). No había "bug latente" entre ellos. La mitad-restricción buena del comentario del stateDirectory (el "NO se deduce del HOME", que protege contra el bug real de `a58feba`) ya está fusionada en `ops/cli/cauce`, sin la fecha que violaba la regla 4.

## La divergencia REAL: el repo entero está detrás del binario que corre
`/home/stev/.local/bin/cauce` — **byte-idéntico en la torre Y en kratos** (sha256 `0639a3c4…`, 63.644 bytes, sincronizado a mano fuera de git) — tiene **1.138 líneas y 41 funciones: 21 NO existen en el repo**, incluido el subsistema completo `cauce <alias> login` (login_claude/codex, huellas, instala_token, credencial_env, choques_de_codex) + ayudantes remotos (remoto_cauce, leer_en_alias, contenedor_alcanzable, turno_en_vuelo…). Cadena de .bak: 43K (08-13) → 63K (08-23), todo POSTERIOR al congelamiento de las copias del repo (07-31). **El patrón "vivió 14 meses solo en el home" sigue activo.** Escaneo de secretos del binario: **LIMPIO** (solo referencias a rutas de credenciales, ningún valor embebido) — apto para subir al repo.

## Lo que hay en kratos (verificado por ssh, no por comentarios)
- `~/.local/bin`: **~30 variantes cauce-\*** vivas (attach, codex-sync, credenciales, directo, esfuerzo, estado, modal-sweeper, quien-consume, sesiones, soltar, tmux-panel, watch…) + ~25 `cauce.bak-*`.
- **6 guardianes systemd --user activos SIN fichero en ops/guardias/**: cauce-attach-guard, cauce-v3-panel-guard, cauce-ai-live, cauce-quien-consume, cauce-cred-guard-kratos, cauce-v3-medico-monitor. El problema que el README de guardias dice haber resuelto el 04-08 volvió a producirse.
- `cred-guard.py` de kratos DIVERGE del repo (tercer fork adicional).
- Los 2 guardianes que SÍ están en el repo (polidin-guard, cred-guard.sh) coinciden byte a byte. `cauce-panel` también está sincronizado.

## Veredictos
- `ops/guardias/cauce-envoltorio-local.sh`: **CONSERVAR** — entregable real (se instala en cada contenedor, hace el ssh a kratos), con hardening en curso (`ops-control` en console-login/README:418); su único casi-gemelo era `cauce-portatil`, ya borrado.
- `ops/guardias/` NO es carpeta de duplicados: es el **manifiesto de restauración de un RAID 0 sin redundancia** (README:3-6). Quitar filas es decisión de recuperación ante desastre → dueño.
- Detalle del trinquete: `scripts/calidad.mjs` no ve ficheros sin extensión → `ops/cli/cauce` es invisible al gate de calidad (anotado para cuando se amplíe EXTS).

## Decisiones del dueño (añadidas a PENDIENTES-DEL-DUEÑO.md como g, h, i)
