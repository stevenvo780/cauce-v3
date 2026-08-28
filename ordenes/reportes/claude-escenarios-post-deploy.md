# Informe post-deploy: los 5 escenarios contra producción tras el despliegue real

Ejecución: 2026-08-28T14:52–14:58Z. Deploy: commit caa8789a (14:48–14:52Z), esquema 024→037, 10 contenedores recreados, smoke 7/7. Comparación contra `gemini-escenarios-pre-deploy.md` (13:15Z).

## Los 5 escenarios

| # | Sonda | Resultado medido (DESPUÉS) | Veredicto | vs ANTES |
|---|---|---|---|---|
| 1 argos | `cauce argos estado` | pid 3617467 (mismo, sin reinicio), bus online, **epoch 31** (igual), latido hace 1s, cola vacía, último ACK 14:10 hace 43m (done) | **FUNCIONA** | IGUAL |
| 2 janus | `cauce janus estado` | pid 3065110 (mismo), bus online, **epoch 7602** (igual), latido hace 10s, cola vacía, último ACK 13:03 hace 1h (done) | **FUNCIONA** | IGUAL |
| 3 hegel | `cauce hegel estado` + SQL `deliveries` | pid 3686940 (mismo), bus online, **epoch 27** (igual), latido hace 8s, último ACK 13:01 hace 1h; **siguen 2 reintentando**, la más vieja 12d | **DEGRADADO** | IGUAL (ni mejoró ni empeoró) |
| 4 jarvis | `cauce jarvis estado` + SQL `deliveries` | **sin proceso adaptador**, bus **OFFLINE**, epoch 34 (igual), latido **08:48:58 idéntico al segundo** (0 latidos nuevos en >6h), 1 mensaje pending sin reclamar, ahora ~1h54m de espera | **ROTO** | IGUAL |
| 5 CLI/TUI | `cauce {argos,janus,hegel,jarvis,socrates} estado` + `argos sesiones` | 5 aliases diagnosticados, salida limpia y legible, sin fallos de conexión al gateway | **FUNCIONA** | IGUAL (ver hallazgo nuevo en (d)) |

## (a) 14 leases: epoch y latido antes/después

Fuente: `connection_leases` (después) vs `leases-antes.txt`. **Los 14 epochs son idénticos antes/después** — cero reconexiones de ningún adaptador durante el redeploy de gateway/dispatcher/etc.

| alias | epoch | fresco antes→después |
|---|---|---|
| argos 31, atlas 20, gaia 2, hegel 27, heraclito 4, janus 7602, kant 39, salva 31, socrates 31 | sin cambio | t→true (los 9) |
| iza 6, jarvis 34, kratos 30, tales 2, zeus 8 | sin cambio | f→false (los 5, offline ambos lados, mismo `last_heartbeat_at`) |

## (b) Las 2 entregas atascadas de hegel: ¿las segó el dispatcher nuevo?

**No.** Son las mismas dos filas de antes, sin tocar: `a35c0d83` (recipient hegel, sender argos, creada 08-16 03:09, `updated_at` 08-16 03:11:50 — la de "12 días") y `aefdee3a` (recipient hegel, sender heraclito, creada 08-24 02:24, `updated_at` 08-24 02:30:51). Ambas siguen `status='failed'`, `attempt=1/3` (no agotado, no promovidas a `dead`). Ningún `updated_at` cae después de las 14:51Z. El segador de fase 3 (migraciones 025–037) no las alcanzó.

## (c) jarvis: ¿sigue sin adaptador?

Sí, sin cambios. `ps aux` no muestra proceso adaptador para jarvis (solo el pty-agent de terminal-relay, ver (d)); `last_heartbeat_at` es el mismo timestamp exacto de antes del deploy (08:48:58); el único mensaje en cola (`6d69fc86`, `status='pending'`, `attempt=0`) es el mismo que reportó el "antes" (creado 13:01:15Z), ahora con más espera. Cero recuperación, cero regresión: la migración no repara ni empeora un adaptador que ya estaba caído.

## (d) Líneas de error nuevas en los 5 servicios core desde 14:51Z

`gateway`: 1 línea `AuthError 401` (cookie de consola ausente) — respuesta correcta a una petición sin sesión, no es un defecto. `dispatcher` y `telegram-bridge`: 0 líneas error/warn (2 y 1 líneas de log en total, ambas informativas). `postgres`: 5 líneas `ERROR`/`FATAL`, **las cinco generadas por mis propias consultas SQL de esta auditoría** (rol/columna inexistentes en mis primeros intentos), no por los servicios.

**Hallazgo nuevo no cubierto por los 5 escenarios**: `terminal-relay` (el enlace de sesión TUI compartida) muestra un **flapping sostenido connect/disconnect** desde 14:52Z en prácticamente toda la flota — argos y atlas a ~270–280 ciclos/min cada uno, y también janus/hegel/socrates/iza/kratos/**jarvis** a ~90/min — sin amortiguarse en los 6 minutos observados (seguía activo al cierre de este informe, confirmado en los últimos 60s de log). No hay `reason` en el log de desconexión y no hay contenedor viejo para diferenciar "nuevo" de "preexistente", pero un ritmo así, sostenido y sin decaer, no es un patrón sano. No rompe la entrega por bus (los 5 escenarios arriba miden `FUNCIONA`/`IGUAL` por sus propios criterios), pero sí puede degradar el adjunto en vivo a la TUI del escenario 5 y merece revisión antes de cerrar la ventana.

## Conclusiones

1. **Cero regresiones** en los 5 escenarios del dueño medidos por sus propios criterios: 1, 2 y 5 siguen FUNCIONA; 3 (hegel) sigue DEGRADADO igual que antes; 4 (jarvis) sigue ROTO igual que antes.
2. Los 14 epochs de lease son bit-a-bit idénticos antes/después: el redeploy de los 10 contenedores no forzó ninguna reconexión de adaptador.
3. El segador de fase 3 (migraciones 025–037) **no drenó** las 2 entregas de hegel ni recuperó jarvis — quedan como deuda pendiente, tal como anticipaba el informe "antes".
4. Único hallazgo genuinamente nuevo: flapping sostenido en `terminal-relay` desde el redeploy, fleet-wide, sin amortiguarse — fuera del alcance de los 5 escenarios pero digno de seguimiento inmediato.
