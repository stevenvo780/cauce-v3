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
read -r -s -p "Token ROTADO de BotFather para @$EXPECTED_BOT: " bot_token
echo
[ -n "$bot_token" ] || { echo "Token vacío" >&2; exit 1; }
printf '%s\n' "$bot_token" >"$TEMP_TOKEN"
unset bot_token
chown 1000:1000 "$TEMP_TOKEN"
chmod 0600 "$TEMP_TOKEN"

python3 - "$TEMP_TOKEN" "$EXPECTED_BOT" <<'PY'
from pathlib import Path
import json
import sys
import urllib.parse
import urllib.request

token = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
expected = sys.argv[2]
url = "https://api.telegram.org/bot" + urllib.parse.quote(token, safe=":") + "/getMe"
with urllib.request.urlopen(url, timeout=15) as response:
    body = json.load(response)
result = body.get("result") if isinstance(body, dict) else None
if body.get("ok") is not True or not isinstance(result, dict) or result.get("username") != expected:
    raise SystemExit("El token no pertenece al bot esperado")
PY

activation_nonce="hospital-$(openssl rand -hex 8)"
issued_at=$(date +%s)
echo "Mandá /start $activation_nonce por DM a @$EXPECTED_BOT y después presioná Enter acá."
read -r _confirmation

python3 - "$TEMP_TOKEN" "$ALLOWLIST" "$activation_nonce" "$issued_at" <<'PY'
from pathlib import Path
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

token = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
target = Path(sys.argv[2])
expected_text = "/start " + sys.argv[3]
issued_at = int(sys.argv[4])
query = urllib.parse.urlencode({"timeout": "30", "allowed_updates": json.dumps(["message"])})
url = "https://api.telegram.org/bot" + urllib.parse.quote(token, safe=":") + "/getUpdates?" + query
with urllib.request.urlopen(url, timeout=40) as response:
    body = json.load(response)
updates = body.get("result") if isinstance(body, dict) else None
if body.get("ok") is not True or not isinstance(updates, list):
    raise SystemExit("Telegram no devolvió actualizaciones válidas")
candidate = None
for update in reversed(updates):
    message = update.get("message") if isinstance(update, dict) else None
    chat = message.get("chat") if isinstance(message, dict) else None
    sender = message.get("from") if isinstance(message, dict) else None
    if (
        isinstance(chat, dict)
        and isinstance(sender, dict)
        and chat.get("type") == "private"
        and str(chat.get("id", "")) == str(sender.get("id", ""))
        and message.get("text") == expected_text
        and isinstance(message.get("date"), int)
        and message["date"] >= issued_at
    ):
        candidate = str(chat["id"])
        break
if candidate is None or not candidate.isdigit():
    raise SystemExit("No encontré un /start privado reciente; repetí la activación")
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
