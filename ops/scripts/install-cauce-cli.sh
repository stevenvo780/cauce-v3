#!/usr/bin/env bash
# Installs the `ops/cli/` binaries in ~/.local/bin, saving the previous version.
#
# The owner's CLI lived fourteen months only in their home, without git: nobody could review it,
# nobody could revert it and anyone could stomp on it. Now the source is in the repo and this is
# the only thing that writes to the home.
#
# Two pieces:
#   cauce           on the TOWER. Speaks with docker and with the containers' tmux.
#   cauce-panel     on the TOWER. Dumps an alias panel; it is the only proof a turn went through
#                   the harness. Returns rc=3 on openclaw, which has no tmux panel.
set -euo pipefail

CLI_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli
BIN=${1:-$HOME/.local/bin}

instalar() {  # $1=source in the repo  $2=destination name
  local source="$CLI_DIR/$1" target="$BIN/$2" backup
  [ -f "$source" ] || { printf 'no encuentro la fuente: %s\n' "$source" >&2; return 1; }
  bash -n "$source" || { printf '%s no pasa la comprobación de sintaxis\n' "$1" >&2; return 1; }
  if [ -f "$target" ] && ! cmp -s "$source" "$target"; then
    backup="$target.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p -- "$target" "$backup"
    printf 'copia de seguridad: %s\n' "$backup"
  fi
  install -m 0755 -- "$source" "$target"
  printf 'instalado: %s\n' "$target"
}

mkdir -p "$BIN"
instalar cauce cauce
instalar cauce-panel cauce-panel
