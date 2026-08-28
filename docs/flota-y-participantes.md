# La flota y sus participantes (canónico — del dueño, 28-08)

Fuente de roles por agente: `grupos.json` (raíz). Este doc es el contexto que toda instancia debe tener.

## Máquinas
| Máquina | Qué es | Papel | Agentes |
|---|---|---|---|
| **VPS cauce** (Ryzen 9700X) | este servidor | centro de mando SIEMPRE: repo, bus, prod | todos menos kant y salva |
| **Torre** (9950X3D, hostname `kratos`, tailscale .1) | máquina principal de desarrollo del dueño | CLI del dueño, contenedores de prueba, respaldo+`gdrive:` | kant, salva |
| **NAS i5** | almacenamiento | backups nocturnos | — |
| **agora-storage** | Hostinger | proyecto "agora" + auxiliares (hegel-ventas-checkin) | — |
| ils-server / servidores caseros | apagados | disponibles bajo demanda (luz inestable) | — |
| saldantia-vps | VPS de Jhon | servicios de Jhon | — |
| VPS de clientes (Juan, polidinámica) | ajenos | SOLO pruebas de conectividad | — |

## Humanos y sus grupos
- **Steven** (dueño/operador): jarvis (asistente personal OpenClaw), zeus (gestor de Cauce e infra de agentes), argos (director general de desarrollo — **OpenClaw**), socrates (dev personal), kant (DevOps de todos los servidores).
- **Miguel**: janus (asistente multi-empresa), atlas y kratos (devs; kratos suele llevar Demeter y graf), iza (Humanizar), gaia (Finca Directa).
- **Jhon**: hegel (asistente + ventas; mantiene Xenia), tales y heraclito (devs).
- **Isa**: salva (asistente de diseño en ClaudeCode).
- Pablo: retirado.

## Los 5 escenarios esenciales (criterio de éxito del despliegue)
1. Steven→argos por Telegram (nuevo cliente/software/deploy) → argos delega → resultado por Telegram.
2. Miguel→janus (graf, demeter, recurrentes) → delega → Telegram.
3. Jhon→hegel (ventas, Xenia) → delega → Telegram.
4. Steven→jarvis personal (HOY por WhatsApp: cauce se volvió cuello de botella para OpenClaw — dolor a resolver).
5. Operación por TUI/CLI: esfuerzos, destrabar, prioridades, credenciales, rollouts — la vía de rescate cuando las colas se atascan.

## La visión (resumen; detalle en git: PENDIENTES 915b5c5)
Harness interop · alta/baja de agentes trivial (flota-como-datos) · rotación de credenciales fácil para cuotas inteligentes · **contextos NATIVOS por harness** (editar CLAUDE.md/Codex.md/Soul.md, NO inyectar contexto en cada mensaje) · permisos dinámicos · terminal+TUI de cada agente por web desde cualquier dispositivo · UI clara multi-socio · logs de auditoría de comportamiento (detectar contaminaciones).
