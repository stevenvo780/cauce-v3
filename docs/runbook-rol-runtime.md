# Runbook: rol de runtime de mínimo privilegio

Cómo pasar el runtime de producción del rol propietario `cauce` (superusuario, dueño de todas las tablas) a logins propios sin privilegios de dueño, y cómo deshacerlo. El diseño está en `docs/v4-plan-multiempresa.md`, «Diseño V4.1», §4.1 y §5. Este documento es el paquete WP-B.

**Nada de esto cambia el comportamiento mientras el runtime siga conectando como `cauce`.** La migración 052 crea los grupos y concede los permisos; un superusuario los atraviesa todos. El cambio real llega al conmutar cada servicio a su login, en una ventana distinta de R1.

## 1. Qué crea la migración 052

**Grupos** (`NOLOGIN`, del clúster; la migración tolera que ya existan y aborta si alguno tiene `LOGIN`, `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION` o pertenece a otro rol):

| Grupo | Para qué |
|---|---|
| `cauce_runtime` | gateway, dispatcher, telegram-bridge y controlador de flota |
| `cauce_observer` | `outbox-metrics`, `fleet-watchdog` y `mcp-fleet-monitor` |
| `cauce_platform` | rol propietario y CLI de plataforma; la migración lo concede a quien la ejecuta |

**Clases de permisos del runtime.** Siempre una lista explícita de tablas de migración, nunca `ON ALL TABLES`: las tablas ad hoc de producción (`respaldo_*`, `zeus_*`, `deliveries_bak_*`) y sus vistas quedan solo para el dueño.

| Clase | Tablas | Permisos de `cauce_runtime` |
|---|---|---|
| Plataforma, solo lectura | `companies`, `company_links`, `platform_admins`, `schema_migrations`, `schema_migration_ledger`, `schema_migration_verifications`, `agent_role_templates`, vista `cauce_dlq_inventory_030` | `SELECT` |
| Catálogo bloqueable | `harness_definitions`, `role_policies` | `SELECT`, `UPDATE` solo para bloqueos; toda escritura la rechaza el trigger `*_platform_write` (42501) |
| Política de cadena | `agent_chain_policies` | `SELECT`, `UPDATE`; desde 066 el trigger diferido `agent_chain_policies_platform_revision` rechaza al confirmar (42501) todo cambio sin una revisión de plataforma de esa política en la misma transacción, salvo como `cauce_platform` |
| Historial de flota | `fleet_operation_events` | `SELECT`, `INSERT` |
| Historial de flota con bloqueos | `fleet_runtime_identities`, `fleet_operations` | `SELECT`, `INSERT`, `UPDATE`, sin `DELETE`; los triggers de 048 rechazan todo cambio de una identidad y los de atribución de una operación |
| Revisiones | `config_revisions` | `SELECT`, `INSERT`, `UPDATE` (el trigger de solo-anexar llega en 053) |
| Auditoría | `audit_events` | `SELECT`, `INSERT`, `DELETE` (retención), `UPDATE` solo para bloqueos; reescribir filas lo rechaza `audit_events_platform_rewrite` (42501) |
| Espacios | `tenants` | `SELECT`, `INSERT`, `DELETE` y `UPDATE` de todas las columnas salvo `id` y `company_id` |
| Resto de tablas de migración | 74 tablas | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |

Además: `CONNECT` a la base y `USAGE` del esquema `public`; `USAGE` y `SELECT` de las 12 secuencias; `EXECUTE` de las funciones DEFINER `cauce_lock_company_link` y `cauce_lock_hub_star_tenant`. Las demás funciones son `INVOKER` y siguen ejecutables por `PUBLIC`: no dan más permisos que los de quien llama. Nadie salvo el dueño crea objetos en `public`.

**Permisos re-aplicables.** Los permisos no están sueltos en la migración: viven en `cauce_runtime_grants_052()`, y `cauce_apply_runtime_grants()` ejecuta en orden todas las `cauce_runtime_grants_NNN()`. Las dos son `INVOKER` y solo las ejecuta `cauce_platform`. Son idempotentes: crean los grupos si faltan, conceden `cauce_platform` a quien las llama y vuelven a quitar a `PUBLIC` las funciones DEFINER. Sirven para una restauración sin ACL (§6).

