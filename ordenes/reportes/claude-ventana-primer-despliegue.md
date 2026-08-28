# VENTANA DEL PRIMER DESPLIEGUE REAL — 28-08-2026 (integrador: claude)

**Resultado: DESPLEGADO.** Commit `caa8789a` en producción a las **14:52:45Z**, `deploy.sh` rc=0 en **89 s**: 10 migraciones en UNA transacción (esquema **024 → 037**), los 10 contenedores recreados desde el compose canónico del repo (fin de `/opt/cauce-v3` y de los 4 overrides), smoke **7/7**. Autorización del dueño por escrito ("tú empieza a desplegar… en serio"); `CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si`.

## Cronología (UTC)
| Hora | Paso | Evidencia |
|---|---|---|
| 13:5x–14:30 | Pre-flight: gate verde en árbol limpio (typecheck/lint/test:unit) · revisión adversarial Opus del runbook · render canónico · binds · imágenes por dentro | `scratchpad/gate-ventana.log`, veredicto Opus (NO-GO inicial, resuelto) |
| 14:36 | Backup fresco `cauce-20260828T143627Z.dump` (58,7 MB, sha256 OK, `pg_restore --list` 62 tablas) | `/opt/_archive/cauce-v3-db-backups/` |
| 14:38 | B1: 3 sesiones fantasma de julio revocadas → 0 | `terminal_sessions` |
| 14:3x | B2: `CAUCE_TERMINAL_RELAY_INSTANCE_ID=749f8af8…` (sha256 DER de `terminal-gateway-client.crt`), copia `prod.env.bak-ventana`; timers `revividor` y `fleet-watchdog` parados | `compose config` OK |
| 14:4x | Ensayos del migrator con la IMAGEN real contra clon del dump: (1) sin B1 → guard 034 aborta con rollback total ✔ · (2) con B1 → 037 en 917 ms, 14/14 agentes, idempotente ✔ · (3b) con **guard de producción activo** → 037 en 848 ms ✔ | `scratchpad/ensayo-migrate*.log` |
| 14:46 | **Intento 1**: migrator abortó en el guard (`direct migration is disabled`) — rollback total, esquema intacto; postgres recreado y sano | `scratchpad/deploy-ventana.log` |
| 14:51–14:52 | **Intento 2**: build (caché) → pin → migrar → `up --wait` → smoke 7/7 → **COMPLETO** | `scratchpad/deploy-ventana2.log`, `deploy/HISTORIAL.md` |
| 14:53 | Post: 14 leases idénticos antes/después (9 vivos reconectados en su mismo epoch), entregas sin pérdida (12519/2466/321/4), consola TLS 200, timers de vuelta | `scratchpad/leases-{antes,despues}.txt` |

## Los 7 defectos que la pre-flight cazó (cualquiera habría tumbado prod o abortado la ventana)
1. `deploy.sh` construía `deploy/Dockerfile` **sin `--target runtime`** → la última etapa es `console` (nginx): un nginx como runtime para gateway/dispatcher/relay/bridge/migrator. (`ea32b838`)
2. La consola se construía con `console/Dockerfile` (nginx de DESARROLLO, 8080 plano) en vez de `deploy/Dockerfile --target console` con TLS y el instance-id horneado. (`ea32b838`)
3. Dentro de la imagen la consola vivía en `apps/console`, fuera del workspace → `pnpm build:console` salía 0 sin construir → sin `dist`. (`8f269cf6`)
4. `compose.yaml` había perdido el default `:-120` del timeout de transcripción → `Number('')=0` → el telegram-bridge moría al arrancar en bucle. (`067b6650`, hallazgo Opus)
5. El instance-id se derivaba del cert equivocado: es el sha256 del DER del cert que el relay presenta **al gateway**; el relay lo valida al arrancar. (`067b6650`, hallazgo Opus; yo lo tenía mal)
6. El guard del migrator esperaba `deploy/runtime/migrate.mjs` (repo) y la imagen lo aplana a `deploy/migrate.mjs` → abortó el intento 1. (`caa8789a`)
7. El runbook citaba una ruta de cert inexistente cuyo `sha256sum` de la nada (`e3b0c442…`) pasaba todos los filtros, `pg_restore` en el host (no existe) y un rollback con `down` que pararía postgres. (`067b6650`)

