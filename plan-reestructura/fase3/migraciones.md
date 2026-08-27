# La tanda pendiente: 10 migraciones (026–028, 030–035, 037)

Revisadas una a una contra la base real (esquema hoy: 024) y re-refutadas el 27-08 tras el dictado del dueño: **la flota real es lo que está activo en la BD** — 14 agentes, todos enabled, nadie se toca. Las dos migraciones-ficción se borraron del repo (commit `b4bc7b9`): la **029** reconciliaba una "flota declarada" falsa (creaba los 4 agentes de Pablo, que se retiró, y deshabilitaba heraclito/tales/gaia, que están activos) y la **036** mantenía la valla de un servicio (`shadow-router`) ya borrado, cuyo único consumidor era su propio probe de readiness. El runner tolera huecos: ordena por nombre sin exigir contigüidad (prod ya convive con los huecos de 022 y 025).

## Mecánica de la tanda

- El runner (`packages/store/src/db.ts`) aplica TODO lo pendiente en **UNA transacción**: las 10 entran o se revierten juntas.
- El FK de 026 toma `SHARE ROW EXCLUSIVE` sobre `agents` hasta el COMMIT: durante la ventana la consola no puede altas/bajas/ediciones de alias (lecturas y claims NO se bloquean).
- Checksums: solo se congelan al aplicar (ledger atómico desde la 026). Las pendientes son editables hasta ese momento — por eso la cabecera de la 027 que citaba a la 029 se corrigió ANTES de la ventana.
- Huella estructural de la 024: verificada — ninguna de las 10 la altera (la 028 solo escribe datos en `agents.role_template_slug`).
- Nunca por psql a mano: por el migrator del repo.

## Veredictos (todas con consumidor de producto verificado línea a línea)

| Mig | Veredicto | Consumidor real |
|---|---|---|
| 026 agent_profile | aplicar | LEFT JOIN de `repository/agents.ts:226` en el camino caliente de CADA entrega |
| 027 rol_agent_notify | aplicar | FK de `memberships.role` (003:77); sin la fila, ninguna base desde cero puede tener agent_notify |
| 028 canonical_agent_role | aplicar | `revision`/`applied_revision` = fencing de publicación de perfil (`repository/agents.ts:37,159`) |
| 030 dlq_causal (2.211 líneas) | aplicar | `cauce_list_dlq_030` (observability.ts:228), replays de telegram-bridge; el helper de tests TRUNCA sus tablas en cada reset |
| 031 connection_session_fencing | aplicar | `connection_token` rotado en cada hello (`deliveries/claims.ts:75-86`) |
| 032 terminal_claim_fencing | aplicar | CAS exacto de `relay-proxy/authorization.ts:62-81` |
| 033 terminal_browser_owner | aplicar | admisión idempotente del navegador (`session-control.ts`) |
| 034 terminal_relay_instance | aplicar **tras B1** | enrutado autenticado (`presence.ts`, `registry.ts`). **B1: aborta HOY** — 3 `terminal_sessions` fantasma de julio (2× Steven/kant, 1× Pablo/vulcano) con closed_at y revoked_at NULL |
| 035 agent_profile_runtime | aplicar | evidencia durable de perfil-en-disco (`repository/agents.ts:45-120`) |
| 037 publish_intent_indexes | aplicar | ruta VIVA `app.ts:387 → routes/console-publish.ts` → índices que casan con `messages.ts:349-360`. Sigue siendo la última: `deploy/Dockerfile` ARG `CAUCE_SCHEMA_COMPATIBLE_THROUGH=037...` correcto |

## Preparación de datos previa a la ventana (B1, exacta)

```sql
-- las 3 sesiones fantasma que revientan la 034 (verificar ids antes de tocar):
SELECT id, tenant_id, alias, issued_at FROM terminal_sessions
 WHERE closed_at IS NULL AND revoked_at IS NULL;
-- remedio (en la ventana, con el dueño):
-- UPDATE terminal_sessions SET revoked_at = now() WHERE id IN ('897cc101-…','320b0d6d-…','366bb306-…');
```

## Poda de historiales (aprobada por el dueño, en la ventana, tras el backup)

El dueño: "los historiales no tienen ningún valor — copia de seguridad y fuera". Backup automatizado YA existe y está PROBADO (restore verificado 27-08, `/var/backups/cauce-v3` + `/opt/_archive` + NAS nocturno). Volúmenes medidos hoy: `audit_events` 51K/47MB · `quota_window_samples` 62K/27MB · `delivery_acks` 21K/53MB · `messages` 14K/56MB · `adapter_outbox` 19K/32MB · `deliveries` 15K/32MB. La poda exacta (qué tablas, qué antigüedad, respetando "mensajes no terminales nunca se borran") se decide con el dueño EN la ventana, nunca antes del backup de esa misma ventana.

Rollback de la tanda: automático (una transacción). Rollback POST-commit: el backup probado — los `down/` de las pendientes existen y SÍ están probados por sus suites, pero el plan es el backup.

## Nota para bases de prueba

Bases `cauce_test*` externas que ya aplicaron 029/036 en corridas previas: recrearlas (la huella de ficheros cambió y el helper lo detecta). Testcontainers no se ven afectados (nacen limpios).

## ENSAYO DE LA TANDA LIMPIA — 27-08 ~20:45 UTC, contra clon fresco de prod (VEREDICTO: LISTA)

Método: pg_dump de prod (solo lectura) → postgres:16-alpine efímero en loopback → migrator real del repo (`migrate:dev`), dos pasadas + idempotencia; clon y dump destruidos al terminar.
- **RUN 1 (sin B1)**: aborta con `cannot apply schema 034 while an unpinned terminal session remains usable` y **rollback TOTAL** (23 aplicadas, sin rastro de la 026) — la transacción única funciona.
- **B1 en el clon**: `UPDATE terminal_sessions SET revoked_at=now()` sobre las 3 fantasma → UPDATE 3.
- **RUN 2**: `Cauce V3 migrations applied` en **2,96 s** de reloj (SQL incluido en ese total). Estado final verificado: 33 versiones (las 10 exactas: 026–028, 030–035, 037), **agents 14/14 enabled INTACTOS**, agent_profiles=14, `fleet_reconciliation_*` inexistentes, columna `claim_target_started` inexistente, 0 funciones `cauce_shadow_router*`, 4 índices `*_037_idx`, 0 sesiones fantasma.
- **RUN 3**: segunda pasada = no-op idempotente.
