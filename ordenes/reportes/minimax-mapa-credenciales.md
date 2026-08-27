# Mapa de consumidores de credenciales (Cauce V3)

Solo lectura de código y configs. **No se leyó ningún contenido bajo `/etc/cauce-v3/**` ni `ops/private/credentials/**`**; de `/etc/cauce-v3/` solo se listaron nombres. Ningún valor de secreto aparece en este documento.

Método: grep sobre `packages/ services/ ops/ deploy/ console/` por `CAUCE_*_PATH`, `CAUCE_*_FILE`, `/etc/cauce-v3`, `ops/private/credentials`; lectura de units systemd, `deploy/compose*.yaml`, `ops/container-aliases.json` y `ops/runbooks/`.

## A. Variables `CAUCE_*_PATH` y consumidores

Total de identificadores `CAUCE_*PATH` distintos hallados en el árbol: **100**. De ellos, 5 son fixtures de test (`CAUCE_FIXTURE_*`), 3 no son credenciales (`CAUCE_TERMINAL_WS_PATH`, `CAUCE_OIDC_POST_LOGIN_PATH`, `CAUCE_TMUX_PATH`) y 55 son la matriz alias×material (11 aliases × 5).

### A.1 Matriz por alias (indirección de dos saltos)

| variable | consumidor (fichero:línea) | propósito declarado en código |
|----------|---------------------------|------------------------------|
| `CAUCE_<ALIAS>_TOKEN_PATH` | `ops/manifests/<alias>.yaml:14` → `ops/scripts/generate-units.py:61` → `ops/scripts/alias-runner.sh:36` | ruta al bearer token del alias |
| `CAUCE_<ALIAS>_CERT_PATH` | `ops/manifests/<alias>.yaml:15` → `generate-units.py:62` → `alias-runner.sh:37` | certificado cliente mTLS del alias |
| `CAUCE_<ALIAS>_KEY_PATH` | `ops/manifests/<alias>.yaml:16` → `generate-units.py:63` → `alias-runner.sh:38` | clave privada cliente mTLS |
| `CAUCE_<ALIAS>_CA_PATH` | `ops/manifests/<alias>.yaml:17` → `generate-units.py:64` → `alias-runner.sh:39` | CA que valida al gateway |
| `CAUCE_<ALIAS>_EXEC_PATH` | `ops/manifests/<alias>.yaml:18-19` → `generate-units.py:65` → `alias-runner.sh:40` | binario del arnés (no es secreto) |

`<ALIAS>` ∈ {ARGOS, ATLAS, HEGEL, IZA, JANUS, JARVIS, KANT, KRATOS, SALVA, SOCRATES, ZEUS} (11 manifiestos en `ops/manifests/`).

La indirección: la unit exporta `CAUCE_TOKEN_PATH_ENV=CAUCE_<ALIAS>_TOKEN_PATH` (y sus 4 hermanas); `ops/scripts/alias-runner.sh:36-40` desreferencia con `indirect()`. El VALOR real de `CAUCE_<ALIAS>_*_PATH` se define en `/etc/cauce-v3/aliases/<alias>.env` (no leído).

### A.2 Rutas de despliegue (compose secrets)

