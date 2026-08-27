# Dónde vive el CLAUDE.md, las herramientas y los prompts de cada agente

Medido el **23-ago-2026** dentro de los contenedores, leyendo `/proc/<pid>/cmdline` y
`/proc/<pid>/environ` del proceso del arnés que de verdad corría. No hay nada inferido del
registro: donde el registro dice otra cosa, se dice cuál de las dos es.

## 1. La respuesta corta

**No existe hoy ninguna vía para leer ni escribir un fichero dentro del contenedor de un agente
desde la consola.** Lo único que atraviesa esa frontera es el **PTY interactivo** del
terminal-relay, que da una shell entera y no un API de ficheros. La vía más pequeña que sirve está
en el §6.

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

### Herramientas y prompts, por arnés

| arnés | herramientas / permisos | prompts | MCP |
|---|---|---|---|
| claude | `<dir>/settings.json` → `permissions.allow` / `.deny` / `.defaultMode` | `<dir>/agents/` (10 en zeus y ws-humanizar), `<dir>/commands/` (no existe en ninguno), `<dir>/skills/` (no existe en ninguno) | `~/.claude.json` → `mcpServers` |
| codex | `<CODEX_HOME>/config.toml` (307–326 líneas) | `<CODEX_HOME>/prompts/` — **no existe en ningún alias** | dentro del mismo `config.toml` |
| openclaw | `~/.openclaw/openclaw.json` → `tools`, `skills` | mismo fichero → `commands`, `agents` | mismo fichero → `mcp.servers` |

**Cauce no gobierna ninguna herramienta.** El adaptador de claude arranca con
`baseArgs: ["--print","--output-format","json"]` y nada más: ni `--allowedTools`, ni
`--permission-mode`, ni `--mcp-config`. Lo que un agente puede usar sale **entero** de esos
ficheros del contenedor, nunca de la base.

## 3. Los cinco alias en los que el registro miente

`agents.harness_id` no coincide con el binario en ejecución en **5 de 14**: kratos, argos,
heraclito, salva y kant. Un editor que resuelva la ruta por esa columna le enseñaría a Steven un
fichero que ese agente **no lee**, y al guardar escribiría ahí sin dar un solo error.

`agents.home_directory` también miente: dice `/home/dev` para **iza**, que corre con
`HOME=/home/claw` en `claw-iza`. Y `agents.container_name` dice `ws-humanizar` para iza, que corre
en `claw-iza`.

**La respuesta correcta ya viaja por el cable.** `GET /v3/status` →
`presence[].capabilities` lleva `harness.claude` / `harness.codex` / `harness.openclaw`, y coincidió
con el binario medido en **14 de 14**. La página «La flota ahora» no la usa: pinta la columna, y por
eso muestra `iza (hermes @ ws-humanizar)` y `argos (hermes @ ctrl-infra)`.

## 4. Lo que hay que mirar antes de escribir nada

1. **`openclaw.json` lleva `auth` y `secrets`** en el mismo documento que `tools`, `skills`, `mcp`
   y `commands`. Servirlo entero a un navegador es una fuga. Hay que proyectar campo a campo.
2. **`~/.claude.json` lleva el OAuth y 34 historiales de proyecto** junto a `mcpServers`. Igual.
3. **`~/.claude/settings.json` lleva `hooks`**, que son órdenes de shell que el arnés ejecuta solo.
   Editarlo desde la web **es ejecución de código dentro del contenedor**, aunque no lo parezca.
   No lo prohibimos —es lo que Steven pidió— pero el aviso tiene que salir **antes** de guardar.
4. **Un `config.toml` mal formado deja a codex sin arrancar.** De sólo lectura hasta que haya
   validación previa.
5. **Hay bind-mounts de UN SOLO FICHERO.** `~/.claude.json` lo es en casi todos, y en `ctrl-infra`
   el `.credentials.json` es un bind-mount de fichero metido **dentro** de un `.claude` que por lo
   demás es propio. Escribir con «temporal + rename» sobre un bind-mount de fichero **rompe el
   montaje**; hay que truncar y escribir en sitio.
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

