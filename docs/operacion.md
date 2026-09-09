# Manual operativo — Cauce V3

Procedimientos del producto. Fuente de verdad de arquitectura: [arquitectura.md](arquitectura.md). Este documento es solo el CÓMO operar; runbooks completos en `ops/runbooks/*.md`.

El stack corre desde el **propio checkout del repo** en el host del stack, con el compose canónico de `deploy/`: el árbol es material de producción, porque Prometheus, OTel y PostgreSQL montan ficheros directamente desde ahí. La configuración de instancia vive fuera del árbol, por defecto en `/etc/cauce-v3` (`CAUCE_ENV_FILE` apunta a `/etc/cauce-v3/prod.env` salvo que se sobrescriba). La revisión publicada se consulta en `deploy/HISTORIAL.md` y el esquema en `schema_migrations`; no se deducen del checkout.

Si una instalación conserva un release anterior fuera del árbol (con su propio compose y sus overrides), esa es su única ruta de rollback probada: comprobar el `ExecStart` de las unidades antes de considerarla retirada, porque puede haber unidades apuntando todavía a herramientas instaladas ahí.

## 1. Desplegar

**Precondiciones que `deploy/deploy.sh` verifica y aborta si fallan:**
- `git status` limpio y `HEAD == origin/main` (`CAUCE_DEPLOY_EXPECTED_GIT_REF`).
- Backup <24h acreditado por `ops/scripts/host-backup-monitor.sh` (o confirmación explícita si no lo hay).
- `CAUCE_TERMINAL_RELAY_INSTANCE_ID` en `prod.env` = sha256 del DER del certificado cliente del relay (el relay no arranca si no coincide).
- `docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml config` renderiza sin error.
- Si la migración 034 sigue pendiente: 0 filas en `terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL`. Si ya está aplicada, las terminales abiertas son normales; no revocarlas para superar este control.

**Precondición que el operador verifica a mano, `deploy.sh` NO la comprueba:** gate en verde
(`pnpm typecheck && pnpm lint && pnpm test:unit`). El script no ejecuta ni un solo comando `pnpm`;
confía en que quien despliega ya corrió el gate.

**Comando** (dueño presente, root, `df -h /` con holgura para dos imágenes nuevas o `docker builder prune -f` antes):
```bash
export CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si
./deploy/deploy.sh
```
Hace, en orden: build de `deploy/Dockerfile --target runtime` y `--target console` (la consola hornea el instance-id) → push y pin por digest SHA256 en `prod.env` → migrator efímero (todas las migraciones pendientes en UNA transacción) → `docker compose up -d --wait --remove-orphans` (actualiza los servicios afectados y conserva el volumen de datos de PostgreSQL) → `deploy/refresh-observability.sh` → `deploy/smoke.sh`. Registra el resultado en `deploy/HISTORIAL.md` (commitear tras verificar).

El refresco recrea únicamente Prometheus y OTel que ya estén activos, sin dependencias ni perfiles apagados. Un reemplazo atómico de archivos por Git puede dejar un montaje individual leyendo el inode anterior; `up` sin cambios de imagen/configuración no garantiza su recarga. Si el refresco falla, no se registra un despliegue exitoso. Los adaptadores SDK se publican y activan por separado: el smoke central no prueba sus nuevos pins. Su canary exige la identidad mTLS reservada `gate-probe`; una entrega normal o un snapshot manual no la sustituye.

**Criterios de parada**: cualquier precondición falla → no arranca. Migrator falla → PostgreSQL
revierte solo la transacción (esquema intacto) y el script muere ahí — pero `prod.env` YA fue
reescrito con los digests nuevos ANTES del migrator (paso previo), así que hay que restaurarlo a
mano desde `prod.env.pre-deploy-<STAMP>`: no es cierto que "nada más se toca". Ningún contenedor
llega a levantarse con los digests nuevos. `up` o smoke fallan → pasar a rollback (tampoco
automático: el script solo imprime la receta, no la ejecuta).

