# Runbook: rollback

## Selector de release completo

`rollback.sh runtime|console|release` nunca baja migraciones ni ejecuta `migrator`. Lee los ocho
selectores únicamente de `CAUCE_ENV_FILE` (privado `0600`): runtime, consola, manifest de overrides
y SHA del manifest, path/SHA del `rollback-baseline.json` y path/SHA del snapshot durable de
writers externos. Variables exportadas con esos nombres no tienen
precedencia. El target tampoco se escribe a mano: sale del baseline autenticado.

El baseline debe haber sido publicado antes del deploy mediante `rollback-baseline.py create`. Su
validator recupera por registry el RepoDigest del runtime bridge, el de la consola anterior y el
runtime candidato; los IDs deben coincidir. También revalida manifest, evidencia bridge reciente,
fuente reproducible `originBaseCommit + patch versionado en main + patchSha256 + resultingBridgeTree`,
restore PostgreSQL 16 aislado sin egress, schema 037, reconciliación de flota histórica 029, contrato
DLQ 030, fencing por `connection_token` 031, claim PTY 032, owner del browser 033 y pin de
instancia/boot del relay 034, adopción conductual de perfiles 035, fase durable de target shadow 036
y los cuatro índices exactos key/nonce/rate/head del journal de consola 037,
leases/perfiles/revisiones/expectativas/adopciones, migrator no-op, retorno al
candidato y compensación con fallo de health y pérdida de respuesta CAS durable inyectados.

No se acepta origin/main puro, un tag mutable ni el label de compatibilidad como sustituto. No se
ejecutan los down 028/029/030/031/032/033/034/035/036/037 durante un rollback normal: perderían o metamorfosearían estado
durable y volverían incompatible el runtime ya seleccionado.

Un downgrade deliberado comienza por 037 y es una operación distinta al rollback de release. Sólo
es admisible antes del primer uso del journal: detener todo runtime capaz de crear intents, ejecutar
`down/037_console_publish_intent_indexes.sql` bajo los locks global+específico y exigir que el CAS de
ledger, catálogo y journal vacío siga intacto. Después, para bajar schema036, detener
primero el runtime shadow 036 y su guard, demostrar cero leases `processing`, ejecutar
`down/036_shadow_router_target_phase.sql` bajo la misma ventana cerrada y recién después arrancar
el binario pre-036. El down rechaza un ledger posterior o un lease activo. Nunca arrancar el worker
viejo contra schema036 ni ejecutar down036 mientras el runtime nuevo pueda reclamar trabajo.

## Compensación automática del deploy forward

`deploy-release.sh` mantiene el flock autenticado durante admisión, CAS, migrator, recreación,
health, evidencia final y compensación. Antes del CAS valida la evidencia recuperable del candidato
y del bridge, sus RepoDigest/IDs, la topología y el inventario exacto; un container extra o detenido
impide migrar. Tanto el manifest actual como el forward son selectores content-addressed por path y
SHA-256, y se vuelven a autenticar en cada uso.

Si el migrator falla sin cambiar el schema, la compensación puede restaurar los ocho selectores y
servicios exactos anteriores. Si la entrada era la flota legada fragmentada, antes de CAS existe un
snapshot privado y content-addressed por servicio; la compensación previa recrea su override exacto
y vuelve a comprobar inventario, RepoDigest/ID, `Config.Image`, config hash y health. Fallar esa
restauración termina `CRITICAL` con código 74, nunca como rollback exitoso.

Si el schema objetivo declarado en `build.json` quedó durable, cualquier fallo posterior selecciona
exclusivamente el runtime bridge acreditado por el baseline target. El driver exige que su label
`io.cauce.schema.compatible-through` coincida con ese schema; junto con la consola y el manifest
anteriores conserva el baseline target que liga bridge ID/evidencia, recrea `--no-build`, verifica
IDs/config hashes/health y vuelve a medir exactamente el mismo schema. Nunca se restaura el runtime
viejo ni el mosaico fragmentado después de esa frontera durable.