**`search_path` de las funciones y `TEMPORARY`.** Si `pg_temp` no aparece en `search_path`, PostgreSQL lo recorre el primero al resolver relaciones y tipos. Una función con una tabla sin cualificar sería secuestrable con una tabla temporal del mismo nombre: las guardas son `INVOKER` y corren como quien escribe, así que una tabla temporal `messages` o `acl_edges` saltaba la guarda hub-star de `deliveries` y la de `tenants`. Por eso toda función DEFINER fija `search_path=pg_catalog,public,pg_temp`, con `pg_temp` el último (052 se lo pone a las dos de 051), y 066 extiende la regla a toda función de `public` que nombre una relación o un tipo de `public`, sea DEFINER o INVOKER. Las funciones SQL puras de los CHECK (`cauce_text_items_ok`, `cauce_utf16_units`) quedan sin `SET`, que impediría su inlining (038). Además 066 quita `TEMPORARY` sobre la base a `PUBLIC`, `cauce_runtime` y `cauce_observer` en `cauce_runtime_grants_066()`, así que la repetición tras una restauración, cuya base nueva vuelve a dar `TEMPORARY` a `PUBLIC`, lo quita otra vez. Ningún camino del runtime crea objetos temporales.

**Orden de bloqueos.** 052 toma primero `tenants` en `ACCESS EXCLUSIVE` y después `audit_events`, `harness_definitions` y `role_policies` en `SHARE ROW EXCLUSIVE`. Es el orden canónico de 051 y 053, así que el bundle de R1, que va en una sola transacción, nunca lo invierte. `lock_timeout` es de 5 s.

`cauce_observer` solo tiene `SELECT` sobre `adapter_outbox`, `agent_output_materializations`, `agents`, `connection_leases`, `dead_letters`, `deliveries`, `messages`, `outbox_dead_letters` y `tenants`.

**Decisión: `UPDATE` para bloquear, con trigger de guarda.** PostgreSQL exige `UPDATE` para `SELECT … FOR SHARE/UPDATE` y para `LOCK TABLE … IN SHARE MODE`. El runtime bloquea filas de `role_policies` en unas quince consultas de autorización (store, gateway y las funciones DLQ de 030), `harness_definitions` en la admisión de flota, `audit_events` en el linaje de respuestas de agente y `fleet_runtime_identities` en la adopción heredada. `fleet-adoption-snapshot.ts` hace además `LOCK TABLE memberships,role_policies,provider_accounts IN SHARE MODE`. Con solo `SELECT`, esos caminos fallarían con 42501 al conmutar. Se concede `UPDATE` y la escritura la cierra un trigger por sentencia, `cauce_platform_write_guard()`, que exige ser miembro de `cauce_platform`. El runtime no es dueño de las tablas, así que no puede desactivarlo ni borrarlo. Un superusuario cuenta como miembro de todo rol, por eso el comportamiento con `cauce` no cambia. 054 (G1) reutiliza la misma función en las tablas del plano de plataforma.

**Riesgo aceptado: `LOCK TABLE` sobre los catálogos.** Con `UPDATE`, el runtime también puede tomar `LOCK TABLE harness_definitions|role_policies IN ACCESS EXCLUSIVE MODE` y bloquear a todos los lectores mientras dure su transacción. La guarda de escritura no lo impide; sí rechaza la vista temporal actualizable, `MERGE` y el CTE con escritura. Es una denegación de servicio, no una escritura, y el runtime ya puede hacer lo mismo con las ~80 tablas en las que escribe. Si se quiere cerrar, cuando WP-D y WP-E toquen esas consultas, el `UPDATE` se sustituye por helpers DEFINER de bloqueo.

