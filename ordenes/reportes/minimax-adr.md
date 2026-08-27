# Verificación de ADR — ronda 2 minimax

Comandos usados: `ls docs/adr/`, `grep -l 'shadow-router\|relay-worker\|rollback-bridge\|shadow_router' docs/adr/*.md`, `ls packages/store/migrations/`, `grep -n 'provider_accounts\|agent_account_bindings\|alias_routing_ceiling\|config_revisions\|audit_events\|routing_account_required\|health_checked_at\|consecutive_failures\|allowed_tiers\|delivery_account_assignments' packages/store/migrations/*.sql`, lectura directa de cada ADR, sobre `main` (`7590d44`).

Estado del sistema que importa para contrastar:

- `services/` vivos: `dispatcher`, `gateway`, `telegram-bridge`, `terminal-relay`. `services/relay-worker` y `services/shadow-router` están en `_legado/` (ningún ADR los menciona — verificado con `grep`).
- `packages/store/migrations/`: 37 archivos (001–037). El último (037) es `console_publish_intent_indexes`. Los referidos por los ADR (001, 002, 003, 005, 008, 010) existen.
- Migration 010 (`010_agent_account_registry.sql`) implementa el modelo descrito en ADR-006 (`provider_accounts` con PK global + `payer_tenant_id` + `shared_with_pool` + `credential_ref`, `alias_routing_ceiling` con FK espejo del pagador, `agent_account_bindings` con `priority`/`enabled` y **sin** columna `purpose`).
- Las columnas "dejadas fuera a propósito" por ADR-006 (`agents.routing_account_required`, `provider_accounts.health_status`, `provider_accounts.health_checked_at`, `provider_accounts.consecutive_failures`, `alias_routing_ceiling.allowed_tiers`, `delivery_account_assignments`) **no** aparecen en ninguna migración posterior — la promesa del ADR se sostiene.

## Tabla por ADR

| ADR | Veredicto | Detalle |
|---|---|---|
| `001-postgres-source-of-truth.md` | Vigente | Decisión fundacional (Postgres única fuente, `FOR UPDATE SKIP LOCKED`, ACK atómico). No menciona servicios específicos; sigue describiendo el sistema real. |
| `002-lease-epoch-fencing.md` | Vigente | `(tenant_id, alias)` como identidad, `epoch` en cada claim/heartbeat/ACK, presencia = `lease_until > now()`. Coherente con ADR-003 y con las migraciones 002/003/031. |
| `003-outbox-routing-and-lanes.md` | Vigente | `adapter_outbox` + `event_id+attempt+claim_token`, lanes `interactive`/`batch`, default-deny en `route/read/control`, ACL dirigida. Sin referencias a servicios retirados. |
| `004-authenticated-command-boundary.md` | Vigente | `AuthenticatedPublishSchema` excluye identidad, OIDC/JWKS/mTLS/token-file, headers forwarded inválidos en prod. Coherente con `ops/runbooks/authentication.md` (que tiene un detalle colgado, pero el ADR en sí está limpio). |
| `005-versioned-configuration.md` | Vigente | `config_revisions`, `audit_events`, `expected_revision`, dry-run en la misma transacción, RBAC `operator+control`. Verificado: `config_revisions` y `audit_events` definidos en 001/003. |
| `006-agent-registry-and-deferred-execution.md` | Vigente (con la matización que el propio ADR ya hace) | Migration 010 implementa el modelo declarado. Las columnas explícitamente excluidas (`routing_account_required`, `health_*`, `consecutive_failures`, `allowed_tiers`, `delivery_account_assignments`) no se filtraron después — la disciplina del ADR se sostuvo. La parte "ejecución remota en kratos" sigue **diseño únicamente** (lo dice el propio ADR y se confirma en repo: `ops/container-aliases.json` + diccionarios `EXPECTED` siguen siendo la única verdad de ejecución). |

## Resumen ejecutivo

- 6/6 vigentes. Ninguno referencia `shadow-router`, `relay-worker`, `rollback-bridge`, ni la maquinaria de release retirada; verificado por `grep` sobre los seis ficheros.
- Ninguno contradice el estado post-cuarentena. ADR-001 a 005 son decisiones de arquitectura del bus (DB, leases, routing, auth, config) que no nombran componentes hoy en `_legado/`. ADR-006 describe un modelo de datos que ya está migrado (010) y una fase de ejecución remota explícitamente diferida por el propio ADR.
- Ninguno está "superado por X". Las decisiones de los seis siguen siendo las decisiones que el código y las migraciones implementan.
- Cero deberían ir a bitácora.

Recomendación al integrador: sin cambios. Los ADR son el subconjunto de `docs/` que mejor sobrevivió a la purga del 27-08.