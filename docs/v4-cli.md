# CLI de Cauce V4

Las pruebas locales y sus límites están en [la matriz local](v4-matriz-local.md). La instalación comprobada en un destino temporal no acredita instalación en todos los ordenadores ni despliegue de esta versión.

## Entrada e instalación

`ops/cli/cauce` conserva el despacho de terminales, sesiones, panel y cuotas, e incorpora estas entradas antes del despacho legado:

| Entrada | Implementación | Alcance |
|---|---|---|
| `cauce platform` | `cauce-platform` → gateway CLI | Catálogo de plataforma y transferencia de configuración de una empresa |
| `cauce hosts` | `host_enrollment.py` | Enrolamiento y heartbeat firmado de un ordenador |
| `cauce context` | `context_client.py` | Lectura y edición del contexto versionado mediante el gateway |
| `cauce context-native` | `context_native.py` | Ingesta de una lista explícita de archivos locales |
| `cauce spaces` | `cauce-spaces` y `space_archive.py` | Operaciones durables de espacios, backup y restauración local del contenido persistente permitido |
| `cauce diagnose` | `cauce-diagnose` | Diagnóstico de solo lectura, acotado a la empresa de la sesión |
| `cauce login` | `cauce-login` | Crear, consultar o renovar la sesión nominal de consola |

La instalación usa `ops/scripts/install-cauce-cli.sh`, que coloca helpers en el área local del usuario. El wrapper de plataforma necesita `CAUCE_PROJECT_ROOT` absoluto, el checkout fuente o el runtime instalado en `$HOME/.local/share/cauce-v3`. Prefiere `services/gateway/dist/platform-cli-main.js`; si sólo existe fuente usa `pnpm exec tsx` desde esa raíz. No instala dependencias automáticamente para suplir un bundle incompleto.

### Comandos de administración y operación

```sh
cauce platform admin semilla --email "$CORREO_SUPER_ADMIN"
cauce platform contenedor admin semilla --email "$CORREO_SUPER_ADMIN" --company "$COMPANY_ID" --role owner
cauce platform contenedor contexto sembrar --empresa "$COMPANY_ID" --nativos "$DIRECTORIO_CONTEXTOS"
cauce diagnose --help
cauce login --help
cauce spaces --help
cauce hosts setup --help
cauce hosts status --help
```

La siembra de administración es idempotente. En producción, los subcomandos `contenedor` usan la imagen de runtime y sus secretos montados; los datos privados de cuenta se suministran desde configuración del operador. `hosts setup` requiere que el ordenador ya esté enrolado; `hosts status` informa si el executor local quedó listo.

En flota dinámica, `CAUCE_FLEET_RUNTIME_STATE` limita el despacho legado a las consultas y paneles admitidos. Las mutaciones físicas pasan por la consola y el coordinador durable. La incorporación de los nuevos comandos no demuestra por sí sola que todas las terminales remotas sigan funcionando en el despliegue: ese recorrido permanece como criterio de aceptación.

## Administración de plataforma

Todos los comandos requieren correo humano, empresa activa elegida y un archivo DSN autorizado:

```text
cauce platform show --email owner@example.invalid --company COMPANY_ID --database-url-file /ruta/privada/database-url
cauce platform change --email owner@example.invalid --company COMPANY_ID --database-url-file /ruta/privada/database-url --mutation-file /ruta/privada/change.json --expected-revision 12 --dry-run
cauce platform rollback --email owner@example.invalid --company COMPANY_ID --database-url-file /ruta/privada/database-url --revision 11 --expected-revision 12 --dry-run
cauce platform export --email owner@example.invalid --company COMPANY_ID --database-url-file /ruta/privada/database-url --output /ruta/privada/nuevo-bundle.json
cauce platform plan-import --email owner@example.invalid --company COMPANY_ID --database-url-file /ruta/privada/database-url --bundle-file /ruta/privada/bundle.json --expected-revision 12 --output /ruta/privada/nuevo-plan.json
cauce platform import --email owner@example.invalid --company COMPANY_ID --database-url-file /ruta/privada/database-url --bundle-file /ruta/privada/bundle.json --plan-file /ruta/privada/plan.json --dry-run
```