| variable | consumidor (fichero:línea) | propósito declarado en código |
|----------|---------------------------|------------------------------|
| `CAUCE_DATABASE_URL_SECRET_PATH` | `deploy/compose.yaml:558` | fichero del secret `database_url` |
| `CAUCE_POSTGRES_CA_PATH` | `deploy/compose.yaml:560` | CA de Postgres (`PGSSLROOTCERT`) |
| `CAUCE_POSTGRES_PASSWORD_PATH` | `deploy/compose.postgres.yaml:65` | password del servidor Postgres |
| `CAUCE_POSTGRES_SERVER_CERT_PATH` | `deploy/compose.postgres.yaml:67` | cert TLS del servidor Postgres |
| `CAUCE_POSTGRES_SERVER_KEY_PATH` | `deploy/compose.postgres.yaml:69` | clave TLS del servidor Postgres |
| `CAUCE_GATEWAY_TLS_CERT_PATH` | `deploy/compose.yaml:564` | cert TLS servidor del gateway |
| `CAUCE_GATEWAY_TLS_KEY_PATH` | `deploy/compose.yaml:566` | clave TLS servidor del gateway |
| `CAUCE_GATEWAY_TLS_CA_PATH` | `deploy/compose.yaml:568` | CA del gateway (también `NODE_EXTRA_CA_CERTS`) |
| `CAUCE_GATEWAY_CLIENT_CA_PATH` | `deploy/compose.yaml:570` | CA que valida clientes mTLS (default `/dev/null`) |
| `CAUCE_GATEWAY_OIDC_SESSION_KEY_PATH` | `deploy/compose.yaml:575` | clave de firma de sesión OIDC |
| `CAUCE_GATEWAY_OIDC_CLIENT_SECRET_PATH` | `deploy/compose.yaml:582` | client secret OIDC |
| `CAUCE_CONSOLE_JWT_KEY_PATH` | `deploy/compose.yaml:580` | clave JWT de consola (fallback password) |
| `CAUCE_CONSOLE_TLS_CERT_PATH` / `_KEY_PATH` / `_CA_PATH` | `deploy/compose.yaml:584,586,588` | TLS del nginx de consola |
| `CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH` / `_KEY_PATH` | `deploy/compose.yaml:590,592` | mTLS consola→gateway |
| `CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH` / `_KEY_PATH` | `deploy/compose.yaml:597,599` | mTLS terminal-relay→gateway |
| `CAUCE_TERMINAL_RELAY_TLS_CERT_PATH` / `_KEY_PATH` | `deploy/compose.yaml:601,603` | TLS servidor del terminal-relay |
| `CAUCE_TERMINAL_RELAY_TOKEN_PATH` | `deploy/compose.yaml:605` | token compartido gateway↔relay |
| `CAUCE_TERMINAL_TICKET_KEY_PATH` | `deploy/compose.yaml:607` | clave de firma de tickets de terminal |
| `CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH` / `_KEY_PATH` | `deploy/compose.yaml:609,611` | mTLS gateway→relay; **default apuntando a `/etc/cauce-v3/pki/gateway-client.{crt,key}`** |
| `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE` | `deploy/compose.yaml:562` | snapshot de estado de release (no secreto) |
| `CAUCE_ALERTMANAGER_TELEGRAM_TOKEN_PATH` | `deploy/compose.alertmanager.yaml:59`; emitido por `ops/scripts/provision-alertmanager-config.py:349` | token del bot de alertas |
| `CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH` | `deploy/compose.alertmanager.yaml:61`; `provision-alertmanager-config.py:348` | chat destino de alertas |
| `CAUCE_ALERTMANAGER_CONFIG_PATH` | `deploy/compose.alertmanager.yaml:24`; invariante en `ops/scripts/validate.sh:94` | config de Alertmanager sin identidades |
| `CAUCE_GATE_CAPTURE_PATH`, `CAUCE_GATE_PROBE_PATH` | `ops/scripts/{cutover,guard-check,canary}.sh` | ejecutables del gate (no secretos; exigidos absolutos, ejecutables y no symlink) |

### A.3 Variables `CAUCE_*_FILE` dentro del contenedor (el consumidor real del secreto)

