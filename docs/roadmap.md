# Roadmap — qué falta

Cauce V3 corre en producción desde el primer despliegue real (estado a 28-08-2026: commit `caa8789a`, esquema 024→037, 10 contenedores desde el compose canónico del repo). Este documento no describe cómo funciona el sistema (eso es `arquitectura.md`, `flota-y-participantes.md`, `grafo.md`) sino lo que falta, priorizado.

## 1. Inmediato post-deploy

Lo que sigue sin cerrar de la propia ventana de despliegue, antes de dar la fase por terminada.

- **Rollout del launcher PTY con siega**: la instalación vigente del launcher (release `20260825`) no lleva la siega de procesos huérfanos. Se detectaron y limpiaron a mano 12 agentes PTY huérfanos en contenedores (argos ×4, atlas ×4, …) causando ~540 ciclos/min de flapping en `terminal-relay`; el fix manual bajó a 0 ciclos/min pero no sobrevive a un reinicio. Falta desplegar el launcher que sí siega (commit `0a08de4d`) a todos los alias.
- **Gateway acepta agentes `enabled=false`** (seguridad, asignado a codex-1 en `ordenes/codex.md`): el hello mTLS de `/v3/ws` autoriza solo por certificado; `authority.ts:220` filtra `agent.enabled` para enrutar, pero el hello/lease no lo consulta. Verificado en la demo probeta: tras `UPDATE agents SET enabled=false` el gateway siguió respondiendo `hello_ack`. Rompe la promesa de "la baja es 1 UPDATE en BD" hasta que se revoca el cert a mano. Fichero: `services/gateway/src/routes/core.ts` (handler del hello, ~líneas 207-422).
- **Contextos nativos por harness — revisión adversarial RECHAZÓ activar** (flag permanece OFF en main). Cuatro bloqueantes reales, en orden activa de codex-1 (`ordenes/codex.md`):
  1. Topes de truncado de OpenClaw cableados a una constante (`60.000/150.000`) que solo vale para el contenedor `claw`; el resto usa defaults reales distintos (20.000/60.000 o 24.000/90.000) leídos del `openclaw.json` de cada alias, no propagados. `packages/protocol/src/ficheros-del-arnes.ts:141`.
  2. Precipicio de expectativa vencida: la primera entrega con el flag ON converge el bloque A y cambia el SHA del fichero canónico; la segunda entrega falla `NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED` contra la misma expectativa y muere en dead-letter. `packages/adapter-sdk/src/context/native-profile-context.ts:99-141,331-359`.
  3. La allowlist del supervisor no conoce `CAUCE_NATIVE_PROFILE_CONTEXT`: activarlo hoy mata el alias (`die "config key is not allowlisted"`). `ops/scripts/container-adapter-supervisor.sh:176-196`.
  4. Las fórmulas de "generación" del supervisor y del launcher no coinciden (una produce 64 hex, la otra 32), así que el filtro de procesos del launcher no encontraría nada. `ops/scripts/container-adapter-supervisor.sh:483-485` vs `ops/pty-agent/cauce-pty-launcher.sh:149-155`.
  Además: 5 tests de `shared-session` rojos en `adapter-sdk` por aserciones en castellano que la traducción a inglés dejó desfasadas (zona de minimax-1); lado Claude sin alias elegible en producción (único agente Claude, `zeus`, corre TUI compartida y `NativeProfileContext` rechaza `sharedSession`).