**Regla para migraciones nuevas.** Cada tabla, vista, secuencia o función nueva declara su permiso en una función propia, `cauce_runtime_grants_NNN()` (idempotente, `INVOKER`, sin `EXECUTE` para `PUBLIC` y con `EXECUTE` para `cauce_platform`), y la migración la ejecuta. Así `cauce_apply_runtime_grants()` la repite tras una restauración. `packages/store/test/runtime-grants-postgres.test.ts` falla si queda algo sin clasificar:
- toda relación de migración debe dar al runtime al menos un permiso, y solo de DML;
- una secuencia da `USAGE` y `SELECT` al runtime solo si este inserta en la tabla que la posee;
- la lista de funciones cerradas a `PUBLIC` es exacta: todas las de 053 y 054, más las de permisos y las DEFINER de 052. El runtime solo ejecuta las DEFINER y las que llaman sus escrituras guardadas;
- toda función DEFINER debe tener `search_path` fijo que termine en `pg_temp` y no ser ejecutable por `PUBLIC`;
- toda función debe poder ejecutarla `cauce_runtime` o `cauce_platform`;
- tras borrar todas las ACL del esquema, como deja `pg_restore --no-acl`, `cauce_apply_runtime_grants()` devuelve exactamente los permisos de los grupos y de `PUBLIC`.

`packages/store/test/runtime-hardening-postgres.test.ts` falla además si una función de `public` nombra una relación o un tipo de `public` sin un `search_path` que termine en `pg_temp`, o si un fuente del runtime crea objetos temporales.

**`down/052`** (solo en desarrollo o en un clon):
- se niega si hay una migración posterior o un login miembro conectado a la base;
- quita los triggers, la función de guarda y las dos funciones de permisos, y devuelve a las funciones de 051 su `search_path`;
- revoca solo los permisos que nombran a los grupos, sin materializar ACL en el resto de objetos;
- borra cada grupo solo si ninguna otra base del clúster le concede algo. Si alguna lo hace, el grupo queda inerte;
- se niega a borrar `cauce_runtime` o `cauce_observer` mientras tengan logins miembros: el `DROP ROLE` les quitaría la pertenencia en silencio y volver a aplicar 052 no la devuelve. Primero hay que borrar esos logins (`DROP ROLE cauce_gateway, …`) o revocarles el grupo. Tras volver a aplicar 052, se recrean con `provision-db-roles.py --rotate --apply` y se recrean sus consumidores.

El catálogo tras el `down` es el de una base migrada hasta 051 (permisos efectivos, funciones y triggers), y volver a aplicar 052 da los mismos permisos.

## 2. Logins

| Login | Grupo | Consumidor | Pools máx. | Límite | URL |
|---|---|---|---|---|---|
| `cauce_gateway` | `cauce_runtime` | gateway (con overlay de flota) y `console-user-cli` por `docker exec` | 20 + 2 | 30 | `CAUCE_DATABASE_URL_GATEWAY_SECRET_PATH` |
| `cauce_dispatcher` | `cauce_runtime` | dispatcher (sus métricas lanzan 10 consultas en paralelo) | 20 | 25 | `CAUCE_DATABASE_URL_DISPATCHER_SECRET_PATH` |
| `cauce_bridge` | `cauce_runtime` | telegram-bridge (un poller por bot más el egreso) | 20 | 25 | `CAUCE_DATABASE_URL_BRIDGE_SECRET_PATH` |
| `cauce_observer_login` | `cauce_observer` | outbox-metrics y fleet-watchdog (`psql`) | 2 + 1 | 5 | `CAUCE_DATABASE_URL_OBSERVER_SECRET_PATH` |
| `cauce_fleet` | `cauce_runtime` | `cauce-fleet-v35-controller` (host) y `fleet/auth-main` de cada ejecutor | 4 + 1, y 4 por ejecutor | 20 | `database_url_fleet` |
| `cauce_monitor` | `cauce_observer` | `mcp-fleet-monitor` | 20 por instancia | 25 | `database_url_monitor` |
| `cauce_backup` | `pg_read_all_data` | `backup.sh` (`pg_dump` por TCP, sin `-j`) | 1 | 2 | `database_url_backup` |
| `cauce` | `cauce_platform` | migrador, `psql` del operador, CLI de plataforma | — | — | `CAUCE_DATABASE_URL_SECRET_PATH` |

