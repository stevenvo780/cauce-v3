# Runbook de copias y recuperación de espacios

## Alcance y límites

Este procedimiento cubre el contenido persistente del espacio de un agente. La copia durable se solicita desde la consola en **Perfil y contexto del agente → Backup del espacio**. `space_backup_runtime.py` y `space_backup_local.py` son workers del host; no se invocan a mano. Para ensayos locales se usa `space_archive.py` y su validador.

La copia incluye las raíces permitidas `context`, `directives`, `projects`, `config` y `data`. No sustituye el backup de PostgreSQL ni conserva autenticación, credenciales, `.git`, `logs`, `tmp` ni mounts externos. El manifiesto registra las omisiones; una exclusión `external_mount` puede incluir una ruta absoluta. Trata el ZIP y su recibo como datos operativos privados y no los subas a GitHub. Los cambios de proyecto que solo existan en `.git` deben publicarse o guardarse por separado antes de migrar.

La restauración del CLI valida la identidad completa (`company_id`, `tenant_id`, `alias`, `runtime_key`) y exige una ruta de destino nueva o vacía. «Espacio nuevo» en este procedimiento significa un directorio de prueba nuevo para la misma identidad. No se admite reasignar la copia a otro tenant o alias: no edites el manifiesto para forzarla. Crear el registro Cauce, el runtime, las credenciales o el enrutamiento del nuevo agente es una operación distinta.

## Crear y comprobar una copia durable

1. Abre **Perfil y contexto** del agente correcto y localiza **Backup del espacio**. Comprueba que la empresa, el tenant y el alias visibles son los esperados y que tienes autoridad vigente.
2. Pulsa **Crear backup del espacio**. Espera a que el estado sea `ready`; `pending` y `running` no son descargables. Si el estado es `failed`, corrige la causa indicada y solicita una copia nueva.
3. Descarga el ZIP mientras siga vigente. Las copias retenidas vencen a las 24 horas. Conserva juntos el recibo durable y el archivo descargado. La vista muestra el estado, tamaño y SHA-256 del ZIP; el recibo durable incluye también el SHA-256 del manifiesto. En navegadores con selector de archivo (Chromium), **Descargar backup ZIP** pide dónde guardarlo, lee la descarga por stream, calcula el SHA-256 y sólo conserva el archivo si tamaño y hash coinciden con el recibo; entonces muestra el SHA-256 calculado y un comando `cauce spaces restore` en el que debes completar el destino y `identity.runtime_key` de `space-manifest.json`. En el resto de navegadores la descarga es un enlace directo y la comparación del paso 4 es manual.
4. Asigna la ruta local del ZIP a `ARCHIVE` y compara el resultado con el SHA-256 mostrado por la consola:

   ```sh
   sha256sum "$ARCHIVE"
   ```

   El valor debe coincidir exactamente. Si no coincide, no restaures el archivo: vuelve a descargarlo y repite la comparación.

5. Abre `space-manifest.json` con un visor ZIP local. Confirma que cada omisión (`sensitive_path`, `sensitive_content`, `vcs_metadata`, `external_mount` o `special_file`) es conocida y aceptable para el corte. Si el espacio depende de un mount o de archivos omitidos, prepara y verifica su recuperación por separado.

El manifiesto conserva los nombres de las rutas omitidas: una búsqueda `grep -a` de `.env` en el ZIP puede encontrarlos aunque esos archivos no estén incluidos. Comprueba las entradas reales con `unzip -Z1 "$ARCHIVE"` y busca los valores de credenciales sintéticas del ensayo, tanto en el ZIP como en los archivos restaurados. No copies credenciales reales a comandos ni a informes. Compara cada archivo restaurado con su SHA-256 en `files` del manifiesto y con el origen; el SHA-256 del ZIP por sí solo no acredita esa igualdad.

Una restauración de prueba verifica de nuevo la identidad, el esquema, los hashes de contenido, los límites y las rutas del ZIP antes de escribir. El resultado debe ser `state: restored`; no uses solo el SHA del archivo como prueba de que el contenido se puede restaurar.

## Ensayo local aislado del CLI

Este ejemplo crea datos sintéticos bajo `mktemp`, hace una copia, ejecuta el validador y restaura a un directorio nuevo. La identidad `demo-*` es ficticia. El `trap` elimina únicamente el directorio temporal creado por este bloque.

