# Espacios, archivos y contextos de Cauce V4

El espacio normalizado se deriva de `agent.state_directory/space` y se transmite al runtime como `CAUCE_SPACE_ROOT`. El layout, la materialización, las API, los helpers CLI y las copias se prueban en local. La migración de los espacios existentes y la adopción de cambios por proveedores reales siguen sujetas a verificación física y publicada; esta guía no acredita esas fases.

## Estructura y persistencia

```text
space/
  context/
  directives/
  projects/
  config/
  data/
  logs/
  tmp/
```

| Directorio | Contenido y consumidor | Persistencia y recuperación |
|---|---|---|
| `context/` | Documentos versionados; `profile.json` es el perfil canónico. Gateway, SDK, UI y CLI consumen el snapshot autorizado | Historial PostgreSQL y Git; incluido en backup |
| `directives/` | Directivas versionadas para el prompt/materialización del adapter | Historial PostgreSQL y Git; incluido en backup |
| `projects/` | Proyectos y archivos de trabajo del espacio | Incluido en backup si pasa los filtros; no se versiona en el broker de contextos |
| `config/` | Configuración no sensible y `context-state.json` con identidad, versión/digest y recibos SHA de archivos | Incluido en backup según filtros; el receipt no sustituye la autoridad durable |
| `data/` | Datos persistentes de trabajo | Incluido en backup según filtros; recuperación por identidad exacta |
| `logs/` | Registros locales de diagnóstico | Fuera de Git y backup del espacio; retención según su consumidor |
| `tmp/` | Artefactos temporales del runtime | Fuera de Git y backup; regenerable por su productor |

`prepareSpaceLayout` exige raíz absoluta canónica, directorios reales sin escape por symlinks y creación privada `0700`. Un archivo de propósito desconocido no se elimina por no encajar visualmente en la estructura. La normalización de espacios existentes requiere inventario, consumidores/rutas, copia recuperable y comparación de contenido antes/después.

### Layout por agente en el supervisor legacy

El supervisor de contenedores (`ops/scripts/container-adapter-supervisor.sh`, lanzado por las unidades rootless) deriva `CAUCE_SPACE_ROOT=<state_directory>/space` igual que el executor V4, crea los siete directorios (`0700`, como el usuario de ejecución y rechazando symlinks) antes de arrancar el adaptador y exporta `TMPDIR=<space>/tmp`, que es el productor real de `tmp/`. Sin workspace declarado en el inventario, `CAUCE_AGENT_WORKSPACE` (cwd del arnés) es `space/projects`.

Un workspace declarado fuera del espacio (`/workspace` compartido de Hegel, el de Argos, `clawd` legado) sigue siendo el cwd hasta su migración y se registra como montaje externo en `config/external-mounts.json`, con `excluded_from_copy` y el motivo. `MUSE_WORKSPACE` es opcional: sin él, Muse usa `CAUCE_AGENT_WORKSPACE`.

`logs/` no tiene todavía un productor propio: el log del adaptador va al journal de la unidad (acotado por la configuración de journald), no a `space/logs`. Un log acotado y rotado dentro del espacio requiere un cambio en el SDK o en el helper de ejecución.

No se guardan credenciales en estas raíces versionables. La sesión del proveedor permanece en su perfil autorizado, con el usuario de ejecución correspondiente. Los backups excluyen rutas y contenido sensible conocido; no ofrecen un detector universal de secretos incrustados en proyectos o datos.

## Fuente durable y estados

PostgreSQL conserva el historial inmutable, identidad `(company_id, tenant_id, alias)`, autoría/origen, versión, fecha, digest y archivos. Una escritura usa versión esperada y crea una versión nueva; restore registra `source:restore` y `restored_from`, conservando la historia.

| Dimensión | Qué significa | Qué no acredita por sí sola |
|---|---|---|
| Versión deseada | Cambio persistido con CAS en PostgreSQL | Consumo por el agente o envío a GitHub |
| Commit Git | Broker registró el contenido autorizado y su marcador | Push confirmado ni adopción del runtime |
| Sincronización `pending/synced/error` | Estado de envío de la versión al remoto | Que el agente ya use esa versión |
| Aplicación `pending/applied/error` | Resultado de la vía durable de aplicación | Un simple retorno del sink no concede `applied` |
| Versión aplicada | ACK `done` cercado con versión, digest y witness de consumo coherentes | Funcionamiento de todos los proveedores y rutas legacy |

