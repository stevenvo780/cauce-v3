# Runbook: deploy Cauce V3 aislado

## Preflight de release

1. Confirmar que el target, DB, DNS, collectors y unidades pertenecen a V3; no apuntar scripts a V2.
2. Construir runtime/consola con `make -C ops release-build` desde el commit RC exacto, pasando
   los tres child manifests `linux/amd64`: Node
   `docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819`,
   Python `docker.io/library/python@sha256:53739acebd52a300f19f52d93f2a6165f63300689bdf6f8af2bff0d63780e5e6`
   y nginx `docker.io/nginxinc/nginx-unprivileged@sha256:28d91bdce70ad09025ea901458fdd149259d8e05982ade79d4ef2c0d9470eb48`
   en `CAUCE_NODE_BASE_IMAGE`, `CAUCE_PYTHON_BASE_IMAGE` y `CAUCE_NGINX_BASE_IMAGE`. Publicar ambas
   imágenes por RepoDigest. El productor rechaza índices multiarch/roles incorrectos, valida los
   labels finales y conserva RepoDigest, manifest digest, media type, plataforma e image ID en
   `build.json` schema v7. `CAUCE_RELEASE_PULL=0` no descarga bases: exige las tres ya cacheadas.
   Index y tracked worktree deben estar limpios; el único untracked permitido es
   `apps/console/src/features/_grafo/`, que no entra al commit ni al `git archive`.
3. Completar fuera del repo un env `0600` desde `ops/config/prod.env.example`. Son PATHs/config; el contenido sensible queda en archivos del gestor de secretos.
4. Ejecutar QA real, restart auténtico, `make -C ops smoke-cli` para los cinco
   ejecutables, restore drill y hashes. CLI smoke sigue siendo version/help-only.
5. Ejecutar `CAUCE_ENV_FILE=/etc/cauce-v3/prod.env make -C ops release-gate`.

El release gate ejecuta primero `physical-fleet-gate.py`: todo container Docker declarado debe
existir antes de cualquier migración. También exige snapshot de flota v3 exacto (15 agentes, un
principal de sistema, tres históricos), permisos completos de `agent_notify`, leases y placements.
No tolera ausencia de Docker Compose v2 o `docker build`, build evidence viejo, SHA inválido, tests
reales/restart skipped o fallidos, unidades systemd desactualizadas ni imagen sin `@sha256:`.
En la revalidación final enumera todos los servicios Compose materializados, incluidos los
detenidos, y por eso no exige perfiles inactivos que nunca se crearon. `migrator` debe existir una
sola vez, haber terminado con `exited/0`, y todos los demás servicios materializados deben estar
`running`. Para cada réplica exige simultáneamente: `.Config.Image` igual al RepoDigest
seleccionado, `.Image` igual al ID recuperado de ese digest y el label
`com.docker.compose.config-hash` igual a `docker compose config --hash <servicio>`. Así ni un
migrador omitido ni un restart que conservó imagen o configuración vieja pueden pasar como deploy
actual.

### Bootstrap reproducible del host actual

El host legado actual sí tiene `prod.env`, pero sólo contiene los dos selectores de imagen del
contrato histórico y éstos todavía son tags mutables. No se edita, se sourcea ni se reconstruye
leyendo valores de `docker inspect` o del historial de shell. Primero se autentica el conjunto
Compose observado: base, PostgreSQL local y los cuatro overrides existentes. Dentro de
`/etc/cauce-v3/compose-overrides`, crear
`active.manifest` con una línea `active <sha256> <basename>` en este orden exacto:

1. `telegram-bridge.active.yaml`
2. `store-fanin.yaml`
3. `terminal-minrows.yaml`
4. `directiva-20260825.yaml`

No usar glob; cualquier YAML adicional debe declararse `inactive` con su hash o el resolver falla.
`ops/scripts/compose-files.sh` verifica contenido, inventario, orden y ausencia de symlinks antes de
invocar Docker.

Un host cuyo `prod.env` realmente no exista usa el bootstrap create-only descrito más abajo. El
host actual no entra por esa ruta. El paso 2→6 es únicamente una normalización del release vivo:
primero se publican RepoDigests que recuperen exactamente los mismos image IDs que los dos tags
seleccionados, junto con la evidencia bridge y el baseline del estado actual. No se usa aquí el
runtime del release nuevo. El baseline debe declarar exactamente ese runtime vivo, esa consola y el
manifest anterior; cualquier divergencia falla antes de tocar el selector. El cambio real de
release ocurre después, exclusivamente mediante el CAS completo de ocho campos.

