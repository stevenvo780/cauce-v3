# Reconciliación causal de DLQ — schema 030

## Alcance y garantías

`030_dlq_causal_reconciliation.sql` agrega una proyección operativa durable sobre
`dead_letters` y `outbox_dead_letters`. Una fila de DLQ no prueba por sí sola que un efecto remoto
ocurrió. Sólo `telegram_exact_sent_v1` puede cambiar un `adapter_outbox` de `dead` a `sent`, y exige
un `chunk_count` único, exactamente los índices `0..n-1`, todos los chunks `sent`, y
`provider_message_id` más `sent_at` no vacíos en cada chunk. Ninguna regla usa edad, texto de error,
sibling aproximado ni cuerpo del mensaje.

Las mutaciones de `telegram_egress_effects` pasan por el trigger
`cauce_fence_telegram_effect_030`, que toma `telegram-effect:<outbox_id>`. `apply`, el reconciliador
del bridge y el replay manual toman el mismo lock. Un chunk nuevo sólo puede insertarse mientras el
outbox está `processing`; las coordenadas causales y un efecto `sent` son inmutables, y la evidencia
durable no se borra. Así una escritura que gana primero vuelve stale el plan, y una escritura tardía
no puede invalidar una recuperación exacta ya confirmada.

La migración es aditiva sobre 029. Agrega las disposiciones estables
`ambiguous`, `safe_retry`, `missing_final`, `auth`, `expected_offline` y `unclassified`, junto con
`disposition_at`, `resolution_rule` y `evidence_sha256`. Las decisiones durables viven en
`dlq_reconciliation_transitions`, `dlq_reconciliation_runs`, `telegram_manual_replays` y
`dlq_operator_resolutions`; una resolución marca `resolved_at` y nunca borra la DLQ.

Todas las operaciones verifican en PostgreSQL que el actor tenga `allow_control`. El objetivo debe
pertenecer al mismo tenant o existir un `acl_edges` habilitado con `allow_control`. La existencia de
tenants no se duplica en los CLI: éstos sólo validan una forma acotada y PostgreSQL conserva la
fuente de verdad.

## Contrato para gateway y consola

El listado individual seguro es:

```sql
SELECT cauce_list_dlq_030(actor_tenant, actor_alias, limit, cursor_or_null);
```

`limit` debe estar entre 1 y 500. PostgreSQL aplica tenant/ACL antes de contar o devolver filas. La
respuesta base contiene `schemaVersion`, `items`, `total`, `truncated` y `nextCursor`; `dlq-list.py`
acepta `--cursor` para pedir la página siguiente y agrega
`suite=cauce-v3-dlq-safe-list`, `phase=list` y `generatedAt`.

La paginación es keyset, no offset, con orden inmutable
`(created_at DESC, target DESC, id DESC)`. `nextCursor` es opaco y está ligado por hash al tenant y
alias del actor: reutilizarlo desde otro scope falla cerrado. No es una firma criptográfica; un actor
ya autorizado que fabrique otro cursor sólo puede saltar o repetir filas dentro de su propio scope,
nunca ampliar autorización. Reaperturas cambian el estado de la fila pero no su posición, por lo
que no esconden incidentes viejos. El overload de tres argumentos se conserva como primera página
compatible.

Cada item tiene exactamente estos campos:

```text
target, id, tenantId, kind, adapter, disposition, open, actionable,
evidenceSha256, attempts, resolutionRule, createdAt, dispositionAt,
resolvedAt, reopenCount, lastReopenedAt
```

`id` es exclusivamente el id interno de la DLQ y, junto con `evidenceSha256`, forma el CAS de una
decisión de operador. `adapter`, hashes, reglas y timestamps pueden ser `null` cuando aún no existe
esa evidencia. No se exponen payload, reason, error, origin, cuerpos ni ids de message, delivery,
outbox o proveedor. El schema versionado es `ops/schemas/dlq-safe-list.schema.json`.

La UI debe mostrar por separado inventario (`total`), apertura (`open`), acción posible
(`actionable`), `kind` y `disposition`. `expected_offline` se cierra automáticamente mediante
`wake_expected_offline_v1`; queda como inventario histórico no accionable, no como envío exitoso.