**Rollback exacto** (nunca `docker compose down`: pararía postgres antes de restaurar):
```bash
# 1. Parar todo menos postgres (los servicios de aplicación que el compose declare activos)
docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml --project-directory deploy \
  stop gateway dispatcher telegram-bridge terminal-relay console outbox-metrics prometheus otel-collector
# 2. Restaurar el prod.env previo
cp -a /etc/cauce-v3/prod.env.pre-deploy-<STAMP> /etc/cauce-v3/prod.env
# 3. Solo si el esquema ya quedó confirmado y hay que volver atrás: verificar sha256, terminar backends, dropdb/restore
#    ($DB_BACKUP_DIR = directorio de dumps del timer de backup; su valor por defecto, en §5)
D=$(ls -t "$DB_BACKUP_DIR"/*.dump | head -n 1); (cd "$(dirname "$D")" && sha256sum -c "$(basename "$D").sha256")
docker exec cauce-v3-prod-postgres-1 psql -U cauce -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cauce' AND pid<>pg_backend_pid()"
docker exec cauce-v3-prod-postgres-1 dropdb -U cauce cauce && docker exec cauce-v3-prod-postgres-1 createdb -U cauce cauce
docker exec -i cauce-v3-prod-postgres-1 pg_restore -U cauce -d cauce --no-owner --no-acl < "$D"
# 4. Levantar la versión previa con el compose del RELEASE ANTERIOR y sus overrides (NO el canónico)
docker compose --env-file /etc/cauce-v3/prod.env -f <PREV_RELEASE>/deploy/compose.yaml -f <PREV_RELEASE>/deploy/compose.postgres.yaml \
  $(printf -- '-f %s ' /etc/cauce-v3/compose-overrides/*.yaml) \
  --project-directory <PREV_RELEASE>/deploy up -d --wait --wait-timeout 300
# 5. Verificar (el esquema dirá la versión del dump restaurado — esperado)
./deploy/smoke.sh
```
Los nombres de contenedor del ejemplo derivan del `COMPOSE_PROJECT_NAME` por defecto (`cauce-v3-prod`); con otro proyecto cambian en consecuencia.

## 2. Alta y baja de un agente

Única fuente de verdad: BD (`agents` + `memberships`). Cadena declarativa obligatoria — nunca editar a mano `ops/container-aliases.json`, `ops/manifests/*.yaml` ni `ops/generated/**`:
```
BD (INSERT/UPDATE) → export-fleet-snapshot.py → ops/flota.json → regenerate-fleet.sh → validate.sh → cauce <alias> aprovisionar/retirar
```

**Alta**: `INSERT` transaccional en `agents` (con `enabled=true`) y `memberships`, luego:
```bash
python3 ops/scripts/export-fleet-snapshot.py --out ops/flota.json   # git diff: solo flota.json, el alias entra a "fleet"
./ops/scripts/regenerate-fleet.sh                                    # deriva manifest, unit systemd, container-aliases.json, config Telegram
./ops/scripts/validate.sh                                            # gate: hermeticidad byte a byte + checksums
ops/cli/cauce <alias> aprovisionar                                   # cert mTLS + token + clave PTY + PKI de contenedor + token de Telegram
systemctl --user daemon-reload && systemctl --user enable --now cauce-v3-container-<alias>.service
```
**La única pieza que pide un humano**: el token del bot de Telegram, generado en BotFather — `aprovisionar` lo solicita interactivamente y lo registra en `/etc/cauce-v3/telegram-runtime/config.json` (0600).

**Baja**: `ops/cli/cauce <alias> retirar` (para la unit y revoca token e identidad mTLS) → `UPDATE agents SET enabled=false` → re-exportar snapshot (el alias pasa a `retired`) → `regenerate-fleet.sh` (purga manifest y units huérfanas: `ops/scripts/generate-container-units.py:289-294` y `ops/scripts/generate-units.py:109-113`) → `validate.sh`.