## Estado que deja la ventana
- Producción corre desde `/datos/workspaces/zeus/cauce-v3` (D3: una sola fuente). **Ese árbol es material de producción**: prometheus/otel/postgres montan ficheros de ahí. No rebasear ni cambiar de rama con prod arriba (no hay ramas, pero `git pull` de `ops/observability/*.yaml` muta prometheus en caliente).
- `/opt/cauce-v3` y `/etc/cauce-v3/compose-overrides/` quedan **muertos pero intactos**: son la ruta de rollback documentada (§8 del runbook). Archivar tras un periodo de reposo.
- prod.env muerto: `SHADOW_*`, `CAUCE_RELAY_*`, `CAUCE_COMPOSE_OVERRIDE_MANIFEST` (9 claves sin consumidor). Limpiar en calma.
- Preexistente, NO regresión: iza/jarvis/kratos/tales sin latido desde 08:49Z y zeus desde hace 3 días; 4 entregas `pending` son para jarvis/kratos/zeus (cola durable esperando a su adaptador).

## Pendiente del dueño (decisiones, no bloquean)
1. **Poda de historiales** (aprobada en principio; tablas/antigüedad se deciden contigo; backup fresco ya hecho).
2. **GC del registry** (`cauce-v3-*-legacy`, tags viejos).
3. Los dos checks MANUALES que pide `deploy.sh`: editar un fichero de gobierno desde la consola y verlo dentro del contenedor; abrir una TUI y verla viva >60 s.
4. Revivir los adaptadores rancios (jarvis es el dolor histórico; el "antes" ya lo tenía ROTO).

## Post-ventana: el incidente de las 08:49Z (preexistente) y su recuperación — 15:00-15:20Z
El dueño vio en la consola a kratos/iza/jarvis/tales/zeus caídos. **Preexistente**: los 4 primeros dieron su último latido a las 08:48:58Z (6 h antes del deploy) y zeus el 25-08. Mecanismo, con evidencia del journal: a las **08:49:03Z los 4 supervisores recibieron SIGKILL a la vez** (el PID principal de la unit es el `docker exec` del adaptador); systemd los reinició y el runtime, fail-closed, rehusó arrancar sobre metadatos de una generación cuyo PID ya no existía (`current-generation adapter PID is absent; metadata was preserved`, exit 78) → `failed`. Hipótesis del asesino, no probada (la torre se reinició y su journal no lo conserva): `cauce-v3-medico-monitor` mata "puentes" por PID con TERM→KILL y los 4 eran justo los agentes callados.
**Recuperación** (operador = equivalente al `remove_metadata` que el runtime ejecuta tras un teardown verificado): PIDs y controladores verificados muertos dentro de cada contenedor → documento archivado como `cauce-v3-adapter.json.preserved-<ts>` (forense intacto) → `systemctl --user -M stev@ reset-failed` + `start`. Resultado: jarvis (vació su mensaje atascado de 6 días), kratos (drenó su cola de 4 h), tales e iza **vivos con lease fresco**. Ojo: `cauce <alias> on` bajo `su stev` no arranca nada (sin `XDG_RUNTIME_DIR`, `systemctl --user` falla en silencio tras `|| true`).
**zeus**: arrancó, pero el dueño lo paró por orden explícita — es su agente Claude con `/datos/workspaces/zeus → /workspace` montado **rw** en `ws-zeus`, y ese árbol es desde hoy material de producción. Decisión pendiente del dueño: montaje `ro` o sacar del árbol lo que prod monta.
**Bucle del terminal-relay** (hallazgo del "después"): ~540 ciclos/min en toda la flota. Causa: 12 agentes PTY huérfanos dentro de los contenedores (argos ×4, atlas ×4, …) — exactamente los PIDs del censo de `pty-huerfanos.md` del 27-08, cuya kill-list nunca se ejecutó, y el launcher instalado (release 20260825) no lleva la siega del commit `0a08de4d`. Ejecutado el BLOQUE A con guarda de identidad conservando el agente más joven por alias: **0 ciclos/min**. Pendiente: rollout del launcher arreglado (G1/rollout-pty).
