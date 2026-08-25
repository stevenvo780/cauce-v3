# Runbook: deploy Cauce V3 aislado

## Preflight de release

1. Confirmar que el target, DB, DNS, collectors y unidades pertenecen a V3; no apuntar scripts a V2.
2. Construir runtime/consola con `make -C ops release-build` desde el commit RC exacto y publicar
   ambas imágenes por RepoDigest. Index y tracked worktree deben estar limpios; el único untracked
   permitido es `apps/console/src/features/_grafo/`, que no entra al commit ni al `git archive`.
3. Completar fuera del repo un env `0600` desde `ops/config/prod.env.example`. Son PATHs/config; el contenido sensible queda en archivos del gestor de secretos.
4. Ejecutar QA real, restart auténtico, `make -C ops smoke-cli` para los cinco
   ejecutables, restore drill y hashes. CLI smoke sigue siendo version/help-only.
5. Ejecutar `CAUCE_ENV_FILE=/etc/cauce-v3/prod.env make -C ops release-gate`.

El release gate ejecuta primero `physical-fleet-gate.py`: todo container Docker declarado debe
existir antes de cualquier migración. También exige snapshot de flota v3 exacto (15 agentes, un
principal de sistema, tres históricos), permisos completos de `agent_notify`, leases y placements.
No tolera ausencia de Docker Compose v2 o `docker build`, build evidence viejo, SHA inválido, tests
reales/restart skipped o fallidos, unidades systemd desactualizadas ni imagen sin `@sha256:`.

### Bootstrap reproducible del host actual

El host legado no tiene un `prod.env` canónico. No se reconstruye leyendo `docker inspect` ni el
historial de shell. Primero se autentica el conjunto Compose observado: base, PostgreSQL local y
los cuatro overrides existentes. Dentro de `/etc/cauce-v3/compose-overrides`, crear
`active.manifest` con una línea `active <sha256> <basename>` en este orden exacto:

1. `telegram-bridge.active.yaml`
2. `store-fanin.yaml`
3. `terminal-minrows.yaml`
4. `directiva-20260825.yaml`

No usar glob; cualquier YAML adicional debe declararse `inactive` con su hash o el resolver falla.
`ops/scripts/compose-files.sh` verifica contenido, inventario, orden y ausencia de symlinks antes de
invocar Docker.

Crear después un archivo privado de referencias, no de secretos literales:

```sh
sudo install -m 0600 -o root -g root ops/config/prod.env.example /root/cauce-prod.references
sudoedit /root/cauce-prod.references
sudo python3 ops/scripts/bootstrap-prod-env.py \
  --authorized-references /root/cauce-prod.references \
  --output /etc/cauce-v3/prod.env
```

Completarlo sólo desde rutas administradas autorizadas y desde los digests publicados por
`release-build`; fijar `CAUCE_LOCAL_POSTGRES=1`, el manifest absoluto y todos los images como
`name@sha256`. El bootstrap nunca muestra valores, exige input 0600, falla ante tags mutables y no
sobrescribe un env existente. La validación efectiva se hace redirigiendo `compose config` a un
temporal 0600; no imprimirlo a terminal.

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

Cambiar runtime, consola, manifest y path/SHA del baseline con una sola invocación
`pin-production-release.py swap`. Se deben pasar los cinco valores esperados leídos del ledger de
release y los cinco targets; el helper compara el env bajo lock, revalida el baseline completo y
hace un único replace atómico. En el primer bootstrap, el env ya se crea apuntando al baseline
recién publicado, por lo que expected/target baseline son iguales. No editar líneas por separado ni
exportar selectores para Compose.

Después del arranque, emitir evidencia final únicamente con:

```sh
sudo env CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  python3 ops/scripts/release-candidate.py --release-host-ready
```

Ese flujo ejecuta el release gate vivo en el mismo proceso y luego vuelve a resolver Compose,
RepoDigests/IDs, RC limpio, manifest sin overrides activos, CAS y baseline. No consume un marker
host-ready persistente.

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
CAUCE_LOCAL_POSTGRES=1 CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  ops/scripts/compose.sh prod up -d --no-build --wait
```

El certificado del overlay debe tener SAN `postgres`; password/cert/key/CA se montan como secrets y `5432` no se publica.

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

Profiles opt-in: `origin-relay`, `telegram`, `shadow`, `observability`. `telegram` ejecuta el bridge nativo y requiere un directorio externo read-only con `config.json`, tokens `0600` y markers de poller V2 detenido. `shadow` ejecuta el router por Unix socket y el guard; en shadow/compare no habilita harness ni respuesta humana, y cutover exige interlock/dirección. `origin-relay` no debe registrar `telegram` cuando el bridge está activo. Prometheus scrapea dispatcher, relay y `outbox-metrics`; wake/outbox/relay y DLQ tienen alertas.

Todos los procesos propios corren non-root, filesystem read-only, `no-new-privileges`, capabilities vacías y restart `always` (migrator es one-shot). No relajar health o TLS para forzar un arranque.

## Desplegar SÓLO la consola

`release-build.sh` construye y publica siempre runtime y consola desde el mismo RC limpio. Un deploy
sólo-consola puede recrear únicamente `console`, pero el cambio de pin sigue usando el CAS completo
runtime+console+manifest+baseline y un RepoDigest recuperable; no usar el camino histórico de copia
SSH/tag local. La reversa durable es `rollback.sh console`: deriva la consola previa del baseline,
recrea sólo ese servicio, verifica su image ID y compensa el CAS si falla.

## Gate posterior

`stack-health.sh prod`, migrations completas, consumer único por alias, lease owner único, round-trip ACK auténtico, wake/outbox/relay bajo umbral, cero DLQ nuevas no explicadas respecto del baseline y dos ventanas de retry estables. Cutover usa confirmación explícita y jamás se ejecuta como parte de deploy.

Durante una ventana en la que sólo Zeus deba estar detenido, `release-gate.sh` y
`stack-health.sh prod` admiten exclusivamente `--maintenance-offline-zeus`. Requiere
`CAUCE_CHANGE_ID` y `CAUCE_MAINTENANCE_CONFIRM=offline:Steven:zeus:<cambio>`; además falla si Zeus
sigue activo. Esa excepción no es un gate final: al terminar mantenimiento se deben ejecutar ambos
sin flag y obtener paridad estricta.

El ledger actual no permite afirmar digest histórico completo para migraciones 001–023. Restore
drill, invariantes y versión aplicada son cobertura operativa; la equivalencia de schema exige aún
un digest canónico normalizado, con igual versión PostgreSQL, entre base fresca 001–029 y restore
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
