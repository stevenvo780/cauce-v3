# La flota y sus participantes

Fuente de roles por agente: `grupos.json` (raíz). Este doc es el contexto que toda instancia debe tener.

## Máquinas

| Máquina | Papel | Agentes y servicios de la flota |
|---|---|---|
| VPS Cauce (`server`, Tailscale .11) | bus, consola, repositorio y medición de cuotas | doce alias en once contenedores locales, con Atlas y Kratos compartiendo `ws-humanizar` |
| server2 (Tailscale .13) | runtimes permanentes | Kant nativo con Claude; Salva en `ws-isa`, con su acceso público a archivos |
| server1 (Tailscale .14) | virtualización y transcripción de audio | VM `pc-agente` (.15) con Astra/Codex; audio de Telegram en CPU |
| ILS (Tailscale .5) | sesiones dedicadas de navegador | fuentes de cuota consultadas directamente desde el VPS |
| Workstation `kratos` (Tailscale .1) | desarrollo personal y respaldo | los runtimes de la flota, audio y acceso de archivos de Salva están retirados; las cuotas ya no se publican desde aquí |

El registro y `ops/flota.json` describen quince agentes. `ops/container-aliases.json` contiene
sólo los trece alias que viven en Docker; los hosts nativos son Astra y Kant. La ubicación no
se deduce del nombre del harness. Los respaldos conservan las copias anteriores al traslado.

## Humanos y sus grupos
- **Steven** (dueño/operador): jarvis (asistente personal OpenClaw), zeus (gestor de Cauce e infra de agentes), argos (director general de desarrollo — **OpenClaw**), socrates (dev personal), kant (DevOps de todos los servidores) y astra (Codex en la VM `pc-agente`).
- **Miguel**: janus (asistente multi-empresa), atlas y kratos (devs; kratos suele llevar Demeter y graf), iza (Humanizar), gaia (Finca Directa).
- **Jhon**: hegel (asistente + ventas; mantiene Xenia), tales y heraclito (devs).
- **Isa**: salva (asistente de diseño en ClaudeCode).
- Pablo: retirado.

## Los 5 escenarios esenciales (criterio de éxito del despliegue)
1. Steven→argos por Telegram (nuevo cliente/software/deploy) → argos delega → resultado por Telegram.
2. Miguel→janus (graf, demeter, recurrentes) → delega → Telegram.
3. Jhon→hegel (ventas, Xenia) → delega → Telegram.
4. Steven→jarvis personal por los canales configurados, sin bloquear el trabajo de OpenClaw.
5. Operación por TUI/CLI: esfuerzos, destrabar, prioridades, credenciales, rollouts — la vía de rescate cuando las colas se atascan.

## La visión (resumen; detalle en git: PENDIENTES 915b5c5)
Harness interop · alta/baja de agentes trivial (flota-como-datos) · rotación de credenciales fácil para cuotas inteligentes · **contextos NATIVOS por harness** (editar CLAUDE.md/Codex.md/Soul.md, NO inyectar contexto en cada mensaje) · permisos dinámicos · terminal+TUI de cada agente por web desde cualquier dispositivo · UI clara multi-socio · logs de auditoría de comportamiento (detectar contaminaciones).
