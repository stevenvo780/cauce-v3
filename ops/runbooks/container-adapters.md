# Runbook: adapters V3 dentro de containers existentes

## Alcance e invariantes

Esta variante supervisa desde systemd del host Kratos un `docker exec -i` por alias. Soporta systemd de **usuario/rootless** (modo recomendado en Kratos, UID 1000 miembro de `docker`, linger habilitado) y conserva las units system/root como opción. No crea/reinicia containers, no toca V2 y no maneja prompts: el adapter entrega cada prompt al harness exclusivamente por stdin. Las units host-native `cauce-v3-alias-*` permanecen disponibles y no deben estar habilitadas a la vez que `cauce-v3-container-*` para el mismo alias.

`ops/container-aliases.json` fija los 15 pares alias/container, usuario, harness y state dir, y liga
cada placement al `dockerHost` (local cuando se omite) y al `systemdUser` obligatorio. Esos dos
campos forman parte de la identidad del manager: un release consulta cada nombre de unit en todos
los managers declarados y rechaza una copia homónima activa o habilitada fuera de su placement.
Ya **no** fija un destino de mount dedicado: en los containers reales ningún alias tiene un mount
propio en su state dir; el state vive dentro de un bind persistente amplio (p.ej.
`/home/dev/.local`, `/home/claw/.openclaw` o `/workspace`). Antes de leer PKI, el supervisor fija el
ID completo del container, valida el `EXPECTED_IMAGE_ID` obligatorio, valida la label sólo si el
config la declara, y **descubre** en el JSON estructurado de Docker (`{{json .Mounts}}`) el mount
cuyo `Destination` es el ancestro más cercano que **contiene** el state dir, exigiendo que sea un
bind/volumen con `RW=true` (nunca `tmpfs`/efímero) para que el state sobreviva un recreate;
`Type`/`Source`/`Name`/`RW` se re-verifican sólo si el config lo declara. Después de ese primer lookup
por nombre, todo `inspect/exec/cp` usa exclusivamente el ID completo. El
`CAUCE_INSTANCE_ID=systemd-container-<alias>` no depende del ID efímero del container.

## Preparación e instalación

El supervisor usa defaults rootless cuando el host caller no es root:

- código/scripts: el árbol que contiene `ops/`, normalmente `~/.local/share/cauce-v3`;
- bundle host: `${XDG_DATA_HOME:-$HOME/.local/share}/cauce-v3-adapter`;
- config: `${XDG_CONFIG_HOME:-$HOME/.config}/cauce-v3/container-aliases`;
- PKI: `${XDG_CONFIG_HOME:-$HOME/.config}/cauce-v3/container-pki`;
- locks: `$XDG_RUNTIME_DIR/cauce-v3`, o `${XDG_STATE_HOME:-$HOME/.local/state}/cauce-v3/lock` sin XDG runtime.

Todos se pueden fijar con `CAUCE_CONTAINER_{OPS,CONFIG,PKI,BUNDLE,LOCK}_ROOT`. Son paths del **host**. `CONTROL_ROOT=/run/cauce-v3-supervisor` y `/opt/cauce-v3-secrets` siguen siendo paths **dentro del container**, creados por `docker exec --user 0`; rootless host no debilita esa separación.

En modo rootless, el UID instalador completo es un único dominio de confianza: cualquier otro proceso que corra con ese mismo UID puede modificar config, PKI y locks user-owned. No ejecutar workloads host no confiables bajo ese usuario. Las variables de identidad `CAUCE_*` tampoco son autoridad para seleccionar procesos: un match ambiental fuera del leader registrado, su process-group o sus descendientes hace que `stop`/`stopped` fallen cerrado con `78`; nunca se señala ese proceso sólo por copiar el entorno.

La transición de release conserva además una sesión SSH persistente y un `flock` por
`dockerHost + systemdUser` remoto durante todo stop/drain/CAS/migración/restauración. Ese lock vive
en el runtime privado `0700` del mismo usuario rootless; por eso el UID instalador sigue siendo el
dominio de confianza explícito. Si la sesión cae, el controlador termina la transacción hija,
mantiene ingress cerrado y sólo permite reconciliar desde el snapshot content-addressed. No
restaurar una unit manualmente mientras exista esa transición.

