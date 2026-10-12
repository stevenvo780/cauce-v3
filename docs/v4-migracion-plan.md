# Plan de migración de agentes a servidores locales (medición del 12-oct-2026)

Plan de la §5 del goal (`GOAL.md` y `ordenes/v4-cierre-objetivo.md` §4 «§5»): mover **Gaia, Hades, Argos y Hegel** fuera de la VPS principal y **retirar Cauce del hospital** moviendo los agentes de **Praxis**. Todo lo de este documento se obtuvo en **solo lectura** entre las 21:38 y las 21:56 UTC del 12-oct-2026: no se detuvo, reinició, copió ni borró nada, no se cambió ninguna cuenta y no se abrió ninguna credencial, `auth.json`, `.env` ni fichero de sesión. Las cuentas se identifican por los comandos de estado de cada CLI, por `cauce <alias> login --ver` (comando del repo que imprime tipo, huella corta e id de cuenta) y por las huellas que ya publica `cauce-cred-guard`; aquí se recortan a 8 caracteres.

Sustituye al censo del 11-oct (GPT), que medía tamaños pero no fijaba ubicación, bindings ni dependencias.

## 1. Medición del día

### VPS principal (`167.114.118.213`, 16 núcleos)

Recibo «antes»: `.delegados/v4/recibos/vps-antes-20261012.json`, generado por `ops/scripts/measure-vps-footprint.sh` (§6) a las **21:51:35 UTC**. Sello interno `sha256` `04e2bdac6da521df322f2cb787317ab582f3c1c7011d45528697f7c5011087a5`; sha256 del fichero `31454938df12e3abcbf7ab2fbd6b5465b778591f6e0e313c7a838fe84360e93f`.

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
| server1 `100.64.0.14` | 21:45:52 | 6 × i5-8400T | 22,8 GiB / **11,3 GiB** | 62 MiB de 8 GiB | **278,5 GB** (54 % usado) | **no** (LXD) | LXD `escritorio-steven` (contenedor, 6,3 GiB) y `pc-agente` (VM, 5,3 GiB); `cauce-audio-cpu.service` |
| server2 `100.64.0.13` | 21:45:53 | 6 × i5-8400T | 22,8 GiB / **11,6 GiB** | 53 KiB de 8 GiB | **149,8 GB** (69 % usado) | 29.1.3; `server` en el grupo `docker` | ver tabla siguiente |
| server3 `100.64.0.16` (`ils-server`) | 21:46:26 | 4 × i5-7400 | **7,1 GiB / 3,5 GiB** | 0 de 4 GiB | 85,9 GB (22 % usado) | sí, solo con `sudo`; `server3` sin linger | 8 contenedores `nav-*` (linuxserver/chromium, ~400 MiB cada uno, 3,2 GiB) y servicios `nav-*-puente`, `nav-dns-usa`, `nav-exit-usa` |

server2 por contenedor:

| Contenedor | Memoria | Límite |
|---|---|---|
| `rpg-dos-almas` (Minecraft) | 9,22 GiB | 12 GiB (77 %) |
| `ws-isa` (Salva) | 859 MiB | 6 GiB, 2 CPU |
| `cuota-claude-1`, `cuota-claude-3`, `cuota-codex-b2b`, `cuota-grok-1` | 108 MiB, 0,5 MiB, 1,2 MiB, 9,8 MiB | 512 MiB cada uno |
| `isa-files`, `isa-tunnel`, `nav-lan` | 12, 2 y 11 MiB | sin límite |

Kant corre nativo en server2 (`cauce-v3-host-kant.service`, `cauce-v3-tmux-kant.service`, `cauce-v3-pty-host@kant`): dos `claude` (~0,8 GB) y su `codex app-server`. Los límites ya comprometidos en server2 suman **20 GiB** (Minecraft 12, Salva 6, cuotas 2) sobre 22,8 GiB físicos; el `systemd --user` de `server` está `degraded` solo por `cauce-v3-profile-expectation@salva` (fallo previo, igual que en la VPS). Imágenes en server2: 22 GB (`ws-isa` 18,2 GB, `cuota-cli` 2,1 GB).

