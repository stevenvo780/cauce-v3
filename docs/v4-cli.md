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
| `cauce <alias>` con sesión nominal | `context_client.py --terminal` | Resolver el destino dinámico y conectar por gateway y terminal-relay |

La instalación usa `ops/scripts/install-cauce-cli.sh`, que coloca helpers en el área local del usuario. El wrapper de plataforma necesita `CAUCE_PROJECT_ROOT` absoluto, el checkout fuente o el runtime instalado en `$HOME/.local/share/cauce-v3`. Prefiere `services/gateway/dist/platform-cli-main.js`; si sólo existe fuente usa `pnpm exec tsx` desde esa raíz. No instala dependencias automáticamente para suplir un bundle incompleto.

### Actualizar una instalación existente

Desde la raíz de un checkout actualizado de Cauce, como el mismo usuario que instaló el CLI:

```sh
bash ops/scripts/install-cauce-cli.sh "$(dirname "$(readlink -f "$(command -v cauce)")")"
hash -r
cauce hosts setup --dry-run
cauce hosts setup
cauce hosts status
```

El instalador reemplaza el comando y sus helpers juntos, y conserva una copia de los archivos reemplazados. Reutiliza el destino de avisos de attach existente. Si falta, pide configurarlo o ejecutar el instalador con `CAUCE_DESTINO_AVISO_INICIAL=<tu-destino-de-avisos>`. La actualización conserva las identidades enroladas; no repitas el enrolamiento ni copies archivos de credenciales.

`setup package must carry at most one agent image` identifica un helper antiguo que no admite las imágenes separadas de agentes y cuotas. Actualiza el CLI con el comando anterior: repetir sólo `cauce hosts setup` o desplegar el gateway no reemplaza los helpers locales. El setup actual, ejecutado desde el checkout con `bash ops/cli/cauce hosts setup`, avisa si el CLI del `PATH` todavía contiene ese rechazo e indica el comando de reinstalación. El paquete firmado conserva su formato.

### Comandos de administración y operación

```sh
cauce platform admin semilla --email "$CORREO_SUPER_ADMIN"
cauce platform contenedor admin semilla --email "$CORREO_SUPER_ADMIN" --company "$COMPANY_ID" --role owner
cauce platform contenedor contexto sembrar --empresa "$COMPANY_ID" --nativos "$DIRECTORIO_CONTEXTOS"
cauce platform contenedor empresa importar --inventario "$INVENTARIO" --perfiles "$PERFILES" --email "$CORREO_DUENO" --nombre "$NOMBRE_DUENO" --dry-run
cauce diagnose --help
cauce login --help
cauce spaces --help
cauce hosts setup --help
cauce hosts status --help
cauce platform admin otorgar --empresa "$COMPANY_ID" --id "$UUID" --email "$CORREO" --rol owner
cauce platform admin revocar --empresa "$COMPANY_ID" --id "$UUID"
cauce platform empresa estado --empresa "$COMPANY_ID" --estado retired --si
cauce platform empresa purgar-canarios --simular --empresa zz-canary-ejemplo
cauce platform enlace crear --empresa "$COMPANY_ID" --otra-empresa "$OTRA_EMPRESA"
cauce platform enlace borrar --empresa "$COMPANY_ID" --otra-empresa "$OTRA_EMPRESA"
cauce platform contexto sembrar --empresa "$COMPANY_ID" --simular
```

`admin`, `empresa` y `enlace` los resuelve `ops/cli/platform_admin.mjs` tanto en local como tras `cauce platform contenedor`. `contexto sembrar` lo resuelve `ops/cli/context_seed.mjs` también sin `contenedor`; `--simular` muestra el plan y no escribe. `otorgar` puede repetir `--id` y `--email`. `empresa estado` admite `enabled`, `disabled` o `retired`; deshabilitar o retirar pide confirmación y `--si` la da por escrito. `purgar-canarios` solo admite identificadores `zz-canary-…` y solo purga empresas ya retiradas. El resto del CLI de plataforma (`show`, `change`, `rollback`, `export`, `plan-import`, `import`) sigue en el gateway.

`cauce spaces inventory` exige `--dry-run`. `cauce spaces migrate` exige `--workspace`. El procedimiento de inventario y migración está en [archivos y contextos](v4-archivos-contextos.md).

