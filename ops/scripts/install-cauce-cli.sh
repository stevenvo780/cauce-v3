#!/usr/bin/env bash
# Installs the `cauce` CLI and the guards it execs into ~/.local/bin, keeping a copy of whatever
# was there. The owner's CLI lived fourteen months only in their home, without git: nobody could
# review it, nobody could revert it and anyone could stomp on it.
# Two source directories, because `cauce` DELEGATES: `cauce <alias> estado|sesiones` and the
# exclusive attach are an `exec` on a sibling binary, so installing `cauce` alone ships
# subcommands that die with "no such file". All seven land in the SAME directory on purpose:
# cauce-estado and cauce-attach resolve cauce-sesiones next to their own executable.
set -euo pipefail

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BIN=${1:-$HOME/.local/bin}
PYCACHE=$(mktemp -d)
trap 'rm -rf "$PYCACHE"' EXIT

# Not every source is bash: cauce-estado, cauce-sesiones and cauce-attach are python3, and
# `bash -n` on a python file proves nothing. The pycache prefix keeps py_compile from dropping
# __pycache__/ into the repo.
sintaxis() {  # $1=source
  case "$(head -n 1 "$1")" in
    (*python3*) PYTHONPYCACHEPREFIX="$PYCACHE" python3 -m py_compile "$1" ;;
    (*bash*|*/sh|*' sh') bash -n "$1" ;;
    (*) printf 'no se que interprete usa %s: no lo instalo\n' "$1" >&2; return 1 ;;
  esac
}

instalar() {  # $1=source directory under ops/  $2=name, the same on both sides
  local source="$RAIZ/$1/$2" target="$BIN/$2" backup
  [ -f "$source" ] || { printf 'no encuentro la fuente: %s\n' "$source" >&2; return 1; }
  sintaxis "$source" || { printf '%s no pasa la comprobación de sintaxis\n' "$2" >&2; return 1; }
  if [ -f "$target" ] && ! cmp -s "$source" "$target"; then
    backup="$target.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p -- "$target" "$backup"
    printf 'copia de seguridad: %s\n' "$backup"
  fi
  install -m 0755 -- "$source" "$target"
  printf 'instalado: %s\n' "$target"
}

mkdir -p "$BIN"
instalar cli cauce
instalar cli cauce-panel
instalar cli cauce-huerfanas
instalar cli cauce-reponer
instalar guardias cauce-estado
instalar guardias cauce-sesiones
instalar guardias cauce-attach