```bash
set -euo pipefail
umask 077
WORK=$(mktemp -d)
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$WORK"' EXIT
printf 'scratch=%s\n' "$WORK"
COMPANY_ID=demo-company
TENANT_ID=demo-tenant
ALIAS=demo-agent
RUNTIME_KEY=demo-runtime
mkdir -m 700 "$WORK/source"
mkdir -m 700 "$WORK/source/context" "$WORK/source/config" "$WORK/source/projects" "$WORK/source/projects/.git"
printf '{"company_id":"%s","tenant_id":"%s","alias":"%s"}\n' "$COMPANY_ID" "$TENANT_ID" "$ALIAS" > "$WORK/source/config/context-state.json"
printf 'sample context for recovery rehearsal\n' > "$WORK/source/context/readme.md"
printf 'synthetic config\n' > "$WORK/source/config/settings.txt"
printf 'placeholder only\n' > "$WORK/source/config/.env"
BACKUP_JSON=$(python3 ops/cli/space_archive.py backup --directory "$WORK/source" --archive "$WORK/space.zip" --company-id "$COMPANY_ID" --tenant-id "$TENANT_ID" --alias "$ALIAS" --runtime-key "$RUNTIME_KEY")
printf '%s\n' "$BACKUP_JSON"
ARCHIVE="$WORK/space.zip"
MANIFEST_SHA=$(printf '%s' "$BACKUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest_sha256"])')
sha256sum "$ARCHIVE"
printf '{"archive":"%s","identity":{"company_id":"%s","tenant_id":"%s","alias":"%s","runtime_key":"%s"},"manifest_sha256":"%s"}\n' "$ARCHIVE" "$COMPANY_ID" "$TENANT_ID" "$ALIAS" "$RUNTIME_KEY" "$MANIFEST_SHA" | python3 ops/cli/space_backup_validate.py
python3 ops/cli/space_archive.py restore --archive "$ARCHIVE" --directory "$WORK/restored" --company-id "$COMPANY_ID" --tenant-id "$TENANT_ID" --alias "$ALIAS" --runtime-key "$RUNTIME_KEY"
cmp "$WORK/source/context/readme.md" "$WORK/restored/context/readme.md"
```

La salida del backup debe mostrar `state: backed_up`; el validador, `{"verified": true}`; y la restauración, `state: restored` más el manifiesto y las omisiones. `cmp` debe terminar con código 0. El ejemplo comprueba el helper local con un ZIP sintético; no crea ni verifica una copia de consola ni accede a un agente real. `space_backup_validate.py` recibe el JSON por stdin y no es una interfaz de operación de la consola.

El CLI `cauce spaces create|list|edit|retire` gestiona registros y operaciones de flota. El wrapper `cauce spaces backup|restore` despacha a `space_archive.py`; los workers `space_backup_*.py` son internos del ejecutor del host. No envíes solicitudes manuales a los endpoints de flota ni invoques directamente los workers.

## Restaurar una copia en un destino nuevo

1. Conserva el origen y el ZIP sin cambios. Prepara un destino aislado, nuevo y vacío; no restaures encima del espacio activo.
2. Usa la identidad exacta del agente origen. Ejecuta `space_archive.py restore` con `--archive` apuntando al ZIP, `--directory` al destino nuevo y los cuatro campos de identidad. El ejemplo anterior ensaya esta operación en una carpeta nueva.
3. Comprueba que el recibo `space-restore-receipt.json` dice `restored` y que sus `identity`, `files`, `bytes`, `omissions` y `manifest_sha256` concuerdan con el backup. Compara los archivos de datos relevantes con los del origen o con los hashes del manifiesto.
4. Comprueba la aplicación en el entorno aislado antes de cualquier corte. La copia no instala credenciales ni levanta un runtime. No conectes un segundo runtime con la misma identidad mientras el original siga activo.

Si se necesita recuperar dentro de un agente Cauce con una identidad distinta, detén el procedimiento: la herramienta actual rechazará el destino. Hace falta implementar y revisar explícitamente una reasignación segura de identidad; no cambies `context-state.json` ni los hashes a mano.

## Ensayar la reversión antes de un corte

Haz el ensayo antes de retirar o borrar el origen. Mantén una ventana sin escrituras en el espacio durante la copia; si el contenido cambia mientras se recorre, el helper debe fallar en lugar de presentar el ZIP como completo.

