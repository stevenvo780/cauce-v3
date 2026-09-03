# Dónde vive el CLAUDE.md, las herramientas y los prompts de cada agente

Medido el **23-ago-2026** dentro de los contenedores, leyendo `/proc/<pid>/cmdline` y
`/proc/<pid>/environ` del proceso del arnés que de verdad corría. No hay nada inferido del
registro: donde el registro dice otra cosa, se dice cuál de las dos es.

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

## 2. El mapa medido, alias por alias

`DIRECTIVA` es el fichero que ese arnés lee de verdad, resuelto desde el entorno del proceso.
El tamaño se comprobó **después**, yendo a mirar el fichero por la ruta que produce el resolutor
(21 de 27 rutas existen; las 6 ausentes son ausencias reales, no fallos del resolutor).

| alias | contenedor | arnés REAL | `agents.harness_id` | directiva | tamaño |
|---|---|---|---|---|---|
| zeus | ws-zeus | claude | claude | `/home/dev/.claude/CLAUDE.md` | 10.733 |
| socrates | ws-prizma | codex | codex | `/home/dev/.codex/AGENTS.md` | 12.942 |
| atlas | ws-humanizar | codex | codex | `/home/dev/.codex/cuenta-b/AGENTS.md` | 12.942 |
| kratos | ws-humanizar | **claude** | codex ✗ | `/home/dev/.claude/CLAUDE.md` | 8.339 |
| jarvis | claw | openclaw | openclaw | `~/.openclaw/openclaw.json` → `agents` | 23.778 |
| argos | ctrl-infra | **openclaw** | hermes ✗ | `~/.openclaw/openclaw.json` → `agents` | 7.368 |
| iza | claw-iza | openclaw | openclaw | `~/.openclaw/openclaw.json` → `agents` | 18.775 |
| janus | claw-miguel | openclaw | openclaw | `~/.openclaw/openclaw.json` → `agents` | 19.463 |
| hegel | agv2-jhon-hegel-oc | openclaw | openclaw | `~/.openclaw/openclaw.json` → `agents` | 12.322 |
| heraclito | agv2-jhon-heraclito-oc | **claude** | openclaw ✗ | `/home/claw/.claude/CLAUDE.md` | **NO EXISTE** |
| tales | agv2-jhon-tales-oc | codex | codex | `/home/claw/.codex/AGENTS.md` | **NO EXISTE** |
| gaia | agv2-miguel-finca-oc | openclaw | openclaw | `~/.openclaw/openclaw.json` → `agents` | 1.143 |
| salva | ws-isa (kratos) | **claude** | codex ✗ | `/home/dev/.claude/CLAUDE.md` | 9.201 |
| kant | host:kratos (sin docker) | **claude** | codex ✗ | `/home/stev/.claude/CLAUDE.md` | 6.563 |

### Configuración efectiva de herramientas y prompts, por arnés

| arnés | herramientas / permisos | prompts | MCP |
|---|---|---|---|
| claude | `<dir>/settings.json` → `permissions.allow` / `.deny` / `.defaultMode` | `<dir>/agents/` (10 en zeus y ws-humanizar), `<dir>/commands/` (no existe en ninguno), `<dir>/skills/` (no existe en ninguno) | `~/.claude.json` → `mcpServers` |
| codex | `<CODEX_HOME>/config.toml` (307–326 líneas) | `<CODEX_HOME>/prompts/` — **no existe en ningún alias** | dentro del mismo `config.toml` |
| openclaw | `~/.openclaw/openclaw.json` → `tools`, `skills` | mismo fichero → `commands`, `agents` | mismo fichero → `mcp.servers` |

El campo `tools` de **Contexto** es una declaración para orientar al agente y Cauce puede
materializarla dentro de su perfil. **No concede acceso**: no habilita binarios, no configura MCP y
no sustituye los permisos del arnés. Las capacidades acreditadas salen del runtime; la autorización
de Cauce sale de membresías, `role_policies`, ACL y RBAC. En particular, el adaptador de Claude
arranca con `baseArgs: ["--print","--output-format","json"]` y no traduce esa lista declarada a
`--allowedTools`, `--permission-mode` ni `--mcp-config`.

