# Runbook: Fleet Watchdog

## Cuándo usar
Monitorear de forma periódica la salud de la flota (leases de conexión, entregas muertas o fallidas, profundidad de DLQ y anomalías de reconexión). Lee la base y no la modifica. Cada corrida que supera la comprobación de `CAUCE_DATABASE_URL` escribe el archivo de estado (`save_state`; por defecto `/tmp/cauce-watchdog.state`, o `CAUCE_WATCHDOG_STATE_FILE`).

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
   - `0`: el script terminó. `status` puede ser `healthy`, `warning`, `critical` o `unknown`. Un fallo de `psql` o de la base queda como `read-error` en el check y `status` `unknown`; no cambia el código de salida.
   - `2`: falta `CAUCE_DATABASE_URL`. No indica base inaccesible ni falta de permisos.
2. Revisar el reporte JSON generado en `/tmp/watchdog-report.json`. Esas tres claves están dentro de `checks`, no en la raíz:
   - `checks.connection_leases`: Verificar que no existan aliases offline o con heartbeat vencido (>30 min).
   - `checks.dead_letters`: Monitorear que el conteo no supere el umbral.
   - `checks.epochs`: Detectar bucles de reconexión con épocas anómalas.
3. Revisar el resumen textual en `/tmp/watchdog-report.txt`.

## Deshacer
1. Detener la ejecución periódica que se haya creado en el paso 3. El repositorio no instala
   ninguna unidad para este script (no existe `cauce-v3-fleet-watchdog.timer`; la unidad
   `cauce-v3-watchdog@` es otro guardia, el de consumidores duplicados): hay que parar el cron
   o el timer que se creó a mano para este script.
2. Eliminar el archivo de estado persistente `/tmp/cauce-watchdog.state` si se requiere reiniciar la línea base de alertas.