`change`, `rollback` e `import` exigen elegir `--dry-run` o `--apply`. El ensayo no guarda cambios; la aplicación usa CAS y la autoridad durable del humano dentro de la misma transacción. No se acepta un rol en argumentos ni se concede autoridad por `is_hub`. Harnesses y políticas globales requieren `platform_admin`; el catálogo no está habilitado en el editor genérico de configuración.

La contraseña actual se pide sin eco. También se admite `CAUCE_PLATFORM_PASSWORD`, que se elimina del entorno antes de crear el pool. No hay contraseña ni DSN en argv, ni fallback a `DATABASE_URL`. El archivo DSN tiene límite de 16 KiB; los JSON, de 32 MiB. Las entradas deben ser archivos absolutos privados del UID actual, regulares y sin enlace simbólico final. Las salidas son nuevas, modo `0600`, y no sobrescriben archivos existentes. El DSN debe tener los permisos SQL apropiados; la CLI no amplía los del runtime.

La transferencia es estructural y está acotada a la misma empresa: tenants, salas, metadatos de agentes, membresías y ACL permitidas. El bundle lleva esquema y SHA-256; el plan liga empresa, revisión, contenido, mutations y solicitudes físicas con otro SHA-256. `import` recalcula el plan, rechaza colisiones con tenants ajenos, contenido alterado y CAS obsoleto. Crea o actualiza lo incluido sin borrar recursos adicionales.

El replay devuelve el recibo durable sin pisar cambios posteriores. Los agentes nuevos quedan inactivos; las alteraciones físicas y membresías de agentes colocados generan operaciones en la cola del coordinador. `physical_effect_verified:false` sigue siendo explícito: haber importado configuración o encolado trabajo no acredita creación ni autenticación de un agente.

La transferencia no incluye personas, cuentas o bindings de proveedor, contraseñas, certificados, sesiones, mensajes, perfiles ni contextos. Conserva la selección local autorizada de cuenta/modelo/esfuerzo de agentes existentes. No crea empresas, relocaliza ordenadores ni sustituye una copia del espacio.

## Enrolamiento de ordenadores

El humano autorizado crea la invitación desde la consola de su empresa. El token sólo se entrega una vez; se pasa a la CLI por stdin:

```text
cauce hosts enroll --gateway https://cauce.example.invalid --invitation-stdin
cauce hosts heartbeat --identity-directory /ruta/privada/identidad-del-host
```

`enroll` admite `--state-root /ruta/privada`. Su raíz predeterminada es `$HOME/.local/state/cauce-v3/hosts/<company>/<host>`. Genera una identidad Ed25519 propia; no requiere copiar sesiones ni `auth.json` de otro ordenador. No se pone la invitación en argv ni en comandos guardados en el historial del shell.

La identidad enrolada y el executor preparado son estados distintos. Un heartbeat firmado confirma identidad y presencia; las capacidades de ejecución necesitan un catálogo firmado vigente del executor y la política admitida por el gateway. No basta con el heartbeat para habilitar creación, autenticación o administración de entornos.

## Contextos mediante el gateway

Los argumentos comunes van antes del subcomando. El archivo de sesión privada contiene los campos `cookie` y `csrf_token` de una sesión humana autorizada. No existe en estos helpers un login autónomo ni un exportador de sesión del navegador. El archivo debe pertenecer al UID actual y conservar permisos privados.

```text
cauce context --gateway https://cauce.example.invalid --origin https://cauce.example.invalid --session-file /ruta/privada/session.json --tenant TENANT_ID --alias AGENT_ALIAS read
cauce context --gateway https://cauce.example.invalid --origin https://cauce.example.invalid --session-file /ruta/privada/session.json --tenant TENANT_ID --alias AGENT_ALIAS status
```

HTTPS es obligatorio salvo loopback local. `--ca-file /ruta/ca.pem` permite elegir una CA. Las mutaciones transmiten Origin y CSRF; una sesión con permiso de lectura no obtiene permiso de edición. El cliente tiene timeout de 65 segundos y límite de respuesta de 2 MiB.

