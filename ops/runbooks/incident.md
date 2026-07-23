# Runbook: incidente gateway/DB/delivery

## Triage no destructivo

1. Consultar `/health/live` y `/health/ready` por separado.
2. Confirmar `up`, `cauce_dispatcher_metrics_query_success`,
   `cauce_outbox_query_success`, conexiones/leases, queue/oldest por lane,
   wake/outbox/relay y sus DLQ.
3. Consultar logs por `messageId`/`deliveryId` sin payloads ni headers de auth.
4. Confirmar DB con `pg_isready` y `SELECT 1`; revisar locks y saturación.
5. Comparar V2: no reiniciarlo ni cambiar su ruta para arreglar V3.

## Árbol de decisión

- **live falla**: reinicio controlado del gateway V3; preservar logs y core.
- **live sí, ready no**: reparar dependencia (DB/collector si obligatoria), no
  agregar réplicas que aumenten la tormenta de retries.
- **double consumer/poller**: detener el consumer V3 afectado, capturar snapshot
  y usar el gate; nunca autoarrancar V2 ni aceptar ambas instancias.
- **DLQ crece**: pausar productor/lane afectada, corregir receptor, re-drive con
  la misma idempotency key. No editar filas manualmente.
- **ACK lento/perdido**: correlacionar intento y delivery; un ACK viejo debe ser
  `out_of_order`, no confirmar el intento actual.
- **starvation**: limitar bulk antes de elevar workers; preservar control.
- **unknown job kind**: no re-drive hasta desplegar y versionar un handler; el
  dispatcher debe haberlo dejado `dead` con DLQ, nunca `done`.
- **relay failed/stalled**: reparar el egress específico; `sent_at` ausente no
  acredita entrega al origen.

## Recuperación y cierre

Ejecutar health + harness live, observar dos ventanas de retry/lease y verificar
que DLQ dejó de crecer. Registrar línea temporal, hashes de artefactos, alcance
por tenant y acciones. Nunca copiar secretos/sesiones al reporte.
