# @cauce/store

La única fuente durable: schema SQL, migrator transaccional y repositorio PostgreSQL.

**Contiene:** `migrations/` 001–038 forward-only con huecos deliberados (022, 025, 029 y 036 no existen; el runner ordena por nombre y no exige contigüidad); `migrations/down/` sólo de las que llevaron down deliberada (026, 028, 030–035, 037–038) y cada una probada por su suite de migración — el rollback real de la base es el backup; `src/repository.ts` (fachada de 43 líneas) + `src/repository/{messages,outbox,jobs,config,observability,quotas,deliveries,agents/{fanin,chain-control}}.ts` (~9,2K líneas) donde vive la clase `CauceRepository` (mensajes, entregas con fencing claim/epoch, outbox, DLQ, jobs, config versionada con revisión optimista y rollback-como-nueva-revisión, agentes, auditoría); `src/migrate-cli.ts` para dev.

**Estado real (verificado en vivo contra `schema_migrations` de producción):** la base productiva está en la migración **038**, igual que el bundle versionado — no quedan migraciones pendientes de desplegar.

**Invariantes:** mensajes no terminales nunca se borran; un consumer por `(tenant, alias)` con epoch creciente; ACLs default-deny también por constraint SQL.

**Probar:** `packages/store/test` (necesita Docker/Testcontainers) y `pnpm test:store-hardening`.

**NO TOCAR `migrations/` aplicadas:** se extienden con una migración nueva, nunca se editan; una que contamina se borra ENTERA (con su `down` y su suite), nunca se parchea — ver `AGENTS.md`.
