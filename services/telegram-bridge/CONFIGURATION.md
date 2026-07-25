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
que rutas fuera de ese mount no serían visibles para el proceso. `recipients` debe
contener exactamente al propio alias. Delegaciones y fan-out se realizan después con
`StructuredOutput.messages` de Cauce V3; el bridge rechaza el fan-out directo de
ingress porque no puede representar un único estado terminal de Telegram.
`ops/scripts/generate-telegram-config.py` produce estos paths y esta política;
`ops/scripts/telegram-cutover-preflight.py` los verifica sin leer el token.

### Ruteo por menciones en grupos (`chats[]` / `bot_username`)

Estas dos claves son **opcionales y van juntas**. Ninguna existe en la config viva de
producción hoy, y esa ausencia es una señal semántica, no un descuido:

| Estado del alias                    | Comportamiento en TODOS sus grupos |
|--------------------------------------|-------------------------------------|
| `chats` **ausente**                  | `legacy`: cada grupo listado en `allowed_chat_ids` sigue publicando exactamente como hoy, sin resolver menciones, sin `thread_id`, sin bloque de contexto no confiable. Es lo que hace seguro desplegar el código ANTES de instalar la config nueva. |
| `chats: []` (presente y vacío)       | `scoped`, default-deny: **ningún** grupo de ese alias publica salvo que tenga una entrada `chats[]`. |
| `chats: [{...}, ...]`                | `scoped`: cada `chat_id` listado se sirve según su entrada; cualquier otro grupo del alias (incluso si está en `allowed_chat_ids`) queda mudo. |

`bot_username` es **obligatorio para todo alias que declare `chats`** (aunque sea
`[]`): sin él, los demás bots de la flota no pueden reconocer una mención hacia ese
alias y lo silencian por error. Un alias que nunca declara `chats` puede omitir
`bot_username` sin problema.

Forma de una entrada `chats[]`:

```json
{
  "chat_id": "-5044661837",
  "mode": "mention",
  "allowed_user_ids": ["111", "222"],
  "default_alias": "kant",
  "session_scope": "user",
  "reply_to_origin": true,
  "threads": [
    { "thread_id": "42", "mode": "always" }
  ]
}
```

- `chat_id`: siempre **negativo** (los grupos/supergrupos de Telegram nunca tienen id
  positivo) y debe figurar también en el `allowed_chat_ids` del alias.
- `mode`: `mention` (default, responde solo si lo mencionan/citan) | `always` (host
  ambiente: responde también los mensajes sin destinatario) | `off` (no participa; sus
  respuestas se marcan `dead` en egress).
- `allowed_user_ids`: opcional; si está presente debe ser **subconjunto** del
  `allowed_user_ids` del alias. Ausente = hereda la lista del alias completo — no hay
  default-deny de usuario dentro de un chat ya admitido, solo de chat.
- `default_alias`: solo puede nombrarse **a sí mismo** (el alias que declara la
  entrada); cualquier otro valor es un error de config. `null` limpia un host heredado
  de una entrada `threads[]`.
- `session_scope`: `user` (default, igual a la sesión legacy) | `chat` | `thread`.
- `reply_to_origin`: si el primer chunk de la respuesta cita el mensaje original
  (`reply_to_message_id`). Default `true`.
- `threads[]`: overrides por tema (`is_topic_message`); mismo esquema salvo `chat_id`.

**Tabla de precedencia** que aplica el resolver (`services/telegram-bridge/src/addressing.ts`,
primera regla que aplica gana):

| # | Condición | Resultado |
|---|-----------|-----------|
| P0.a | sin autor válido | deniega |
| P0.b | chat privado (DM) | permite — semántica legacy intacta, sin política |
| P0.b2 | grupo + alias sin `chats` declarado | permite — modo `legacy`, sin cambios |
| P0.c | `sender_chat` (admin anónimo/canal) | deniega |
| P0.d | autor es bot / `via_bot` | deniega (anti-eco) |
| P0.e | grupo sin entrada `chats[]` para ese alias | deniega (`chat_not_configured`) |
| P0.f | usuario fuera del allowlist del chat | deniega |
| P1 | `mode: "off"` | deniega |
| P2 | el propio alias es mencionado o citado en un `/command` | **permite** |
| P3 | se mencionó a OTRO alias que sirve este chat | deniega (supresión de eco) |
| P4 | el mensaje abre con una mención ajena a la flota | deniega |
| P5 | responde a un mensaje que este bot envió | **permite** |
| P6 | responde a un mensaje de otro bot de la flota | deniega |
| P7 | `mode: "always"` | **permite** (host ambiente) |
| P8 | `/comando` sin `@sufijo` y este alias es `default_alias` | **permite** |
| P9 | este alias es el `default_alias` del chat/tema | **permite** |
| P10 | ninguna regla anterior aplica | deniega |

La supresión en P3 solo se aplica contra los alias que efectivamente **participan**
de ese chat (`chatParticipants`, calculado desde el archivo completo), no contra los
12 alias de la flota: mencionar a un alias ausente del grupo cae a P4/P7-P9 en vez de
silenciar a todos.

Generación y validación de estas claves están centralizadas en
`ops/scripts/generate-telegram-config.py --groups-file <archivo>`, que espera:

```json
{
  "bot_usernames": { "kant": "kant_cauce_bot" },
  "aliases": { "kant": { "chats": [ { "chat_id": "-5044661837", "mode": "always" } ] } }
}
```

Un alias ausente de `aliases` en ese archivo no recibe la clave `chats` en la salida
(ruteo legacy). `validate_config()` en ese mismo script replica
`parseTelegramBridgeConfig`, incluidas las reglas cruzadas entre alias
(`assertFleetUsernames`, `assertSingleAmbientHost`): un `chats.json` que dejaría a
dos alias como host ambiente del mismo chat, o que declare `chats` sin
`bot_username`, se rechaza antes de escribir el archivo.

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

Como señal visual best-effort, el bridge reacciona 👀 al aceptar un update, cambia a
🤔 y renueva `typing` mientras la entrega sigue activa, y finaliza con 👍 o 👎. Un
fallo de estas llamadas visuales nunca altera la publicación, el ACK ni el relay
durable.

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