Git y aplicación se reintentan por separado. Un fallo de push conserva el cambio durable; un timeout de aplicación no borra una adopción tardía válida. La UI muestra deseada/aplicada/sincronización separadas. No se transforma una escritura SQL, un commit ni una respuesta HTTP 202 en prueba de consumo.

El runtime publica una petición normal mediante el director durable de la misma empresa, reutiliza la pendiente y espera el ACK preciso. No toma prestado el director de otra empresa. El worker tiene timeout de 55 segundos y reserva de token/lease; el ACK terminal debe coincidir con el delivery y las pruebas de consumo esperadas. El background se ejecuta cada cinco segundos sólo cuando Git o runtime están configurados.

## API de contextos

Base: `/v3/console/context/agents/:tenant/:alias`. El servidor deriva la empresa de la autoridad humana; cambiar el target no concede acceso a otra empresa.

| Método y ruta relativa | Contrato |
|---|---|
| `GET /` | Snapshot vigente y archivos visibles |
| `PUT /` | `{expected_version, source, files}`; devuelve 202 tras persistir |
| `GET /history?before=N` | Hasta 50 registros sin contenido y `next_cursor` |
| `GET /diff?from=N&to=N` | Diferencias entre versiones del mismo target |
| `GET /status` | Deseada/aplicada/Git/sincronización y errores |
| `POST /restore` | `{expected_version, version}`; versión nueva, respuesta 202 |
| `POST /sync/retry` | Reintento de envío, conservando la versión |
| `POST /apply` | Respuesta 202 inmediata; trabajo fuera del plazo de acceso de sesión |

Mutaciones requieren Origin, CSRF y autoridad durable de escritura revalidada. `source` admite `ui`, `cli`, `native`, `profile` o `directive`. Las rutas permiten archivos `md/txt/json/yaml/yml` bajo `context/` y `directives/`, hasta 100 archivos, 262 144 caracteres por contenido y 1 MiB total UTF-8. Paths inseguros, segmentos sensibles y formas conocidas de secretos se rechazan. CAS concurrente produce conflicto explícito.

Sin runtime configurado, apply responde 503 y conserva el snapshot pendiente. El retorno del sink sin ACK no marca applied. La guía de [CLI](v4-cli.md) muestra history/diff/restore, ingesta local y export; [consola](v4-consola.md) documenta estados y preservación del borrador.

## Vías de edición y proyección al agente

El panel versionado usa la API con `source:ui`; la CLI usa `source:cli`; la ingesta explícita de archivos usa `source:native`. Los guardados legacy de perfil/directiva/documentos nativos permitidos enlazan al historial/outbox. `context/profile.json` permite restaurar el perfil canónico por SQL sin recursión de hooks. Configuración, MCP y memory quedan fuera de esa ingesta de documentos.

`context-native` toma una lista expresa de archivos y mergea sobre el snapshot remoto; no inspecciona homes. El modo watch es cada dos segundos y se detiene ante conflicto CAS. Editar directamente otro archivo local sin un mecanismo de ingesta soportado no promete captura automática del cambio.

El SDK incorpora el contexto una vez en el prompt y, si hay raíz de espacio, materializa `context/` y `directives/`. `context-state.json` guarda hashes de lo escrito. Antes de reemplazar o retirar un archivo compara el receipt con sus bytes actuales: una edición local divergente falla y permanece para reconciliación. El retiro usa descriptores de directorio, evita symlinks y hace readback.

La engine actual fuerza `native_document:'none'` para preservar el contrato del perfil legacy. Aunque el descriptor sepa describir `AGENTS.md`, `CLAUDE.md` o `SOUL.md`, la vía engine probada no demuestra reescritura del archivo físico legacy. Prompt, archivos del espacio y perfil SQL cuentan con evidencia local; la proyección física legacy y el consumo actual de cada proveedor necesitan su propia comprobación.

## Git privado compartido

El broker central usa un único repositorio privado y scopes estables:

```text
companies/<company_id>/tenants/<tenant_id>/agents/<alias>/
  context/...
  directives/...
  .cauce-version.json
```

El marcador liga versión y digest. Cambiar nombre visible, sala o host conserva el scope porque no modifica los IDs. Tenant y alias son identificadores persistentes; cambiar uno no es un renombrado inocuo y requiere una migración explícita de identidad/historial.

