# Runbook: Gestión y Triage de Incidentes

## Cuándo usar
Diagnosticar, mitigar y resolver incidentes operativos en gateway, base de datos, dispatcher, outbox o entrega de adaptadores sin aplicar acciones destructivas.

## Pasos
1. Ejecutar triage no destructivo de endpoints de salud:
   ```sh
   # [no ejecutable en verificación]
   curl -s http://127.0.0.1:8080/health/live
   curl -s http://127.0.0.1:8080/health/ready
   ```
2. Comprobar conectividad y estado de PostgreSQL (`SELECT 1;` y revisión de locks/conexiones).
3. Consultar métricas de cola y DLQ en Prometheus o logs estructurados por `messageId`/`deliveryId` sin incluir payloads sensibles.
4. Aplicar árbol de decisión operativa:
   - Falla `/health/live`: Reinicio controlado del servicio gateway preservando logs.
   - `/health/live` OK pero `/health/ready` falla: Reparar dependencia degradada (DB/red).
   - DLQ en crecimiento: Pausar el productor o lane afectada e inspeccionar con `ops/scripts/dlq_cli.py`.
   - ACK lento o fuera de orden: Correlacionar intentos y marcar como `out_of_order` sin confirmar entregas inválidas.

## Verificar efecto
1. Confirmar que `/health/ready` responda con código 200.
2. Verificar que el backlog de outbox drena normalmente y no se generan nuevas entradas en DLQ.
3. Observar estabilidad durante al menos dos ventanas de retry y lease antes de declarar resuelto el incidente.

## Deshacer
1. Reanudar productores o lanes pausadas una vez mitigada la causa raíz.
2. Limpiar banderas de mantenimiento o bloqueos temporales en `/etc/cauce-v3/guards/`.
