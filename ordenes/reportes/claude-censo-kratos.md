# Censo y rescate de kratos (ronda i, autorizada) — 28-08

## Ejecutado
- **18 herramientas vivas versionadas byte-exactas** en `ops/guardias/` (commit af7b7b4, +6.341 líneas): el médico de la flota (3.208 líneas), ai-live (cuota real por CDP), credenciales (renovador OAuth), esfuerzo, estado, attach(+guard), quien-consume, codex-sync, panel-guard, modal-sweeper, destrabar-telegram, directo, sesiones, soltar, tmux-panel, watch, cred-guard-kratos.py — con sus 14 units/timers. Secretos embebidos: NINGUNO (escaneado). Amnistías del trinquete a valor actual.
- **cred-guard.py del repo → kratos** (hash verificado): el guardián vivo ya NO vigila las credenciales fantasma de vulcano/dedalo (ws-pablo).
- **Kill-list ejecutado en kratos**: 93 `.bak` de las familias cauce-* + el binario opencode.bak (150MB) — **159MB liberados**, 240→147 ficheros en `~/.local/bin`. Timers verificados activos después.

## Queda para próximas rondas (NO tocado)
- **Ficción de Pablo en el systemd de kratos**: `~/.config/systemd/user/` tiene `cauce-v3-container-dedalo.service` y drop-ins `cauce-v3-pty@{dedalo,midas,seneca,vulcano}.service.d` — retirarlos cuando la ronda flota-como-datos defina el generador (o a mano en la ventana).
- **`.bak` ajenos a cauce** (claw-menu, chat-claw, nav-guard, puente-audio, vnc-*, ia, cuotas, libro_tareas ×13): otros proyectos del dueño — fuera de mi remit, listados en el censo por si quiere barrerlos.
- `cauce-esfuerzo` menciona "15 alias": revisar contra la flota real de 14 en la evolución del CLI.
- Estos rescatados alimentan directamente el **CLI integral**: ai-live+cuotas → consumo en tiempo real; credenciales+login → auth guiada; estado/attach/esfuerzo → operación.