```sh
two_selector_sha=$(sudo sha256sum /etc/cauce-v3/prod.env | awk '{print "sha256:" $1}')
current_manifest=/etc/cauce-v3/compose-overrides/active.manifest
current_manifest_sha=$(sudo sha256sum "$current_manifest" | awk '{print "sha256:" $1}')
sudo install -d -m 0700 -o root -g root /etc/cauce-v3/releases/bootstrap-<change-id>
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_BOOTSTRAP_TWO_SELECTOR_ENV_SHA256="$two_selector_sha" \
  CAUCE_BOOTSTRAP_RUNTIME_IMAGE='<RepoDigest-del-tag-runtime-vivo@sha256>' \
  CAUCE_BOOTSTRAP_CONSOLE_IMAGE='<RepoDigest-del-tag-console-vivo@sha256>' \
  CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST="$current_manifest" \
  CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256="$current_manifest_sha" \
  CAUCE_BOOTSTRAP_ROLLBACK_BASELINE=/etc/cauce-v3/releases/<release>/rollback-baseline.json \
  CAUCE_BOOTSTRAP_ROLLBACK_BASELINE_SHA256='sha256:<64-hex>' \
  CAUCE_BOOTSTRAP_BACKUP_ENV_FILE=/etc/cauce-v3/releases/bootstrap-<change-id>/prod.env.before \
  make -C ops release-bootstrap-two-selector
```

El helper exige exactamente dos selectores de entrada, autoriza todos sus bytes por SHA y conserva
byte a byte el resto. Contra el daemon local canónico exige que cada tag resuelva al mismo image ID
que su RepoDigest target. Enumera además todos los containers `running` del proyecto
`cauce-v3-prod`: runtime y consola deben ejercer sus tags/digests y cada fragmento restante debe
estar configurado por RepoDigest, con image ID y `com.docker.compose.config-hash` válidos. No
homogeneiza ni relaja el gate posterior del mosaico.

El backup debe vivir bajo un parent canónico, propiedad del operador y no escribible por
grupo/otros; nunca puede ser el env, el lock, el manifest, el baseline ni compartir su inode. La
publicación create-only usa un descriptor autenticado del directorio y la secuencia
`fsync(file) → link → unlink(temp) → fsync(directory)`. Una caída en cualquiera de esas fronteras
se reanuda recuperando únicamente el temporal reservado y los mismos bytes autorizados. Manifest,
baseline, prueba Docker y nombre/inode del backup se revalidan después del replace; cualquier
carrera restaura el selector original por CAS bajo el mismo lock antes de devolver error. Ya con
seis selectores, capturar el writer snapshot y ejecutar 6→8 como se indica en la sección «Baseline
y CAS de release»; esa transición aplica la misma compensación si el snapshot o baseline cambia.
Si el proceso recibe `SIGKILL` después del replace 2→6, el reintento con la misma autorización
reconoce únicamente el replacement exacto derivado del backup autenticado. Repite toda la admisión
y finaliza idempotentemente; si ya no pasa, restaura byte a byte el preestado del backup. No se
edita el selector para «destrabar» el reintento.

El parent canónico de `prod.env` y de `.<nombre>.release-pin.lock` también debe pertenecer a root o
al operador efectivo y cumplir `mode & 022 == 0`; un parent `0777` se rechaza antes de mutar. El
helper mantiene un FD `O_DIRECTORY`, abre ambos nombres con `dir_fd`, compara cada nombre contra su
FD y revalida la identidad del parent antes y después de leer, bloquear o reemplazar. Si el nombre
del directorio pasa a otro inode, aborta; una compensación pendiente opera sólo sobre el FD ya
autenticado para no escribir en el directorio sustituto.

La misma disciplina protege manifest, baseline y snapshot: cada parent debe ser canónico, de owner
autorizado y no escribible por grupo/otros. El digest se calcula con
`stat(name) → openat(O_NOFOLLOW) → read/fstat → stat(name)` sobre un único parent FD; si un `rename`
atómico cambia el pathname durante la lectura, la admisión falla aunque el inode ya abierto tuviera
los bytes autorizados.

Para un host nuevo sin selector, crear un archivo privado de referencias, no de secretos literales.
El resultado se genera como candidato: todavía no es el selector de producción.

```sh
sudo install -m 0600 -o root -g root ops/config/prod.env.example /root/cauce-prod.references
sudoedit /root/cauce-prod.references
sudo python3 ops/scripts/bootstrap-prod-env.py \
  --authorized-references /root/cauce-prod.references \
  --output /root/cauce-prod.candidate.env
```

