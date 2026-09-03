# @cauce/store

La única fuente durable: schema SQL, migrator transaccional y repositorio PostgreSQL.

**Contiene:** `migrations/` 001–040 forward-only con huecos deliberados (022, 025, 029 y 036 no existen; el runner ordena por nombre y no exige contigüidad); `migrations/down/` sólo de las que llevaron down deliberada (026, 028, 030–035, 037–040) y cada una probada por su suite de migración — el rollback real de la base es el backup; `src/repository.ts` (fachada de 43 líneas) + `src/repository/{messages,outbox,jobs,config,observability,quotas,deliveries,agents/{fanin,chain-control}}.ts` (~9,2K líneas) donde vive la clase `CauceRepository` (mensajes, entregas con fencing claim/epoch, outbox, DLQ, jobs, config versionada con revisión optimista y rollback-como-nueva-revisión, agentes, auditoría); `src/migrate-cli.ts` para dev.

**Estado real (verificado en vivo contra `schema_migrations` de producción):** la base productiva está en la migración **038**; el bundle versionado llega a **040** (039 traspaso sellado, 040 arriendo del control de la TUI), así que esas dos quedan pendientes de desplegar.

**Orden de despliegue de 040 — MIGRAR ANTES DE DESPLEGAR:** `claimOne` referencia `terminal_control_holds` sin condición y las migraciones las aplica el CLI (`src/migrate-cli.ts`), nunca el arranque de un servicio. Publicar este código de store contra una base en 038 hace que TODA reclamación falle con `relation "terminal_control_holds" does not exist` y la flota deja de consumir entregas. Al revés para el rollback: primero se retira el código y después se corre `down/040`, porque bajar el esquema con el código nuevo en línea rompe igual.

**Invariantes:** mensajes no terminales nunca se borran; un consumer por `(tenant, alias)` con epoch creciente; ACLs default-deny también por constraint SQL.

**Probar:** `packages/store/test` (necesita Docker/Testcontainers) y `pnpm test:store-hardening`.

**NO TOCAR `migrations/` aplicadas:** se extienden con una migración nueva, nunca se editan; una que contamina se borra ENTERA (con su `down` y su suite), nunca se parchea — ver `AGENTS.md`.