- **Revivir o decidir jarvis**: sin proceso adaptador, bus offline desde antes del deploy (mismo `last_heartbeat_at`, 08:48:58Z), 1 mensaje pending sin reclamar. Es el cuello de botella histórico (ver §2). El deploy ni lo rompió ni lo arregló.
- **El cuello de botella OpenClaw**: jarvis migró a WhatsApp porque las colas de Cauce se atascan para OpenClaw. Sin diagnosticar la causa raíz; candidato de primera misión para el Zeus guardián (§2) apoyado en logs de comportamiento (§2).
- **Poda de historiales de BD** y **GC del registry de contenedores** (`cauce-v3-*-legacy`, tags viejos): aprobados en principio por el dueño, backup fresco ya hecho; falta decidir con él qué tablas/antigüedad y ejecutar.
- **Limpiar `prod.env`**: 9 claves sin consumidor (`SHADOW_*`, `CAUCE_RELAY_*`, `CAUCE_COMPOSE_OVERRIDE_MANIFEST`).
- **Archivar `/opt/cauce-v3` y `/etc/cauce-v3/compose-overrides/`**: quedan muertos pero intactos como ruta de rollback documentada; archivar tras un periodo de reposo sin incidentes.
- **Montaje rw de `ws-zeus` sobre el árbol de producción**: `/datos/workspaces/zeus → /workspace` está montado `rw` en el contenedor del propio agente zeus, y ese árbol es desde el despliegue material de producción (prometheus/otel/postgres montan ficheros de ahí). Decisión pendiente del dueño: montar `ro` o sacar del árbol lo que producción monta.
- **`cauce <alias> on` sin `XDG_RUNTIME_DIR` bajo `su stev`**: `systemctl --user start` falla en silencio tras `|| true`, sin diagnóstico. `ops/cli/cauce:549`.
- **Las 2 entregas atascadas de hegel**: `a35c0d83` (12 días) y `aefdee3a`, `status='failed'`, `attempt=1/3`, no agotadas ni promovidas a `dead`. El segador de fase 3 (migraciones 025-037) no las alcanzó; siguen como deuda del escenario 3.

## 2. Producto — los 7 puntos de la visión

Estado de cada punto de `docs/flota-y-participantes.md` §La visión:

| Punto | Estado |
|---|---|
| Flota como datos (alta/baja de agentes trivial) | **Hecho** — demo probeta superada: alta y baja tocando solo BD+CLI, todo lo demás derivado (manifests, units, telegram, aprovisionamiento mTLS). Persiste el hallazgo de seguridad del gateway (§1) y `register-agent-identity.py` sin modo de baja propio (`cauce retirar` debería encadenarlo). |
| Contextos nativos por harness | **Pendiente** — 4 bloqueantes descritos en §1, flag OFF |
| Rotación de credenciales fácil / cuotas inteligentes | **Pendiente** — `quota-collector` se queda como referencia hasta que el CLI integral (abajo) lo absorba; no se rehace todavía |
| Permisos dinámicos | **Pendiente** — sin ronda dedicada |
| Terminal/TUI web desde cualquier dispositivo | **En curso** — el CLI ya opera TUIs vía `cauce-attach`; falta el acceso web (parte del CLI integral) |
| UI clara multi-socio | **En curso** — consola operativa (`/live`, `/observability`, `/messages`); pendiente el mega-refactor (§3) |
| Logs de auditoría de comportamiento | **Pendiente** — no existen hoy; objetivo es detectar contaminación de contextos entre instancias |

**CLI instalable**: hoy es una única fuente rescatada (`ops/cli/cauce`, ~1.446 líneas) que corre solo desde esta VPS. Falta: empaquetarlo como app instalable en cualquier ordenador sin depender de la torre, con autenticación hacia TUIs/máquinas remotas y consumo de cuotas en tiempo real integrado (reemplaza a `quota-collector`). Centro de mando sigue siendo siempre esta VPS; multi-servidor ya tiene precedente (kant).

**Notificaciones recurrentes por agente**: sustituye a la idea descartada de Alertmanager. Cualquier agente puede tener mensajes tipo cron encolados a su canal por el bus; generaliza el patrón ya probado del revividor-de-colas (con su salvaguarda de idempotencia). El primer uso previsto es el Zeus guardián: un timer que lee alertas de Prometheus y publica al bus (~100 líneas, patrón ya existente) — alternativas evaluadas: receptor webhook de Alertmanager, o registrar `mcp-fleet-monitor` en el harness de zeus para que investigue con tools.

**Aislamiento por tenant**: cada tenant en su propio docker con carpetas separadas. El checkout de git hoy lo comparten los 4 tenants; el aislamiento real exige credenciales por-tenant dentro del contenedor de cada uno (patrón `/opt/cauce-v3-secrets/<alias>` ya existe, falta generalizarlo).

## 3. Calidad continua

