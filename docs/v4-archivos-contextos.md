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

El supervisor de contenedores (`ops/scripts/container-adapter-supervisor.sh`, lanzado por las unidades rootless) deriva `CAUCE_SPACE_ROOT=<state_directory>/space` igual que el executor V4, crea los siete directorios (`0700`, como el usuario de ejecución y rechazando symlinks) antes de arrancar el adaptador y exporta `TMPDIR=<space>/tmp`, que es el productor real de `tmp/`.

`CAUCE_AGENT_WORKSPACE` (cwd del arnés) sigue la migración de cada alias, para no perder sesiones por cwd (claude y grok las guardan por directorio) ni los `CLAUDE.md`, `AGENTS.md` y `.mcp.json` del proyecto:

- Con workspace en el inventario, es ese workspace. Si está fuera del espacio (Argos, `clawd` legado) se declara como montaje externo.
- Sin workspace y sin migrar, **no se exporta** y el arnés conserva el cwd heredado del contenedor. Se declara como montaje externo el `/workspace` compartido (o `SHARED_SESSION_WORKSPACE` si existe), que es el caso de Hegel, Atlas y Kratos.
- Solo la clave explícita `SPACE_CWD_MIGRATED=1` en la configuración del alias lo cambia a `space/projects`. Se activa después de copiar sin mover, comparar manifiestos y verificar un turno con nonce.

Los montajes externos se registran en `config/external-mounts.json` con `excluded_from_copy` y el motivo; las copias del espacio los excluyen explícitamente.

Cuando el inventario declara un workspace de Muse, la política de aprovisionamiento exige `MUSE_WORKSPACE` y lo valida contra el inventario; el supervisor rechaza un valor distinto. El SDK no fija `/home/node/clawd`: resuelve el workspace con `CAUCE_MUSE_WORKSPACE ?? CAUCE_AGENT_WORKSPACE ?? process.cwd()` en `packages/adapter-sdk/src/bin/config.ts`.

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

El panel versionado usa la API con `source:ui`; la CLI de edición usa `source:cli`; las escrituras legacy permitidas de perfil, directivas y documentos nativos registran su versión y outbox. `context/profile.json` permite restaurar el perfil canónico por SQL sin recursión de hooks.

`cauce context-native` usa la sesión humana de consola (cookie, Origin y CSRF) y su autoridad durable de escritura sobre la empresa y el agente elegidos. Toma una lista expresa de archivos permitidos bajo `context/` o `directives/`, lee el snapshot remoto con `GET` y combina los cambios mediante `PUT /v3/console/context/agents/:tenant/:alias` con `expected_version`, `source:native` y `files`. Conserva los archivos no seleccionados y no inspecciona homes. El modo watch comprueba cada dos segundos y se detiene ante conflicto CAS, conservando los archivos locales.

La ingesta autónoma del SDK usa `POST /v3/context/ingest` con `base_version` y `files`, certificado mTLS e identidad del propio agente; el servidor deriva su empresa y target, sin autoridad humana para editar otros agentes. Con raíz de espacio, contexto versionado y cliente de ingesta configurados, compara los archivos locales con `context-state.json` al preparar el siguiente turno y vuelve a comprobarlos en su verificación final. Sólo autoriza modificaciones bajo `context/notes/**`; perfil, directivas y el resto del contexto siguen gobernados por el operador. Configuración, MCP y memory no se ingieren por esta vía. Editar fuera de las rutas permitidas no crea una versión autorizada; los archivos no versionables (rutas sensibles, symlinks, secretos detectados) no se envían.

Si la ingesta autónoma choca (`VERSIONED_CONTEXT_CONFLICT`), el cambio local no es ingerible (`VERSIONED_CONTEXT_CHANGED`) o el servidor lo rechaza (`VERSIONED_CONTEXT_INGEST_REJECTED`), el turno continúa con el snapshot autorizado recibido. Los archivos divergentes conocidos por el snapshot o el receipt que pueden apartarse con seguridad se conservan en `config/conflicts/<ruta>.conflict` (sufijo `-2` a `-100` si el nombre existe); los archivos nuevos ajenos a ambos conjuntos permanecen locales. El engine registra `versioned_context_degraded` con la razón (`native_context_conflict` o `local_context_quarantined`) y las rutas. Un fallo de transporte (`VERSIONED_CONTEXT_INGEST_FAILED`) hace fallar el turno.

