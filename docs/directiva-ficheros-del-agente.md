# Dónde vive el CLAUDE.md, las herramientas y los prompts de cada agente

Los hechos de este documento se **miden dentro del contenedor**, leyendo `/proc/<pid>/cmdline` y
`/proc/<pid>/environ` del proceso del arnés que de verdad corre. Nada se infiere del registro de la
base: donde el registro discrepa de la medición manda la medición, y la respuesta declara cuál de
las dos usó (`facts_source`).

## 1. La respuesta corta

La consola tiene **un único lugar para modificar el contexto de un agente**: la pestaña
**Contexto** de su cajón en «La flota ahora». Allí se editan el perfil canónico y, por separado, el
texto libre del manual efectivo. La pestaña **Ficheros** sólo lista y abre contenido permitido
en modo de lectura; no guarda nada.

La frontera al contenedor ya existe: gateway → terminal-relay → pty-agent. El navegador nunca manda
un path. Envía el alias y el `kind`; el servidor resuelve la ruta desde hechos medidos y la sonda
aplica lectura, CAS, allowlist, límites y ACK.

El soporte se declara sin extrapolar: el perfil canónico por lote tiene proyección para Claude,
Codex y OpenClaw. Hermes puede exponer su manual medido, pero no tiene proyección de perfil por lote.
OpenCode no forma parte del juego de arneses soportado; la consola no le promete edición.

## 2. Dónde resuelve cada arnés sus documentos de gobierno

La **directiva** es el fichero que ese arnés lee de verdad, y la ruta se resuelve desde el entorno
medido del proceso — nunca desde una ruta que mande el navegador. La tabla de rutas es única y la
comparten gateway, adaptador y pty-agent: `DOCUMENTOS_DE_GOBIERNO`, en
`packages/protocol/src/ficheros-del-arnes.ts`.

