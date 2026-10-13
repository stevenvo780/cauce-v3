# Dependencias de Argos con la VPS

Inventario de solo lectura previo a mover Argos. La inspección se limitó al contenedor `ctrl-infra`, sus unidades, configuraciones MCP y conexiones TCP. No se imprimieron valores de entorno, credenciales ni direcciones IP; las rutas personales de la cuenta de servicio se agrupan por raíz.

## Runtime y montajes

| Elemento | Observación en la VPS |
|---|---|
| Contenedor | `ctrl-infra`, imagen `cauce-sep/ctrl-infra:20260730T180341Z`, sano en la captura, usuario `dev`, `restart=unless-stopped`. `Privileged=false`; `CapAdd` y `CapDrop` nulos: no hay capacidades añadidas ni retiradas del conjunto por defecto. |
| Redes | `ctrl-infra-proxy`, `net-claw`, `net-claw-ws`, `ws_net-out` y `control_default`. |
| Puertos | Docker declara `22/tcp`, sin publicación en el host. La captura de sockets vio `sshd` en 22, OpenClaw en 18789 y el shim en 18799 dentro del contenedor; 18789 y 18799 no aparecen como puertos Docker publicados. |
| Variables de entorno | Solo nombres: `API_KEY`, `BW_SERVER`, `DEBIAN_FRONTEND`, `DISPLAY`, `DOCKER_HOST`, `HISTFILE`, `LANG`, `LC_ALL`, `NEXUS_URL`, `NODE_ENV`, `NVIDIA_DRIVER_CAPABILITIES`, `NVIDIA_VISIBLE_DEVICES`, `PATH`, `PIP_DISABLE_PIP_VERSION_CHECK`, `PYTHONUNBUFFERED`, `WORKER_NAME`, `XDG_RUNTIME_DIR`. No se consultaron ni registraron valores. |
| Persistencia | `/datos/agents/ctrl-infra-config` está montado en escritura para estado y configuración de Argos; `/datos/workspaces` llega como `/workspace`, también en escritura y con todos los workspaces del host. |
| Configuración compartida | Hay montajes seleccionados de `/datos/agents/shared` en lectura y escritura. No se enumeran ficheros. También hay montajes de identidad SSH con permisos de lectura y escritura, y otro de solo lectura; sus fuentes privadas no se publican ni se abrieron. |
| Volúmenes Docker | `ctrl-infra-cache` y `ctrl-infra-etcssh`, ambos en escritura. |

## MCP configurados

Los servidores de transporte `stdio` se lanzan como procesos locales dentro del entorno de Argos; la configuración consultada no declara una URL HTTP para ellos. Los endpoints HTTP se muestran solo como origen, sin ruta, query ni token.

| Perfil | MCP | Endpoint declarado |
|---|---|---|
| OpenClaw | `ai-usage`, `cauce`, `cauce-decisiones` | `stdio` con `node`; sin URL HTTP explícita. |
| OpenClaw | `cloud-offload` | `stdio` con `python3`; sin URL HTTP explícita. |
| Codex | `atlassian`, `neon`, `openaiDeveloperDocs` | HTTP: `https://mcp.atlassian.com`, `https://mcp.neon.tech`, `https://developers.openai.com`. |
| Codex | `brave-search`, `chrome-devtools`, `clawbus`, `context7`, `firebase`, `github-legacy`, `graphify`, `playwright`, `sentry`, `sequential-thinking`, `serena`, `vercel` | `stdio` con ejecutables locales (`npx`, `bun`, `firebase`, `bash`, `uvx` o `vercel-mcp-headless`); sin URL HTTP explícita. |
| Claude | `ai-usage`, `brave-search`, `cloud-offload`, `firebase`, `github`, `godaddy`, `graphify`, `hostinger`, `neon`, `sentry`, `sequential-thinking` | `stdio` con ejecutables locales (`node`, `npx`, `python3`, `firebase` o `bash`); sin URL HTTP explícita. |
| Gemini | No se encontró un registro MCP en la configuración revisada. | No detectado en ese perfil. |

El MCP `cauce-decisiones` tiene además un backend vivo llamado `cauce-decisiones-decisiones-1`, con `8447/tcp` publicado en el host. No se mostró una dirección del host ni se infirió que ese puerto sea el endpoint del proceso MCP `stdio`.