### Compatibilidad histórica OpenCode de Kant

Desde el cutover operativo del 2026-07-23, `kant` usa el harness `codex` dentro
de `ctrl-infra`. El server OpenCode, el pointer
`canonical-opencode-session.json` y la TUI `=kant:opencode` pertenecen sólo al
rollback histórico; no son dependencias, probes ni gates de la ruta live.

El bundle conserva el binario OpenCode y su state durable para poder volver al
release anterior mediante el rollback CAS de **sólo Kant**. No iniciar
`opencode serve`, no recrear la TUI y no copiar, editar ni borrar
`sessions.json`/el pointer durante el forward cutover Codex.

### Cutover Codex auditado

Desde el release de ops del 2026-07-23, `kant` (`ctrl-infra`), `socrates`
(`ws-prizma`), `kratos` (`ws-humanizar`) y `salva` (`ws-isa`) usan
explícitamente el harness `codex`.
El preflight live encontró Claude sin autenticación (`loggedIn=false`,
`authMethod=none`) y Codex instalado con `codex login status` satisfactorio en
los tres containers. Alias, tenant, room, container, usuario, home y state dir
no cambian. `vulcano` conserva Claude porque su autenticación live sí estaba
disponible.

Este fallback no copia, migra ni inspecciona credenciales entre CLIs o
containers: cada harness consume únicamente la sesión que ya existe dentro de
su workspace. Volver cualquiera de esos tres aliases a Claude requiere un
preflight live nuevo que pruebe autenticación Claude dentro del container y un
nuevo release inmutable de ops con mapping, manifiesto, units, digests y
evidencia de flota regenerados; no se permite editar sólo la config o la unit
instalada.

1. Publicar el bundle ya construido bajo `~/.local/share/cauce-v3-adapter/releases/<release>` en el host rootless (o `/opt/cauce-v3-adapter/releases/<release>` en modo system). Debe contener `packages/adapter-sdk/dist/src/bin/{openclaw,opencode,claude,hermes,codex}.js`, dependencias/bridges resolubles, ownership del usuario instalador y ningún bit de escritura. No crear ni usar un symlink global `current`: cada alias fija directamente su release inmutable.
2. Crear `~/.config/cauce-v3/container-aliases` `0700`. Copiar cada `generated/container-systemd/rootless/configs/<alias>.env.example` como `<alias>.env`, completar solo valores no secretos y aplicar `0600`. **Obligatorios**: `BUNDLE_RELEASE` (nombre directo bajo `releases/`, no path ni symlink), `BUNDLE_SHA256` (digest SHA-256 del mismo release), `PKI_DIR`, `RELAY_URL` y `EXPECTED_IMAGE_ID`. **Opcionales de refuerzo**: `EXPECTED_LABEL_KEY`/`EXPECTED_LABEL_VALUE` (ambos o ninguno; se omiten cuando la imagen no lleva una label única) y `MOUNT_TYPE`/`MOUNT_SOURCE`/`MOUNT_NAME`/`MOUNT_DESTINATION`/`MOUNT_RW`. El supervisor descubre el bind/volumen persistente que contiene el state dir aunque no se declare ningún `MOUNT_*`; si se declaran, se verifican contra el mount descubierto. `MOUNT_DESTINATION` debe ser ese mount contenedor (no el state dir) y `MOUNT_NAME` sólo aplica con `MOUNT_TYPE=volume`.
3. Crear `~/.config/cauce-v3/container-pki/<alias>` `0700`, con `client.crt`, `client.key` y `ca.crt` regulares, user-owned y `0600`. El archivo `token` es **opcional**: omitirlo activa mTLS-only sin exportar `CAUCE_TOKEN_FILE`. Para OpenClaw API verificado, agregar `openclaw-token` y configurar únicamente su path container-side `OPENCLAW_TOKEN_FILE`; nunca poner tokens en el env.
4. Generar/verificar e instalar las units de usuario:

