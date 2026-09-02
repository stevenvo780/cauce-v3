# Guardias de la flota

Scripts de operación que hasta el 2026-08-04 vivían **sólo** en el disco de `kratos` y dentro de un
contenedor, sin versionar. `/datos` es un **RAID 0 de tres NVMe** (`md127`, sin redundancia): si
cae un disco se pierde todo, y con ello estos scripts y las horas de diagnóstico que hay detrás.
Por eso están acá.

Ninguno contiene secretos: leen credenciales pero sólo publican una **huella** —los primeros 10
hex de `sha256(refreshToken)`— que identifica una cuenta sin permitir reconstruirla.

## Qué hay

| Archivo | Dónde va instalado | Qué hace |
|---|---|---|
| `cauce-ai-live` | `kratos:~/.local/bin/` + timer 10min | Cuota REAL por cuenta vía CDP (no estimada) |
| `cauce-attach` | `kratos:~/.local/bin/` | Entra a LA sesión real del agente (claude --resume / codex resume) con guardas |
| `cauce-attach-guard` | `kratos:~/.local/bin/` + timer 2min | Repone adaptadores parados por un attach mal cerrado |
| `cauce-codex-sync` | `kratos:~/.local/bin/` + path-unit | Propaga auth.json compartido de codex a los agentes sin bind-mount |
| `cauce-cred-guard-kratos.py` | `kratos:~/.local/bin/` + timer 15min | Mide credenciales de los alias que viven EN kratos y empuja huellas al VPS |
| `credential_health.py` | `VPS` y `kratos`: `~/.local/bin/` | Autoridad pura compartida para clasificar vencimientos y huellas repetidas |
| `cauce-credenciales` | `kratos:~/.local/bin/` | Audita y renueva credenciales OAuth de toda la flota (detecta bind-mounts compartidos) |
| `cauce-destrabar-telegram` | `kratos:~/.local/bin/` | Destraba el cursor de Telegram atascado por un adjunto no descargable |
| `cauce-directo` | `kratos:~/.local/bin/` | Abre un alias sin los 4 saltos de pty (evita ptys huérfanas) |
| `cauce-esfuerzo` | `kratos:~/.local/bin/` | Ve/cambia modelo y nivel de esfuerzo por agente/harness/todos |
| `cauce-estado` | `kratos:~/.local/bin/` | ¿Trabaja o está muerto? — systemd+CPU+attach+latido del gateway por alias o flota |
| `cauce-modal-sweeper` | `kratos:~/.local/bin/` | Destraba el modal 'Update available' de codex (agente vivo pero mudo) |
| `cauce-panel-guard` | `kratos:~/.local/bin/` + timer | Repone la sesión tmux compartida (panel) si muere sola |
| `cauce-quien-consume` | `kratos:~/.local/bin/` + timer | Mapa contenedor→cuenta REAL de Claude (el auth status puede mentir) |
| `cauce-sesiones` | `kratos:~/.local/bin/` | Lista sesiones reales por agente |
| `cauce-soltar` | `kratos:~/.local/bin/` | Suelta una sesión/plaza tomada |
| `cauce-tmux-panel` | `kratos:~/.local/bin/` | Panel tmux de un alias |
| `cauce-v3-medico-monitor` | `kratos:~/.local/bin/` + timer | El MÉDICO de la flota (3.207 líneas): vigila, adjudica y avisa — 55 iteraciones rescatadas de .bak |
| `cauce-watch` | `kratos:~/.local/bin/` | Watch de la flota |
| `cred-guard.py` | `VPS:/usr/local/sbin/cauce-cred-guard.py`, unit de sistema `cauce-cred-guard.service` (root) | Revisa las 14 credenciales de la flota: quién se quedó sin `refreshToken` y qué credenciales están compartidas entre contenedores |
| `cred-guard.sh` | `VPS:~/.local/bin/` | Envoltorio del anterior: deja estado en `~/.local/state/cred-guard.{txt,log}` |
| `polidin-guard.sh` | `kratos:~/.local/bin/` | Repone el túnel `ws-zeus:12222 → 10.88.88.31:22` cuando muere |
| `systemd/cred-guard.*` | `VPS:/etc/systemd/system/cauce-cred-guard.{service,timer}` (system, no `--user`) | Dispara el agregador de credenciales cada 30 min |
| `systemd/{cauce-cred-guard-kratos,cauce-v3-medico-monitor,polidin-guard}.*` | `kratos:~/.config/systemd/user/` | Dispara las sondas remotas, el médico y el guardia del túnel |
| `contenedor/polidin-fwd.sh` | `ws-zeus:/home/dev/` | El túnel en sí; corre **dentro** del contenedor |
| `cauce-envoltorio-local.sh` | `<contenedor>:~/.local/bin/cauce` | Envoltorio que hace el `ssh kratos` por vos |
| `cauce-huerfanas.sh` | `<contenedor>:~/.local/bin/` | Wrapper compatible del comando canónico `ops/cli/cauce-huerfanas` |
| `telegram-bridge.override.yaml` | `agora-storage:/etc/cauce-v3/compose-overrides/` | Monta el parche que apaga la redacción de la ingesta |
| `hegel-ventas-checkin.py` | `agora-storage:/usr/local/sbin/` | Publica el check-in diario de ventas de `hegel` (`POST /v3/messages` con cert mTLS de hegel) |
| `systemd/hegel-ventas-checkin.{service,timer}` | `agora-storage:/etc/systemd/system/` | Disparan el inyector todos los días a las 13:00 UTC (08:00 America/Bogota) |

