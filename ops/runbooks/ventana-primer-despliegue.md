# Runbook: Ventana del Primer Despliegue Real (Fase 3)

**Autoridad**: Dueño del sistema presente (`CAUCE_FASE3_CON_DUENO=si`).  
**Duración estimada**: 2 a 3 horas.  
**Objetivo**: Migrar esquema a 037 en una sola transacción, levantar el compose canónico único desde el repositorio y validar los 5 escenarios esenciales de la flota.

---

## 1. Precondiciones y Criterio de Parada Inicial

Antes de tocar producción, el árbol local en `main` debe cumplir:
1. `git status` limpio y sincronizado con `origin/main`.
2. Gate local estricto en verde:
   ```bash
   pnpm typecheck && pnpm lint && pnpm test:unit
   ```
3. Backup automatizado verificado en el host:
   ```bash
   find /var/backups -name "*cauce*" -mmin -1440
   ```

**CRITERIO DE PARADA 0**: Si el gate falla o no hay backup reciente (<24h), **ABORTAR**. No se inicia la ventana.

---

## 2. Paso 1 — Backup Previo Inmediato

Ejecutar un snapshot manual completo y consistente antes de cualquier mutación:
```bash
sudo /usr/local/sbin/cauce-v3-host-backup
```
Verificar que el archivo `.dump` se generó y es legible:
```bash
# el script deja el dump en /opt/_archive/cauce-v3-db-backups (NO en /var/backups); pg_restore no existe en el host
LATEST_BACKUP=$(ls -t /opt/_archive/cauce-v3-db-backups/*.dump | head -n 1)
(cd "$(dirname "$LATEST_BACKUP")" && sha256sum -c "$(basename "$LATEST_BACKUP").sha256")
docker run --rm -v "$(dirname "$LATEST_BACKUP"):/b:ro" "$(docker inspect cauce-v3-prod-postgres-1 --format '{{.Config.Image}}')" \
  pg_restore --list "/b/$(basename "$LATEST_BACKUP")" | grep -c "TABLE DATA"   # debe listar ~60 tablas
echo "Backup verificado: $LATEST_BACKUP"
```

**CRITERIO DE PARADA 1**: Si `pg_restore --list` arroja error de integridad, **ABORTAR**.

---

## 3. Paso 2 — Preparación de Datos: B1 (Sesiones Fantasma)

La migración 034 exige que no existan sesiones de terminal abiertas sin anclar. En la BD de producción existen 3 sesiones huérfanas de julio que deben revocarse.

1. Identificar las sesiones huérfanas:
   ```bash
   docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -c \
     "SELECT id, tenant_id, alias, issued_at FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL;"
   ```
2. Revocar exactamente esas 3 sesiones:
   ```bash
   docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -c \
     "UPDATE terminal_sessions SET revoked_at = now() WHERE closed_at IS NULL AND revoked_at IS NULL;"
   ```
3. Verificar que el resultado sea 0 filas pendientes:
   ```bash
   docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tA -c \
     "SELECT count(*) FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL;"
   ```

**CRITERIO DE PARADA 2**: Si el conteo es distinto de `0`, **ABORTAR** antes de ejecutar migraciones.

---

## 4. Paso 3 — Ajuste de Configuración en `prod.env` (B2 y B3)

1. Respaldar `/etc/cauce-v3/prod.env`:
   ```bash
   sudo cp -a /etc/cauce-v3/prod.env /etc/cauce-v3/prod.env.bak-ventana
   ```
2. Calcular el `CAUCE_TERMINAL_RELAY_INSTANCE_ID`: es el sha256 del DER del certificado que el relay presenta **al gateway** (`CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH`, hoy `/etc/cauce-v3/secrets/terminal-gateway-client.crt`, CN=console-client). El relay lo valida al arrancar (`services/terminal-relay/src/config.ts`): con otro valor **no arranca**. Y ese mismo digest es la identidad mTLS del relay en `mtls_identities.json`.
   ```bash
   CERT=$(sed -n 's/^CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH=//p' /etc/cauce-v3/prod.env)
   test -r "$CERT" || { echo "PARAR: no existe $CERT"; exit 1; }   # sin este guardia, sha256sum de la nada da e3b0c442… y pasa todos los filtros
   ID=$(openssl x509 -in "$CERT" -outform DER | sha256sum | awk '{print $1}'); echo "$ID"
   ```
   *(Valor verificado el 28-08: `749f8af81ce316c6e28c3c7ac200640ea1b918ac12b653193864f5d61f4c520b`; si da otra cosa, PARAR.)*
