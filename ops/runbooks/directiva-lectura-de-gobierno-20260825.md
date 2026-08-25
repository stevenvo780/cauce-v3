# La lectura de gobierno del modal de directiva — qué estaba roto y cómo quedó

zeus, 2026-08-25. Cierra el objetivo que quedó pendiente en `handoff-zeus-20260824.md`.

## El síntoma

El modal «Directiva de \<alias\>» pintaba **NO SE PUDO MIRAR** en la Capa 2 (`CLAUDE.md`) y la
Capa 3 (memoria). La Capa 1 (rol declarado) sí funcionaba y sí se editaba.

## No era un eslabón: eran CINCO

El handoff del 24 daba por resuelto el punto 4 y no había visto el 5. Medido el 25:

| # | Eslabón | Qué le pasaba |
|---|---|---|
| 1 | gateway | La imagen que corría (`7b88c1e8`) **no tenía** `agent-directive.routes.js`. El `agent-documents.routes.js` que sí tenía **no lo montaba nadie** (cero llamadores). |
| 2 | terminal-relay | La imagen viva (`terminal-minrows-20260824`) no tenía `POST /v3/terminal/relay/read`. |
| 3 | pty-agent | El desplegado no tenía `read_governance` (`grep -c` = **0** en las tres copias del host). |
| 4 | config del gateway | Las `CAUCE_TERMINAL_RELAY_*` estaban en `prod.env` desde el 24 y se dieron por desplegadas, pero el servicio `gateway` declara `environment:` explícito: **lo del env-file no entra solo**. Dentro del contenedor no estaban. |
| 5 | identidad TLS | El gateway **no tenía certificado de cliente**. El handoff apuntaba `CLIENT_CERT_FILE` a `gateway_tls_cert`, que es **serverAuth únicamente** (EKU `1.3.6.1.5.5.7.3.1`). El relay lo rechazaba en el saludo TLS (`terminal_relay_console_handshake_rejected`) y **ningún ajuste de CN lo arregla**. |

El 5 es el que invalidaba la frase del handoff anterior *«es PURA CONFIGURACIÓN y ya está escrita»*.
No lo era: faltaba emitir una credencial que nunca existió.

## Lo que se hizo

1. **Imagen completa**, no cirugía: `cauce-v3-runtime:directiva-20260825`, etapa `runtime` de
   `deploy/Dockerfile`, desde `zeus/directiva-20260825` (commit `5f59f93`). El 24 se intentó copiar
   `.js` sueltos dentro de la imagen viva y el gateway no arrancó (`authority.js` no exportaba
   `FLEET_PLACEMENTS`): dos versiones no son intercambiables fichero a fichero.
2. **Se portó el arreglo de `rows` del relay** (`parseClientMessage` **acota** en vez de rechazar),
   con prueba y control negativo. Sin esto, subir el relay habría **revertido**
   `terminal-minrows-20260824` y una tercera terminal habría vuelto a matar las dos vivas.
3. **Certificado de cliente emitido**: `/etc/cauce-v3/pki/gateway-client.{crt,key}`,
   `CN=gateway-client`, EKU `clientAuth`, misma CA, vence 2028-11-27. Es **aditivo**: no rota ni
   invalida nada, no deja mudo a ningún alias. Dueño `1000:1000` (si queda `root`, el gateway
   entra en bucle con `EACCES`; es la convención del resto de claves).
4. **`gateway-client` añadido** a `CAUCE_TERMINAL_RELAY_CONSOLE_CN` (es una lista por comas), sin
   quitar `console-client`.
5. **pty-agent publicado como release nueva** — `releases/ops-pty-directiva-20260825` — y el
   symlink `~stev/.local/share/cauce-v3/ops` girado. **El `pty-kit` de `~stev/pty-kit` NO es el que
   usan los units**: los units apuntan al symlink `ops`. También se actualizó, pero el que manda es
   el symlink.

## La trampa del reinicio del pty (otra vez)

Reiniciar el unit **deja un huérfano dentro del contenedor** y el nuevo entra en bucle
conectar/desconectar. La secuencia que funciona es **`stop` → matar dentro del contenedor →
`start`**. Se aplicó a los 11 alias de vpstn. Dos procesos por alias es lo NORMAL (el `docker exec`
del host + el python de dentro); tres es el huérfano.

## Verificación

