# ADR-005: configuración versionada, atómica y default-deny

**Estado:** aceptado.

Tenants, rooms, memberships/agents, ACL dirigidas, harness definitions/capabilities y role policies son configuración durable de PostgreSQL. Toda mutación pasa por RBAC `operator+control`, scope de tenant/hub y un lock transaccional global; `expected_revision` evita lost updates.

`dry_run=true` ejecuta constraints dentro de la misma transacción y hace rollback. Un apply guarda operación e inversa en `config_revisions` y agrega `audit_events`; rollback aplica la inversa como **nueva** revisión, nunca reescribe historia. Recursos nuevos no conceden permisos implícitos. El borrado se rechaza si hay deliveries activas o leases de membresía, y las FK conservan integridad histórica.

La consola solo edita el contrato JSON permitido, incluye la revisión observada y muestra UNKNOWN ante datos/capacidades ausentes. No mantiene una copia autoritativa ni usa browser storage.