## Flujo automatizado sin efectos externos

El reconciliador se ejecuta siempre en cuatro fases separadas:

```text
inspect -> plan -> apply -> post
```

Los comandos sólo admiten una conexión PostgreSQL privada verificada: el contenedor Compose exacto
`cauce-v3-prod/postgres` en ejecución, o un archivo privado de URL que pasa por
`private-postgres-command.py`. Los artefactos de salida son nuevos, atómicos, modo `0600` y nunca se
sobrescriben.

```bash
ops/scripts/dlq-reconcile.py inspect \
  --actor-tenant TENANT --actor-alias ALIAS \
  --postgres-container CONTAINER --output /ruta/privada/inspect.json

ops/scripts/dlq-reconcile.py plan \
  --actor-tenant TENANT --actor-alias ALIAS \
  --postgres-container CONTAINER --output /ruta/privada/plan.json

ops/scripts/dlq-reconcile.py apply \
  --actor-tenant TENANT --actor-alias ALIAS \
  --postgres-container CONTAINER --plan /ruta/privada/plan.json \
  --output /ruta/privada/apply.json

ops/scripts/dlq-reconcile.py post \
  --actor-tenant TENANT --actor-alias ALIAS \
  --postgres-container CONTAINER --plan /ruta/privada/plan.json \
  --output /ruta/privada/post.json
```

`plan` sólo contiene conteos, categorías y hashes agregados. `apply` toma el advisory lock global,
los locks causales de Telegram en orden y locks `FOR UPDATE`; vuelve a calcular el plan y falla si
su hash cambió. Repetir el mismo `apply` devuelve cero transiciones y no crea nuevos audits.
`audit_events` recibe una fila por transición, scoped al tenant objetivo, con regla, actor hasheado,
conteos y digest; no recibe payload, origin ni ids externos.

Para deliveries, `delivery_terminal_notice_materialized_v1` exige estado terminal con
`terminal_at` y un `audit_events.decision=allow` ligado directamente por `delivery_id`, cuya acción
sea `agent_output.materialize`, `agent_output.response` o `agent_output.fanin`.
`delivery_cancelled_v1` exige de la misma forma `delivery.cancel/allow`. El digest liga DLQ,
delivery, estado, terminal y el conjunto ordenado de ids/acciones audit, sin copiar metadata ni
payload; sólo se resuelve la DLQ, nunca se modifica ni replaya la delivery. Ausencia y `deny` no son
prueba. Una delivery terminal nunca ejecutada cuyo agente o conjunto de memberships está
estructuralmente deshabilitado usa `delivery_expected_offline_v1`; sus filas de identidad quedan
share-locked hasta confirmar el CAS, de modo que una reactivación vuelve stale el plan.

## Cierre revisado sin replay

El operador primero selecciona `id` y `evidenceSha256` desde el listado seguro. Después crea un
archivo privado `0400` o `0600`, validable con
`ops/schemas/dlq-no-replay-resolution-request.schema.json`:

```json
{
  "schemaVersion": 1,
  "target": "outbox",
  "id": "00000000-0000-4000-8000-000000000000",
  "evidenceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "reason": "revision operativa documentada",
  "actorTenant": "TENANT",
  "actorAlias": "operator_alias",
  "possibleDuplicateAcknowledged": true,
  "possibleNoDeliveryAcknowledged": true
}
```

```bash
ops/scripts/resolve-dlq-without-replay.py \
  --request /ruta/privada/request.json \
  --postgres-container CONTAINER --output /ruta/privada/resolution.json
```

Se aceptan sólo incidentes clasificados `ambiguous`, `safe_retry`, `missing_final` o `auth`.
`unclassified` y `expected_offline` se rechazan. Todos requieren reconocer posible no-entrega;
`ambiguous` y `missing_final` también requieren reconocer posible duplicado. La función no toca
`adapter_outbox`, effects ni proveedores. Una repetición con la misma evidencia, actor, motivo y
acknowledgements devuelve `alreadyApplied=true`; una decisión distinta queda fenced.