El SDK incorpora el contexto una vez en el prompt y, si hay raíz de espacio, materializa `context/` y `directives/`. `context-state.json` guarda hashes de lo escrito. Antes de reemplazar o retirar un archivo compara el receipt con sus bytes actuales. El retiro usa descriptores de directorio, evita symlinks y hace readback.

La engine no fuerza `native_document` a `none`: usa el valor del descriptor del harness. Al materializar, si no es `none`, `writeSpaceContext` escribe ese fichero en la raíz del espacio (`CAUCE_SPACE_ROOT`). `claude` declara `CLAUDE.md`; el resto de los descriptores publicados declara `AGENTS.md`. El parser admite también `SOUL.md` y ningún descriptor publicado lo selecciona. El bloque queda entre `<!-- CAUCE VERSIONED CONTEXT START -->` y `<!-- CAUCE VERSIONED CONTEXT END -->`, conserva el texto que ya hubiera fuera de las marcas y anota la versión y el digest. El encabezado del prompt incluye la ruta absoluta de ese documento salvo cuando el descriptor dice `none`. La proyección no reescribe un workspace legado fuera del espacio. Que cada proveedor lea el documento en un turno real sigue sin estar demostrado.

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

`ContextGitBroker` exige raíz privada absoluta canónica y metadata `.git` real. Hace fetch de `origin/main`, integra los cambios por carpeta y publica con CAS de `update-ref`; no comparte un checkout mutable entre escritores. Los commits de contenido se atribuyen al alias con la forma `alias@empresa.cauce.invalid`; el broker figura como committer. El replay es idempotente por identidad/versión/digest y el push comprueba la relación de ancestry con main. Las pruebas locales usan un remoto Git bare real y ensayan concurrencia, fallo de push y recuperación.

El broker filtra variables heredadas `GIT_*`, deshabilita hooks y fija la autoría de los commits. `GIT_SSH_COMMAND` externo no es el canal de configuración del transporte. El código no configura `core.sshCommand`; montar la clave y `known_hosts` no basta para seleccionarlos en Git.

### Configuración del broker

| Ruta de host | Mount del gateway | Uso |
|---|---|---|
| `/var/lib/cauce-v3-context-broker/repository` | `/var/lib/cauce-v3/contexts`, escritura | Repositorio privado central |
| `/var/lib/cauce-v3-context-broker/ssh` | `/run/cauce-context-git`, sólo lectura | `id_ed25519` y `known_hosts` del broker |

El código no pasa al transporte SSH las opciones `-i`, `UserKnownHostsFile`, `StrictHostKeyChecking`, `IdentitiesOnly` ni `-F /dev/null`; Git usa la configuración SSH efectiva del entorno del broker.

Compose prepara `CAUCE_CONTEXT_REPOSITORY_ROOT=/var/lib/cauce-v3/contexts`, `CAUCE_PROJECT_ROOT=/app`, `CAUCE_SPACE_BACKUP_DIRECTORY=/var/lib/cauce-v3/space-backups` y `CAUCE_SPACE_BACKUP_PYTHON=/usr/local/bin/python3`. Las rutas de host pueden elegirse con `CAUCE_CONTEXT_REPOSITORY_DIRECTORY` y `CAUCE_CONTEXT_GIT_KEY_DIRECTORY`. `space_backups_data` persiste las copias durables. Configuración preparada no equivale a imagen publicada ni worker activo demostrado.

## Copias durables y recuperación

El backend deriva la fuente `state_directory/space` de la fila del agente y la política del ordenador; el navegador no aporta rutas. El contrato, los filtros, los límites, los estados y la recuperación están descritos en [copias durables](v4-copias-espacios.md). La CLI local se documenta en [Cauce V4 CLI](v4-cli.md).

## Descriptores de harnesses

`packages/adapter-sdk/descriptors/<harness>.json` contiene esquema 1, identidad, operaciones y límites de contexto. El parser valida identidad, campos y recetas cerradas; no ejecuta shell suministrado por el navegador o por el JSON. El bundle aprobado contiene los descriptores; el executor verifica el digest del descriptor leído, sin usar el repositorio fuente como fallback.

| Operación | Receta |
|---|---|
| `install` | `runtime-package` |
| `authenticate` | `provider-login` |
| `execute` | `native-execution` |
| `update` | `provider-update` |
| `quota` | `quota-collector` |

