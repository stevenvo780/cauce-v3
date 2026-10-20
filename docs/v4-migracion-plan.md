# Plan de migración de agentes a servidores locales (medición del 12-oct-2026)

> Histórico: inventario y plan de migración previos al cierre V4; verifica ubicaciones, cuentas y versiones actuales antes de intervenir. Usa la [guía V4](v4-guia.md) y [Operación](operacion.md).

Plan de la §5 del goal (`GOAL.md` y `ordenes/v4-cierre-objetivo.md` §4 «§5»): mover **Gaia, Hades, Argos y Hegel** fuera de la VPS principal y **retirar Cauce del hospital** moviendo los agentes de **Praxis**. Todo lo de este documento se obtuvo en **solo lectura** entre las 21:38 y las 21:56 UTC del 12-oct-2026: no se detuvo, reinició, copió ni borró nada, no se cambió ninguna cuenta y no se abrió ninguna credencial, `auth.json`, `.env` ni fichero de sesión. Las cuentas se identifican por los comandos de estado de cada CLI, por `cauce <alias> login --ver` (comando del repo que imprime tipo, huella corta e id de cuenta) y por las huellas que ya publica `cauce-cred-guard`; aquí se recortan a 8 caracteres.

Sustituye al censo del 11-oct (GPT), que medía tamaños pero no fijaba ubicación, bindings ni dependencias.

## 1. Medición del día

### VPS principal (`<host-prod>`, 16 núcleos)

Recibo del 12-oct: `.delegados/v4/recibos/vps-antes-20261012.json`, generado por `ops/scripts/measure-vps-footprint.sh` a las **21:51:35 UTC**. Sello interno `sha256` `04e2bdac6da521df322f2cb787317ab582f3c1c7011d45528697f7c5011087a5`; sha256 del fichero `31454938df12e3abcbf7ab2fbd6b5465b778591f6e0e313c7a838fe84360e93f`. Es la referencia histórica de RAM, swap, disco y RSS. El «antes» del corte se vuelve a medir con el script único del §6, que añade los tamaños por alias con un alcance fijo, para que el «después» use el mismo formato y el mismo alcance.

| Medida | Valor |
|---|---|
| RAM (`free -b`) | total 67 006 722 048 B (62,4 GiB); usada 36 526 579 712; **disponible 30 480 142 336 (28,4 GiB)** |
| Swap | **9 662 189 568 de 9 663 664 128 B usados (100 %)**: dos particiones de 512 MiB y `/swapfile-8g` |
| Disco `/` (`df -B1`) | 500 673 052 672 B; usado 411 751 792 640; disponible 83 806 236 672 (83 %) |
| Carga | 6,04 / 5,21 / 5,21 |

| Contenedor (`docker stats --no-stream`) | Memoria | Límite | CPU | PIDs | Capa escribible | Imagen |
|---|---|---|---|---|---|---|
| `agv2-miguel-finca-oc` (Gaia) | 270 MiB | 12 GiB, 1,5 CPU | 1,3 % | 25 | 2,77 GB | `claw:latest` 2,84 GB (compartida con `claw`, `claw-iza`, `claw-miguel`) |
| `agv2-steven-hades-oc` (Hades) | 240 MiB | 12 GiB | 2,0 % | 116 | 0,19 GB | `claw:tmux-grok-20260923` 2,84 GB (solo Hades) |
| `ctrl-infra` (Argos) | 1,50 GiB | 16 GiB | 19 % | 488 | 3,12 GB | `cauce-sep/ctrl-infra:20260730T180341Z` 3,63 GB |
| `ws-humanizar` (Hegel, Atlas, Kratos) | **14,46 GiB** | sin límite | **222 %** | 1 815 | 26,09 GB | `ws-humanizar:aplanada-20260927` 6,12 GB |

RSS propio de cada alias (suma del árbol de procesos atribuido: adaptador `--alias <alias>`, agente PTY, panel tmux `cauce-<alias>` y, en openclaw, el `gateway`):

| Alias | RSS | Procesos | Qué incluye |
|---|---|---|---|
| Gaia | 304 750 592 B (291 MiB) | 5 | gateway openclaw (CMD del contenedor), adaptador, PTY |
| Hades | 224 284 672 B (214 MiB) | 6 | `grok --always-approve --resume` en tmux, MCP `cauce`, adaptador, PTY |
| Argos | 1 483 739 136 B (1,38 GiB) | 25 | gateway openclaw (~790 MiB tras 13 días), `claude -p` en curso, dos `codex app-server`, Chrome headless, MCP, adaptador, PTY |
| Hegel | 150 896 640 B (144 MiB) | 4 | `muse-bin-1.4.1 --reasoning-effort max resume` en tmux, adaptador, PTY |

Liberar los cuatro devuelve a la VPS unos **2,1 GiB de RSS**. `ws-humanizar` sigue siendo el gran consumidor (codex `ultra` de gravitatoria, opencode, Playwright) y no cambia con la migración.

### Servidores locales

| Host | Medido (UTC) | CPU | RAM total / disponible | Swap | Disco `/` libre | Docker | Carga actual |
|---|---|---|---|---|---|---|---|
| server1 (IP de Tailscale del host) | 21:45:52 | 6 × i5-8400T | 22,8 GiB / **11,3 GiB** | 62 MiB de 8 GiB | **278,5 GB** (54 % usado) | **no** (LXD) | LXD `<contenedor-escritorio>` (contenedor, 6,3 GiB) y `pc-agente` (VM, 5,3 GiB); `cauce-audio-cpu.service` |
| server2 (IP de Tailscale del host) | 21:45:53 | 6 × i5-8400T | 22,8 GiB / **11,6 GiB** | 53 KiB de 8 GiB | **149,8 GB** (69 % usado) | 29.1.3; `server` en el grupo `docker` | ver tabla siguiente |
| server3 (IP de Tailscale del host) (`<host-navegador>`) | 21:46:26 | 4 × i5-7400 | **7,1 GiB / 3,5 GiB** | 0 de 4 GiB | 85,9 GB (22 % usado) | sí, solo con `sudo`; `server3` sin linger | 8 contenedores `nav-*` (linuxserver/chromium, ~400 MiB cada uno, 3,2 GiB) y servicios `nav-*-puente`, `nav-dns-usa`, `nav-exit-usa` |

server2 por contenedor:

| Contenedor | Memoria | Límite |
|---|---|---|
| `rpg-dos-almas` (Minecraft) | 9,22 GiB | 12 GiB (77 %) |
| `ws-isa` (Salva) | 859 MiB | 6 GiB, 2 CPU |
| `<cuenta-claude-1>`, `<cuenta-claude-2>`, `<cuenta-codex-1>`, `<cuenta-grok-1>` | 108 MiB, 0,5 MiB, 1,2 MiB, 9,8 MiB | 512 MiB cada uno |
| `isa-files`, `isa-tunnel`, `nav-lan` | 12, 2 y 11 MiB | sin límite |

Kant corre nativo en server2 (`cauce-v3-host-kant.service`, `cauce-v3-tmux-kant.service`, `cauce-v3-pty-host@kant`): dos `claude` (~0,8 GB) y su `codex app-server`. Los límites ya comprometidos en server2 suman **20 GiB** (Minecraft 12, Salva 6, cuotas 2) sobre 22,8 GiB físicos; el `systemd --user` de `server` está `degraded` solo por `cauce-v3-profile-expectation@salva` (fallo previo, igual que en la VPS). Imágenes en server2: 22 GB (`ws-isa` 18,2 GB, `cuota-cli` 2,1 GB).

### Huella de server3

El inventario histórico detectó un cambio de dirección LAN y una entrada caducada en `known_hosts`. No se aceptó ninguna clave nueva: la medición usó una ruta de malla cuya huella ya era confiable. Antes de intervenir, el operador debe cotejar la huella por su canal privado y actualizar únicamente la entrada confirmada; no se publican direcciones ni huellas del host.

## 2. Los cuatro agentes

### Gaia → `agv2-miguel-finca-oc` (openclaw con Anthropic, tenant Miguel)