## Por qué los guardias viven en kratos y no donde corre lo que vigilan

Los contenedores `ws-*` / `claw*` **no tienen cron ni systemd**: un proceso auxiliar que muere ahí
dentro no lo repone nadie, y el síntoma no dice "falta un proceso" —dice `Connection refused` o
`HTTP 000`—. `kratos` sí tiene systemd de usuario con `Linger=yes`, así que el guardián vive ahí y
alcanza al contenedor por `docker exec`. Pasó dos veces en 48 h: el túnel de Polidinámica y el shim
de Antigravity, los dos caídos días sin que nadie lo notara.

La excepción es `cred-guard.py`: agrega en el VPS las mediciones locales y el documento que
`cauce-cred-guard-kratos.py` empuja desde `kratos`. Ambos hosts necesitan su propia copia de
`credential_health.py` junto al ejecutable que la importa.

## El check-in diario de hegel corre en agora-storage, no en kratos

A diferencia de los guardias de arriba (que viven en `kratos` y alcanzan al contenedor por
`docker exec`), el inyector de `hegel-ventas-checkin` corre en **agora-storage** como unidad
systemd de **sistema**. Va ahí porque los dos motivos apuntan al mismo host: el gateway de
Cauce V3 escucha en `agora-storage` (`100.64.0.6:8443`), así que el `POST /v3/messages` es
local; y los certificados de cliente mTLS viven en `agora-storage:/etc/cauce-v3/pki`
(root-only), así que no hay que copiarlos a ningún lado. El inyector se autentica con el
**certificado del propio hegel** (`agent-hegel.crt/.key`): el gateway deriva tenant+alias del
certificado, de modo que el mensaje se queda dentro del tenant de hegel (`Jhon`, room
`grp.jhon`), sin cruzar tenants. La `idempotency_key` lleva la fecha UTC, así que correrlo dos
veces el mismo día NO duplica la entrega y cada día produce una nueva.

Instalar / restaurar en `agora-storage` (con el repo clonado):

```sh
sudo install -m755 ops/guardias/hegel-ventas-checkin.py            /usr/local/sbin/
sudo install -m644 ops/guardias/systemd/hegel-ventas-checkin.service /etc/systemd/system/
sudo install -m644 ops/guardias/systemd/hegel-ventas-checkin.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hegel-ventas-checkin.timer
sudo systemctl list-timers hegel-ventas-checkin.timer   # NEXT debe caer 13:00:00 UTC
```

