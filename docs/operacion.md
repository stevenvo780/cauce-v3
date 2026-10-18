# Manual operativo — Cauce V4

Procedimientos del producto. Fuente de verdad de arquitectura: [arquitectura.md](arquitectura.md). Este documento es solo el CÓMO operar; runbooks completos en `ops/runbooks/*.md`.

El stack corre desde el **propio checkout del repo** en el host del stack, con el compose canónico de `deploy/`: el árbol es material de producción, porque Prometheus, OTel y PostgreSQL montan ficheros directamente desde ahí. La configuración de instancia vive fuera del árbol, por defecto en `/etc/cauce-v3` (`CAUCE_ENV_FILE` apunta a `/etc/cauce-v3/prod.env` salvo que se sobrescriba). La revisión publicada se consulta en `deploy/HISTORIAL.md` y el esquema en `schema_migrations`; no se deducen del checkout.

Si una instalación conserva un release anterior fuera del árbol (con su propio compose y sus overrides), esa es su única ruta de rollback probada: comprobar el `ExecStart` de las unidades antes de considerarla retirada, porque puede haber unidades apuntando todavía a herramientas instaladas ahí.

## 1. Desplegar

El procedimiento de actualización de V4 está en [Desplegar V4](#desplegar-v4). Lo que sigue es lo que `deploy/deploy.sh` comprueba en cualquier despliegue.

**Gate de despliegue: tres pasos.** En un clon limpio del SHA candidato, con usuario normal y las
dependencias instaladas, `scripts/release-gates.sh` ejecuta únicamente:

```text
pnpm typecheck
pnpm lint
pnpm qa:runtime-packaging
```

Consulta la lista sin ejecutar los gates con `scripts/release-gates.sh --list`. El recibo
`recibo.json` contiene commit, árbol, comando, exit y hash de cada log; los tres pasos deben salir 0
y corresponder al SHA que se publica. El recibo vive fuera del clon certificado. La ruta por
defecto es `~/.local/state/cauce-v3/release-gates/<commit>-<marca>/`; se cambia con
`CAUCE_RELEASE_GATES_DIR`.

El nivel `CAUCE_RELEASE_GATES_NIVEL=completo` es optativo: suites, matrices y trinquetes de cobertura
no son requisitos de despliegue. La comprobación de comportamiento se hace usando los flujos reales
sobre la versión desplegada. Procedimiento del operador: [Desplegar V4](#desplegar-v4).

**Precondiciones que `deploy/deploy.sh` verifica y aborta si fallan (todas antes del build):**
- `git status` limpio y `HEAD == origin/main` (`CAUCE_DEPLOY_EXPECTED_GIT_REF`).
- Recibo de gates: `commit` = `HEAD`, `tree` = `HEAD^{tree}`, exactamente los comandos de
  `scripts/release-gates.sh --list` en orden y todos con `exit` 0. Escape auditado, solo con el
  dueño: `CAUCE_DEPLOY_SIN_RECIBO="motivo"` (una línea, sin `|`, excluyente con el recibo); pide
  confirmación y el motivo queda en la fila de `deploy/HISTORIAL.md`, igual que el sha256 del recibo
  cuando lo hay. `CAUCE_DEPLOY_PRINT_COMPOSE=1` no pide recibo ni escape: solo imprime la receta de
  Compose y sale sin tocar git, imágenes ni la base ([runbook-rol-runtime.md](runbook-rol-runtime.md), paso 3).
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
: "${CAUCE_DEPLOY_GATES_RECEIPT:?Define la ruta absoluta del recibo verde del candidato}"
export CAUCE_DEPLOY_GATES_RECEIPT
./deploy/deploy.sh
```
Hace, en orden: precondiciones → build de `deploy/Dockerfile --target runtime` y `--target console` (la consola hornea el instance-id) → push → copia candidata `prod.env.candidate-<STAMP>` con los digests SHA256 nuevos (mismos permisos; se borra al salir) → `config` y migrator efímero (todas las migraciones pendientes en UNA transacción) con esa copia; con migraciones pendientes, antes del migrator para el `dispatcher` (lee `deliveries` con `messages` en cada scrape) y comprueba `pg_stat_activity`, y lo vuelve a arrancar en cuanto el migrator termina, también si falla o se interrumpe → **solo si el migrator sale con 0**: snapshot `prod.env.pre-deploy-<STAMP>` y la copia candidata reemplaza a `prod.env` → `docker compose up -d --wait --remove-orphans` (actualiza los servicios afectados y conserva el volumen de datos de PostgreSQL) → `deploy/refresh-observability.sh` → `deploy/smoke.sh`. Registra el resultado en `deploy/HISTORIAL.md` con el sha256 del recibo o el motivo del escape (commitear tras verificar).

El refresco recrea únicamente Prometheus y OTel que ya estén activos, sin dependencias ni perfiles apagados. Un reemplazo atómico de archivos por Git puede dejar un montaje individual leyendo el inode anterior; `up` sin cambios de imagen/configuración no garantiza su recarga. Si el refresco falla, no se registra un despliegue exitoso. Los adaptadores SDK se publican y activan por separado: el smoke central no prueba sus nuevos pins. Su canary exige la identidad mTLS reservada `gate-probe`; una entrega normal o un snapshot manual no la sustituye.

**Criterios de parada**: cualquier precondición falla → no arranca, no construye y `prod.env` no
cambia. Render con los pins nuevos fallido o confirmación negada → no se migra. Con migraciones
pendientes, una sesión de la base `idle in transaction` desde hace más de 1 s o con una transacción
de más de `CAUCE_DEPLOY_MAX_XACT_SECONDS` (5 s por defecto) → no se migra: el error lista pid,
aplicación, estado y edad de cada una (nunca la consulta); terminarla o esperar y repetir. El migrator
toma al empezar todos los locks de tablas que piden las migraciones pendientes (lista explícita en
`packages/store/src/migration-locks.ts`): cada espera dura como mucho `CAUCE_MIGRATION_LOCK_TIMEOUT_MS`
(5000 ms por defecto, `deploy.sh` lo pasa al migrator) y la toma de todos, ese tiempo más 1 s; si no
los consigue, falla sin aplicar nada. Migrator fallido o interrumpido → PostgreSQL revierte la transacción
(esquema intacto) y `deploy.sh` termina el backend que quede con `application_name=cauce-migrator`. En esos casos `prod.env` sigue con los pins
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
# 1b. Si este despliegue aplicó 081_membresia_rol_derivado.sql (deploy.sh imprime el aviso y este comando):
#     el gateway anterior lee human_tenant_memberships.role, que 081 retiró. Aplicar su down ANTES del paso 2,
#     salvo que el paso 3 restaure un dump previo a 081. Aborta si hay una migración posterior. Desde la raíz del clon nuevo:
docker exec -i cauce-v3-prod-postgres-1 psql -X -v ON_ERROR_STOP=1 --single-transaction -U cauce -d cauce \
  < packages/store/migrations/down/081_membresia_rol_derivado.sql
# 2. Restaurar el prod.env previo (el snapshot solo existe si el migrator terminó con 0)
cp -a /etc/cauce-v3/prod.env.pre-deploy-<STAMP> /etc/cauce-v3/prod.env
# 3. Solo si hay que restaurar la BD: usa el dump PREVIO anotado en la fase backup, nunca el más reciente.
(
  set -euo pipefail
  : "${CAUCE_PREDEPLOY_DUMP:?Define la ruta absoluta del dump previo aprobado}"
  [[ "$CAUCE_PREDEPLOY_DUMP" = /* ]]
  test -r "$CAUCE_PREDEPLOY_DUMP"
  (cd "$(dirname "$CAUCE_PREDEPLOY_DUMP")" && sha256sum -c "$(basename "$CAUCE_PREDEPLOY_DUMP").sha256")
  docker exec cauce-v3-prod-postgres-1 psql -X -v ON_ERROR_STOP=1 -U cauce -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cauce' AND pid<>pg_backend_pid()"
  docker exec cauce-v3-prod-postgres-1 dropdb -U cauce cauce
  docker exec cauce-v3-prod-postgres-1 createdb -U cauce cauce
  docker exec -i cauce-v3-prod-postgres-1 pg_restore --exit-on-error -U cauce -d cauce --no-owner --no-acl < "$CAUCE_PREDEPLOY_DUMP"
  # Con esquema 052 o posterior, --no-acl deja los logins de runtime sin permisos.
  docker exec cauce-v3-prod-postgres-1 psql -X -v ON_ERROR_STOP=1 -U cauce -d cauce -c "SELECT cauce_apply_runtime_grants()"
)
# Si este bloque falla, no continúes al paso 4: conserva los servicios de aplicación parados.
# 4. Levantar la versión previa con el compose del RELEASE ANTERIOR y sus overrides (NO el canónico)
docker compose --env-file /etc/cauce-v3/prod.env -f <PREV_RELEASE>/deploy/compose.yaml -f <PREV_RELEASE>/deploy/compose.postgres.yaml \
  $(printf -- '-f %s ' /etc/cauce-v3/compose-overrides/*.yaml) \
  --project-directory <PREV_RELEASE>/deploy up -d --wait --wait-timeout 300
# 5. Verificar (el esquema dirá la versión del dump restaurado — esperado).
#    En los logs de cada servicio, 42501 indica que faltó cauce_apply_runtime_grants().
./deploy/smoke.sh
```
Los nombres de contenedor del ejemplo derivan del `COMPOSE_PROJECT_NAME` por defecto (`cauce-v3-prod`); con otro proyecto cambian en consecuencia.

### Desplegar V4

V4 ya está desplegado según `deploy/HISTORIAL.md`. Las actualizaciones usan `deploy/deploy.sh` con recibo de tres pasos, overlay de flota y paquete de ordenadores del mismo candidato. La configuración inicial de proxy, red, controlador y autoridad se conserva entre releases; no se deduce del árbol de trabajo.

**Variables.** `CAUCE_DEPLOY_FLEET_OVERLAY` y `CAUCE_FRONT_PROXY_CIDR` van en el archivo de instancia (`prod.env`): `deploy.sh` las lee de ese archivo (`env_value`), no del entorno del proceso. `CAUCE_RESERVED_COMPANY_SLUGS` también va en `prod.env`, pero la consume Compose, no `deploy.sh`. `CAUCE_DEPLOY_GATES_RECEIPT` es del proceso que lanza el script.

- `CAUCE_DEPLOY_FLEET_OVERLAY=1`. Exige `cauce-fleet-v35-controller.service` activo antes de recrear el gateway y añade `deploy/compose.fleet.yaml`. Vacío o `0` despliega sin overlay. Cualquier otro valor aborta.
- `CAUCE_FRONT_PROXY_CIDR=<cidr del proxy frontal>`. `deploy.sh` lo pasa como build-arg de la imagen de consola (`deploy/Dockerfile`). nginx solo acepta `X-Forwarded-For` de ese CIDR (`set_real_ip_from`). Vacío borra la directiva y no se confía en ningún salto. Un carácter fuera de `0-9a-fA-F:./` falla el build. Si la variable no está en `prod.env`, `deploy.sh` no aborta y la imagen queda sin salto de confianza: hay que declararla antes de construir. Consulta el valor de tu instalación en su configuración privada; [parámetros](parametros.md) describe su significado.
- `CAUCE_RESERVED_COMPANY_SLUGS=<id>,<id>`. Identificadores de las empresas que la plataforma va a crear, separados por comas. `deploy.sh` no la lee. Compose la pasa al gateway (`${CAUCE_RESERVED_COMPANY_SLUGS:-}`; vacía si falta). Cada id tiene que cumplir `COMPANY_ID_PATTERN` y se suma a la lista fija de `services/gateway/src/company-slug.ts`. Un valor inválido impide arrancar el gateway. El registro público los rechaza con el mismo 409 que un identificador ocupado. Hay que reservarlos antes de abrir el registro; consulta los valores privados de tu instalación.
- `CAUCE_DEPLOY_GATES_RECEIPT`. Ruta absoluta del recibo de `scripts/release-gates.sh` del mismo commit, en el entorno del proceso. Obligatoria, salvo el escape `CAUCE_DEPLOY_SIN_RECIBO`. No va en `prod.env`. El comando de esta sección ya la exporta.
- `CAUCE_HARNESS_DESCRIPTOR_APPROVALS_DIR` (opcional en `prod.env`; por defecto `/etc/cauce-v3/harness-descriptor-approvals`). Directorio que solo contiene `approvals.json`, el mapa público `{harness: sha256}` que el dueño aprueba. `deploy/compose.yaml` lo monta en solo lectura y fija `CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE`; sin él el gateway retira todos los lectores de cuota de agente. `deploy.sh` se niega a construir si falta, no es un objeto de pins hex de 64 o algún pin no coincide con el descriptor de la release. Se genera desde el clon de la release y lo aprueba el dueño, pin a pin (`{}` no aprueba ninguno):
  ```bash
  install -d -m 0755 /etc/cauce-v3/harness-descriptor-approvals
  python3 ops/scripts/harness-descriptor-approvals.py codex claude grok \
    --output /etc/cauce-v3/harness-descriptor-approvals/approvals.json   # --replace para sustituirlo en otra release
  ```
  El script valida cada descriptor con el parser del executor e imprime `approve <harness> <sha256>` para la revisión. Cambiar un descriptor en una release exige regenerar y volver a aprobar.
- `CAUCE_NATIVE_CONTEXT_REPOSITORY_ROOT` queda sin definir en producción a propósito: la inspección nativa de contextos está apagada hasta que exista una raíz de repositorio independiente del broker (`CAUCE_CONTEXT_REPOSITORY_ROOT`); el gateway rechaza que ambas coincidan.

**Backup.** Con migraciones pendientes, `deploy.sh` baja la ventana a 2 h, no admite confirmación de un backup más viejo y repite el monitor justo antes del migrator. Sin migraciones pendientes sigue `CAUCE_DEPLOY_BACKUP_MAX_AGE_HOURS` (24 h por defecto) y un backup viejo admite confirmación. El detalle está en las precondiciones de esta sección.

**Red edge.** La consola tiene la IP fija `CAUCE_CONSOLE_EDGE_IP`, fuera del pool dinámico `CAUCE_EDGE_IP_RANGE`. Los valores por defecto están en `deploy/compose.yaml` y en `docs/parametros.md`. No hace falta declarar `CAUCE_TRUSTED_PROXY_CIDRS`: Compose lo deriva de `CAUCE_CONSOLE_EDGE_IP` más `/32`. Un override tiene que seguir esa misma IP. Cambiar el IPAM puede recrear la red. Tras el `up`, la IP efectiva de la consola tiene que ser `CAUCE_CONSOLE_EDGE_IP`. Si no lo es, recrear solo la consola con el mismo `docker compose` del despliegue (`up -d --no-deps --force-recreate console`) y volver a comprobar.

**Controlador y enclave.** El controlador tiene que estar activo antes de `deploy.sh`. El directorio del socket se crea antes; después del `up` se actualiza el controlador a la release del commit desplegado y solo entonces se instala el enclave desde el export de esa release. Hasta ese paso, un enclave que ya existiera sigue en la release anterior. Orden, preflight y reversión: [Enclave de autoridad firmada de la flota](#enclave-de-autoridad-firmada-de-la-flota).

**Semilla de autoridad.** Después de aplicar el esquema, desde la raíz del clon del despliegue en el host y como root, con la CLI de la imagen recién desplegada. Los correos se resuelven en la base y no se imprimen ni se versionan. Primero el `platform_admin`, después los owners de la empresa. Comandos y comprobación: [Siembra de autoridad](#siembra-de-autoridad-cauce-platform-admin-semilla).

**Reversión.** Sigue la receta de esta sección: no ejecutar `docker compose down`; restaurar `prod.env.pre-deploy-<STAMP>` y, si el esquema ya quedó confirmado, el dump previo. Si el despliegue aplicó `081_membresia_rol_derivado.sql`, el down de 081 (paso 1b de la receta) va antes de restaurar los pins: el gateway anterior lee la columna de rol que 081 retiró. El `down` de `054_company_admins.sql` aborta con `rollback preserves company authority` si hay un owner, un admin cuyo `source` no es `v4.0-hub-operator`, más de una empresa, filas en `platform_authority_events` o en `agent_role_template_owners`, o principals y roles de agente distintos de las filas de plataforma que esa migración conserva. La semilla deja historial en `platform_authority_events`, así que no se deshace con ese `down`: se restaura el dump previo o se corrige hacia delante.

**Publicar un candidato con `corte.sh` y `deploy1-*.sh`.** Los ayudantes de la sesión operativa
están en `.delegados/v4/`, fuera de Git. Contienen los destinos y directorios privados de esa
instalación; se usan allí, con autorización para integrar y desplegar. Un clon público no los
incluye. En otra instalación se usan `scripts/release-gates.sh` y `deploy/deploy.sh`, configurados
para sus propios destinos; no se copian accesos del operador.

1. **Cerrar los cambios y revisar.** Cada carril commitea sus rutas; el operador revisa el diff.
   `corte.sh` toma la cabeza de `claude/v4-cierre`, regenera los artefactos operativos en un worktree
   limpio y actualiza la rama solo si nadie la movió. No incluye cambios sin commitear de los carriles.
2. **Cortar y pasar los tres gates.** Desde el checkout autorizado:
   ```bash
   bash .delegados/v4/corte.sh
   ```
   Anota el SHA completo que imprime como candidato y la ruta del `recibo.json` verde.
   El script usa el clon de gate configurado en esa instalación; no cambies sus rutas desde otro carril.
   Si falla un paso, corrige, commitea y vuelve a cortar.
3. **Publicar y transferir.** Solo quien tenga autorización de integración/despliegue ejecuta:
   ```bash
   : "${CAUCE_CANDIDATE:?Define el SHA completo que imprimió corte.sh}"
   : "${CAUCE_RECEIPT_DIR:?Define el directorio del recibo verde}"
   bash .delegados/v4/deploy1-local.sh "$CAUCE_CANDIDATE" "$CAUCE_RECEIPT_DIR"
   ```
   Comprueba el recibo contra `--list` y publica `dev` y `main` al candidato, además de la rama de
   cierre. Transfiere bundle y recibo, construye y valida el paquete firmado de ordenadores del
   mismo SHA y lo instala en el destino. Si cambiaron los descriptores, exige aprobaciones nuevas:
   no reutilices las de otro digest.
   Las ramas se publican antes de construir el paquete: un fallo posterior no deshace esa publicación
   ni acredita un despliegue. Resuelve el fallo antes de pasar al host remoto.
4. **Preparar el host y desplegar por fases.** Con el destino SSH autorizado en `CAUCE_DEPLOY_HOST`:
   ```bash
   : "${CAUCE_DEPLOY_HOST:?Define el destino SSH autorizado}"
   ssh "$CAUCE_DEPLOY_HOST" bash -s -- "$CAUCE_CANDIDATE" pre < .delegados/v4/deploy1-vps.sh
   ssh "$CAUCE_DEPLOY_HOST" bash -s -- "$CAUCE_CANDIDATE" backup < .delegados/v4/deploy1-vps.sh
   ssh "$CAUCE_DEPLOY_HOST" bash -s -- "$CAUCE_CANDIDATE" clone < .delegados/v4/deploy1-vps.sh
   ssh "$CAUCE_DEPLOY_HOST" bash -s -- "$CAUCE_CANDIDATE" enclave0 < .delegados/v4/deploy1-vps.sh
   ssh "$CAUCE_DEPLOY_HOST" bash -s -- "$CAUCE_CANDIDATE" deploy < .delegados/v4/deploy1-vps.sh
   ```
   Ejecuta cada línea después de comprobar la anterior. `pre` informa recursos, controlador y
   permisos; `backup` exige backup y monitor exitosos; `clone` comprueba SHA, árbol limpio y recibo;
   `enclave0` prepara el directorio del socket. `deploy` lanza `deploy.sh` en segundo plano e imprime
   el log: ese mensaje acredita el arranque, no el éxito.
   Antes de `deploy`, anota en el registro privado la ruta y el SHA-256 del dump anterior al candidato;
   esa es la copia que se selecciona con `CAUCE_PREDEPLOY_DUMP` si hace falta revertir la BD.
5. **Comprobar el resultado.** Lee el final del log y la fila de `deploy/HISTORIAL.md`; verifica smoke,
   esquema e imágenes del candidato. Si cambió el controlador o el SDK, actualízalos con el kit de
   esa release ([controlador](v3.5-controlador-despliegue.md)) y luego el
   [enclave](#enclave-de-autoridad-firmada-de-la-flota). Los ayudantes no hacen esa actualización.
6. **Recorrer lo desplegado.** Con usuarios autorizados, comprueba los flujos afectados: acceso y
   personas, Mis cuotas y login, alta/preparación/baja de agentes, contexto del siguiente turno e
   historial en GitHub. Registra el SHA, acción, resultado y evidencia, y limpia los canarios propios.
   Un fallo funcional requiere corrección y un candidato nuevo. Actualiza el [informe final](v4-informe-final.md)
   separando código, comprobación local y comprobación desplegada.

#### Recorrido externo (`pnpm verify:external`)

Herramienta optativa de diagnóstico; no forma parte del gate de tres pasos. Comprueba desde fuera, contra la URL pública, que una empresa
nueva se registra y se usa, y que ninguna petición manipulada de una empresa lee, escribe ni enumera recursos de
otra. Usa solo la API pública: no necesita SSH, credenciales reales ni conexión a la base. Código en
`services/gateway/src/security/route-isolation-external*.ts`; la matriz de casos es la misma
`route-isolation-matrix.ts` de la guardia local.

```bash
pnpm verify:external --base-url https://<consola> --dry-run   # lista lo que hará; ninguna petición
pnpm verify:external --base-url https://<consola>             # ~1 900 peticiones a 5/s, unos 7 min
```

1. **Registro y empresa.** Registra `zz-canary-<run>-a` y `zz-canary-<run>-b` por `POST /v3/auth/register`
   (correos `@canary.example.invalid`, contraseñas aleatorias que no se imprimen), entra con
   `POST /v3/auth/login` y comprueba `GET /v3/auth/session`. Aborta si la empresa activa de la sesión no es su
   canario. En B crea sala, agente lector y su membresía, persona lectora, invitación de ordenador, cuenta de
   cuota, blob, plano de oficina y preferencias; en A, sala y membresía del owner.
2. **Aislamiento.** Desde la sesión de A contra B: los casos con sonda de la matriz (HEAD además en los GET),
   cabeceras de tenant (`x-cauce-tenant`, `x-cauce-alias`, `x-company-id`…) y parámetros de empresa ajenos
   sobre las vistas de A, credenciales cruzadas (CSRF de B, sin CSRF, cookie alterada, cookie de B como
   bearer) y WebSocket (`hello` de B bajo la cookie de A). Falla si una respuesta contiene un identificador o
   el contenido privado de B, si el estado no es el esperado o si B, releída con su propia sesión después de
   cada escritura, cambió fuera de los campos volátiles (los que varían entre dos lecturas seguidas).
3. **Limpieza.** Plano y preferencias vacíos, persona retirada, configuración revertida con el
   `inverse_mutation` de cada recibo, cuenta e invitación borradas y `DELETE /v3/console/companies/:id`, que
   retira la empresa (conserva los datos y deja la sesión sin autoridad), y logout. La purga de la persona no
   se intenta: la auditoría la nombra y la API solo purga a quien no tiene historial. El agente lector puede
   quedar (409 «durable dependencies») porque lo referencia la persona retirada; lo cierra la retirada de la
   empresa.

**Recibo.** `~/.local/state/cauce-v3/verify-external/<run>/receipt.json` (0600; `--receipt` y `--out-dir` lo
cambian): URL, sha del cliente (`client.sha` y `dirty`), canarios y si quedaron retirados, peticiones, totales y
cada caso. La salida resume `cases`, `passed`, `failures`, `not_configured` (501: plano apagado),
`not_mounted` (404 de ruta inexistente: el despliegue no monta ese plano), `inconclusive` y `synthetic`
(casos cuyo recurso de B no se puede crear por la API pública y usan un id bien formado ausente). Sale 0 solo
con `failures=0` y ambas empresas retiradas. `findings` anota lo que no es fallo; hoy, que un token copiado
antes del logout sigue valiendo hasta caducar (sesión sin estado, ver `password-auth.ts`).

**Seguridad de ejecución.** Exige `https` salvo en loopback; ritmo por defecto 5 peticiones/s
(`--rate`, máximo 10 fuera de loopback), presupuesto `--max-requests` (4 000) y un 429 con `Retry-After` de
hasta 60 s se reintenta una vez. Solo opera con las sesiones de los dos canarios que acaba de registrar. El
registro admite 5 intentos por IP cada 15 min y 20 por hora en todo el gateway
(`CAUCE_REGISTRATION_HOURLY_LIMIT`): cada ejecución gasta 2.

**Si se corta.** Las credenciales de los canarios quedan en `<out-dir>/<run>/canaries.json` (0600) hasta que
ambos se retiran; la salida indica `pending_cleanup=` y
`pnpm verify:external --base-url https://<consola> --cleanup <run>` los retira.

**Ensayo local.** `pnpm exec vitest run services/gateway/src/security/route-isolation-external.postgres.test.ts`
levanta el gateway real con PostgreSQL de Testcontainers en un puerto de loopback, ejecuta el mismo comando,
comprueba en la base que ambas empresas quedan retiradas y que el detector marca una fuga y una escritura
inyectadas, y recupera una ejecución cortada con `--cleanup`. En local no se montan terminal, relay,
repositorio de contexto ni bootstrap mTLS: sus rutas salen `not_mounted`; `--oauth-issuer` apunta las rutas
OAuth al emisor local, en producción no hace falta.

### Enclave de autoridad firmada de la flota

`cauce-fleet-signed-authority.service` atiende, por un socket Unix, el `POST /v3/fleet/hosts/:host_id/authority` que el gateway recibe de los ordenadores enrolados. Comprueba la firma del ordenador, su empresa, nonce, operación, claim y epoch, y emite con el emisor central del controlador: mismo `fleet-authority-issuer.py`, misma política `authority.v1.json` y misma CA. El lock del emisor en su `state_root` permite que ambos emitan sin pisarse. Corre como root en `server`, desde la release del controlador (`/usr/local/lib/cauce-v35/<sha>/app/services/gateway/dist/fleet/authority/signed-main.js`), con su mismo `node`, su `/etc/hosts` privado y su conexión `database-url` (login `cauce_fleet`; el pool de 4 cabe en su límite de 20). Sin el enclave, el gateway responde `AUTHORITY_UNAVAILABLE` y los ordenadores enrolados no anuncian `create`.

| Recurso | Dueño y modo |
|---|---|
| `/run/cauce-fleet-signed-authority/` | root:1000 `0750`; lo crea `/etc/tmpfiles.d/cauce-fleet-signed-authority.conf` en cada arranque, antes que Docker |
| `/run/cauce-fleet-signed-authority/authority.sock` | root:1000 `0660`; lo crea el enclave. El overlay de flota lo monta de solo lectura en el gateway (uid 1000) |
| `/etc/cauce-v3/fleet-v35/signed-authority/` | root `0700` |
| `command.v1.json` | root `0600`; copia exacta del `authority_command` de `controller.v1.json` (ejecutable, política y pins) |
| `authority.env` | root `0600`; `CAUCE_FLEET_AUTHORITY_*` y `NODE_ENV`/`PGSSLMODE`/`PGSSLROOTCERT` del controlador. Lleva la ruta del `database-url`, nunca la URL |
| `/etc/systemd/system/cauce-fleet-signed-authority.service` | root `0644`; plantilla `ops/systemd/cauce-fleet-signed-authority.service` |

**Prerrequisitos.** El controlador debe estar en una release que contenga `signed-main.js`, con `authority_command` en `controller.v1.json` y sus pins correctos. El preflight lo comprueba y, si falta, pide actualizar primero el controlador. `deploy.sh` exige que exista el directorio del socket antes del primer despliegue con este overlay, porque comprueba todas las fuentes de bind mounts.

**Orden con un despliegue** (root en `server`; el instalador es `ops/scripts/fleet-authority-install.py`, preflight sin `--apply`):
```bash
# 0. Antes de deploy.sh, desde el clon del despliegue: solo el directorio del socket y su tmpfiles
python3 ops/scripts/fleet-authority-install.py --socket-directory-only
python3 ops/scripts/fleet-authority-install.py --socket-directory-only --apply
# 1. deploy.sh; prod.env ya tiene CAUCE_DEPLOY_FLEET_OVERLAY=1 (el script no lo lee del entorno)
# 2. fleet-controller-upgrade.py a la release <R> (preflight y --apply), ver v3.5-controlador-despliegue.md
# 3. Enclave, con el export de <R> que usó el kit; PRIVATE_KIT_ROOT viene de la configuración privada
: "${PRIVATE_KIT_ROOT:?Define el directorio privado del kit autorizado}"
: "${RELEASE_ID:?Define la release exportada por el kit}"
python3 "$PRIVATE_KIT_ROOT/upgrade-kit/src-$RELEASE_ID/ops/scripts/fleet-authority-install.py"
python3 "$PRIVATE_KIT_ROOT/upgrade-kit/src-$RELEASE_ID/ops/scripts/fleet-authority-install.py" --apply
```
El preflight no escribe nada. Deriva release, `node`, `/etc/hosts`, entorno TLS y comando del controlador; comprueba los pins, el modo del `database-url` sin leerlo y el `--ready` del emisor; y muestra el diff de cada fichero. `--apply` escribe solo lo que cambia, con respaldo `*.pre-authority-<stamp>`. Hace `daemon-reload` más `restart` solo si algo cambió o el enclave estaba parado, verifica `ready` y solo entonces hace `enable` (si la verificación falla revierte los ficheros y deshace ese `enable`):
- la unidad está activa y sigue activa 3 s después;
- el directorio es root:1000 `0750` y el socket, recién creado, root:1000 `0660`;
- `--ready` del emisor: política, registros, `state_root` y par CA/clave;
- sonda sin firma como uid 1000 para el host `zz-canary-probe`: `403 forbidden` prueba que el enclave llegó a PostgreSQL y rechaza un ordenador no enrolado (`409 AUTHORITY_UNAVAILABLE` indica que no hay BD);
- la misma sonda como root: `403 AUTHORITY_REVOKED`, porque solo atiende al uid del gateway.

Repetirlo sin cambios solo verifica y vuelve a habilitar la unidad. La habilitación se realiza después de verificar el enclave; si falla, la reversión retira la habilitación añadida en esa ejecución y conserva la que ya existía. Tras cada actualización del controlador, repetir el paso 3 con el export de la release nueva: hasta entonces el enclave sigue en la anterior, que el kit conserva, y el preflight muestra la diferencia. La unidad queda habilitada en el arranque (`WantedBy=multi-user.target`) y arranca después del controlador (`After`), pero sigue activa de forma independiente cuando este se detiene o reinicia. Si falla al arrancar, `journalctl -u cauce-fleet-signed-authority` nombra la etapa sin secretos: `configuration`, `database configuration`, `issuer command` o `socket`.

**Aceptación de punta a punta** (la acción `ready` firmada): en server2, como `server`, `python3 <release>/ops/cli/fleet-executor.py --policy <política> --capabilities` devuelve `available: true` solo si `authority_ready` obtuvo `{"ready":true,"host_id":"<host>"}` del gateway y del enclave. El ensayo local con PostgreSQL real está en `services/gateway/src/fleet/authority/signed-main-postgres.test.ts`.

**Reversión.** Si falla la escritura de la configuración del enclave, su `daemon-reload`, el `restart`, la verificación o la habilitación de `--apply`, el instalador detiene el enclave solo si intentó reiniciarlo y ejecuta `disable` solo si esa ejecución intentó añadir la habilitación; conserva la que ya existía. Aunque falle `disable`, intenta restaurar los ficheros desde sus respaldos tras verificar su sha256, borrar lo creado en esa ejecución, hacer `daemon-reload` y arrancar el enclave anterior si estaba activo. Conserva el directorio del socket y su tmpfiles, porque el gateway los monta. El resultado final dice `ROLLBACK INCOMPLETE` y detalla el estado observado si falla `disable` (la nueva habilitación puede permanecer), si no se restaura un respaldo (conserva los ficheros actuales y de recuperación sin arrancar una configuración parcialmente restaurada), o si no se pueden borrar los ficheros creados, falla el `daemon-reload` de la reversión o el enclave anterior no vuelve a estar activo. Si no intentó reiniciar el enclave, la reversión no lo detiene. Para volver a mano a una configuración anterior: copiar el `*.pre-authority-<stamp>` sobre su fichero, `systemctl daemon-reload && systemctl restart cauce-fleet-signed-authority` y repetir el preflight. `systemctl stop cauce-fleet-signed-authority` corta la emisión firmada (fail-closed) sin tocar el controlador ni su emisor.

### Servicio de decisiones

Proyecto compose propio (`deploy/decisiones/`, script `desplegar.sh`): `deploy.sh` nunca lo toca y él nunca toca el bus. Su auditoría es solo PostgreSQL (`audit_events`); el compose ya no declara variable ni volumen de fichero. El JSONL histórico queda en el volumen Docker `cauce-decisiones_decisiones_auditoria` del host, sin montar: se conserva tal cual hasta que el dueño decida su destino, y nadie lo lee. Para inspeccionarlo sin montarlo en el servicio: `docker run --rm -v cauce-decisiones_decisiones_auditoria:/v:ro alpine cat /v/auditoria.jsonl`. No borrar el volumen como parte de un despliegue.

## 2. Alta y baja de un agente

El flujo de V4 empieza en **Ajustes → Agentes → Añadir agente**: registrar, asignar computadora y
grupo inicial, previsualizar y crear; después **Preparar en la computadora** y completar el login
del proveedor. El registro y la operación física son pasos distintos. Para un agente existente,
abre su ficha y usa **Registro** u **Operación**. No des por completada una operación en cola.

Para agentes con ejecución, **Eliminar** guía primero el retiro reversible y después la eliminación
definitiva. Los que no tienen entorno se borran desde **Registro → Eliminar registro**. Descarga
antes la copia si existe un espacio y revisa la previsualización de lo que se conserva y se borra.
Pasos de interfaz: [crear y preparar](v4-guia.md#crear-y-preparar-un-agente) y
[eliminar](v4-guia.md#editar-detener-o-eliminar-un-agente). Por CLI: [espacios](v4-cli.md).
Para conectar una computadora: [alta de servidor](v4-alta-servidor.md).

**Flota declarativa heredada.** `ops/flota.json` y sus artefactos siguen describiendo agentes
preexistentes; no son el flujo de alta de un agente dinámico V4. Si el operador cambia esa flota,
debe exportar el estado aprobado de la BD y regenerar/validar los derivados con los scripts de
`ops/scripts/`; nunca edita a mano `ops/container-aliases.json`, `ops/manifests/*.yaml` o
`ops/generated/**`. El aprovisionamiento heredado y su PKI quedan en [despliegue de flota](v3.5-despliegue-flota.md).
Un registro deshabilitado por sí solo no revoca una identidad de ejecución.

### Reponer una entrega fallida desde el CLI

`cauce-reponer <delivery_id>` exige `CAUCE_GATEWAY` con la URL del gateway de la
instalación. Si falta o está vacía, sale con código `2`, nombra la variable y no abre
SSH. Ejemplo ficticio:

```bash
CAUCE_GATEWAY=https://gateway.example.invalid:8443 ops/cli/cauce-reponer <delivery_id>
```

El helper usa el acceso SSH `agora-storage` y el certificado cliente de consola
disponible allí. La entrega debe tener una fila en `dead_letters`; antes de reponerla,
comprueba que no haya una conversación más reciente ni trabajo en vuelo. Tras una
respuesta HTTP `200`, verifica que la entrega nueva termine y su respuesta salga por
`adapter_outbox` con `status=sent`.

### CLI de cuentas humanas de consola

Con `DATABASE_URL` apuntando a la instancia elegida, `pnpm console:user --email persona@example.com`
pide una contraseña nueva (o lee `CAUCE_CONSOLE_USER_PASSWORD`). No pasar contraseñas por argumentos.
No hay tenant ni alias por defecto.

- **Alta:** exige `--tenant` y `--alias`. Sin `--update`, omitir cualquiera de los dos falla antes de
  escribir. El nombre, si se omite, es la parte local del correo; el rol, si se omite, es `operator`;
  la cuenta se crea activa. `--name` y `--role` sustituyen esos valores.
- **Rotar la contraseña** de una cuenta que ya existe:
  `pnpm console:user --email persona@example.com --update`. No crea la cuenta si el correo no existe.
  Omitir nombre, rol, tenant o alias conserva el valor persistido. El correo normalizado identifica
  la cuenta; no se reescribe su correo de presentación ni se reactiva una cuenta dada de baja.
- **Mantenimiento sin alta accidental:** `--update` es obligatorio. Sin él, el comando exige tenant
  y alias aunque la cuenta ya exista; si el correo no existe, `--update` falla sin crear.
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

Primer despliegue de V4 en producción, desde la raíz del clon del despliegue vigente del host, como root. Define `CORREO_SUPER_ADMIN` y `CORREO_OWNER` con las cuentas aprobadas por el operador; no se versionan sus valores:

```bash
ops/cli/cauce-platform-contenedor --mostrar     # solo muestra imagen, red y secretos
cauce platform contenedor admin semilla --email "$CORREO_SUPER_ADMIN"
: "${CAUCE_COMPANY_ID:?Define la empresa autorizada}"
for correo in "$CORREO_SUPER_ADMIN" "$CORREO_OWNER"; do
  cauce platform contenedor admin semilla --email "$correo" --company "$CAUCE_COMPANY_ID" --role owner
done
```

Repetir el bloque no cambia nada. Verificación: al volver a entrar, `GET /v3/auth/session` muestra
`role=platform_admin` para el administrador de plataforma y `role=company_owner`, `scope=company` para el dueño de la empresa.

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
(`ops/container-runtime/cauce_container_tree.py:233`) acredita que ese metadato se
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

### Guardias: variables obligatorias

Las units de usuario leen `%h/.config/cauce/guardias.env`. El CLI no carga ese
fichero: su directorio es `~/.config/cauce-v3/` (`alias-host.tsv` y el resto) y
ninguna unit de guardia lee `guardias.env` desde ahí. Las de sistema del host
principal leen `/etc/cauce-v3/guardias.env`. La supervisión de Praxis lee
`/etc/cauce-v3-hospital/guardias.env`. En los tres casos el fichero es modo
`0600` y pertenece al usuario que ejecuta la unit (el de `User=` o el de
`systemd --user`). Queda fuera del repositorio. Sin el prefijo `-`,
systemd no arranca la unit si el fichero no existe. El monitor médico y `cauce-ai-live` llevan
el prefijo: pueden arrancar sin él. El monitor, si falta el chat, lo anota en su log y en el
journal y sigue. `cred-guard` y la supervisión de Praxis no lo llevan: la variable es obligatoria.

| Variable | Quién la exige | Significado | Ejemplo ficticio |
|---|---|---|---|
| `CAUCE_CRED_GUARD_TARGETS` | `cred-guard.py` | Ruta de un JSON privado con `targets` y `remote_targets` | `/etc/cauce-v3/cred-guard-targets.json` |
| `CAUCE_OWNER_TELEGRAM_CHAT_ID` | aviso del médico y `praxis-supervision-evidence.py` | Chat del operador. El médico sigue si falta. Praxis rechaza el origen (`owner_conversation_unconfigured`) tras escribir el nombre de la variable. | `1000000001` |
| `CAUCE_DECISIONES_SMOKE_PKI` | `deploy/decisiones/desplegar.sh` | Directorio de la PKI de humo. Sin ella el despliegue sale 1. | `/etc/cauce-v3/pki/smoke` |
| `CAUCE_REMOTE_USER` | `cauce` cuando la ruta es `vps` | Usuario remoto. Si falta, esa ruta sale 2 y `cauce flota` omite el VPS. | `ops` |

`CODEX_HOME` no es obligatoria. Si falta, `cauce-ai-live` lo escribe en stderr y usa `~/.codex`.

Las copias ya instaladas (el binario de `~/.local/bin`, las units del host y `/usr/local/sbin`) no
cambian hasta reinstalar. Editar este árbol no las actualiza.

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
siega (`reap_orphan_agents` en `ops/pty-agent/cauce-pty-launcher.sh`) inmediatamente antes del nuevo
`exec` en `start_agent`. Reconoce de forma exacta el argv actual y el legado.
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
| `cauce-v3-host-backup.timer` | 03:10 UTC diario | `pg_dump --format=custom` del contenedor de postgres → `$DB_BACKUP_DIR/cauce-<ts>.dump` + `.sha256` (`DB_BACKUP_DIR` por defecto `/opt/_archive/cauce-v3-db-backups`, `ops/scripts/host-backup.sh:206`); valida con un restore AISLADO (postgres efímero sin red) antes de publicar; retención local `DB_RETENTION_DAYS` (14 por defecto, `:208`) tras confirmar copia off-site; sincroniza al destino `OFFSITE_USER@OFFSITE_HOST` (append-only, nunca borra remoto) |
| `cauce-v3-respaldo-torre.timer` | 04:30 UTC diario | manda los dumps y `/etc/cauce-v3` (tar 0600) al host de respaldo que declara `ops/scripts/backup-a-torre.sh`, y de ahí a almacenamiento externo con `rclone` |
| `cauce-v3-host-backup-monitor.timer` | 00/06/12/18:45 UTC | verifica que el backup corrió y con éxito reciente (`overall == "ok"` en `$STATUS_FILE`, por defecto `/var/log/cauce-v3-backup/status.json`) |
| `cauce-v3-watchdog@.timer` / `cauce-v3-reconciler@.timer` | cada 30 s / cada 5 min, por alias | salud y reconciliación de cada adaptador |
| `cauce-v3-health@.timer` | cada minuto, por instancia | sonda periódica de salud |
| `cauce-v3-quota-collector.timer` | cada 5 min | recolector de cuotas de IA |
| `cauce-v3-ci-local.timer` | Según la unidad instalada | Comprobaciones locales optativas en un worktree desechable; no bloquean el despliegue. Consultar su estado antes de asumir que está activo |

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
`CAUCE_SMOKE_EXPECTED_AGENTS` (`deploy/smoke.sh:74`, cargada mediante `load_required_setting` en `:50-56`, sin valor por defecto): se compara contra los
agentes habilitados con lease vivo y heartbeat fresco, así que hay que declararla igual al número de
alias habilitados de la instalación. Lee ambas salidas del relay y falla si no puede realizar una
consulta. No sustituirlo por conteos parciales ni usar una conexión sin TLS verificado para
acreditar salud.

Para comprobar recursos huérfanos en el host de ejecución, exporta a un JSON las filas actuales de
`agents` que pertenecen a ese host, con `runtime_key`, `container_name`, `runtime_mode` y `host_id`.
Incluye los agentes retirados que aún conservan recursos; excluye los purgados. Conserva el fichero
con permisos privados y ejecuta:

```bash
python3 ops/cli/fleet_orphan_sweep.py --rows "$CAUCE_FLEET_ROWS_JSON" --host-id "$CAUCE_HOST_ID"
```

El comando solo lee Docker y el JSON: informa recursos con etiquetas `cauce.fleet.*` sin fila y
filas de modo `container` cuyo contenedor no existe. Devuelve `0` si está limpio y `1` si encuentra
huérfanos; no borra recursos ni verifica salud o procesos nativos. El JSON debe corresponder al
estado actual del host para evitar falsos resultados. En pruebas puede limitarse con
`--runtime-key-prefix` al prefijo único de la operación. Los gates físicos y simulacros añaden un
inventario de nombres canarios propios para detectar también contenedores y volúmenes sin
etiquetas, y exigen un barrido limpio después de su limpieza antes de cerrar la base de prueba.

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
