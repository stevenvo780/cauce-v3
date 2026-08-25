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

## Cómo se revierte, en este orden

1. `rm /etc/cauce-v3/compose-overrides/directiva-20260825.yaml`
2. Recrear `gateway` y `terminal-relay` (vuelven a `CAUCE_RUNTIME_IMAGE` y a `terminal-minrows`)
3. Girar el symlink: `ln -sfn …/releases/ops-pty-20260822T175800Z …/ops` y reiniciar los units con
   la secuencia stop→matar dentro→start
4. `gateway-client.{crt,key}` puede quedarse: no lo usa nadie más.
