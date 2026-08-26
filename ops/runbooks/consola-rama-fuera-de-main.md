# Consola: incidente de rama y camino historico retirado

## Estado actual

La divergencia que dio origen a este documento ya no define el procedimiento de produccion. La
consola y el runtime se publican desde un mismo commit limpio de `main`; una rama larga de consola
no es una fuente de release. Este fichero conserva la decision operativa para que una referencia
antigua no reactive el segundo camino de despliegue.

`ops/scripts/release-console.sh desplegar` y `revertir` son tombstones fail-closed. No construyen,
transfieren, etiquetan, cambian selectores ni recrean servicios. Los targets historicos
`release-console` y `release-console-rollback` conservan el mismo fallo explicito para detener
automatizaciones antiguas de forma visible.

## Unica ruta de release

1. Integrar consola y runtime en `main`, con el arbol rastreado limpio y las pruebas completas.
2. Ejecutar `ops/scripts/release-build.sh`. Siempre construye y publica runtime y consola del mismo
   commit, recupera cada `repository@sha256` desde el registry y exige que el image ID recuperado
   sea el mismo que paso los smokes. `build.json` conserva ambos RepoDigests, IDs, fuentes y bases.
3. Crear y autenticar el baseline indicado en `ops/runbooks/deploy.md`. El baseline liga el runtime
   candidato, el runtime bridge, la consola anterior, el manifest anterior y la evidencia de
   rollback reproducible.
4. Preparar los tres selectores no derivados de `build.json` como variables de entorno. Son rutas y
   hashes, nunca contenido secreto:

   ```sh
   export CAUCE_ENV_FILE=/etc/cauce-v3/prod.env
   export CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST=/etc/cauce-v3/compose-overrides/release-<commit>.manifest
   export CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256=sha256:<64-hex>
   export CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE=/etc/cauce-v3/releases/rollback-baseline-<commit>.json
   export CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256=sha256:<64-hex>
   ```

5. Ejecutar `make -C ops release-deploy-preflight`. Es read-only respecto de selectores, DB y
   servicios: valida evidencia, baseline, manifest, topologia, health y que los containers actuales
   correspondan exactamente con el expected-old. Devuelve un `CAUCE_DEPLOY_CONFIRM` ligado por hash
   a los seis valores old y los seis target. Si otro proceso cambia uno, el deploy lo rechaza.
6. Con esa confirmacion exacta, ejecutar `make -C ops release-deploy`. El driver canonico
   `ops/scripts/deploy-release.sh` entra por `pin-production-release.py locked-exec` y conserva el
   mismo FD/token de lock durante toda la transaccion. Compara y reemplaza juntos:

   - `CAUCE_RUNTIME_IMAGE`;
   - `CAUCE_CONSOLE_IMAGE`;
   - `CAUCE_COMPOSE_OVERRIDE_MANIFEST`;
   - `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256`;
   - `CAUCE_ROLLBACK_BASELINE_FILE`;
   - `CAUCE_ROLLBACK_BASELINE_SHA256`.

   Dentro de ese lock recupera por registry los RepoDigests de old y target, corre `migrator` como
   `run --rm`, recrea el conjunto exacto de servicios runtime/consola con `--no-build`, verifica
   image ID, `Config.Image`, config hash y health, y produce `release-host-ready`. Un fallo posterior
   al CAS, antes de schema durable, ejecuta el CAS inverso de los seis campos. Después de schema
   durable selecciona el bridge acreditado y la consola/manifest previos, conservando path+SHA
   atómicos. Si la propia compensacion falla, usa códigos diferenciados y un error CRITICAL; nunca
   declara un rollback exitoso a medias.

El baseline target puede codificar un runtime bridge distinto y acreditado para el schema durable;
la consola y el manifest path+SHA sí deben coincidir exactamente con lo observado antes del deploy.
Eso vuelve reproducible la compensacion incluso si falla el migrator. Un arbol vivo con
imagenes o config-hashes fragmentados falla en preflight: primero necesita una recuperacion
controlada que produzca un expected-old coherente; el driver no inventa un selector retroactivo.

Durante la ventana autorizada con Zeus apagado, fijar `CAUCE_DEPLOY_ZEUS_MAINTENANCE=1`,
`CAUCE_CHANGE_ID` y `CAUCE_MAINTENANCE_CONFIRM=offline:Steven:zeus:<mismo-change-id>`. Ese modo exige el gate acotado de mantenimiento y dice
explicitamente que `release-host-ready` estricto sigue cerrado. Tras reactivar Zeus, el gate y la
evidencia estrictos se ejecutan sin la excepcion; el resultado acotado nunca se renombra como final.

No hay transferencia directa de imagen, etiquetas locales como selector, edicion remota del env ni
un `swap` suelto. Un digest de configuracion local tampoco sustituye al RepoDigest recuperable del
registry. El driver no ejecuta cutover ni toca unidades/adapters por alias.

## Reversa

La unica reversa de consola es `ops/scripts/rollback.sh console`. Lee el target de la consola
anterior desde el baseline autenticado, mantiene runtime y manifest como un conjunto verificado,
aplica el mismo CAS de seis campos, recrea solo los servicios necesarios y comprueba image ID y
health. Si la comprobacion falla, compensa el CAS y restaura los selectores anteriores bajo el mismo
lock. No se pasa un tag o digest elegido a mano.

## Verificacion local read-only

La tombstone conserva una comprobacion deliberadamente limitada:

```sh
CAUCE_CONSOLE_IMAGE='registry.example:5000/cauce/console@sha256:<64-hex>' \
  ops/scripts/release-console.sh verificar
```

Tambien puede leer exclusivamente `CAUCE_CONSOLE_IMAGE` desde `CAUCE_ENV_FILE`, sin sourcear ni
mostrar el resto del fichero. Esta comprobacion valida que el selector sea un RepoDigest canonico e
inmutable, incluido un registry con puerto. No consulta produccion y no acredita que la imagen sea
recuperable, que el CAS haya ocurrido o que el servicio este sano; esas afirmaciones pertenecen al
release gate y a la evidencia final del host.