Completarlo sólo desde rutas administradas autorizadas y desde los digests publicados por
`release-build`; fijar `CAUCE_LOCAL_POSTGRES=1`, el manifest absoluto y todos los images como
`name@sha256`. El baseline del candidato debe existir previamente, estar ligado por SHA y declarar
como forward runtime el runtime actual autorizado; se produce con el mismo contrato de evidencia
bridge descrito abajo, nunca desde `docker inspect` ni desde memoria operativa. El candidato debe
guardar el manifest y su digest exacto en `CAUCE_COMPOSE_OVERRIDE_MANIFEST` y
`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256`, y fijar `COMPOSE_PROJECT_NAME=cauce-v3-prod`; sólo admite perfiles `origin-relay`, `telegram`,
`terminal`, `shadow`, `observability` y no puede contener controles `DOCKER_*`/`COMPOSE_*`
alternativos.

La primera publicación usa el lock normal y un create-only atómico. Autorizar los bytes exactos
del candidato y del manifest, y conservar los SHA en el ledger privado:

```sh
candidate_sha=$(sudo sha256sum /root/cauce-prod.candidate.env | awk '{print "sha256:" $1}')
override_sha=$(sudo sha256sum /etc/cauce-v3/compose-overrides/active.manifest | awk '{print "sha256:" $1}')
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_BOOTSTRAP_CANDIDATE_ENV_FILE=/root/cauce-prod.candidate.env \
  CAUCE_BOOTSTRAP_CANDIDATE_ENV_SHA256="$candidate_sha" \
  CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256="$override_sha" \
  make -C ops release-bootstrap-legacy
```

`release-bootstrap-legacy` valida otra vez candidato, manifest y baseline bajo el flock, publica los
bytes por link atómico+fsync y falla si `prod.env` ya existe: un host inicializado sólo puede cambiar
por CAS. El bootstrap nunca muestra valores, exige archivos `0600`, rechaza tags mutables y no
sobrescribe. La validación efectiva se hace redirigiendo `compose config` a un temporal `0600`; no
imprimirlo a terminal.

Si el host ya tiene el selector legado de cinco campos y sólo falta
`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256`, no se recrea ni se edita a mano. Autorizar el env completo
y el manifest seleccionado desde el ledger privado, y ejecutar la migración create-field exacta:

```sh
legacy_env_sha=$(sudo sha256sum /etc/cauce-v3/prod.env | awk '{print "sha256:" $1}')
legacy_manifest=/etc/cauce-v3/compose-overrides/active.manifest
legacy_manifest_sha=$(sudo sha256sum "$legacy_manifest" | awk '{print "sha256:" $1}')
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256="$legacy_env_sha" \
  CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST="$legacy_manifest" \
  CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256="$legacy_manifest_sha" \
  make -C ops release-bootstrap-manifest-sha
```

Ese target sólo acepta exactamente cinco selectores, autentica el baseline y agrega el sexto campo
por replace atómico bajo el mismo flock. Repetirlo, entregar un SHA viejo o apuntar a otro manifest
falla sin cambiar el env. Desde entonces toda operación Compose compara los bytes contra el SHA
seleccionado antes y después de resolver el conjunto de archivos.

### Baseline y CAS de release

Los YAML históricos no se mueven ni se borran. Para el RC, publicar dentro del mismo directorio de
overrides un manifest nuevo que los enumere todos como `inactive` y autentique sus bytes:

```sh
sudo python3 ops/scripts/create-inactive-override-manifest.py \
  --overrides-dir /etc/cauce-v3/compose-overrides \
  --output /etc/cauce-v3/compose-overrides/release-<commit>.manifest
```

Antes de cambiar `prod.env`, el productor independiente debe entregar `rollback-bridge.json` modo
`0600` y su SHA. La evidencia sólo vale si el patch está versionado en main y reproduce exactamente
el tree bridge desde origin/main. Crear entonces el baseline inmutable; el comando recupera y
verifica por ID el runtime candidato, el runtime bridge y la consola previa antes de publicar:

```sh
baseline_sha=$(sudo python3 ops/scripts/rollback-baseline.py create \
  --output /etc/cauce-v3/releases/rollback-baseline-<commit>.json \
  --forward-release-commit '<commit-completo>' \
  --forward-runtime-image '<runtime-candidato@sha256>' \
  --forward-runtime-source-digest 'sha256:<source-digest-runtime>' \
  --bridge-runtime-image '<runtime-bridge@sha256>' \
  --console-image '<consola-previa@sha256>' \
  --override-manifest '/etc/cauce-v3/compose-overrides/<manifest-previo>' \
  --bridge-evidence '/etc/cauce-v3/releases/rollback-bridge.json' \
  --bridge-evidence-sha256 'sha256:<sha-evidencia>')
```