El catálogo reconoce `claude`, `codex`, `hermes`, `opencode`, `openclaw`, `grok`, `muse`, `fake` y `fake2`. Los datos cerrados de operación (argv de login y de cuota, paquete de actualización y módulo de flota) viven en la sección `provider` del propio descriptor y los validan igual el parser TypeScript y el Python; las listas de runtime (operaciones, cuotas, plantillas, empaquetado y smoke) se derivan del directorio de descriptores del bundle. Reconocer una identidad de harness no prueba que todas sus operaciones estén soportadas: cada descriptor declara solo las operaciones implementadas y las capacidades se calculan por acción con su motivo.

### Runbook: dar de alta un harness

1. Crear `packages/adapter-sdk/descriptors/<harness>.json` (esquema 1) declarando solo las operaciones implementadas y, si aplica, la sección `provider` con argv absoluto bajo `/usr/local/bin`, paquete npm y `fleet_module` exactamente `fleet_provider_<harness>`.
2. Correr el test de paridad y seguir exactamente la lista que imprime (hoy, para un harness nuevo):

   ```text
   packages/adapter-sdk/src/sdk/types.ts: add '<harness>' to the HarnessId union
   packages/adapter-sdk/src/harnesses/index.ts: add the '<harness>' harness definition
   packages/adapter-sdk/src/harnesses/<harness>.ts: create the harness definition module
   packages/adapter-sdk/package.json: add the cauce-adapter-<harness> bin
   packages/adapter-sdk/src/bin/<harness>.ts: create the adapter bin entrypoint
   packages/adapter-sdk/src/sdk/durable-store/session-file.ts: add '<harness>' to the session key alternation
   services/gateway/src/console/agent-documents/catalog.ts: add '<harness>' to HarnessKind or to GATEWAY_OMITTED in ops/tests/test_harness_parity.py
   console/src/features/config/arneses.ts: add '<harness>' to ARNESES_REALES (or to CONSOLE_PENDING in ops/tests/test_harness_parity.py)
   ```

   Si el harness declara `quota`, la paridad exige además los enums de protocolo, gateway y consola, el contrato de recibos y una migración nueva para cambiar el CHECK SQL efectivo (nunca editar las migraciones anteriores). La prueba reconstruye las restricciones vigentes en orden y compara conjuntos en ambos sentidos; también rechaza definiciones SDK y claves de sesión sin descriptor. Si declara `fleet_module`, el módulo `ops/cli/fleet_provider_<harness>.py` debe existir y exponer `environment`, `validate_binding` y `authenticated`.
3. Crear el manifiesto `packages/adapter-sdk/manifests/<harness>.json` coherente con la definición y el fixture de CLI falso `packages/adapter-sdk/test/fixtures/fake-<harness>.mjs` si los tests parametrizados lo ejercitan.
4. Empaquetar: `pnpm --filter @cauce/adapter-sdk build` (el descriptor y el bin llegan solos a `dist/`) y construir el bundle con `ops/scripts/build-adapter-release.sh <destino-absoluto> <aprobaciones-absolutas.json>` en un árbol limpio. El segundo archivo es un objeto público `{ "<harness>": "<sha256-aprobado-de-64-hex>" }`, cuyos valores revisa y aprueba el dueño; `{}` no aprueba ningún descriptor. El empaquetador verifica esos valores y los conserva en `packages/adapter-sdk/dist/descriptor-approvals.json`; no deduce aprobación de los bytes presentes. La invocación anterior con un solo argumento conserva compatibilidad y empaqueta el mapa vacío. El digest global del bundle se aprueba por separado en la política del host.
5. Ejecutar en verde: paridad, corpus de descriptores (unittest y node), los escenarios parametrizados del SDK para el harness nuevo y el roundtrip de adaptadores si el harness participa en él. Para `fake2`, `pnpm exec vitest run tests/e2e/real-qa.test.ts --testTimeout=180000` usa PostgreSQL efímero, gateway y WebSocket reales y escribe `ops/artifacts/real/fake2-roundtrip.json`.

El alta de `fake2` añadió el descriptor y las ediciones de paridad en 14 archivos (`1ff5c418`). Su prueba local verifica el registro durable `qa-reviewer-b=fake2`, la capability WebSocket `harness.fake2`, el descriptor empaquetado idéntico al fuente y una entrega `done` dentro del fan-out con respuesta final correlacionada. El recibo cuenta un adaptador `opencode`, tres `fake` y uno `fake2`; conserva el digest del descriptor, el epoch de lease, la correlación final y la limpieza de procesos y temporales. `fake` y `fake2` son harnesses de prueba: no se ofrecen en la UI ni en las plantillas de producción.