### Huella de server3

`server3` de `~/.ssh/config` apunta a `192.168.78.126`, que hoy **no responde** (sin ruta). En `192.168.78.125` SSH avisa **«REMOTE HOST IDENTIFICATION HAS CHANGED»**: la entrada guardada para `.125` es otra máquina (ED25519 `SHA256:iT9KEMrNXJD5wm1MeQY7Yc98AihQvViFAkdXoKukmgg`) y la que responde presenta **ED25519 `SHA256:W0y5Q3Ex/Gz2ok4RVa7tEAwoxUAohCKPnMR7629ONWQ`**. No se aceptó ni se tocó `known_hosts`. Esa misma clave es la que ya estaba registrada y confiada para `192.168.78.126` (server3) y para su IP de malla `100.64.0.16`. Tailscale la lista como `ils-server` con conexión directa a `192.168.78.125`. La medición se hizo por `100.64.0.16` con verificación estricta, sin avisos. Conclusión: server3 cambió de IP de LAN (.126 → .125) y la clave coincide con la confiada; el dueño debe apuntar `server3` a `100.64.0.16` y retirar la entrada caducada de `.125`.

## 2. Los cuatro agentes

### Gaia → `agv2-miguel-finca-oc` (openclaw con Anthropic, tenant Miguel)

