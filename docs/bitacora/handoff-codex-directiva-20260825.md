# Traspaso a codex — el editor de perfiles de agente (modal «Directiva»)

zeus, 2026-08-25. Steven pasa este trabajo a codex. Esto es todo lo que hace falta para seguir sin
volver a descubrirlo. **Todo está mergeado en `main`** (`9862d1f`), en los cuatro remotos:
`origin`, `kratos`, `vpstn` y `respaldo`.

---

## 1. Lo que Steven pide, con sus palabras

> «faltaría botón para crear el archivo correspondiente para poder llenarlo […] el contexto
> inyectado entre mensajes es solo para lo que cambia entre turnos, los demás para lo dijo mueve en
> cada agente y crea en todos sus archivos claude, agent, etc donde esté mejor el perfil de cada
> agente, y los inyectados, que es la capa 1, solamente tienen lo que cambia entre sesiones»

En claro, y es el modelo que hay que respetar:

- **Capa 1 (`agents.role_brief`, va en CADA entrega)** → SÓLO lo que cambia entre turnos. Tope
  1200 caracteres. Hoy funciona y se edita.
- **Capa 2 (los ficheros del propio agente: `CLAUDE.md`, `AGENTS.md`, `SOUL.md`…)** → el perfil
  estable. **Vive dentro del contenedor de cada alias**, en el fichero que su arnés lee de verdad.
- **Lo que falta: poder CREARLO y RELLENARLO desde la consola**, para todos los alias.

---

## 2. Lo que YA funciona (desplegado y medido hoy)

La **lectura** de gobierno, de punta a punta: consola → gateway → terminal-relay → pty-agent.

Medido en producción: `HTTP 200` con el fichero real — `zeus` 10.733 B, `socrates` 8.179 B,
`jarvis` 2.057 B, `janus` 2.057 B (tenant Miguel).

Estaban rotos **siete** eslabones, no uno; por eso pareció imposible durante días. El detalle está
en `ops/runbooks/directiva-lectura-de-gobierno-20260825.md`. Los dos últimos, que son los que más
cuesta ver:

- `terminal/plugin.ts` construía sus hechos con `{ factsFor: async () => undefined }`. Sin hechos
  no hay `home`, sin `home` no hay ruta, y el modal decía «contenedor sin identificar» **con toda
  la cadena funcionando por debajo**. Ahora sale del registro vivo: `terminal/hechos-del-registro.ts`.
- El pty-agent sabía su `HOME` y no lo publicaba; y cuando empezó a publicarlo, **el relay lo
  tiraba**: `AgentLeg.presence()` compone su objeto campo a campo. Hay que tocar los tres sitios:
  `AgentHello`, `parseAgentHello` y `presence()`.

En los tres, `home` es **opcional**. No lo hagas obligatorio: un pty-agent anterior se quedaría sin
saludo y la flota entera aparecería como `not_installed` en la consola durante el despliegue.

---

## 3. Lo que FALTA — la escritura. No existe nada.

**Hoy no hay ningún camino de escritura en toda la cadena.** El pty-agent sólo anuncia
`read_governance`. No hay `TAG_WRITE`, ni ruta en el relay, ni `PUT` en el gateway, ni botón.

Es **simétrico a la lectura**, y ahí está la buena noticia: la lectura ya resolvió lo difícil.

### 3.1 pty-agent — `ops/pty-agent/cauce_pty_agent.py`

- Tags nuevos junto a los de lectura (`TAG_READ = 0x50` … `TAG_READ_DATA = 0x53`).
- `FEATURES = ("read_governance", "write_governance")`. **Es lo que gatea todo**: el relay no manda
  un tag que el agente no anuncie, porque `_dispatch` trata un tag desconocido como violación de
  protocolo y **se tira la conexión encima, con todas sus terminales abiertas**.
- La validación se reutiliza casi entera de `_validate_read_path` (líneas ~760-812): forma
  canónica, lista blanca de nombres base, `NEVER_SERVE`, contención dentro del `home`, y
  `realpath` para cazar un directorio padre enlazado. **Una diferencia:** al crear, `not_found`
  deja de ser error y lo que hay que contener y validar es el **directorio padre**.
- **Escribir EN EL SITIO, nunca por `rename`.** El home del agente puede ser un bind-mount y un
  `rename` le cambia el dueño al fichero. Esto ya nos costó una caída del puente
  (`memoria: escritura-atomica-sobre-un-bind-mount-rompe-el-duenno`).
- Tope de tamaño y rechazo de bytes nulos, igual que en lectura.

### 3.2 terminal-relay — `services/terminal-relay/src/governance-relay.ts`

