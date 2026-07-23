# Runbook: rollback

1. Quitar solo el routing canary hacia V3 y bloquear publishes nuevos.
2. Para un alias, usar `cutover-rollback.sh host-native|container`: valida consumer/lease/ACK/DLQ,
   detiene solo V3 y exige drain antes de que el owner V2 restaure su consumer.
3. Para runtime, volver a una imagen V3 anterior por digest compatible:
   `CAUCE_PREVIOUS_RUNTIME_IMAGE=repo/image@sha256:... CAUCE_ROLLBACK_CONFIRM=runtime-only:repo/image@sha256:... CAUCE_ENV_FILE=/ruta/privada ./scripts/rollback.sh runtime`.
4. Reconciliar por request/message/delivery/trace e idempotency key.
5. Verificar consumer único, readiness, colas y QA real.

`packages/store/migrations` es forward-only. `rollback.sh runtime` cambia gateway,
dispatcher y outbox-metrics, luego verifica TLS/health; no toca schema, datos,
adapters ni V2. Un rollback de datos restaura backup V3 verificado en DB nueva.
Nunca arrancar V2 si el snapshot `rollback-ready` no pasó.