**Límites.** Cada límite es la suma de los pools máximos de sus consumidores (`createPool` usa 20 si no se indica) más un margen. Con un límite menor que el pool, una ráfaga falla con 53300 (`too many connections for role`) en vez de esperar en el pool. La suma de los pools máximos, 95 con un ejecutor, cabe en `max_connections=100` (el valor por defecto; `compose.postgres.yaml` no lo cambia) menos las 3 reservadas a superusuarios. La suma de los límites (132) no tiene por qué caber: el límite por login solo corta a un consumidor desbocado. Un login sin superusuario no usa las conexiones reservadas, así que el migrador y el operador siguen entrando aunque el runtime agote el resto. Si hay más de 3 ejecutores, o más de una instancia de `mcp-fleet-monitor` con el mismo login, sube el límite con `ALTER ROLE … CONNECTION LIMIT n`.

`deploy/compose.yaml` monta en cada servicio **su** secreto con `target: database_url`, así que el código no cambia. Si falta la variable de un servicio, Compose usa la URL del propietario y `deploy.sh` avisa con `AVISO: runtime con superusuario`. El migrador conserva siempre `database_url`. `compose.fleet.yaml` no necesita cambios: solo añade entorno y montajes al gateway, que ya lee su propio secreto.

## 3. Requisitos previos

- R1 (052–054) desplegado y estable; `schema_migrations` llega a 054.
- **Ninguna tabla ad hoc en `public`.** Las previsualizaciones de dependencias de configuración (borrado de agente o de tenant) y de purga de flota recorren todas las tablas de `public` cuyas columnas encajan con tenant y alias. Producción tiene 16 tablas de respaldo solo del dueño (`respaldo_*`, `deliveries_bak_*`, `zeus_*`), y como runtime esas lecturas fallan con 42501. Hoy, como `cauce`, además cuentan sus filas como dependencias. Comprobación (debe dar 0 filas):
  ```bash
  docker exec cauce-v3-prod-postgres-1 psql -X -U cauce -d cauce -Atc \
    "SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
       AND NOT has_table_privilege('cauce_runtime',c.oid,'SELECT') ORDER BY 1"
  ```
  La decisión es del dueño: moverlas a un esquema propio (`CREATE SCHEMA respaldo; ALTER TABLE <tabla> SET SCHEMA respaldo;`, que solo toca metadatos) o borrarlas. La otra salida es que WP-D y WP-E limiten esos recorridos a tablas legibles (`has_table_privilege(source.oid,'SELECT')`). `provision-db-roles.py --apply` se niega mientras existan, salvo que solo rote logins que ya existen.
- `pnpm test:runtime-role` en verde sobre el commit desplegado.
- El ensayo en clon (§9) en verde.
- `backup.sh` reciente con copia offsite (kratos y gdrive).
- Inventario de consumidores de la base hecho (§4, paso 1).

## 4. Conmutación (sin ventana de mantenimiento)

**Paso 1. Inventariar los consumidores.**
- Compose: migrator, gateway, dispatcher, outbox-metrics y telegram-bridge.
- Host: el controlador de flota (`/etc/cauce-v3/fleet-v35/controller/database-url`) y `fleet-watchdog.env`.
- Sin verificar todavía: `host-backup`, `quota-collector`, `cauce-huerfanas`, `cauce-panel` y `mcp-fleet-monitor`. Hay que clasificarlos antes del paso 6.
- Foto de partida:
  ```bash
  docker exec cauce-v3-prod-postgres-1 psql -X -U cauce -d cauce -c \
    "SELECT usename,application_name,count(*) FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY 1,2 ORDER BY 1,2"
  ```

