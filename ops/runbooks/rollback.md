# Runbook: rollback

## Selector de release completo

`rollback.sh runtime|console|release` nunca baja migraciones ni ejecuta `migrator`. Lee los cinco
selectores únicamente de `CAUCE_ENV_FILE` (privado `0600`): runtime, consola, manifest de overrides
y path/SHA del `rollback-baseline.json`. Variables exportadas con esos nombres no tienen
precedencia. El target tampoco se escribe a mano: sale del baseline autenticado.

El baseline debe haber sido publicado antes del deploy mediante `rollback-baseline.py create`. Su
validator recupera por registry el RepoDigest del runtime bridge, el de la consola anterior y el
runtime candidato; los IDs deben coincidir. También revalida manifest, evidencia bridge reciente,
fuente reproducible `originBaseCommit + patch versionado en main + patchSha256 + resultingBridgeTree`,
restore PostgreSQL 16 aislado sin egress, schema 029, flota exacta, leases/perfiles/revisiones,
migrator no-op, retorno al candidato y compensación con fallo de health inyectado.

No se acepta origin/main puro, un tag mutable ni el label de compatibilidad como sustituto. No se
ejecutan los down 028/029: perderían o metamorfosearían estado de revisión.

Antes de ejecutar, obtener la cadena de confirmación exacta del ledger de release ya publicado. No
sourcear `prod.env` ni imprimirlo. El formato es:

```text
release-selectors:<runtime|console|release>:<runtime-actual>|<consola-actual>|<manifest-actual>|<baseline-path>|<baseline-sha>-><runtime-target>|<consola-target>|<manifest-target>|<baseline-path>|<baseline-sha>
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

Antes del CAS se recuperan imágenes actuales y targets por RepoDigest, se verifican IDs y, si cambia
runtime, se exige schema exacto `029_reconcile_declared_fleet.sql`. Sólo se recrean los servicios
inventariados que ya estaban running; gateway/dispatcher/outbox y, cuando aplica, console son obligatorios. El
script cambia los cinco selectores mediante un único replace atómico/CAS, recrea con `--no-build
--no-deps`, compara el ID real de cada contenedor y corre health.

Si falla el arranque o health, revierte el mismo CAS y restaura las imágenes/servicios anteriores.
Si esa compensación falla, detener la ventana y recuperar desde el env privado y la evidencia del
ledger; nunca improvisar tags, editar sólo una línea ni arrancar el migrator.

## Alias y datos

Para un alias usar `cutover-rollback.sh host-native|container`: valida consumer, lease, ACK y DLQ,
detiene sólo V3 y exige drain antes de que el owner V2 restaure su consumer. Un rollback de datos no
usa este script: restaura un backup V3 verificado en una DB nueva. Nunca arrancar V2 si el snapshot
`rollback-ready` no pasó.
