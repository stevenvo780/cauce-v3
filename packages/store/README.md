# @cauce/store

La única fuente durable: schema SQL, migrator transaccional y repositorio PostgreSQL.

**Contiene:** migraciones SQL numeradas con huecos deliberados (el runner las ordena por nombre), y scripts `down/` solo para algunas migraciones; el rollback de una base se hace desde backup. `src/repository.ts` (53 líneas) declara `CauceRepository` como subclase vacía de `BlobsRepository`; las implementaciones se reparten por `src/repository/` y sus subdirectorios. `src/migrate-cli.ts` aplica migraciones fuera del arranque de los servicios.

**El bundle del repo puede ir por delante de la base:** las migraciones las aplica el CLI (`src/migrate-cli.ts`), nunca el arranque de un servicio. Antes de publicar, compara `schema_migrations` con el conjunto de archivos `NNN_*.sql` en `packages/store/migrations/`; no uses un número histórico fijo como límite del bundle.

**Orden de despliegue de 040 — MIGRAR ANTES DE DESPLEGAR:** `claimOne` referencia `terminal_control_holds` sin condición. Publicar este código de store contra una base que aún no aplicó 040 hace que TODA reclamación falle con `relation "terminal_control_holds" does not exist` y los agentes dejan de consumir entregas. Al revés para el rollback: primero se retira el código y después se corre `down/040`, porque bajar el esquema con el código nuevo en línea rompe igual.

**041 añade diarios de perfiles y documentos:** además del trigger sobre `agent_profiles`, el store lee `agent_profile_revisions` al persistir perfiles con fuente; `context-version.ts` lee `agent_document_revisions` y el reconciliador escribe en esa tabla. Sin la migración, esas operaciones fallan por falta de tabla. Su `down/` se niega si hay filas dentro: el diario conserva evidencia.

**Invariantes:** los mensajes no terminales nunca se borran; hay un consumer por `(tenant, alias)` con epoch creciente; las ACL son default-deny y también están protegidas por constraint SQL. El cierre o la revocación liberan el arriendo de una TUI con `releaseSessionControlHolds` dentro de la misma transacción.

El arriendo solo se toma sobre una sesión viva. La base calcula `expires_at` con `clock_timestamp()` capturado en la transacción: el mínimo entre el fin de la sesión, el final de la ventana de arriendo y, si se proporciona, el plazo de autoridad.

El diario de contexto (041) no tiene foreign key a `agents`, por lo que sobrevive a la baja del alias. Sus columnas `sha256` y `bytes` no pueden guardar el cuerpo de un documento, según sus CHECK. Para `path`, la base exige una barra inicial y una longitud de 2 a 4096; `AgentContextRevisionsStore.recordDocumentRevision` también valida ruta absoluta sin `..` ni segmentos vacíos. Hay un segundo escritor en `repository/agent-context-reconcile.ts` que inserta directamente; su plan de escritura solo exige `/` inicial y no normaliza segmentos.

**Probar:** `packages/store/test` (necesita Docker/Testcontainers) y `pnpm test:store-hardening`.

**NO TOCAR `migrations/` aplicadas:** se extienden con una migración nueva, nunca se editan; una que contamina se borra ENTERA (con su `down` y su suite), nunca se parchea — ver `AGENTS.md`.