El `swap` no es por sí solo un despliegue. Preparar las entradas target que no provienen de
`ops/artifacts/release/build.json` y ejecutar primero el preflight read-only del único driver.

Antes del primer uso de los ocho selectores, capturar el inventario exacto de writers externos y
Compose bajo el mismo lock. El JSON se publica create-only, modo `0600`, junto al baseline durable;
su marker `${snapshot}.state.json` no contiene secretos, es ASCII canónico modo `0444` (Compose
local monta file-secrets conservando los permisos del source) y usa un `releaseId` slug
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. En `candidate`, `writersExpected == writersObserved`; en
`rollback_bridge_degraded`, ambos deben ser cero. El marker es la fuente operativa para métricas y
se recrea `outbox-metrics` después de cada replace atómico para no conservar el inode anterior.

Para migrar un env histórico de seis a ocho selectores:

```sh
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_RELEASE_WRITER_SNAPSHOT_FILE=/etc/cauce-v3/releases/<release-actual>/writer-snapshot.json \
  make -C ops release-capture-writer-snapshot
six_selector_env_sha=$(sudo sha256sum /etc/cauce-v3/prod.env | awk '{print "sha256:" $1}')
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_BOOTSTRAP_SIX_SELECTOR_ENV_SHA256="$six_selector_env_sha" \
  CAUCE_RELEASE_WRITER_SNAPSHOT_FILE=/etc/cauce-v3/releases/<release-actual>/writer-snapshot.json \
  CAUCE_RELEASE_WRITER_SNAPSHOT_SHA256=sha256:<sha-impreso-por-capture> \
  make -C ops release-bootstrap-writer-snapshot
```

6→8 autentica el contrato anterior completo: RepoDigests de runtime/consola, bytes y SHA del
manifest, bytes y SHA del baseline y su vínculo semántico con runtime/consola/manifest. Manifest,
baseline y snapshot se leen por path+SHA antes y después de la validación semántica y otra vez tras
el replace. Una carrera compensa al env original de seis campos. Un `SIGKILL` post-replace se
recupera sólo si el env de ocho campos coincide exactamente con el replacement reconstruible cuyo
preestado vuelve a dar el SHA autorizado; el reintento lo finaliza o restaura ese preestado.

Para el target, repetir la captura junto a su baseline pasando también
`CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE` y `_SHA256`; no reutilizar un path mutable ni copiar un
snapshot manualmente. El hash devuelto se pasa como selector target. Luego ejecutar el preflight:

```sh
target_manifest_sha=$(sudo sha256sum /etc/cauce-v3/compose-overrides/release-<commit>.manifest | awk '{print "sha256:" $1}')
legacy_snapshot=/etc/cauce-v3/releases/legacy-fragment-<change-id>.json
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST=/etc/cauce-v3/compose-overrides/release-<commit>.manifest \
  CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256="$target_manifest_sha" \
  CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE=/etc/cauce-v3/releases/rollback-baseline-<commit>.json \
  CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256=sha256:<64-hex> \
  CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE=/etc/cauce-v3/releases/writer-snapshot-<commit>.json \
  CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256=sha256:<64-hex> \
  CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE="$legacy_snapshot" \
  make -C ops release-deploy-preflight
```

El preflight valida los bytes del manifest por path+SHA, topología Compose, health y que el conjunto
running y materializado sea exactamente el conjunto long-lived configurado: un servicio extra,
duplicado o detenido falla antes de pull, CAS o migración. En una flota homogénea cada container
debe corresponder al expected-old por RepoDigest, image ID, `Config.Image` y config hash. El
baseline target puede y debe declarar un runtime bridge distinto del runtime viejo cuando el schema
objetivo lo exige, pero su RepoDigest, ID, evidencia reproducible y SHA quedan autenticados; además,
el label de compatibilidad del bridge debe coincidir con `schemaCompatibility.compatibleThrough`
del `build.json`. Consola y manifest de retorno deben coincidir exactamente con los actuales. No
cambia selectores, servicios ni DB. Devuelve un
`CAUCE_DEPLOY_CONFIRM=deploy-release:sha256:<...>` ligado a los ocho selectores old, los ocho
target, el snapshot físico del mosaico cuando existe y sus hashes.

El primer deploy desde el host legado actualmente fragmentado no usa un bypass de expected-old ni
presupone que el bootstrap homogeneizó containers. La ruta debe ser absoluta, todavía inexistente y
estar en un directorio privado, propiedad de root y no escribible por grupo/otros.

