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
LATEST_BACKUP=$(ls -t /var/backups/cauce-v3/*.dump | head -n 1)
pg_restore --list "$LATEST_BACKUP" > /dev/null
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
2. Calcular el `CAUCE_TERMINAL_RELAY_INSTANCE_ID` exacto (SHA256 del DER del certificado leaf del relay):
   ```bash
   openssl x509 -in /etc/cauce-v3/pki/terminal-relay.crt -outform DER | sha256sum | awk '{print $1}'
   ```
   *(Valor de referencia esperado: `749f8af81ce316c6e28c3c7ac200640ea1b918ac12b653193864f5d61f4c520b`)*.
3. Asegurar que `prod.env` contiene la variable:
   ```bash
   sudo sed -i '/^CAUCE_TERMINAL_RELAY_INSTANCE_ID=/d' /etc/cauce-v3/prod.env
   echo "CAUCE_TERMINAL_RELAY_INSTANCE_ID=$(openssl x509 -in /etc/cauce-v3/pki/terminal-relay.crt -outform DER | sha256sum | awk '{print $1}')" | sudo tee -a /etc/cauce-v3/prod.env
   ```
4. Limpiar rutas de PKI y asegurar que los secretos apuntan a ficheros reales, no `/dev/null`.
5. Validar renderizado canónico de Docker Compose:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml config > /dev/null
   ```

**CRITERIO DE PARADA 3**: Si `docker compose config` falla al validar variables o secretos, **ABORTAR**.

---

## 5. Paso 4 — Ejecución del Despliegue con `deploy/deploy.sh`

Con la presencia del dueño, exportar la variable requerida y lanzar el despliegue canónico:
```bash
export CAUCE_FASE3_CON_DUENO=si
sudo -E ./deploy/deploy.sh
```

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
1. Detener contenedores desplegados:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml down
   ```
2. Restaurar `prod.env` previo:
   ```bash
   sudo cp -a /etc/cauce-v3/prod.env.bak-ventana /etc/cauce-v3/prod.env
   ```
3. Si el esquema 037 ya fue confirmado y se requiere revertir la BD al estado exacto previo:
   ```bash
   RESTORE_DUMP=$(ls -t /var/backups/cauce-v3/*.dump | head -n 1)
   docker exec -i cauce-v3-prod-postgres-1 dropdb -U cauce cauce
   docker exec -i cauce-v3-prod-postgres-1 createdb -U cauce cauce
   docker exec -i cauce-v3-prod-postgres-1 pg_restore -U cauce -d cauce --no-owner --no-acl < "$RESTORE_DUMP"
   ```
4. Levantar la versión previa de los servicios:
   ```bash
   docker compose --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml up -d --wait
   ```
5. Comprobar que los contenedores vuelven a estar operativos:
   ```bash
   ./deploy/smoke.sh
   ```