`POST /v3/terminal/relay/write`, calcado de `GOVERNANCE_READ_PATH`. Ojo con el contrato: los campos
son **`snake_case`** (`tenant_id`, `alias`, `path`) — el `tenantId` en camelCase da
`400 tenant_id es obligatorio`, y perdí un rato ahí.

### 3.3 gateway

`PUT /v3/console/agents/:tenant/:alias/directive` junto al `GET` de
`console/agent-directive.routes.ts`. Permiso de **escritura** de operador, no de lectura.

### 3.4 consola

Botón «Crear» cuando el fichero no existe, y «Guardar» cuando existe. La pieza de composición ya
está escrita y **probada**: `packages/protocol/src/ficheros-del-arnes.ts` genera el texto exacto de
cada fichero por arnés, con marcas de bloque gestionado para no pisar lo que escribió una persona.
`apps/console/src/features/live/PerfilTab.tsx` es el editor de los siete campos.

### 3.5 La otra mitad: que se cree en TODOS los agentes

`packages/adapter-sdk/src/context/siembra-del-perfil.ts` ya lo hace: el adaptador materializa el
perfil en el disco de su propio contenedor. **Está apagado** — se enciende con
`CAUCE_SEMBRAR_PERFIL=1`. Nunca lanza y jamás rompe un turno.

Las dos mitades se complementan: el **botón** crea el fichero ahora en el alias que estás mirando;
la **siembra** lo mantiene en todos los demás en su siguiente turno.

---

## 4. Cómo se despliega esto (no es obvio y quema tiempo)

Producción está en el VPS `vpstn`. **La imagen no sale de `CAUCE_RUNTIME_IMAGE`**: hay un override
por servicio en `/etc/cauce-v3/compose-overrides/`.

- El override vivo es `directiva-20260825.yaml`. Ahí está escrito el porqué de cada línea y la
  reversa exacta.
- **Imagen COMPLETA, nunca cirugía.** Copiar `.js` sueltos dentro de la imagen viva ya tumbó el
  gateway una vez (`authority.js` no exportaba `FLEET_PLACEMENTS`): dos versiones no son
  intercambiables fichero a fichero.
- Construir: `docker build -f deploy/Dockerfile --target runtime -t <tag> .` — **`--target runtime`
  es obligatorio**; sin él te llevas la última etapa, que es el nginx de la consola (79 MB en vez
  de 313 MB), y descubrirlo cuesta un rato.
- Gateway y relay se despliegan **juntos**: las dos patas de la lectura.
- El gateway habla con el relay con un certificado de **cliente** propio,
  `/etc/cauce-v3/pki/gateway-client.{crt,key}` (`CN=gateway-client`, EKU `clientAuth`), emitido el
  2026-08-25. El de servidor NO sirve: el relay lo rechaza en el saludo TLS y el error parece de
  red o de CN, y no lo es. **Dueño `1000:1000`**, o el gateway entra en bucle con `EACCES`.

### El pty-agent va aparte, y tiene trampa

Los units son `cauce-v3-pty@<alias>.service` (usuario `stev`, `XDG_RUNTIME_DIR=/run/user/1000`).
Leen el symlink `~stev/.local/share/cauce-v3/ops` → `releases/ops-pty-*`. **`~stev/pty-kit` NO es
el que corre**; me costó un despliegue entero.

Publicar = copiar a una release nueva y girar el symlink. Y **reiniciar el unit deja un huérfano
dentro del contenedor**, con el nuevo en bucle conectar/desconectar. La secuencia que funciona:

```
stop → docker exec <cid> pkill -f cauce-pty-agent-<alias>.py → start
```

Dos procesos por alias es lo NORMAL (el `docker exec` del host + el python de dentro). Tres es el
huérfano.

---

## 5. Trampas medidas que te van a ahorrar horas

1. **`NODE_ENV=test` para correr las suites.** Con `production` fallan 4 por la guarda de
   `AuthProvider` y parecen preexistentes. No lo son.
2. **`| tail` retiene la salida** de un proceso largo hasta que termina. Si quieres ver progreso,
   no lo pongas.
3. **Las señales mienten.** `systemctl is-active`, el exit code, un log sin la línea que buscas.
   Comprobá el efecto. Ejemplo de hoy: el relay **no loguea** `home` aunque lo reenvíe.
4. **Distinguí el 404 del enrutador del 404 del manejador.** «Route GET:… not found» = la ruta no
   está montada. Con cuerpo `error` = está montada y no encontró el alias. Los conté igual una vez
   y decían cosas opuestas.
5. Para probar que una ruta de consola está montada sin tener sesión: pedila y mirá si da **401**
   en vez de 404, con una ruta inventada al lado como control negativo.
