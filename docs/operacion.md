# Manual operativo — Cauce V3

Procedimientos verificados contra producción real. Fuente de verdad de arquitectura: `docs/arquitectura.md`. Fuente de verdad de flota: `docs/flota-y-participantes.md`. Este documento es solo el CÓMO operar; runbooks completos en `ops/runbooks/*.md`.

**Estado a 28-08-2026**: producción corre desde `/datos/workspaces/zeus/cauce-v3` (esquema 037, compose canónico del repo). `/opt/cauce-v3` y `/etc/cauce-v3/compose-overrides/` son ruta de rollback, muertos pero intactos.

## 1. Desplegar

**Precondiciones que `deploy/deploy.sh` verifica y aborta si fallan:**
- `git status` limpio y `HEAD == origin/main`.
- Backup <24h en `/var/backups` (o confirmación explícita si no lo hay).
- `CAUCE_TERMINAL_RELAY_INSTANCE_ID` en `prod.env` = sha256 del DER de `CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH` (el relay no arranca si no coincide).
- `docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml config` renderiza sin error.
- 0 filas en `terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL` (si no, la migración 034 aborta: revocar esas filas primero).

**Precondición que el operador verifica a mano, `deploy.sh` NO la comprueba:** gate en verde
(`pnpm typecheck && pnpm lint && pnpm test:unit`). El script no ejecuta ni un solo comando `pnpm`;
confía en que quien despliega ya corrió el gate.

**Comando** (dueño presente, root, `df -h /` con ≥60GB libres o `docker builder prune -f` antes):
```bash
export CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si
./deploy/deploy.sh
```
Hace, en orden: build de `deploy/Dockerfile --target runtime` y `--target console` (la consola hornea el instance-id) → push y pin por digest SHA256 en `prod.env` → migrator efímero (todas las migraciones pendientes en UNA transacción) → `docker compose up -d --wait --remove-orphans` (recrea los 10 contenedores, reutiliza el volumen `cauce_pgdata` por nombre) → `deploy/smoke.sh`. Registra el resultado en `deploy/HISTORIAL.md` (commitear tras verificar).

**Criterios de parada**: cualquier precondición falla → no arranca. Migrator falla → PostgreSQL
revierte solo la transacción (esquema intacto) y el script muere ahí — pero `prod.env` YA fue
reescrito con los digests nuevos ANTES del migrator (paso previo), así que hay que restaurarlo a
mano desde `prod.env.pre-deploy-<STAMP>`: no es cierto que "nada más se toca". Ningún contenedor
llega a levantarse con los digests nuevos. `up` o smoke fallan → pasar a rollback (tampoco
automático: el script solo imprime la receta, no la ejecuta).

**Rollback exacto** (nunca `docker compose down`: pararía postgres antes de restaurar):
```bash
# 1. Parar todo menos postgres
docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml --project-directory deploy \
  stop gateway dispatcher telegram-bridge terminal-relay console outbox-metrics prometheus otel-collector
# 2. Restaurar prod.env previo
cp -a /etc/cauce-v3/prod.env.bak-ventana /etc/cauce-v3/prod.env   # o el .pre-deploy-<STAMP> que dejó deploy.sh
# 3. Solo si el esquema ya quedó confirmado y hay que volver atrás: verificar sha256, terminar backends, dropdb/restore
D=$(ls -t /opt/_archive/cauce-v3-db-backups/*.dump | head -n 1); (cd "$(dirname "$D")" && sha256sum -c "$(basename "$D").sha256")
docker exec cauce-v3-prod-postgres-1 psql -U cauce -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cauce' AND pid<>pg_backend_pid()"
docker exec cauce-v3-prod-postgres-1 dropdb -U cauce cauce && docker exec cauce-v3-prod-postgres-1 createdb -U cauce cauce
docker exec -i cauce-v3-prod-postgres-1 pg_restore -U cauce -d cauce --no-owner --no-acl < "$D"
# 4. Levantar la versión previa con el compose VIEJO y sus overrides (NO el canónico)
docker compose --env-file /etc/cauce-v3/prod.env -f /opt/cauce-v3/deploy/compose.yaml -f /opt/cauce-v3/deploy/compose.postgres.yaml \
  -f /etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml -f /etc/cauce-v3/compose-overrides/store-fanin.yaml \
  -f /etc/cauce-v3/compose-overrides/terminal-minrows.yaml -f /etc/cauce-v3/compose-overrides/directiva-20260825.yaml \
  --project-directory /opt/cauce-v3/deploy up -d --wait --wait-timeout 300
# 5. Verificar (esquema dirá 024 si se restauró el dump — esperado)
./deploy/smoke.sh
```

## 2. Alta y baja de un agente