| variable | consumidor (fichero:línea) | propósito |
|----------|---------------------------|-----------|
| `DATABASE_URL_FILE`, `PGSSLROOTCERT` | `deploy/compose.yaml:38,41,49,52,341,344,410,413` | migrator, gateway, dispatcher, outbox-metrics, telegram-bridge |
| `CAUCE_CONSOLE_JWT_KEY_FILE` | `services/gateway/src/main.ts:94`; `deploy/compose.yaml:59` | clave JWT de consola |
| `CAUCE_OIDC_SESSION_KEY_FILE` | `services/gateway/src/main.ts:128`; `compose.yaml:70` | sesión OIDC |
| `CAUCE_OIDC_CLIENT_SECRET_FILE` | `services/gateway/src/main.ts:137`; `compose.yaml:71` | client secret OIDC |
| `CAUCE_TOKEN_HASH_FILE` | `services/gateway/src/main.ts:81,113`; `compose.yaml:74` | hashes de tokens de identidad |
| `CAUCE_MTLS_IDENTITY_FILE` | `services/gateway/src/main.ts:76,118`; `compose.yaml:75` | identidades mTLS admitidas |
| `CAUCE_TLS_CERT_FILE` / `CAUCE_TLS_KEY_FILE` / `CAUCE_TLS_CLIENT_CA_FILE` | `services/gateway/src/main.ts:167,168,175`; `compose.yaml:76-78` | TLS/mTLS del gateway |
| `CAUCE_TERMINAL_TICKET_KEY_FILE`, `CAUCE_TERMINAL_RELAY_TOKEN_FILE`, `CAUCE_TERMINAL_RELAY_{CA,CLIENT_CERT,CLIENT_KEY}_FILE` | `deploy/compose.yaml:94,95,100-102` | canal gateway↔relay |
| `CAUCE_TERMINAL_RELAY_TLS_{CERT,KEY}_FILE`, `_CLIENT_CA_FILE`, `_AGENT_CA_FILE`, `_AGENT_REGISTRY_FILE`, `CAUCE_TERMINAL_GATEWAY_CLIENT_{CERT,KEY}_FILE` | `deploy/compose.yaml:251-263` | terminal-relay |
| `CAUCE_TELEGRAM_CONFIG_FILE` | `services/telegram-bridge/src/main.ts:80`, `config.ts:383`; `compose.yaml:415` | config con tokens de bot por alias (debe ser absoluta) |
| `CAUCE_TELEGRAM_TRANSCRIPTION_API_KEY` | `services/telegram-bridge/src/transcription.ts:56` | API key de transcripción (**valor en env, no fichero**) |
| `CAUCE_TLS_{CERT,KEY,CA}_FILE`, `CAUCE_TOKEN_FILE`, `CAUCE_OPENCLAW_TOKEN_FILE`, `CAUCE_CONFIG_FILE` | `packages/adapter-sdk/src/bin/config.ts:226,235-237,259,292` | credenciales del adapter dentro del contenedor |
| `CAUCE_CONSOLE_USER_PASSWORD` | `services/gateway/src/console-user-cli.ts:83` | alta de usuario de consola (**valor en env**) |
| `CAUCE_TENANT_ID`, `DATABASE_URL` | `packages/mcp-fleet-monitor/src/server.ts:12,18` | MCP de flota lee la base directamente |
| `CAUCE_QUOTA_PKI_DIR` (default `~/.config/cauce-v3/container-pki/quota-collector`) | `ops/scripts/quota-collector.py:49` | mTLS del colector de cuotas |
| `CAUCE_PTY_PKI_ROOT`, `PKI_DIR`, `ALIAS_KEY_FILE` | `ops/pty-agent/cauce-pty-launcher.sh:15,118-121,130-133` | material del canal PTY por alias (`alias-key.hex`, modo 600) |
| `CAUCE_PKI_DIR` (default `/etc/cauce-v3/pki`) | `ops/guardias/hegel-ventas-checkin.py:45` | guardia que corre como root para leer PKI |

## B. Rutas `/etc/cauce-v3/**` y consumidores

| ruta (sin valor) | consumidor (fichero:línea) | para qué se usa |
|-----------------|---------------------------|-----------------|
| `/etc/cauce-v3/prod.env` | `deploy/deploy.sh:8` (`CAUCE_ENV_FILE`) | env raíz del despliegue: define todas las `CAUCE_*_PATH` de compose |
| `/etc/cauce-v3/aliases/<alias>.env` | `ops/generated/systemd/cauce-v3-alias-<alias>.service:5,29`; `ops/systemd/cauce-v3-{watchdog,reconciler}@.service:10`; plantilla `ops/scripts/generate-units.py:42,66` | valores de `CAUCE_<ALIAS>_{TOKEN,CERT,KEY,CA,EXEC}_PATH` |
| `/etc/cauce-v3/container-aliases/` (+`<alias>.env`) | `ops/scripts/container-adapter-supervisor.sh:8`; `generate-container-units.py:68,95,131`; `pin-container-release.py:38`; `update-alias-config.py:610` | config por alias contenedorizado (`PKI_DIR`, `RELAY_URL`, `OPENCLAW_TOKEN_FILE`) |
| `/etc/cauce-v3/container-pki/<alias>/` | `container-adapter-supervisor.sh:10,215,224,436-453`; `update-alias-config.py:611` | `client.crt`, `client.key`, `ca.crt`, `token`, `openclaw-token` por alias |
| `/etc/cauce-v3/pki/` | `ops/guardias/hegel-ventas-checkin.py:45`; `ops/guardias/cauce-envoltorio-local.sh:38`; `ops/tests/update-alias-config.test.mjs:25,37` | PKI de host: `console-client.{crt,key}`, `gateway-client.{crt,key}` |
| `/etc/cauce-v3/pki/gateway-client.{crt,key}` | `deploy/compose.yaml:609,611` (**default del secret**) | mTLS gateway→relay |
| `/etc/cauce-v3/secrets/identities/{mtls_identities,token_hashes}.json` | `ops/runbooks/authentication.md:10-28`; consumidos vía `CAUCE_{MTLS_IDENTITY,TOKEN_HASH}_FILE` | revocación atómica de identidades |
| `/etc/cauce-v3/secrets/console_jwt_key` | `deploy/compose.yaml:578` (comentario) | clave JWT de consola en producción |
| `/etc/cauce-v3/ops.env` | `ops/systemd/cauce-v3-compose@.service:10`; `cauce-v3-health@.service:7` | env de las unidades de stack/salud |
| `/etc/cauce-v3/host-backup.env` | `ops/systemd/cauce-v3-host-backup.service:11` | credenciales/destinos del respaldo al host |
| `/etc/cauce-v3/fleet-watchdog.env` | (presente en el directorio; sin consumidor hallado en el árbol) | ver §F |
| `/etc/cauce-v3/guards/<alias>.enabled` | `ops/systemd/cauce-v3-{watchdog,reconciler}@.service:3` | interruptor por alias (no secreto) |
| `/etc/cauce-v3/compose-overrides/` | `ops/scripts/compose-files.sh:19` (`CAUCE_COMPOSE_OVERRIDES_DIR`) | overrides de compose fuera de git |
| `/etc/cauce-v3/patches/telegram-bridge-redaction.js` | `ops/guardias/telegram-bridge.override.yaml:19` | parche montado en caliente sobre el bridge |
| `/etc/cauce-v3/telegram-runtime/`, `/etc/cauce-v3/terminal/`, `/etc/cauce-v3/releases/` | solo presentes en el directorio; consumidos por valores dentro de `prod.env` | config de bots / terminal / releases |

