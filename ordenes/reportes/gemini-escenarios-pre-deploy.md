# Informe pre-deploy: Prueba de los 5 escenarios contra producción actual

Fecha de ejecución: 2026-08-28T13:15:00Z  
Entorno: Producción actual (imágenes heredadas, PostgreSQL en migración 024, gateway/terminal-relay/dispatcher/telegram-bridge vivos).

## Tabla de evaluación de los 5 escenarios

| Escenario | Participantes / Vía | Sonda ejecutada | Resultado medido | Veredicto | Causa probable |
|---|---|---|---|---|---|
| **1. Steven → argos** | Steven (dueño) → Telegram bot `argos` → OpenClaw (`ctrl-infra`) | `ops/cli/cauce argos estado` + inspección logs `telegram-bridge` | Adaptador online (pid 3617467, latido <15s, epoch 31), cola vacía, último ACK OK (hace ~1h), polling Telegram activo. | **FUNCIONA** | Servicio operativo en producción actual. |
| **2. Miguel → janus** | Miguel → Telegram bot `janus` → OpenClaw (`claw-miguel`) | `ops/cli/cauce janus estado` + inspección logs `telegram-bridge` | Adaptador online (pid 3065110, latido <10s, epoch 7602), cola vacía, último ACK OK (hace 10m), polling Telegram activo. | **FUNCIONA** | Servicio operativo en producción actual. |
| **3. Jhon → hegel** | Jhon → Telegram bot `hegel` → OpenClaw (`agv2-jhon-hegel-oc`) | `ops/cli/cauce hegel estado` + inspección logs `telegram-bridge` | Adaptador online (pid 3686940, latido <10s, epoch 27), último ACK OK (hace 12m), pero 2 mensajes atascados reintentando en cola (el más antiguo de hace 12 días). | **DEGRADADO** | Cola con mensajes muertos/reintentos infinitos acumulados por carecer del segador estricto de la migración 037/fase 3. |
| **4. Steven → jarvis** | Steven → OpenClaw (`claw`) | `ops/cli/cauce jarvis estado` + `docker ps` | Proceso adaptador detenido (sin PID), bus OFFLINE (último latido hace 4h), 1 mensaje encolado hace 12m sin consumir. | **ROTO** | Adaptador caído/desconectado del bus; documentado en flota (cuello de botella histórico que desvió tráfico a WhatsApp). |
| **5. Operación TUI/CLI** | Operador → CLI `cauce` (`argos`, `janus`, `socrates`) | `ops/cli/cauce <alias> estado/sesiones` + `ops/cli/cauce socrates ver` con salida limpia | Diagnóstico completo de 12 alias de la flota; visualización en vivo de sesión tmux/TUI sin degradar el bus; salida y desacople limpios. | **FUNCIONA** | Interfaz CLI operativa con lectura de configuración y conexión tmux compartida. |

## Conclusiones para la ventana de despliegue

1. **Escenarios 1, 2 y 5 están sanos**: el paso a las imágenes nuevas y migraciones 025–037 debe preservar la entrega y latidos en argos, janus y la operativa de CLI.
2. **Escenario 3 (hegel)**: los 2 mensajes bloqueados de hace 12 días deben ser drenados/segados durante la ventana (Paso B1 / migraciones).
3. **Escenario 4 (jarvis)**: se confirma que jarvis ya estaba inactivo en el stack previo, por lo que el despliegue no introduce una regresión sino que habilitará su recuperación controlada.