Única fuente de verdad: BD (`agents` + `memberships`). Cadena declarativa obligatoria — nunca editar a mano `ops/container-aliases.json`, `ops/manifests/*.yaml` ni `ops/generated/**`:
```
BD (INSERT/UPDATE) → export-fleet-snapshot.py → ops/flota.json → regenerate-fleet.sh → validate.sh → cauce <alias> aprovisionar/retirar
```

**Alta**: `INSERT` transaccional en `agents` (con `enabled=true`) y `memberships`, luego:
```bash
python3 ops/scripts/export-fleet-snapshot.py --out ops/flota.json   # git diff: solo flota.json, alias entra a "fleet"
./ops/scripts/regenerate-fleet.sh                                    # deriva manifest, unit systemd, container-aliases.json, config Telegram
./ops/scripts/validate.sh                                            # gate: hermeticidad byte a byte + checksums
ops/cli/cauce <alias> aprovisionar                                   # cert mTLS + token + clave PTY + PKI de contenedor + token de Telegram
systemctl --user daemon-reload && systemctl --user enable --now cauce-v3-container-<alias>.service
```
**La única pieza que pide un humano**: el token del bot de Telegram, generado en BotFather — `aprovisionar` lo solicita interactivamente y lo registra en `/etc/cauce-v3/telegram-runtime/config.json` (0600).

**Baja**: `ops/cli/cauce <alias> retirar` (para la unit y revoca hash/token) → `UPDATE agents SET enabled=false` → re-exportar snapshot (el alias pasa a `retired`) → `regenerate-fleet.sh` (purga manifest y units huérfanas) → `validate.sh`.

**Aviso de orden (hallazgo verificado hoy)**: `enabled=false` en BD saca al agente del enrutado de entregas, pero el `hello`/lease del gateway se autoriza solo por certificado mTLS — un agente dado de baja en BD puede seguir conectándose hasta que `retirar` revoca su credencial. No dar el UPDATE por baja completa sin correr `retirar`.

## 3. Diagnóstico y recuperación de un adaptador caído

```bash
ops/cli/cauce <alias> estado          # columna ADAPTADOR: activo/failed/inactive
systemctl --user status cauce-v3-container-<alias>.service   # host-<alias> para agentes host-native
```

**`failed` con exit 78 significa un fallo permanente y cerrado; no diagnostica por sí solo la
causa.** La unidad no reintenta ese código. Solo el error exacto
`current-generation adapter PID is absent; metadata was preserved` acredita que ese metadato se
preservó; otros controles de configuración, identidad o integridad también pueden terminar en 78.

No se recupera automáticamente un metadato abandonado de la misma generación. Comprobar solo PID,
grupo, sesión y entorno no demuestra ausencia: un descendiente puede crear otra sesión, ejecutar
con el entorno vacío y seguir vivo. Relanzar en ese estado podría crear dos consumidores. Una
recuperación desatendida exige primero un cgroup dedicado por alias cuya vaciedad sea enumerable.

Sin ese límite no existe una recuperación segura *in-place* basada en `ps`. Inspeccionar el journal
y el metadato sirve para diagnosticar, no para demostrar ausencia. No mover, borrar ni archivar el
metadato y no ejecutar `reset-failed`/`start` basándose solo en ese censo. Mantener la unidad fallida
y escalar al dueño: la recuperación requiere instrumentar el cgroup por alias o detener y recrear,
con autorización, el límite completo que contiene necesariamente todos sus procesos.

```bash
journalctl --user -u cauce-v3-container-<alias>.service -n 50
systemctl --user -M <usuario>@ is-active cauce-v3-container-<alias>.service
```

Confirmar el lease:
`SELECT alias, lease_until > now() FROM connection_leases WHERE alias='<alias>';`.

El médico aplica un veto adicional antes de reiniciar un adaptador: consulta dos veces las entregas
`leased`, `accepted` o `started`, una al entrar al ciclo y otra inmediatamente antes de
`systemctl restart`. La captura conserva solo identificadores y metadatos de ruteo; no consulta ni
registra el cuerpo o texto del mensaje. Cualquier fila impide el reinicio.

Las dos consultas no forman una barrera atómica con `systemctl`: una entrega todavía puede entrar
después de la segunda consulta. Por esa razón el reinicio requiere el interruptor explícito
`--reiniciar-adaptadores`, apagado por defecto, y la unidad versionada usa `--solo-detectar`. No se
habilitó el reinicio automático ni existe reinyección automática del trabajo en vuelo.

## 4. Plano PTY: detectar y segar bucles del relay

Síntoma: `terminal-relay` expulsa (`superseded`) agentes en bucle porque un mismo alias tiene más
de un proceso PTY vivo con el mismo certificado.

```bash
# Detectar: >30 conexiones/2min es bucle (umbral de deploy/smoke.sh)
docker logs cauce-v3-prod-terminal-relay-1 --since 2m | grep -c 'agent_connected"'
```

