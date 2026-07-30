#!/usr/bin/env bash
# Instala `ops/cli/cauce` como ~/.local/bin/cauce, guardando la versión anterior.
#
# El CLI del dueño vivió catorce meses sólo en su home, sin git: nadie podía revisarlo, nadie podía
# revertirlo y cualquiera podía pisarlo. Ahora la fuente está en el repo y esto es lo único que
# escribe en el home.
set -euo pipefail

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli/cauce
TARGET=${1:-$HOME/.local/bin/cauce}

[ -f "$SOURCE" ] || { printf 'no encuentro la fuente: %s\n' "$SOURCE" >&2; exit 1; }
bash -n "$SOURCE" || { printf 'la fuente no pasa la comprobación de sintaxis\n' >&2; exit 1; }

mkdir -p "$(dirname "$TARGET")"
if [ -f "$TARGET" ] && ! cmp -s "$SOURCE" "$TARGET"; then
  backup="$TARGET.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p -- "$TARGET" "$backup"
  printf 'copia de seguridad: %s\n' "$backup"
fi
install -m 0755 -- "$SOURCE" "$TARGET"
printf 'instalado: %s\n' "$TARGET"