- Ruta montada, **con control negativo**: `/directive` → **401** («se requiere la cookie de
  sesión»); `/ruta-inexistente-de-control` → **404** «Route GET:… not found». Antes las dos daban 404.
- **Lectura real de punta a punta** (gateway → relay → pty-agent), que es la misma llamada que hace
  la ruta: **HTTP 200** con `{path,bytes,truncated,modified_at,content}` —
  `zeus` 10.733 B · `socrates` 8.179 B · `jarvis` 2.057 B · `janus` 2.057 B (Miguel).
- Suites: gateway `console`+`terminal` **123/123**, terminal-relay **83/83**, pty-agent **74/74**.
  Con `NODE_ENV=test`: con `production` fallan 4 por la guarda de AuthProvider y parecen
  preexistentes.
- Stack entero `healthy`; **0 entregas muertas** en la hora del despliegue (8 `done`, 3 `started`).

## Lo que NO se probó

- **No se abrió el modal en un navegador.** Hace falta una sesión de consola y no la tengo; el
  certificado de agente de zeus da **403 `operator role is required`** en `/v3/console/*`, y no se
  intentó sortear esa frontera. Lo verificado es la ruta (401 vs 404) y la lectura subyacente.
- No se comprobó que una terminal siga abriéndose desde la UI tras subir el relay. El clamp está
  probado en la suite, no en la pantalla.

## Segunda vuelta del 2026-08-25: eran SIETE, no cinco

Con los cinco de arriba desplegados el modal seguía mintiendo: decía *«el servidor miró y no hay
ningún CLAUDE.md en ningún nivel»* junto a *«contenedor sin identificar»*. **Nunca miró.** El fichero
de zeus existe y pesa 10.733 bytes.

| # | Eslabón | Qué le pasaba |
|---|---|---|
| 6 | hechos del alias | `terminal/plugin.ts` construía su `MeasuredFactsSource` como `{ factsFor: async () => undefined }`. Sin hechos no hay `home`, sin `home` no hay ruta y sin ruta no hay nada que leer. Ahora sale del registro vivo de presencia (`terminal/hechos-del-registro.ts`). |
| 7 | `home` en la presencia | El pty-agent **sabía** su `HOME` y no lo publicaba; y cuando empezó a publicarlo, **el relay lo tiraba**: `AgentLeg.presence()` compone su objeto campo a campo y `home` no estaba en la lista. Tres puntos: `AgentHello`, `parseAgentHello` y `presence()`. |

En los tres sitios `home` es **opcional**: un pty-agent anterior conserva su saludo, su presencia y
sus terminales, y sólo se queda sin lectura de directiva. Exigirlo habría dejado a la flota entera
como `not_installed` en la consola durante el despliegue.

## Lo que SIGUE pendiente: crear y escribir el fichero

Steven lo pidió con estas palabras: *«faltaría botón para crear el archivo correspondiente para
poder llenarlo»*, y que el perfil de cada agente viva en SUS ficheros (`CLAUDE.md`, `AGENTS.md`,
`SOUL.md`…), dejando la Capa 1 sólo para lo que cambia entre turnos.

**Hoy no existe ningún camino de escritura.** El pty-agent sólo anuncia `read_governance`; no hay
`TAG_WRITE`, ni ruta en el relay, ni `PUT` en el gateway, ni botón en la consola. Lo que sí está
escrito y sin conectar, en la rama `integracion/con-main-20260825`: `ficheros-del-arnes.ts` (compone
el texto exacto de cada fichero por arnés), `siembra-del-perfil.ts` (el adaptador lo materializa en
el disco de su contenedor, apagado tras `CAUCE_SEMBRAR_PERFIL=1`), `agent-profile.routes.ts` (sólo
`GET`) y `PerfilTab.tsx`.

El camino corto es simétrico al de lectura, y la validación de escritura puede reutilizar
`_validate_read_path` casi entera — con una diferencia: al crear, `not_found` deja de ser un error y
el directorio padre es lo que hay que contener. **La escritura tiene que ser en el sitio, no por
`rename`**: el home del agente puede ser un bind-mount y un `rename` le cambia el dueño al fichero.

## Cómo se revierte, en este orden

1. `rm /etc/cauce-v3/compose-overrides/directiva-20260825.yaml`
2. Recrear `gateway` y `terminal-relay` (vuelven a `CAUCE_RUNTIME_IMAGE` y a `terminal-minrows`)
3. Girar el symlink: `ln -sfn …/releases/ops-pty-20260822T175800Z …/ops` y reiniciar los units con
   la secuencia stop→matar dentro→start