## Unidades y guardias

| Unidad | Estado observado | Relación con Argos |
|---|---|---|
| `cauce-v3-container-argos.service` | Servicio de usuario habilitado y activo. | Arranca `ctrl-infra`. Se sustituye por el supervisor V4 de Argos en el host destino. |
| `cauce-v3-pty@argos.service` | Habilitado y activo. | Mantiene la terminal remota; recrear el canal PTY con el host V4. |
| `cauce-v3-profile-expectation@argos.service` | Fallido, deshabilitado; último resultado `exit-code` 1. | La expectativa de perfil no está sana; corregirla o retirar su equivalente al pasar a V4. |
| `cauce-openclaw-gateway-guard.timer` | Timer root habilitado y activo; su servicio de una ejecución estaba inactivo al consultar. | Arranca/repara el gateway OpenClaw y reaplica su ajuste local. Llevar esa función al artefacto V4 o sustituirla por una unidad acotada. |
| `cauce-openclaw-fallback-guard.timer` | Timer root habilitado y activo; su servicio de una ejecución estaba inactivo al consultar. | Mantiene los fallbacks de OpenClaw y aplica su ajuste local. Reproducir solo la función necesaria en el destino. |
| `cauce-cred-guard.timer` / `.service` | Timer root habilitado y activo; el servicio falló con `exit-code` 1. | Comprueba estado de credenciales compartidas. Resolver el fallo y configurar identidades propias por agente antes del corte. |
| `argos-repaso-pmo.timer` / `.service` | Timer deshabilitado y servicio inactivo. | No se observó como dependencia del runtime; confirmar si sigue teniendo propósito y retirarlo si no. |

## Conexiones y dependencias

Las conexiones se capturaron en tres muestras separadas por diez segundos, limitadas al espacio de red de `ctrl-infra` y filtradas a TCP establecido. Son una observación breve, no una medición histórica.

| Peer sin dirección IP | Proceso | Observación |
|---|---|---|
| `host externo sin nombre útil:443` | `node` | Presente en las tres muestras; el nombre inverso del host contiene una dirección y se omitió. Servicio concreto sin confirmar. |
| `peer externo sin DNS:8443` | `node` | Presente en las tres muestras; destino no identificable por DNS inverso. |
| `peer externo sin DNS:8445` | `python3` | Presente en las tres muestras; destino no identificable por DNS inverso. |
| `*.1e100.net:5228` | `chrome` | Infraestructura de Google vista en dos de las tres muestras. |
| `loopback:18800` / `loopback:42520` | `node` / `chrome` | Conexiones internas del contenedor; no son salidas a otros hosts. |