El paquete npm local incluye el descriptor, el bin y la definición de `fake2`. La construcción del bundle de release sigue exigiendo un árbol limpio y la aprobación del digest por el host. La autenticación con cuentas reales de Grok/Muse/OpenClaw y las ejecuciones físicas de `quota` y `update_cli` por descriptor en server2 requieren sus propios recibos; el roundtrip de CLI controlado no acredita esas operaciones.

### Aprobación y adopción por el dueño

El dueño revisa una release concreta y lleva cada valor aprobado a `policy.bundles[<harness>].descriptor_sha256` de la plantilla de enrolamiento y de las políticas executor y authority ya existentes. `HostSetupPackager` conserva esos pins al filtrar harnesses habilitados y los incluye en la firma Ed25519. El instalador conserva el pin al sustituir rutas y comprueba tanto el digest global como cada pin declarado antes de activar el servicio: recalcular solo el digest global no aprueba un descriptor alterado. Las políticas legadas sin pin individual siguen requiriendo su adopción explícita; la compatibilidad de lectura no acredita aprobación por harness.

Store recibe el archivo público aprobado mediante `CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE`; `CAUCE_HARNESS_DESCRIPTOR_DIRECTORY` permite seleccionar el directorio publicado de descriptores. Por defecto resuelve el catálogo SDK desde el layout fuente, el build de core o el paquete desplegado (`packages/adapter-sdk/dist/descriptors`). Cada lectura vuelve a validar los pins y deriva los harnesses con `quota` y argv desde el catálogo; añadir o retirar una operación o aprobación cambia la elegibilidad sin editar SQL. Si falta el archivo de aprobación, el paquete, el pin o el descriptor válido, el lector se retira. El despliegue debe montar o instalar ese archivo público y configurar su ruta; la imagen actual no aporta por sí sola valores aprobados.

Después de actualizar sus políticas, el dueño verifica firma, instalación y capacidades, retira una aprobación en un entorno de prueba y comprueba la retirada de elegibilidad y el rechazo de bytes alterados con digest global recalculado. Debe conservar los pins durante las actualizaciones del controlador y repetir la comprobación tras actualizar. Este procedimiento describe el mecanismo y la operación pendiente: las pruebas locales con fixtures no acreditan adopción de políticas privadas ni ejecución en producción.

### Mapa proveedor ↔ harness

| Harness | Proveedor (binding) | Módulo de flota | Cuota en «Mis cuotas» |
|---|---|---|---|
| `claude` | `claude` | genérico (`CLAUDE_CONFIG_DIR`) | sí |
| `codex` | `codex` | genérico (`CODEX_HOME`) | sí |
| `grok` | `grok` | `fleet_provider_grok` | sí |
| `muse` | `muse` | `fleet_provider_muse` | no |
| `openclaw` | `codex` u `claude` (la cuenta que paga decide; Anthropic sin medir) | `fleet_provider_openclaw` | no |
| `hermes` | `hermes` | genérico | no |
| `opencode` | `opencode` | genérico | no |
| `fake`, `fake2` | ninguno (prueba) | ninguno | no |

Proveedores que no son harness y solo existen para cuotas: `gemini`, `minimax`, `feihoa`.

## Diagnóstico y fronteras de aceptación

Para un conflicto de contexto se releen versión e historial, se preserva el borrador y se reconcilian cambios; para Git pendiente se consulta status y se usa retry, conservando el snapshot durable; para applied pendiente se comprueba director de la empresa, delivery, lease y ACK/witness exactos. Para backup fallido se conserva UUID/error/fence y se investiga placement, política, integridad o límites. No se imprimen contenido sensible, DSN ni sesiones para diagnosticar.

Los recibos, su procedencia y los negativos están en la [matriz local](v4-matriz-local.md). La adopción de contexto por proveedores reales y la aceptación publicada siguen pendientes.

## Exclusión durante el consumo de contexto

El SDK serializa turnos que comparten `CAUCE_SPACE_ROOT` entre sesiones y engines del mismo proceso. Adquiere el espacio después del lock de sesión, materializa el contexto y verifica SHA, ruta y metadatos antes de acreditar adopción. Conserva el lock hasta persistir el resultado; un cambio externo falla sin marcar done ni applied. Este lock no coordina procesos distintos.
