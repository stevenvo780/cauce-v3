#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

HERE=$(cd "$(dirname "$0")" && pwd)
"$HERE/bootstrap-core.sh"
"$HERE/provision-agents.sh"
install -m 0755 "$HERE/show-access.sh" /usr/local/sbin/hospital-cauce-access

echo "Instancia Cauce Hospital instalada con tres agentes."
echo "Pendiente humano: autenticar Grok en builders y activar Telegram con un token rotado."
