# Manual operativo — Cauce V3

Procedimientos del producto. Fuente de verdad de arquitectura: [arquitectura.md](arquitectura.md). Este documento es solo el CÓMO operar; runbooks completos en `ops/runbooks/*.md`.

El stack corre desde el **propio checkout del repo** en el host del stack, con el compose canónico de `deploy/`: el árbol es material de producción, porque Prometheus, OTel y PostgreSQL montan ficheros directamente desde ahí. La configuración de instancia vive fuera del árbol, por defecto en `/etc/cauce-v3` (`CAUCE_ENV_FILE` apunta a `/etc/cauce-v3/prod.env` salvo que se sobrescriba). La revisión publicada se consulta en `deploy/HISTORIAL.md` y el esquema en `schema_migrations`; no se deducen del checkout.

Si una instalación conserva un release anterior fuera del árbol (con su propio compose y sus overrides), esa es su única ruta de rollback probada: comprobar el `ExecStart` de las unidades antes de considerarla retirada, porque puede haber unidades apuntando todavía a herramientas instaladas ahí.

## 1. Desplegar

**Recibo de gates del SHA candidato.** `deploy.sh` no corre `pnpm`; exige un recibo verde de
`scripts/release-gates.sh` del mismo commit. Se genera una vez por candidato, en un checkout limpio
del SHA, con usuario normal (no root, por `qa:runtime-packaging`), tras `pnpm install --frozen-lockfile`
y con `~/.venvs/cauce-qa/bin` en `PATH`:
```bash
scripts/release-gates.sh            # scripts/release-gates.sh --list muestra el orden
```
Corre en orden `pnpm typecheck`, `lint`, `test`, `coverage:ratchet`, `qa:testcontainers`, `qa:layout`,
`qa:runtime-packaging`, `ops:validate` y `arch:validate`, en modo release (`CAUCE_RELEASE_VALIDATION=1`,
`CAUCE_REQUIRE_TESTCONTAINERS=1`: sin Docker o testcontainers falla, no se salta), y se detiene en el
primer rojo. Escribe un log por comando y `recibo.json` con `{commit, tree, comandos: [{cmd, exit,
log_sha256, duracion, log}], inicio, fin}` en `~/.local/state/cauce-v3/release-gates/<commit>-<STAMP>/`
(`CAUCE_RELEASE_GATES_DIR` lo cambia; nunca `/tmp`). Se niega con el árbol sucio y no emite recibo si
algún gate cambia `HEAD` o el árbol. El recibo no puede ir dentro del commit que certifica: se copia
junto al bundle en el VPS, fuera del clon (dentro ensuciaría el árbol), y se pasa por ruta absoluta en
`CAUCE_DEPLOY_GATES_RECEIPT`.

**Precondiciones que `deploy/deploy.sh` verifica y aborta si fallan (todas antes del build):**
- `git status` limpio y `HEAD == origin/main` (`CAUCE_DEPLOY_EXPECTED_GIT_REF`).
- Recibo de gates: `commit` = `HEAD`, `tree` = `HEAD^{tree}`, exactamente los comandos de
  `scripts/release-gates.sh --list` en orden y todos con `exit` 0. Escape auditado, solo con el
  dueño: `CAUCE_DEPLOY_SIN_RECIBO="motivo"` (una línea, sin `|`, excluyente con el recibo); pide
  confirmación y el motivo queda en la fila de `deploy/HISTORIAL.md`, igual que el sha256 del recibo
  cuando lo hay.
- `CAUCE_RUNTIME_IMAGE` y `CAUCE_CONSOLE_IMAGE` declarados una sola vez como `NOMBRE=` en `prod.env`
  y ausentes del entorno (un valor exportado anularía el pin del archivo).
- Existen todas las fuentes de bind mounts y de `secrets`/`configs` con `file` del compose renderizado
  tal como se va a levantar (perfiles activos, overlay MCP y overlay de flota incluidos): p. ej. el
  repositorio y la clave del broker de contextos (`create_host_path: false`) y
  `/etc/cauce-v3/fleet-v35/*` y `/run/cauce-fleet-v35/auth` con `CAUCE_DEPLOY_FLEET_OVERLAY=1`. El
  error lista cada fuente ausente con su servicio.
- Backup acreditado por `ops/scripts/host-backup-monitor.sh` con la edad de
  `CAUCE_DEPLOY_BACKUP_MAX_AGE_HOURS` (24 h por defecto). Sin migraciones pendientes, un backup
  viejo o ausente admite confirmación explícita. **Con migraciones pendientes** (archivos del bundle
  que no están en `schema_migrations` del PostgreSQL vivo) la ventana baja a 2 h como máximo, no se
  admite confirmación y el monitor se repite justo antes del migrator. Instalación nueva sin volumen
  de datos: no hay nada que respaldar.