## Replay manual de Telegram

El replay es otra operación y nunca forma parte de `apply`. El request privado sigue
`ops/schemas/telegram-manual-replay-request.schema.json` y exige actor, motivo, hash exacto,
un UUID `requestId` nuevo para la decisión y `duplicateRiskAcknowledged=true`:

El `effectSha256` no se obtiene de consultas ad-hoc. A partir del `id` y
`evidenceSha256` del listado seguro, el operador crea un request 0600 conforme a
`ops/schemas/telegram-replay-inspect-request.schema.json` y ejecuta:

```bash
ops/scripts/telegram-replay-inspect.py \
  --request /ruta/privada/inspect-request.json \
  --postgres-container CONTAINER --output /ruta/privada/inspect.json
```

La salida 0600 sólo contiene el índice causal del chunk, hash del effect, estado, contador de replay
y riesgo de duplicado. No contiene `effectId`: en el bridge ese valor deriva literalmente del
UUID del outbox. Tampoco incluye payload, origin, diagnósticos, IDs de mensajes/outbox/proveedor ni
identidades externas. PostgreSQL aplica el mismo scope de tenant/ACL/control y vuelve a validar la
evidencia; el replay posterior resuelve exactamente un effect por incidente + evidencia + índice +
hash + contador bajo locks y CAS. Un selector no único falla cerrado.

```json
{
  "schemaVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000030",
  "id": "ID_DLQ_DEL_LISTADO_SEGURO",
  "evidenceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "chunkIndex": 0,
  "effectSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedReplayCount": 0,
  "reason": "ticket de revision",
  "actorTenant": "TENANT",
  "actorAlias": "operator_alias",
  "duplicateRiskAcknowledged": true
}
```

```bash
ops/scripts/telegram-manual-replay.py \
  --request /ruta/privada/request.json \
  --postgres-container CONTAINER --output /ruta/privada/replay.json
```

Sólo se agenda si effect y outbox están dead/ambiguos o si el effect quedó `prepared` con prueba
firme de que ningún chunk pendiente llegó a iniciar una llamada remota, existe la DLQ durable, el
hash coincide y no hay aceptación durable del proveedor. Reintentar la misma decisión con el mismo
`requestId` devuelve `alreadyApplied=true` sin crear otra generación; un UUID nuevo expresa una
decisión nueva deliberada sólo si `id`, `evidenceSha256` y `expectedReplayCount` siguen siendo los
inspeccionados. Una reapertura o generación concurrente vuelve el request viejo obsoleto y falla
cerrado. Un ACK queda prohibido si su final correlacionado fue
reclamado o ya es terminal. La transición conserva la DLQ, registra actor/motivo durable y advierte
que el duplicado sigue siendo posible. Si el nuevo intento vuelve a `dead`, el trigger reabre la
misma DLQ, incrementa `reopenCount` y proyecta otra transición auditable.

## Release, rollback y extensión del DLQ de deliveries

El release que contenga 030 debe declarar exactamente
`030_dlq_causal_reconciliation.sql` como schema compatible y empaquetar el up, down, scripts y
schemas anteriores. El bridge, productor de evidencia, runtime/deploy gates y rollback bridge deben
actualizarse juntos de 029 a 030. El down es idempotente antes de cualquier uso, toma los mismos
locks y falla cerrado en cuanto existe historia o estado 030; después de una transición durable no
es válido degradar a una imagen que sólo entienda 029 ni eliminar esas tablas.

Para ampliar causalidad futura sobre otros `dead_letters` históricos no se debe crear otro catálogo
ni otro ledger. Una migración posterior puede reutilizar las mismas disposiciones,
`evidence_sha256`, advisory lock, scope tenant/ACL, `dlq_reconciliation_transitions`, audit exacto,
listado seguro y cierre sin replay; sólo debe agregar reglas causales nuevas al conjunto de
candidatos. Nunca debe convertir antigüedad, estado aislado o texto en prueba de ejecución, ni hacer
replay histórico automático.