```sh
python3 ops/scripts/generate-container-units.py --rootless --home "$HOME" \
  --output ops/generated/container-systemd/rootless
(cd ops/generated/container-systemd/rootless && sha256sum -c SHA256SUMS)
python3 ops/scripts/container_ops_digest.py --rootless --check
install -d -m 0700 "$HOME/.config/systemd/user"
install -m 0644 ops/generated/container-systemd/rootless/cauce-v3-container-*.service \
  "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable cauce-v3-container-kant.service
systemctl --user restart cauce-v3-container-kant.service
for gate_round in 1 2; do
  systemctl --user is-active --quiet cauce-v3-container-kant.service
  ops/scripts/container-adapter-supervisor.sh check kant
  # En producción esperar aquí una ventana completa de lease/retry.
  test "$gate_round" = 2 || sleep "${CAUCE_LEASE_WINDOW_SECONDS:-60}"
done
```

Los dos gates deben complementarse con un round-trip real que termine en
`done`; `is-active`/`check` por sí solos no demuestran respuesta del harness.
Ante cualquier fallo, aplicar el rollback CAS de Kant antes de reactivar su
release anterior. No cambiar pins, units o servicios de otros aliases.

`loginctl enable-linger <usuario>` debe estar activo para sobrevivir al logout; en Kratos ya figura `Linger=yes`. El usuario necesita acceso efectivo al socket Docker mediante el grupo `docker`. Las units usan `WantedBy=default.target`, no contienen `User=` y omiten sandboxing que requiere privilegios del manager system.

El modo system/root sigue disponible y genera el árbol histórico:

```sh
python3 /opt/cauce-v3/ops/scripts/generate-container-units.py
(cd /opt/cauce-v3/ops/generated/container-systemd && sha256sum -c SHA256SUMS)
python3 /opt/cauce-v3/ops/scripts/container_ops_digest.py --check
cp /opt/cauce-v3/ops/generated/container-systemd/cauce-v3-container-*.service /etc/systemd/system/
systemctl daemon-reload
/opt/cauce-v3/ops/scripts/container-adapter-supervisor.sh check kant  # falla hasta arrancar: esperado
```

El host necesita Docker, Python 3, `flock`, `timeout`, `find`, `readlink` y `stat`; el container necesita `/usr/bin/python3` y `/usr/bin/env`. La unit rootless corre como el usuario del host, pero dentro del container el lifecycle controller continúa como **root** (`docker exec --user 0`) para poseer el control-plane, y sólo el **proceso hijo adapter/harness** baja al UID/GID mapeado (rechaza UID/GID 0). El lock y la metadata viven en `/run/cauce-v3-supervisor/<alias>` dentro del container (tmpfs, `0700 root:root`), un directorio que el runtime user no puede escribir ni desenlazar. Bundle/helper container-side quedan root-owned y sin bits de escritura; PKI/state quedan `0600`/`0700` bajo ese UID/GID. Cada llamada Docker de control-plane está acotada con `timeout`; el `exec` largo del adapter no. El controller root introspecciona el `/proc` del hijo dropeado igualando fs-credentials (`CAP_SETUID`), sin depender de `CAP_SYS_PTRACE`.

La preparación root del state usa descriptores `openat` con `O_NOFOLLOW`, `mkdirat`, `fchown` y `fchmod` acotados al mount persistente **descubierto** (`--mount`), creando cada componente del state por debajo de ese límite: ningún componente symlink se sigue y no se hace `mkdir/chown/chmod` privilegiado por pathname. Riesgo residual explícito: el runtime user es dueño del state final y puede intentar cambiar componentes después de la validación root; el helper vuelve a abrir toda la cadena con `O_NOFOLLOW`, pero el SDK recibe un pathname y no un FD heredado. El bind persistente puede ser amplio y compartido por dos alias del mismo container (p.ej. `kant`/`argos` en `ctrl-infra` bajo `/home/dev/.local`), pero cada state dir es un subárbol disjunto (`.../cauce-v3/<alias>`); ese árbol de state debe tratarse como dominio de confianza del alias y no compartirse con procesos no confiables.

