#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecutá esta activación con sudo desde una terminal interactiva" >&2
  exit 1
fi
[ -t 0 ] || { echo "La activación requiere una terminal interactiva" >&2; exit 1; }

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
ENV_FILE=/etc/cauce-v3-hospital/prod.env
RUNTIME=/etc/cauce-v3-hospital/telegram-runtime
TOKEN_FILE=$RUNTIME/operador.token
ALLOWLIST=/etc/cauce-v3-hospital/telegram-allowlist.json
EXPECTED_BOT=hospitales_builder_developer_bot
TEMP_TOKEN=$RUNTIME/.operador.token.tmp
cleanup() {
  rm -f "$TEMP_TOKEN"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
COMPOSE=(
  docker compose --env-file "$ENV_FILE"
  --profile telegram
  -f "$REPO/deploy/compose.yaml"
  -f "$REPO/deploy/compose.postgres.yaml"
  --project-directory "$REPO/deploy"
)

[ -r "$ENV_FILE" ] || { echo "Falta $ENV_FILE" >&2; exit 1; }
for command in docker openssl python3 systemctl; do
  command -v "$command" >/dev/null || { echo "Falta $command" >&2; exit 1; }
done
for alias in operador backend frontend; do
  [ "$(systemctl is-active "cauce-v3-container-$alias.service" 2>/dev/null)" = active ] \
    || { echo "El adapter $alias no está activo" >&2; exit 1; }
done

leases=$(docker exec hospital-cauce-postgres-1 psql -XAtq -U cauce_hospital -d cauce_hospital \
  -c "SELECT count(*) FROM connection_leases WHERE tenant_id='Hospital' AND lease_until > now()")
[ "$leases" = 3 ] || { echo "La flota no tiene sus tres leases activos" >&2; exit 1; }

install -d -o 1000 -g 1000 -m 0700 "$RUNTIME"
read -r -s -p "Pegá únicamente el token completo más reciente de @$EXPECTED_BOT: " bot_token
echo
[ -n "$bot_token" ] || { echo "Token vacío" >&2; exit 1; }
printf '%s\n' "$bot_token" >"$TEMP_TOKEN"
unset bot_token
chown 1000:1000 "$TEMP_TOKEN"
chmod 0600 "$TEMP_TOKEN"

python3 - "$TEMP_TOKEN" "$EXPECTED_BOT" <<'PY'
from pathlib import Path
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

token = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
expected = sys.argv[2]
if re.fullmatch(r"[0-9]{6,12}:[A-Za-z0-9_-]{30,80}", token) is None:
    raise SystemExit("El valor ingresado no tiene formato de token de BotFather")
url = "https://api.telegram.org/bot" + urllib.parse.quote(token, safe=":") + "/getMe"
try:
    with urllib.request.urlopen(url, timeout=15) as response:
        body = json.load(response)
except urllib.error.HTTPError as error:
    if error.code in {401, 404}:
        raise SystemExit(
            f"Telegram rechazó el token (HTTP {error.code}); copiá el último token completo desde BotFather"
        ) from None
    raise SystemExit(f"Telegram no pudo validar el token (HTTP {error.code})") from None
except (urllib.error.URLError, TimeoutError, OSError):
    raise SystemExit("No se pudo contactar a Telegram para validar el token") from None
result = body.get("result") if isinstance(body, dict) else None
if not isinstance(body, dict) or body.get("ok") is not True or not isinstance(result, dict):
    raise SystemExit("Telegram devolvió una respuesta inválida al validar el token")
if result.get("username") != expected:
    raise SystemExit("El token no pertenece al bot esperado")
PY

activation_nonce="hospital-$(openssl rand -hex 8)"
python3 - "$TEMP_TOKEN" "$ALLOWLIST" "$activation_nonce" "$EXPECTED_BOT" <<'PY'
from pathlib import Path
import json
import math
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

token = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
target = Path(sys.argv[2])
nonce = sys.argv[3]
expected_bot = sys.argv[4]
api = "https://api.telegram.org/bot" + urllib.parse.quote(token, safe=":") + "/"


def telegram(method: str, parameters: dict[str, str | int]) -> object:
    query = urllib.parse.urlencode(parameters)
    try:
        with urllib.request.urlopen(
            api + method + "?" + query,
            timeout=int(parameters.get("timeout", 0)) + 10,
        ) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 409 and method == "getUpdates":
            raise SystemExit("Otro proceso está consumiendo getUpdates para este bot (HTTP 409)") from None
        raise SystemExit(f"Telegram rechazó {method} (HTTP {error.code})") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SystemExit(f"No se pudo contactar a Telegram durante {method}") from None
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise SystemExit(f"Telegram rechazó {method}")
    return result


webhook = telegram("getWebhookInfo", {})
if isinstance(webhook, dict) and webhook.get("url"):
    raise SystemExit("El bot tiene un webhook activo; retiralo antes de usar Cauce")

backlog = telegram(
    "getUpdates",
    {"offset": -1, "limit": 1, "timeout": 0, "allowed_updates": json.dumps(["message"])},
)
if not isinstance(backlog, list):
    raise SystemExit("Telegram no devolvió actualizaciones válidas")
offset = None
for previous in backlog:
    if isinstance(previous, dict) and isinstance(previous.get("update_id"), int):
        offset = previous["update_id"] + 1

issued_at = int(time.time()) - 5
deadline = time.monotonic() + 300
link = f"https://t.me/{expected_bot}?start={nonce}"
print(f"Abrí {link}, tocá Start y dejá esta terminal abierta; espero hasta 5 minutos.", flush=True)

candidate = None
candidate_update_id = None
observed = 0
private_messages = 0
start_commands = 0
while candidate is None and time.monotonic() < deadline:
    remaining = max(1, math.ceil(deadline - time.monotonic()))
    parameters: dict[str, str | int] = {
        "timeout": min(20, remaining),
        "limit": 100,
        "allowed_updates": json.dumps(["message"]),
    }
    if offset is not None:
        parameters["offset"] = offset
    updates = telegram("getUpdates", parameters)
    if not isinstance(updates, list):
        raise SystemExit("Telegram no devolvió actualizaciones válidas")
    for update in updates:
        if not isinstance(update, dict):
            continue
        update_id = update.get("update_id")
        if isinstance(update_id, int):
            offset = update_id + 1
        observed += 1
        message = update.get("message")
        chat = message.get("chat") if isinstance(message, dict) else None
        sender = message.get("from") if isinstance(message, dict) else None
        if not (
            isinstance(chat, dict)
            and isinstance(sender, dict)
            and chat.get("type") == "private"
            and str(chat.get("id", "")) == str(sender.get("id", ""))
        ):
            continue
        private_messages += 1
        text = message.get("text")
        parts = text.replace("\u00a0", " ").strip().split() if isinstance(text, str) else []
        if parts and parts[0] in {"/start", f"/start@{expected_bot}"}:
            start_commands += 1
        if (
            len(parts) == 2
            and parts[0] in {"/start", f"/start@{expected_bot}"}
            and parts[1] == nonce
            and isinstance(message.get("date"), int)
            and message["date"] >= issued_at
            and isinstance(update_id, int)
        ):
            candidate = str(chat["id"])
            candidate_update_id = update_id
            break
if candidate is None or not candidate.isdigit() or candidate_update_id is None:
    raise SystemExit(
        "No encontré el desafío privado "
        f"(actualizaciones={observed}, privados={private_messages}, comandos_start={start_commands})"
    )
confirmed = telegram(
    "getUpdates",
    {
        "offset": candidate_update_id + 1,
        "limit": 1,
        "timeout": 0,
        "allowed_updates": json.dumps(["message"]),
    },
)
if not isinstance(confirmed, list):
    raise SystemExit("Telegram no confirmó el desafío de activación")
document = {
    "aliases": {
        "operador": {"user_ids": [candidate], "chat_ids": [candidate]}
    }
}
descriptor, temporary = tempfile.mkstemp(prefix=".telegram-allowlist-", dir=target.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(document, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
finally:
    Path(temporary).unlink(missing_ok=True)
PY

mv "$TEMP_TOKEN" "$TOKEN_FILE"
chown 1000:1000 "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"
printf 'v2-poller-disabled:operador\n' >"$RUNTIME/operador.disabled"
chown 1000:1000 "$RUNTIME/operador.disabled"
chmod 0644 "$RUNTIME/operador.disabled"

python3 "$REPO/ops/scripts/generate-telegram-config.py" \
  --ops-dir "$REPO/ops" \
  --aliases operador \
  --allowlist-file "$ALLOWLIST" \
  --output "$RUNTIME/config.json"
chown 1000:1000 "$RUNTIME/config.json"
chmod 0600 "$RUNTIME/config.json"

python3 "$REPO/ops/scripts/telegram-cutover-preflight.py" \
  --config "$RUNTIME/config.json" \
  --aliases operador \
  --runtime-dir "$RUNTIME" \
  --expected-uid 1000 >/dev/null

python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import os
import tempfile
import sys

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines()
key = "COMPOSE_PROFILES"
value = "telegram,observability"
matches = [index for index, line in enumerate(lines) if line.startswith(key + "=")]
if len(matches) != 1:
    raise SystemExit("COMPOSE_PROFILES debe existir exactamente una vez")
lines[matches[0]] = key + "=" + value
descriptor, temporary = tempfile.mkstemp(prefix=".prod-env-", dir=path.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    Path(temporary).unlink(missing_ok=True)
PY

"${COMPOSE[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 120 telegram-bridge
container=$("${COMPOSE[@]}" ps -q telegram-bridge)
if [ -z "$container" ] \
   || [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" != healthy ]; then
  "${COMPOSE[@]}" stop telegram-bridge
  echo "El bridge no quedó saludable; se detuvo" >&2
  exit 1
fi

echo "Telegram Cauce quedó activo sólo para operador. Enviá un mensaje nuevo al bot para probar el fan-out."
