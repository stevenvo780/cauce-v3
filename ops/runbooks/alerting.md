# Runbook: Alerting y Alertmanager

## Cuándo usar
Aprovisionar y validar el enrutamiento de alertas de Alertmanager a Telegram sin exponer tokens ni identidades en Git o logs, o al operar incidentes de DLQ y wake pump.

## Pasos
1. Crear directorios protegidos en el host:
   ```sh
   # [no ejecutable en verificación]
   install -d -m 0700 /etc/cauce-v3/alertmanager
   install -d -m 0700 /var/lib/cauce-v3-alertmanager
   ```
2. Ejecutar el provisionador de configuración:
   ```sh
   # [no ejecutable en verificación]
   python3 ops/scripts/provision-alertmanager-config.py \
     --telegram-config /etc/cauce-v3/telegram-runtime/config.json \
     --telegram-runtime-dir /etc/cauce-v3/telegram-runtime \
     --alias kant \
     --tenant default \
     --postgres-container cauce-v3-prod-postgres-1 \
     --secret-dir /etc/cauce-v3/alertmanager \
     --data-dir /var/lib/cauce-v3-alertmanager
   ```
3. Configurar variables en `prod.env` e iniciar Alertmanager con overlay de Compose:
   ```sh
   # [no ejecutable en verificación]
   docker compose -f deploy/compose.yaml -f deploy/compose.alertmanager.yaml up -d alertmanager
   ```

## Verificar efecto
1. Validar sintaxis y configuración canónica:
   ```sh
   # [no ejecutable en verificación]
   amtool check-config /opt/cauce-v3/ops/observability/alertmanager.yaml
   ```
2. Verificar readiness en Alertmanager `/-/ready` y peer activo en Prometheus.
3. Verificar métricas DLQ de outbox filtrando `actionable="true"`:
   - `cauce_outbox_dead_letters_open_by_disposition`
   - `cauce_outbox_dead_letter_oldest_actionable_seconds`
4. Comprobar progreso del wake pump:
   - `cauce_gateway_wake_pump_last_progress_timestamp_seconds`

## Deshacer
1. Detener el servicio de Alertmanager:
   ```sh
   # [no ejecutable en verificación]
   docker compose -f deploy/compose.alertmanager.yaml down
   ```
2. Limpiar directorios y secretos generados:
   ```sh
   # [no ejecutable en verificación]
   rm -rf /etc/cauce-v3/alertmanager /var/lib/cauce-v3-alertmanager
   ```