## Migración del state

Detener y drenar primero el consumer V3 anterior. No copiar un state vivo. Si ya existe state durable del mismo alias, copiarlo conservando ownership al path asignado y verificar que ese path esté respaldado por el mount persistente del container. Paths objetivo:

- `jarvis/janus/hegel/midas/seneca`: `/home/claw/.openclaw/cauce-v3/<alias>`;
- `kant/socrates/argos/kratos/atlas/iza/salva/zeus`: `/home/dev/.local/state/cauce-v3/<alias>`;
- `dedalo/vulcano`: `/workspace/.cauce-v3/<alias>`.

El lock y `cauce-v3-adapter.json` NO viven en el state dir (que el runtime user posee), sino en el control dir root-owned `/run/cauce-v3-supervisor/<alias>`, de modo que el UID del adapter no puede desenlazarlos ni forjarlos. La metadata atómica se publica en fase `starting` (controller PID/starttime, alias, control dir, runtime UID/GID, ID/generación, ejecutable, digest) apenas se toma el control —antes de cualquier operación larga— y luego se actualiza a `running` con PID/PGID/SID/starttime del hijo. Metadata incompleta o con un PID vivo discrepante se preserva y bloquea con exit `78`; solo se limpia cuando el PID no existe y la generación almacenada es verificablemente anterior. `stop` nunca hace fail-open: sin metadata inspecciona el lock y `/proc` por alias+generación y devuelve `78` ante cualquier proceso/lock vivo o ambigüedad; sólo reporta detenido con ausencia total demostrada. Habilitar un alias recién después del gate explícito de drain/cutover:

```sh
export CAUCE_CHANGE_ID=CHG-123
export CAUCE_CUTOVER_CONFIRM=cutover:container:kant:CHG-123
export CAUCE_SYSTEMD_SCOPE=user
ops/scripts/cutover.sh container kant /ruta/snapshot-drain.json
ops/scripts/container-adapter-supervisor.sh check kant
```

## Restart, verificación y recreación

`Restart=always`/`RestartSec=5s` vuelve a ejecutar el supervisor, limitado por `StartLimitIntervalSec=300s`, `StartLimitBurst=10` y `RestartPreventExitStatus=2 73 78` para errores permanentes de config/lock/metadata del supervisor. Una salida legítima del adapter con código `2/73/78` se remapea a `70` para que no se confunda con esos códigos permanentes del supervisor. Si el container reinicia o se recrea, cambia la generación persistida; stop/check nunca señalizan metadata de otra ID/generación. Una recreación aborta porque el ID viejo desaparece y ninguna mutación se dirige al nombre nuevo. Para restart con el mismo ID, cada activación corre dentro de `guard-exec`, que compara el starttime de `/proc/1`; los `docker cp` escriben primero a staging nombrado por generación y nunca lo activan después de un mismatch. Con el mismo mount validado, el siguiente start limpia solo metadata stale segura, repone bundle/PKI y conserva el instance ID. `kant`/`argos` mantienen árboles y locks disjuntos en `ctrl-infra`.

```sh
systemctl --user status cauce-v3-container-kant.service
ops/scripts/container-adapter-supervisor.sh check kant
journalctl --user -u cauce-v3-container-kant.service --since -10m
```

Los logs no deben contener prompts, respuestas, tokens ni material PKI. Para validar el soporte sin Docker real: `node ops/tests/container-supervisor.test.mjs`; `ops/scripts/validate.sh` también verifica mapping, generación reproducible y checksums.

`check` recalcula el digest del bundle activo y verifica identidad completa del líder y su grupo. El cutover además exige mediante `migration-gate.mjs` exactamente un consumer, poller y lease owner V3. Si esa evidencia live no está disponible, no habilitar el alias: el supervisor local no puede demostrar por sí solo unicidad en gateway/DB.

### Pin y rollback por alias

