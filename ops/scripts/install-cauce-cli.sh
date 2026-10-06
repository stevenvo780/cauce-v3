#!/usr/bin/env bash
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
    (*) case "$1" in (*.lib.sh) bash -n "$1" ;; (*) printf 'no se que interprete usa %s: no lo instalo\n' "$1" >&2; return 1 ;; esac ;;
  esac
}

copy_artifact() {
  local source=$1 target=$2 mode=$3 backup
  [ -f "$source" ] || { printf 'no encuentro la fuente: %s\n' "$source" >&2; return 1; }
  [ ! -L "$target" ] || { printf 'destino enlazado: %s\n' "$target" >&2; return 1; }
  if [ -f "$target" ] && ! cmp -s "$source" "$target"; then
    backup="$target.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p -- "$target" "$backup"
    printf 'copia de seguridad: %s\n' "$backup"
  fi
  install -m "$mode" -- "$source" "$target"
  printf 'instalado: %s\n' "$target"
}

instalar() {
  local source="$RAIZ/$1/$2"
  sintaxis "$source" || { printf '%s no pasa la comprobación de sintaxis\n' "$2" >&2; return 1; }
  copy_artifact "$source" "$BIN/$2" 0755
}

install_instance_selector() {
  local relative destination directory
  local -a files=(cli/instance-selection.py instances/common/descriptor.py schemas/instance-descriptor.schema.json)
  for relative in "${files[@]}"; do
    destination="$BIN/.cauce-instance/ops/$relative"
    directory=$(dirname "$destination")
    local ancestor="$BIN/.cauce-instance"
    [ ! -L "$ancestor" ] || return 1
    ancestor="$BIN/.cauce-instance/ops"
    [ ! -L "$ancestor" ] || return 1
    case "$relative" in
      *.py) PYTHONPYCACHEPREFIX="$PYCACHE" python3 -m py_compile "$RAIZ/$relative" ;;
      *.json) python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$RAIZ/$relative" ;;
    esac
    while [[ $directory != "$BIN" && $directory != / ]]; do
      [ ! -L "$directory" ] || { printf 'directorio enlazado: %s\n' "$directory" >&2; return 1; }
      directory=$(dirname "$directory")
    done
    mkdir -p "$(dirname "$destination")"
    copy_artifact "$RAIZ/$relative" "$destination" 0644
  done
}

mkdir -p "$BIN"
BIN=$(cd -- "$BIN" && pwd -P)
instalar cli cauce
instalar cli cauce-credenciales.lib.sh  # sourced by cauce: login, aprovisionar, retirar
instalar cli cauce-panel
instalar cli cauce-huerfanas
instalar cli cauce-reponer
instalar guardias cauce-estado
instalar guardias cauce-sesiones
instalar guardias cauce-attach
install_instance_selector