3. Escribirlo en `prod.env` (`deploy.sh` vuelve a verificar que iguala al DER del cert):
   ```bash
   sed -i '/^CAUCE_TERMINAL_RELAY_INSTANCE_ID=/d' /etc/cauce-v3/prod.env
   printf 'CAUCE_TERMINAL_RELAY_INSTANCE_ID=%s\n' "$ID" >> /etc/cauce-v3/prod.env
   ```
4. Enmascarar durante la ventana los timers que escriben en la BD por el gateway (la 034/037 toman locks exclusivos): `systemctl stop cauce-revividor-de-colas.timer cauce-v3-fleet-watchdog.timer` (son ficheros reales en /etc/systemd/system: `mask` no aplica) — y **`systemctl start` de ambos al cerrar**.
5. Validar renderizado canónico de Docker Compose:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml config > /dev/null
   ```

**CRITERIO DE PARADA 3**: Si `docker compose config` falla al validar variables o secretos, **ABORTAR**.

---

## 5. Paso 4 — Ejecución del Despliegue con `deploy/deploy.sh`

Con la presencia del dueño, exportar la variable requerida y lanzar el despliegue canónico:
```bash
export CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si   # ya como root; cero interactividad
./deploy/deploy.sh
```

Realidades medidas en la pre-flight (28-08): el `up` **recrea los 10 contenedores, postgres incluido** (el volumen `cauce_pgdata` se reutiliza por nombre; compose avisa que no lo creó él: esperado). Las imágenes se construyen con `--target` explícito (runtime y console salen de `deploy/Dockerfile`; la consola hornea el instance id). Con `df -h /` < 60 GB libres, `docker builder prune -f` antes. El árbol `/datos/workspaces/zeus/cauce-v3` pasa a ser **material de producción** (prometheus/otel/postgres montan ficheros de ahí): no rebasear ni cambiar de rama con prod arriba.

El script ejecuta automáticamente:
1. Verificación de `main` y estado git limpio.
2. Build y tag de imágenes `cauce-v3-runtime` y `cauce-v3-console` con pin por digest SHA256 en `prod.env`.
3. Ejecución del contenedor efímero `migrator` aplicando las 10 migraciones (026–028, 030–035, 037) en una sola transacción (~3 segundos).
4. `docker compose up -d --wait --remove-orphans`.
5. Verificación inmediata con `deploy/smoke.sh`.

**CRITERIO DE PARADA 4**: Si `migrator` falla, la transacción revierte automáticamente a 024. Si `up` o `smoke.sh` fallan, proceder al **Plan de Rollback**.

---

## 6. Paso 5 — Validación de Humo y Efectos Reales (`smoke.sh`)

Verificar que las 7 sondas de `deploy/smoke.sh` pasen:
```bash
./deploy/smoke.sh
```
Puntos de comprobación evaluados por `smoke.sh`:
- Gateway `/health/ready` responde OK en puerto interno 8081.
- Los 5 contenedores core están en estado `healthy` (gateway, dispatcher, terminal-relay, telegram-bridge, console).
- Esquema de BD en versión `037_*`.
- Al menos 8 leases de conexión de agentes con latido fresco (<60s).
- Entregas del bus en estado `done` en las últimas 6h.
- Terminal Relay sin bucle de reconexión (<30 conexiones de agentes en 2 min).
- Rutas de gobernanza respondiendo a través del proxy de consola.

---

## 7. Paso 6 — Verificación de los 5 Escenarios Esenciales Post-Deploy

Ejecutar la validación funcional de los 5 escenarios definidos en `docs/flota-y-participantes.md`:

1. **Escenario 1 (Steven → argos por Telegram)**:
   - Enviar mensaje de prueba al bot de Telegram `@argos`.
   - Verificar recepción y ACK en logs:
     ```bash
     docker logs --tail 30 cauce-v3-prod-telegram-bridge-1
     HOME=/home/stev ops/cli/cauce argos estado
     ```
2. **Escenario 2 (Miguel → janus por Telegram)**:
   - Verificar polling activo y recepción en `janus`:
     ```bash
     HOME=/home/stev ops/cli/cauce janus estado
     ```
3. **Escenario 3 (Jhon → hegel por Telegram)**:
   - Verificar que `hegel` procesa entregas y que las 2 entregas atascadas pre-deploy fueron segadas por el nuevo dispatcher.
     ```bash
     HOME=/home/stev ops/cli/cauce hegel estado
     ```
4. **Escenario 4 (Steven → jarvis)**:
   - Verificar si el contenedor `claw` y el adaptador de `jarvis` recuperan conectividad con el nuevo runtime.
5. **Escenario 5 (Operación TUI/CLI)**:
   - Ejecutar inspección de flota y attach limpio:
     ```bash
     HOME=/home/stev ops/cli/cauce
     HOME=/home/stev timeout 5 ops/cli/cauce socrates ver
     ```

---

## 8. Plan de Rollback Exacto

Si se produce un fallo crítico tras el despliegue o la prueba de humo resulta insatisfactoria:

### Caso A: Fallo en migración (antes de levantar servicios nuevos)
- La transacción de PostgreSQL revierte automáticamente.
- La base de datos queda intacta en el esquema 024.
- No se requiere restaurar dump.

### Caso B: Fallo en arranque de servicios nuevos o smoke rojo
El orden importa: **nunca `down`** (pararía postgres antes de restaurar) y la vuelta es con el compose VIEJO de `/opt` + sus 4 overrides (el canónico con imágenes legacy sería un tercer estado jamás probado).
1. Parar todo menos postgres:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml --project-directory deploy \
     stop gateway dispatcher telegram-bridge terminal-relay console outbox-metrics prometheus otel-collector
   ```