Probar el efecto (crea una entrega real y hace correr a hegel):
`sudo systemctl start hegel-ventas-checkin.service` y verificar una fila nueva en
`deliveries` (columnas `recipient_tenant`/`recipient_alias`, NO `tenant_id`/`alias`):
`docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -c "select id,status from deliveries where recipient_alias='hegel' order by created_at desc limit 3"`.

## Restaurar después de una pérdida de disco

**El agregador del VPS corre HOY como unit de SISTEMA, no de usuario** (verificado con
`systemctl cat cauce-cred-guard.service`): `/etc/systemd/system/cauce-cred-guard.service`
(root, `Type=oneshot`) dispara `/usr/local/sbin/cauce-cred-guard.py` — el script se instala ahí
con OTRO nombre que el fichero de este repo (`cred-guard.py`), y `credential_health.py` va en el
mismo directorio para que el import relativo resuelva. Las plantillas versionadas en
`systemd/cred-guard.*` siguen escritas para una unit `--user` de `stev`; restaurar la unit REAL es
el rename manual de abajo, no una copia literal de esas plantillas.

```sh
# en el VPS, con el repo clonado — unit de SISTEMA (root), no de usuario
install -d -m755 /usr/local/sbin
install -o root -g root -m750 ops/guardias/credential_health.py /usr/local/sbin/
install -o root -g root -m750 ops/guardias/cred-guard.py /usr/local/sbin/cauce-cred-guard.py
install -o root -g root -m644 ops/guardias/systemd/cred-guard.service /etc/systemd/system/cauce-cred-guard.service
install -o root -g root -m644 ops/guardias/systemd/cred-guard.timer /etc/systemd/system/cauce-cred-guard.timer
sed -i 's#^ExecStart=.*#ExecStart=/usr/local/sbin/cauce-cred-guard.py#' /etc/systemd/system/cauce-cred-guard.service
systemctl daemon-reload
systemctl enable --now cauce-cred-guard.timer

# en kratos, con el repo clonado
install -d -m755 ~/.local/bin ~/.config/systemd/user
install -m644 ops/guardias/credential_health.py ~/.local/bin/
install -m755 ops/guardias/cauce-cred-guard-kratos.py \
  ops/guardias/cauce-v3-medico-monitor ~/.local/bin/
install -m755 ops/guardias/polidin-guard.sh ~/.local/bin/
install -m755 ops/cli/cauce  ~/.local/bin/cauce   # fuente única del CLI (1.138 líneas reales)
install -m644 ops/guardias/systemd/cauce-cred-guard-kratos.service \
  ops/guardias/systemd/cauce-cred-guard-kratos.timer \
  ops/guardias/systemd/cauce-v3-medico-monitor.service \
  ops/guardias/systemd/cauce-v3-medico-monitor.timer \
  ops/guardias/systemd/polidin-guard.service \
  ops/guardias/systemd/polidin-guard.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cauce-cred-guard-kratos.timer \
  cauce-v3-medico-monitor.timer polidin-guard.timer
```

Y dentro de `ws-zeus`: `install -m755 ops/guardias/contenedor/polidin-fwd.sh /home/dev/`.

**Comprobá el efecto, no el `systemctl start`.** Matá el proceso a propósito y verificá que el
guardián lo repone; para el túnel, el banner por TCP crudo prueba la cadena entera sin autenticar
(y sin gastar un intento contra `fail2ban`, que banea a la flota entera a los 3 fallos):

```sh
exec 3<>/dev/tcp/172.26.0.7/12222; read -t 8 linea <&3; echo "$linea"   # -> SSH-2.0-OpenSSH_...
```

## Lo que este directorio NO cubre

- El parche compilado que monta `telegram-bridge.override.yaml`
  (`agora-storage:/etc/cauce-v3/patches/telegram-bridge-redaction.js`) es un **artefacto**: sale de
  `services/telegram-bridge/src/redaction.ts`, que sí está versionado. Se regenera compilando; no se
  guarda el binario.
- Las credenciales. A propósito: se rehacen con un login por agente, nunca copiando el archivo de
  otro —copiarlo es exactamente lo que dejó a `janus` y a `claw-iza` sin `refreshToken`.
