# Backup durable de espacios por consola

## Resultado y alcance

La consola puede solicitar una copia durable de `agent.state_directory/space`, consultar su estado y descargar el ZIP verificado. La fuente y el usuario provienen del agente durable y de la política vigente del host; el navegador no admite rutas. La restauración se ejecuta con la CLI existente `space_archive.py restore`. Los proyectos se copian sin `.git` (declarado como `vcs_metadata`): los commits sin publicar no viajan y el remoto es la fuente de verdad. `.env` y credenciales se omiten. El flujo HTTP firmado descargó y restauró un proyecto sintético de 100 000 bytes. La ampliación exportó, validó y restauró por CLI real un JSONL sintético mayor de 96 MiB, con bytes, SHA256, identidad y manifiesto iguales; no exportó `config/auth.json`, sesiones ni `logs`.

Esto acredita la implementación y los flujos herméticos descritos. El máximo exportado y del ZIP es 1 GiB, con 128 MiB por archivo; las cuotas durables predeterminadas son 4 GiB por empresa y 16 GiB globales. No acredita una copia productiva, una restauración productiva, un snapshot transaccional de un espacio vivo ni ejecución en todos los proveedores y hosts reales. El censo y el plan están en `docs/v4-migracion-plan.md`; las fuentes aún requieren un manifiesto aprobado, bootstrap legítimo y una operación multi-host con fences. No se migró ningún agente.

## Contrato y controles

- UUID durable con empresa, tenant, alias, host, solicitante humano, placement exacto y SHA256 de política. Idempotencia por empresa/tenant/alias y clave; retención serializada de 20 solicitudes activas por empresa y 200 globales.
- Cuota durable serializada mediante advisory lock global: 4 GiB por empresa y 16 GiB globales, configurables con `companyMaxBytes` y `globalMaxBytes`. `pending` y `running` reservan 1 GiB desde la admisión; `begin` vuelve a comprobar capacidad antes de bloquear el recibo. `ready` carga bytes reales. Un `failed` carga sus bytes declarados o recibidos para conservar la reserva de los parciales retenidos. Los recibos expirados no cuentan. Las opciones deben ser enteros seguros, al menos 1 GiB y con límite de empresa menor o igual al global.
- Canal Ed25519 existente del host; token, epoch y lease de 60 segundos, con renovación cada 15 segundos. Cada mutación vuelve a comprobar autoridad humana, empresa, placement y política actual del host. Un reclaim invalida el fence anterior y reinicia metadata.
- POST de consola sujeto a CSRF y Origin. Acceso de dueño/admin de empresa, plataforma en empresa seleccionada o operador del tenant correspondiente. El canal firmado rechaza cookies y payloads adicionales.
- Copias privadas con directorios 0700, archivos 0600 y TTL de 24 horas. Se limpian todas las copias de epochs expirados con nombres cerrados; un reclaim limpia las copias anteriores del UUID después de obtener el nuevo fence. Se preservan archivos ajenos.
- El ZIP y el total exportado del backup durable tienen límite de 1 GiB; cada archivo, 128 MiB; máximo 20 000 entradas y manifiesto de 8 MiB. El CLI standalone `space_archive.py` también aplica `MAX_TOTAL=1 GiB` y `MAX_FILE=128 MiB`, tanto al exportar como al validar/restaurar el contenido. El ZIP durable añade la cota de bytes del helper. Los chunks conservan 64 KiB y el helper tiene deadline de 110 segundos. Los límites producen `LIMIT_EXCEEDED`; el recibo no acredita una copia completa ni omite datos excesivos como si hubiese terminado. El error simulado `ENOSPC` conserva un estado fallido y nunca anuncia un ZIP parcial como `ready`.
- El manifiesto declara cada omisión con motivo cerrado: `sensitive_path` (perfiles, sesiones, credenciales, `.env*`, `.npmrc`, `.pypirc`, `.htpasswd`, cookies de datos como `cookies.txt` pero no código como `cookies.ts`), `sensitive_content` (claves privadas, tokens de GitHub/GitLab/Slack/AWS/npm y URLs con usuario y contraseña), `vcs_metadata` (`.git`) y `external_mount` (rutas de `config/external-mounts.json` con `excluded_from_copy`, que escribe el supervisor). Las raíces `logs`/`tmp` quedan fuera. El contenido admitido procede de `context`, `directives`, `projects`, `config` y `data`.
- Upload por offset con retry exacto de bytes aceptados y truncado al offset durable tras rollback. Finish verifica bytes, SHA256, identidad y manifiesto; permite recuperar un rename seguido de rollback SQL y vuelve a verificar incluso cuando el recibo ya está ready. Download verifica el mismo descriptor de archivo que entrega, sin reabrir la ruta.