Una salida perdida del migrator no se adivina: el driver mide el schema con el candidato. Resultado
anterior sin cambios permite compensación previa; el schema objetivo nuevo exige bridge; otro schema o una medición
fallida abortan con código 72 sin ejecutar una compensación incompatible. Fallo del CAS
compensatorio usa 70 y fallo de recreación/verificación usa 71; ambos son CRITICAL observables.

`make -C ops prod-up`, `make -C ops prod-down` y `make -C ops migrate` también entran por
`pin-production-release.py locked-exec` y conservan el mismo FD/token. No ejecutar mutadores
`docker compose` en paralelo ni invocar `pin-production-release.py swap` aisladamente.

Cuando el manifest declara managers remotos, `deploy-release.sh` y `rollback.sh` adquieren además
una sesión SSH persistente con `flock` por `dockerHost + systemdUser` antes de mutar. El descriptor
y el digest del conjunto exacto de managers acompañan al proceso hijo; `fence`, `restore` y sus
checks de transición los autentican. La caída de cualquier sesión termina el hijo y deja ingress
cerrado. Repetir la operación canónica reconcilia el estado observado contra el mismo snapshot;
nunca completar el CAS o reactivar units a mano después de una pérdida de guardia.

## Producir la evidencia privada del bridge

La evidencia no se redacta a mano. `produce-rollback-bridge-evidence.py` sólo corre desde un `HEAD`
completo con índice y archivos rastreados limpios (el único no rastreado admitido sigue siendo
`apps/console/src/features/_grafo/`). No acepta `DATABASE_URL`, `prod.env` ni una red de producción.
Exige estos inputs exactos antes de arrancar Docker:

- backup `pg_dump` custom, absoluto, regular, un solo link, dueño del proceso y modo `0600`, más su
  SHA-256 autorizado;
- evidencia `cauce-v3-host-backup-restore` del mismo archivo y de la misma imagen PG16, también
  privada `0600`, más su SHA-256 autorizado; `verified_at_utc` debe conservar el timestamp original,
  no superar 5 minutos de skew futuro y tener como máximo 30 horas tanto al iniciar como al publicar
  el ciclo bridge;
- `build.json` schema v7 del candidato, privado `0600`, más SHA-256, commit candidato,
  `repository@sha256` exactos del runtime/consola y bases Node/Python/nginx inmutables, con rol,
  manifest digest, media type, plataforma `linux/amd64` e image ID;
- repositorio de publicación del bridge sin tag/digest, imagen PostgreSQL 16 por
  `repository@sha256`, y el commit completo de `HEAD` que contiene patch, productor, schema,
  Compose, validador y runbook.

Invocación (las rutas y digests salen del ledger privado; no pegarlos en tickets o logs):

```sh
python3 ops/scripts/produce-rollback-bridge-evidence.py \
  --output /ruta/privada/rollback-bridge.json \
  --backup /ruta/privada/host.dump \
  --expected-backup-sha256 'sha256:<64-hex>' \
  --restore-evidence /ruta/privada/host.dump.restore.json \
  --expected-restore-evidence-sha256 'sha256:<64-hex>' \
  --candidate-build-evidence /ruta/privada/build.json \
  --expected-candidate-build-evidence-sha256 'sha256:<64-hex>' \
  --candidate-image 'registry.example/cauce/runtime@sha256:<64-hex>' \
  --bridge-repository 'registry.example/cauce/runtime-bridge' \
  --postgres-image 'registry.example/library/postgres@sha256:<64-hex>' \
  --patch-source-commit '<HEAD-completo>'
```

