# Telegram bridge V3

El servicio ejecuta polling y `origin_relay` para varios aliases sin compartir
identidad con V2. El token **solo** se lee desde `token_file`: debe ser archivo
regular, no symlink, propiedad del usuario del proceso y modo exacto `0600`.
Nunca se acepta token inline ni por variable de entorno.

## Corte por alias

1. Detener y verificar el poller Telegram V2 del alias.
2. Crear de forma atómica un archivo protegido cuyo contenido exacto sea
   `v2-poller-disabled:<alias>`.
3. Referenciarlo como `v2_shutdown_marker_file` y recién entonces iniciar V3.

El bridge falla cerrado si falta el marcador. `channel_bridge_leases` agrega una
única lease cercada por el ID real del bot (obtenido con `getMe`), de modo que dos
instancias V3 no pueden hacer polling simultáneo. V2 no comparte esta lease; por eso
el orden operativo anterior es obligatorio.

## Configuración declarativa

`CAUCE_TELEGRAM_CONFIG_FILE` apunta a JSON externo (contiene IDs operativos, no tokens):

```json
{
  "aliases": [{
    "alias": "kant",
    "tenant_id": "Steven",
    "room_id": "grp.steven",
    "token_file": "/run/cauce-telegram/kant.token",
    "v2_shutdown_marker_file": "/run/cauce-telegram/kant.disabled",
    "allowed_user_ids": ["123"],
    "allowed_chat_ids": ["123"],
    "recipients": [{"tenant_id": "Steven", "alias": "kant"}],
    "poll_timeout_seconds": 25,
    "poll_lease_ms": 60000
  }]
}
```

`token_file` y `v2_shutdown_marker_file` deben vivir **bajo el mismo directorio que
`config.json`**: Compose monta `CAUCE_TELEGRAM_RUNTIME_DIR` (host) en
`/run/cauce-telegram` (contenedor, read-only) y lee `config.json` desde ahí, de modo
que rutas fuera de ese mount no serían visibles para el proceso. `recipients` enruta
el DM humano: por defecto el propio alias lo atiende (una respuesta por su bot).
`ops/scripts/generate-telegram-config.py` produce estos paths y política por defecto;
`ops/scripts/telegram-cutover-preflight.py` los verifica sin leer el token.

`CAUCE_TELEGRAM_ALIASES` permite seleccionar una lista separada por comas; solo los
alias seleccionados exigen su `token_file` y marcador, lo que habilita un encendido
incremental. También se requieren `DATABASE_URL` y la migración `005_channel_bridges.sql`.
`PORT` usa 8084 por defecto (Compose usa 8086 para no colisionar con `outbox-metrics`)
y escucha solo en loopback:

- `/health/live`
- `/health/ready`
- `/metrics` (sin labels de tenant, chat, bot ni alias)

El origen, la sesión, conversación y mensaje externo se derivan exclusivamente del
update recibido. Updates denegados avanzan el cursor pero nunca ingresan a Cauce.
Los reintentos de ingress usan una clave estable, por lo que reiniciar antes de
persistir el cursor no duplica el mensaje.

## Semántica de egress

El texto se limita a 65.536 caracteres y se divide en mensajes de hasta 4.096
caracteres; previews web quedan deshabilitados. Cada chunk tiene un registro durable
`prepared/sending/sent/ambiguous/dead`, diagnóstico y cantidad total de chunks. El
ACK global `sent` se rechaza en el repositorio salvo que todos los chunks estén
confirmados como `sent`. Un `429` recibido (rechazo remoto conocido) vuelve a
`prepared` y respeta `retry_after`; un timeout, corte de transporte o respuesta 2xx
ilegible es un resultado remoto ambiguo y nunca se reintenta automáticamente.

Telegram Bot API no ofrece idempotency key. Si el proceso cae después de marcar
`sending`, al reiniciar el efecto pasa a `ambiguous`, el outbox a `dead` con un
diagnóstico durable y **no se repite ni se declara enviado**. Esto evita duplicar una
respuesta, aunque una caída entre el fence local y el inicio de la petición puede
omitirla. La métrica `egress_ambiguous` y `getEffect()` permiten inspeccionarla.

El único reenvío posible es la acción explícita y cercada
`manualReplayEffect(effectId, payloadHash, reason)`: exige efecto `ambiguous/dead`,
outbox `dead`, hash exacto y motivo no vacío; registra el replay y vuelve a encolar
una sola vez. Nunca admite un efecto `sent` o `sending`. No se registran bodies,
tokens ni IDs completos. Al primer uso de egress, el repositorio amplía de forma
idempotente y bajo advisory lock el esquema original de
`telegram_egress_effects` con estos estados y campos de diagnóstico.