Rutas:

```text
POST /v3/console/spaces/:tenant_id/:alias/backups
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id/download
POST /v3/fleet/hosts/:host_id/space-backups
```

El recibo expone `pending|running|ready|failed`, bytes/hashes completos cuando están disponibles, error cerrado y URL de descarga sólo en ready. Una solicitud expirada conserva metadata y devuelve `EXPIRED` sin URL, también en el replay idempotente.

## Evidencia local real

Estos recibos corresponden al checkout de revisión con HEAD `a896a184ed67703f8b9fbae03010b884c46c5be9` y cambios propios todavía sin commit. El typecheck registra tres errores externos de `placement_role` de la construcción multi-host; el integrador conserva ese sector y el resello global final. Los gates focales del backup permiten congelar este sector para su revisión independiente sin acreditar el árbol integrado.

| Validación | Resultado | Recibo local |
|---|---|---|
| PostgreSQL 16 ampliado, rol runtime, firma real, HTTP real, helper Python real y cuotas durables | 15/15 PASS, 23.35 s | `/var/tmp/cauce-v4-space-backup-expanded-postgres.log` |
| Host worker TS | 5/5 PASS | `/var/tmp/cauce-v4-space-backup-host-unit.log` |
| Exportador/restaurador: límites y fallo de disco simulado | 10/10 PASS, 0.017 s | `/var/tmp/cauce-v4-space-archive-expanded.log` |
| Runtime Python ampliado, JSONL mayor de 96 MiB y CLI de restore real | 8/8 PASS, 55.674 s | `/var/tmp/cauce-v4-space-backup-expanded-python.log` |
| Regresión Python ampliada con SDK native/container reales y replay | 10/10 PASS, 7.887 s | `/var/tmp/cauce-v4-space-backup-python-sdk-final.log` |
| ESLint normal y estricto focal de la ampliación | exit 0, salida vacía | `/var/tmp/cauce-v4-space-backup-expanded-lint.log`, `/var/tmp/cauce-v4-space-backup-expanded-strict-fixed.log` |
| Typecheck core del árbol actual | exit 2: tres tipos opcionales de `placement_role` en `repository/fleet-operation-hosts.ts`, sector paralelo | `/var/tmp/cauce-v4-space-backup-expanded-typecheck.log` |
| Ruff de archivos propios ampliados | exit 0 | `/var/tmp/cauce-v4-space-backup-expanded-ruff.log` |
| Calidad del árbol ampliado | VERDE, 2761 archivos, sin modificar baseline | `/var/tmp/cauce-v4-space-backup-expanded-calidad.log` |
| Diffcheck de archivos propios ampliados | exit 0, salida vacía | `/var/tmp/cauce-v4-space-backup-expanded-diffcheck.log` |

PostgreSQL cubre CSRF, Origin, autoridad humana, aislamiento de empresa, revocación del solicitante, replay/fence antiguo, retry de chunks y rollback, cambios de placement/política, límite de fuente real, corrupción de bytes/manifiesto, recuperación de rename, expiración de todos los epochs y retención por empresa. La ampliación cubre admisiones concurrentes, capacidad independiente por empresa dentro del límite global, bytes reales de `ready`, parciales de `failed`, liberación por expiración, comprobación de capacidad en `begin`, un recibo de 96 MiB que sigue `running` y un `ENOSPC` simulado después del primer chunk que queda `failed/EXPORT_FAILED`. El primer caso ejecuta `SignedHostChannel`, exporta, descarga, verifica bytes/hashes y restaura con la CLI real en un directorio privado nuevo. La prueba Python del JSONL restaura el contenido real y compara su hash y manifiesto; no simula una restauración productiva.

Se conserva la primera regresión ampliada de Python: 2 fallos reales de 10 en `/var/tmp/cauce-v4-space-backup-python-sdk.log`. La nueva variable `CAUCE_SPACE_ROOT` no estaba en la allowlist de observación de `/proc` para los procesos SDK. La reparación autorizada añadió ese prefijo en los proofs native/container y la regresión final pasó 10/10. El estricto inicial de la nueva ampliación registró tres interpolaciones numéricas inválidas en `/var/tmp/cauce-v4-space-backup-expanded-strict.log`; se corrigieron con conversiones explícitas y el resello salió con exit 0. Se conservan los typechecks fallidos por trabajo paralelo y el pase anterior `/var/tmp/cauce-v4-space-backup-typecheck-resolved.log`; ese pase anterior no acredita el árbol actual. El resello core actual requiere que el integrador cierre los tres errores de su sector.