6. **No hay forma de abrir la consola sin credencial.** El certificado de agente da
   `403 operator role is required` en `/v3/console/*`. No lo sortees: pedile el acceso a Steven.

---

## 6. Estado de `main` al entregar

- `main` = `9862d1f` en `origin`, `kratos`, `vpstn` y `respaldo`. **Los cuatro alineados.**
- Trae fusionadas las dos líneas de trabajo: `integracion/con-main-20260825` (editor de perfiles,
  siembra, `ficheros-del-arnes`) y `fix/directive-contenido-20260824` (la cadena de lectura, el
  clamp de `rows` del relay y la propagación de `home`).
- **`pnpm build:core` → 0 errores.** Suites: gateway + relay **285 pasan, 6 saltadas**; pty-agent
  **103 pasan**.
- Las 6 saltadas son un solo `describe.skip` en `services/gateway/src/health-progress.test.ts`:
  una especificación que escribí y **nunca implementé** (`HealthOptions` no tiene `dataApp` ni
  `ackProbe`). Llevaba 4 rojos permanentes. Está saltada con la fecha, el motivo y cómo
  reactivarla. **El defecto que describe es real**: el gateway puede contestar `ready` con el plano
  de datos caído.

## 7. codex está en 0.149.1 y sus MCP quedaron revisados

**Actualizado de `0.145.0` a `0.149.1`** (la última del registro). La causa de que estuviera atrás
no era que faltara instalar: **había dos prefijos npm a la vez**. `/usr/lib/node_modules` ya tenía
`0.149.1`, pero el `PATH` resuelve `~/.local/bin/codex` → `~/.npm-global`, que seguía en `0.145.0`.
Actualizado ese prefijo, `codex --version` → `codex-cli 0.149.1`.

**La credencial compartida NO se tocó**: `~/.codex/auth.json` conserva su `mtime` del 12-ago y su
tamaño. Nunca se ejecutó `codex login` ni nada que renueve el testigo — un `login` rota la
credencial de `codex-pro-steven`, que comparten ocho alias. Sólo `--version`, `mcp list` y
`mcp get`, que no autentican.

Respaldos antes de tocar nada: `~/.codex/config.toml.bak-zeus-*`,
`~/.codex/plugins/agent-parity/.mcp.json.bak-zeus-*` y el `.mcp.json.bak-zeus-*` de la caché.

### El estado real, según el propio codex (`codex mcp list`)

**Encendidos — 13:** `ai-usage`, `cloud-offload`, `serena`, `chrome-devtools`, `playwright`,
`context7`, `graphify`, `sequential-thinking`, `github-legacy`, `firebase`, `vercel`, `atlassian`,
`openaiDeveloperDocs`.

**Apagados — 3, y los tres por credencial:** `brave-search` (`BRAVE_API_KEY` ausente), `sentry`
(`SENTRY_ACCESS_TOKEN` ausente), `neon` (HTTP 401). Se dejan apagados a propósito: encender lo que
no arranca sólo llena la lista de herramientas rotas. **No se tocan**: es dato, no recomendación.

### Lo que estaba mal y se arregló

- **Diez servidores estaban `disabled`,** entre ellos `chrome-devtools`, `playwright` y `serena`.
  Eso importa para este trabajo: **la tarea pendiente exige abrir el modal en un navegador**, y
  codex tenía las dos herramientas de navegador apagadas. Encendidos los siete que miden bien.
- **`ollama-local` seguía declarado y ENCENDIDO**, contra la baja de Ollama que pidió Steven el
  2026-07-24. Vivía en la **copia cacheada** del plugin
  (`plugins/cache/shared-agents/agent-parity/0.1.0+codex.20260723185017/.mcp.json`, fechada un día
  antes de la baja), que es la que codex lee de verdad — quitarlo del plugin «fuente» no bastaba.
  Eliminado de las dos.
- **`firebase` no arrancaba**: no existe el binario global. Reapuntado a `npx -y firebase-tools`;
  pasó de no arrancar a 19 herramientas.

### Dos correcciones a lo que informé antes

1. **`cloud-offload` y `ai-usage` NO faltaban.** Estaban declarados en el plugin `agent-parity`,
   no en `config.toml`, y yo sólo había mirado el `.toml`. Peor: al «añadirlos» pisé la definición
   buena — la mía apuntaba a `~/.local/bin/cloud-mcp.py` y la del plugin a
   `scripts/safe_cloud_mcp.py`, **que es el que de verdad atiende `delegar_a_cloud`**. Revertido:
   `codex mcp get cloud-offload` vuelve a mostrar `safe_cloud_mcp.py`.
2. **`clawbus` sí estaba muerto** (`Module not found`) y sigue eliminado. Eso se sostiene.

