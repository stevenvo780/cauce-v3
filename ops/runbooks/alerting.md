# Alertas de producción sin identidad en Git

Prometheus evalúa las reglas, pero una alerta sólo es operable si un Alertmanager independiente
puede entregarla aun cuando dispatcher, outbox o Telegram Bridge estén caídos. El overlay
`deploy/compose.alertmanager.yaml` habla directamente con Telegram y usa dos entradas privadas:

- el token existente de un alias de confianza, montado como Compose secret;
- el identificador del destino en un segundo archivo privado, montado como Compose secret.

La imagen pinneada soporta `chat_id_file`. Por eso
`ops/observability/alertmanager.yaml` es la configuración operativa canónica y no contiene token,
identificador de chat ni material generado en el host.

## Preparación reproducible

Crear una vez un directorio privado fuera del checkout y ejecutar el provisionador con el alias
autorizado. El comando no imprime ni copia tokens o identificadores; sólo devuelve paths y el
principal no secreto que deben quedar en `prod.env`.

```sh
install -d -m 0700 /etc/cauce-v3/alertmanager
install -d -m 0700 /var/lib/cauce-v3-alertmanager
python3 ops/scripts/provision-alertmanager-config.py \
  --telegram-config /etc/cauce-v3/telegram-runtime/config.json \
  --telegram-runtime-dir /etc/cauce-v3/telegram-runtime \
  --alias kant \
  --tenant Steven \
  --postgres-container cauce-v3-prod-postgres-1 \
  --secret-dir /etc/cauce-v3/alertmanager \
  --data-dir /var/lib/cauce-v3-alertmanager
```

El provisionador falla si config/token permiten acceso de grupo u otros, si hay symlinks, si el
token sale del runtime Telegram o si no puede derivar exactamente un chat privado reciente desde
un origen Telegram autenticado y autorizado por ambas allowlists. La ventana por defecto es de
24 horas y el provisionador falla ante cero o varios destinos: no elige el primero ni adivina.
No inventa destinatarios ni copia material de token. Adopta los dos
directorios vacíos con el mismo principal no-root que ya posee ese token y rechaza estado previo
con ownership divergente.

Fijar además `CAUCE_ALERTMANAGER_IMAGE` a un child manifest `linux/amd64`, incorporar
`deploy/compose.alertmanager.yaml` a la lista canónica de Compose y usar como
`CAUCE_ALERTMANAGER_CONFIG_PATH` el archivo rastreado
`/opt/cauce-v3/ops/observability/alertmanager.yaml`. Guardar también todos los paths y UID/GID
emitidos por el provisionador en el `prod.env` privado. El archivo de destino y el token deben
seguir con modo `0600` y pertenecer al mismo principal no-root con el que corre Alertmanager.

## Gates

Antes del cutover:

1. `amtool check-config` sobre el YAML canónico dentro de la imagen pinneada, con ambos secrets
   presentes y legibles por el UID/GID configurado.
2. `docker compose config --quiet` con base, PostgreSQL y overlay de Alertmanager.
3. Alertmanager `/-/ready` y Prometheus mostrando un peer Alertmanager activo.
4. Una alerta sintética con etiqueta propia llega al destino confiable y luego emite `resolved`.
5. La alerta sintética se elimina; no se silencian ni alteran reglas productivas para probarla.

La prueba no pasa si sólo están verdes los contenedores. Debe acreditarse la entrega real y el
resolved, sin imprimir el destinatario, token o cuerpo externo en evidencia.

## Lectura correcta de DLQ desde schema 030

`cauce_outbox_dead_letters_open` es inventario durable: incluye historia `expected_offline` y por
eso no debe usarse sola como pager. La señal operativa es la combinación estable de
`disposition` y `actionable` publicada por
`cauce_outbox_dead_letters_open_by_disposition`. El exporter falla cerrado si PostgreSQL devuelve
un kind, disposition o flag fuera del contrato; `CauceOutboxDlqClassificationMetricsMissing`
detecta además un runtime viejo que siga publicando métricas pre-030.

Las altas recientes usan `created_at`, nunca `disposition_at`: clasificar hoy una fila histórica no
la convierte en un incidente nuevo. Los pagers de alta filtran `actionable="true"`; los casos
esperados-offline permanecen visibles como inventario pero no despiertan al operador. En cambio,
una fila `unclassified` por más de cinco minutos indica que la reconciliación causal no converge, y
la edad de `cauce_outbox_dead_letter_oldest_actionable_seconds` evita que un incidente clasificado
quede olvidado sin volver a alertar.

Antes de silenciar una alerta DLQ, ejecutar el flujo privado inspect → plan → apply → post y revisar
el listado scoped. Resolver sin replay exige id+evidence exactos, motivo y reconocimientos de riesgo;
no borra la fila ni toca el outbox/efecto. Un replay Telegram es otra operación, explícita y
separada. Nunca reinyectar inventario histórico para “poner el dashboard verde”.

## Progreso real del wake pump del gateway

El gateway publica únicamente telemetría agregada en su listener interno `:8081`; ese puerto no se
publica en el host. `cauce_gateway_wake_pump_last_progress_timestamp_seconds` cambia en cada ciclo,
incluso si no había trabajo, y por eso distingue un proceso vivo de un pump detenido. Los contadores
usan vocabulario fijo (`sent`, `retry`, `dead`, `fenced`, `error`, `cancelled`) y nunca llevan tenant,
alias, delivery, event, claim ni recipient como label.

`CauceGatewayMetricsDown` cubre la desaparición del listener;
`CauceGatewayWakePumpStale` cubre el falso verde en que health responde pero el ciclo dejó de
progresar. Un `fenced` es crítico porque el frame pudo salir sin que su ACK durable fuese aceptado.
`retry` no alerta por sí solo: una desconexión y el mantenimiento explícito de un alias son estados
operativos normales y siguen visibles en profundidad/edad durable del outbox.