El productor reconstruye el árbol versionado en un worktree efímero que siempre limpia, vuelve a
hashear el tar extraído con un índice Git aislado y exige `resultingBridgeTree` antes de construir.
Luego corre su suite, construye y publica el runtime con labels de árbol/patch/fuente, hace push→pull y exige el
mismo ID. Después levanta exactamente `postgres`, `candidate` y `bridge` sobre la única red Compose
`internal:true`, sin puertos; el backup entra read-only y las credenciales son secretos aleatorios
del scratch. Restaura de nuevo en PG16, migra exactamente hasta 036, corre
candidate→bridge→candidate, comprueba el migrator no-op, la flota 15/16/3, la política
`agent_notify`, la columna UUID no-null de fencing, un token no-null y distinto por lease, el
claim PTY digest+epoch+lease con takeover y stale-close cercado, el request UUID/digest y owner
digest+generation del browser con POST idempotente y DELETE tardío no-op, cero sesiones abiertas
tras el drain, y el pin `relay_instance_id` + generación `relay_boot_id` con claim del relay exacto,
takeover sólo al expirar y stale-close no-op. También acredita las 17 columnas, 15 constraints,
dos funciones y trigger exactos de 035; una adopción sólo se acepta contra la expectativa exacta,
un delivery no puede adoptar dos veces y el probe transaccional vuelve a cero. Para 036 acredita
el interlock stop/drain, la forma exacta de fase shadow, claim sin consumo anticipado, armado antes
del target, settlement observado, replay idempotente tras crash y reconciliación terminal frente a
leases competidores; todo probe mutante se revierte. Finalmente acredita
el roundtrip sin modelo y siete hashes canónicos de filas completas con sus conteos, incluidos el
estado durable de expectativas/adopciones y el journal completo de publish, idempotencia,
deliveries, ACKs y outbox de adapters.

La compensación ejecuta `rollback.sh evidence-cycle`, no una réplica Python del selector. Ese modo
está limitado al directorio `0700` y al proyecto Compose efímeros creados por el productor: usa un
`release.env` completo, los ocho selectores, `pin-production-release.py` y el mismo motor de
transacción que producción. El flock autenticado permanece abierto durante CAS, recreación Compose,
health y CAS/recreación compensatorios. El ciclo hace durable el CAS forward, simula la pérdida de
su respuesta y exige que la readmisión exacta continúe sin repetirlo. Después del swap al bridge detiene PostgreSQL únicamente en
el proyecto aislado y exige que el probe real de base falle; vuelve a levantarlo y el motor debe
restaurar por CAS inverso el candidato, su ID exacto, su health y el conjunto exacto de servicios.
Los resultados del proceso se incorporan al informe; los hashes/conteos antes y después se comparan,
no se rellenan como assertions constantes.

El baseline usado en ese ciclo es un descriptor scratch privado ligado por SHA-256. No puede ser el
baseline de producción: esa pieza requiere la evidencia que se está produciendo y consumirla aquí
crearía una dependencia circular. El modo aislado no es aceptado por `rollback.sh runtime|console|release`
ni omite el baseline real en producción. El cleanup exige que `compose down --volumes` pase y que no
quede contenedor, volumen ni red con el label del proyecto; cualquier residuo impide publicar.

Sólo después de pasar schema y semántica publica, sin overwrite, dos archivos privados: el JSON y
`rollback-bridge.json.sha256`. La publicación usa temporales fsync + links; una interrupción deja el
par inválido y el validador lo rechaza. Verificación independiente:

```sh
python3 ops/scripts/validate-rollback-bridge-evidence.py \
  --evidence /ruta/privada/rollback-bridge.json \
  --expected-evidence-sha256 'sha256:<64-hex>' \
  --expected-repository-digest 'registry.example/cauce/runtime-bridge@sha256:<64-hex>' \
  --expected-image-id 'sha256:<64-hex>' \
  --expected-candidate-repository-digest 'registry.example/cauce/runtime@sha256:<64-hex>' \
  --expected-candidate-image-id 'sha256:<64-hex>' \
  --expected-candidate-source-digest 'sha256:<64-hex>'
```

Si falta Docker Compose v2, acceso pull/push al registry, cualquiera de los tres inputs privados o
su SHA exacto, se detiene sin publicar evidencia. No se sustituye con un restore anterior, un tag,
un hash parcial ni un resultado escrito manualmente.

