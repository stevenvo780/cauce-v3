# Runbook: Ventana del Primer Despliegue Real

**Autoridad**: dueño del sistema presente (`CAUCE_FASE3_CON_DUENO=si`).
**Objetivo**: aplicar las migraciones pendientes en una sola transacción, levantar el compose
canónico único desde el repositorio y validar el efecto real contra la flota viva.

---

## 1. Precondiciones y Criterio de Parada Inicial

Antes de tocar producción, el árbol local en `main` debe cumplir:
1. `git status` limpio y sincronizado con `origin/main` (`CAUCE_DEPLOY_EXPECTED_GIT_REF`).
2. Gate local estricto en verde:
   ```bash
   pnpm typecheck && pnpm lint && pnpm test:unit
   ```
3. Backup automatizado verificado y reciente en el host.

**CRITERIO DE PARADA 0**: si el gate falla o no hay backup de menos de 24 h, **ABORTAR**. No se
inicia la ventana.

---

## 2. Paso 1 — Backup Previo Inmediato

Ejecutar un snapshot manual completo y consistente antes de cualquier mutación:
```bash
sudo /usr/local/sbin/cauce-v3-host-backup
```
Verificar que el `.dump` se generó y es legible. El script deja el dump en `DB_BACKUP_DIR`
(`/opt/_archive/cauce-v3-db-backups` por defecto) con su `.sha256` al lado. Esa variable sólo existe
dentro del script, no en el shell del operador: los comandos de abajo usan la ruta literal. Y
`pg_restore` puede no existir en el host: se usa el de la propia imagen de PostgreSQL.
```bash
LATEST_BACKUP=$(ls -t /opt/_archive/cauce-v3-db-backups/*.dump | head -n 1)
(cd "$(dirname "$LATEST_BACKUP")" && sha256sum -c "$(basename "$LATEST_BACKUP").sha256")
docker run --rm -v "$(dirname "$LATEST_BACKUP"):/b:ro" \
  "$(docker inspect <contenedor-postgres> --format '{{.Config.Image}}')" \
  pg_restore --list "/b/$(basename "$LATEST_BACKUP")" | grep -c "TABLE DATA"
echo "Backup verificado: $LATEST_BACKUP"
```
El conteo de `TABLE DATA` debe coincidir con las tablas que declara el esquema vigente.

**CRITERIO DE PARADA 1**: si `pg_restore --list` arroja error de integridad, **ABORTAR**.

---

## 3. Paso 2 — Preparación de Datos: sesiones de terminal sin anclar

Las migraciones del plano de terminal exigen que no existan sesiones abiertas sin anclar.

1. Identificar las sesiones huérfanas:
   ```bash
   docker exec -i <contenedor-postgres> psql -U cauce -d cauce -c \
     "SELECT id, tenant_id, alias, issued_at FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL;"
   ```
2. Revocar exactamente esas sesiones:
   ```bash
   docker exec -i <contenedor-postgres> psql -U cauce -d cauce -c \
     "UPDATE terminal_sessions SET revoked_at = now() WHERE closed_at IS NULL AND revoked_at IS NULL;"
   ```
3. Verificar que no quede ninguna pendiente:
   ```bash
   docker exec -i <contenedor-postgres> psql -U cauce -d cauce -tA -c \
     "SELECT count(*) FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL;"
   ```

**CRITERIO DE PARADA 2**: si el conteo es distinto de `0`, **ABORTAR** antes de migrar.

---

## 4. Paso 3 — Ajuste del entorno privado

1. Respaldar el env privado: `sudo cp -a /etc/cauce-v3/prod.env /etc/cauce-v3/prod.env.bak-ventana`.
2. Calcular `CAUCE_TERMINAL_RELAY_INSTANCE_ID`: es el sha256 del DER del certificado que el relay
   presenta **al gateway** (`CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH`). El relay lo valida al arrancar
   (`services/terminal-relay/src/config.ts`: 64 hex minúsculas): con otro valor **no arranca**. Ese
   mismo digest es la identidad mTLS del relay en `mtls_identities.json`.
   ```bash
   CERT=$(sed -n 's/^CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH=//p' /etc/cauce-v3/prod.env)
   test -r "$CERT" || { echo "PARAR: no existe $CERT"; exit 1; }   # sin este guardia, sha256sum de la nada da e3b0c442… y pasa todos los filtros
   ID=$(openssl x509 -in "$CERT" -outform DER | sha256sum | awk '{print $1}'); echo "$ID"
   ```
   Si el valor cambia respecto del que ya está en el env privado sin que se haya rotado el
   certificado, **PARAR**.
3. Escribirlo en el env privado (`deploy.sh` vuelve a verificar que iguala al DER del cert):
   ```bash
   sed -i '/^CAUCE_TERMINAL_RELAY_INSTANCE_ID=/d' /etc/cauce-v3/prod.env
   printf 'CAUCE_TERMINAL_RELAY_INSTANCE_ID=%s\n' "$ID" >> /etc/cauce-v3/prod.env
   ```
4. Parar durante la ventana los timers que escriben en la BD por el gateway —watchdog, reconciler y
   cualquier revividor de colas instalado— porque las migraciones toman locks exclusivos. Si son
   ficheros reales en `/etc/systemd/system`, `mask` no aplica: `systemctl stop`. **Arrancarlos otra
   vez al cerrar la ventana.**