- **Imagen**: `claw:latest` (`sha256:721695d4…`, 2,84 GB, base CUDA/Ubuntu 24.04 sin GPU). CMD `tini -- node …/openclaw/dist/index.js gateway --port 18793`. Usuario `claw`, red `agv2-tn-miguel` + `net-claw-ws`, `unless-stopped`.
- **Volúmenes**: `/datos/agent-v2/tenants/miguel/agents/finca/oc/clawd` → `/home/claw/clawd` (105 MB) y `…/oc/.openclaw` → `/home/claw/.openclaw` (786 MB). **En la capa escribible, sin volumen** (se pierde con `docker rm`): `~/.claude` (2,7 MB), `~/.codex` (0,6 MB), `~/.claude.json`, `~/.ssh` (clave de despliegue de GitHub con alias de host `github.com-clawd`), `~/.local` 402 MB, `~/.npm-global` 335 MB, `~/.config` 257 MB, `~/.npm` 113 MB y un bundle `clawd-salvaguarda` de 2,5 MB.
- **Unidades** (usuario `stev`, `systemd --user`, linger): `cauce-v3-container-gaia.service` (`container-adapter-supervisor.sh start gaia`), `cauce-v3-pty@gaia.service`, `cauce-v3-profile-expectation@gaia.service` (fallida). De root: `cauce-bootstrap-guard` (vigila `claw*` y `agv2-*`). El gateway es el CMD: no depende del `cauce-openclaw-gateway-guard`.
- **Layout legado**: `/home/claw/clawd` es un repo Git (`gaia-clawd` del GitHub del dueño, rama `web-humanizar-catalogo`, HEAD `87ddc8f`) que mezcla contexto (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md` vacío, `00-CONTEXTO-ACTUAL.md`), documentos de negocio (`CATALOGO`, `EMPRESA`, `ESTRATEGIA`, `NEGOCIO`, `PLAN`), catálogo PDF/JPG, `AGENTS.md.bak-*` y carpetas `clientes`, `entregas`, `pedidos`, `memory`, `tools`, `gravitatoria*`, `web-enlaces`, `web-humanizar*`. Estado Cauce en `~/.openclaw/cauce-v3/gaia`; `~/.openclaw` guarda además 20 copias `openclaw.json.bak*` y `codex-cli.bak-*`.
- **Binding**: primario `anthropic/claude-opus-5`; fallbacks `codex/gpt-6-astra`, `anthropic/claude-sonnet-5`, `antigravity/gemini-3.8-flash-high`; `thinkingDefault max`. Claude por el perfil `claude-cli` (OAuth del CLI): **setup-token sin refreshToken, huella `daa25a18`**; `claude auth status`: `loggedIn`, suscripción `max`, sin email ni organización, así que **el titular no se puede leer sin abrir la credencial** (titular previsto: Miguel, pregunta 2 del §3). Fallback Codex: **cuenta ChatGPT `b5fbdfe7`**, la del dueño, la misma que usa Argos. `cauce-cred-guard` no cubre los `agv2-*`.
- **Depende de la VPS**: el proveedor `antigravity` apunta a `http://ctrl-infra:18799/v1` (shim de Argos); fuera de la VPS ese fallback queda roto y Gemini está fuera del pool: se elimina del destino.

### Hades → `agv2-steven-hades-oc` (grok, tenant Steven)

- **Imagen**: `claw:tmux-grok-20260923` (`sha256:22134c36…`, 2,84 GB). CMD `tini -- sleep infinity`; el supervisor lanza la TUI de grok en tmux (`-L cauce`, sesión `cauce-hades`, `GROK_HOME=/home/claw/.grok`). Red `agv2-tn-steven` + `net-claw-ws`.
- **Volúmenes** (bajo `/datos/agent-v2/tenants/steven/agents/hades/oc/`, 2,29 GB): `state` → `~/.local/state/cauce-v3` (1 MB), `workspace` → `~/workspace` (1,74 GB), `.grok` → `~/.grok` (551 MB) y **el binario `.grok/bin/grok-1.0.41` montado en `/usr/local/bin/grok`** (solo lectura). En la capa escribible: `~/bin` 42 MB, `~/.cauce`, `~/.config` y seis ficheros `*.hdr` en la raíz del home (cabeceras de scraping: tratarlos como secretos).
- **Unidades**: `cauce-v3-container-hades.service`, `cauce-v3-pty@hades.service`, `cauce-v3-profile-expectation@hades.service` (fallida); `cauce-bootstrap-guard`.
- **Layout legado**: contexto en `~/.grok/AGENTS.md` (más `.bak` y copias de zeus). `~/workspace` tiene **440 ficheros sueltos en la raíz** (193 `ENVIO-*.json`, 21 `.md` operativos), el repo `xenia` (`xenia-operaciones`, `main`, `a2d48b8`), `revision-xenia` y `__pycache__`. Los 8 JSONL de más de 16 MiB son datos del proyecto (`xenia/data/bases_locales/…`, el mayor 91 MB).
- **Binding**: `[models] default = "grok-4.7"`, `default_reasoning_effort = "xhigh"`, `fork_secondary_model = "grok-4.6"`; MCP `cauce` y `xenia`. Login Grok en `~/.grok/auth.json` (0600, 1 763 B, renovado el 12-oct). Grok 1.0.41 no tiene un comando de estado que imprima la cuenta sin abrir ese fichero y `cauce hades login --ver` no lo reconoce, así que **la cuenta queda sin identificar en solo lectura**; el titular y pagador previsto es Steven (tenant Steven).

### Argos → `ctrl-infra` (openclaw con OpenAI, tenant Steven)

- **Imagen**: `cauce-sep/ctrl-infra:20260730T180341Z` (3,63 GB). CMD: `sshd`, *worker* de terminal remota y `sleep infinity`; el gateway openclaw (`index.js gateway --bind loopback --port 18789`) lo mantiene vivo el `cauce-openclaw-gateway-guard` de root.
- **Volúmenes** (`/datos/agents/ctrl-infra-config`, 16,25 GB en total): `clawd` 1,97 GB (de ellos `work` 1,79 GB de repos), `.openclaw` 6,69 GB (`agents` con las sesiones 4,1 GB, `npm` 1,1 GB, `memory` 0,5 GB, `codex-cli` y su `.bak` 0,8 GB, `gateway.log` 3 MB), `.local` 2,39 GB, `.codex` 2,89 GB, `.claude` 1,39 GB, `.gemini` 0,92 GB; además `/datos/workspaces` → `/workspace` (todos los workspaces, rw), ficheros sueltos compartidos `/datos/agents/shared/{.claude/.credentials.json,.codex/auth.json,.netrc,.gitconfig,.bashrc,.npm,.cache/pip}`, claves `ws-keys` y configuración de `gh` y Bitwarden CLI.
- **Unidades**: `cauce-v3-container-argos.service`, `cauce-v3-pty@argos.service`, `cauce-v3-profile-expectation@argos.service` (fallida). De root: `cauce-openclaw-gateway-guard` (solo `ctrl-infra`: arranca el gateway y reaplica un parche de esfuerzo en `dist` de openclaw), `cauce-openclaw-fallback-guard` (`claw` y `ctrl-infra`: suelta fallbacks pegados y parchea el pensamiento de gpt-6) y `cauce-cred-guard`.
- **Layout legado**: `/home/dev/clawd` es el repo `argos-workspace` (`main`, `ac1b080`, con un remoto `mirror` dentro de `/workspace`), con contexto (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS*.md`, `HEARTBEAT.md` de 113 KB, `MEMORY.md`, `DIRECTIVAS-OPERATIVAS.md`, `DECISIONES-STEVEN-*`), 9 informes `REPORTE-*`/`REVISION-*`, 27 carpetas y ficheros de acceso local (`.qa-credentials.local`, `ACCESOS-DEV-QA-*.local.md`) que no se copian por manifiesto. Repos en `work/` y `proyectos/`: `gravitatoria`, `pos-back`, `devkits-crm`, `devkits-crm-catalogo`, `cauce-v3`, `web-humanizar-agenda`, `cauce-v3-humanizar-tech` y dos carpetas sin Git.
- **Binding**: primario `codex/gpt-6.1-sol`; fallbacks `anthropic/claude-opus-5-5[1m]`, `codex/gpt-6-sol`, `codex/gpt-6-luna`, `anthropic/claude-sonnet-5`, `minimax/MiniMax-M3` y `antigravity/gemini-3.8-flash-high` (los dos últimos, fuera del pool); `thinkingDefault max`. Codex: **cuenta ChatGPT `b5fbdfe7`** del dueño (huella de `cauce-cred-guard` `b135a639`); su `auth.json` es el **fichero compartido** `/datos/agents/shared/.codex/auth.json`. Claude: **setup-token, huella `31eb8fc1`**, también del fichero compartido. Pagador: Steven.
- **Dependencias con la VPS (mejora 15)**:
  - API Docker por `DOCKER_HOST=tcp://ctrl-infra-docker-proxy:2375` (docker-socket-proxy en la red `ctrl-infra-proxy`): solo `CONTAINERS`, `INFO`, `PING` y `VERSION`; sin `EXEC`, `POST`, imágenes, redes ni volúmenes.
  - SSH a los `ws-*` con `ws-keys` por la red `net-claw-ws` (también tiene `net-claw`, `ws_net-out` y `control_default`).
  - `/workspace` con todos los workspaces del host, en escritura.
  - MCP `cauce` y `cauce-decisiones` (contenedor `cauce-decisiones-decisiones-1`), `ai-usage` y `cloud-offload`.
  - `BW_SERVER` (Vaultwarden público), `NEXUS_URL` (terminal remota pública) y `host.docker.internal`.
  - **Sirve a otros**: el shim `agy-openai-shim.py` en `:18799` lo usan como fallback Gaia, Jarvis (`claw`), Iza (`claw-iza`) y Janus (`claw-miguel`). Por eso **`ctrl-infra` no se retira**: solo las unidades y el estado de Argos.

### Hegel → dentro de `ws-humanizar` (muse, tenant Miguel)

- **Imagen**: `ws-humanizar:aplanada-20260927` (6,12 GB), proyecto compose `ws`, **privilegiado**, `docker.sock` montado, compartido con Atlas (codex) y Kratos (claude). No se replica.
- **Volúmenes y datos propios**: estado `~/.local/state/cauce-v3/hegel` (69 632 B), configuración `~/.local/share/cauce-v3/config/hegel` (35,9 MB: login de Muse, sesión `2026/09/28/01a0e56c…`, perfil de Chrome), lanzador `~/.local/bin/muse-cauce` y binario `muse-bin-1.4.4` (352 MB; el proceso vivo es 1.4.1, sustituido en disco). Todo vive en `/datos/agents/humanizar-config` (36,6 GB entre los tres alias).
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

## 4. Praxis en el hospital (`ssh hospital`, `vps-990525f1`)

Host: 8 núcleos, 22,9 GiB de RAM (**18,4 GiB disponibles**), sin swap, 172 GB libres de 207 GB. Docker: 141 imágenes (21,5 GB, 4,6 GB recuperables) y 2,7 GB de caché de build.

**Versión de Cauce**: checkout `/opt/hospital-cauce` en la rama `hospitales`, HEAD `78f6d93c` («docs(hospital): registrar actualización validada de Cauce», 02-oct). Runtime desplegado **`da8d921bc`** (último `deploy/HISTORIAL.md`: 02-oct 22:41 UTC). Adaptadores en ejecución: `release-a89b86211715` (operador) y `release-7e1aaf125198` (perseo, teseo); el más reciente instalado es `release-72727a163c4e`. Todos esos commits están solo en `origin/socrates/hospital-supervision-1699`, no en V4. Las imágenes de agente salen de `0790d9f5`, que no existe en este repo.

**Base de datos** (`hospital-cauce-postgres-1`, consultas dentro de `BEGIN TRANSACTION READ ONLY`): **esquema 043** (39 migraciones; las últimas son `041_agent_context_revisions`, `042_blobs` y `043_blob_tenant_entitlements`), pgdata de 100 MB. Tenant único `Hospital` («Hospital Conecta», hub). Agentes en BD: `operador` (openclaw), `perseo` y `teseo` (muse) habilitados; `backend` y `frontend` (openclaw) deshabilitados. `agent_account_bindings` está vacía.

**Correo de León: no está en la V3 del hospital.** `console_users` tiene una sola fila (el operador del dueño, rol `operator`, alias `operador`) y ninguna otra tabla guarda correos. Hay que pedirlo al dueño (§3, pregunta 4).

| Componente | Contenedor e imagen | Memoria | Capa / datos | Modelo y cuenta |
|---|---|---|---|---|
| **operador** (alias Cauce) | `hospital-agent-openclaw-operator-gateway-1`, `hospital-openclaw-builder:ef87f685` (362 MB, openclaw 2026.7.1-2) | 873 MiB | capa 985 MB; `state-operator` 165 MB, `operator-workspace` 382 MB, `state-muse-operator` 208 MB, `operator-ops` 12 MB, `operator-admin-jobs` 18 MB | `xai/grok-4.7` `xhigh`, fallback `muse-cli/muse-spark-1.3`; API de xAI; bot de Telegram; plugins `browser`, `hospital-ops`, `hospital-muse-native` |
| **perseo** (muse frontend) | `hospital-agent-muse-frontend-1`, `hospital-openclaw-builder:8ef92b3a` (362 MB) | 280 MiB | capa 1,15 GB; `state-muse-frontend` 1,02 GB | login Meta en `~/.muse/config/muse` |
| **teseo** (muse backend) | `hospital-agent-muse-backend-1`, misma imagen | 441 MiB | capa 552 MB; `state-muse-backend` 937 MB | login Meta |
| ventas/atención (sin alias Cauce) | `hospital-agent-openclaw-sales-gateway-1`, `ghcr.io/openclaw/openclaw:2026.7.1-2` | 362 MiB | `state-sales` 142 MB | `xai/grok-4.6`; **canal WhatsApp**; plugin `hospital-crm` |
| crm | `hospital-agent-crm-1`, `hospital-agent-crm:stable` (46 MB, Python + SQLite) | 72 MiB | volumen 0,5 MB | publicado por Caddy |
| navegador | `hospital-agent-browser-1` (404 MB) + `-cdp-proxy-1` | 519 + 16 MiB | volumen 261 MB | Chromium del operador por socket CDP |

- Comunes en `/opt/hospital-agent/runtime` (5,1 GB en total): `muse-code-bin` 718 MB, `developer-workspace` 732 MB, `praxis` 701 MB y plantillas, políticas *seccomp*, aprobaciones y copias. Seis redes `hospital-agent_*`.
- **Servicios de host (root)**: `cauce-v3-container-{operador,perseo,teseo}.service` (supervisor del checkout), `hospital-access.service` (custodia del acceso del director, montado en `/run/hospital-access/{perseo,teseo}`), `hospital-operator-ops.service` (broker tipado por socket), `praxis-preview.service` (`127.0.0.1:8077`), `hospital-agent-repair.timer` y **Caddy** (80, 443 y 8443: el sitio del CRM y la vista previa de Praxis, lo «publicado» que irá a otra infraestructura).
- **Pila Cauce V3 del hospital** (`hospital-cauce-*`: consola, gateway, dispatcher, PG, telegram-bridge, prometheus, otel, registry): ~0,45 GiB. Se retira al importar Praxis en la V4 central. Las pilas de prueba `hospital-readiness-step0-*` y `ops-*` (`cauce-v3-test-runtime:local`, ~0,47 GiB) no se migran.
- Agentes y servicios de Praxis suman **~2,5 GiB** de RAM medida.

## 5. Propuesta de ubicación

| Agente | Vía | Host | `--memory` | `--cpus` | Base (medido hoy) |
|---|---|---|---|---|---|
| **Gaia** | overlay V3 `dockerHost=server2` | server2 | 1 GiB | 1,5 | 270 MiB contenedor, 291 MiB RSS |
| **Hades** | overlay V3 `dockerHost=server2` | server2 | 1 GiB | 1 | 240 MiB contenedor, 214 MiB RSS |
| **Argos** | flota V4 (el único colocable hoy); respaldo: overlay V3 | server2 | **3 GiB** | 2 | 1,38 GiB RSS propio y 1,50 GiB de contenedor; con 2 GiB quedarían 0,6 GiB para los picos de `claude -p`, `codex app-server` y Chrome |
| **Hegel** | overlay V3, **contenedor propio nuevo** (sin `ws-humanizar`) | server2 | 2 GiB | 2 | 144 MiB en reposo; los turnos de Muse con herramientas y Playwright crecen |
| **Praxis**: operador + navegador, perseo, teseo, ventas, crm | perseo y teseo (muse), igual que Hegel; operador (openclaw con xAI) por flota V4 si su driver lo soporta (§7) o por overlay; ventas, crm y navegador como servicios del mismo host | **server1** si el dueño aprueba instalar Docker; si no, server2 tras los cuatro | operador 1,5 GiB, navegador 1 GiB, perseo 1 GiB, teseo 1 GiB, ventas 768 MiB, crm 256 MiB, cdp-proxy 64 MiB | 1–2 cada uno | ~2,5 GiB |

- **Balance de server2**: hoy usa 12,1 GB y tiene 11,6 GiB disponibles. Con los cuatro agentes (~2,2 GiB medidos) quedaría con **~9,5 GiB disponibles** y ~7 GiB si Minecraft llega a su tope de 12 GiB. Los límites sumarían 27 GiB sobre 22,8 físicos: son topes, no reservas, pero por eso Praxis no se apila en server2 salvo necesidad. Disco: imágenes (~6 GB si Gaia y Hades comparten capas) y datos (Gaia ~0,9 GB, Hades ~2,3 GB, Argos ~3–4 GB seleccionados, Hegel 36 MB + repos) caben de sobra en 149,8 GB.
- **server1**: reserva y destino preferido de Praxis (278 GB libres, 11,3 GiB disponibles), pero **no tiene Docker**: instalarlo es una decisión del dueño. **server3** se descarta: 7,1 GiB de RAM con la mitad ocupada por los navegadores `nav-*`.
- **Cómo es el overlay V3 (patrón Salva)**: en el repo, `ops/flota-fisica.json` lleva `placement.<alias> = {"dockerHost": "server2", "systemdUser": "server"}` (hoy solo Salva; Kant y Astra solo `systemdUser`). Se regenera con `ops/scripts/regenerate-fleet.sh` (pasa a `ops/container-aliases.json`) y se valida con `ops/scripts/validate.sh`. `container-alias-query.py --route` resuelve `ssh:server@server2` para el CLI. En server2, como `server` (UID 1000, linger), se instalan: `~/.config/systemd/user/cauce-v3-container-<alias>.service` con `CAUCE_CONTAINER_OPS_ROOT=%h/.local/share/cauce-v3-release-tools/<sha>/ops`, `CONFIG_ROOT=%h/.config/cauce-v3/container-aliases` (`<alias>.env`), `PKI_ROOT=%h/.config/cauce-v3/container-pki` y `BUNDLE_ROOT=%h/.local/share/cauce-v3-adapter`; el *drop-in* `90-migration-prepared.conf` con `ConditionPathExists=%h/.config/cauce-v3/<alias>-migration.ready` como interruptor del corte; `cauce-v3-pty@<alias>.service`; y `cauce-cred-guard-server2.timer`, que publica la salud de credenciales al agregador de la VPS. Salva corre hoy así (`cauce-migration/ws-isa:20260908`, 6 GiB, 2 CPU). Detalle: `docs/v3.5-despliegue-flota.md`.
- **Orden canario**: **Gaia → Hades → Argos → Hegel → Praxis**, uno cada vez. Antes de cada corte: copia cifrada a kratos y Drive con restauración de prueba; ensayo de reversión con Gaia; origen detenido antes del primer refresco de credenciales en destino. Se acepta por alias con: nonce respondido por Cauce desde server2, terminal por CLI y web, cuota de su cuenta, contexto aplicado (versión y digest), host nuevo en la UI, edición de contexto N+1 desde la UI y detener/arrancar aplicado en el host nuevo. En Argos, además, que inspeccione la VPS desde server2. El origen se libera tras 7 días sin incidentes y se mide «después» con el mismo script.
- **Normalización durante el traslado** (manifiesto ruta vieja → nueva con sha256):
  - **Gaia**: clonar `gaia-clawd` en el mismo HEAD → `space/projects/gaia-clawd`; `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` y `00-CONTEXTO-ACTUAL.md` → `space/context` como primera versión; catálogo y documentos de negocio → `space/data`; sin `.bak`.
  - **Hades**: `~/.grok/AGENTS.md` → `space/context`; `xenia` por Git → `space/projects/xenia`, con sus JSONL de `data/` por manifiesto; los 440 ficheros sueltos → `space/data/envios` y `space/data/notas`; fuera `__pycache__` y `*.hdr`.
  - **Argos**: contexto y directivas de `clawd` → `space/context` y `space/directives`; los 7 repos → `space/projects` por Git; informes → `space/data`; ni `/workspace` ni los ficheros `*.local*`.
  - **Hegel**: espacio nuevo vacío más los repos que él indique.

### Riesgos y bloqueos

1. **Swap de la VPS al 100 %** con 28,4 GiB disponibles: el prechequeo de deploy (≥ 8 GiB) pasa, pero la presión es real; el ahorro de la migración es modesto (~2,1 GiB de RSS).
2. **Disco liberable**: imagen de Hades (2,84 GB, única) y capas escribibles de Gaia (2,77 GB) y Hades (0,19 GB), más 3,2 GB de volúmenes. `claw:latest` **no** se libera (la usan `claw`, `claw-iza` y `claw-miguel`) y `ctrl-infra` y `ws-humanizar` se quedan.
3. **Credenciales en fichero compartido o en la capa del contenedor**: Argos usa los ficheros sueltos `/datos/agents/shared/.codex/auth.json` y `.claude/.credentials.json`, que también montan otros contenedores. Copiarlos a server2 duplica un refresh token que rota y deja una de las dos copias inválida, así que el corte exige el origen detenido y un fichero propio por alias en destino. Las credenciales y la clave SSH de Gaia viven en la capa escribible: hay que copiarlas en privado (decisión del dueño, §3) antes de cualquier `docker rm`.
4. **Argos pierde su posición en la VPS**: necesita acceso remoto mínimo (Tailscale a un docker-socket-proxy de solo lectura publicado en la malla, o SSH con comando restringido) y, para los `ws-*`, otra vía que su red `net-claw-ws`. Los parches de los guardias de root (gateway y fallback) deben venir en la imagen de destino o en su release. Gaia, Jarvis, Iza y Janus pierden el shim `:18799` solo si se apaga `ctrl-infra`, que no se apaga.
5. **Hegel sin lista de repos** hasta que responda por Cauce; Atlas y Kratos no se tocan.
6. **Hades**: el binario de grok se monta desde el host y hay que llevarlo con la misma versión (1.0.41); los `*.hdr` son material sensible.
7. **server2 con límites sobrecomprometidos** (27 GiB de topes sobre 22,8 físicos) y Minecraft al 77 % de su tope.
8. **Hospital sin backup válido**: `hospital-cauce-backup.service` falla desde al menos el 11-oct con «La restauración aislada no conserva la topología Hospital» y su monitor también está en fallo. Antes de mover Praxis hace falta una copia verificada.
9. **Código del hospital fuera de V4**: hay que portar `socrates/hospital-supervision-1699` (§3 de las órdenes) antes de mover un agente de Praxis. El canal WhatsApp de ventas exige revincular o copiar su estado en privado.
10. **Pendientes de solo lectura no resolubles**: titulares de Claude (Gaia), Grok (Hades) y Muse (Hegel, Praxis) sin identificar; correo de León ausente; Kant sin consultar (escribirle por Cauce no es solo lectura); `cauce-v3-profile-expectation@*` en fallo en la VPS y en server2.

## 6. Script de medición antes/después

`ops/scripts/measure-vps-footprint.sh` mide en solo lectura un host Docker y los alias indicados, y emite un JSON sellado con sha256 (sobre el JSON canónico sin el campo `sha256`):

```sh
ops/scripts/measure-vps-footprint.sh --ssh root@167.114.118.213 --label antes \
  --out .delegados/v4/recibos/vps-antes-20261012.json \
  'gaia=agv2-miguel-finca-oc:index\.js gateway' 'hades=agv2-steven-hades-oc' \
  'argos=ctrl-infra:index\.js gateway' 'hegel=ws-humanizar'
ops/scripts/measure-vps-footprint.sh --verify .delegados/v4/recibos/vps-antes-20261012.json
ops/scripts/measure-vps-footprint.sh --compare <antes.json> <despues.json>
```

- Cada argumento es `ALIAS=CONTENEDOR[:REGEX]`. El RSS de un alias es la suma del árbol de procesos que cuelga del adaptador (`--alias <alias>`), del agente PTY (`cauce-pty-bundle-<alias>.json`), del panel tmux `cauce-<alias>` y de los procesos que casen con la regex opcional (el gateway de openclaw).
- Recoge `free -b`, swap, `df -B1 /`, carga, `docker stats --no-stream`, `docker inspect --size` (imagen, capa escribible, límites, montajes) y el tamaño de la imagen.
- Las líneas de comando solo se usan en memoria en el host medido: el recibo lleva conteos y sumas, nunca argumentos ni entorno.
- `--out` no sobrescribe un recibo existente; `--compare` verifica los dos sellos y da la diferencia de RAM disponible y usada, swap, disco, RSS por alias y memoria por contenedor.
