# La flota y sus participantes

> Snapshot del inventario de flota: consulta la consola y el inventario operativo autorizado para conocer la ubicación actual. Las direcciones de red pertenecen al inventario privado.

La flota operativa y el rol de membresía por agente salen de `ops/flota.json`; `grupos.json` define las descripciones del grupo `hospital` para operador, teseo y perseo, no los roles de toda la flota. Este doc es el contexto que toda instancia debe tener.

## Máquinas

| Máquina | Papel | Agentes y servicios de la flota |
|---|---|---|
| VPS Cauce (`server`) | bus, consola, repositorio y medición de cuotas | once alias en nueve contenedores locales; Atlas, Hegel y Kratos comparten `ws-humanizar` |
| server2 | runtimes permanentes | Kant nativo con Claude; Salva en `ws-isa`, con su acceso público a archivos |
| server1 | virtualización y transcripción de audio | VM `pc-agente` con Astra/Codex; audio de Telegram en CPU |
| Host de navegadores | sesiones dedicadas de navegador | fuentes de cuota consultadas directamente desde el VPS |
| Estación de desarrollo | desarrollo personal y respaldo | los runtimes de la flota, audio y acceso de archivos de Salva están retirados; las cuotas ya no se publican desde aquí |

La clave `fleet` de `ops/flota.json` describe catorce agentes. `ops/container-aliases.json` contiene
los doce alias que viven en Docker; los hosts nativos son Astra y Kant. La ubicación no
se deduce del nombre del harness. Los respaldos conservan las copias anteriores al traslado.

## Humanos y sus grupos
- **Steven** (dueño/operador): jarvis (asistente personal OpenClaw), zeus (gestor de Cauce e infra de agentes), argos (director general de desarrollo — **OpenClaw**), socrates (dev personal), kant (DevOps de todos los servidores), astra (Codex en la VM `pc-agente`) y hades (Grok).
- **Miguel**: janus (asistente multi-empresa), atlas y kratos (devs; kratos suele llevar Demeter y graf), iza (Humanizar), gaia (Finca Directa).
- **Jhon**: tales y heraclito (devs). La flota canónica sitúa a hegel en el tenant Miguel y la sala `grp.miguel`; `ops/harness/fleet.mjs` y la guardia de ventas de hegel aún usan Jhon/`grp.jhon`, una discrepancia pendiente de resolver.
- **Isa**: salva (asistente de diseño en ClaudeCode).
- Pablo: retirado.

## Los 5 escenarios esenciales (criterio de éxito del despliegue)
1. Steven→argos por Telegram (nuevo cliente/software/deploy) → argos delega → resultado por Telegram.
2. Miguel→janus (graf, demeter, recurrentes) → delega → Telegram.
3. Miguel→hegel (ventas, Xenia) → delega → Telegram, según `ops/flota.json`; pendiente conciliar la discrepancia con `ops/harness/fleet.mjs` y la guardia de ventas.
4. Steven→jarvis personal por los canales configurados, sin bloquear el trabajo de OpenClaw.
5. Operación por TUI/CLI: esfuerzos, destrabar, prioridades, credenciales, rollouts — la vía de rescate cuando las colas se atascan.

## La visión (resumen; detalle en git: PENDIENTES 915b5c5)
Harness interop · alta/baja de agentes trivial (flota-como-datos) · rotación de credenciales fácil para cuotas inteligentes · **contextos NATIVOS por harness** (editar CLAUDE.md/Codex.md/Soul.md, NO inyectar contexto en cada mensaje) · permisos dinámicos · terminal+TUI de cada agente por web desde cualquier dispositivo · UI clara multi-socio · logs de auditoría de comportamiento (detectar contaminaciones).
