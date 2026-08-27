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
   sudo /usr/local/sbin/cauce-v3-host-backup
   ```
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
3. Verificar tablas y migraciones aplicadas en la base restaurada.
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