Sólo el broker tiene acceso al repositorio completo y su credencial global. Agentes y humanos reciben contenido mediante Cauce y el target autorizado; no se les entrega el clone compartido ni la clave GitHub. La CLI de contexto aplica los permisos del gateway y la transferencia de configuración de empresa no exporta este repositorio.

`ContextGitBroker` exige raíz privada absoluta canónica y metadata `.git` real. Construye un índice temporal por commit; no comparte un checkout mutable de contenido para cada escritor. Usa CAS de `update-ref` sobre main, conflicto explícito y replay idempotente por identidad/versión/digest. Push envía `origin main` y comprueba la relación de ancestry del commit con main. Las pruebas locales usan un remoto Git bare real y ensayan concurrencia, fallo de push y recuperación.

El broker filtra variables heredadas `GIT_*`, deshabilita hooks y usa su configuración controlada. `GIT_SSH_COMMAND` externo no es el canal de configuración del transporte. La clave y known_hosts se fijan en `core.sshCommand` local del repositorio.

### Preparación comprobada de GitHub y VPS

El repositorio [stevenvo780/cauce-agent-contexts](https://github.com/stevenvo780/cauce-agent-contexts) es privado. Un ensayo sintético registró y envió el mismo commit `6b542f583ea19747d4c3f196ce1a279ed8344ff2`; la repetición conservó ese commit. Se limpió el recurso sintético con `73cc58f6fcc195263ff8ff0e935bb57d173f481d`. El `ls-remote` desde el broker preparado de VPS mostró ese último SHA en main. Son pruebas de transporte con contenido sintético, sin contextos productivos migrados.

Metadatos de configuración confirmados por el coordinador:

| Ruta de host | Mount del gateway | Uso |
|---|---|---|
| `/var/lib/cauce-v3-context-broker/repository` | `/var/lib/cauce-v3/contexts`, escritura | Repositorio privado central |
| `/var/lib/cauce-v3-context-broker/ssh` | `/run/cauce-context-git`, sólo lectura | `id_ed25519` y `known_hosts` del broker |

La deploy key de escritura tiene id `166116310`. No se documenta su contenido. El comando SSH local fija `-i /run/cauce-context-git/id_ed25519`, `UserKnownHostsFile=/run/cauce-context-git/known_hosts`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes` y `-F /dev/null`. El setup inicial conserva un fallo real de ownership de Git; el recibo posterior acredita que se corrigió el acceso, sin acreditar despliegue del gateway.

Compose prepara `CAUCE_CONTEXT_REPOSITORY_ROOT=/var/lib/cauce-v3/contexts`, `CAUCE_PROJECT_ROOT=/app`, `CAUCE_SPACE_BACKUP_DIRECTORY=/var/lib/cauce-v3/space-backups` y `CAUCE_SPACE_BACKUP_PYTHON=/usr/local/bin/python3`. Las rutas de host pueden elegirse con `CAUCE_CONTEXT_REPOSITORY_DIRECTORY` y `CAUCE_CONTEXT_GIT_KEY_DIRECTORY`. `space_backups_data` persiste las copias durables. Configuración preparada no equivale a imagen publicada ni worker activo demostrado.

## Copias durables y recuperación

El backend deriva la fuente `state_directory/space` de la fila del agente y la política del ordenador. El navegador no aporta rutas. Las API son:

```text
POST /v3/console/spaces/:tenant_id/:alias/backups
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id
GET  /v3/console/spaces/:tenant_id/:alias/backups/:id/download
POST /v3/fleet/hosts/:host_id/space-backups
```

El UUID liga empresa/target/host/humano/placement y hash de política. El canal firmado y el worker usan token/epoch, lease de 60 segundos renovado cada 15 y revalidación de autoridad y placement. Reclaim invalida el fence anterior; upload exige offset y bytes exactos en retries. Finish verifica identidad, manifiesto, bytes y SHA-256, con recuperación de rename seguido de rollback SQL. Download calcula la integridad del mismo descriptor de archivo que entrega.

`pending/running/ready/failed` se conserva durable. URL sólo para ready; expiración `EXPIRED` sin URL. TTL de 24 horas, máximo 20 solicitudes activas por empresa y 200 globales, directorios `0700` y archivos `0600`. ZIP y total tienen límite de 1 GiB; archivo individual de 128 MiB; máximo 20 000 entradas y manifiesto de 8 MiB. Los chunks son de 64 KiB y el helper tiene deadline de 110 segundos. `LIMIT_EXCEEDED` acredita un fallo explícito, no una copia parcial suficiente.

La CLI local comparte los límites de 1 GiB total y 128 MiB por archivo, con los mismos filtros base; restore exige destino nuevo/vacío e identidad exacta. No hay botón web de restore. El ZIP incluye contenido permitido de context/directives/projects/config/data; Git sólo versiona context/directives. Ninguno sustituye un plan de recuperación de credenciales ni una copia consistente de otros sistemas durables.

Se probó con PostgreSQL runtime, HTTP TCP, Ed25519, Python y filesystem reales: un proyecto sintético de 100 000 bytes fue exportado, descargado y restaurado sin `config/auth.json` ni logs. Las pruebas de descarga UI usan un ZIP fixture vacío de 22 bytes y prueban su mecánica e integridad, sin demostrar contenido productivo. Se verificó además un JSONL sintético mayor de 96 MiB con hashes exactos y límites de entradas. Los espacios reales de varios GiB requieren una copia consistente adicional; esas pruebas locales no acreditan su recuperación productiva.

## Descriptores de harnesses

`packages/adapter-sdk/descriptors/<harness>.json` contiene esquema 1, identidad, operaciones y límites de contexto. El parser valida identidad, campos y recetas cerradas; no ejecuta shell suministrado por el navegador o por el JSON. El bundle aprobado contiene los descriptores; el executor verifica el digest del descriptor leído, sin usar el repositorio fuente como fallback.

| Operación | Receta |
|---|---|
| `install` | `runtime-package` |
| `authenticate` | `provider-login` |
| `execute` | `native-execution` |
| `update` | `provider-update` |
| `quota` | `quota-collector` |

El catálogo reconoce `claude`, `codex`, `hermes`, `opencode`, `openclaw`, `grok`, `muse` y `fake`. Las recetas Python de instalación/login/cuotas con comandos cerrados están implementadas para Claude, Codex y Grok; otras operaciones sin implementación permanecen indisponibles. Reconocer una identidad de harness no prueba que todas sus operaciones estén soportadas.

Para añadir una integración hay que registrar su identidad/definición en el SDK, empaquetar y validar el descriptor, implementar las recetas necesarias en el helper cerrado y declarar capacidades frescas del host. Las pruebas deben incluir descriptor inválido, operación ausente, bundle/hash/usuario/rutas y ejecución física con el CLI correspondiente. El mecanismo actual reduce la definición repetida mediante recetas, pero no permite añadir cualquier proveedor sólo dejando un JSON: enums, driver y comandos soportados siguen requiriendo código. No se acredita extensibilidad completa sólo por las ocho fichas del catálogo.

## Diagnóstico y fronteras de aceptación

Para un conflicto de contexto se releen versión e historial, se preserva el borrador y se reconcilian cambios; para Git pendiente se consulta status y se usa retry, conservando el snapshot durable; para applied pendiente se comprueba director de la empresa, delivery, lease y ACK/witness exactos. Para backup fallido se conserva UUID/error/fence y se investiga placement, política, integridad o límites. No se imprimen contenido sensible, DSN ni sesiones para diagnosticar.

La evidencia local incluye 16 pruebas PostgreSQL/Git, 5 API PostgreSQL, 10 adapter/espacio, 6 CLI con HTTP fixture y las pruebas de backup durable y SDK. Los recibos, su procedencia y los negativos están en [la matriz local](v4-matriz-local.md). La migración física, contexto productivo en GitHub, turnos reales de proveedor, gate final integrado y E2E publicado siguen pendientes y no se deducen de esos resultados.

## Exclusión durante el consumo de contexto

El SDK serializa turnos que comparten `CAUCE_SPACE_ROOT` entre sesiones y engines del mismo proceso. Adquiere el espacio después del lock de sesión, materializa el contexto y verifica SHA, ruta y metadatos antes de acreditar adopción. Conserva el lock hasta persistir el resultado; un cambio externo falla sin marcar done ni applied. Se probaron 38 casos locales, incluidos 10 de exclusión, cancelación, timeout y persistencia. La operación debe garantizar un único consumidor por espacio: este lock no coordina procesos distintos.