- `CAUCE_BLOB_API_ENABLED` acepta solo `0` o `1` en el archivo de instancia, por defecto `0`; un valor exportado distinto aborta antes del build. Con `1`, el monitor de la instancia debe acreditar restauración aislada posterior a la migración 042 de la tabla `blobs` y del volumen `blobs_data`. La confirmación general no omite este control.
- `CAUCE_TERMINAL_RELAY_INSTANCE_ID` en `prod.env` = sha256 del DER del certificado cliente del relay (el relay no arranca si no coincide).
- `docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml config` renderiza sin error.

Los envoltorios que llaman a `deploy.sh` (p. ej. `ops/instances/hospital/bootstrap-core.sh`) heredan
`CAUCE_DEPLOY_GATES_RECEIPT` o `CAUCE_DEPLOY_SIN_RECIBO` del entorno de quien los ejecuta.

Para activar blobs en Hospital: desplegar primero con `CAUCE_BLOB_API_ENABLED=0` para aplicar la
migración 042 y crear el volumen, ejecutar `ops/instances/hospital/backup.sh`, comprobar con
`REQUIRE_BLOB_VOLUME=1 ops/instances/hospital/backup-monitor.sh`, cambiar el archivo de instancia
a `CAUCE_BLOB_API_ENABLED=1` y desplegar de nuevo. En la instancia central, instalar primero las
versiones actuales de `ops/scripts/host-backup.sh` y `host-backup-monitor.sh` en
`/usr/local/sbin/cauce-v3-host-backup` y `/usr/local/sbin/cauce-v3-host-backup-monitor`.
Ejecutar un respaldo nuevo y comprobar `REQUIRE_BLOB_VOLUME=1` con el monitor instalado: éste
exige dump y volumen restaurados en aislamiento, hashes y tamaños de cada blob, y evidencia
ligada a ese dump. Con la API ya activa, no saltar la compuerta usando Compose directo;
si hay una migración pendiente, respaldar antes y repetir el respaldo tras aplicarla. Para
desactivar la API, restaurar `0` y recrear el gateway; el volumen y la tabla permanecen intactos.

La migración 043 cambia la clave de `blobs`; el gateway anterior no puede escribir con ese
esquema. En una instalación existente con API activa, planificar una ventana de blobs: fijar
`CAUCE_BLOB_API_ENABLED=0` en el archivo de instancia y recrear solo el gateway anterior para
cerrar PUT/GET, tomar un respaldo estricto nuevo, desplegar 043 con el procedimiento oficial y
la API todavía apagada, tomar otro respaldo verificado y recién entonces reactivar la API con
el runtime nuevo. El deploy rechaza 043 pendiente con API activa y exige el respaldo estricto
aunque se haya puesto en `0` para migrar. Si falla después de confirmar 043, mantener la API
apagada: restaurar **base y volumen juntos** desde el respaldo previo antes de volver al runtime
anterior, o corregir hacia adelante. Restaurar solo pines antiguos bajo 043 dejaría PUT roto.

**Comando** (dueño presente, root, `df -h /` con holgura para dos imágenes nuevas o `docker builder prune -f` antes):
```bash
export CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si
export CAUCE_DEPLOY_GATES_RECEIPT=/root/recibo-gates-<SHA>.json
./deploy/deploy.sh
```
Hace, en orden: precondiciones → build de `deploy/Dockerfile --target runtime` y `--target console` (la consola hornea el instance-id) → push → copia candidata `prod.env.candidate-<STAMP>` con los digests SHA256 nuevos (mismos permisos; se borra al salir) → `config` y migrator efímero (todas las migraciones pendientes en UNA transacción) con esa copia → **solo si el migrator sale con 0**: snapshot `prod.env.pre-deploy-<STAMP>` y la copia candidata reemplaza a `prod.env` → `docker compose up -d --wait --remove-orphans` (actualiza los servicios afectados y conserva el volumen de datos de PostgreSQL) → `deploy/refresh-observability.sh` → `deploy/smoke.sh`. Registra el resultado en `deploy/HISTORIAL.md` con el sha256 del recibo o el motivo del escape (commitear tras verificar).

El refresco recrea únicamente Prometheus y OTel que ya estén activos, sin dependencias ni perfiles apagados. Un reemplazo atómico de archivos por Git puede dejar un montaje individual leyendo el inode anterior; `up` sin cambios de imagen/configuración no garantiza su recarga. Si el refresco falla, no se registra un despliegue exitoso. Los adaptadores SDK se publican y activan por separado: el smoke central no prueba sus nuevos pins. Su canary exige la identidad mTLS reservada `gate-probe`; una entrega normal o un snapshot manual no la sustituye.