## 3. Los cinco alias en los que el registro miente

`agents.harness_id` no coincide con el binario en ejecución en **5 de 14**: kratos, argos,
heraclito, salva y kant. Un editor que resuelva la ruta por esa columna le enseñaría a Steven un
fichero que ese agente **no lee**, y al guardar escribiría ahí sin dar un solo error.

`agents.home_directory` también miente: dice `/home/dev` para **iza**, que corre con
`HOME=/home/claw` en `claw-iza`. Y `agents.container_name` dice `ws-humanizar` para iza, que corre
en `claw-iza`.

**La respuesta correcta ya viaja por el cable.** En aquella medición, `GET /v3/status` →
`presence[].capabilities` lleva `harness.claude` / `harness.codex` / `harness.openclaw`, y coincidió
con el binario medido en **14 de 14**. Por eso el resolutor actual prioriza hechos del runtime y no
habilita escritura a partir de `agents.harness_id`.

## 4. Lo que hay que mirar antes de escribir nada

1. **`openclaw.json` lleva `auth` y `secrets`** en el mismo documento que `tools`, `skills`, `mcp`
   y `commands`. Servirlo entero a un navegador es una fuga. Hay que proyectar campo a campo.
2. **`~/.claude.json` lleva el OAuth y 34 historiales de proyecto** junto a `mcpServers`. Igual.
3. **`~/.claude/settings.json` lleva `hooks`**, que son órdenes de shell que el arnés ejecuta solo.
   Editarlo desde la web sería **ejecución de código dentro del contenedor**, aunque no lo parezca;
   por eso permanece en el inventario pero fuera de la escritura web.
4. **Un `config.toml` mal formado deja a codex sin arrancar.** De sólo lectura hasta que haya
   validación previa.
5. **Hay bind-mounts de UN SOLO FICHERO.** `~/.claude.json` lo es en casi todos, y en `ctrl-infra`
   el `.credentials.json` es un bind-mount de fichero metido **dentro** de un `.claude` que por lo
   demás es propio. Escribir con «temporal + rename» sobre un bind-mount de fichero **rompe el
   montaje**; hay que truncar y escribir en sitio.

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

   Hoy la brecha es **latente, no medida**: los dos únicos bind-mounts de fichero que este
   documento nombra (`~/.claude.json` y `.credentials.json`) están en
   `GOVERNANCE_NEVER_SERVE_BASENAMES` y fuera del conjunto escribible, así que ninguna escritura
   gobernada llega a ellos. Deja de ser latente en cuanto el conjunto escribible crezca.
   **W5-O1** lleva la elección de semántica por destino al escritor que todavía no la tiene —el
   adaptador—, para que sea el destino, y no qué escritor tocó, quien decida entre atomicidad e
   inodo preservado.
6. **`ws-isa` y `ws-isa-workspace` (los dos en kratos) montan el MISMO
   `/datos/agents/isa-config/.claude`.** Ahí editar «el CLAUDE.md de un alias» cambia el del otro.
   `ws-humanizar` aloja **dos** alias (atlas y kratos) con un solo `$HOME`: hoy no chocan sólo
   porque usan arneses distintos, y dejarían de no chocar en cuanto los dos fueran claude.
7. **`agv2-jhon-heraclito-oc` no tiene `~/.claude` en bind.** Lo que se escriba ahí vive en la capa
   escribible del contenedor y **desaparece al recrearlo**.
8. **`kant` no es docker.** Corre host-native en kratos como el usuario `stev`. Desde otra cuenta
   ni siquiera se le puede leer `/proc/<pid>/environ`. Y los contenedores están repartidos entre
   **dos demonios docker distintos** (el del VPS y el de kratos).

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

- El pty-agent **ya corre dentro de cada contenedor, como el usuario del agente**, en los dos
  demonios docker **y** en el `kant` host-native. Ninguna otra vía cubre las tres cosas: el gateway
  con el socket de docker no llega a kant ni al docker de kratos.
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
   Ni la columna de la BD (5 de 14 mal) ni el bundle del propio agente (que es configuración).
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