4. `gateway-client.{crt,key}` puede quedarse: no lo usa nadie más.

---

## Anexo 2026-08-25: los adjuntos de la flota — `bus-v3-20260825-adjuntos`

Queja de Miguel: «janus me sigue enviando los archivos de una manera que no me sirve». Medido:
janus emitía **cero `artifacts`** y escribía rutas en el texto (`MEDIA:/home/claw/...`,
`ws-humanizar:/workspace/...`).

**No era culpa del agente, y hay tres capas:**

1. **`MEDIA:` lo inyecta OpenClaw**, no el agente: `buildAssistantOutputDirectivesSection()` de
   `/usr/lib/node_modules/openclaw/dist/system-prompt-config-*.js` ordena *«Attach media … with
   `MEDIA:<path-or-url>`»*. Está en la trayectoria viva de janus. Funciona en el Telegram propio de
   openclaw; dentro del sobre de Cauce es **texto muerto** (`grep -rn "MEDIA:"` sobre cauce-v3 → 0).
   OpenClaw sólo emite la rama moderna («Do not use legacy MEDIA:») si
   `sourceReplyDeliveryMode == 'message_tool_only'`, clave ausente del `openclaw.json` de janus.
2. **janus abandonó `artifacts` con evidencia correcta.** Su nota del 06-ago registra un PDF enviado
   por `artifacts` con `file://` que no llegó. Era cierto: `artifact-inliner.ts` —que convierte el
   fichero local a `data:` **dentro del contenedor del agente**— se escribió el **22-ago**, y la
   flota corría el bundle del **14-ago**.
3. **El sobre de Cauce nombra `artifacts` una sola vez**, en la línea del esquema, y **sin una sola
   invariante de protocolo**, mientras `reply`/`messages`/`notify`/`status` sí las tienen. Un campo
   sin regla lo llena cada arnés con su propia convención.

### Lo desplegado

Release `bus-v3-20260825-adjuntos`, digest `sha256:3edd721e75bc570b…`, **canario en `janus`**.
El resto de la flota sigue en `bus-v3-20260814-umbral` hasta que janus lo pruebe en uso real.

### Las tres trampas que costaron el rato, para el próximo

- **`SHA256SUMS` del bundle NO lo lee el supervisor** (sólo `release-gate.sh` y las herramientas de
  verificación). La puerta real es `bundle-digest`. Y el del bundle vivo **ya estaba desactualizado**
  (le faltaban 20 ficheros y listaba un `SHA256SUMS.tmp` fantasma): ese fantasma es el generador
  original hasheando su propio temporal dentro del árbol. No lo copies: generá el temporal FUERA.
- **Reemplazar sólo `packages/adapter-sdk/dist` NO basta.** El `dist` nuevo importa
  `clampToRoleBriefLimit` de `@cauce/protocol`, y el bundle trae su propia copia en
  `adapter-sdk/node_modules/@cauce/protocol`. Sin actualizarla también, el arranque muere con
  `SyntaxError: … does not provide an export named 'clampToRoleBriefLimit'` — la misma clase de
  fallo que tumbó el gateway el 24-ago.
- **La prueba de vuelo que lo cazó**, y que hay que hacer siempre antes de pinear: copiar el
  paquete **entero** (con `node_modules`) al contenedor y `import()` el `engine`, el `inliner` y
  `bin/openclaw.js`. Llegar a `ADAPTER_FATAL: Required configuration 'CAUCE_TENANT' is missing` es
  **éxito**: significa que el grafo de módulos cargó entero y sólo falta el entorno del supervisor.

### Reversa

```
python3 /opt/cauce-v3/ops/scripts/pin-container-release.py pin janus \
  --release bus-v3-20260814-umbral \
  --sha256 sha256:a469ed640d2ac5ef0aacc89e14c21cea9c13b7e8d6d55a38c8a671c328874d56 \
  --expected-release bus-v3-20260825-adjuntos \
  --expected-sha256 sha256:3edd721e75bc570b8fc5a67aa45c1e60992ca24570b56a20b32da96e77f036af
```
y reiniciar `cauce-v3-container-janus.service`. Las instrucciones de janus están respaldadas en
`/home/claw/clawd/TOOLS.md.bak-zeus-20260825`.
