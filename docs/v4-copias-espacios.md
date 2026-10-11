# Backup durable de espacios por consola

## Resultado y alcance

La consola puede solicitar una copia durable de `agent.state_directory/space`, consultar su estado y descargar el ZIP verificado. La fuente y el usuario provienen del agente durable y de la política vigente del host; el navegador no admite rutas. La restauración se ejecuta con la CLI existente `space_archive.py restore`. La prueba final descargó y restauró un proyecto sintético de 100 000 bytes, conservó su identidad y no exportó `config/auth.json` ni `logs`.

Esto acredita la implementación y el flujo hermético. No acredita una copia completa de espacios productivos de varios GiB, una restauración productiva ni ejecución en todos los proveedores y hosts reales. El límite actual de 32 MiB representa un impedimento explícito para esas fuentes; la aceptación productiva requiere el censo y la decisión de alcance del integrador.

## Contrato y controles

- UUID durable con empresa, tenant, alias, host, solicitante humano, placement exacto y SHA256 de política. Idempotencia por empresa/tenant/alias y clave; retención serializada de 20 solicitudes activas por empresa y 200 globales.
- Canal Ed25519 existente del host; token, epoch y lease de 60 segundos, con renovación cada 15 segundos. Cada mutación vuelve a comprobar autoridad humana, empresa, placement y política actual del host. Un reclaim invalida el fence anterior y reinicia metadata.
- POST de consola sujeto a CSRF y Origin. Acceso de dueño/admin de empresa, plataforma en empresa seleccionada o operador del tenant correspondiente. El canal firmado rechaza cookies y payloads adicionales.
- Copias privadas con directorios 0700, archivos 0600 y TTL de 24 horas. Se limpian todas las copias de epochs expirados con nombres cerrados; se preservan archivos ajenos.
- El ZIP y el total exportado tienen límite de 32 MiB; cada archivo, 16 MiB; máximo 20 000 entradas y manifiesto de 8 MiB. Los chunks tienen 64 KiB y el helper tiene deadline de 110 segundos. Los límites producen `LIMIT_EXCEEDED`; el recibo no acredita una copia completa ni omite datos excesivos como si hubiese terminado.
- El manifiesto conserva las omisiones de privacidad del exportador existente: perfiles, sesiones, credenciales, archivos sensibles y raíces `logs`/`tmp` quedan fuera. El contenido admitido procede de `context`, `directives`, `projects`, `config` y `data`.
- Upload por offset con retry exacto de bytes aceptados y truncado al offset durable tras rollback. Finish verifica bytes, SHA256, identidad y manifiesto; permite recuperar un rename seguido de rollback SQL y vuelve a verificar incluso cuando el recibo ya está ready. Download verifica el mismo descriptor de archivo que entrega, sin reabrir la ruta.

Rutas:

```text
POST /v3/console/spaces/:tenant_id/:alias/backups
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id/download
POST /v3/fleet/hosts/:host_id/space-backups
```

El recibo expone `pending|running|ready|failed`, bytes/hashes completos cuando están disponibles, error cerrado y URL de descarga sólo en ready. Una solicitud expirada conserva metadata y devuelve `EXPIRED` sin URL, también en el replay idempotente.

## Evidencia real

| Validación | Resultado | Recibo local |
|---|---|---|
| PostgreSQL 16 hermético, rol runtime, firma real, HTTP real y helper Python real | 11/11 PASS, 13.19 s | `/var/tmp/cauce-v4-space-backup-postgres-final.log` |
| Host worker TS | 5/5 PASS | `/var/tmp/cauce-v4-space-backup-host-unit.log` |
| Helpers Python de backup | 7/7 PASS | `/var/tmp/cauce-v4-space-backup-python.log` |
| Regresión Python ampliada con SDK native/container reales y replay | 10/10 PASS, 7.887 s | `/var/tmp/cauce-v4-space-backup-python-sdk-final.log` |
| ESLint normal y estricto focal | exit 0, salida vacía | `/var/tmp/cauce-v4-space-backup-lint-final.log`, `/var/tmp/cauce-v4-space-backup-strict-final.log` |
| Typecheck core tras resolver el tipo de env en el sector paralelo | exit 0, salida vacía | `/var/tmp/cauce-v4-space-backup-typecheck-resolved.log` |
| Ruff de archivos propios | exit 0 | `/var/tmp/cauce-v4-space-backup-ruff-final.log` |
| Calidad del árbol | VERDE, sin modificar baseline | `/var/tmp/cauce-v4-space-backup-calidad.log` |

PostgreSQL cubre CSRF, Origin, autoridad humana, aislamiento de empresa, revocación del solicitante, replay/fence antiguo, retry de chunks y rollback, cambios de placement/política, límite de fuente real, corrupción de bytes/manifiesto, recuperación de rename, expiración de todos los epochs y retención por empresa. El primer caso ejecuta `SignedHostChannel`, exporta, descarga, verifica bytes/hashes y restaura con la CLI real en un directorio privado nuevo.

Se conserva la primera regresión ampliada de Python: 2 fallos reales de 10 en `/var/tmp/cauce-v4-space-backup-python-sdk.log`. La nueva variable `CAUCE_SPACE_ROOT` no estaba en la allowlist de observación de `/proc` para los procesos SDK. La reparación autorizada añadió ese prefijo en los proofs native/container y la regresión final pasó 10/10. También se preservan el lint inicial y los typechecks fallidos por trabajo paralelo en plataforma/transfer; el resello core posterior pasó con exit 0. `git diff --check` de los dos archivos modificados existentes salió con exit 0.

## Archivos y empaquetado

Hay 18 archivos nuevos propios: migración 060 y down; cuatro módulos store; suite PostgreSQL; ruta de consola; contratos, storage, rutas, proceso, host y suite del host en gateway; tres helpers Python y su suite. Se añadieron además `CAUCE_SPACE_ROOT` al entorno SDK y a las allowlists de observación en `fleet_executor_runtime.py`/`fleet_executor_container.py`, con autorización puntual del integrador.

Gateway necesita Python, `space_backup_validate.py` y `space_archive.py`. El executor necesita los tres helpers nuevos, `space_archive.py` y los módulos fleet existentes; el mount readonly completo de `ops/cli` ya cubre native/container/shared según los bindings aprobados. El integrador mantiene la autoría de los exports, `app.ts`, `enrolled-main.ts`, instalación, Docker y despliegue. Este subagente no hizo commits, push, merge, cambios productivos ni cambios de credenciales.

## Revisión independiente de otros sectores

La revisión de flota `forCompany` no encontró un bloqueo confirmado: empresa solicitada y durable, actor/humano vigentes, idempotencia, filtros, provenance y transacción exterior se mantienen. Evidencia del autor: 22/22 PostgreSQL, 79/79 unit y 16/16 executor de cuotas. El patch de shutdown vuelve a comprobar abort tras la lectura inicial/final y el drenaje de renovación; un auth handle sin handoff válido se cierra.

La revisión de plataforma/transfer encontró dos fallos funcionales y el autor los corrigió: el sentinel `host:...` ya no degrada el descriptor native a null; el update físico conserva desde el destino durable su cuenta, modelo y esfuerzo sin exportarlos. Las memberships físicas pasan por el descriptor completo y el coordinador. La lectura completa del CLI confirmó contraseña actual, autoridad durable dentro de la transacción, empresa seleccionada y archivos privados abiertos con NOFOLLOW. Evidencia del autor al liberar el turno: 13/13 PostgreSQL PASS, 16.34 s, incluido source CLI real.