**Paso 2. Crear los logins.** Primero en seco (lee la base, no escribe nada), luego con `--apply`:
```bash
cd /ruta/del/checkout
python3 ops/scripts/provision-db-roles.py --env /etc/cauce-v3/prod.env \
  --template cauce_fleet=/etc/cauce-v3/fleet-v35/controller/database-url
python3 ops/scripts/provision-db-roles.py --env /etc/cauce-v3/prod.env \
  --template cauce_fleet=/etc/cauce-v3/fleet-v35/controller/database-url --apply
```
Para cada login el script hace lo siguiente:
- genera 32 bytes aleatorios y calcula **localmente** el verificador SCRAM-SHA-256;
- envía solo el verificador, por stdin a `docker exec -i … psql -U cauce`, en una única transacción (`CREATE ROLE … LOGIN … CONNECTION LIMIT n PASSWORD 'SCRAM-SHA-256$4096:…' IN ROLE <grupo>`, con `log_statement` apagado en esa transacción);
- escribe su URL junto a la del propietario (`database_url_<servicio>`). Copia host, base, `sslmode` y CA de la plantilla y cambia solo usuario y contraseña. La escritura es atómica, con modo 0400 y el dueño de la plantilla. `--template LOGIN=RUTA` toma como plantilla la URL actual de un consumidor del host para conservar su host y su TLS. Sin `--template`, la URL de un login del host lleva el host de Compose (`postgres`), que el host no resuelve: el plan lo avisa;
- verifica cada login, también los del host, con un contenedor efímero de la imagen runtime en la red `backend` y el host de la URL del propietario. El contenedor recibe la URL por stdin. Comprueba que `current_user` es el login, `rolsuper=false`, que no puede insertar en `platform_admins` y que lee `tenants`. La ruta propia de cada consumidor del host (127.x y `CAUCE_FLEET_DATABASE_TLS_SERVERNAME`) se comprueba en el paso 5, al reiniciarlo;
- solo si todo verifica, copia `prod.env` a `prod.env.pre-roles-<stamp>` y añade las cuatro variables `CAUCE_DATABASE_URL_*_SECRET_PATH`. Si una verificación falla, `prod.env` queda intacto y un despliegue posterior no conmuta nada.

Nunca imprime contraseñas, verificadores ni URL. Si un login o un fichero ya existe, se detiene antes de tocar nada. `--rotate` rota explícitamente, y entonces hay que recrear sus consumidores, porque Compose monta el fichero por inodo. `--login NOMBRE` limita la ejecución a algunos logins. Si la transacción de roles ya se confirmó y falla la publicación de un fichero, los ficheros preparados (`.provision-*`, 0400) se conservan y el error los nombra: hay que moverlos a mano a su destino, porque los roles ya tienen la contraseña nueva.

**Paso 3. Compose.** El comando de Compose sale de `deploy.sh`, no se escribe a mano. `deploy.sh` exporta variables que el Compose necesita: `CAUCE_TERMINAL_RELAY_INSTANCE_ID`, `CAUCE_BLOB_API_ENABLED` y, con el terminal apagado, las rutas del cliente del relay a `/dev/null`. Además, el overlay MCP se renderiza con `env -u`. Un comando escrito a mano recrearía el gateway con otra configuración. `CAUCE_DEPLOY_PRINT_COMPOSE=1` hace las comprobaciones de configuración de un despliegue, imprime el comando exacto en una línea y sale sin tocar git, imágenes ni la base. Desde el checkout desplegado:
```bash
recipe() { env CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_PRINT_COMPOSE=1 CAUCE_ENV_FILE="$1" \
  CAUCE_MCP_OAUTH_SIGNING_KEY_PATH=/etc/cauce-v3/mcp-oauth/signing-key.pem ./deploy/deploy.sh; }
NEW="$(recipe /etc/cauce-v3/prod.env)"; OLD="$(recipe /etc/cauce-v3/prod.env.pre-roles-<stamp>)"
compose() { eval "$NEW"' "$@"'; }
# El comando reproduce lo desplegado: el hash de cada servicio coincide con el del contenedor vivo.
for service in outbox-metrics telegram-bridge dispatcher gateway; do
  [ "$(compose config --hash "$service" | awk '{print $2}')" = \
    "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "cauce-v3-prod-$service-1")" ] \
    && echo "OK $service" || echo "DISTINTO $service: no sigas"
done
# Lo único que cambia son los ficheros de los cuatro secretos.
diff <(eval "$OLD config") <(eval "$NEW config")
```
El hash de servicio de Compose no incluye la ruta del fichero de un secreto. Por eso coincide con el comando nuevo, y por eso mismo `up -d` sin `--force-recreate` no recrea el contenedor y lo deja con la URL del propietario.

