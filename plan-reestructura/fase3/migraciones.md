# Las 12 migraciones (026–037), revisadas y refutadas contra la base real

Método: un agente por migración leyó el SQL completo y verificó cada precondición con SELECT contra `cauce-v3-prod-postgres-1` (esquema hoy: 024). Después, un refutador adversarial por migración re-midió todo. Lo que sigue es el veredicto FINAL tras la refutación.

## Mecánica de la tanda (aplica a todas)

- El runner (`packages/store/src/db.ts:88`) aplica TODO lo pendiente en **UNA transacción**: 026–037 entran o se revierten juntas. No existe aplicar una sola.
- El FK de 026 toma `SHARE ROW EXCLUSIVE` sobre `agents` y lo retiene hasta el COMMIT de 037: durante la ventana **la consola no puede altas/bajas/ediciones de alias** (las lecturas y el claim de entregas NO se bloquean).
- La huella estructural del esquema 024 que exige el verificador COINCIDE hoy (observed = expected). El gate está verde para arrancar.
- Nunca por psql a mano: por el migrator del repo (mismas semánticas que el contenedor migrator).

## Tabla de veredictos

| Mig | Riesgo | Veredicto final | Condiciones |
|---|---|---|---|
| 026 agent_profile | bajo | **Aplicar tal cual** | Intachable: tabla nueva, 14 filas sembradas, 0 violaciones medidas. Es PRECONDICIÓN del gateway nuevo (repository.ts hace LEFT JOIN agent_profiles) |
| 027 rol_agent_notify | bajo | **Aplicar tal cual** | No-op verificador contra los datos de hoy (fila existe, no diverge) |
| 028 canonical_agent_role | medio | **Aplicar tal cual** | Backfills afectan 0 filas hoy. Depende duro de 026 (orden alfabético lo garantiza). Ojo al lock escalado sobre `agents` |
| 029 reconcile_declared_fleet | **alto** | **Aplicar con DECISIÓN D1 resuelta** | ENSAYADA contra clon: deshabilita heraclito/tales/gaia Y crea los 4 agentes de Pablo (dedalo, midas, seneca, vulcano) enabled — flota 14→18. Los 4 nuevos sin fila en agent_profiles (026 siembra antes; LEFT JOIN aguanta, no publican perfil). El riesgo es de intención, no de SQL |
| 030 dlq_causal (2.211 líneas) | alto→ok | **Aplicar tal cual** | La puerta causal da 0/0/0 hoy (verificado ejecutando sus tres ramas como SELECT); 0 violaciones del CHECK nuevo; las columnas replay_* ya existen. El "riesgo alto" era de tamaño, no de contenido |
| 031 connection_session_fencing | bajo | **Aplicar tal cual** | 2 sentencias sobre 14 filas |
| 032 terminal_claim_fencing | bajo | **Aplicar tal cual** | `ADD COLUMN ... DEFAULT 0` no volátil = fast-default sin reescritura; CHECK valida 164 filas con 0 violaciones |
| 033 terminal_browser_owner | medio | **Aplicar tal cual, nunca suelta** | Precondiciones exactas verificadas (164 filas, tickets de 32 bytes). Dentro de la tanda, en la ventana |
| 034 terminal_relay_instance | **alto** | **Aplicar tras arreglo de DATOS** | **B1: aborta HOY con certeza** — 3 `terminal_sessions` de 2026-07-26 con closed_at y revoked_at NULL (ids 897cc101…, 320b0d6d…, 366bb306…). Cerrarlas/revocarlas antes. Además `LOCK TABLE terminal_sessions ACCESS EXCLUSIVE` y persiste `relay_instance_id` (ver B2 del dossier) |
| 035 agent_profile_runtime | bajo | **Aplicar tal cual** | Después de 026 y 028 (el orden alfabético lo garantiza). Migrar ANTES de desplegar el gateway nuevo |
| 036 shadow_router_target_phase | bajo | **Aplicar tal cual** (aunque el servicio esté en _legado) | No-op exacto (4 tablas shadow a 0 filas, LOCK inocuo) y **el health del gateway nuevo la exige como parte del esquema completo**. Saltarla rompe readiness |
| 037 publish_intent_indexes | bajo | **Aplicar tal cual** | La más barata del lote. Misma razón que 036: `health.ts` sondea el esquema 037; el runner la aplica con el resto. "Mandarla a _legado" fue REFUTADO con evidencia |

## Preparación de datos previa a la ventana (exacta)

```sql
-- B1: las 3 sesiones fantasma de julio que revientan la 034 (verificar ids antes de tocar):
SELECT id, issued_at FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL;
-- remedio (en la ventana, con el dueño): UPDATE terminal_sessions SET revoked_at = now() WHERE id IN ('897cc101-…','320b0d6d-…','366bb306-…');
```

Rollback de la tanda: automático si algo falla (una transacción). Rollback POST-commit: el backup de BD — los ficheros `migrations/down/` existen pero JAMÁS se probaron; no son el plan.