## C. Unidades systemd relevantes

| unit | EnvironmentFile | lee `CAUCE_*_PATH` | qué hace con la credencial |
|------|-----------------|--------------------|----------------------------|
| `cauce-v3-alias-<alias>.service` (11, en `ops/generated/systemd/`) | `/etc/cauce-v3/aliases/<alias>.env` | sí, por indirección `CAUCE_{TOKEN,CERT,KEY,CA,EXEC}_PATH_ENV` | `alias-runner.sh <alias>` abre token+mTLS y conecta el arnés al gateway |
| `cauce-v3-watchdog@.service` | `/etc/cauce-v3/aliases/%i.env` | sí (mismas vars, vía `guard-check.sh`) | detección read-only de consumidores duplicados |
| `cauce-v3-reconciler@.service` | `/etc/cauce-v3/aliases/%i.env` | sí | reconciliación por alias |
| `cauce-v3-compose@.service` | `-/etc/cauce-v3/ops.env` | indirecto (compose resuelve los `*_PATH`) | levanta/recarga el stack; `ReadWritePaths=/etc/cauce-v3` |
| `cauce-v3-health@.service`/`.timer` | `-/etc/cauce-v3/ops.env` | indirecto | sondas de salud |
| `cauce-v3-host-backup.service`/`.timer` | `-/etc/cauce-v3/host-backup.env` | no `*_PATH`; usa `DB_BACKUP_DIR`, `UT_NEXUS_BACKUP_SCRIPT` (`ops/scripts/host-backup.sh:68,80`) | dumps de la base y copia al host |
| `cauce-v3-host-backup-monitor.*`, `cauce-v3-backup-alert@.service` | — | no | vigilancia del respaldo |
| `cauce-v3-quota-collector.service`/`.timer` | (config en `ops/config/quota-collector.env.example`) | `CAUCE_QUOTA_PKI_DIR` (`quota-collector.py:49`) | mTLS contra `/v3/quotas/samples` |
| `hegel-ventas-checkin.service` (`ops/guardias/systemd/`) | — | `CAUCE_PKI_DIR` | corre como **root** para leer `/etc/cauce-v3/pki` |
| container adapters (`ops/scripts/generate-container-units.py`, system y rootless) | `/etc/cauce-v3/container-aliases/<alias>.env` | `PKI_DIR` por alias | `container-adapter-supervisor.sh` copia la PKI a `/opt/cauce-v3-secrets/<alias>/` dentro del contenedor |

Unidades con credencial: **11 alias + watchdog@ + reconciler@ + quota-collector + host-backup + hegel-ventas-checkin + N container-adapters** ⇒ **16 units nominales** que leen material de credenciales (más las instanciadas por alias).

