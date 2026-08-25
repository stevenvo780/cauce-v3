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

Antes y después de migrar:

```sh
CAUCE_ENV_FILE=/ruta/privada/prod.env ops/scripts/migration-integrity-gate.sh pre
CAUCE_ENV_FILE=/ruta/privada/prod.env ops/scripts/migration-integrity-gate.sh post
```

Los artefactos quedan con modo 0600 bajo `ops/artifacts/migration-integrity/`, cubiertos por
`SHA256SUMS`. Sólo contienen versiones, estados, hashes de las fuentes, la huella estructural y la
fecha de observación; no incluyen URL de base, filas de negocio, mensajes ni secretos.