- **Molienda estricta por zonas, pendiente de promoción al gate** (`lint:estricto:zonas` en `package.json` hoy solo cubre `console`, `services/{terminal-relay,telegram-bridge,dispatcher}`, `tests`). Zonas medidas en rojo y con orden activa (`ordenes/codex-2.md`): `packages/protocol/src` (20 problemas), `packages/mcp-fleet-monitor/src` (15), `packages/store/src` (136), `services/gateway/src` (346). Cada zona se promueve al gate solo cuando cierra en `0 problems`.
- **Traducción de comentarios a inglés**: en curso por zonas (`ordenes/opencode-minimax.md`, `opencode-minimax-2.md`). Cerradas: `adapter-sdk/src`, `dispatcher`, `deploy`, `scripts`, `pty-agent`, las 18 herramientas de `ops/guardias/`. Pendientes: barrido de restos (~51 comentarios en español medidos en la última ronda) en las zonas ya tocadas; tests de consola/relay/bridge; `packages/adapter-sdk/test/**` (zona exclusiva de minimax-1, en curso con la partición del punto siguiente).
- **Particiones >800 líneas**: el trinquete de calidad (`scripts/calidad.mjs`, umbral 800) mantiene una lista de excepciones congeladas en `scripts/calidad-base.json` que solo puede bajar — hoy 21 ficheros en `lineas`, 24 en `fechas`, 810 entradas acotadas en `comentarios`. `shared-session.test.ts` (5.444 líneas, el mayor del repo) tiene plan de partición escrito y ronda activa (`ordenes/opencode-minimax.md`). Quedan además, fuera de la lista congelada o como candidatos futuros: `packages/store/test/agent-output-postgres.test.ts` (2.730), `ops/pty_agent/cauce_pty_agent.py` (2.659), `services/gateway/src/terminal.plugin.test.ts` (2.020), `ops/tests/container-supervisor.test.mjs` (1.712), `ops/container-runtime/cauce-container-runtime.py` (1.652), y varios más entre 800-1.400 líneas.
- **Cirugía de dominios** (planificada, sin ronda asignada): mover `flota/` a su propio dominio, subir consola a la raíz del repo, repartir `ops/` — con checklists derivados de `docs/grafo.md` para no romper consumidores.
- **Mega-refactor de consola**: deudas acumuladas de la revisión de vistas — deep-link en `/terminal` que desbloquearía borrar ~180 LOC más y los casos especiales del router; regenerar `docs/grafo.md`; resolver los 74 asserts-sobre-texto de los tests de consola. Incluye adoptar el patrón "un agente con Chrome revisa legibilidad" en vez de sondas CDP quemadas en código (las 6 sondas de contraste/tipografía/CSP se conservan para ese uso).

## 4. Deuda anotada

- `ops/scripts/generate-container-units.py` no purgaba units huérfanas al dar de baja un alias (`generate-units.py` sí) — **corregido** durante la demo probeta, verificar que la paridad entre ambos generadores se mantenga en cambios futuros.
- `ops/scripts/register-agent-identity.py`: sin modo de baja; la revocación de identidad mTLS hoy es manual. `cauce retirar` debería encadenarlo.
- `packages/store/migrations/**`: fila NADIE del residuo físico BD↔realidad; para el drift físico está el overlay (`ops/flota.json` / snapshot), no nuevas migraciones.
- `container-aliases.json` y `manifests/` siguen sin fusionarse dentro del snapshot único (round 2, sin ronda asignada); mientras tanto son 3 parsers duplicados pineados por G-SNAP-4.
- `/opt/.../fleet_source.py` y su watchdog no están versionados en git; falta añadir el chequeo de paridad BD↔físico al watchdog de 10 minutos (hoy es manual).
- `cauce alta` haciendo el INSERT en BD tras confirmación del operador (hoy el alta es un INSERT manual, documentado pero no asistido por el CLI).
- 7 tests de `ops/` que un censo anterior llamó "huérfanos" no lo son (cubren `alias-lock-exec`, `verify-hermes-runtime`, el reaper del container-runtime, en 3 casos como única cobertura); el único candidato real a limpieza futura es `gate-collector.test.mjs` (tiene gemelo ya wireado).
- `services/gateway`: 1 línea `AuthError 401` observada tras el deploy por petición sin sesión de consola — comportamiento correcto, no defecto, pero sin test que lo fije como contrato.

## Hallazgos de la revisión post-despliegue (28-08, tras el primer despliegue real)

Ordenados por prioridad; cada uno con su zona. Evidencia y reproducción en el historial de git (`git log --grep 'post-ventana'`).

