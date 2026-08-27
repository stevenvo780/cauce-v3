# Runbook: Alta Disponibilidad y Failover

## Cuándo usar
Ensayar, validar y mitigar procedimientos de alta disponibilidad (HA) y failover para PostgreSQL multi-AZ, gateways redundantes, dispatchers y puentes de canal. Caveat operativo: la validación de imágenes finales queda aplazada a FASE 3; no promover HA basándose exclusivamente en Testcontainers.

## Pasos
1. Validar topología base de alta disponibilidad:
   - PostgreSQL administrado multi-AZ con TLS `sslmode=verify-full` y `pg_stat_ssl.ssl=true`.
   - Dos instancias de gateway detrás de un balanceador HTTPS con chequeo `/health/ready`.
   - Dos dispatchers con idéntico registro de jobs y bloqueos `SKIP LOCKED`.
   - Un único lease owner por `(tenant, alias)` en base de datos.
2. Ejecutar prueba de corte de gateway con tráfico activo:
   ```sh
   # [no ejecutable en verificación]
   docker stop cauce-v3-prod-gateway-1
   ```
3. Ejecutar corte controlado de base de datos o dispatcher durante procesamiento de mensajes.

## Verificar efecto
1. Verificar que los clientes reconecten automáticamente con un nuevo epoch sin doble ACK.
2. Comprobar que los mensajes en procesamiento no confirmados expiran su lease y son reintentados o dirigidos a DLQ de forma idempotente.
3. Confirmar que el outbox no registra falsos positivos (`sent` sin `sent_at`) ante fallos de conectividad.
4. Monitorear métricas de salud en Prometheus:
   - `up`
   - `cauce_dispatcher_metrics_query_success`
   - `cauce_outbox_query_success`

## Deshacer
1. Restaurar el gateway, dispatcher o nodo de base de datos interrumpido:
   ```sh
   # [no ejecutable en verificación]
   docker start cauce-v3-prod-gateway-1
   ```
2. Reanudar el balanceo de tráfico únicamente tras observar estabilidad durante al menos dos ventanas completas de lease/retry.