| arnés | raíz de los documentos de gobierno | documentos |
|---|---|---|
| claude | hecho medido `claudeConfigDir`; por defecto `$HOME/.claude` | `CLAUDE.md` |
| codex | hecho medido `codexHome` (`CODEX_HOME`); por defecto `$HOME/.codex` | `AGENTS.md` |
| hermes | hecho medido `home` | `AGENTS.md` |
| openclaw | hecho medido `openclawWorkspace` | `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `AGENTS.md`, `TOOLS.md` |

Una ruta que el resolutor produce **puede no existir en disco**. Esa ausencia es un hecho del
contenedor, no un fallo del resolutor: el inventario la publica como ausencia y el `PUT` de creación
la trata con precondición de ausencia, en vez de inventar un fichero.

El conjunto de manuales que el proceso aplica de verdad —el nivel global más los niveles de proyecto
que el `projectRoot` avale— lo cierra y lo ordena `effectiveManualPaths`
(`services/gateway/src/console/agent-documents/catalog.ts`). Sin un `projectRoot` avalado se añade
un único nivel exacto desde el `cwd` medido: la jerarquía no se inventa buscando un `.git` ni otro
marcador plausible. Un mismo destino aparece una sola vez, en su primera posición efectiva.

### Configuración efectiva de herramientas y prompts, por arnés

| arnés | herramientas / permisos | prompts | MCP |
|---|---|---|---|
| claude | `<dir>/settings.json` → `permissions.allow` / `.deny` / `.defaultMode` | `<dir>/agents/`, `<dir>/commands/`, `<dir>/skills/` — los que el contenedor tenga; ninguno es obligatorio | `~/.claude.json` → `mcpServers` |
| codex | `<CODEX_HOME>/config.toml` | `<CODEX_HOME>/prompts/` — directorio opcional; el inventario sólo lista lo que hay | dentro del mismo `config.toml` |
| openclaw | `~/.openclaw/openclaw.json` → `tools`, `skills` | mismo fichero → `commands`, `agents` | mismo fichero → `mcp.servers` |

El campo `tools` de **Contexto** es una declaración para orientar al agente y Cauce puede
materializarla dentro de su perfil. **No concede acceso**: no habilita binarios, no configura MCP y
no sustituye los permisos del arnés. Las capacidades acreditadas salen del runtime; la autorización
de Cauce sale de membresías, `role_policies`, ACL y RBAC. En particular, el adaptador de Claude
arranca con `baseArgs: ["--print","--output-format","json"]` y no traduce esa lista declarada a
`--allowedTools`, `--permission-mode` ni `--mcp-config`.

## 3. Por qué el resolutor no confía en las columnas del registro

`agents.harness_id` puede no coincidir con el binario en ejecución, y `agents.home_directory` y
`agents.container_name` pueden nombrar un `$HOME` o un contenedor que el proceso vivo ya no usa: son
intención declarada, no medición. Un editor que resolviera la ruta por esas columnas abriría un
fichero que ese agente **no lee**, y al guardar escribiría ahí sin dar un solo error.

**La respuesta correcta ya viaja por el cable.** `GET /v3/status` → `presence[].capabilities` lleva
`harness.claude` / `harness.codex` / `harness.openclaw` / `harness.hermes`
(`harnessFromCapabilities`), y el `cmdline` medido lo confirma por separado
(`harnessFromCommand`). Por eso el resolutor prioriza hechos del runtime y no habilita escritura a
partir de `agents.harness_id`; cuando no hubo medición, `facts_source` lo declara.

## 4. Lo que hay que mirar antes de escribir nada

1. **`openclaw.json` lleva `auth` y `secrets`** en el mismo documento que `tools`, `skills`, `mcp`
   y `commands`. Servirlo entero a un navegador es una fuga. Hay que proyectar campo a campo.
2. **`~/.claude.json` lleva el OAuth de la cuenta y el historial de todos sus proyectos** junto a
   `mcpServers`. Igual.
3. **`~/.claude/settings.json` lleva `hooks`**, que son órdenes de shell que el arnés ejecuta solo.
   Editarlo desde la web sería **ejecución de código dentro del contenedor**, aunque no lo parezca;
   por eso permanece en el inventario pero fuera de la escritura web.
4. **Un `config.toml` mal formado deja a codex sin arrancar.** De sólo lectura hasta que haya
   validación previa.
5. **Hay bind-mounts de UN SOLO FICHERO.** `~/.claude.json` suele serlo, y un `.credentials.json`
   puede venir montado fichero a fichero **dentro** de un `.claude` que por lo demás es propio del
   contenedor. Escribir con «temporal + rename» sobre un bind-mount de fichero **rompe el montaje**;
   hay que truncar y escribir en sitio.

   **Los dos escritores del contexto no tienen la misma semántica.**

   - **El adaptador** (`packages/adapter-sdk/src/context/siembra-del-perfil.ts`,
     `reemplazarContenido`) escribe **en sitio**: `ftruncate(0)` + `write` + `fsync` sobre el
     descriptor ya validado. Conserva el inodo, así que respeta un bind-mount de fichero, pero
     trunca **antes** de escribir: un corte a mitad deja el documento medio escrito. No mira el
     destino: siempre hace lo mismo.
   - **El pty-agent** (`ops/pty-agent/cauce_pty_agent/governance_write.py`) stagea un temporal y
     lo publica con `os.replace` (atómico, pero **sustituye el inodo**); el `create` va por
     `os.link`, que falla con `EEXIST` y por eso nunca pisa una creación que ganó la carrera.
     En la escritura **de un solo fichero** ya elige por destino: si detecta un punto de montaje
     conmuta a `_commit_in_place` (escribe y luego trunca, y restaura los bytes previos si algo
     falla). El **lote** del perfil, en cambio, **rechaza** un destino bind-mounted con
     `GovernanceBindMountError`, porque su rollback es un hardlink al inodo original y sobre un
     montaje no hay inodo que enlazar.

   La brecha es **latente**: los dos nombres que este documento cita (`~/.claude.json` y
   `.credentials.json`) están en `GOVERNANCE_NEVER_SERVE_BASENAMES` y fuera del conjunto escribible,
   así que ninguna escritura gobernada llega a ellos. Deja de ser latente en cuanto el conjunto
   escribible crezca.
   **W5-O1** lleva la elección de semántica por destino al escritor que todavía no la tiene —el
   adaptador—, para que sea el destino, y no qué escritor tocó, quien decida entre atomicidad e
   inodo preservado.
6. **Dos alias pueden compartir el mismo directorio de contexto**: porque dos contenedores montan
   el MISMO directorio de configuración del arnés, o porque un contenedor aloja dos alias con un
   solo `$HOME`. Ahí escribir «el `CLAUDE.md` de un alias» cambia el del otro: no hay dos ficheros,
   hay uno con dos dueños declarados. Un despliegue así puede no chocar por casualidad —dos arneses
   distintos leen nombres distintos— y deja de no chocar en cuanto los dos usen el mismo arnés. Eso
   es coincidencia de configuración, no un control; el control es la guardia de contaminación
   (`adr/008-guardia-de-contaminacion-de-contexto.md`).
7. **Un contenedor puede no tener el directorio del arnés en bind.** Lo que se escriba ahí vive en
   la capa escribible del contenedor y **desaparece al recrearlo**.
8. **Un arnés puede no correr en docker.** Host-native, bajo su propio usuario del sistema: desde
   otra cuenta ni siquiera se le puede leer `/proc/<pid>/environ`. Y los contenedores de una flota
   pueden estar repartidos entre varios demonios docker, en hosts distintos.

## 5. Lo que ya funciona y no hace falta reconstruir

- `GET|PUT /v3/console/tenants/:tenantId/agents/:alias/perfil` lee y sustituye con revisión esperada
  el perfil canónico durable; su aplicación al runtime es un lote con evidencia por fichero.
- `GET /v3/console/tenants/:tenantId/agents/:alias/documents` publica el inventario derivado de
  hechos medidos. `GET .../documents/:kind/content` sirve sólo contenido allowlisted y
  `PUT .../documents/directive/content` modifica únicamente el manual efectivo con
  `expected_sha` o precondición de ausencia.
- `GET /v3/console/terminal/targets` publica autorización y estado PTY por alias; su disponibilidad
  es estado vivo y se verifica en cada operación, no se fija como un conteo en esta guía.
- Las concesiones del PTY son por `(operador, tenant, alias, modo)` y fallan cerradas: si el fichero
  de concesiones no se puede leer, **cero** concesiones. Y todo pasa por `recordTerminalAudit`,
  que audita igual el permiso que la denegación.

`agents.role_brief` no es otra fuente editable: es una proyección diagnóstica de sólo lectura. La
fuente canónica es `agent_profiles.role_summary` y se modifica en **Contexto** mediante el PUT de
perfil. Ajustes rechaza localmente cualquier mutación JSON de `agents.role_brief`.

El PUT manual tampoco es un atajo al perfil. Conserva los bloques delimitados por los marcadores
reservados `CAUCE:CONTEXTO-FIJO`, `CAUCE:PERFIL` y `CAUCE:REVISION-PERFIL`, y rechaza modificaciones,
supresiones, topologías inválidas o marcadores `CAUCE` nuevos. Un marcador de una versión futura
bloquea la escritura hasta actualizar el gateway. Sólo cambia el texto libre exterior y conserva
CRLF cuando ése es el estilo completo del fichero leído.

## 6. La vía implementada

El canal gobernado usa capacidades negociadas del pty-agent (`read_governance`,
`write_governance_v1` y `write_governance_batch_v1`) a través de terminal-relay. No abre el socket
Docker en el gateway ni reutiliza una shell interactiva como API de ficheros.

Por qué cubre la topología real:

- El pty-agent **ya corre junto al agente, como el usuario del agente**: dentro de cada contenedor,
  cualquiera que sea el demonio docker que lo lleve, **y** también donde el arnés corre host-native.
  Ninguna otra vía cubre las tres cosas: el gateway con el socket de docker local no llega a un
  arnés host-native ni a un demonio docker de otro host.
- El control de acceso y la atribución del destino se resuelven antes de llegar al canal de
  gobernanza; lectura y escritura exigen permisos distintos y fallan cerradas.
- La autorización de **este** canal son **seis** puertas, y no son las del PTY:
  `requireOperatorPermission(actor, 'control')` para escribir (`'read'` para leer),
  `authorizeAgentTarget` con tenant y alias exactos, el `enabled` del registro, hechos **medidos**
  dentro del contenedor, la política de rutas (`verifyReadableDocument` / `verifyWritablePath`) y
  el CAS con relectura previa. **No** usa concesión en fichero, **no** exige un pty vivo y **no**
  tiene control de concurrencia: ésas son puertas del plano PTY y afirmar que las comparte era
  falso. La auditoría sí escribe permisos y denegaciones.
- Es estrictamente menos que una shell: sólo admite operaciones tipadas sobre un juego cerrado de
  rutas derivadas de hechos medidos.

Reglas que la vía cumple, y por qué:

1. **El navegador manda un `kind`, nunca un `path`.** La ruta la deriva el servidor de hechos
   medidos (`services/gateway/src/console/agent-documents.ts`). Un `path` que venga del navegador
   es un directorio transversal esperando a ocurrir.
2. **Los hechos los mide el pty-agent**, leyendo el `cmdline` y el `environ` del proceso del arnés.
   Ni la columna de la BD (que puede discrepar del proceso vivo) ni el bundle del propio agente
   (que es configuración).
3. **Denegación por nombre base y por ruta canónica**: `.credentials.json`, `auth.json`,
   `.claude.json`, `openclaw.json`, `.env`, `.netrc`, claves ssh, `*.pem`, `*.key`. Y si el
   `realpath` no es igual a la ruta pedida, se rechaza: eso es un symlink.
4. **CAS y relectura verificable**: reemplazo con SHA esperado o creación con precondición de
   ausencia; el ACK acredita SHA y bytes y el perfil por lote relee todos los destinos.
5. **Un solo tope en la escritura**: el genérico de 256 KiB (`MAX_DOCUMENT_BYTES`), y sólo texto
   UTF-8 válido. El `project_doc_max_bytes` medido de codex **no** se aplica aquí, y decir que sí
   sería falso para el fichero que este canal escribe: topa el AGREGADO de los manuales de ámbito
   **workspace** (`effectiveManualPaths` → `scope: 'workspace'`, que es como lo aplica el lector en
   `agent-directive.routes.ts`), mientras que el `kind` `directive` de codex resuelve a
   `$CODEX_HOME/AGENTS.md`, de ámbito **usuario**, que el proceso aplica entero. Toparlo aquí
   rechazaba con un 413 una escritura legítima. El lector sí muestra el tope medido donde rige.
6. **Todo auditado** con el mismo `recordTerminalAudit` que el plano PTY, sobre la misma tabla
   `audit_events`: `agent_document.read` en la lectura de contenido real, `agent_document.write` en
   el PUT que escribe y `agent_document.denied` en cada denegación por estado de **los dos
   canales** — el `channel` de la fila dice cuál —: destino que no se ve (la sonda de enumeración
   de alias), hechos sin medir, ruta prohibida, documento inexistente, respuesta de sonda que no
   acredita, sin canal, conflicto de CAS, bloque gestionado, tope excedido y alias apagado. La
   lectura deniega tanto como la escritura, y son sus denegaciones las que produce un barrido a
   por credenciales: sin fila, ese barrido no dejaría rastro ninguno.
   El inventario que sí se resuelve no se audita: la vista Ficheros lo relee cada vez que se abre
   el cajón. La fila lleva `operator_id` del principal autenticado, `target_tenant`, `target_alias`,
   `channel`, `kind`, `path`, `sha_before`, `sha_after`, `bytes`, `harness_id`, `home_directory` y
   `facts_source`, y **jamás el cuerpo ni un byte de él**. `harness_id` y `home_directory` son los
   **medidos** cuando hubo medición —son los que resolvieron la ruta—, y sólo caen a las columnas
   del registro cuando no la hubo, que es lo que declara `facts_source`.

   Tres límites de esa fila, dichos aquí para que nadie los descubra buscándola:

   - **Una petición que ni siquiera autentica no deja fila**: sin principal no hay `tenant_id` al
     que atribuirla, y una fila con un tenant inventado sería peor que ninguna. Eso lo registra la
     capa de autenticación, no este canal.
   - **La fila se ve donde vive el actor, no donde vive el fichero.** `/v3/console/audit` filtra
     por `audit.tenant_id` y `audit.actor_alias` (`packages/store/src/repository/observability.ts`),
     y la fila se inserta con la identidad del **actor**: el tenant cuyo manual efectivo se
     reescribió desde fuera no la ve. Es el modelo heredado del plano PTY, no algo que introduzca
     este canal, pero la puerta cross-tenant deja rastro **para quien lo dejó**.
   - **La fila se escribe después de la mutación del disco.** Si el `INSERT` falla, el cliente
     recibe 500 con el fichero ya reescrito: cerrado en la respuesta, abierto en el rastro.
7. **El PUT no dice `applied`.** Responde 202 con
   `state: 'written_pending_session'` y `evidence: 'probe_write_ack'`: un ACK de escritura acredita
   bytes en disco, no que el proceso releyera el fichero. El vocabulario de los dos canales de
   contexto (perfil y manual) vive en `services/gateway/src/console/context-apply-policy.ts`, donde
   sólo `applied` afirma que la sesión recargó, y sólo con el ACK de adopción de la sesión.
   La consola trata ese 202 como lo que es —**un guardado**—: limpia el borrador, refresca la
   huella servida (si no, el reintento evidente chocaría contra un SHA que ya no existe) y avisa
   con esas palabras, «escrito; la sesión lo aplica al recargar», en vez de pintar en rojo una
   escritura que sí ocurrió.

## 7. Piezas del código actual

- `services/gateway/src/console/agent-documents/` — catálogo, política de rutas y sonda del relay.
- `services/gateway/src/console/agent-documents.routes.ts` — inventario y contenido gobernado por
  tenant+alias; no sirve configuraciones sensibles ni escribe sin hechos medidos.
- `services/gateway/src/console/agent-profile.routes.ts` y `agent-profile-runtime.ts` — perfil
  canónico durable, proyección nativa, lote cercado y acreditación de adopción.
- `services/gateway/src/console/context-apply-policy.ts` — vocabulario único de aplicación de
  contexto para los dos canales; `services/gateway/src/terminal/audit.ts` — el único insertador de
  `audit_events` de este plano, compartido con el PTY.
- `console/src/features/live/` — una vista **Contexto** para las mutaciones y **Ficheros** como visor.

Las rutas de documentos y perfil están registradas en `services/gateway/src/routes/console.ts`.
