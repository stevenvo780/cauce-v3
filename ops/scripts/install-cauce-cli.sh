#!/usr/bin/env bash
# Instala los binarios de `ops/cli/` en ~/.local/bin, guardando la versión anterior.
#
# El CLI del dueño vivió catorce meses sólo en su home, sin git: nadie podía revisarlo, nadie podía
# revertirlo y cualquiera podía pisarlo. Ahora la fuente está en el repo y esto es lo único que
# escribe en el home.
#
# Son dos piezas:
#   cauce           en la TORRE. Habla con docker y con los tmux de los contenedores.
#   cauce-panel     en la TORRE. Vuelca el panel de un alias; es la única prueba de que un turno
#                   pasó por el arnés. Devuelve rc=3 en openclaw, que no tiene panel tmux.
set -euo pipefail

CLI_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli
BIN=${1:-$HOME/.local/bin}

instalar() {  # $1=fuente en el repo  $2=nombre destino
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