- **RESUELTO 28-08 · gateway/store (bus)** — *(arreglo en el servidor, commit en main; desplegado con la ventana de la tarde)* `acks.ts:140` responde a un ACK con epoch vigente pero identidad ajena con un frame `error fenced` SIN correlación; el cliente no sabe qué evento descartar y derriba la conexión (bucle medido con zeus: 453 reconexiones WS en 5 min). Arreglo: responder `ack_result receipt:'ownership_lost'` correlacionado, como ya hace `staleTerminalReplay` en `routes/core.ts:520-531`; el cliente ya trata `ownership_lost` bien. Complemento: tope de reenvíos por evento en el cliente.
- **Decidido · segador** — Las entregas en `failed` con `attempt<max_attempts` NO se reintentan por diseño: `failed` es un ACK terminal ya aplicado por el adaptador (invariante probado en `packages/store/test/materialization-crosstenantroom-postgres.test.ts`); el segador solo barre claims vencidos (`leased/accepted/started`). Lo que sí merece ticket: `retryable` en el ACK es `false` por defecto y casi ningún harness lo activa, así que fallos transitorios mueren en el primer intento.
- **P0 · adapter-sdk (bus, complemento)** — Un ACK durable cuyo `claim_token` fue superado (la entrega se reclamó de nuevo en otro intento) se reenvía en cada reconexión sin backoff ni tope: el gateway responde FENCED (`ACK identity does not own this delivery claim`), el adaptador lo trata como error de conexión y reconecta (~2/s; 453 reconexiones WS en 5 min medidas con zeus). Debe descartarse el ACK superado y avanzar. Mitigación operativa: vaciar `outbox.json` del alias con el adaptador parado (copia de seguridad) y cerrar la entrega agotada.
- **P0 · plano PTY** — `cauce-v3-pty@heraclito` y `@tales`: unit `inactive` pero agente PTY vivo y conectado al relay. Un `systemctl start` rutinario duplicaría el agente y reabriría el bucle del relay. No arrancarlas hasta desplegar el launcher con la siega (`ops/pty-agent/cauce-pty-launcher.sh` ya la trae; la release instalada `ops-pty-home-20260825` no).
- **Sin resolver · incidente 08:49Z** — Los 4 supervisores recibieron SIGKILL simultáneo desde fuera; el médico queda exonerado (no existe como unit ni en la torre ni en el VPS, y no escribió bitácora ese día) aunque su bug de substring era real y ya está cerrado. Única pista: a esa hora 5 instancias IA trabajaban como root en el VPS. Si se repite: `journalctl _COMM=kill` y auditd sobre `kill()` a los MainPID de `cauce-v3-container-*`.
- **P1 · torre (kratos)** — Instalación vieja de la flota bajo `stev`: drop-ins `pty@dedalo`/`pty@midas` (agentes de Pablo, que no existen), units `container-{atlas,kratos,dedalo}` inactivas, y `salva` corriendo el release `bus-v3-20260814-umbral-espera`. Entra en el rollout del release de adaptadores; purgar lo de Pablo.
- **P1 · release de adaptadores** — El `container-aliases.json` instalado (release 20260825) difiere del canónico en 5 alias (argos/iza/tales harness, gaia/heraclito nuevos, y kant mapeado al contenedor de argos). Rollout con las units generadas en `ops/generated/container-systemd/rootless/` (G1 + `rollout-pty`).
- **P1 · observabilidad** — Alertmanager no está desplegado y prometheus apunta a `alertmanager:9093`: 7 alertas críticas encendidas que nadie recibe (entre ellas `CauceOriginOutboxStalled` desde el 24-08) y un job `cauce-origin-relay` que no existe. Decisión del dueño: notificaciones tipo cron por agente en vez de Alertmanager; hasta entonces, silenciar el job inexistente.
- **P1 · producto (origin_relay)** — La única fila de `adapter_outbox` con `adapter='console'` lleva días sin consumidor: el worker de `origin_relay` filtra por `telegram`. O el encolado traduce el adaptador, o se registra un worker para `console` (`CAUCE_RELAY_ADAPTERS`).
- **P2 · dead letters** — 576 entregas, 64 origin_relay y 1405 wake en cartas muertas sin triaje; las 2 de hegel de hace 12 días siguen en `failed` (el segador no las toca). Triaje por lotes con los humanos de cada tenant.
- **P3 · seguridad de ws-zeus** — El contenedor del dueño monta `/var/run/docker.sock` y el árbol del repo (material de producción) en rw, con `claude --dangerously-skip-permissions`. Retirar el socket o proxy con scopes; decidir `ro` para lo que prod monta.
- **P3 · host** — `docker builder prune` periódico (~15 GB reclamables; disco al 83%). CI nocturno ya corre como root (el mix root/stev lo tumbaba a los 17 s).