## Orden de despliegue

La razón `external_mount` es nueva. Primero se despliega el gateway con el validador nuevo, que acepta las razones nuevas; después los hosts con el exportador nuevo. Un gateway viejo rechazaría los archivos generados por el exportador nuevo (razón de omisión desconocida).

La descarga (`/v3/console/spaces/:tenant_id/:alias/backups/:id/download`) tiene su propia ubicación en nginx con `proxy_buffering off`, con las mismas cabeceras y mTLS que `/v3/`, para no pasar hasta 1 GiB por el buffering por defecto.

## Archivos y empaquetado

Los módulos propios incluyen la migración 060 y down; módulos store y suite PostgreSQL; ruta de consola; contratos, storage, rutas, proceso, host y suite del host en gateway; helpers Python y sus suites. La migración 060 aún no desplegada se amplió con autorización del integrador; no se tocaron las migraciones anteriores. En la implementación inicial se añadieron `CAUCE_SPACE_ROOT` al entorno SDK y a las allowlists de observación en `fleet_executor_runtime.py`/`fleet_executor_container.py`, con autorización puntual. La ampliación de límites y cuotas no añadió cambios en SDK, app, Docker ni empaquetado.

Gateway necesita Python, `space_backup_validate.py` y `space_archive.py`. El executor necesita los tres helpers nuevos, `space_archive.py` y los módulos fleet existentes; el mount readonly completo de `ops/cli` ya cubre native/container/shared según los bindings aprobados. El integrador mantiene la autoría de los exports, `app.ts`, `enrolled-main.ts`, instalación, Docker y despliegue, así como la exposición opcional de los límites de bytes en la configuración. Los defaults funcionan sin esas opciones. Este subagente no hizo commits, push, merge, cambios productivos ni cambios de credenciales. El informe está ignorado por Git y su evidencia pertenece al checkout de revisión, no a un despliegue.

## Revisión independiente de otros sectores

La revisión de flota `forCompany` no encontró un bloqueo confirmado: empresa solicitada y durable, actor/humano vigentes, idempotencia, filtros, provenance y transacción exterior se mantienen. Evidencia del autor: 22/22 PostgreSQL, 79/79 unit y 16/16 executor de cuotas. El patch de shutdown vuelve a comprobar abort tras la lectura inicial/final y el drenaje de renovación; un auth handle sin handoff válido se cierra.

La revisión de plataforma/transfer encontró dos fallos funcionales y el autor los corrigió: el sentinel `host:...` ya no degrada el descriptor native a null; el update físico conserva desde el destino durable su cuenta, modelo y esfuerzo sin exportarlos. Las memberships físicas pasan por el descriptor completo y el coordinador. La lectura completa del CLI confirmó contraseña actual, autoridad durable dentro de la transacción, empresa seleccionada y archivos privados abiertos con NOFOLLOW. Evidencia del autor al liberar el turno: 13/13 PostgreSQL PASS, 16.34 s, incluido source CLI real.

## Correcciones posteriores de revisión

La revisión independiente reprodujo una inversión de locks entre enqueue y begin: el recibo inicial dio enqueue202/begin503; el orden común identity/host antes del advisory de cuotas produjo enqueue202/begin200. La suite PostgreSQL final pasó 16/16 en 14.99 s (`backup-postgres-full-green.log`). También se corrigió el conteo de las cinco raíces del ZIP: backup ya no acredita un archivo que su restaurador rechazaría por exceso de entradas. La prueba falla antes del cambio y la suite de archivo final pasó11/11 (`backup-root-limit-{red,green}.log`), con restore del límite exacto y eliminación del parcial rechazado.

Los entrypoints dinámicos de export/read fueron añadidos al bundle del upgrade; RED por omisión y28/28 Python PASS tras el cambio (`packaging-backup-closure-{red,green}.log`). El gate ops detectó `OPERATIONS.sha256` generado antiguo: se regenerará antes de publicar. Estos resultados no acreditan migración, copia de datos productivos ni ejecución de la release empaquetada final.