Antes de ejecutar, obtener la cadena de confirmación exacta del ledger de release ya publicado. No
sourcear `prod.env` ni imprimirlo. El formato es:

```text
release-selectors:<runtime|console|release>:<runtime-actual>|<consola-actual>|<manifest-actual>|<manifest-sha>|<baseline-path>|<baseline-sha>|<writer-snapshot-path>|<writer-snapshot-sha>-><runtime-target>|<consola-target>|<manifest-target>|<manifest-sha>|<baseline-path>|<baseline-sha>|<writer-snapshot-path>|<writer-snapshot-sha>
```

Luego ejecutar con sólo el env canónico y la confirmación:

```sh
sudo env \
  CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  CAUCE_ROLLBACK_CONFIRM='<cadena-exacta-del-ledger>' \
  ops/scripts/rollback.sh release
```

Acciones:

- `runtime`: bridge runtime + manifest anterior; conserva la consola actual.
- `console`: consola anterior; conserva runtime y manifest actuales.
- `release`: bridge runtime + consola + manifest anteriores como un conjunto.

Toda consola nueva de release lleva
`io.cauce.console.publish-journal=multi-intent-v1`, y build/evidence/registry gate verifican el
label en la imagen final. `rollback.sh console` rechaza una consola legada sin esa capacidad antes
de mutar selectores. La única excepción es que el gateway **ya seleccionado y ejecutándose** tenga
el mismo image ID del runtime bridge con `io.cauce.rollback-bridge.read-only=server-v2` y responda
al probe POST con el contrato exacto `503 {"error":"rollback_bridge_read_only"}`. El cliente no es
autoridad para esa excepción.

El bridge 037 sólo permite GET/HEAD en `/health/live`, `/health/ready` y `/metrics`. Su hook
server-side rechaza con 503 toda API de datos, todas las rutas `/v3/auth/*` —incluidos GET, HEAD y
OPTIONS—, los demás métodos y todo upgrade WebSocket, con `Cache-Control: no-store` y
`Retry-After: 60`, antes de auth o de cualquier handler durable. Por eso una consola baseline
sin journal no puede publicar, cambiar configuración/perfiles, hacer replay/cancel ni mutar PTY
durante el bridge. La evidencia A/B exige journal canónico idéntico al entrar/salir del bridge y
que los intents previos sigan disponibles al rollforward.

Antes del CAS se recuperan imágenes actuales y targets por RepoDigest, se verifican IDs y, si cambia
runtime, se exige schema exacto `037_console_publish_intent_indexes.sql`. Un bridge
029/030/031/032/033/034/035/036 se rechaza
aunque conserve labels o evidencia antiguos. Sólo se recrean los servicios
inventariados que ya estaban running; gateway/dispatcher/outbox y, cuando aplica, console son obligatorios. El
script cambia los ocho selectores mediante un único replace atómico/CAS, recrea con `--no-build
--no-deps`, compara el ID real de cada contenedor y corre health.

Antes de cualquier preflight SQL, CAS o migración, `deploy-release.sh` detiene y verifica
`Running=false,Pid=0` para gateway, consola, dispatcher y outbox-metrics; después detiene todos los
writers internos/externos. `rollback.sh runtime|release` aplica la misma frontera a gateway y
consola antes del preflight terminal y CAS; el rollback sólo de consola cierra la consola y deja el
gateway bridge probado sirviendo 503. Un fallo o señal antes de CAS restaura exactamente el
candidato; una salida ambigua posterior vuelve a cerrar ingress antes del CAS inverso. Si la
restauración no puede probarse, los procesos quedan detenidos y la salida es CRITICAL: nunca se
reabre una mezcla provisional. El primer `up` del candidato ocurre dentro de GO después de CAS,
migración y verificación post; GO sólo se declara committed tras health, gate final y selector
exacto.