- `GET /v3/console/role-templates` (desplegado) devuelve `revision`, `templates` (hoy **0**) y las
  **14 asignaciones con su `role_brief` entero**. La capa 1 se puede LEER ya.
- `GET /v3/console/terminal/targets` devuelve `authorized: true` y `pty_state: online` para **13 de
  14** alias (sólo gaia falta, «sin autoridad»). El pty-agent está vivo en toda la flota.
- Las concesiones del PTY son por `(operador, tenant, alias, modo)` y fallan cerradas: si el fichero
  de concesiones no se puede leer, **cero** concesiones. Y todo pasa por `recordTerminalAudit`,
  que audita igual el permiso que la denegación.

Lo que **no** existe: ninguna ruta desplegada escribe el `role_brief` de un alias.
`PATCH /v3/console/role-templates/:slug` rechaza `role_brief` como clave desconocida, y
`PATCH /v3/console/agents/:alias`, `PUT …/directive` y `POST …/role-brief` dan 404.

## 6. La vía más pequeña que sirve

**Un modo nuevo del pty-agent, `document`, junto a `shell` y `harness`.** No un API de ficheros
nuevo, no docker socket en el gateway.

Por qué es la más pequeña:

- El pty-agent **ya corre dentro de cada contenedor, como el usuario del agente**, en los dos
  demonios docker **y** en el `kant` host-native. Ninguna otra vía cubre las tres cosas: el gateway
  con el socket de docker no llega a kant ni al docker de kratos.
- El control de acceso **ya existe y es por modo**: `grants.allowsCohort(operador, alias, modo)`.
  Un `document` se concede o se niega **sin tocar** el `shell` que alguien ya tenga.
- La autorización **ya son 7 puertas** (rol, permiso en BD, atribución a un humano con nombre,
  autoridad de ruteo sobre toda la cohorte del contenedor, concesión en fichero, pty vivo,
  concurrencia) y la auditoría ya escribe permisos y denegaciones.
- Es **estrictamente menos** de lo que ya está abierto: quien tiene `shell` ya puede escribir
  cualquier fichero. `document` es un `shell` recortado a un juego cerrado de rutas.

Reglas que la vía tiene que cumplir, y por qué:

1. **El navegador manda un `kind`, nunca un `path`.** La ruta la deriva el servidor de hechos
   medidos (`services/gateway/src/console/agent-documents.ts`). Un `path` que venga del navegador
   es un directorio transversal esperando a ocurrir.
2. **Los hechos los mide el pty-agent**, leyendo el `cmdline` y el `environ` del proceso del arnés.
   Ni la columna de la BD (5 de 14 mal) ni el bundle del propio agente (que es configuración).
3. **Lista negra por nombre base y por `realpath`**: `.credentials.json`, `auth.json`,
   `.claude.json`, `openclaw.json`, `.env`, `.netrc`, claves ssh, `*.pem`, `*.key`. Y si el
   `realpath` no es igual a la ruta pedida, se rechaza: eso es un symlink.
4. **Escritura en sitio, nunca «temporal + rename»** (§4.5), con respaldo previo y verificación por
   relectura y sha256.
5. **Tope de 256 KB** y sólo texto UTF-8 válido.
6. **Todo auditado** con el mismo `recordTerminalAudit`, incluida la denegación.

## 7. Qué hay en esta rama

- `services/gateway/src/console/agent-documents.ts` — el resolutor y la puerta de escritura.
- `services/gateway/src/console/agent-documents.routes.ts` — `GET /v3/console/agents/:alias/documents`,
  **sólo lectura y ni siquiera del contenido**: el mapa de qué fichero es cada cosa y dónde vive.
  Cada respuesta dice de dónde salen los hechos (`measured` / `presence` / `database`) y **nada sale
  como editable si no están medidos**.
- Los dos ficheros de test, 23 casos, con los controles negativos del §4.

**Sí está enganchado**: `services/gateway/src/app.ts:41` lo importa y `:1483` lo registra dentro del bootstrap de consola.