`empresa importar` da de alta una empresa con su dueño, le importa la topología de un inventario (tenants, salas, agentes en borrador, membresías y aristas con su hub) y verifica su aislamiento en la misma transacción. Con `--perfiles`, además prepara los perfiles. `--dry-run` lo ejecuta todo y lo deshace; `--apply` lo confirma, y crear al dueño exige `--clave-archivo` con su contraseña inicial. En `contenedor`, el inventario, los perfiles y la clave se montan en solo lectura; los dos últimos deben ser `0600` del uid 1000. Procedimiento de Praxis: [plan de migración, §4](v4-migracion-plan.md#alta-e-importación-de-praxis-en-la-v4-central).

La siembra de administración es idempotente. En producción, los subcomandos `contenedor` usan la imagen de runtime y sus secretos montados; los datos privados de cuenta se suministran desde configuración del operador. `hosts setup` requiere que el ordenador ya esté enrolado; `hosts status` informa si el executor local quedó listo.

En flota dinámica, `CAUCE_FLEET_RUNTIME_STATE` limita el despacho legado. Con esa variable definida, `on`, `off`, `retirar` y el resto de mutaciones locales salen con el aviso de usar la consola y el coordinador durable; siguen admitidos entrar, `ver`, `estado` y `sesiones`. `pila-test` también se rechaza en ese modo. La incorporación de los nuevos comandos no demuestra por sí sola que todas las terminales remotas sigan funcionando en el despliegue: ese recorrido permanece como criterio de aceptación.

## Despacho legado

Si el primer argumento no es `diagnose`, `platform`, `hosts`, `login`, `context`, `context-native` ni `spaces`, `ops/cli/cauce` conserva el inventario local:

| Comando | Efecto |
|---|---|
| `cauce` o `cauce flota` | Lista la flota de ese inventario |
| `cauce estado` y `cauce <alias> estado` | Estado |
| `cauce ver` y `cauce <alias> ver` | Vista |
| `cauce <alias>` | Entra en la sesión local, salvo que haya sesión nominal de consola: entonces conecta por gateway |
| `cauce <alias> sesiones` | Sesiones del alias |
| `cauce <alias> on`, `off`, `login`, `aprovisionar`, `retirar` | Mutaciones locales del runtime. Con `CAUCE_FLEET_RUNTIME_STATE` quedan bloqueadas |
| `cauce cuotas` o `cauce coutas` | Abre por SSH el CLI de cuotas del host indicado en `CUOTAS_HOST` |
| `cauce pila-test` | Solo existe en el repositorio (`ops/tests/cauce-pila-test.cli.mjs`) |

`cuotas` y `coutas` no llevan un nombre de host en la documentación: el destino es el valor de `CUOTAS_HOST`. Sin esa variable el despacho usa el valor por defecto del script, que es un ordenador concreto de la instalación y no forma parte del contrato público.

## Sesión nominal y terminal de la flota dinámica

```sh
cauce login --gateway https://cauce.example.invalid --email usuario@example.invalid
cauce login --status
cauce AGENT_ALIAS
cauce TENANT_ID/AGENT_ALIAS
cauce AGENT_ALIAS --tenant TENANT_ID --mode shell
cauce AGENT_ALIAS --tenant TENANT_ID --mode harness
```

La contraseña se pide sin eco; para automatización, `cauce login --password-stdin` la recibe por stdin. `--renew` renueva la sesión guardada. El archivo queda privado (`0600`), ligado al gateway y al origen. Su ruta predeterminada es `$XDG_STATE_HOME/cauce-v3/console-session.json`, o `$HOME/.local/state/cauce-v3/console-session.json` si no existe esa variable. `CAUCE_CONSOLE_SESSION_FILE` y `--session-file` permiten elegir otro archivo; no hace falta copiar cookies del navegador.

Después del login, `cauce <alias>` consulta `/v3/console/terminal/targets`, solicita la sesión y su ticket de un solo uso en `/v3/console/terminal/sessions` y conecta al WebSocket publicado por el gateway. El relay llega al agente PTY del ordenador o contenedor; el cliente no necesita inventario local, acceso Docker ni SSH al destino. Un alias repetido exige `--tenant` o `tenant/alias`. El gateway decide visibilidad, permisos, modos y disponibilidad. Una sesión caducada, un destino sin autorización o un agente PTY desconectado producen un error.

El modo predeterminado elige `harness_rw`, después `shell` y finalmente `harness`, según los modos publicados y autorizados. `harness_rw` conecta la TUI existente y toma su control mediante la concesión del gateway antes de transmitir teclado; mientras dura ese control, el bus mantiene pendientes las entregas del agente. `harness` permite observar la TUI sin escribir; `shell` abre una shell del usuario de ejecución. `Ctrl-]` desconecta el cliente. Al salir se libera su sesión y el control asociado; la TUI compartida del agente sigue disponible. Si se interrumpe la red, el comando informa el cierre: vuelve a ejecutarlo para solicitar una sesión nueva.

Este acceso necesita Node.js y el runtime Cauce con su dependencia `ws`. Reutiliza el contrato y los validadores de mensajes de `terminal-relay`, desde su código fuente mediante `tsx` en un checkout de desarrollo o desde el runtime compilado instalado. `CAUCE_PROJECT_ROOT` puede señalar esa raíz, además de la ubicación habitual `$HOME/.local/share/cauce-v3`. `--ca-file` admite una CA privada para HTTP y WebSocket. La conexión WebSocket es directa al gateway; no utiliza el proxy HTTP del entorno. HTTPS es obligatorio salvo loopback local, y no se siguen redirecciones ni se ponen tickets en la URL.

Sin una sesión guardada ni una configuración nominal explícita, sigue disponible el despacho anterior por inventario. La presencia de `CAUCE_CONSOLE_SESSION_FILE`, `CAUCE_GATEWAY_URL` o argumentos como `--session-file` selecciona el gateway; un fallo de autenticación en ese recorrido se devuelve al usuario. Los subcomandos existentes conservan su precedencia sobre los alias.

El gateway concede el terminal si `grants.json` tiene una fila para el operador y el alias, o una fila `alias: "*"` del mismo tenant para ese operador exacto (ver [terminal-pty](terminal-pty.md)). Un operador `"*"` no puede usar el comodín de alias.

## Registro y operaciones de espacios

```sh
cauce spaces list --tenant TENANT_ID
cauce spaces create --tenant TENANT_ID --alias AGENT_ALIAS --expected-revision 7 --idempotency-key crear-agente-001 --input /ruta/privada/parameters.json
cauce spaces edit --tenant TENANT_ID --alias AGENT_ALIAS --expected-revision 7 --idempotency-key editar-agente-001 --input /ruta/privada/parameters.json
cauce spaces retire --tenant TENANT_ID --alias AGENT_ALIAS --expected-revision 7 --idempotency-key retirar-agente-001
```

Estos comandos reutilizan la sesión de `cauce login`; cada subcomando admite `--session-file`, `--gateway`, `--origin` y `--ca-file`. `list` devuelve la revisión, los agentes y las operaciones durables del tenant elegido. `create`, `edit` y `retire` previsualizan por defecto; `--apply` solicita su aplicación con la revisión esperada y la misma clave de idempotencia. El JSON contiene los parámetros de ejecución: identidad del runtime, harness, sala, membresías y ubicación. La previsualización y las capacidades del gateway determinan si puede aplicarse.

`create` y `edit` admiten `--registry-only` para cambiar únicamente el registro. En ese modo el JSON contiene los campos del registro y un agente nuevo queda deshabilitado; no acredita creación del runtime. Una operación `queued`, `running` o `awaiting_auth` requiere consultar su recibo con `list`: la aceptación no significa que el efecto físico esté completado.

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

Los argumentos comunes van antes del subcomando. `cauce login` genera el archivo de sesión privada con los campos `cookie` y `csrf_token` de una sesión humana autorizada. El archivo debe pertenecer al UID actual y conservar permisos privados; estos comandos de contexto reciben su ruta explícitamente.

```text
cauce context --gateway https://cauce.example.invalid --origin https://cauce.example.invalid --session-file /ruta/privada/session.json --tenant TENANT_ID --alias AGENT_ALIAS read
cauce context --gateway https://cauce.example.invalid --origin https://cauce.example.invalid --session-file /ruta/privada/session.json --tenant TENANT_ID --alias AGENT_ALIAS status
```

HTTPS es obligatorio salvo loopback local. `--ca-file /ruta/ca.pem` permite elegir una CA. Las mutaciones transmiten Origin y CSRF; una sesión con permiso de lectura no obtiene permiso de edición. El cliente tiene timeout de 65 segundos y límite de respuesta de 2 MiB.

Si hay un proxy en el entorno, configura `NO_PROXY=<ip del gateway>` para acceder directamente al gateway; si lo llamas por nombre, incluye también ese nombre, separado por coma. También se leen `https_proxy` y `no_proxy` en minúsculas. `urllib` no admite rangos CIDR en `NO_PROXY`: enumera las IP o nombres concretos. Los clientes de sesión usados por `login`, `context`, `context-native` y `spaces` omiten automáticamente el proxy para `localhost`, `127.0.0.0/8` y `::1`, incluso sin `NO_PROXY`. Para gateways remotos sólo usan `HTTPS_PROXY` o `https_proxy` mediante CONNECT; rechazan HTTP remoto y las redirecciones.

Un gateway HTTPS alcanzado mediante un alias que resuelve a loopback, por ejemplo a través de un túnel SSH, necesita incluir ese alias en `NO_PROXY` o `no_proxy`. La omisión automática del proxy reconoce las direcciones de loopback y `localhost`, pero no resuelve otros nombres para identificarlas.

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

`cauce context-native` usa la sesión humana, Origin y CSRF, sujetos a la autoridad durable de escritura de la empresa sobre el agente elegido. Sólo lee la lista explícita bajo una raíz real y los paths permitidos de `context/` o `directives/`. Lee el snapshot con `GET` y envía los cambios por `PUT /v3/console/context/agents/:tenant/:alias`, con `expected_version`, `source:native` y `files`. Conserva los demás archivos del snapshot remoto. `--remove directives/retirada.md` retira una ruta concreta; se puede repetir. No recorre el home, perfiles, sesiones o repositorios para descubrir documentos.

`--watch` vuelve a comprobar cada dos segundos. Tras un éxito avanza su versión esperada; ante edición concurrente se detiene y conserva el archivo local para reconciliarlo.

La ingesta automática de notas del SDK es otra vía: con raíz de espacio, contexto versionado y cliente de ingesta configurados, ocurre al preparar el siguiente turno y también en su verificación final. Usa `POST /v3/context/ingest`, certificado mTLS y autoridad del propio agente, con `base_version` y `files`; sólo autoriza modificaciones bajo `context/notes/**`. Las ediciones autónomas de perfil, directivas u otras rutas no generan una versión autorizada. Ante conflicto o rechazo, continúa con el snapshot autorizado recibido y conserva las divergencias: aparta los archivos conocidos por el snapshot o receipt que puede mover con seguridad a `config/conflicts/`; los archivos nuevos no rastreados permanecen locales. Un fallo de transporte hace fallar el turno. Los límites y estados de esta vía están en [archivos y contextos](v4-archivos-contextos.md#vías-de-edición-y-proyección-al-agente).

## Backup y restauración del espacio

```text
cauce spaces backup --archive /ruta/privada/nueva-copia.zip --directory /ruta/privada/space --company-id COMPANY_ID --tenant-id TENANT_ID --alias AGENT_ALIAS --runtime-key RUNTIME_KEY
cauce spaces restore --archive /ruta/privada/copia.zip --directory /ruta/privada/nuevo-space --company-id COMPANY_ID --tenant-id TENANT_ID --alias AGENT_ALIAS --runtime-key RUNTIME_KEY
```

La restauración exige un destino nuevo o vacío y no restaura autenticación ni reactiva procesos. Los filtros, manifiesto, límites y estados de backup durable están en [copias de espacios](v4-copias-espacios.md). La consola sólo ofrece descarga cuando el recibo está `ready`; la restauración se ejecuta con esta CLI.

## Evidencia

Las pruebas locales de los comandos y sus límites están en la [matriz de verificación](v4-matriz-local.md).

`tests/e2e/v4-cli-dynamic-terminal.test.ts` ejecuta `cauce login` y `cauce <alias>` contra PostgreSQL efímero, gateway, terminal-relay y agente Python PTY reales. Comprueba la respuesta de una shell en un destino `zz-canary-`, la identidad humana durable y los rechazos sin sesión o sin permiso sobre el agente. También verifica el control de una sesión tmux compartida con shell real, su grabación, la devolución del control y la continuidad de esa sesión al desconectar el CLI. La prueba se ejecuta localmente, sin proveedor de IA, y no acredita un recorrido en producción.