| Dependencia | Tipo | Cómo se ve en la VPS | Qué hacer al migrar |
|---|---|---|---|
| `ctrl-infra` / `cauce-v3-container-argos.service` | Runtime de Argos | Contenedor sano, usuario `dev`, redes y montajes anteriores; el supervisor está activo. | Mover solo el estado y runtime propios de Argos a su host V4. Mantener `ctrl-infra` mientras tenga consumidores del shim. |
| `ctrl-infra-docker-proxy:2375` | API Docker filtrada | Proxy `ghcr.io/tecnativa/docker-socket-proxy:latest`, en `ctrl-infra-proxy`, socket Docker montado en solo lectura y sin puerto publicado al host. La política se conoce como de solo lectura por el plan vigente; sus valores de configuración no se imprimieron ni verificaron en vivo. | Sustituir por un proxy de destino con allowlist explícita de solo lectura. El montaje del socket en solo lectura, por sí solo, no demuestra que la API rechace mutaciones. |
| SSH a `ws-*` por `net-claw-ws` | Acceso remoto a workspaces | Red presente en Argos y montajes de identidad SSH; `sshd` escucha dentro de `ctrl-infra`. No se observó una sesión SSH saliente en las tres muestras. | Sustituir las rutas de red y provisionar una identidad nueva, con permisos limitados. No trasladar una identidad compartida de la VPS. |
| `/workspace` ← `/datos/workspaces` | Datos de proyectos | Árbol completo montado `rw`. | Mover o clonar solo repositorios y datos asignados a Argos; retirar el montaje global. |
| `/datos/agents/ctrl-infra-config` | Estado/configuración persistente | Raíz montada `rw` para OpenClaw, perfiles de CLI y workspace legado. | Extraer únicamente el contexto y estado de Argos conforme al manifiesto de migración. |
| `/datos/agents/shared` | Configuración e identidades compartidas | Montajes seleccionados `ro` y `rw`; algunos corresponden a credenciales. | Sustituir por credenciales aisladas por agente y reprovisionadas por su titular; no copiar el árbol compartido. |
| MCP `cauce`, `cauce-decisiones`, `ai-usage`, `cloud-offload` | Integración de Argos | Declarados por OpenClaw como procesos `stdio`; el backend `cauce-decisiones-decisiones-1` está vivo. | Configurar de nuevo solo los MCP necesarios y sus destinos nombrados para el host V4. |
| MCPs de Codex y Claude | Herramientas de los perfiles CLI | Hay servidores `stdio` y tres endpoints HTTP de Codex listados arriba. | Reinstalar en el host nuevo los que Argos realmente usa; verificar permisos y endpoints sin copiar variables secretas. |
| `BW_SERVER`, `NEXUS_URL`, `host.docker.internal` | Vaultwarden, terminal remota y puente al host | Los nombres de servicio/variables están configurados; no se mostraron sus valores. Las conexiones TCP observadas no se pudieron asociar de forma concluyente a estos nombres. | Reemplazar por rutas a servicios nombrados accesibles desde V4 y reprovisionar sus accesos de forma aislada. |
| Timers root de OpenClaw y `cauce-cred-guard` | Supervisión | Dos guardias OpenClaw tienen timers activos; la última ejecución consultada del guardia de credenciales falló. | Sustituir las dos guardias con lógica integrada o unidades específicas. Reparar y reorientar el monitor de credenciales antes del corte. |
| `agy-openai-shim.py:18799` | Servicio compartido por otros agentes | Listener Python observado en `ctrl-infra`. Según el inventario de migración, lo usan Gaia, Jarvis, Iza y Janus como fallback. | Mantener `ctrl-infra` o mover el shim aparte y repuntar esos cuatro consumidores antes de retirar cualquier servicio compartido. |
| Salidas TCP `443`, `8443` y `8445` | Dependencias externas aún sin nombre | `node` conserva conexiones en esos puertos en las tres muestras; `8443` y `8445` no tienen nombre DNS inverso. | Identificar dueño y función antes del corte, autorizar solo destinos necesarios y reemplazarlos por nombres de servicio. |
| `argos-repaso-pmo.timer` | Tarea auxiliar | Deshabilitado e inactivo; no se observó conexión con el runtime. | Retirar si el dueño confirma que ya no es necesario. |

## Riesgos y límites

- El proxy Docker se declara de solo lectura en el plan vigente, pero no se comprobaron sus toggles efectivos porque la inspección no debía mostrar valores de entorno. Antes del traslado hay que verificar la allowlist con un método que no exponga secretos.
- `cauce-cred-guard.service` y la expectativa de perfil de Argos terminaron con código 1; las causas no se investigaron en registros que pudieran contener datos sensibles.
- Los destinos TCP `8443` y `8445` y el peer externo de `443` no quedaron asociados a un servicio concreto. Su presencia fue persistente solo durante las tres muestras breves.
- El montaje global y escribible de `/workspace` y los montajes compartidos de configuración amplían el alcance de Argos. La migración debe reducirlo a su propio espacio y credenciales.
- El shim `18799` tiene cuatro consumidores conocidos; mover Argos no permite retirar `ctrl-infra` hasta sustituir y comprobar esa dependencia.

## Comprobación de solo lectura

Se consultaron `docker ps`, campos seleccionados de `docker inspect`, `docker top`, `docker network inspect`, `systemctl list-unit-files`, `systemctl show` con propiedades de estado, un parser de solo lectura para nombres de entorno y configuraciones JSON/TOML MCP, y `ss -tnp` dentro del espacio de red del contenedor. No se inspeccionaron valores de entorno, credenciales, archivos `.env` ni archivos de autenticación; no se reinició ni modificó ningún servicio o contenedor.