1. Define por escrito el criterio de aceptación del destino, el responsable del corte y la acción concreta que devolvería el tráfico o la ejecución al origen. Verifica que el origen puede mantenerse y arrancar de nuevo con su configuración anterior.
2. Crea y descarga la copia durable; valida el SHA-256 y revisa todas las omisiones. No inicies el corte si falta un dato necesario que el manifiesto marque como omitido.
3. Restaura en un destino aislado nuevo y valida sus archivos y recibo. Ensaya el cambio y el regreso solo con un canario aislado. No ejecutes dos instancias vivas con la misma identidad.
4. Para el ensayo de regreso, conserva el origen intacto, vuelve a seleccionarlo con el mecanismo de control de flota que corresponda y verifica que responde con la identidad y el contexto esperados. La copia por sí sola no revierte rutas, contenedores, procesos, cuotas, sesiones ni escrituras posteriores.
5. En el corte real, conserva el origen y la copia verificada hasta que el destino supere los criterios acordados. Si hay escrituras posteriores en el destino, captura y reconcilia esos cambios antes de volver al origen: el ZIP es una copia puntual, no una réplica.

Este repositorio aún no acredita un ciclo físico completo de reversión en un host real. El ensayo local demuestra backup y restauración de archivos sintéticos; no demuestra arranque, autenticación, conmutación ni regreso de un agente desplegado.

## Fallos, síntomas y recuperación

| Síntoma | Causa probable | Acción |
|---|---|---|
| Sigue en `pending` o `running`; no aparece el botón de descarga | El host aún procesa la solicitud | Actualiza el estado y espera. No descargues ni declares completa una copia sin `ready`. |
| `HOST_UNAVAILABLE`, error 404 o 409 al crear | Host sin conexión, agente reubicado, ejecutor ausente, cuota/retención agotada o política cambiante | Relee el agente y el host en la consola, restablece su ejecutor o libera capacidad según corresponda; después solicita una copia nueva. |
| `SCOPE_CHANGED` | Cambió la identidad, ubicación o autorización desde la solicitud | Vuelve a leer el agente y confirma el alcance actual. No reutilices como válida la solicitud fallida. |
| `LIMIT_EXCEEDED` | Se superó 16 GiB de contenido, 20 000 entradas, 8 MiB de manifiesto o el ZIP (16 GiB + 8 MiB + 64 MiB) | La consola dice «El espacio supera el límite de tamaño del backup. No se creó una copia incompleta.» Reduce datos regenerables, versiona proyectos en Git y pide otra copia. |
| `EXPORT_FAILED` por disco | El helper no tuvo sitio (`insufficient free space for space archive: required N bytes, available M bytes`) o falló la lectura con `ENOSPC` | La copia queda `failed`, sin descarga. Libera espacio en el ordenador del agente y pide otra. No uses el parcial. |
| `EXPIRED` o enlace sin descarga | El recibo o el archivo temporal venció (TTL de 24 horas) | Genera una copia nueva y descarga su ZIP dentro de su vigencia. |
| SHA-256 local distinto al recibo | Descarga incompleta, archivo alterado o copia distinta | No restaures; conserva el recibo, vuelve a descargar y compara otra vez. Si persiste, informa el fallo. |
| `space archive digest or content is invalid` | Hash de archivo/manifiesto incorrecto, contenido alterado o literal sensible detectado | No edites el manifiesto ni fuerces la restauración. Solicita una copia nueva y revisa las omisiones. |
| `space archive identity or schema differs` o `space belongs to another context identity` | Se usó identidad distinta o el validador no admite el esquema de ese ZIP | Confirma los cuatro campos contra el registro del agente y el recibo; no reasignes una copia entre tenants. Si persiste, coordina una pareja compatible de gateway y host antes de repetir. |
| `space restore destination must be new or empty` | El directorio de destino ya contiene datos | Elige un destino nuevo y vacío. No borres contenido del destino para forzar la operación. |
| `space archive must be private and owned by the selected user` o directorio/permisos inseguros | ZIP no regular, no privado, propietario incorrecto o ruta no permitida | Usa una copia regular de tu usuario con permisos privados y directorios privados; no cambies permisos del espacio productivo para sortear el control. |
| Hay entradas omitidas `external_mount`, `sensitive_path`, `sensitive_content`, `vcs_metadata` o `special_file` | El exportador excluyó mounts, credenciales, secretos, `.git` o archivos inseguros | Revisa el manifiesto y recupera por separado solo los datos autorizados y necesarios. No esperes que el ZIP contenga sesiones, logs, temporales o mounts externos. |

## Criterio de cierre

La recuperación de prueba queda documentada cuando el recibo durable está `ready`, el SHA-256 local coincide, las omisiones están revisadas y el restore aislado termina en `restored` con identidad y archivos verificados. Registra por separado qué se ensayó, qué fallo ocurrió y qué parte sigue pendiente de una prueba física. La copia de un espacio no acredita el backup de base de datos ni autoriza por sí sola el corte o la eliminación del origen.
