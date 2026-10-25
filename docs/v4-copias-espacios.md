# Backup durable de espacios por consola

## Resultado y alcance

La consola solicita una copia durable de `agent.state_directory/space`, consulta su estado y descarga el ZIP verificado. La fuente y el usuario provienen del agente durable y de la política vigente del host; el navegador no admite rutas. La restauración usa `space_archive.py restore`. Los proyectos se copian sin `.git`; `.env` y las credenciales detectadas se omiten según el manifiesto.

El límite de exportación y ZIP es 1 GiB, con 128 MiB por archivo; las cuotas durables predeterminadas son 4 GiB por empresa y 16 GiB globales. No se ha validado la restauración de una copia productiva ni la migración física de agentes. El censo y el plan están en `docs/v4-migracion-plan.md`.

## Contrato y controles

- UUID durable con empresa, tenant, alias, host, solicitante humano, placement exacto y SHA256 de política. Idempotencia por empresa/tenant/alias y clave; retención serializada de 20 solicitudes activas por empresa y 200 globales.
- Cuota durable serializada mediante advisory lock global: 4 GiB por empresa y 16 GiB globales, configurables con `companyMaxBytes` y `globalMaxBytes`. `pending` y `running` reservan 1 GiB desde la admisión; `begin` vuelve a comprobar capacidad antes de bloquear el recibo. `ready` carga bytes reales. Un `failed` carga sus bytes declarados o recibidos para conservar la reserva de los parciales retenidos. Los recibos expirados no cuentan. Las opciones deben ser enteros seguros, al menos 1 GiB y con límite de empresa menor o igual al global.
- Canal Ed25519 existente del host; token, epoch y lease de 60 segundos, con renovación cada 15 segundos. Cada mutación vuelve a comprobar autoridad humana, empresa, placement y política actual del host. Un reclaim invalida el fence anterior y reinicia metadata.
- POST de consola sujeto a CSRF y Origin. Acceso de dueño/admin de empresa, plataforma en empresa seleccionada o operador del tenant correspondiente. El canal firmado rechaza cookies y payloads adicionales.
- Copias privadas con directorios 0700, archivos 0600 y TTL de 24 horas. Se limpian todas las copias de epochs expirados con nombres cerrados; un reclaim limpia las copias anteriores del UUID después de obtener el nuevo fence. Se preservan archivos ajenos.
- El ZIP y el total exportado del backup durable tienen límite de 1 GiB; cada archivo, 128 MiB; máximo 20 000 entradas y manifiesto de 8 MiB. El CLI standalone `space_archive.py` también aplica `MAX_TOTAL=1 GiB` y `MAX_FILE=128 MiB`, tanto al exportar como al validar/restaurar el contenido. El ZIP durable añade la cota de bytes del helper. Esos chunks son de 64 KiB (`SPACE_BACKUP_CHUNK_BYTES` y `space_backup_validate.CHUNK_BYTES`). El exportador local corta con `signal.alarm(110)` (`ops/cli/space_backup_local.py`). El proceso que lo lanza en el gateway espera por defecto 180 s y como máximo 300 s (`invokeSpaceBackupHelper`). `space_archive.py` lee el árbol local en trozos de 1 MiB (`CHUNK_BYTES`): es otra vía, la de inventario y migración. Los límites producen `LIMIT_EXCEEDED`; el recibo no acredita una copia completa ni omite datos excesivos como si hubiese terminado. El error simulado `ENOSPC` conserva un estado fallido y nunca anuncia un ZIP parcial como `ready`.
- El manifiesto declara cada omisión con motivo cerrado: `sensitive_path` (perfiles, sesiones, credenciales, `.env*`, `.npmrc`, `.pypirc`, `.htpasswd`, cookies de datos como `cookies.txt`, `cookies.sqlite` y sus sidecars `-wal`/`-shm`/`-journal`, o `Cookies-journal`, pero no código como `cookies.ts`), `sensitive_content` (claves privadas, tokens de GitHub/GitLab/Slack/AWS/npm y URLs con usuario y contraseña literales; una plantilla `${...}` o `process.env` no es secreto), `vcs_metadata` (`.git`), `special_file` (enlaces simbólicos, FIFOs y archivos con enlaces duros dentro de los directorios admitidos del espacio: se omiten sin seguir enlaces ni leer su contenido y constan en el manifiesto) y `external_mount` (rutas de `config/external-mounts.json` con `excluded_from_copy`, que escribe el supervisor; las de fuera del espacio, como `/workspace`, constan con su ruta absoluta normalizada y no se copian). Las raíces `logs`/`tmp` quedan fuera. El contenido admitido procede de `context`, `directives`, `projects`, `config` y `data`; esas raíces de primer nivel deben ser directorios reales: si una es un enlace simbólico, la exportación aborta sin conservar una copia parcial.
- Upload por offset con retry exacto de bytes aceptados y truncado al offset durable tras rollback. Finish verifica bytes, SHA256, identidad y manifiesto; permite recuperar un rename seguido de rollback SQL y vuelve a verificar incluso cuando el recibo ya está ready. Download verifica el mismo descriptor de archivo que entrega, sin reabrir la ruta.

Rutas:

```text
POST /v3/console/spaces/:tenant_id/:alias/backups
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id/download
POST /v3/fleet/hosts/:host_id/space-backups
```

El recibo expone `pending|running|ready|failed`, bytes/hashes completos cuando están disponibles, error cerrado y URL de descarga sólo en ready. Una solicitud expirada conserva metadata y devuelve `EXPIRED` sin URL, también en el replay idempotente.

## Evidencia local

Las pruebas, recibos y límites de su alcance están en la [matriz de verificación local](v4-matriz-local.md).

## Orden de despliegue

La razón `external_mount` es nueva y su recibo admite una ruta absoluta (la restauración la ignora). Primero se despliega el gateway con el validador nuevo, que acepta las razones nuevas; después los hosts con el exportador nuevo. Un gateway viejo rechazaría los archivos generados por el exportador nuevo (razón de omisión desconocida).

El manifiesto nuevo usa `schema_version` 2. El validador acepta la versión 1 y la 2, y en ambas vuelve a clasificar el texto literal: una clave AWS de al menos 20 caracteres `[A-Za-z0-9/+]` separada por `=`, `:`, `=>`, `>` o solo espacios; un `_authToken` de al menos 8 caracteres; o una URL cuya contraseña no es toda plantilla. No cuenta como secreto el valor (o la contraseña entera) que empieza por `${` o `process.env`. Una copia de la versión 1 auténtica ya pasó el filtro amplio anterior, así que sigue restaurándose si el manifiesto, las omisiones y los hashes cuadran y no trae uno de esos literales. Una copia de cualquiera de las dos versiones que todavía los lleve se rechaza con `space archive digest or content is invalid`. Un validador que solo acepta la versión 1 rechaza la versión 2 con `space archive identity or schema differs`. Primero se despliega el validador que acepta ambas versiones y aplica esas reglas a las dos; después los hosts que escriben la versión 2. Cada omisión (ruta y motivo, también las de contenido) queda en `space-manifest.json` dentro del ZIP.

La descarga (`/v3/console/spaces/:tenant_id/:alias/backups/:id/download`) tiene su propia ubicación en nginx con `proxy_buffering off`, con las mismas cabeceras y mTLS que `/v3/`, para no pasar hasta 1 GiB por el buffering por defecto.

## Operación y recuperación

El procedimiento para solicitar, verificar, restaurar y ensayar la reversión está en el [runbook de copias de espacios](v4-runbook-copias.md).