La config de cada alias es su único pin. `pin-container-release.py` toma un lock
por alias, verifica que el release directo sea inmutable y que su digest
coincida, aplica compare-and-swap sobre el release/digest actualmente esperados,
preserva comentarios y las demás claves, y publica el config `0600` mediante
`fsync` + rename + `fsync` del directorio. No abre ni copia PKI.

```sh
# Migración única desde el pointer global histórico. El release y digest se
# obtienen de la metadata lifecycle viva de ESE alias, no del symlink global.
ops/scripts/pin-container-release.py migrate kant \
  --expected-current "$HOME/.local/share/cauce-v3-adapter/current" \
  --expected-sha256 sha256:<digest-configurado> \
  --release release-vivo-de-kant \
  --sha256 sha256:<digest-vivo-de-kant>

# Canary de kant: los demás aliases conservan su propio BUNDLE_RELEASE.
ops/scripts/pin-container-release.py pin kant \
  --expected-release release-20260722 \
  --expected-sha256 sha256:<digest-anterior> \
  --release release-20260723 \
  --sha256 sha256:<digest-nuevo>
systemctl --user restart cauce-v3-container-kant.service
ops/scripts/container-adapter-supervisor.sh check kant

# Rollback CAS: falla si otro operador ya cambió el pin.
ops/scripts/pin-container-release.py rollback kant \
  --expected-release release-20260723 \
  --expected-sha256 sha256:<digest-nuevo> \
  --release release-20260722 \
  --sha256 sha256:<digest-anterior>
systemctl --user restart cauce-v3-container-kant.service
ops/scripts/container-adapter-supervisor.sh check kant
```

En modo system ejecutar el mismo helper instalado bajo `/opt/cauce-v3` como
root. En rootless ejecutarlo como el usuario dueño de config/bundles. No editar
simultáneamente los `.env`; un CAS fallido exige releer sólo
`BUNDLE_RELEASE`/`BUNDLE_SHA256` y decidir de nuevo.
`migrate` sólo acepta el `BUNDLE_CURRENT` exacto y su digest configurado, valida
el release directo e inmutable que realmente ejecuta el alias y reemplaza
únicamente el selector legacy por `BUNDLE_RELEASE`; un segundo intento falla
cerrado. Nunca se deriva el release vivo del symlink global.

## Rollback

1. Drenar el consumer V3 y ejecutar `cutover-rollback.sh container <alias> SNAPSHOT`. `cutover.sh` y `cutover-rollback.sh` comparten un `flock` de host por alias, así que no pueden intercalarse dos operaciones para el mismo alias. El script hace `disable --now`, exige que AMBAS familias (`cauce-v3-alias-<alias>` host-native y `cauce-v3-container-<alias>`) queden `inactive` Y `disabled` y que `container-adapter-supervisor.sh stopped` pruebe la ausencia antes del snapshot `rollback-ready`.
2. `ExecStop` fija con pidfd y verifica starttime del leader registrado, los miembros de su process-group y sus descendientes; sólo ese conjunto puede recibir TERM/KILL. Un proceso que únicamente copie el entorno `CAUCE_*` nunca es target: fuerza `78`, preserva metadata y bloquea rollback-ready. No se borra metadata hasta probar que el conjunto legítimo terminó; cualquier mismatch o ausencia de pidfd falla cerrado.
3. Conservar state y PKI. Para volver de bundle, ejecutar el rollback CAS por alias anterior; nunca mover un pointer global ni cambiar el release de otros aliases. Reiniciar y verificar sólo la unit del alias antes de repetir el cutover.
4. Para volver a la unit V3 host-native, usar el parámetro explícito `host-native`; nunca habilitar ambas familias. V2 sigue su runbook separado y estos scripts nunca lo modifican.

Para `kant`, el rollback al release histórico conserva `sessions.json`, el
pointer canónico y el state OpenCode sin editarlos. La estrategia anterior debe
seguir siendo `observed`, nunca `generated`. Orden obligatorio: rollback CAS,
restaurar/verificar healthy el único server OpenCode histórico, restart y gates
del adapter anterior, round-trip real y recién entonces recrear la TUI. Nunca
iniciar un segundo server.
