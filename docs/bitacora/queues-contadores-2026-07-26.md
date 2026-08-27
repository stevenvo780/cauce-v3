# Contadores de queues: el bug tiene dos capas, no una (2026-07-26)

Seguimiento del hallazgo #2 de [`consola-e2e-2026-07-26.md`](./consola-e2e-2026-07-26.md) («los
contadores mienten fuera de las 200 más recientes»). Confirmado, con **una capa que el barrido
anterior no vio** y con dos datos del reporte original corregidos.

## Correcciones al reporte anterior

| Afirmación original | Estado | Real |
|---|---|---|
| `packages/store/src/repository.ts:2838-2861` | ubicación equivocada | `queueSnapshot` está en **`repository.ts:3886`**; 2838 cae en el egress proactivo |
| «audit siempre devuelve los 150 más recientes» (#5) | dirección correcta, número mal | el tope es **200**, no 150 (`listAudit`, `repository.ts:4570`, `limit = 200`) |
| «un reload fallido no avisa» es un bug de `use-resource` (#8) | capa equivocada | el hook **sí** preserva `data` y expone `error`; el defecto está en el guard de las páginas (`error && !data`), o sea en la capa de presentación, y afecta a más páginas que Jobs |

## La capa que faltaba: el facade pisa los contadores

`GET /v3/console/queues` no devuelve lo que calcula el store. El orden real es:

1. `repository.queueSnapshot()` (`repository.ts:3886`) hace `ORDER BY d.created_at DESC LIMIT 200`
   y **después** reduce sobre `result.rows` → los contadores ya nacen acotados a la ventana.
2. `services/gateway/src/app.ts:369` pasa ese objeto por `visibleQueue()`.
3. `visibleQueue()` (`services/gateway/src/facades.ts:62-73`) vuelve a reducir sobre `items` y
   retorna `{ ...value, ...counts, items }`. Como `...counts` va **después** de `...value`,
   **sobrescribe** cualquier contador que el store hubiera calculado.

Consecuencia operativa: **un fix aplicado sólo en `queueSnapshot` no cambia nada de lo que ve el
operador.** El facade lo pisa en memoria milisegundos después. Peor, el sistema pagaría el costo del
conteo global en Postgres para tirarlo a la basura. Son dos instancias del mismo patrón —
confundir «la página» con «el universo» — y hay que tocar las dos o ninguna.

## Reproducción mínima

Con un actor `(tenant, alias)` y **201 filas visibles** para él en `deliveries`:

- 200 filas `status='pending'` con `created_at` reciente,
- 1 fila `status='dead'` con `created_at` más antiguo que todas las anteriores.

`queueSnapshot` devuelve las 200 `pending` (la `dead` cae fuera del `LIMIT`) y reporta
`{ pending: 200, retrying: 0, dead: 0 }`. La consola muestra **0 dead letters** existiendo 1.
Escala igual con cualquier `dead` más vieja que las 200 deliveries más recientes.

Esto también explica la divergencia observada en Observabilidad (`DLQ` 101 vs `queues.dead` 14): son
métricas distintas —`dead_letters` sin resolver, contada sobre la tabla completa, contra
`deliveries.status='dead'` contada sobre la ventana de 200— y ninguna de las dos lo declara.

## Fix recomendado

Contar en SQL sobre todo el alcance visible y paginar los items aparte, **sin duplicar el predicado
de visibilidad** (si el conteo y el listado divergen en el `WHERE`, la métrica filtra existencia de
filas de otro tenant). Con window functions el conteo se evalúa después del `WHERE` y antes del
`LIMIT`, así que una sola pasada alcanza:

```sql
       ...,
       count(*) FILTER (WHERE d.status IN ('pending','leased','accepted','started')) OVER ()::int AS total_pending,
       count(*) FILTER (WHERE d.status = 'retry') OVER ()::int AS total_retrying,
       count(*) FILTER (WHERE d.status = 'dead')  OVER ()::int AS total_dead
  FROM deliveries d JOIN messages m ON m.id=d.message_id
 WHERE <el mismo predicado de visibilidad que ya está en queueSnapshot>
 ORDER BY d.created_at DESC LIMIT $3
```

Con 0 filas, los tres contadores son 0; con filas, se leen de `rows[0]` y se quitan de cada item.

Y en `facades.ts`, `visibleQueue` debe **dejar de recalcular**: filtrar `items` con
`queueRowVisible` pero preservar los contadores que vienen del store.

> Antes de aplicarlo hay que resolver una pregunta abierta: por qué existe el doble filtrado
> (el SQL ya filtra por membership/ACL y el facade vuelve a filtrar con `queueRowVisible`). Si
> `queueRowVisible` puede descartar filas que el SQL sí devuelve, entonces preservar los contadores
> del store los deja por encima de lo visible, y la opción correcta pasa a ser contar en SQL con
> el predicado ya unificado. No se puede decidir sin leer `queueRowVisible` y `Principal`.

## Bloqueo reproducible

**No se puede probar el fix del store en este contenedor: no hay Postgres.**
`pg_isready` → `/var/run/postgresql:5432 - no response`, y no hay `DATABASE_URL` en el entorno.
Un fake no sirve: la corrección depende del orden de evaluación real de las window functions
respecto del `LIMIT`, que es justamente lo que hay que verificar.

Reparto de lo que sí se puede probar sin base de datos:

- **`visibleQueue` es una función pura** (`facades.ts`) → su mitad del fix es testeable con un
  objeto sintético: dado `{ dead: 14, items: [...200 pending] }`, el resultado debe seguir diciendo
  `dead: 14`. Ese test es el que impide que la regresión vuelva.
- **`queueSnapshot`** necesita Postgres vivo (201 filas, una `dead` vieja) → queda pendiente para
  un entorno con base.
