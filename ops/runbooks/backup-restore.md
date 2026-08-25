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

## Respaldo automático de host (agora-storage) — 2026-07-25

Hasta 2026-07-25 no existía ningún respaldo automático de la base de producción
ni del SQLite de `ut-nexus` (Ultimate Terminal): ambos vivían solo en el disco
de `agora-storage`, junto con el propio respaldo manual si alguien lo tomaba.
Esta sección documenta la automatización que lo reemplaza. Es un mecanismo
**distinto** del `backup.sh`/`restore.sh` de arriba (esos asumen `DATABASE_URL`
sobre red, pensados para CI/release); este corre directo en el host de DB
usando `docker exec`, porque `agora-storage` no tiene cliente `psql`/`pg_dump`
ni la contraseña de la DB, y no la necesita (auth peer/trust del socket local
del contenedor).

### Qué cubre

| Origen | Método | Script |
|---|---|---|
| Postgres `cauce-v3-prod-postgres-1` | `docker exec pg_dump --format=custom`, verificado con `docker exec pg_restore --list` (no solo "el archivo existe": se comprueba que el dump se puede listar) | `ops/scripts/host-backup.sh` |
| SQLite `ut-nexus` (opcional, modo WAL) | Sólo cuando `UT_NEXUS_ENABLED=1`: API online de SQLite (`Connection.backup()`), origen abierto `mode=ro`; verifica `integrity_check`, tablas, conteos, esquema y FKs entre origen y copia antes de darla por buena | `ops/scripts/ut-nexus-backup.py` (ver su docstring: por qué un `cp` de `nexus.db` solo da una copia atrasada) |
| Ambos, fuera de `agora-storage` | `rsync --ignore-existing` append-only y verificación posterior `--checksum --dry-run`, sobre una clave SSH dedicada y restringida | mismo `host-backup.sh`, paso 3 |

`ops/scripts/host-backup.sh` siempre exige dump de Cauce y copia off-host. `ut-nexus`
es otro producto y queda deshabilitado por defecto; un host que también lo ejecute
debe declarar `UT_NEXUS_ENABLED=1` en `/etc/cauce-v3/host-backup.env`. Cuando está
habilitado, cada paso es independiente (uno que falle no cancela los otros) pero
el proceso completo sale con código ≠0 si **cualquiera** falló.

### Dónde vive el respaldo — y por qué no es solo un disco

- Local: `/opt/_archive/cauce-v3-db-backups/` (dump + `.sha256`, retención 14
  días) y `/opt/_archive/ultimate-terminal/<fecha>/` (sqlite + `SHA256SUMS` +
  `manifest-*.json`, retención 30 días).
- **Fuera de host**: espejo en `nass-stev` (`100.64.0.4`, NAS del operador en
  el tailnet — ya usado en producción como destino de respaldo real de
  `prizma-crm`, con éxito verificado noche a noche). El espejo usa una clave
  dedicada **propia de este respaldo** (no la de `prizma-crm`, para no
  compartir blast radius entre servicios), generada en `agora-storage` y
  autorizada en `nass-stev` con `command="rrsync -wo <dir>/",restrict,from="100.64.0.6"`:
  solo puede escribir rsync, solo dentro de su propio subdirectorio
  (`/mnt/pool/backups/cauce-v3/{db,ut-nexus}/`), y solo si la conexión viene
  de la IP de `agora-storage`. El remoto nunca borra ni sobrescribe generaciones: después de copiar,
  una corrida seca con checksum debe quedar vacía. La retención es exclusivamente local y sólo se
  ejecuta tras ese gate; una política corrupta no puede propagarse al respaldo remoto.
- Si `agora-storage` se pierde entero, el dump de Postgres y el sqlite de
  `ut-nexus` siguen existiendo en `nass-stev`.

### Programación y falla ruidosa

```
systemctl status cauce-v3-host-backup.timer cauce-v3-host-backup-monitor.timer
journalctl -u cauce-v3-host-backup.service -n 50
cat /var/log/cauce-v3-backup/status.json   # resumen máquina-legible de la última corrida
```