No usar `pgrep` por substring como censo: omite el argv legado y no acredita el bundle exacto. La
verificación debe comparar byte a byte ambos argv admitidos y la ruta exacta del bundle mediante el
mismo parser de `/proc` del reaper.

El launcher versionado prepara los artefactos, vuelve a validar la generación y después ejecuta la
siega inmediatamente antes del nuevo `exec`. Reconoce de forma exacta el argv actual y el legado.
Exige `PID + starttime + argv`, fija cada candidato con `pidfd`, envía `SIGTERM` y escala a
`SIGKILL` solo si la misma identidad sigue viva. Si no puede demostrar la salida, no lanza el
reemplazo. No seleccionar un PID por antigüedad ni señalizarlo solo por nombre. Detalle: [agente
PTY](../ops/pty-agent/README.md).

Verificación: debe quedar un solo proceso por bundle; repetir el conteo de conexiones tras más de
dos minutos y mantener una sesión TUI abierta durante más de un minuto. Comprobar la versión del
launcher instalada antes de usar la siega como control operativo.

## 5. Backups y timers

| Timer | Cuándo | Qué hace |
|---|---|---|
| `cauce-v3-host-backup.timer` | 03:10 UTC diario | `pg_dump --format=custom` de `cauce-v3-prod-postgres-1` → `/opt/_archive/cauce-v3-db-backups/cauce-<ts>.dump` + `.sha256`; valida con un restore AISLADO (postgres efímero sin red) antes de publicar; retención local 14 días tras confirmar copia off-site; sincroniza a NAS (append-only, nunca borra remoto) |
| `cauce-v3-respaldo-torre.timer` | 04:30 UTC diario | manda los dumps y `/etc/cauce-v3` (tar 0600) a la torre (`kratos`); kratos sube a Drive con `rclone` |
| `cauce-v3-host-backup-monitor.timer` | cada 6h | verifica que el backup corrió y con éxito reciente |
| `cauce-v3-watchdog@.timer` / `cauce-v3-reconciler@.timer` | cada 30s–5min por alias | salud y reconciliación de cada adaptador |
| `cauce-v3-quota-collector.timer` | cada 5min | recolector de cuotas de IA |

Verificar un dump:
```bash
LATEST=$(ls -t /opt/_archive/cauce-v3-db-backups/*.dump | head -n 1)
(cd "$(dirname "$LATEST")" && sha256sum -c "$(basename "$LATEST").sha256")
docker exec -i cauce-v3-prod-postgres-1 pg_restore --list < "$LATEST" | grep -c "TABLE DATA"   # ~60 tablas
cat /var/log/cauce-v3-backup/status.json   # "overall":"ok"
```
**Timers a parar en una ventana de despliegue** (toman locks exclusivos en `agents` durante las migraciones 026/034/037): `systemctl stop cauce-revividor-de-colas.timer cauce-v3-fleet-watchdog.timer` — y `systemctl start` de ambos SIEMPRE al cerrar la ventana, éxito o rollback.

## 6. Smoke y comprobaciones rápidas de salud

```bash
./deploy/smoke.sh   # 7 sondas: gateway ready, 5 contenedores healthy, esquema esperado, leases, entregas done, relay sin bucle, rutas de gobernanza
docker exec cauce-v3-prod-gateway-1 node /app/deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready
docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tAc "SELECT max(version) FROM schema_migrations"                                    # esperar la última de packages/store/migrations (hoy 038_*)
docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tAc "SELECT count(*) FROM connection_leases WHERE last_heartbeat_at > now() - interval '60 seconds'"   # esperar >=8
docker logs cauce-v3-prod-terminal-relay-1 --since 2m | grep -c 'agent_connected"'   # esperar <30
```

## 7. Reglas de oro

- `/datos/workspaces/zeus/cauce-v3` es material de PRODUCCIÓN: prometheus, otel y postgres montan ficheros de ahí directamente. No rebasear, no cambiar de rama con prod arriba (`git pull` de `ops/observability/*.yaml` muta prometheus en caliente).
- `/opt/cauce-v3` y `/etc/cauce-v3/compose-overrides/` son la ÚNICA ruta de rollback probada hasta que se archiven tras un periodo de reposo — no borrar, no tocar.
- `deploy/deploy.sh` exige `CAUCE_FASE3_CON_DUENO=si`: ningún despliegue corre sin el dueño presente.
- Nunca `docker compose down` en producción: pararía postgres antes de poder restaurar. `stop` de los servicios de aplicación, postgres se toca aparte y con backup verificado en mano.
- `ops/container-aliases.json`, `ops/manifests/*.yaml` y `ops/generated/**` son GENERADOS: editarlos a mano los desincroniza de la BD y lo bloquea `ops/scripts/validate.sh`.