**Criterios de parada**: cualquier precondición falla → no arranca, no construye y `prod.env` no
cambia. Render con los pins nuevos fallido o confirmación negada → no se migra. Migrator fallido →
PostgreSQL revierte la transacción (esquema intacto). En esos casos `prod.env` sigue con los pins
anteriores, no se crea `prod.env.pre-deploy-<STAMP>`, no hay pins que restaurar y ningún contenedor
se levanta con los digests nuevos. Si falla justo después del migrator al guardar el snapshot o instalar los pins, la BD
ya quedó en la última migración del bundle y `prod.env` sigue con los anteriores: decidir entre
corregir hacia delante o restaurar la BD (paso 3 del rollback). `up`, refresco o smoke fallan →
`prod.env` ya tiene los pins nuevos y `prod.env.pre-deploy-<STAMP>` los anteriores: pasar a rollback
(tampoco automático: el script solo imprime la receta, no la ejecuta).

**Rollback exacto** (nunca `docker compose down`: pararía postgres antes de restaurar):
```bash
# 1. Parar todo menos postgres (los servicios de aplicación que el compose declare activos)
docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml --project-directory deploy \
  stop gateway dispatcher telegram-bridge terminal-relay console outbox-metrics prometheus otel-collector
# 2. Restaurar el prod.env previo (el snapshot solo existe si el migrator terminó con 0)
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
**La única pieza que pide un humano**: el token del bot de Telegram, generado en BotFather — `aprovisionar` lo solicita interactivamente, lo deja en `/etc/cauce-v3/telegram-runtime/<tenant>/<alias>.token` (0600) y recién entonces reemplaza la fila del alias en `config.json` (`ops/scripts/publish-telegram-token.py`).

**Baja**: `ops/cli/cauce <alias> retirar` (para la unit y revoca token e identidad mTLS) → `UPDATE agents SET enabled=false` → re-exportar snapshot (el alias pasa a `retired`) → `regenerate-fleet.sh` (purga manifest y units huérfanas: `ops/scripts/generate-container-units.py:289-294` y `ops/scripts/generate-units.py:109-113`) → `validate.sh`.

**Aviso de orden**: `enabled=false` en BD saca al agente del enrutado de entregas, pero el `hello`/lease del gateway se autoriza además por certificado mTLS — un agente dado de baja en BD puede seguir conectándose hasta que `retirar` revoca su credencial. No dar el UPDATE por baja completa sin correr `retirar`.

### CLI de cuentas humanas de consola

Con `DATABASE_URL` apuntando a la instancia elegida, `pnpm console:user --email persona@example.com`
pide una contraseña nueva (o lee `CAUCE_CONSOLE_USER_PASSWORD`). No pasar contraseñas por argumentos.
El comando conserva su comportamiento de alta si el correo no existe y actualización si ya existe:

- **Alta:** sin atributos explícitos, nombre = parte local del correo, rol = `operator`, tenant =
  `Steven`, alias = `kant`; la cuenta se crea activa. `--name`, `--role`, `--tenant` y `--alias`
  sustituyen esos valores para esta alta.
- **Cuenta existente:** cambia la contraseña y sólo los atributos indicados explícitamente.
  Omitir nombre, rol, tenant o alias conserva su valor persistido. El correo normalizado identifica
  la cuenta; no se reescribe su correo de presentación ni se reactiva una cuenta dada de baja.
- **Mantenimiento sin alta accidental:** añadir `--update`; si el correo no existe, falla sin crear.
- **Reactivación explícita:** `--update --activate`; exige cuenta existente y contraseña nueva,
  conserva los demás atributos omitidos. Cambiar contraseña por sí solo no reactiva.
- **Baja:** `pnpm console:user --email persona@example.com --deactivate`; no pide contraseña,
  falla si no existe y sólo acepta `--email`. El gateway relee la fila y rechaza cuentas inactivas.

**Límite del alta/actualización implícita:** si la parte local del correo (antes de `@`) supera
120 caracteres y se omite `--name`, el nombre derivado incumple la restricción de la base antes de
resolver `ON CONFLICT`, incluso si la cuenta ya existe. Para rotar la contraseña de una cuenta
existente conservando su nombre, usar `pnpm console:user --email <correo> --update` y omitir `--name`;
esta operación no construye un alta candidata ni crea una cuenta si el correo no existe.

Toda actualización de contraseña, incluida una reactivación explícita, avanza `password_changed_at`;
las sesiones anteriores se evalúan contra esa marca con la tolerancia temporal existente del proveedor.
La salida muestra rol, ámbito y estado activo devueltos por la base, no defaults del parser.
Flags desconocidos o combinaciones incompatibles fallan antes de abrir el pool. Para cambiar un ámbito
usar sus flags expresamente; esto no sustituye las reglas de autorización ni crea membresías de agentes.

#### Siembra de autoridad: `cauce platform admin semilla`

`cauce platform` es la única CLI de plataforma. Los grupos `admin`, `empresa` y `enlace` operan sobre
las tablas de autoridad con la URL de dueño de la base (`DATABASE_URL_FILE` o `DATABASE_URL`, nunca
se imprime); el resto (`show`, `change`, `rollback`, `export`, `plan-import`, `import`) es la CLI de
configuración autenticada con una cuenta humana. `cauce platform contenedor ...` ejecuta los tres
grupos de autoridad dentro de la imagen de runtime del despliegue (`ops/cli/cauce-platform-contenedor`).

```bash
cauce platform admin semilla --email persona@example.com                         # platform_admin
cauce platform admin semilla --email persona@example.com --company ID [--role owner|admin]  # rol de empresa
```

- La persona se resuelve por correo normalizado; una cuenta inexistente, inactiva o que no sea
  `operator` falla con exit 1 y un mensaje claro, sin crear nada.
- Es idempotente: si el estado ya es el pedido, imprime «sin cambios» y no escribe ni audita. Con
  `--company` usa `cauce_platform_grant_admin` (el rol por defecto es `owner`); sin `--company`
  inserta en `platform_admins`, que el disparador de la 054 deja en `platform_authority_events`.
- El actor del rol de empresa es `--admin UUID`, `CAUCE_PLATFORM_ADMIN_ID` o, si faltan, el
  `platform_admin` activo más antiguo; por eso se siembra primero el `platform_admin`.
- La persona debe tener su cuenta de consola en esa empresa (regla de `cauce_platform_grant_admin`).

Primer despliegue de V4 en producción (en el clon del despliegue vigente del host, como root):

```bash
cd /datos/workspaces/zeus/cauce-v3-deploy/<clon del despliegue vigente>
ops/cli/cauce-platform-contenedor --mostrar     # solo muestra imagen, red y secretos
ops/cli/cauce-platform-contenedor admin semilla --email steven@elenxos.com
for correo in steven@elenxos.com miguel@elenxos.com; do
  ops/cli/cauce-platform-contenedor admin semilla --email "$correo" --company humanizar --role owner