**Aviso de orden**: `enabled=false` en BD saca al agente del enrutado de entregas, pero el `hello`/lease del gateway se autoriza además por certificado mTLS — un agente dado de baja en BD puede seguir conectándose hasta que `retirar` revoca su credencial. No dar el UPDATE por baja completa sin correr `retirar`.

## 3. Diagnóstico y recuperación de un adaptador caído

```bash
ops/cli/cauce <alias> estado          # columna ADAPTADOR: activo/failed/inactive
systemctl --user status cauce-v3-container-<alias>.service   # cauce-v3-alias-<alias> para agentes host-native
```

**`failed` con exit 78 significa un fallo permanente y cerrado; no diagnostica por sí solo la
causa.** La unidad no reintenta ese código. Solo el error exacto
`current-generation adapter PID is absent; metadata was preserved`
(`ops/container-runtime/cauce-container-runtime.py:1084`) acredita que ese metadato se
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

El médico (`ops/guardias/cauce-v3-medico-monitor`) aplica un veto adicional antes de reiniciar un
adaptador: consulta dos veces las entregas `leased`, `accepted` o `started`, una al entrar al ciclo y
otra inmediatamente antes de `systemctl restart`. La captura conserva solo identificadores y
metadatos de ruteo; no consulta ni registra el cuerpo o texto del mensaje. Cualquier fila impide el
reinicio.

Las dos consultas no forman una barrera atómica con `systemctl`: una entrega todavía puede entrar
después de la segunda consulta. Por esa razón el reinicio requiere el interruptor explícito
`--reiniciar-adaptadores`, apagado por defecto, y la unidad versionada usa `--solo-detectar`
(`ops/guardias/systemd/cauce-v3-medico-monitor.service:13`). No se habilitó el reinicio automático
ni existe reinyección automática del trabajo en vuelo.

**Regla de orden con el plano PTY**: los hechos medidos del runtime y el ticket firmado están atados
a la generación del contenedor, y el pty-agent los mide UNA vez al arrancar. Tras reiniciar un
adaptador hay que reiniciar su PTY —adaptador primero, PTY después—; si no, la medición queda
obsoleta y la consola responde 503 al escribir un perfil de ese alias.

## 4. Plano PTY: detectar y segar bucles del relay

Síntoma: `terminal-relay` expulsa (`superseded`) agentes en bucle porque un mismo alias tiene más
de un proceso PTY vivo con el mismo certificado.

```bash
# Detectar: por encima del umbral de conexiones/2min de deploy/smoke.sh es bucle
docker logs cauce-v3-prod-terminal-relay-1 --since 2m | grep -c 'agent_connected"'
```

No usar `pgrep` por substring como censo: omite el argv legado y no acredita el bundle exacto. La
verificación debe comparar byte a byte ambos argv admitidos y la ruta exacta del bundle mediante el
mismo parser de `/proc` del reaper.

El launcher versionado prepara los artefactos, vuelve a validar la generación y después ejecuta la
siega inmediatamente antes del nuevo `exec` (`ops/pty-agent/cauce-pty-launcher.sh:786`, invocada en
`:820`). Reconoce de forma exacta el argv actual y el legado.
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
| `cauce-v3-host-backup.timer` | 03:10 UTC diario | `pg_dump --format=custom` del contenedor de postgres → `$DB_BACKUP_DIR/cauce-<ts>.dump` + `.sha256` (`DB_BACKUP_DIR` por defecto `/opt/_archive/cauce-v3-db-backups`, `ops/scripts/host-backup.sh:71`); valida con un restore AISLADO (postgres efímero sin red) antes de publicar; retención local `DB_RETENTION_DAYS` (14 por defecto, `:72`) tras confirmar copia off-site; sincroniza al destino `OFFSITE_USER@OFFSITE_HOST` (append-only, nunca borra remoto) |
| `cauce-v3-respaldo-torre.timer` | 04:30 UTC diario | manda los dumps y `/etc/cauce-v3` (tar 0600) al host de respaldo que declara `ops/scripts/backup-a-torre.sh`, y de ahí a almacenamiento externo con `rclone` |
| `cauce-v3-host-backup-monitor.timer` | 00/06/12/18:45 UTC | verifica que el backup corrió y con éxito reciente (`overall == "ok"` en `$STATUS_FILE`, por defecto `/var/log/cauce-v3-backup/status.json`) |
| `cauce-v3-watchdog@.timer` / `cauce-v3-reconciler@.timer` | cada 30 s / cada 5 min, por alias | salud y reconciliación de cada adaptador |
| `cauce-v3-health@.timer` | cada minuto, por instancia | sonda periódica de salud |
| `cauce-v3-quota-collector.timer` | cada 5 min | recolector de cuotas de IA |
| `cauce-v3-ci-local.timer` | 05:30 UTC diario | gate completo + `validate.sh` sobre un worktree desechable, en el propio host |