### Antes eran 15 declarados y 9 respondían

## 7 bis. Detalle de la primera revisión

Probados arrancando cada servidor y hablándole el protocolo (`initialize` + `tools/list`), **sin
invocar el CLI de codex**: hacerlo revoca la cadena de credencial que comparte la flota.

Sonda: `/tmp/claude-1000/-workspace/…/scratchpad/probar-mcp.py`. Respaldo de la config antes de
tocarla: `~/.codex/config.toml.bak-zeus-mcp-*`.

**Funcionan — 12:** `context7` (2 herramientas), `graphify` (9), `sequential-thinking` (1),
`serena` (30), `chrome-devtools` (29), `playwright` (24), `github-legacy` (26), `firebase` (19),
`vercel` (37), `openaiDeveloperDocs`, `ai-usage` (1), `cloud-offload` (1).

**Lo que estaba mal y arreglé:**

- **Faltaban los dos que la flota EXIGE.** `cloud-offload` (`delegar_a_cloud`, la vía de
  delegación) y `ai-usage` (`get_ai_quotas`, el paso 0 antes de un fan-out) **no estaban en la
  config de codex**. Añadidos y probados: los dos responden.
- **`clawbus` apuntaba al bus muerto.** `Module not found …/clawbus-channel/server.ts`. Cauce V3 lo
  reemplazó hace tiempo. Eliminado.
- **`firebase` no arrancaba**: no existe el binario global. Reapuntado a `npx -y firebase-tools`;
  pasó de no arrancar a 19 herramientas.

**Siguen sin funcionar — 4, y los cuatro por credencial:** `neon` (HTTP 401), `atlassian`
(HTTP 403), `sentry` (`SENTRY_ACCESS_TOKEN` ausente), `brave-search` (`BRAVE_API_KEY` ausente).
Los extremos viven y responden; lo que falta es la credencial. **No los toqué**: es dato, no
recomendación.

## 8. Lo que NO probé, con esas palabras

- **No abrí el modal en un navegador.** Verifiqué la ruta (401 con control negativo en 404), la
  lectura real (200 con el contenido), y que los tres artefactos desplegados llevan el cambio.
  La pantalla en sí, no.
- **No leí ni un valor de variable de entorno ni de credencial** en todo esto: sólo nombres.
- **No probé la escritura** porque no existe.

---

## 9. Addendum 2026-08-25: por qué codex no ejecutaba nada, y qué se arregló

Al arrancar `codex --yolo` a mano contestaba **`self_alias no está en esta tabla`** y no hacía nada.
Parecía que los subagentes estaban rotos. **No lo estaban.**

`~/.codex/AGENTS.md` ordenaba: *«Si `self_alias` no está en esta tabla, respondé diciendo
exactamente eso y no ejecutes nada»*. `self_alias` sólo existe dentro del `TRUSTED DELIVERY
CONTEXT` de una entrega del bus — **arrancado por una persona no hay entrega, así que no hay
`self_alias`, y nunca lo va a haber.** El fichero daba por supuesto que codex sólo corre como
agente de Cauce y se auto-bloqueaba en el único modo en el que un humano lo usa.

Arreglado partiendo la sección 0 en dos: **con** `TRUSTED DELIVERY CONTEXT` = agente del bus, se
busca en la tabla; **sin** él = hay un humano al teclado, se le contesta y no aplican las reglas del
bus (`reply`/`messages`, plazos de ACK). Respaldo: `~/.codex/AGENTS.md.bak-zeus-interactivo-*`.

**`~/.codex` es un bind compartido** (`/datos/agents/shared/.codex`): esto lo arregla para los cinco
alias codex a la vez.

Además, en el mismo arranque:

- **`atlassian` tumbaba el arranque de MCP** (`MCP startup incomplete (failed: atlassian)`) por no
  tener login. Apagado. Ahora no queda ningún servidor encendido sin autenticar.
- **Tres subagentes apuntaban a Ollama**, dado de baja el 2026-07-24. `local-offloader` (su única
  herramienta era `delegar_a_local`) se retiró a `agents/.retirados-zeus-20260825/`;
  `external-offloader` y `quota-router` se limpiaron. **El propio AGENTS.md ya declaraba Ollama
  prohibido: el documento estaba al día y los `.toml` no.**

Subagentes que quedan, todos con proveedor vivo: `adversarial-reviewer`, `external-offloader`,
`gemini-offloader`, `integrator`, `minimax-offloader`, `quota-router`, `workflow-runner`.

**No lo probé ejecutando codex**, con esas palabras: Steven tenía una sesión interactiva abierta y
un `codex exec` mío refresca el mismo `auth.json` que esa sesión tiene en memoria. La prueba la
corre él en su propia sesión.