done
```

Repetir el bloque no cambia nada. Verificación: al volver a entrar, `GET /v3/auth/session` muestra
`role=platform_admin` para Steven y `role=company_owner`, `scope=company` para Miguel.

## 3. Diagnóstico y recuperación de un adaptador caído

`cauce <alias>` resuelve primero `~/.config/cauce-v3/alias-host.tsv` del usuario real de la
cuenta. Cada alias presente debe tener un único registro de dos campos: alias y `local`, `vps` o
`ssh:usuario@host`. El destino SSH ejecuta el CLI instalado en el home real de esa cuenta;
no busca el alias en el inventario local ni abre otra conversación como alternativa. Una
ruta presente desconocida o duplicada, o un mapa existente ilegible, aborta el comando. Por
compatibilidad, un mapa inexistente o un alias ausente se resuelve como local. El mapa de
acceso no sustituye el inventario del bus: verificar el destino y la respuesta del modelo.

Si el alias tiene sesión compartida habilitada y no puede abrirse, `cauce <alias>` termina con
error: no abre una terminal «APARTE». El consumidor tampoco ejecuta por otra conversación.
Recuperar la TUI canónica exige acreditar su contexto; no elegir el último historial ni crear
uno vacío para sustituir una conversación desconocida. Ver [contrato de recuperación](adapter-sdk.md#reanudación-exacta-de-la-tui-claude).

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

## Consultar el buzón de un cliente MCP

Una declaración activa de cliente OAuth local habilita su buzón. Consulta `cauce_mailbox` sin argumentos para obtener dirección, etiqueta y mensajes recientes; usa su `next_cursor` para páginas anteriores. Los clientes que todavía no anuncien la herramienta pueden obtener la primera página mediante `cauce_inbox`. La consulta deriva el dueño y el grant de la autenticación; no acepta una identidad alternativa.

Un agente compatible puede iniciar texto nuevo hacia la dirección pública del buzón. El transporte devuelve almacenamiento con intento cero; en consola aparece «Guardado en buzón». La respuesta del agente remitente continúa sin esperar que el cliente ejecute un turno. Leer no cambia el estado ni confirma ejecución. ChatGPT ejecuta la consulta cuando tenga un turno activo.

Cada mensaje admite hasta 16 KiB de cuerpo JSON con texto y sin adjuntos; cada grant admite 1000 mensajes. Las páginas devuelven texto completo y respetan un presupuesto de bytes. El buzón lleno rechaza nuevos mensajes sin borrar historia. Renovar tokens o renombrar mantiene la dirección; un nuevo consentimiento crea otro buzón. Si deja de estar disponible, verifica vigencia del grant, declaración, dueño, membresías y permisos de ruta. No recrees una declaración ni traslades mensajes por coincidencia de etiquetas.