## D. Compose / deploy mounts

| compose file | volumen/secret | mount/path en contenedor | quién monta |
|--------------|---------------|--------------------------|-------------|
| `deploy/compose.yaml:557` | `database_url` | `/run/secrets/database_url` | migrator, gateway, dispatcher, outbox-metrics, telegram-bridge (`x-runtime-secrets`, l.20) |
| `deploy/compose.yaml:559` | `postgres_ca` | `/run/secrets/postgres_ca` | los mismos (`PGSSLROOTCERT`) |
| `deploy/compose.yaml:561` | `release_state` | `/run/secrets/release_state` | outbox-metrics |
| `deploy/compose.yaml:563-569` | `gateway_tls_cert` / `_key` / `_ca` | `/run/secrets/gateway_tls_*` | gateway (y `NODE_EXTRA_CA_CERTS` en varios) |
| `deploy/compose.yaml:569` | `gateway_client_ca` | `/run/secrets/gateway_client_ca` | gateway, terminal-relay (client CA y agent CA) |
| `deploy/compose.yaml:574` | `gateway_oidc_session_key` | `/run/secrets/gateway_oidc_session_key` | gateway |
| `deploy/compose.yaml:579` | `console_jwt_key` | `/run/secrets/console_jwt_key` | gateway |
| `deploy/compose.yaml:581` | `gateway_oidc_client_secret` | ruta vía `CAUCE_OIDC_CLIENT_SECRET_CONTAINER_FILE` | gateway |
| `deploy/compose.yaml:583-588` | `console_tls_cert` / `_key` / `_ca` | `/run/secrets/console_tls_*` | console (nginx) |
| `deploy/compose.yaml:589-592` | `console_gateway_client_cert` / `_key` | `/run/secrets/console_gateway_client_*` | console → gateway |
| `deploy/compose.yaml:596-599` | `terminal_gateway_client_cert` / `_key` | `/run/secrets/terminal_gateway_client_*` | terminal-relay |
| `deploy/compose.yaml:600-603` | `terminal_relay_tls_cert` / `_key` | `/run/secrets/terminal_relay_tls_*` | terminal-relay |
| `deploy/compose.yaml:604-607` | `terminal_relay_token`, `terminal_ticket_key` | `/run/secrets/terminal_relay_token`, `/run/secrets/terminal_ticket_key` | gateway y terminal-relay |
| `deploy/compose.yaml:608-611` | `gateway_relay_client_cert` / `_key` | `/run/secrets/gateway_relay_client_*` | gateway (default desde `/etc/cauce-v3/pki`) |
| `deploy/compose.yaml:74,75,106,259` | montajes de directorio (no secret) | `/run/cauce-identities/`, `/run/cauce-terminal/` | identidades y grants publicados por rename atómico |
| `deploy/compose.yaml:415` | montaje de config | `/run/cauce-telegram/config.json` | telegram-bridge (tokens de bot) |
| `deploy/compose.postgres.yaml:65-69` | `postgres_password`, `postgres_server_cert`, `postgres_server_key` | `/run/secrets/...` | postgres |
| `deploy/compose.alertmanager.yaml:24,59,61` | config + `alertmanager_telegram_token` / `_chat_id` | montaje de config y `/run/secrets/...` | alertmanager |
| `ops/guardias/telegram-bridge.override.yaml:19` | bind-mount ro | `/app/services/telegram-bridge/dist/redaction.js` | parche en caliente desde `/etc/cauce-v3/patches` |

## E. Cómo se rota HOY cada credencial