- `cauce-v3-host-backup.timer` → 03:10 UTC todas las noches.
- `cauce-v3-host-backup-monitor.timer` → cada 6h, corre
  `host-backup-monitor.sh`: relee `status.json` y falla si la última corrida
  no fue `overall=ok` o si tiene más de 30h (para atrapar un timer muerto o
  enmascarado, no solo una corrida que falló activamente).
- Ambos servicios declaran `OnFailure=cauce-v3-backup-alert@%n.service`, que
  escribe un `logger -p daemon.crit` (syslog/journal) identificando la unidad
  que falló. Esto es deliberadamente el mecanismo más simple posible (sin
  red, sin dependencias) para que no pueda fallar por la misma razón que hizo
  fallar el respaldo. **No** se conecta a la API de mensajería de
  agentes (`POST /v3/messages`) porque publicar a un alias (p.ej. `kant`)
  dispara a ese agente IA a procesar el mensaje como una tarea — no es un
  canal pasivo de notificación al humano, y usarlo así sería un efecto
  colateral fuera del alcance de un respaldo. Cablear una alerta empujada de
  verdad (Telegram/email/pager) a un canal pasivo es una decisión pendiente
  de Steven, no tomada acá.

### Instalar / actualizar en agora-storage

El script fuente vive en este repo pero se despliega como copia standalone en
`/usr/local/sbin/`, deliberadamente **fuera** del árbol de release de la app
(`/opt/cauce-v3`, que se reemplaza en cada deploy/cutover): el respaldo tiene
que seguir funcionando aunque un deploy falle o se haga rollback.

```sh
scp ops/scripts/host-backup.sh agora-storage:/usr/local/sbin/cauce-v3-host-backup
scp ops/scripts/host-backup-monitor.sh agora-storage:/usr/local/sbin/cauce-v3-host-backup-monitor
scp ops/scripts/ut-nexus-backup.py ops/scripts/ut-nexus-backup-verify.py agora-storage:/opt/_archive/ultimate-terminal/
ssh agora-storage 'chmod 755 /usr/local/sbin/cauce-v3-host-backup /usr/local/sbin/cauce-v3-host-backup-monitor'
scp ops/systemd/cauce-v3-host-backup.service ops/systemd/cauce-v3-host-backup.timer \
    ops/systemd/cauce-v3-host-backup-monitor.service ops/systemd/cauce-v3-host-backup-monitor.timer \
    ops/systemd/cauce-v3-backup-alert@.service \
    agora-storage:/etc/systemd/system/
ssh agora-storage 'systemctl daemon-reload && systemctl enable --now cauce-v3-host-backup.timer cauce-v3-host-backup-monitor.timer'
```

En un host dedicado únicamente a Cauce, el fichero privado puede contener:

```sh
UT_NEXUS_ENABLED=0
```

No se debe usar la ausencia accidental del script de `ut-nexus` como mecanismo de
configuración: `UT_NEXUS_ENABLED=1` hace que esa ausencia falle ruidosamente.

Antes de un release o incidente se ejecuta una generación sin retención:

```sh
sudo env CAUCE_BACKUP_SKIP_RETENTION=1 /usr/local/sbin/cauce-v3-host-backup
sudo env REQUIRE_RETENTION_PRESERVED=1 \
  /usr/local/sbin/cauce-v3-host-backup-monitor
```

La generación produce y conserva local/off-site tres artefactos timestamped: el dump, su
`.sha256` y `.dump.restore.json`. Este último demuestra restore completo en un PostgreSQL temporal
con `--network none`, imagen por digest y conteos mínimos. Durante el release no se usa un valor
grande de retención como aproximación: el estado debe declarar explícitamente
`preserved-for-release`.

### Restore

Postgres: mismo `ops/scripts/restore.sh` documentado arriba, apuntado al
`.dump` bajo `/opt/_archive/cauce-v3-db-backups/` (o su copia en `nass-stev`);
el `.sha256` sidecar ya viaja con él. ut-nexus: procedimiento completo en
`/opt/_archive/ultimate-terminal/RESTORE.md` en `agora-storage` (dos métodos:
host directo y vía Docker; ambos con verificación de integridad antes de
reemplazar el volumen en uso).
