# Runbook: backup y restore V3

## Backup

`backup.sh` acepta `DATABASE_URL` o preferentemente `DATABASE_URL_FILE`, exige TLS en producción, usa snapshot `serializable-deferrable`, formato custom, `umask 077`, validación `pg_restore --list`, rename atómico y SHA256.

```sh
export NODE_ENV=production
export DATABASE_URL_FILE=/run/secrets/database_url
BACKUP_DIR=/ruta/cifrada ops/scripts/backup.sh
```

La URL debe usar `sslmode=verify-full` y CA. Copiar dump+SHA a almacenamiento cifrado, inmutable y off-site; la rotación local no reemplaza retención externa. Nunca apuntar a DB V2.

## Restore drill

Siempre a DB V3 vacía/aislada y con checksum:

```sh
export NODE_ENV=production DATABASE_URL_FILE=/run/secrets/restore_database_url
export RESTORE_EXPECT_DB=cauce_drill RESTORE_CONFIRM=restore:cauce_drill
export ALLOW_REMOTE_RESTORE=yes
ops/scripts/restore.sh /ruta/cauce-YYYYmmddTHHMMSSZ.dump
```

El script verifica DB destino, TLS, host remoto autorizado, contenido y SHA antes de `--clean --single-transaction`. `RESTORE_ALLOW_UNSIGNED=yes` solo existe para legado documentado y bloquea evidencia de release.

Después: migrations, integridad/conteos, `stack-health.sh prod`, E2E real y alias gates sin iniciar consumers. Registrar inicio/fin, tamaño, edad del backup (RPO) y restore+health (RTO). Ensayo trimestral mínimo; un dump no restaurado no es evidencia.