5. Validar el renderizado canónico de Compose:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml config > /dev/null
   ```

**CRITERIO DE PARADA 3**: si `docker compose config` falla al validar variables o secretos, **ABORTAR**.

---

## 5. Paso 4 — Despliegue con `deploy/deploy.sh`

Con el dueño presente, exportar las variables requeridas y lanzar el despliegue canónico:
```bash
export CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si   # ya como root; cero interactividad
./deploy/deploy.sh
```

Qué hay que tener en cuenta antes del `up`: **recrea todos los contenedores del compose, postgres
incluido** (el volumen de datos se reutiliza por nombre; compose avisa que no lo creó él, es
esperado). Las imágenes se construyen con `--target` explícito (runtime y console salen de
`deploy/Dockerfile`; la consola hornea el instance id). Con poco espacio libre en `/`, correr
`docker builder prune -f` antes. **El árbol del checkout pasa a ser material de producción**
(prometheus/otel/postgres montan ficheros desde ahí): no rebasear ni cambiar de rama con producción
arriba.

El script ejecuta automáticamente:
1. Verificación de `main` y estado git limpio.
2. Build y tag de las imágenes `cauce-v3-runtime` y `cauce-v3-console`, con pin por digest en el env
   privado.
3. Contenedor efímero `migrator`: todas las migraciones pendientes en una sola transacción.
4. `docker compose up -d --wait --remove-orphans`.
5. Verificación inmediata con `deploy/smoke.sh`.

**CRITERIO DE PARADA 4**: si `migrator` falla, la transacción revierte al esquema previo por sí sola.
Si `up` o `smoke.sh` fallan, ir al **Plan de Rollback**.

---

## 6. Paso 5 — Validación de humo (`deploy/smoke.sh`)

```bash
./deploy/smoke.sh
```
Qué evalúa, con sus umbrales por variable de entorno:
- gateway `/health/ready` por el probe interno (puerto 8081);
- un contenedor activo y `healthy` por cada servicio del compose;
- versión de esquema **igual a la que declara el repo**;
- flota: agentes habilitados con arriendo vigente y fresco frente a `EXPECTED_AGENTS`;
- el agente de gobierno declarado (`GOVERNANCE_TENANT`/`GOVERNANCE_ALIAS`) existe y está habilitado;
- bus: entregas `done` con ACK aplicado o ejecuciones vivas con arriendo, frente a `MIN_ACTIVITY`;
- relay sin bucle de reconexión, frente a `RELAY_MAX_CONNECTIONS` (o perfil `terminal` inactivo);
- la ruta de documentos de gobierno responde exigiendo autenticación (401/403) a través del proxy de
  consola.

El propio script deja una comprobación **manual** al final: editar un fichero de gobierno desde la
consola y verificarlo dentro del contenedor objetivo.

---

## 7. Paso 6 — Verificación funcional post-deploy

Por cada alias que la instalación declare, y como mínimo por cada arnés distinto en uso:

1. **Entrada por Telegram**: enviar un mensaje al bot del alias y verificar recepción y ACK:
   ```bash
   docker logs --tail 30 <contenedor-telegram-bridge>
   ops/cli/cauce <alias> estado
   ```
2. **Entrega por el bus**: `ops/cli/cauce probar <alias>` — criterio de éxito: entrega `done` con ACK
   durable en PostgreSQL.
3. **Entregas atascadas antes del despliegue**: comprobar que el dispatcher nuevo las segó (no
   quedan `inflight` vencidos).
4. **Operación TUI/CLI**: inspección de flota y attach limpio:
   ```bash
   ops/cli/cauce
   timeout 5 ops/cli/cauce <alias> ver
   ```

De dónde sale la lista de alias y su colocación: `ops/flota.json` y la sección «La flota como datos»
de `../../docs/arquitectura.md`.

---

## 8. Plan de Rollback

### Caso A: fallo en la migración (antes de levantar servicios nuevos)
- La transacción de PostgreSQL revierte automáticamente.
- La base queda intacta en el esquema previo.
- No se requiere restaurar dump.

### Caso B: fallo al arrancar los servicios nuevos o smoke rojo
El orden importa: **nunca `down`** (pararía postgres antes de restaurar), y la vuelta es con el
compose de la versión anterior más sus overrides tal como corrían antes de la ventana —el compose
canónico con imágenes viejas sería un tercer estado jamás probado—.

1. Parar todo menos postgres:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml --project-directory deploy \
     stop gateway dispatcher telegram-bridge terminal-relay console outbox-metrics prometheus otel-collector
   ```
2. Restaurar el env privado previo: `cp -a /etc/cauce-v3/prod.env.bak-ventana /etc/cauce-v3/prod.env`.
3. Sólo si el esquema nuevo quedó confirmado y hay que volver al anterior (verificar el sha256 del
   dump antes; terminar backends antes de `dropdb`):
   ```bash
   D=$(ls -t /opt/_archive/cauce-v3-db-backups/*.dump | head -n 1); (cd "$(dirname "$D")" && sha256sum -c "$(basename "$D").sha256")
   docker exec <contenedor-postgres> psql -U cauce -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cauce' AND pid<>pg_backend_pid()"
   docker exec <contenedor-postgres> dropdb -U cauce cauce && docker exec <contenedor-postgres> createdb -U cauce cauce
   docker exec -i <contenedor-postgres> pg_restore -U cauce -d cauce --no-owner --no-acl < "$D"
   ```
4. Levantar la versión previa **con su compose y sus overrides** (los que corrían antes de la
   ventana, desde la ruta de release anterior y el directorio de overrides del host):
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env \
     -f <release-anterior>/deploy/compose.yaml -f <release-anterior>/deploy/compose.postgres.yaml \
     -f <dir-overrides>/<override>.yaml ... \
     --project-directory <release-anterior>/deploy up -d --wait --wait-timeout 300
   ```
5. Comprobar: `./deploy/smoke.sh` (la sonda de esquema señalará la versión anterior — esperado en
   rollback) y volver a arrancar los timers parados en el paso 4 de la §4 (watchdog, reconciler y
   revividores de colas).
