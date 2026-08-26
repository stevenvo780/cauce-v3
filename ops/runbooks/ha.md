# Runbook: HA y failover (gate, no promesa)

## Estado honesto

Cauce usa PostgreSQL durable, `SKIP LOCKED`, leases/epoch y gateways stateless. Compose, dos instancias o una DB con réplica no prueban HA. No promover sin restore/failover ensayado, auth/TLS real, relay idempotente y evidencia de fencing.

## Topología candidata

1. PostgreSQL administrado multi-AZ con writer estable, PITR y `sslmode=verify-full`; readiness debe observar `pg_stat_ssl.ssl=true`.
2. Dos gateways por digest detrás de balanceador HTTPS con health `/health/ready`. WS reconecta y drena DB; no migra sockets vivos.
3. Dos dispatchers con registry idéntico. Claims compiten por locks/leases; kind desconocido va a DLQ.
4. Un consumer/poller por `(tenant,alias)` en toda la flota, vigilado por snapshot externo más epoch/lease en DB. Nunca autoarrancar V2 como fallback.
5. Un único relay owner por adapter. Telegram y origin-relay son mutuamente exclusivos si comparten adapter.
6. Prometheus/OTel fuera del dominio de falla, con métricas exactas delivery/job, wake/outbox, relay, lease, ACK y DLQ. Serie ausente es UNKNOWN/fallo.

## Ensayo obligatorio

- Restore del último backup en DB V3 aislada; registrar RPO/RTO y SHA.
- `test-compose-authentic` con `failed=0`, `skipped=0`,
  `criticalSkipped=0`, hashes, mismo image/source digest y mecanismos explícitos
  `gateway-process-kill`/`postgres-container-kill`.
- Cortar un gateway con consumers: epoch nuevo, cero doble ACK y delivery después de reconnect.
- Failover writer administrado: readiness cae, no confirma trabajo y recupera sin pérdida.
- Detener dispatcher durante handler: lease expira y retry/DLQ refleja resultado.
- Interrumpir relay/Telegram: outbox queda failed/pending, jamás sent sin `sent_at`; reintento es idempotente.
- Ejecutar watchdog/reconciler para los 15 aliases durante soak y verificar cero overlap V2/V3.
- Restaurar tráfico solo después de dos ventanas de lease/retry estables.

## Criterios de aborto

Dos owners/pollers, ACK viejo aplicado, TLS ausente, outbox/relay falsamente sent, shadow con side effects, serie UNKNOWN, pérdida de correlación o RPO/RTO fuera de SLO. Quitar routing canary, detener solo consumers V3 afectados, conservar procesos/DB para diagnóstico y seguir `alias-cutover.md`/`rollback.md`; nunca down migration ni cambio automático de V2.