Con `CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE="$legacy_snapshot"`, el preflight observa por cada servicio
el `Config.Image` RepoDigest, image ID, config hash e ID del container. Sólo admite fragmentación en
los servicios que la transacción recrea. Construye en memoria un override JSON por servicio y exige
que `compose config --hash` reproduzca exactamente cada config hash observado. El SHA del snapshot,
su path y los ocho selectores quedan ligados a `CAUCE_DEPLOY_CONFIRM`; cambiar un container, imagen
o configuración entre ambas invocaciones cambia la confirmación y evita todo pull/CAS. El token
también liga path+SHA del snapshot global de writers; cualquier cambio de unit fragment, estado,
lease o inventario Compose entre preflight y deploy invalida la admisión.

En modo mutante el driver recupera cada imagen del mosaico por RepoDigest y exige el mismo image ID,
publica el snapshot modo `0600` por link create-only+fsync, normaliza sólo los servicios de release
al expected-old canónico y vuelve a admitir inventario, imágenes, config hashes, manifests,
snapshot y CAS inmediatamente antes del swap. Un fallo parcial o drift restaura con el override
exacto y verifica de nuevo inventario/IDs/config/health; si esa restauración falla termina
`CRITICAL` con código 74. No ejecuta el migrator hasta que esta normalización reversible terminó.
Después de una migración durable nunca vuelve al mosaico: sólo puede seleccionar el bridge
acreditado para el schema objetivo.

Copiar exactamente la confirmación y ejecutar la misma invocación con el target mutante:

```sh
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST=/etc/cauce-v3/compose-overrides/release-<commit>.manifest \
  CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256="$target_manifest_sha" \
  CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE=/etc/cauce-v3/releases/rollback-baseline-<commit>.json \
  CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256=sha256:<64-hex> \
  CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE=/etc/cauce-v3/releases/writer-snapshot-<commit>.json \
  CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256=sha256:<64-hex> \
  CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE="$legacy_snapshot" \
  CAUCE_DEPLOY_CONFIRM=deploy-release:sha256:<confirmacion-exacta> \
  make -C ops release-deploy
```

`ops/scripts/deploy-release.sh` entra por `pin-production-release.py locked-exec`: expected-old,
validación semántica/evidencia recuperable, CAS completo de runtime/consola/manifest/path+SHA del
baseline y snapshot-writers/path+SHA, migrator one-shot, recreación exacta `--no-build`, health y
`release-candidate.py --release-host-ready` conservan el mismo FD/token de lock. El manifest forward
es content-addressed por path+SHA y se revalida antes y después de cada uso Compose, health o gate.
El replace del CAS de ocho campos queda todavía dentro de una admisión compensable: si el manifest,
baseline, snapshot o el read-back cambia después de publicar, el helper vuelve a publicar los ocho
selectores old con sus bytes exactos antes de devolver el error. Ningún fallo post-replace deja un
selector target parcialmente admitido.

Schema 036 es una frontera stop/drain, no una migración compatible con workers viejos. Antes de
aplicar `036_shadow_router_target_phase.sql`, detener `shadow-router` y `shadow-cutover-guard` junto
con el resto de writers, comprobar que no queda ninguna fila `shadow_router_inbox` en
`status='processing'` y recién entonces ejecutar el migrator. La migración toma
`ACCESS EXCLUSIVE` y vuelve a comprobar el drain dentro de la transacción; un claim pre-036 o un
lease que cruce la frontera aborta el release. El runtime 036 sólo arranca después del COMMIT y del
probe exacto de columna, constraints, funciones y triggers.

`037_console_publish_intent_indexes.sql` es la capa de operabilidad del journal durable de consola
sobre esa frontera ya drenada. El primer upgrade exige cero eventos `console.publish.%`: no inventa
heads para datos experimentales. Instala exactamente cuatro índices parciales (`key`, `nonce`,
`rate`, `head`) y el gate PostgreSQL demuestra tanto sus definiciones/predicados como su uso bajo
planes genéricos. El release objetivo y su bridge declaran compatibilidad exacta hasta 037; 036
sigue siendo la frontera stop/drain que obliga a cerrar writers antes del migrator.