Si hay un proxy en el entorno, configura `NO_PROXY=<ip del gateway>` para acceder directamente al gateway; si lo llamas por nombre, incluye también ese nombre, separado por coma. `urllib` no admite rangos CIDR en `NO_PROXY`: enumera las IP o nombres concretos. Los clientes de sesión usados por `login`, `context`, `context-native` y `spaces` omiten automáticamente el proxy para `localhost`, `127.0.0.0/8` y `::1`, incluso sin `NO_PROXY`. Para gateways remotos sólo usan `HTTPS_PROXY` mediante CONNECT; rechazan HTTP remoto y las redirecciones.

| Subcomando | Argumentos propios | Resultado |
|---|---|---|
| `read` | Ninguno | Versión actual y archivos autorizados |
| `status` | Ninguno | Versión deseada, aplicada y estado de Git/sincronización |
| `history` | `--before N` opcional | Hasta 50 entradas y cursor para continuar |
| `diff` | `--from-version N --to-version N` | Diferencias por archivo; `from=0` permite comparar contra vacío |
| `edit` | `--expected-version N --input /ruta/privada/files.json` | Snapshot completo nuevo, origen `cli`, sujeto a CAS |
| `restore` | `--expected-version N --version N` | Nueva versión derivada de la anterior; conserva el historial |
| `retry` | Ninguno | Reintento de la sincronización pendiente |
| `apply` | Ninguno | Solicitud de aplicación al runtime; la respuesta no acredita consumo |
| `export` | `--directory /ruta/privada/destino-nuevo` | Archivos de contexto y `context-manifest.json` |

El JSON de `edit` es una lista, sin wrapper:

```json
[
  {"path":"context/objetivo.md","content":"Objetivo autorizado del agente.\n"},
  {"path":"directives/operacion.md","content":"Directiva autorizada.\n"}
]
```

`edit` reemplaza el conjunto versionado completo: omitir un archivo lo retira de esa versión. La API admite hasta 100 archivos bajo `context/` o `directives/`, con extensiones `md`, `txt`, `json`, `yaml` o `yml`, límite por contenido de 262 144 caracteres y total UTF-8 de 1 MiB. Rechaza rutas inseguras y patrones sensibles conocidos. Un conflicto CAS obliga a releer y reconciliar el borrador; no se descarta contenido silenciosamente.

`export` copia sólo el contexto autorizado. No incluye proyectos, datos, logs, credenciales ni todo el espacio. Para una copia del contenido persistente se usa `spaces backup` o la descarga durable de la consola.

## Ingesta de archivos locales

```text
cauce context-native --gateway https://cauce.example.invalid --origin https://cauce.example.invalid --session-file /ruta/privada/session.json --tenant TENANT_ID --alias AGENT_ALIAS --root /ruta/privada/space --expected-version 7 context/objetivo.md directives/operacion.md
```

Sólo lee la lista explícita bajo una raíz real y los paths permitidos. Conserva los demás archivos del snapshot remoto. `--remove directives/retirada.md` retira una ruta concreta; se puede repetir. No recorre el home, perfiles, sesiones o repositorios para descubrir documentos.

`--watch` vuelve a comprobar cada dos segundos. Tras un éxito avanza su versión esperada; ante edición concurrente se detiene y conserva el archivo local para reconciliarlo. Un archivo local modificado sin pasar por esta ingesta no queda automáticamente en el historial.

## Backup y restauración del espacio

```text
cauce spaces backup --archive /ruta/privada/nueva-copia.zip --directory /ruta/privada/space --company-id COMPANY_ID --tenant-id TENANT_ID --alias AGENT_ALIAS --runtime-key RUNTIME_KEY
cauce spaces restore --archive /ruta/privada/copia.zip --directory /ruta/privada/nuevo-space --company-id COMPANY_ID --tenant-id TENANT_ID --alias AGENT_ALIAS --runtime-key RUNTIME_KEY
```

La restauración exige un destino nuevo o vacío y no restaura autenticación ni reactiva procesos. Los filtros, manifiesto, límites y estados de backup durable están en [copias de espacios](v4-copias-espacios.md). La consola sólo ofrece descarga cuando el recibo está `ready`; la restauración se ejecuta con esta CLI.

## Evidencia

Las pruebas locales de los comandos y sus límites están en la [matriz de verificación](v4-matriz-local.md).