Si el target es el bridge 037, primero valida el snapshot durable de writers, detiene exactamente
los Compose writers y units externas declaradas por el manifest canónico de aliases, y exige
procesos, leases y writers DB en cero, incluido cero `shadow_router_inbox.status='processing'`.
Con los writers detenidos ejecuta además una transacción
read-only acotada que exige forma 032/033/034/035/036 exacta, índice único de `request_id`, pin de instancia
del relay, tablas/constraints/funciones/trigger y consulta conductual de adopción, privilegios del
gateway y cero `terminal_sessions` abiertas; cualquier fallo restaura los writers antes del CAS.
Sólo materializa gateway, dispatcher, outbox-metrics y la
consola seleccionada; observabilidad read-only permanece activa. Publica el marker
`${CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE}.state.json` en modo `rollback_bridge_degraded` con
`writersExpected=writersObserved=0`, recrea outbox-metrics y exige las dos métricas concordantes.
Telegram y PTY quedan temporalmente indisponibles y alertando CRITICAL. Al compensar o volver al
candidato restaura exactamente el conjunto enabled/active del snapshot; una unit desconocida,
stop/restore parcial o discrepancia del marker falla cerrado.

El rollback productivo también corre en un entorno cerrado: proyecto fijo `cauce-v3-prod`, perfiles
sólo de la allowlist del env privado, daemon `unix:///var/run/docker.sock`, `DOCKER_CONTEXT` ausente
y sin interpolación ambiental. Controles Docker/Compose dentro de `prod.env` se rechazan antes de
pull, CAS o recreación.

Si falla el arranque o health, revierte el mismo CAS y restaura las imágenes/servicios anteriores.

## Retorno canónico desde el bridge

Un rollback de consola seguido por `rollback.sh runtime` no es un callejón sin salida. El estado
degradado conserva el baseline y el snapshot de writers del release forward. Para volver al
candidato se reutilizan **los mismos artefactos content-addressed** (`build.json`, manifest,
baseline y snapshot) y se ejecuta `deploy-release.sh preflight` seguido de `deploy-release.sh
deploy` con la confirmación recién emitida. El driver reconoce que el runtime seleccionado es el
bridge del baseline, exige la topología safe-only y writers realmente detenidos, hace CAS al
runtime y consola candidatos, recrea servicios, restaura exactamente los writers del snapshot y
publica el marker `candidate`. No se redactan selectores ni se ejecuta un segundo rollback manual.

Este camino está cubierto por la prueba transaccional
`console-then-runtime rollback has a canonical bridge-to-candidate roll-forward path`, que parte de
bridge + consola anterior + baseline/snapshot target y exige restauración completa de runtime,
consola y writers bajo el mismo flock autenticado.
Una respuesta perdida del CAS forward o inverso sólo continúa si `check` readmite el estado durable
completo de ocho selectores bajo el mismo lock; cualquier estado parcial falla cerrado.
Si esa compensación falla, detener la ventana y recuperar desde el env privado y la evidencia del
ledger; nunca improvisar tags, editar sólo una línea ni arrancar el migrator.

Si el release se desplegó con Zeus detenido y después se cerró la ventana mediante
`make -C ops release-rotate-writer-snapshot`, todo rollback posterior toma obligatoriamente el
snapshot Zeus-active ya seleccionado. No se vuelve a apuntar al snapshot offline: eso apagaría un
writer que forma parte del estado candidato actual. El preflight de `rollback.sh runtime|console|release`
vuelve a ejecutar el check `restored` sobre ese path+SHA, conserva ambos campos durante su CAS y
compensa con el mismo snapshot si falla la recreación. Una discrepancia de unit, lease, fleet,
marker o active-set bloquea la reversa antes de seleccionar el bridge.

## Alias y datos

Para un alias usar `cutover-rollback.sh host-native|container`: valida consumer, lease, ACK y DLQ,
detiene sólo V3 y exige drain antes de que el owner V2 restaure su consumer. Un rollback de datos no
usa este script: restaura un backup V3 verificado en una DB nueva. Nunca arrancar V2 si el snapshot
`rollback-ready` no pasó.