Si falla antes de una migración durable, el driver aplica el CAS inverso y acredita imágenes,
config hashes, health y selectores viejos; si el baseline de entrada era fragmentado, restaura ese
mosaico exacto. Desde que el schema objetivo de `build.json` queda durable —también si se perdió la
respuesta del migrator después de COMMIT— toda compensación selecciona el runtime bridge
acreditado por el baseline, junto con consola/manifest previos; recrea, exige exactamente ese mismo
schema y health. Nunca vuelve al runtime viejo ni al mosaico después de esa frontera. Un resultado SQL ambiguo detiene la
automatización con código 72; selector o servicio de compensación fallido usa 70/71 y se declara
CRITICAL. Una respuesta perdida de cualquier CAS se resuelve re-admitiendo el estado durable exacto:
forward, inverso o bridge pueden continuar sólo si los ocho selectores coinciden por completo con
uno de esos estados; si no coinciden ni con old ni con target, termina `CRITICAL` con código 75. No
se presenta un rollback parcial como éxito.

Tras una migración durable, el bridge es deliberadamente degradado: detiene relay-worker,
terminal-relay, telegram-bridge, shadow-router y todo adapter/model writer externo declarado por el
manifest canónico de aliases/units; exige procesos, leases y writers DB en cero antes del CAS.
Mantiene gateway, consola, outbox-metrics, PostgreSQL e infraestructura/observabilidad read-only;
dispatcher también queda fuera porque muta claims, reintentos y entregas. Los contenedores de
dispatcher y writers se eliminan después del drain, y las unidades externas originalmente
`enabled` quedan persistente y reversiblemente `disabled --now`: ni un reinicio de Docker ni un
boot del host puede reabrir el plano de escritura. Telegram y PTY quedan temporalmente
indisponibles y esto debe alertar como crítico, no
como healthy normal. Un writer desconocido, una unit declarada que no se pueda detener/restaurar o
un marker/métrica discrepante aborta y compensa. Al volver bridge→candidate se restaura exactamente
el conjunto enabled/active previo y se acredita que el outbox sigue progresando.
No invocar `pin-production-release.py swap` aisladamente.

El proceso ejecuta con entorno cerrado: PATH fijo, proyecto `cauce-v3-prod`, perfiles sólo desde la
allowlist del env privado, daemon fijo `unix:///var/run/docker.sock` y sin `DOCKER_CONTEXT` ni
interpolación ambiental. Para operaciones productivas ordinarias usar exclusivamente
`make -C ops prod-up` y `make -C ops prod-down` entran por el lock autenticado. El target
`make -C ops migrate` es un tombstone que falla cerrado: el target schema 037 —incluida la frontera
stop/drain de 036— sólo puede migrarse mediante
el flujo transaccional de `make -C ops release-deploy`, que detiene gateway, console, dispatcher y
writers, demuestra el drenaje, migra y después restaura candidate o el bridge acreditado. No
invocar `docker compose up/down/run migrator` directamente.
La unidad `cauce-v3-compose@prod.service` entra por `systemd-stack.sh`, que llama al mismo
`deploy-release.sh prod-up|prod-down` autenticado. Tanto en candidate como en bridge enumera sólo
servicios long-lived con `--no-deps`; nunca ejecuta el migrator por efecto lateral de boot/reload.

Con Zeus deliberadamente apagado durante mantenimiento, añadir
`CAUCE_DEPLOY_ZEUS_MAINTENANCE=1`, un `CAUCE_CHANGE_ID` no secreto y
`CAUCE_MAINTENANCE_CONFIRM=offline:Steven:zeus:<mismo-change-id>` tanto al preflight como al deploy.
Sólo esas dos autoridades de mantenimiento atraviesan el entorno cerrado. Ese modo ejecuta el gate
acotado y declara explícitamente que la evidencia estricta permanece cerrada. Después de reactivar
Zeus se debe ejecutar la admisión estricta sin esa excepción; el resultado acotado no se renombra
como `release-host-ready`.

### Cierre de mantenimiento: rotación del snapshot tras reactivar Zeus

Reactivar Zeus cambia deliberadamente el conjunto de writers y vuelve obsoleto el snapshot capturado
durante la ventana. Antes de la rotación, `release-candidate.py --release-host-ready` debe fallar al
comparar ese snapshot con unidades y leases reales; no se transforma ese fallo en una excepción ni se
edita el JSON seleccionado. Con Zeus ya `active` y su lease vigente, publicar un nombre nuevo dentro
del mismo directorio durable del baseline:

```sh
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_CHANGE_ID='<change-id-de-cierre>' \
  CAUCE_WRITER_ROTATION_FILE=/etc/cauce-v3/releases/writer-snapshot-zeus-active-<change-id>.json \
  CAUCE_WRITER_ROTATION_CONFIRM='active:Steven:zeus:<change-id-de-cierre>' \
  make -C ops release-rotate-writer-snapshot
```

