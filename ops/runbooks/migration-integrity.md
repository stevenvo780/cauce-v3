# Integridad de migraciones

El release no toma el nombre de una fila de `schema_migrations` como prueba de procedencia. En
particular, `024_agent_role_templates.sql` puede aparecer aplicado aunque la imagen histórica no
contuviera su fuente. Su `sourceOrigin` permanece `undetermined`: el gate vuelve a medir todos sus
objetos en cada intento y sólo acepta equivalencia estructural exacta.

La huella esperada de 024 se obtiene de forma determinista con PostgreSQL 16 limpio, aplicando en
orden únicamente las fuentes 001..024. La prueba
`packages/store/test/migration-integrity-postgres.test.ts` construye esa base desde cero, comprueba
la coincidencia y después elimina un índice para demostrar que la deriva falla cerrada. Para
reproducirla:

```sh
pnpm exec vitest run packages/store/test/migration-integrity-postgres.test.ts --testTimeout=120000
```

Las migraciones nuevas se registran en `schema_migration_ledger` dentro de la misma transacción que
aplica el SQL y crea `schema_migrations`. No existe TOFU ni backfill. Una base que ya tenga
026/027/028 por nombre, pero sin ledger atómico, se rechaza. La salida explica cuál versión carece
de ledger; el operador debe presentar evidencia estructural explícita y resolver la procedencia,
no fabricar una fila.

No hay una migración productiva directa. `pnpm migrate`, `make migrate`, `make -C ops migrate` y
`ops/scripts/migrate.sh` son tombstones y fallan antes de leer `DATABASE_URL` o
`DATABASE_URL_FILE`. En producción el único camino es `ops/scripts/deploy-release.sh deploy`, que
conserva el lock autenticado y ejecuta stop/drain/CAS/migrate/restore con compensación. Para una
base descartable de desarrollo o pruebas se conserva el runner explícito:

```sh
NODE_ENV=development DATABASE_URL=postgresql://... pnpm migrate:dev
```

El CLI acepta únicamente `NODE_ENV=development` o `NODE_ENV=test` fuera del wrapper canónico de la
imagen; un valor vacío también falla cerrado, porque no demuestra que la URL sea no productiva.

`036_shadow_router_target_phase.sql` añade además un interlock operacional obligatorio: detener
los binarios shadow pre-036 y demostrar cero filas `processing` antes de migrar. La propia
migración repite esa comprobación bajo `ACCESS EXCLUSIVE` y rechaza el patrón de claim viejo que
incrementaba `attempts` al adquirir el lease. Para volver deliberadamente a un binario viejo se
aplica el orden inverso —detener runtime 036, drenar `processing`, ejecutar down036 y recién entonces
arrancar el runtime anterior—.

`037_console_publish_intent_indexes.sql` agrega los cuatro índices parciales exactos que hacen
acotados los lookups durable `key`, `nonce`, `rate` y `head`. El primer up exige el journal
`console.publish.%` vacío. Su down toma los locks global y específico, compara ledger+catálogo por
CAS y sólo admite el caso sin uso posterior del journal; después del primer intent la vuelta atrás
se rechaza. El rollback normal de release conserva schema037 y usa el bridge; no ejecuta down
migrations.

Antes y después de migrar:

```sh
CAUCE_ENV_FILE=/ruta/privada/prod.env ops/scripts/migration-integrity-gate.sh pre
CAUCE_ENV_FILE=/ruta/privada/prod.env ops/scripts/migration-integrity-gate.sh post
```

Los artefactos quedan con modo 0600 bajo `ops/artifacts/migration-integrity/`, cubiertos por
`SHA256SUMS`. Sólo contienen versiones, estados, hashes de las fuentes, la huella estructural y la
fecha de observación; no incluyen URL de base, filas de negocio, mensajes ni secretos.

`post` no es documentación opcional: exige cero migraciones pendientes y ledger atómico para cada
fuente desde 026. El `release-gate.sh` general lo vuelve a medir y `release-candidate.py` exige
simultáneamente `pre.json` y `post.json`, ambos en el manifest exacto, ligados al mismo conjunto de
fuentes. Borrar `post.json`, dejarlo fuera de `SHA256SUMS`, reutilizar uno anterior a `pre` o presentar
una migración pendiente/sin ledger hace fallar cerrado el release.