**Paso 4. Conmutar servicio a servicio**, en este orden: outbox-metrics, telegram-bridge, dispatcher y gateway.
```bash
compose up -d --no-deps --force-recreate --wait <servicio>
```
Tras cada servicio:
- `/health/ready` del servicio (el gateway con `docker exec cauce-v3-prod-gateway-1 node /app/deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready`);
- `docker logs --since 10m cauce-v3-prod-<servicio>-1 2>&1 | grep -c 42501` debe dar 0;
- la consulta de `pg_stat_activity` del paso 1: el servicio ya aparece con su login.

**Paso 5. Host.**
- El controlador pasa a `cauce_fleet`. Guarda el fichero actual como `database-url.pre-roles-<stamp>` y sustitúyelo conservando dueño y modo: `install -m 0400 -o "$(stat -c %u database-url)" -g "$(stat -c %g database-url)" /etc/cauce-v3/secrets/database_url_fleet database-url`. Después, `systemctl restart cauce-fleet-v35-controller`.
- El watchdog pasa al login de observador: `CAUCE_DATABASE_URL` en `fleet-watchdog.env`.
- `mcp-fleet-monitor` pasa a `cauce_monitor` y el respaldo a `cauce_backup`, cada uno según el inventario del paso 1.

**Paso 6. Comprobación final.** Solo el migrador, el `psql` del operador y la CLI de plataforma usan `cauce`. Añade `CAUCE_RUNTIME_ROLES_ENFORCED=1` a `prod.env`. Desde ese momento `deploy/smoke.sh` da `ROJO rol de runtime` si alguna conexión de `cauce` lleva un `application_name` de runtime (`cauce-v3`, `cauce-fleet-host`, `cauce-fleet-adoption-drain` o `cauce-fleet-auth`). Antes de esa marca solo avisa.

**Paso 7. Rotar la contraseña de `cauce`**, porque estuvo montada en todos los contenedores:
```bash
python3 ops/scripts/provision-db-roles.py --env /etc/cauce-v3/prod.env --rotate-owner
python3 ops/scripts/provision-db-roles.py --env /etc/cauce-v3/prod.env --rotate-owner --apply
```
El script se niega si queda alguna conexión de runtime con `cauce`. Hace estos pasos:
- cambia la contraseña con el mismo camino SCRAM;
- publica la nueva URL del propietario de forma atómica (el migrador usa un contenedor nuevo en cada despliegue);
- reescribe en el sitio `CAUCE_POSTGRES_PASSWORD_PATH`, porque el contenedor de PostgreSQL lo monta por inodo y su healthcheck lo lee;
- prueba la conexión del healthcheck.

Después revisa los consumidores del host que todavía lean la URL del propietario.

**Paso 8. Endurecimiento opcional.** Limitar `cauce` en `pg_hba`. `TEMPORARY` ya no es de `PUBLIC` desde 066.

## 5. Rollback

- **Por servicio.** `cp /etc/cauce-v3/prod.env.pre-roles-<stamp> /etc/cauce-v3/prod.env` (o borra solo la variable de ese servicio), vuelve a obtener el comando (`NEW` del paso 3) y `compose up -d --no-deps --force-recreate --wait <servicio>`. Sin `--force-recreate` el contenedor no cambia de login.
- **Host.** Vuelve a la URL guardada (`database-url.pre-roles-<stamp>`) y reinicia la unidad.
- No cambia ningún dato y los logins quedan inertes.
- Si una guarda o un permiso que falta da un 42501 legítimo, se corrige hacia delante con una migración y se vuelve atrás solo ese servicio mientras tanto.

## 6. Restauración

`backup.sh` vuelca con `--no-owner --no-acl` y `docs/operacion.md` restaura con `--no-acl`. La base restaurada no trae ningún permiso, y `schema_migrations` ya incluye 052, así que el migrador no vuelve a concederlos: cada login del runtime daría 42501. Los roles son del clúster y tampoco van en el volcado. Justo después de `pg_restore`, y antes de levantar ningún servicio:
1. **Mismo clúster** (`dropdb`/`createdb` y `pg_restore`): los grupos y los logins siguen existiendo.
   ```bash
   docker exec cauce-v3-prod-postgres-1 psql -X -U cauce -d cauce -c "SELECT cauce_apply_runtime_grants()"
   ```