Ésta es la única transición permitida para ese cierre. Conserva el flock autenticado y los guards de
los managers remotos; exige los ocho selectores exactos en modo `candidate` (nunca bridge), marker
actual válido y snapshot viejo con Zeus inactivo. Captura unidades y fleet/leases otra vez, y sólo
admite que el active-set cambie en una entrada: Zeus pasa a una única unit activa y lease activo;
Compose y todos los demás aliases deben permanecer idénticos en su conjunto activo.

El snapshot nuevo se publica `0600` por nombre create-only; un reintento sólo acepta bytes idénticos.
Antes del CAS publica su marker `candidate`, recrea `outbox-metrics` contra ese marker y verifica sus
cuatro gauges. El CAS 8→8 conserva runtime, consola, manifest y baseline byte por byte y cambia sólo
path+SHA del snapshot. Una respuesta perdida se resuelve readmitiendo el estado completo; un fallo o
drift restaura por CAS el selector anterior, su marker y el consumer. Al final ejecuta
`release-candidate.py --release-host-ready`, cuyo contrato comprueba el snapshot `restored` al inicio
y al final, y vuelve a admitir los ocho selectores. Repetir el mismo comando después de éxito no
recaptura ni inventa el preestado: revalida el snapshot ya seleccionado, recrea el consumer y repite
el gate estricto.

Los dos clientes nuevos se emiten sin tocar credenciales históricos:

```sh
sudo env CAUCE_CLIENT_CA_CERT=/ruta/autorizada/client-ca.crt \
  CAUCE_CLIENT_CA_KEY=/ruta/autorizada/client-ca.key \
  ops/scripts/provision-terminal-client.sh gateway-relay-client /etc/cauce-v3/pki
sudo env CAUCE_CLIENT_CA_CERT=/ruta/autorizada/client-ca.crt \
  CAUCE_CLIENT_CA_KEY=/ruta/autorizada/client-ca.key \
  ops/scripts/provision-terminal-client.sh terminal-relay-client /etc/cauce-v3/pki
```

El provisioner sólo acepta esos CN, agrega `clientAuth`, verifica CA/key/fecha/CN, publica uid 1000
con key 0400 y cert 0444 y rechaza cualquier overwrite. En `prod.env`, apuntar gateway→relay al
primer par y relay→gateway al segundo. `validate-terminal-release.py` vuelve a comprobar el Compose
efectivo y que la lista de CN conserve `console-client,gateway-relay-client`.

## Desarrollo y test

```sh
CAUCE_ENV_FILE=/ruta/privada/dev.env ops/scripts/compose.sh dev up --build -d --wait
ops/scripts/compose.sh test up --build --abort-on-container-exit --exit-code-from e2e
```

Dev (`deploy/compose.dev.yaml`) usa HTTP/WS y auth de desarrollo solo sobre bind loopback por defecto. Test (`ops/compose.test.yaml`) es efímero. Ninguno acredita producción TLS.

## Producción

`deploy/compose.yaml` no contiene `build:` ni PostgreSQL local. Usa una DB administrada cuyo `DATABASE_URL` se monta como secret y debe incluir `sslmode=verify-full` más CA. Para una DB autocontenida con TLS real:

```sh
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env make -C ops prod-up
```

`CAUCE_LOCAL_POSTGRES=1` debe estar fijado dentro del env privado, no como variable ambiental. El
certificado del overlay debe tener SAN `postgres`; password/cert/key/CA se montan como secrets y
`5432` no se publica.

### TLS/auth

- Gateway escucha HTTPS `8443`; health usa `https://gateway:8443` y CA montada.
- Consola escucha HTTPS `8444`, verifica el certificado upstream y presenta client cert. CSP mantiene scripts self-only y habilita solo atributos de estilo que xterm necesita.
- Los certificados internos deben incluir SAN `gateway` y `console` respectivamente;
  no desactivar hostname verification para acomodar certificados incorrectos.