## Post-perfiles (28-08 por la tarde)

- **Hecho · flota 12/12 al día** — los 12 alias locales en `bus-v3-20260828-perfiles2` + supervisor `ops-main-20260828`, unit activa, lease vivo y perfil sembrado (kratos/atlas con config aislada por alias). `applied_revision` avanza cuando cada arnés consuma su primer turno real (contrato 035); hasta entonces es NULL aunque los ficheros ya estén en disco.
- **Hecho · cirugía de mounts** — `agv2-jhon-heraclito-oc` y `ctrl-infra` recreados con binds persistentes (.claude/.claude.json; .openclaw/clawd): sus datos de arnés vivían en capa efímera y el supervisor nuevo lo cazó (fail-closed, trabajando como fue diseñado). Los contenedores viejos quedan PARADOS como respaldo: `*-pre-mounts-20260828` — purgar cuando el dueño valide. El workspace de argos sigue ya la convención `{home}/clawd` (BD: user=dev, home=/home/dev).
- **P1 · imagen claw:latest** — hornea claude 2.1.150 y el supervisor solo acepta el binario en `~/.local/bin` o `~/.npm-global`: cada recreación exige reinstalar la versión esperada + symlink (hecho a mano en heraclito). Hornear versión y ruta en la imagen.
- **P1 · rollout perfiles3 a argos** — el tope por fichero de openclaw vetaba TODA la siembra de argos porque su TOOLS.md (117 KB, no gestionado) se medía igual; arreglado en protocolo (`comprobarTopes` ignora ficheros que no se escriben) con test. Falta: bundle `perfiles3`, pin de argos y verificación; el resto de la flota puede converger al mismo bundle sin prisa.
- **Nota · tests realineados a la flota real** — `b4bc7b9d` (borra migraciones-ficción) dejó 3 tests presuponiendo membresías que ya no siembra ninguna migración; ahora cada test siembra lo suyo (patrón topología).

## Validación final con workflow (28-08 noche, Sonnet×5 + Opus adversarial)

- **Arreglado en el acto · redes de ctrl-infra** — la cirugía de mounts recreó el contenedor con 1 de sus 5 redes (docker run no hereda redes múltiples): healthcheck en rojo (streak 1152) y sin alcance a su docker-proxy ni a ws-zeus/ws-prizma/ws-humanizar/claw. Reconectadas las 4 (`docker network connect`), healthy con streak 0. Regla nueva del runbook de cirugías: capturar `NetworkSettings.Networks` ANTES de recrear y reconectarlas después.
- **Arreglado · respaldo NAS (7 días caído)** — `vps-humanizar-backup` abortaba a diario: ruta vieja `/datos/workspaces/cauce-v3` (el repo vive bajo `zeus/`) y rutas de Pablo inexistentes. Corregido en `/usr/local/sbin/vps-humanizar-backup-to-nas` (steven→`/datos/workspaces/zeus`, pablo fuera del ciclo con nota; respaldo del script en `.bak-20260828`); corrida manual lanzada. **Punto ciego pendiente (decisión dueño):** el monitor de frescura solo vigila el respaldo de la BD, no el del NAS — cubrir ambos.
- **Arreglado · cauce-cred-guard (334 rojos desde el 21-08)** — la fila `claude/socrates` vigilaba una credencial MUERTA de un harness que socrates no usa (codex según BD); retirada del inventario con nota (la credencial NO se tocó). Guard en verde: `problemas=0 compartidas=0`.
- **Arreglado · CI local mudo** — moría en `dubious ownership` (árbol chowneado a stev hoy 21:19 vs unit como root): `safe.directory` a nivel `--system` y relanzado; el gate completo corre ahora.
- **Limpieza** — unit fantasma `cauce-v3-openclaw-gateway@argos` (12 días failed, sin fichero) purgada con reset-failed.
- **Decisión dueño · dovecot** — muerto desde el 13-08 (status 89), proyecto de correo ajeno a cauce: no lo toqué.
- **Nota** — las descripciones de las units instaladas contradicen la BD en argos/iza/kratos (harness viejo); se corrige solo con el rollout de units generadas ya pendiente en P1.
- **Verificado por Opus además**: bus sano de verdad (argos trabajando durante el incidente de redes), respaldo de BD del plano de control OK con restauración aislada verificada, árbol limpio y pusheado.