2. Restaurar `prod.env` previo: `cp -a /etc/cauce-v3/prod.env.bak-ventana /etc/cauce-v3/prod.env`.
3. Solo si el esquema 037 quedó confirmado y hay que volver a 024 (verificar sha256 antes; terminar backends antes de `dropdb`):
   ```bash
   D=$(ls -t /opt/_archive/cauce-v3-db-backups/*.dump | head -n 1); (cd "$(dirname "$D")" && sha256sum -c "$(basename "$D").sha256")
   docker exec cauce-v3-prod-postgres-1 psql -U cauce -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cauce' AND pid<>pg_backend_pid()"
   docker exec cauce-v3-prod-postgres-1 dropdb -U cauce cauce && docker exec cauce-v3-prod-postgres-1 createdb -U cauce cauce
   docker exec -i cauce-v3-prod-postgres-1 pg_restore -U cauce -d cauce --no-owner --no-acl < "$D"
   ```
4. Levantar la versión previa **con el compose viejo y sus overrides** (los que corrían antes de la ventana):
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f /opt/cauce-v3/deploy/compose.yaml -f /opt/cauce-v3/deploy/compose.postgres.yaml \
     -f /etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml -f /etc/cauce-v3/compose-overrides/store-fanin.yaml \
     -f /etc/cauce-v3/compose-overrides/terminal-minrows.yaml -f /etc/cauce-v3/compose-overrides/directiva-20260825.yaml \
     --project-directory /opt/cauce-v3/deploy up -d --wait --wait-timeout 300
   ```
5. Comprobar: `./deploy/smoke.sh` (la sonda del esquema dirá 024 — esperado en rollback) y `systemctl unmask cauce-revividor-de-colas.timer cauce-v3-fleet-watchdog.timer && systemctl start` de ambos.