- Elegir `oidc`, `mtls` o `token-file`; auth incompleta falla cerrado. `CAUCE_DEV_AUTH=0` es fijo.
- Exposición host usa `CAUCE_PRIVATE_BIND_IP` (default `127.0.0.1`); un balanceador público es un cambio externo explícito.
- Adapters no corren en el compose: se generan por alias, requieren WSS y secretos por PATH. Seguir `alias-cutover.md`.
- Gateway y dispatcher reciben el mismo `CAUCE_ACK_DEADLINE_MS` (default productivo explícito: `600000`). `ACK_TIMEOUT_MS` debe ser igual o mayor; ambos procesos fallan al arrancar ante valores no enteros/positivos o si el dispatcher pudiera reintentar antes del deadline. Un ACK `started` nuevo y correctamente fenced renueva `ack_deadline_at` y `claim_expires_at`; su replay exacto previamente aplicado vuelve a renovar sólo mientras claim y lease sigan vivos. Colisiones de `event_id`, ACK rechazados, claims vencidos y owners obsoletos no pueden renovarlos.
- `ack_deadline_at` es una lease corta de ownership, no el límite de ejecución
  del modelo. Mientras el harness sigue activo, el adapter emite ACK `started`
  durables y el gateway renueva la lease configurada; una caída sigue siendo
  detectable al vencer la última renovación. Todos los harnesses agentic usan
  `86400000` (24 h) por defecto y admiten overrides entre `60000` y
  `604800000` (7 días).

### Relay, Telegram, shadow y observabilidad

Profiles opt-in: `origin-relay`, `telegram`, `terminal`, `shadow`, `observability`. `telegram` ejecuta el bridge nativo y requiere un directorio externo read-only con `config.json`, tokens `0600` y markers de poller V2 detenido. `shadow` ejecuta el router por Unix socket y el guard; en shadow/compare no habilita harness ni respuesta humana, y cutover exige interlock/dirección. `origin-relay` no debe registrar `telegram` cuando el bridge está activo. Prometheus scrapea dispatcher, relay y `outbox-metrics`; wake/outbox/relay y DLQ tienen alertas.

Todos los procesos propios corren non-root, filesystem read-only, `no-new-privileges`, capabilities
vacías y restart `unless-stopped` (migrator es one-shot). La política conserva recuperación de
crash, pero respeta el stop del bridge tras reinicios del daemon/host. No relajar health o TLS para
forzar un arranque.

## Consola sin segundo camino de deploy

`release-build.sh` construye y publica siempre runtime y consola desde el mismo RC limpio. No existe
un deploy forward sólo-consola: todo cambio de consola usa `release-deploy-preflight` y
`release-deploy`, con el mismo CAS completo runtime+console+manifest+baseline y RepoDigests
recuperables. `ops/scripts/release-console.sh desplegar` y los targets Make históricos son tombstones
fail-closed; no copiar por SSH, no crear tags locales y no editar el env remoto. La reversa durable
de una consola ya desplegada sigue siendo `rollback.sh console`: deriva la consola previa del
baseline autenticado, recrea el servicio y compensa el CAS si falla.

## Gate posterior

`stack-health.sh prod`, migrations completas, consumer único por alias, lease owner único, round-trip ACK auténtico, wake/outbox/relay bajo umbral, cero DLQ nuevas no explicadas respecto del baseline y dos ventanas de retry estables. Cutover usa confirmación explícita y jamás se ejecuta como parte de deploy.

Durante una ventana en la que sólo Zeus deba estar detenido, `release-gate.sh` y
`stack-health.sh prod` admiten exclusivamente `--maintenance-offline-zeus`. Requiere
`CAUCE_CHANGE_ID` y `CAUCE_MAINTENANCE_CONFIRM=offline:Steven:zeus:<cambio>`; además falla si Zeus
sigue activo. Esa excepción no es un gate final: al terminar mantenimiento se deben ejecutar ambos
sin flag y obtener paridad estricta.

El ledger actual no permite afirmar digest histórico completo para migraciones 001–023. Restore
drill, invariantes y versión aplicada son cobertura operativa; la equivalencia de schema exige aún
un digest canónico normalizado, con igual versión PostgreSQL, entre base fresca 001–031 y restore
real migrado a 029.

Para este incidente, antes del gate se toma un backup sin retención incidental:

```sh
sudo env CAUCE_BACKUP_SKIP_RETENTION=1 /usr/local/sbin/cauce-v3-host-backup
sudo env REQUIRE_RETENTION_PRESERVED=1 /usr/local/sbin/cauce-v3-host-backup-monitor
```

La fila heredada `origin_relay/console` se conserva y se cierra en DB con status `dead`, razón
fenced estable, DLQ y auditoría; nunca se elimina ni se mezcla con los dead históricos:

```sh
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env ops/scripts/reconcile-stale-console-outbox.sh pre
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env ops/scripts/reconcile-stale-console-outbox.sh apply
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env ops/scripts/reconcile-stale-console-outbox.sh post
```

`post` exige que todos los dead anteriores al timestamp de `pre` sigan presentes y que después de
ese corte sólo exista la fila creada por esta reconciliación. Un claim activo, más de un candidato,
una DLQ inconsistente o una nueva regresión hacen fallar el procedimiento.
