#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

ACCESS=/etc/cauce-v3-hospital/access/console
if [ ! -f "$ACCESS" ] || [ -L "$ACCESS" ] \
   || [ "$(stat -c '%a' "$ACCESS")" != 600 ]; then
  echo "El acceso de consola todavía no fue creado" >&2
  exit 1
fi
cat "$ACCESS"
