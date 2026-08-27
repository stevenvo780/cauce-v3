# Runbook: Fleet Watchdog

## Cuándo usar
Monitorear de forma periódica y en modo solo lectura la salud integral de la flota de Cauce V3 (leases de conexión, entregas muertas o fallidas, profundidad de DLQ y anomalías de reconexión).

## Pasos
1. Ejecutar verificación puntual de la flota:
   ```sh
   # [no ejecutable en verificación]
   export CAUCE_DATABASE_URL="postgresql://user:pass@host/cauce"
   python3 ops/scripts/fleet-watchdog.py \
     --output-json /tmp/watchdog-report.json \
     --output-text /tmp/watchdog-report.txt
   ```
2. Para incluir verificación de unidades systemd en hosts remotos:
   ```sh
   # [no ejecutable en verificación]
   export CAUCE_CHECK_SYSTEMD=1
   python3 ops/scripts/fleet-watchdog.py \
     --output-json /tmp/watchdog-report.json \
     --output-text /tmp/watchdog-report.txt
   ```
3. Programar ejecución periódica cada 5 minutos mediante cron o systemd timer.

## Verificar efecto
1. Comprobar el código de salida del script:
   - `0`: Verificación completada (`healthy`, `warning` o `critical`).
   - `2`: Error fatal (base de datos inaccesible o falta de permisos).
2. Revisar el reporte JSON generado en `/tmp/watchdog-report.json`:
   - `connection_leases`: Verificar que no existan aliases offline o con heartbeat vencido (>30 min).
   - `dead_letters`: Monitorear que el conteo no supere el umbral.
   - `epochs`: Detectar bucles de reconexión con épocas anómalas.
3. Revisar el resumen textual en `/tmp/watchdog-report.txt`.

## Deshacer
1. Detener y deshabilitar el timer del watchdog:
   ```sh
   # [no ejecutable en verificación]
   systemctl disable --now cauce-v3-fleet-watchdog.timer
   ```
2. Eliminar el archivo de estado persistente `/tmp/cauce-watchdog.state` si se requiere reiniciar la línea base de alertas.
