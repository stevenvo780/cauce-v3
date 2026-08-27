# @cauce/store

La única fuente durable: schema SQL, migrator transaccional y repositorio PostgreSQL.

**Contiene:** `migrations/` 001–037 forward-only (con `migrations/down/` **jamás probadas** — el rollback real de la base es el backup); `src/repository.ts`, la clase `CauceRepository` (mensajes, entregas con fencing claim/epoch, outbox, DLQ, jobs, config versionada con revisión optimista y rollback-como-nueva-revisión, agentes, auditoría) — **en partición por dominios** (ordenes/codex.md tarea 3); `src/migrate-cli.ts` para dev.

**Estado real a 2026-08-27:** la base productiva está en la migración **024**; las 026–037 (3.649 líneas SQL, escritas en un commit monolítico) **nunca se aplicaron** y se revisan una a una antes de aplicarse en FASE 3 (`plan-reestructura/31`).

**Invariantes:** mensajes no terminales nunca se borran; un consumer por `(tenant, alias)` con epoch creciente; ACLs default-deny también por constraint SQL.

**Probar:** `packages/store/test` (necesita Docker/Testcontainers) y `pnpm test:store-hardening`.

**NO TOCAR `migrations/` fuera de FASE 3.**