| credencial | runbook |
|-----------|---------|
| identidades mTLS del gateway (`mtls_identities.json`) y token-hashes (`token_hashes.json`) | `ops/runbooks/authentication.md` — publicación por rename atómico en `/etc/cauce-v3/secrets/identities`, verificación con `stat`, rollback desde `/var/backups/cauce-v3/` |
| token del bot de alertas (Alertmanager/Telegram) | `ops/runbooks/alerting.md` menciona el aprovisionamiento vía `ops/scripts/provision-alertmanager-config.py`, **no la rotación** ⇒ (sin runbook de rotación) |
| tokens de bot de Telegram (`CAUCE_TELEGRAM_CONFIG_FILE`) | `ops/runbooks/telegram-cutover.md` cubre el cutover, no la rotación ⇒ (sin runbook de rotación) |
| PKI por alias (`container-pki/<alias>/client.{crt,key}`, `ca.crt`, `token`) | (sin runbook) — solo `ops/runbooks/alias-cutover.md` y `container-adapters.md` para alta/cutover |
| TLS de gateway / console / terminal-relay | (sin runbook) |
| `terminal_relay_token`, `terminal_ticket_key` | (sin runbook) |
| OIDC: `session_key`, `client_secret` | (sin runbook de rotación; `authentication.md` solo describe la configuración) |
| `console_jwt_key` | (sin runbook) |
| `DATABASE_URL` / password de Postgres | `ops/runbooks/backup-restore.md` toca el respaldo, no la rotación ⇒ (sin runbook) |
| material del canal PTY (`alias-key.hex`) | (sin runbook) |
| token de la API de transcripción (`CAUCE_TELEGRAM_TRANSCRIPTION_API_KEY`) | (sin runbook) |
| PKI del quota-collector | `ops/runbooks/quota-collector.md` describe el alta; rotación (sin runbook) |
| credenciales de host-backup (`host-backup.env`) | (sin runbook) |
| token de GitHub (layout previsto en `ops/private/credentials/README.md`) | (sin runbook) |

Ningún fichero de `ops/runbooks/` ni de `docs/` contiene la palabra «rotación» aplicada a credenciales; el único procedimiento de reemplazo documentado es el de identidades en `authentication.md`.

## F. Lagunas observadas

1. **13 de las 14 familias de credenciales de §E no tienen runbook de rotación.** La única con procedimiento es el par `mtls_identities.json` / `token_hashes.json`.
2. **`/etc/cauce-v3/fleet-watchdog.env` no tiene consumidor en el árbol** (ningún grep lo referencia): o es residuo, o su consumidor vive fuera de git.
3. **~80 copias de `prod.env.*`** (`bak-*`, `pre-*`, `respaldo.*`, `antes-*`) conviven en `/etc/cauce-v3/`, cada una con el juego completo de secretos vigentes en su fecha. Ninguna rotación las invalida: caducar un secreto exige purgarlas. **Riesgo de superficie principal.**
4. **Dos secretos viajan como valor en variable de entorno, no como fichero**: `CAUCE_TELEGRAM_TRANSCRIPTION_API_KEY` (`services/telegram-bridge/src/transcription.ts:56`) y `CAUCE_CONSOLE_USER_PASSWORD` (`services/gateway/src/console-user-cli.ts:83`). No son montables como docker secret ni auditables por `stat`.
5. **`deploy/compose.yaml:609,611` empotra un default absoluto a `/etc/cauce-v3/pki/gateway-client.{crt,key}`**: acopla el compose en git a una ruta de host. Debería ser `:?` obligatorio como sus hermanas, no un default silencioso.
6. **Defaults `:-/dev/null` en 9 secrets** (`gateway_client_ca`, `gateway_oidc_session_key`, `console_jwt_key`, `gateway_oidc_client_secret`, `terminal_*`): un despliegue con la variable sin definir arranca con credencial vacía en vez de fallar.
7. `ops/scripts/container-adapter-supervisor.sh:607,745` y `ops/pty-agent/cauce-pty-launcher.sh:557` manipulan `~/.claude/.credentials.json`, `auth.json`, `.claude.json` y `openclaw.json` **dentro de los contenedores**: credenciales de proveedor sin inventario ni rotación documentada.
8. `ops/private/CREDENTIAL-INVENTORY.local` es la fuente del inventario, pero está ignorado por `.gitignore:29` (`*.local`) y por tanto **no versionado ni respaldado por git** — coherente con la regla, pero implica que su pérdida es total.

### Paths detectados que NO deberían estar en git

Auditoría de `git ls-files` por extensiones y nombres sensibles: **no hay ningún secreto real versionado**. Hallazgos a revisar:

- `services/gateway/src/test-fixtures/mtls-server-certificate.pem` y `mtls-server-private.pem` — clave privada en git. Son fixtures de test y no material productivo, pero conviene documentarlo explícitamente o generarlas en tiempo de test.
- `ops/generated/container-systemd/rootless/configs/<alias>.env.example` (11) y `ops/openclaw-gateway/argos.env.example` — plantillas; verificar que ninguna incluya valores reales heredados.
- El resto (`ops/config/*.env.example`) está correctamente cubierto por `.gitignore:26-30` con la excepción `!.env.example`.

Nada sugerido para mover a `ops/private/credentials/`: el material real ya vive fuera de git (en `/etc/cauce-v3/`).
