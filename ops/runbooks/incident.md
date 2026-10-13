# Runbook: Gestión y Triage de Incidentes

## Cuándo usar
Diagnosticar, mitigar y resolver incidentes operativos en gateway, base de datos, dispatcher, outbox o entrega de adaptadores sin aplicar acciones destructivas.

## Pasos
1. Triage no destructivo de salud. Con mTLS o `NODE_ENV=production` el puerto principal no
   sirve `/health/live` ni `/health/ready` (responden 404). Esas rutas están en el listener
   aislado, `CAUCE_HEALTH_PORT` (8081 por defecto), dentro del contenedor; compose no publica
   ese puerto. Sin mTLS y fuera de production van en el puerto principal (`PORT`, 8080 por
   defecto). Un 404 en el puerto publicado no es caída de `/health/live`.
   ```sh
   # [no ejecutable en verificación]
   docker exec cauce-v3-prod-gateway-1 node -e 'fetch("http://127.0.0.1:8081/health/live").then(async (r)=>{console.log(r.status, await r.text()); process.exit(r.ok?0:1)})'
   docker exec cauce-v3-prod-gateway-1 node -e 'fetch("http://127.0.0.1:8081/health/ready").then(async (r)=>{console.log(r.status, await r.text()); process.exit(r.ok?0:1)})'
   ```
2. Comprobar conectividad y estado de PostgreSQL (`SELECT 1;` y revisión de locks/conexiones).
3. Consultar métricas de cola y DLQ en Prometheus o logs estructurados por `messageId`/`deliveryId` sin incluir payloads sensibles.
4. Aplicar árbol de decisión operativa:
   - Falla `/health/live` en el listener de arriba: Reinicio controlado del servicio gateway preservando logs.
   - `/health/live` OK pero `/health/ready` falla: Reparar dependencia degradada (DB/red).
   - DLQ en crecimiento: Pausar el productor o lane afectada e inspeccionar la página «Colas y DLQ», pestaña «DLQ operativo». `cauce_list_dlq_030` es la función SQL del repositorio, no una pestaña. «Señales y auditoría» tiene «Señales y relays» y «Auditoría», y no lista la DLQ.
   - ACK lento o fuera de orden: Correlacionar intentos y marcar como `out_of_order` sin confirmar entregas inválidas.

## Verificar efecto
1. Confirmar que `/health/ready` del listener del paso 1 responda con código 200.
2. Verificar que el backlog de outbox drena normalmente y no se generan nuevas entradas en DLQ.
3. Observar estabilidad durante al menos dos ventanas de retry y lease antes de declarar resuelto el incidente.

## Deshacer
1. Reanudar productores o lanes pausadas una vez mitigada la causa raíz.
2. Limpiar banderas de mantenimiento o bloqueos temporales en `/etc/cauce-v3/guards/`.
