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
AVISO_ATTACH=$HOME/.config/cauce-v3/attach-aviso.json
if [ ! -e "$AVISO_ATTACH" ] && [ -z "${CAUCE_DESTINO_AVISO_INICIAL:-}" ]; then
  printf 'aviso de attach sin destino: configura %s o reinstalá con CAUCE_DESTINO_AVISO_INICIAL=<destino>\n' "$AVISO_ATTACH" >&2
  exit 1
fi
PYCACHE=$(mktemp -d)
trap 'rm -rf "$PYCACHE"' EXIT

# Not every source is bash: cauce-estado, cauce-sesiones and cauce-attach are python3, and
# `bash -n` on a python file proves nothing. The pycache prefix keeps py_compile from dropping
# __pycache__/ into the repo.
sintaxis() {  # $1=source
  case "$(head -n 1 "$1")" in
    (*python3*) PYTHONPYCACHEPREFIX="$PYCACHE" python3 -m py_compile "$1" ;;
    (*bash*|*/sh|*' sh') bash -n "$1" ;;
    (*) case "$1" in (*.lib.sh) bash -n "$1" ;; (*.py) PYTHONPYCACHEPREFIX="$PYCACHE" python3 -m py_compile "$1" ;; (*) printf 'no se que interprete usa %s: no lo instalo\n' "$1" >&2; return 1 ;; esac ;;
  esac
}

comprobar() {  # $1=path under ops/. Failure prints the reason and writes nothing.
  local source="$RAIZ/$1"
  if [ ! -f "$source" ]; then
    printf 'no encuentro la fuente: %s\n' "$source" >&2
    return 1
  fi
  if ! sintaxis "$source"; then
    printf '%s no pasa la comprobación de sintaxis\n' "${1##*/}" >&2
    return 1
  fi
}

colocar() {  # $1=path under ops/. Every source was checked before the destination existed.
  local source="$RAIZ/$1" target="$BIN/${1##*/}" backup
  if [ -f "$target" ] && ! cmp -s "$source" "$target"; then
    backup="$target.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p -- "$target" "$backup"
    printf 'copia de seguridad: %s\n' "$backup"
  fi
  install -m 0755 -- "$source" "$target"
  printf 'instalado: %s\n' "$target"
}

# Checked in full before mkdir: a later missing guard must not leave a new `cauce` beside old ones.
fuentes=(
  cli/cauce
  cli/cauce-platform
  cli/cauce-diagnose
  cli/cauce-login
  cli/cauce-spaces
  cli/host_enrollment.py
  cli/host_channel_client.py
  cli/host_setup.py
  cli/host_image.py
  cli/context_client.py
  cli/context_native.py
  cli/space_archive.py
  cli/space_archive_stream.py
  cli/cauce-credenciales.lib.sh
  cli/cauce-panel
  cli/cauce-huerfanas
  cli/cauce-reponer
  guardias/cauce-estado
  guardias/cauce-sesiones
  guardias/cauce-attach
)
fallos=0
for rel in "${fuentes[@]}"; do
  comprobar "$rel" || fallos=1
done
[ "$fallos" = 0 ]
mkdir -p "$BIN"
for rel in "${fuentes[@]}"; do
  colocar "$rel"
done

if [ ! -e "$AVISO_ATTACH" ] && [ -n "${CAUCE_DESTINO_AVISO_INICIAL:-}" ]; then
  install -d -m 0700 -- "${AVISO_ATTACH%/*}"
  ( umask 077; python3 -c 'import json, sys; print(json.dumps({"destino": sys.argv[1]}))' \
      "$CAUCE_DESTINO_AVISO_INICIAL" > "$AVISO_ATTACH" )
  printf 'aviso de attach: %s -> %s\n' "$AVISO_ATTACH" "$CAUCE_DESTINO_AVISO_INICIAL"
fi