- **Imagen**: `claw:latest` (`sha256:721695d4…`, 2,84 GB, base CUDA/Ubuntu 24.04 sin GPU). CMD `tini -- node …/openclaw/dist/index.js gateway --port 18793`. Usuario `claw`, red `agv2-tn-miguel` + `net-claw-ws`, `unless-stopped`.
- **Volúmenes**: `<datos>/tenants/<tenant>/agents/<alias>/oc/clawd` → `<home-del-agente>/clawd` (105 MB) y `…/oc/.openclaw` → `<home-del-agente>/.openclaw` (786 MB). **En la capa escribible, sin volumen** (se pierde con `docker rm`): `~/.claude` (2,7 MB), `~/.codex` (0,6 MB), `~/.claude.json`, `~/.ssh` (clave de despliegue de GitHub con alias de host `github.com-clawd`), `~/.local` 402 MB, `~/.npm-global` 335 MB, `~/.config` 257 MB, `~/.npm` 113 MB y un bundle `clawd-salvaguarda` de 2,5 MB.
- **Unidades** (usuario `stev`, `systemd --user`, linger): `cauce-v3-container-gaia.service` (`container-adapter-supervisor.sh start gaia`), `cauce-v3-pty@gaia.service`, `cauce-v3-profile-expectation@gaia.service` (fallida). De root: `cauce-bootstrap-guard` (vigila `claw*` y `agv2-*`). El gateway es el CMD: no depende del `cauce-openclaw-gateway-guard`.
- **Layout legado**: `<home-del-agente>/clawd` es un repo Git (`gaia-clawd` del GitHub del dueño, rama `web-humanizar-catalogo`, HEAD `87ddc8f`) que mezcla contexto (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md` vacío, `00-CONTEXTO-ACTUAL.md`), documentos de negocio (`CATALOGO`, `EMPRESA`, `ESTRATEGIA`, `NEGOCIO`, `PLAN`), catálogo PDF/JPG, `AGENTS.md.bak-*` y carpetas `clientes`, `entregas`, `pedidos`, `memory`, `tools`, `gravitatoria*`, `web-enlaces`, `web-humanizar*`. Estado Cauce en `~/.openclaw/cauce-v3/gaia`; `~/.openclaw` guarda además 20 copias `openclaw.json.bak*` y `codex-cli.bak-*`.
- **Binding**: primario `anthropic/claude-opus-5`; fallbacks `codex/gpt-6-astra`, `anthropic/claude-sonnet-5`, `antigravity/gemini-3.8-flash-high`; `thinkingDefault max`. Claude por el perfil `claude-cli` (OAuth del CLI): **setup-token sin refreshToken**; `claude auth status`: `loggedIn`, suscripción `max`, sin email ni organización, así que **el titular no se puede leer sin abrir la credencial** (titular previsto: Miguel, pregunta 2 del §3). Fallback Codex: **cuenta de proveedor del operador**, la misma que usa Argos. `cauce-cred-guard` no cubre los `agv2-*`.
- **Depende de la VPS**: el proveedor `antigravity` apunta a `http://<host-shim-legado>/v1` (shim de Argos); fuera de la VPS ese fallback queda roto y Gemini está fuera del pool: se elimina del destino.

### Hades → `agv2-steven-hades-oc` (grok, tenant Steven)

- **Imagen**: `claw:tmux-grok-20260923` (`sha256:22134c36…`, 2,84 GB). CMD `tini -- sleep infinity`; el supervisor lanza la TUI de grok en tmux (`-L cauce`, sesión `cauce-hades`, `GROK_HOME=<home-del-agente>/.grok`). Red `agv2-tn-steven` + `net-claw-ws`.
- **Volúmenes** (bajo `<datos>/tenants/<tenant>/agents/<alias>/oc/`, 2,29 GB): `state` → `~/.local/state/cauce-v3` (1 MB), `workspace` → `~/workspace` (1,74 GB), `.grok` → `~/.grok` (551 MB) y **el binario `.grok/bin/grok-1.0.41` montado en `/usr/local/bin/grok`** (solo lectura). En la capa escribible: `~/bin` 42 MB, `~/.cauce`, `~/.config` y seis ficheros `*.hdr` en la raíz del home (cabeceras de scraping: tratarlos como secretos).
- **Unidades**: `cauce-v3-container-hades.service`, `cauce-v3-pty@hades.service`, `cauce-v3-profile-expectation@hades.service` (fallida); `cauce-bootstrap-guard`.
- **Layout legado**: contexto en `~/.grok/AGENTS.md` (más `.bak` y copias de zeus). `~/workspace` tiene **440 ficheros sueltos en la raíz** (193 `ENVIO-*.json`, 21 `.md` operativos), el repo `xenia` (`xenia-operaciones`, `main`, `a2d48b8`), `revision-xenia` y `__pycache__`. Los 8 JSONL de más de 16 MiB son datos del proyecto (`xenia/data/bases_locales/…`, el mayor 91 MB).
- **Binding**: `[models] default = "grok-4.7"`, `default_reasoning_effort = "xhigh"`, `fork_secondary_model = "grok-4.6"`; MCP `cauce` y `xenia`. Login Grok en `~/.grok/auth.json` (0600, 1 763 B, renovado el 12-oct). Grok 1.0.41 no tiene un comando de estado que imprima la cuenta sin abrir ese fichero y `cauce hades login --ver` no lo reconoce, así que **la cuenta queda sin identificar en solo lectura**; el titular y pagador previsto es Steven (tenant Steven).

### Argos → `ctrl-infra` (openclaw con OpenAI, tenant Steven)

Inventario previo al traslado: [dependencias de Argos con la VPS](v4-argos-dependencias.md).

- **Imagen**: `cauce-sep/ctrl-infra:20260730T180341Z` (3,63 GB). CMD: `sshd`, *worker* de terminal remota y `sleep infinity`; el gateway openclaw (`index.js gateway --bind loopback --port 18789`) lo mantiene vivo el `cauce-openclaw-gateway-guard` de root.
- **Volúmenes** (`<disco-de-datos>/agents/ctrl-infra-config`, 16,25 GB en total): `clawd` 1,97 GB (de ellos `work` 1,79 GB de repos), `.openclaw` 6,69 GB (`agents` con las sesiones 4,1 GB, `npm` 1,1 GB, `memory` 0,5 GB, `codex-cli` y su `.bak` 0,8 GB, `gateway.log` 3 MB), `.local` 2,39 GB, `.codex` 2,89 GB, `.claude` 1,39 GB, `.gemini` 0,92 GB; además `<disco-de-datos>/workspaces` → `/workspace` (todos los workspaces, rw), ficheros sueltos compartidos `<disco-de-datos>/agents/shared/{.claude/.credentials.json,.codex/auth.json,.netrc,.gitconfig,.bashrc,.npm,.cache/pip}`, claves `ws-keys` y configuración de `gh` y Bitwarden CLI.
- **Unidades**: `cauce-v3-container-argos.service`, `cauce-v3-pty@argos.service`, `cauce-v3-profile-expectation@argos.service` (fallida). De root: `cauce-openclaw-gateway-guard` (solo `ctrl-infra`: arranca el gateway y reaplica un parche de esfuerzo en `dist` de openclaw), `cauce-openclaw-fallback-guard` (`claw` y `ctrl-infra`: suelta fallbacks pegados y parchea el pensamiento de gpt-6) y `cauce-cred-guard`.
- **Layout legado**: `<home-de-dev>/clawd` es el repo `argos-workspace` (`main`, `ac1b080`, con un remoto `mirror` dentro de `/workspace`), con contexto (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS*.md`, `HEARTBEAT.md` de 113 KB, `MEMORY.md`, `DIRECTIVAS-OPERATIVAS.md`, `DECISIONES-STEVEN-*`), 9 informes `REPORTE-*`/`REVISION-*`, 27 carpetas y ficheros de acceso local (`.qa-credentials.local`, `ACCESOS-DEV-QA-*.local.md`) que no se copian por manifiesto. Repos en `work/` y `proyectos/`: `gravitatoria`, `pos-back`, `devkits-crm`, `devkits-crm-catalogo`, `cauce-v3`, `web-humanizar-agenda`, `cauce-v3-humanizar-tech` y dos carpetas sin Git.
- **Binding**: primario `codex/gpt-6.1-sol`; fallbacks `anthropic/claude-opus-5-5[1m]`, `codex/gpt-6-sol`, `codex/gpt-6-luna`, `anthropic/claude-sonnet-5`, `minimax/MiniMax-M3` y `antigravity/gemini-3.8-flash-high` (los dos últimos, fuera del pool); `thinkingDefault max`. Codex: **cuenta de proveedor del operador**; su auth.json es un fichero compartido. Claude: **setup-token**, también del fichero compartido. Pagador: Steven.
- **Dependencias con la VPS (mejora 15)**:
  - API Docker por `DOCKER_HOST=tcp://ctrl-infra-docker-proxy:2375` (docker-socket-proxy en la red `ctrl-infra-proxy`): solo `CONTAINERS`, `INFO`, `PING` y `VERSION`; sin `EXEC`, `POST`, imágenes, redes ni volúmenes.
  - SSH a los `ws-*` con `ws-keys` por la red `net-claw-ws` (también tiene `net-claw`, `ws_net-out` y `control_default`).
  - `/workspace` con todos los workspaces del host, en escritura.
  - MCP `cauce` y `cauce-decisiones` (contenedor `cauce-decisiones-decisiones-1`), `ai-usage` y `cloud-offload`.
  - `BW_SERVER` (Vaultwarden público), `NEXUS_URL` (terminal remota pública) y `host.docker.internal`.
  - **Sirve a otros**: el shim `agy-openai-shim.py` en `:18799` lo usan como fallback Gaia, Jarvis (`claw`), Iza (`claw-iza`) y Janus (`claw-miguel`). Por eso **`ctrl-infra` no se retira**: solo las unidades y el estado de Argos.

### Hegel → dentro de `ws-humanizar` (muse, tenant Miguel)

- **Imagen**: `ws-humanizar:aplanada-20260927` (6,12 GB), proyecto compose `ws`, **privilegiado**, `docker.sock` montado, compartido con Atlas (codex) y Kratos (claude). No se replica.
- **Volúmenes y datos propios**: estado `~/.local/state/cauce-v3/hegel` (69 632 B), configuración `~/.local/share/cauce-v3/config/hegel` (35,9 MB: login de Muse, sesión `2026/09/28/01a0e56c…`, perfil de Chrome), lanzador `~/.local/bin/muse-cauce` y binario `muse-bin-1.4.4` (352 MB; el proceso vivo es 1.4.1, sustituido en disco). Todo vive en `<disco-de-datos>/agents/humanizar-config` (36,6 GB entre los tres alias).
- **Unidades**: `cauce-v3-container-hegel.service`, `cauce-v3-pty@hegel.service`, `cauce-v3-profile-expectation@hegel.service` (fallida). La TUI corre en el tmux `-L cauce` del contenedor, cuyo servidor lanzó la sesión de Kratos.
- **Layout**: sin contexto propio (no hay `AGENTS.md`/`IDENTITY.md`/`SOUL.md` suyos); directorio de trabajo `/workspace`, el árbol compartido de Humanizar (67 entradas).
- **Binding**: Muse con `reasoning_effort max` (en `settings.json` y en `MUSE_REASONING_EFFORT` del lanzador), sin `--model` (el predeterminado del catálogo Meta). Login Meta en `config/hegel/.config/muse/auth.json` (0600, 1 066 B, renovado el 06-oct). Muse no tiene comando de estado: **cuenta y titular sin identificar en solo lectura**. `cauce hegel login --ver` muestra la cuenta Codex `56121ead`, pero es la del contenedor, no la de Muse.

## 3. Repos de Hegel

No se pueden determinar en solo lectura. Su único directorio de trabajo es `/workspace` (compartido), no tiene espacio ni repo propio y la única traza de qué tocó es el transcript de su sesión de Muse, que no se abre. Los commits `[MUSE]` de `gravitatoria` desde el 27-sep salen de los carriles `muse-carril-*` de `gravitatoria-orq`, no necesariamente de Hegel. Como decidió el dueño (§3, pregunta 5), **hay que preguntárselo a Hegel por Cauce** antes de su corte y clonar solo esos repos. Candidatos (remotos `origin` de los repos de primer nivel de `/workspace`, último commit):

| Repo | Remoto | Último commit |
|---|---|---|
| `gravitatoria` | `gravitatoria` (SSH) | 2026-10-12 |
| `pos-rapido` | `pos-rapido` (HTTPS) | 2026-09-25 |
| `Demeter` | `AutomatizacionFicadirecta` (SSH) | 2026-09-22 |
| `HumanizarDocs` | `HumanizarDocs` (SSH) | 2026-09-19 |
| `HubCentral` | `HubCentral` (HTTPS) | 2026-09-12 |
| `graf-superadmin` | `graf-superadmin` (HTTPS) | 2026-09-10 |
| `Humanizar` | `Humanizar` (SSH) | 2026-08-18 |
| `ApiSigo`, `ApiSoftia` | homónimos (SSH) | 2025 |

Todos son del GitHub del dueño. Los otros 33 directorios con Git son *worktrees* de esos repos y no se clonan.

## 4. Praxis en el hospital (`ssh hospital`, `<host-hospital>`)

Host: 8 núcleos, 22,9 GiB de RAM (**18,4 GiB disponibles**), sin swap, 172 GB libres de 207 GB. Docker: 141 imágenes (21,5 GB, 4,6 GB recuperables) y 2,7 GB de caché de build.

**Versión de Cauce**: checkout `/opt/hospital-cauce` en la rama `hospitales`, HEAD `78f6d93c` («docs(hospital): registrar actualización validada de Cauce», 02-oct). Runtime desplegado **`da8d921bc`** (último `deploy/HISTORIAL.md`: 02-oct 22:41 UTC). Adaptadores en ejecución: `release-a89b86211715` (operador) y `release-7e1aaf125198` (perseo, teseo); el más reciente instalado es `release-72727a163c4e`. Todos esos commits están solo en `origin/socrates/hospital-supervision-1699`, no en V4. Las imágenes de agente salen de `0790d9f5`, que no existe en este repo.

**Base de datos** (`hospital-cauce-postgres-1`, consultas dentro de `BEGIN TRANSACTION READ ONLY`): **esquema 043** (39 migraciones; las últimas son `041_agent_context_revisions`, `042_blobs` y `043_blob_tenant_entitlements`), pgdata de 100 MB. Tenant único `Hospital` («Hospital Conecta», hub). Agentes en BD: `operador` (openclaw), `perseo` y `teseo` (muse) habilitados; `backend` y `frontend` (openclaw) deshabilitados. `agent_account_bindings` está vacía.

**Correo de León: no está en la V3 del hospital.** `console_users` tiene una sola fila (el operador del dueño, rol `operator`, alias `operador`) y ninguna otra tabla guarda correos. Hay que pedirlo al dueño (§3, pregunta 4).

| Componente | Contenedor e imagen | Memoria | Capa / datos | Modelo y cuenta |
|---|---|---|---|---|
| **operador** (alias Cauce) | `hospital-agent-openclaw-operator-gateway-1`, `hospital-openclaw-builder:ef87f685` (362 MB, openclaw 2026.7.1-2) | 873 MiB | capa 985 MB; `state-operator` 165 MB, `operator-workspace` 382 MB, `state-muse-operator` 208 MB, `operator-ops` 12 MB, `operator-admin-jobs` 18 MB | `xai/grok-4.7` `xhigh`, fallback `muse-cli/muse-spark-1.3` (en V4 apagado: ver «Aislamiento» abajo); API de xAI; bot de Telegram; plugins `browser`, `hospital-ops`, `hospital-muse-native` |
| **perseo** (muse frontend) | `hospital-agent-muse-frontend-1`, `hospital-openclaw-builder:8ef92b3a` (362 MB) | 280 MiB | capa 1,15 GB; `state-muse-frontend` 1,02 GB | login Meta en `~/.muse/config/muse` |
| **teseo** (muse backend) | `hospital-agent-muse-backend-1`, misma imagen | 441 MiB | capa 552 MB; `state-muse-backend` 937 MB | login Meta |
| ventas/atención (sin alias Cauce) | `hospital-agent-openclaw-sales-gateway-1`, `ghcr.io/openclaw/openclaw:2026.7.1-2` | 362 MiB | `state-sales` 142 MB | `xai/grok-4.6`; **canal WhatsApp**; plugin `hospital-crm` |
| crm | `hospital-agent-crm-1`, `hospital-agent-crm:stable` (46 MB, Python + SQLite) | 72 MiB | volumen 0,5 MB | publicado por Caddy |
| navegador | `hospital-agent-browser-1` (404 MB) + `-cdp-proxy-1` | 519 + 16 MiB | volumen 261 MB | Chromium del operador por socket CDP |

- Comunes en `/opt/hospital-agent/runtime` (5,1 GB en total): `muse-code-bin` 718 MB, `developer-workspace` 732 MB, `praxis` 701 MB y plantillas, políticas *seccomp*, aprobaciones y copias. Seis redes `hospital-agent_*`.
- **Servicios de host (root)**: `cauce-v3-container-{operador,perseo,teseo}.service` (supervisor del checkout), `hospital-access.service` (custodia del acceso del director, montado en `/run/hospital-access/{perseo,teseo}`), `hospital-operator-ops.service` (broker tipado por socket), `praxis-preview.service` (`127.0.0.1:8077`), `hospital-agent-repair.timer` y **Caddy** (80, 443 y 8443: el sitio del CRM y la vista previa de Praxis, lo «publicado» que irá a otra infraestructura).
- **Pila Cauce V3 del hospital** (`hospital-cauce-*`: consola, gateway, dispatcher, PG, telegram-bridge, prometheus, otel, registry): ~0,45 GiB. Se retira al importar Praxis en la V4 central. Las pilas de prueba `hospital-readiness-step0-*` y `ops-*` (`cauce-v3-test-runtime:local`, ~0,47 GiB) no se migran.
- Agentes y servicios de Praxis suman **~2,5 GiB** de RAM medida.

### Aislamiento del runtime y del fallback Muse del operador (requisito V4)

**Runtime confiable.** Lo que el operador ejecuta para producir evidencia de supervisión (`praxis-proof.py`, `praxis-qa-review.py`) y el backend del fallback Muse (`muse-cli-backend.py` y su plugin `openclaw-muse-native/`) ya no viven en `<home-del-contenedor>/clawd/.cauce/runtime`, que el agente (uid 1000) puede reescribir, sino en **`/opt/cauce-hospital/runtime`** del host: `root:root`, directorios `0755`, ficheros `0644`. Lo instala `provision-agents.sh` con `ops/instances/hospital/operator-runtime-guard.py install`, que reemplaza cada fichero dentro del directorio (nunca el directorio: el bind fija su inodo), borra todo lo demás (`__pycache__`, `json.py` o `usercustomize.py` plantados, enlaces) y rechaza ancestros que no sean de root o que otros puedan escribir. Se invoca siempre en modo aislado: `/usr/bin/python3 -I -B /opt/cauce-hospital/runtime/muse-cli-backend.py` (plugin) y `/opt/praxis-qa-venv/bin/python -I -B /opt/cauce-hospital/runtime/praxis-{proof,qa-review}.py` (la raíz del supervisor, `ROOT_TEXT` en `praxis-supervision.py`). `-I` ignora `PYTHON*`, el *site* de usuario y el directorio del script; `-B` no escribe `.pyc`.

El compose de `hospital-agent` **no está en este repo** (vive en `/opt/hospital-agent` del host del hospital y sus imágenes salen de `0790d9f5`, que tampoco está aquí). Montaje exacto que hay que añadir al servicio del operador (contenedor `hospital-agent-openclaw-operator-gateway-1`, servicio `openclaw-operator-gateway` del proyecto `hospital-agent`) y recrearlo con `docker compose up -d openclaw-operator-gateway`:

```yaml
services:
  openclaw-operator-gateway:
    volumes:
      - type: bind
        source: /opt/cauce-hospital/runtime
        target: /opt/cauce-hospital/runtime
        read_only: true
```

Comprobación (`operator-runtime-guard.py verify`, que `provision-agents.sh` corre antes de tocar bundles y aborta si falla): `docker inspect` muestra un único montaje en ese destino, `Type=bind`, `Source=/opt/cauce-hospital/runtime` y `RW=false`, sin otro montaje por debajo; `docker exec -u 1000:1000` ve cada directorio y cada `.py` legible y **no** escribible; y `sha256sum` dentro del contenedor da los mismos bytes que en el host. A mano:

```sh
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/opt/cauce-hospital/runtime"}}{{.Type}} {{.Source}} RW={{.RW}}{{end}}{{end}}' \
  hospital-agent-openclaw-operator-gateway-1          # → bind /opt/cauce-hospital/runtime RW=false
docker exec -u 1000:1000 hospital-agent-openclaw-operator-gateway-1 sh -c \
  'for p in /opt/cauce-hospital/runtime /opt/cauce-hospital/runtime/*.py; do test -w "$p" && echo "ESCRIBIBLE $p"; done; true'
                                                      # → sin salida
```

**Fallback Muse del operador: apagado en V4.** Hoy la cadena `xai/grok-4.7` → `muse-cli/muse-spark-1.3` está en el `~/.openclaw/openclaw.json` del operador (`state-operator`, estado del agente, fuera del repo) y la sirve el plugin `hospital-muse-native`. Ese fallback corre con el uid 1000 dentro del contenedor del operador: Muse con `--yolo` puede leer el `client.key` mTLS del operador (rol director, `hospital_ops`/`vps_exec`), `openclaw-token`, las credenciales de Telegram y xAI de `~/.openclaw`, y usar el socket de hospital-ops y el CDP del navegador. Por eso:

- `CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK` (de `provision-agents.sh`) vale **`0` por defecto** y el aprovisionamiento solo acepta `0`. El valor `1` se rechaza porque el puente Muse aislado todavía no está construido. El plugin conserva el registro condicionado a `CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK=1`, pero esa condición no autoriza su uso en el contenedor del operador.
- Con `0`, el aprovisionamiento falla si la config del operador menciona `muse-cli` o `hospital-muse-native`, si existe `~/.openclaw/extensions/hospital-muse-native`, si el contenedor trae el opt-in en su entorno o si tiene Muse (montajes en `<home-del-contenedor>/.muse` u `/opt/muse-code`, o los ficheros `<home-del-contenedor>/.muse/config` y `/opt/muse-code/muse`). Antes del corte: quitar el fallback de `agents.defaults.model.fallbacks`, la entrada y la extensión del plugin, y los montajes `state-muse-operator` y `muse-code-bin` del servicio del operador.
- Con `1`, el aprovisionamiento aborta antes de modificar el runtime. No hay una excepción transitoria que permita cargar Muse junto a las credenciales del operador; la alternativa exige terminar y verificar el puente aislado descrito a continuación.

**Destino en los servidores locales: contenedor propio.** Al migrar Praxis, el fallback Muse del operador va en su propio contenedor, como teseo y perseo, sin el PKI del operador ni `~/.openclaw`. Requisitos: uid `1000:1000`, raíz de solo lectura, `cap_drop: [ALL]`, `no-new-privileges`, `/tmp` en tmpfs (`noexec,nosuid,nodev`, 64 MiB) y una red propia con salida solo a la API de Meta, fuera de las redes `hospital-agent_*` del navegador, el `cdp-proxy`, hospital-ops y el CRM. Montajes permitidos (lista cerrada):

| Destino | Origen | Modo |
|---|---|---|
| `/opt/cauce-hospital/runtime` | `/opt/cauce-hospital/runtime` | `ro` |
| `/opt/muse-code` | `/opt/hospital-agent/runtime/muse-code-bin` (lanzador fijado) | `ro` |
| `<home-del-contenedor>/.muse` | `state-muse-operador`: login Muse propio, no compartido con teseo ni perseo | `rw` |
| `<home-del-contenedor>/clawd` | workspace propio del fallback, con el repo de Praxis (`/opt/hospital-agent/runtime/praxis/operator`) como subdirectorio | `rw` |
| `/run/muse-fallback` | directorio del socket del puente | `rw` (solo el socket) |

Prohibidos, entre otros: `/opt/cauce-v3-secrets` y `/etc/cauce-v3-hospital` (PKI y `openclaw-token`), `state-operator` (`<home-del-contenedor>/.openclaw`), `operator-ops`, `operator-admin-jobs`, `/run/hospital-access`, el socket de hospital-ops, el CDP, `/var/run/docker.sock` y los estados de teseo y perseo. El repo de Praxis es la única superficie compartida con el operador: sus hooks y su config de Git se tratan como no confiables (el supervisor ya usa `--no-optional-locks` y `core.fsmonitor=false`). El backend de OpenClaw ejecuta un comando local, así que el operador llega al contenedor solo por un socket Unix de propósito único con el mismo contrato que `muse-cli-backend.py` (prompt por stdin, `--system-prompt`, `--session-id`, JSONL de salida). **Ese puente está por construir; hasta entonces el fallback sigue en `0`.** Comprobación en el host de destino antes de activarlo:

```sh
docker inspect --format '{{range .Mounts}}{{.Destination}} RW={{.RW}}{{"\n"}}{{end}}' praxis-muse-operador | sort
# → exactamente las cinco filas de la tabla, con RW=false en las dos primeras
docker inspect --format '{{range $red, $_ := .NetworkSettings.Networks}}{{$red}} {{end}}' praxis-muse-operador
# → solo su red propia
docker exec -u 1000:1000 praxis-muse-operador sh -c \
  'test ! -e /opt/cauce-v3-secrets && test ! -e <home-del-contenedor>/.openclaw && test ! -e /var/run/docker.sock \
   && ! test -w /opt/cauce-hospital/runtime && ! test -w /opt/cauce-hospital/runtime/muse-cli-backend.py && echo aislado'
# → aislado
```

**Temporales.** El backend escribe el prompt (`0600`) en `$TMPDIR/muse-openclaw-*` y lo borra al salir. Si lo matan con `SIGKILL`, el siguiente arranque barre los directorios propios con más de `TIMEOUT_SECONDS` + 300 s (45 min), sin seguir enlaces ni tocar los de otro uid. En el contenedor propio, `/tmp` es tmpfs y no sobrevive a un reinicio.

**Retención de `~/.muse/data`.** Es el `XDG_DATA_HOME` de Muse: sesiones y transcripciones, que incluyen las instrucciones de sistema del operador y contenido sintético de Praxis (nunca datos clínicos reales: la raíz lo prohíbe). Política: vive solo en el montaje de estado de su contenedor (nunca en el workspace ni en Git); las sesiones sin actividad en 30 días se purgan por sesión con Muse detenido (una sesión purgada ya no se puede reanudar); entra en la copia cifrada del host con la retención de las copias; y al retirar el fallback se borra junto con su login de Muse. Vale igual para `state-muse-backend` y `state-muse-frontend`. La purga automática (timer) está pendiente.

### Alta e importación de Praxis en la V4 central

Un solo comando, `cauce platform empresa importar`, hace todo en una transacción de la base central:

- **Alta de `praxis` con León de owner** por `cauce_register_company`, la misma vía que `POST /v3/console/companies`: la empresa, su hub, la sala `office`, el actor `owner` de León, su membresía y `company_admins` nacen juntos.
- **Topología del hospital** desde el inventario versionado `ops/instances/hospital/praxis-v4.json`, aplicada con la transferencia de configuración de la plataforma (`plan-import` + `import`): tenant `Hospital` (no hub), sala `grp.hospital`, agentes `operador`, `perseo` y `teseo` como **borradores inactivos** y sus tres membresías. Añade las aristas hub ↔ `Hospital` con ruta y lectura, sin control.
- **Verificación de aislamiento** antes de confirmar. Si una comprobación falla, no se confirma nada:
  - `inventory_tenants_belong_to_company` y `company_has_one_hub`;
  - `agents_belong_to_their_tenant_company`;
  - `no_cross_company_routes` y `no_company_links`;
  - `owner_confined_to_company`: León solo tiene membresías y rol de admin en `praxis`, y no es `platform_admin`;
  - `owner_acts_only_on_company`: aunque pida `humanizar`, su autoridad resuelve `company_owner` de `praxis`;
  - `foreign_administrators_excluded`: ningún owner o admin de otra empresa que no sea `platform_admin` actúa sobre `praxis`;
  - `other_companies_unchanged`: la configuración, las personas y los admins de Humanizar quedan idénticos.
- **Perfiles**, con `--perfiles`. Cada agente en borrador recibe el perfil vivo del hospital como versión 1 de su contexto (`agent_profiles` y `agent_context_versions`, origen `profile`). Este paso se ejecuta después de confirmar y nunca pisa un perfil que ya exista: si León lo edita, la repetición informa `kept_differs` y lo conserva. Solo prepara borradores; el perfil de un agente ya activo se edita desde la consola o con `cauce context`.

Es idempotente: si se repite, la salida da `owner.state=existing`, `mutations: []` y perfiles `existing`, y no escribe nada. `--dry-run` ejecuta todo, incluida el alta, y lo deshace. Es el ensayo sobre la base real y deja libres los bloqueos de configuración de las empresas en segundos. El correo nunca entra al repositorio: llega por `--email` o por `CAUCE_IMPORT_OWNER_EMAIL`. La contraseña inicial llega por un archivo privado, nunca por argumento.

Antes de conectar, el comando rechaza la deriva: si el hospital tiene un agente vivo que el inventario no declara, o al revés, falla con código 2. No importa:

- `console-proxy`, el actor de consola de la V3: en V4 cada persona actúa con su propia identidad;
- `praxis-supervisor`, la identidad del servicio de supervisión, que se crea al migrar ese servicio;
- los alias viejos `backend` y `frontend`, ya deshabilitados;
- las plantillas de rol, porque su texto viaja en el perfil;
- contenedores, montajes, cuentas de proveedor, espacios ni credenciales: eso es la migración física (§5).

También se ejecutó dentro de una imagen de runtime local (esquema 079), con usuario 1000, raíz de solo lectura, sin capacidades y con los archivos montados como los monta `cauce platform contenedor`. Contra un PostgreSQL desechable por loopback y sin TLS, dio ensayo, aplicación y repetición sin cambios.

Probado de punta a punta en `ops/tests/empresa-importar.test.mjs`. La prueba levanta dos bases PostgreSQL reales por Testcontainers: la V3 del hospital (esquema 043 con `bootstrap.sql` y `enable-praxis.sql`), de la que exporta los perfiles con el SQL de abajo, y la V4 central con Humanizar. Importa con el owner ficticio `zz-canary` y comprueba el ensayo sin filas, el rechazo sin contraseña, la importación, el login con la contraseña inicial, la autoridad de cada lado, la repetición sin escrituras, la edición conservada, el dueño ajeno, el correo ya usado en Humanizar y el rechazo con una ruta entre empresas.

**Procedimiento cuando llegue el correo de León.**

Requisitos previos:

- el release desplegado contiene estos commits;
- en la base central ya hay un `platform_admin` activo, que actúa de forma implícita; si no lo hay, primero se ejecuta `ops/cli/cauce platform contenedor admin semilla --email <correo-de-Steven>`.

1. Exportar en solo lectura los perfiles vivos del hospital y dejarlos en un directorio privado del host de producción. Se ejecuta desde donde funciona `ssh hospital`; la transacción del SQL es `READ ONLY`.

   ```sh
   ssh hospital 'sudo -n docker exec -i hospital-cauce-postgres-1 psql -U cauce_hospital -d cauce_hospital -X -A -t -q -v ON_ERROR_STOP=1' \
     < ops/instances/hospital/praxis-perfiles-export.sql \
     | ssh <usuario>@<host-prod> 'umask 077 && mkdir -p ~/.local/state/cauce-praxis && cat > ~/.local/state/cauce-praxis/perfiles.json'
   ```

2. En el host de producción, desde el checkout del release y con el usuario uid 1000, fijar los datos y generar la contraseña inicial. El contenedor corre como uid 1000 y solo acepta archivos privados de ese uid.

   ```sh
   cd <checkout-del-release>
   umask 077
   PRAXIS=~/.local/state/cauce-praxis
   read -r CORREO_LEON
   openssl rand -base64 24 > "$PRAXIS/clave-leon"
   ```

   `read` lee el correo sin dejarlo en el historial.

3. Ensayo completo, que se deshace:

   ```sh
   ops/cli/cauce platform contenedor empresa importar --inventario "$PWD/ops/instances/hospital/praxis-v4.json" \
     --perfiles "$PRAXIS/perfiles.json" --email "$CORREO_LEON" --nombre 'León' --dry-run
   ```

   Debe dar:
   - `owner.state=planned` y `password_required=true`;
   - 10 mutaciones: el tenant, la sala, 3 agentes, 3 membresías y 2 aristas;
   - los tres perfiles `planned`;
   - todas las comprobaciones de `isolation` con `ok: true`.

   Un código 1 o 2 no deja nada escrito.

4. Copia previa de la base central: `sudo systemctl start cauce-v3-host-backup.service`, y comprobar `overall == "ok"` en `/var/log/cauce-v3-backup/status.json`.

5. Aplicar: el mismo comando con `--clave-archivo "$PRAXIS/clave-leon" --apply`. Debe dar:
   - `owner.state=created`;
   - las mismas mutaciones;
   - los perfiles `prepared`;
   - `isolation` en verde.

6. Repetir el paso 3. Debe salir `owner.state=existing`, `mutations: []`, perfiles `existing` e `isolation` en verde.

7. Comprobar por HTTP:
   - León inicia sesión y `GET /v3/auth/session` da `company_owner` con `acting_company=praxis`;
   - la consola le muestra `Hospital` con los tres borradores;
   - con la sesión de Miguel, `GET /v3/console/companies/praxis` responde 403.

8. Entregar la contraseña a León por un canal privado y borrar los archivos: `shred -u "$PRAXIS/clave-leon" "$PRAXIS/perfiles.json"`. Para rotarla, Steven la cambia en «Personas» (`PATCH /v3/console/people/:id` con `password`).

Reversión: `ops/cli/cauce platform contenedor empresa estado --empresa praxis --estado retired --si`. Retira la empresa, revoca la autoridad y conserva los datos. La V3 del hospital no cambia en ningún paso.

**Pendiente tras la importación.** Lo pendiente depende de la migración física y del dueño:

- los agentes siguen en borrador hasta enrolar el servidor de destino y crearlos con la operación de flota (harness, `runtime_key`, colocación y cuenta);
- el servicio de supervisión de Praxis y su identidad `praxis-supervisor` en V4;
- el puente Muse aislado del operador;
- la copia verificada del hospital (riesgo 8 de §5);
- el corte con la V3 sin escritores y su retirada.

## 5. Propuesta de ubicación

| Agente | Vía | Host | `--memory` | `--cpus` | Base (medido hoy) |
|---|---|---|---|---|---|
| **Gaia** | overlay V3 `dockerHost=server2` | server2 | 1 GiB | 1,5 | 270 MiB contenedor, 291 MiB RSS |
| **Hades** | overlay V3 `dockerHost=server2` | server2 | 1 GiB | 1 | 240 MiB contenedor, 214 MiB RSS |
| **Argos** | flota V4 (el único colocable hoy); respaldo: overlay V3 | server2 | **3 GiB** | 2 | 1,38 GiB RSS propio y 1,50 GiB de contenedor; con 2 GiB quedarían 0,6 GiB para los picos de `claude -p`, `codex app-server` y Chrome |
| **Hegel** | overlay V3, **contenedor propio nuevo** (sin `ws-humanizar`) | server2 | 2 GiB | 2 | 144 MiB en reposo; los turnos de Muse con herramientas y Playwright crecen |
| **Praxis**: operador + navegador, perseo, teseo, ventas, crm | perseo y teseo (muse), igual que Hegel; operador (openclaw con xAI) por flota V4 si su driver lo soporta (§7) o por overlay; ventas, crm y navegador como servicios del mismo host | **server1** si el dueño aprueba instalar Docker; si no, server2 tras los cuatro | operador 1,5 GiB, navegador 1 GiB, perseo 1 GiB, teseo 1 GiB, ventas 768 MiB, crm 256 MiB, cdp-proxy 64 MiB | 1–2 cada uno | ~2,5 GiB |

En la vía de flota V4 esos topes no se pasan como banderas sueltas de Docker ni como un campo de límites del plan de corte: se declaran como ampliación `resources` del agente antes de crear el destino, y el executor los aplica y los valida como parte de la forma aprobada. En la vía de overlay V3 siguen siendo los límites del contenedor de esa vía.

- **Balance de server2**: hoy usa 12,1 GB y tiene 11,6 GiB disponibles. Con los cuatro agentes (~2,2 GiB medidos) quedaría con **~9,5 GiB disponibles** y ~7 GiB si Minecraft llega a su tope de 12 GiB. Los límites sumarían 27 GiB sobre 22,8 físicos: son topes, no reservas, pero por eso Praxis no se apila en server2 salvo necesidad. Disco: imágenes (~6 GB si Gaia y Hades comparten capas) y datos (Gaia ~0,9 GB, Hades ~2,3 GB, Argos ~3–4 GB seleccionados, Hegel 36 MB + repos) caben de sobra en 149,8 GB.
- **server1**: reserva y destino preferido de Praxis (278 GB libres, 11,3 GiB disponibles), pero **no tiene Docker**: instalarlo es una decisión del dueño. **server3** se descarta: 7,1 GiB de RAM con la mitad ocupada por los navegadores `nav-*`.
- **Cómo es el overlay V3 (patrón Salva)**: en el repo, `ops/flota-fisica.json` lleva `placement.<alias> = {"dockerHost": "server2", "systemdUser": "server"}` (hoy solo Salva; Kant y Astra solo `systemdUser`). Se regenera con `ops/scripts/regenerate-fleet.sh` (pasa a `ops/container-aliases.json`) y se valida con `ops/scripts/validate.sh`. `container-alias-query.py --route` resuelve `ssh:server@server2` para el CLI. En server2, como `server` (UID 1000, linger), se instalan: `~/.config/systemd/user/cauce-v3-container-<alias>.service` con `CAUCE_CONTAINER_OPS_ROOT=%h/.local/share/cauce-v3-release-tools/<sha>/ops`, `CONFIG_ROOT=%h/.config/cauce-v3/container-aliases` (`<alias>.env`), `PKI_ROOT=%h/.config/cauce-v3/container-pki` y `BUNDLE_ROOT=%h/.local/share/cauce-v3-adapter`; el *drop-in* `90-migration-prepared.conf` con `ConditionPathExists=%h/.config/cauce-v3/<alias>-migration.ready` como interruptor del corte; `cauce-v3-pty@<alias>.service`. El repo define `cauce-cred-guard-kratos.timer`, que publica la medición de credenciales de Kratos a la VPS; no define un timer `cauce-cred-guard-server2.timer`. Salva corre hoy así (`cauce-migration/ws-isa:20260908`, 6 GiB, 2 CPU). Detalle: `docs/v3.5-despliegue-flota.md`.
- **Orden canario**: **Gaia → Hades → Argos → Hegel → Praxis**, uno cada vez. Antes de cada corte: medición «antes» (§6.1) y copia con manifiesto y restauración de prueba (§6.3), cifrada a kratos y Drive; ensayo de reversión con Gaia; origen detenido antes del primer refresco de credenciales en destino. Se acepta por alias con: nonce respondido por Cauce desde server2, terminal por CLI y web, cuota de su cuenta, contexto aplicado (versión y digest), host nuevo en la UI, edición de contexto N+1 desde la UI y detener/arrancar aplicado en el host nuevo. En Argos, además, que inspeccione la VPS desde server2. El origen se libera tras 7 días sin incidentes y se mide «después» con el mismo script y el mismo alcance (§6.1, `--alcance-de`).
- **Normalización durante el traslado** (manifiesto ruta vieja → nueva con sha256):
  - **Gaia**: clonar `gaia-clawd` en el mismo HEAD → `space/projects/gaia-clawd`; `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` y `00-CONTEXTO-ACTUAL.md` → `space/context` como primera versión; catálogo y documentos de negocio → `space/data`; sin `.bak`.
  - **Hades**: `~/.grok/AGENTS.md` → `space/context`; `xenia` por Git → `space/projects/xenia`, con sus JSONL de `data/` por manifiesto; los 440 ficheros sueltos → `space/data/envios` y `space/data/notas`; fuera `__pycache__` y `*.hdr`.
  - **Argos**: contexto y directivas de `clawd` → `space/context` y `space/directives`; los 7 repos → `space/projects` por Git; informes → `space/data`; ni `/workspace` ni los ficheros `*.local*`.
  - **Hegel**: espacio nuevo vacío más los repos que él indique.

### Riesgos y bloqueos

1. **Swap de la VPS al 100 %** con 28,4 GiB disponibles: el prechequeo de deploy (≥ 8 GiB) pasa, pero la presión es real; el ahorro de la migración es modesto (~2,1 GiB de RSS).
2. **Disco liberable**: imagen de Hades (2,84 GB, única) y capas escribibles de Gaia (2,77 GB) y Hades (0,19 GB), más 3,2 GB de volúmenes. `claw:latest` **no** se libera (la usan `claw`, `claw-iza` y `claw-miguel`) y `ctrl-infra` y `ws-humanizar` se quedan.
3. **Credenciales en fichero compartido o en la capa del contenedor**: Argos usa los ficheros sueltos `<disco-de-datos>/agents/shared/.codex/auth.json` y `.claude/.credentials.json`, que también montan otros contenedores. Copiarlos a server2 duplica un refresh token que rota y deja una de las dos copias inválida, así que el corte exige el origen detenido y un fichero propio por alias en destino. Las credenciales y la clave SSH de Gaia viven en la capa escribible: hay que copiarlas en privado (decisión del dueño, §3) antes de cualquier `docker rm`.
4. **Argos pierde su posición en la VPS**: necesita acceso remoto mínimo (Tailscale a un docker-socket-proxy de solo lectura publicado en la malla, o SSH con comando restringido) y, para los `ws-*`, otra vía que su red `net-claw-ws`. Los parches de los guardias de root (gateway y fallback) deben venir en la imagen de destino o en su release. Gaia, Jarvis, Iza y Janus pierden el shim `:18799` solo si se apaga `ctrl-infra`, que no se apaga.
5. **Hegel sin lista de repos** hasta que responda por Cauce; Atlas y Kratos no se tocan.
6. **Hades**: el binario de grok se monta desde el host y hay que llevarlo con la misma versión (1.0.41); los `*.hdr` son material sensible.
7. **server2 con límites sobrecomprometidos** (27 GiB de topes sobre 22,8 físicos) y Minecraft al 77 % de su tope.
8. **Hospital sin backup válido**: `hospital-cauce-backup.service` falla desde al menos el 11-oct con «La restauración aislada no conserva la topología Hospital» y su monitor también está en fallo. Antes de mover Praxis hace falta una copia verificada.
9. **Código del hospital fuera de V4**: hay que portar `socrates/hospital-supervision-1699` (§3 de las órdenes) antes de mover un agente de Praxis. El canal WhatsApp de ventas exige revincular o copiar su estado en privado.
10. **Pendientes de solo lectura no resolubles**: titulares de Claude (Gaia), Grok (Hades) y Muse (Hegel, Praxis) sin identificar; correo de León ausente; Kant sin consultar (escribirle por Cauce no es solo lectura); `cauce-v3-profile-expectation@*` en fallo en la VPS y en server2.

## 6. Paquete previo a cada corte: medición, copia y terminal

Todo sale de un único punto de entrada, `ops/scripts/v4-medicion-migracion.sh`. La medición se ejecuta en el host medido, en local o enviada por ssh. La copia se ejecuta donde viven los datos. Nada de esto detiene, reinicia ni modifica el agente. La ejecución del corte (canario Gaia → Hades → Argos → Hegel) es del dueño y del orquestador.

### 6.1 Medición antes/después con un único alcance

```sh
# «antes», en la VPS y antes del canario
ops/scripts/v4-medicion-migracion.sh medir --ssh <usuario>@<host-prod> --label antes \
  --out .delegados/v4/recibos/vps-antes-<fecha>.json gaia hades argos hegel
# «después», tras el canario, con el alcance copiado del «antes»
ops/scripts/v4-medicion-migracion.sh medir --ssh <usuario>@<host-prod> --label despues \
  --alcance-de .delegados/v4/recibos/vps-antes-<fecha>.json --out .delegados/v4/recibos/vps-despues-<fecha>.json
ops/scripts/v4-medicion-migracion.sh verificar <recibo.json>
ops/scripts/v4-medicion-migracion.sh comparar <antes.json> <despues.json>
```

- **Host**: `free -b`, swap, `df -B1 /`, carga, `docker stats --no-stream` y `docker inspect --size` (imagen, capa escribible, límites, montajes). También la identidad física observada: hostname, huella de `/etc/machine-id` (16 hex) y nombre del demonio Docker.
- **RSS por proceso**: es la suma del árbol que cuelga del adaptador (`--alias <alias>`), del agente PTY, del panel tmux `cauce-<alias>` y, en openclaw, del gateway. Se desglosa por ejecutable (`comm`). Las líneas de comando solo se usan en memoria en el host medido; el recibo nunca lleva argumentos ni entorno.
- **Alcance único de tamaños**: se deriva de `ops/container-aliases.json` y va dentro del recibo con su propio `scopeSha256`. Por alias incluye:
  - `estado` (`stateDirectory`), `configuracion` (`<home>/.local/share/cauce-v3/config/<alias>`, el login y el perfil del arnés) y `espacio` (`workspace`, si existe);
  - todos los montajes del contenedor.

  Un montaje es **propio** si el contenedor solo sirve a ese alias y ningún otro contenedor monta el mismo origen, un ancestro o un descendiente. Si no, es **compartido**. `ownBytes` suma los montajes propios y las rutas del alias que no caen dentro de ellos (capa escribible o montaje compartido), sin contar dos veces una ruta anidada. `sharedBytes` suma los compartidos: en Hegel, todo `ws-humanizar`, `/workspace` incluido. Todo se mide con `du --apparent-size` dentro del contenedor (solo metadatos, sin leer contenido), excluye los montajes anidados y mide una sola vez el origen montado por varios contenedores. El alcance de los cuatro sale con `scopeSha256` `633eba320a634271fc5e9a0e578f46bc6a872a1e24b385212261c1e99fa8a422`.
- **Reconciliación**: las cifras «Gaia 3 MB, Hades 498 MB, Argos 52 MB y Hegel 30 KB propios» no tienen recibo ni alcance escrito, y no cuadran con el inventario del §2 (Gaia monta 105 MB + 786 MB; Hades, 2,29 GB). Quedan sustituidas por `aliases.<alias>.ownBytes` y `sharedBytes` del recibo «antes». La capa escribible del contenedor va aparte (`containers.<c>.writableBytes`).
- **Comparación**: `comparar` exige los dos sellos y el mismo `scopeSha256`. Da la diferencia de RAM disponible y usada, swap, disco y memoria y capa por contenedor, y por alias la de RSS, `ownBytes` y `sharedBytes`. Un alias que ya no corre en el host cuenta como 0 allí. El disco que de verdad libera el origen, que se conserva 7 días, lo da `diskUsed`.
- `--out` no sobrescribe un recibo y lo crea con permisos 0600.

### 6.2 Precedente de Salva en server2 (`dockerHost`)

```sh
ops/scripts/v4-medicion-migracion.sh medir --ruta-declarada --label precedente-salva \
  --out .delegados/v4/recibos/precedente-salva-<fecha>.json salva
```

`--ruta-declarada` no elige el host: mide por ssh justo la ruta que declara la configuración (`placement.salva.dockerHost` → `ssh:server@server2`). El recibo lleva `correlation.salva` con:

- `declaredRoute`, `measuredVia` y `routeMatches`;
- si `ws-isa` corre y si hay adaptador o panel de `salva`;
- `correlated`, más la identidad física observada en `host`.

Con `correlated: true` el precedente queda probado en solo lectura.

### 6.3 Copia recuperable y restauración de prueba

```sh
# en el host de origen, con el agente detenido; los orígenes son rutas del host (origen de cada montaje)
ops/scripts/v4-medicion-migracion.sh copiar --alias gaia --empresa Miguel \
  --origen clawd=<datos>/tenants/<tenant>/agents/gaia/oc/clawd \
  --origen openclaw=<datos>/tenants/<tenant>/agents/gaia/oc/.openclaw --destino <copia-gaia>
ops/scripts/v4-medicion-migracion.sh comprobar-copia <copia-gaia>
ops/scripts/v4-medicion-migracion.sh restaurar <copia-gaia> --alias gaia --empresa Miguel --recibo <restauracion-prueba.json>
# traslado con normalización al espacio de destino
ops/scripts/v4-medicion-migracion.sh restaurar <copia-gaia> --alias gaia --empresa Miguel \
  --destino <espacio> --propietario <uid>:<gid> \
  --mapa clawd=projects/gaia-clawd --mapa openclaw=data/openclaw --omitir '*.bak*' \
  --duplicar clawd/AGENTS.md=context/AGENTS.md --recibo <restauracion-gaia.json>
```

- **Proyectos por Git**: cada repositorio (también los anidados) viaja como bundle con todas las refs y el HEAD. El manifiesto guarda el HEAD, la rama y los remotos sin credenciales; los remotos que ejecutan comandos (`ext::`) se descartan. Lo modificado, lo no seguido y lo ignorado viaja como datos. Lo seguido que falta en disco queda como `deleted`.
- **Datos con manifiesto**: cada fichero lleva ruta, modo, tamaño y sha256. El almacén es direccionable por contenido y el manifiesto va sellado con sha256.
- **Omisiones con motivo**, sin leer el contenido:
  - por nombre: `auth`, `session`, `token`, `profile` y `credential` (`.ssh`, `.env`, claves, `*.hdr`, etc.); los nombres se normalizan con NFKC antes de compararlos;
  - `regenerable`: `node_modules`, `__pycache__`, cachés;
  - `special`: sockets y FIFOs;
  - `symlink-outside`: enlaces con destino absoluto o fuera del árbol.

  Además, `sensitive-content` deja fuera cualquier otro fichero cuyo contenido lleve material de credenciales: claves privadas, tokens conocidos, JWT, userinfo en una URL o asignaciones de secretos. Así se cubre también un enlace duro con nombre inocente. Lo ya commiteado viaja en el bundle igual que está en el remoto y queda listado en `trackedSensitive`. Las credenciales de cada alias se trasladan en privado por decisión del dueño (§3), nunca por esta copia.
- **Acotada al alias y a su empresa**: `copiar` lee de `ops/container-aliases.json` el contenedor, la empresa y las rutas del alias, y de `docker inspect` dónde viven en el host. Rechaza:
  - un `--empresa` que no sea la del alias;
  - un origen fuera del espacio del alias. El espacio son sus rutas de estado, configuración y espacio y, si el contenedor solo lo sirve a él, sus montajes no compartidos;
  - un origen que contenga un volumen de otro contenedor;
  - un origen que se solape con las rutas de otro alias del mismo contenedor (`ws-humanizar`: Hegel no puede llevarse nada de Atlas ni de Kratos).

  El manifiesto registra `tenant` y `container`. Además, `restaurar` exige `--alias` y `--empresa` iguales a los de la copia y rechaza cualquier ruta del manifiesto fuera de los orígenes copiados.
- **Seguridad del recorrido**: se recorre por descriptores con `O_NOFOLLOW`, se verifican dispositivo, inodo y tipo, y se hashea y copia desde el mismo descriptor. Si un fichero cambia o se sustituye por un enlace a mitad de la copia, la copia aborta: hay que detener el agente y repetirla.
- **Restauración**: valida el manifiesto entero antes de escribir y exige un destino vacío y propio que no sea un enlace. No escribe a través de enlaces, quita setuid, setgid, sticky y la escritura global, y como root exige `--propietario`. Sin `--destino` restaura en un temporal y lo borra al terminar. El recibo lista cada ruta vieja → nueva con su sha256, los HEAD comprobados, lo excluido por el layout y los problemas; `verified: true` significa que el árbol restaurado coincide con el manifiesto.
- La copia es un directorio 0700. Cifrarla y llevarla a kratos y a Drive corresponde a la canalización de copias existente.

### 6.4 Terminal por CLI con un agente real

`ops/tests/test-cauce-cli-dynamic.py` incluye un recorrido real con un contenedor desechable y tmux real en el host local:

1. `cauce <alias> ver` muestra la sesión nominal `cauce-<alias>:agente`.
2. `cauce <alias>` entra en un pty real, ve la marca de la sesión y sale con Ctrl-b d (exit 0).
3. `on` y `off` se rechazan sin reiniciar el runtime.
4. No quedan clientes tmux, procesos, contenedores ni imágenes.

Sin Docker se salta, salvo con `CAUCE_REQUIRE_REAL_DOCKER=1`. Con un agente ya migrado, el frente de migración repite el mismo conductor contra el CLI instalado:

```sh
python3 ops/tests/test-cauce-cli-dynamic.py recorrido hades   # o hegel; Gaia y Argos (openclaw) usan la consola
```

Imprime `{"alias", "exit", "sawSession", "detached", "seconds"}` y sale con 0 solo si entró, vio `cauce-<alias>` y salió desacoplado.

## 7. Corte coordinado en una orden

`ops/scripts/v4-mover-agente.sh gaia` y `--simular` describen el recorrido sin red ni escrituras. El corte explícito es:

```sh
ops/scripts/v4-mover-agente.sh gaia --ejecutar
```

Lee el plan privado `.delegados/v4/migracion/gaia.json`; `--plan`, `--alias-config` y `--recibos` permiten elegir sus ubicaciones. No instala ni despliega Cauce. Reutiliza las operaciones V4 y la sesión nominal creada con `cauce login`; no copia credenciales de proveedor ni cambia de cuenta. Los prerrequisitos se preparan una vez antes de la ventana: server2 enrolado, ejecutor y plantilla del harness disponibles, imagen aprobada cargada, cuenta original vinculada y autenticada en destino, contexto inicial versionado y terminal operativa. El origen debe estar bajo control de V4, con sus supervisores legados retirados de la escritura. El prechequeo rechaza colocaciones, bindings y alcances inválidos antes de detener. Los límites del destino no van como un campo suelto del plan: el plan se rechaza si trae límites fuera de `extensions`, y los topes de cada agente se declaran como ampliación `resources` antes de crear el destino.

Si la operación del destino queda esperando el login del proveedor con los pasos de preparación, archivos, cuenta y entorno ya acreditados, el corte no vuelve atrás solo: termina como `moved_pending_login`, conserva el origen detenido y retenido, y deja pendientes el login, la adopción de contexto, el nonce, la cuota y la terminal. La reversión en ese estado es siempre una orden explícita sobre el recibo del corte; nunca automática por tiempo ni por el propio comando de corte.

Esqueleto del plan de Gaia, que el orquestador completa con las rutas y el digest de la instalación aprobada:

```json
{
  "company": "humanizar",
  "tenant": "Miguel",
  "session_file": "/ruta/privada/sesion-cauce.json",
  "source": {"route": "ssh:usuario@host-prod", "machine_id_sha256": "HUELLA_16_HEX_DEL_ORIGEN"},
  "destination": {
    "route": "ssh:server@server2",
    "host_id": "server2",
    "machine_id_sha256": "HUELLA_16_HEX_DEL_DESTINO",
    "mode": "container",
    "image": "sha256:DIGEST_DE_LA_IMAGEN_APROBADA"
  },
  "roots": [
    {"name": "clawd", "path": "/datos/raiz-propia/clawd", "target": "projects/gaia-clawd"},
    {"name": "openclaw", "path": "/datos/raiz-propia/.openclaw", "target": "data/openclaw"}
  ],
  "timeout": 300
}
```

El plan es propio y no escribible por otros usuarios. No contiene contraseñas, cookies ni tokens. `session_file` referencia la sesión local existente, nunca una sesión exportada de otro runtime. `ca_file` permite usar una CA privada ya instalada. Las huellas son los primeros 16 caracteres hexadecimales del SHA-256 de `/etc/machine-id`, como en los recibos de medición. Para Hades, Argos y Hegel cambian las raíces exclusivas y sus mapas según §2; no se incluye `/workspace` compartido. Hegel necesita su inventario de repos resuelto. El copiador aplica los límites de alias y tenant de `container-aliases.json` y los montajes observados, también en contenedores compartidos. Antes y después de detener comprueba que las raíces declaradas cubren todas las raíces de datos propias; un subdirectorio que deje fuera SQLite no acredita copia completa.

El comando ejecuta y conserva un recibo privado por corte:

1. Resuelve la colocación y conserva identidad, harness, cuenta, modelo, esfuerzo y membresías; comprueba destino, imagen y volúmenes. Compara identidades físicas para impedir trasladar los agentes reales al mismo ordenador.
2. Mide la VPS con `v4-medicion-migracion.sh` y acredita primero nonce, contexto y terminal del origen, necesarios para verificar una reversión.
3. Detiene únicamente el alias por V4 y realiza la copia integral antes de iniciar el destino. Conserva Git completo, índice, cambios locales, archivos ignorados, sesiones de trabajo y SQLite con sus acompañantes WAL/SHM. Compara inventarios y hashes antes y después: una escritura concurrente invalida la copia.
4. Restaura en `state_directory/space`, con los siete directorios estándar y los mapas declarados. En Docker usa el volumen de estado con las mismas etiquetas que exige el ejecutor y el UID/GID del runtime. No escribe sobre un destino ocupado. Conserva un manifiesto de ruta antigua, ruta nueva y hash.
5. Envía `update` con la colocación nueva por la flota V4. Aplica los topes de §5 como ampliación `resources` declarada en el plan antes de crear el destino: Gaia 1 GiB/1,5 CPU, Hades 1 GiB/1 CPU, Argos 3 GiB/2 CPU y Hegel 2 GiB/2 CPU. Si la operación queda en `awaiting_auth` con la creación del entorno ya acreditada, el corte termina aquí como `moved_pending_login` (ver el párrafo del plan): el recibo conserva el destino pendiente, el origen retenido sin borrado automático y la orden exacta de reversión manual. Los pasos siguientes solo se exigen cuando el login ya se completó.
6. Reaplica el contexto mediante la recarga existente si su contrato todavía pertenece a la generación anterior, sin cambiar su revisión; después exige nonce respondido por el agente a través de Cauce, contexto versionado aplicado, adopción viva del perfil, host/cuenta/harness visibles en el inventario y terminal WebSocket abierta por el CLI existente. En terminal de shell comprueba además un nonce escrito y leído en la sesión.
7. Mide otra vez la VPS con el alcance sellado del «antes» y guarda la comparación. No elimina el origen, sus imágenes ni sus datos.

La copia integral se transporta por SSH y permanece privada, con archivo `0600` y directorio `0700`. Excluye credenciales por rutas concretas y cachés regenerables, con motivo en el manifiesto; nombres de código como `auth.ts`, `token.py` o sesiones de trabajo no son credenciales. Si detecta un secreto de formato inequívoco fuera de esas rutas, aborta para que el dueño lo separe: no omite silenciosamente SQLite ni otros datos. Un enlace simbólico que sale de su raíz no se sigue ni se restaura: queda omitido con motivo `external-symlink` y la huella de su destino en el manifiesto. Rechaza almacenamiento Git externo y archivos especiales no regenerables. Esta copia de corte complementa las copias filtradas de §6.3; no las convierte retrospectivamente en respaldos completos.

La parada dura desde el inicio de `stop` hasta terminar las verificaciones del destino; `recibo.json.outage_seconds` registra su duración real. Incluye inventario, transferencia, restauración, activación y respuesta del proveedor: no se promete el tiempo del ensayo para los datos reales. Los pasos y operaciones conservan sus duraciones e identificadores. Un fallo posterior al corte que no sea el login pendiente, incluidos SIGINT/SIGTERM, cancela y espera cualquier operación pendiente y ejecuta `update` inverso antes de verificar nonce, contexto y terminal desde el origen. Si el fallo ocurre antes de la relocalización, ejecuta `start` en origen. El login pendiente (`moved_pending_login`) es la excepción: no dispara esa vuelta atrás y solo se revierte con la orden explícita que guarda el propio recibo. La aceptación desconocida o una cancelación no acreditada detienen la recuperación para evitar dos consumidores; el recibo queda `rollback_failed`, sin afirmar éxito.

Ensayo local del comando: traslado del agente desechable con parada de **12,674 s** y copia de **0,209 s**; fallo real de la shell de destino (`/bin/false`) con recuperación automática verificada en **22,212 s**. Se usaron PostgreSQL, gateway, enrolamiento, autoridad, flota, SDK y terminal reales, con dos colocaciones lógicas en el mismo ordenador y un proveedor sintético. Los hashes y SQLite quedaron comprobados. Los recibos están en `.delegados/v4/recibos/20261017T204657-mover-agente-un-paso/`. Este ensayo acredita el encadenado y la reversión; las mediciones del contenedor auxiliar no acreditan ahorro de RAM de los agentes reales ni un traslado físico a server2.

Para el canario Gaia: preparar enrolamiento, binding, autenticación privada y contexto inicial; comprobar que el origen ya depende exclusivamente del controlador V4; completar el plan con los dos montajes inventariados en su informe preparatorio; ejecutar primero la simulación y luego la orden de corte. Revisar `recibo.json`, restauración, nonce, terminal, contexto y mediciones. Contrastar además la cuenta/cuota y el host en la consola, y verificar una edición N+1. El origen se conserva al menos siete días y se obtiene copia cifrada externa antes de retirarlo. La orden no acredita por sí sola esa réplica externa, una cuota fresca del proveedor ni un despliegue productivo. Un SIGKILL o pérdida del host del operador exige recuperar usando el diario y la historia durable de operaciones; no hay un supervisor de migración nuevo.