Verificar un dump:
```bash
LATEST=$(ls -t "$DB_BACKUP_DIR"/*.dump | head -n 1)
(cd "$(dirname "$LATEST")" && sha256sum -c "$(basename "$LATEST").sha256")
docker exec -i cauce-v3-prod-postgres-1 pg_restore --list < "$LATEST" | grep -c "TABLE DATA"
cat /var/log/cauce-v3-backup/status.json   # "overall":"ok"
```
**Timers durante una ventana de despliegue.** Registrar primero cuáles están activos y pausar
los que puedan competir por locks durante una migración. Al cerrar la ventana, éxito o rollback,
restaurar sólo los que estaban activos y siguen autorizados. `cauce-revividor-de-colas.timer`
está desactivado por reemitir trabajo ambiguo: no iniciarlo ni habilitarlo como parte del despliegue.
El watchdog de flota es de lectura; conservar su estado previo, sin convertir una pausa temporal
en una activación de guardias retiradas.

## 6. Smoke y comprobaciones rápidas de salud

```bash
./deploy/smoke.sh   # readiness, contenedores, esquema, leases, ACK aplicado, relay y TLS verificado
```

Ejecutarlo en el host que dispone de la CA pública de consola. El control enumera los servicios que
el propio compose declara activos —excluyendo `migrator`— y exige **un** contenedor activo y
`healthy` por cada uno (`deploy/smoke.sh:103-133`): no hay un número fijo de contenedores, son
tantos como servicios activos tenga el compose con los perfiles encendidos. El esquema lo deriva del
repositorio. La cardinalidad de agentes es una entrada independiente y **obligatoria**,
`CAUCE_SMOKE_EXPECTED_AGENTS` (`deploy/smoke.sh:54`, sin valor por defecto): se compara contra los
agentes habilitados con lease vivo y heartbeat fresco, así que hay que declararla igual al número de
alias habilitados de la instalación. Lee ambas salidas del relay y falla si no puede realizar una
consulta. No sustituirlo por conteos parciales ni usar una conexión sin TLS verificado para
acreditar salud.

## 7. Reglas de oro

- El checkout del repo en el host del stack es material de PRODUCCIÓN: Prometheus, OTel y PostgreSQL montan ficheros de ahí. No rebasear ni cambiar de rama con producción arriba. Una actualización de Git exige verificar el contenido efectivo de los montajes; no implica una recarga automática.
- El release anterior y sus overrides externos, si la instalación los conserva, son la ÚNICA ruta de rollback probada hasta que se archiven tras un periodo de reposo — no borrar, no tocar.
- `deploy/deploy.sh` exige `CAUCE_FASE3_CON_DUENO=si`: ningún despliegue corre sin el dueño presente.
- Nunca `docker compose down` en producción: pararía postgres antes de poder restaurar. `stop` de los servicios de aplicación, postgres se toca aparte y con backup verificado en mano.
- `ops/container-aliases.json`, `ops/manifests/*.yaml` y `ops/generated/**` son GENERADOS: editarlos a mano los desincroniza de la BD y lo bloquea `ops/scripts/validate.sh`.
- No redesplegar el runtime con cadenas humanas abiertas: el redespliegue tumba todos los adaptadores a la vez y se lleva los logs del `json-file` de los contenedores recreados.