2. **Clúster nuevo**: el mismo comando crea además los grupos y concede `cauce_platform` a `cauce`. Hasta entonces, los triggers de guarda fallan porque `cauce_platform` no existe, incluso para `cauce`. Después se crean los logins con contraseñas nuevas, `provision-db-roles.py --env /etc/cauce-v3/prod.env --rotate --apply`, y se recrean sus consumidores (Compose con `--force-recreate`, y los del host como en §4, paso 5).
3. Comprobación: la consulta del paso 1 y `docker logs … | grep -c 42501` en cada servicio.

## 7. Alertas

`deploy/smoke.sh` (flota central) añade la línea `rol de runtime`: `OK` sin conexiones de runtime con `cauce`; `AVISO` antes de la marca `CAUCE_RUNTIME_ROLES_ENFORCED=1`; `ROJO` después. La alerta continua de Prometheus no forma parte de WP-B: necesita una métrica nueva en `outbox-metrics` y una regla en `ops/observability/alerts.yaml`.

## 8. Pruebas

- `pnpm test:runtime-role` (en la matriz de `pnpm test`). Repite con `CAUCE_TEST_RUNTIME_ROLE=1` la prueba de permisos y las suites del gateway, el dispatcher, el bridge, `tests/gateway-hardening` y `tests/integration`.
- `tests/helpers/postgres.ts` abre dos pools: `pool`/`url` usan el login `cauce_test_runtime` (miembro de `cauce_runtime`), y `adminPool`/`adminUrl` usan el superusuario para fixtures, DDL de prueba y `resetTestDatabase`. Sin la variable, ambos son el superusuario. Una prueba que escribe catálogos, tablas de plataforma o DDL debe usar `adminPool`.
- `packages/store/test/runtime-grants-postgres.test.ts`:
  - la clasificación, con `pg_temp` el último en las funciones DEFINER;
  - las negativas como `cauce_gateway`: escrituras de plataforma, `tenants.company_id`, DDL, `DISABLE TRIGGER`, `TRUNCATE`, `DELETE` del historial de flota y de revisiones, `MERGE`, CTE con escritura, vista temporal actualizable y las funciones de permisos;
  - todos los bloqueos de fila y de tabla;
  - la adopción heredada real como runtime;
  - el observador;
  - la restauración sin ACL y `cauce_apply_runtime_grants()`;
  - el `down`: catálogo igual al de 051, sus negativas y que nunca borra un grupo con logins.
- `ops/tests/provision-db-roles.test.mjs`: el script en seco y con `--apply` contra un `docker` simulado. Comprueba que:
  - nunca imprime secretos, publica 0400 de forma atómica y envía verificadores que corresponden a las contraseñas;
  - se detiene ante logins existentes y no publica nada si la transacción falla;
  - si falla una verificación, `prod.env` queda intacto;
  - con `--template` conserva la ruta del consumidor y verifica por la red `backend`;
  - las tablas ad hoc frenan la conmutación, pero no una rotación;
  - si falla la publicación tras la transacción, conserva los ficheros preparados;
  - la guarda del clon resuelve las rutas.
- La matriz no cubre todavía las suites de `packages/store/test` con el login de runtime: `configuration/mutations.ts` escribe catálogos hasta que WP-D lo retire.

## 9. Ensayo en clon

En el clon de §4.7 del diseño, con su propio fichero env y el contenedor desechable:
```bash
python3 ops/scripts/provision-db-roles.py --env /ruta/clon.env --target clon \
  --container <contenedor-del-clon> --secrets-dir /ruta/clon/secrets --apply
```
`--target clon` exige `--container`, `--secrets-dir` y `COMPOSE_PROJECT_NAME` en el env del clon, y rechaza cualquier ruta que, ya resuelta, caiga bajo `/etc/cauce-v3`. Antes, saca de `public` las tablas ad hoc del clon (§3). Después levanta gateway, dispatcher y bridge con sus URL (`--force-recreate`), ejecuta `smoke.sh`, abre en la consola la previsualización de borrado de un agente y la de purga de flota, y comprueba 0 errores 42501 en los logs. Destruye el clon al terminar.
