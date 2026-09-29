# Runbook: Backup y Restore V3

## Cuándo usar
Ejecutar respaldos regulares u off-site de PostgreSQL (y opcionalmente SQLite de servicios auxiliares) y ensayar restores en entornos aislados.

## Pasos
1. Ejecutar respaldo manual con TLS y snapshot consistente:
   ```sh
   # [no ejecutable en verificación]
   export NODE_ENV=production DATABASE_URL_FILE=/run/secrets/database_url
   BACKUP_DIR=/ruta/cifrada ops/scripts/backup.sh
   ```
2. Ejecutar respaldo automatizado en host y sincronización off-host:
   ```sh
   # [no ejecutable en verificación]
   install -m 0755 ops/scripts/host-backup.sh /usr/local/sbin/cauce-v3-host-backup
   install -m 0755 ops/scripts/host-backup-monitor.sh /usr/local/sbin/cauce-v3-host-backup-monitor
   sudo /usr/local/sbin/cauce-v3-host-backup
   ```
   Con blobs habilitados, el backup guarda el dump, `<dump>.blobs.tsv` y
   `<dump>.blobs.tar`; verifica una restauración de base y volumen aislados antes
   de publicar evidencia. Esos tres artefactos son una unidad: conservarlos
   juntos en la copia externa. El tar contiene cada digest físico una vez aunque
   varias filas de tenants o grants lo referencien.
3. Ejecutar ensayo de restauración (drill) en base de datos aislada:
   - Crear base vacía y marcar el entorno:
     ```sql
     -- [no ejecutable en verificación]
     CREATE DATABASE cauce_drill;
     ALTER DATABASE cauce_drill SET cauce.environment = 'restore-drill';
     ```
   - Restaurar con `pg_restore`:
     ```sh
     # [no ejecutable en verificación]
     pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --no-acl /ruta/cauce-backup.dump
     ```

## Verificar efecto
1. Validar integridad del archivo de respaldo sin restaurar:
   ```sh
   # [no ejecutable en verificación]
   pg_restore --list /ruta/cauce-backup.dump > /dev/null
   ```
2. Verificar resumen de la última corrida de respaldo:
   ```sh
   # [no ejecutable en verificación]
   cat /var/log/cauce-v3-backup/status.json
   ```
   Si `CAUCE_BLOB_API_ENABLED=1`, exigir el volumen nombrado exacto y evidencia
   posterior a la tabla de blobs antes de cualquier despliegue:
   ```sh
   # [no ejecutable en verificación]
   REQUIRE_BLOB_VOLUME=1 BLOB_VOLUME=cauce-v3-prod_blobs_data \
     /usr/local/sbin/cauce-v3-host-backup-monitor
   ```
3. Verificar tablas y migraciones aplicadas en la base restaurada.
   Para restaurar bytes, extraer `<dump>.blobs.tar` **en un volumen nuevo**, no
   encima de `blobs_data` en uso; comparar su manifiesto, SHA y tamaño con las
   filas de la base restaurada y probar lectura como UID 1000 antes de conmutar.
   Si la verificación falla, conservar intactos la base y el volumen anteriores.
4. Monitorear salud del servicio y timers:
   ```sh
   # [no ejecutable en verificación]
   systemctl status cauce-v3-host-backup.timer cauce-v3-host-backup-monitor.timer
   ```

## Deshacer
1. Eliminar la base de datos temporal de drill:
   ```sql
   -- [no ejecutable en verificación]
   DROP DATABASE cauce_drill;
   ```
2. Limpiar archivos de dump o artefactos temporales no validados.
