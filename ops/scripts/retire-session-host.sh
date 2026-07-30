#!/usr/bin/env bash
# Retira el anfitrión de sesión anterior. Se corre UNA vez en kratos, al desplegar la sesión
# compartida por tmux.
#
# Por qué se retira y no se deja convivir: el anfitrión ('cauce-session-host', 'ia-tui-session')
# resolvía el mismo problema con un socket unix propio y un cliente de línea que IMITABA una TUI.
# La sesión compartida por tmux abre el binario real, así que el anfitrión no aporta nada y sí
# resta: `cauce <alias>` tenía una rama que lo prefería, de modo que dejarlo instalado significa
# que el dueño puede caer en el cliente viejo sin darse cuenta. Dos sistemas para lo mismo es
# exactamente lo que pidió que dejáramos de hacer.
#
# Nada se borra: todo se mueve a una papelera con marca de tiempo, y el commit b9efb7d de la rama
# 'fix/sesion-compartida-encendido-20260730' conserva el código.
set -euo pipefail

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TRASH="$HOME/.local/share/cauce-v3/retirado/session-host-$STAMP"
UNITS="$HOME/.config/systemd/user"
BIN="$HOME/.local/bin"

mkdir -p "$TRASH"

moved=0
retire() {
  local path=$1
  [ -e "$path" ] || return 0
  mv -- "$path" "$TRASH/"
  printf 'retirado: %s\n' "$path"
  moved=$((moved + 1))
}

# 1) Parar y deshabilitar cualquier instancia viva de la unidad plantilla.
while read -r unit; do
  [ -n "$unit" ] || continue
  printf 'parando %s\n' "$unit"
  systemctl --user stop "$unit" || true
  systemctl --user disable "$unit" || true
done < <(systemctl --user list-units --no-legend --plain 'cauce-v3-session-host@*.service' 2>/dev/null | awk '{print $1}')

# 2) Retirar la unidad plantilla, el lanzador y el cliente de línea.
retire "$UNITS/cauce-v3-session-host@.service"
retire "$UNITS/cauce-v3-session-host@.service.d"
retire "$HOME/.local/share/cauce-v3/ops/session-host"
retire "$BIN/ia-tui-session"
retire "$BIN/cauce-session-host"

systemctl --user daemon-reload || true

printf '\n%s elementos retirados a %s\n' "$moved" "$TRASH"
printf 'la sesion compartida ahora es tmux + el helper del bundle; ver docs/sesion-compartida-tmux.md\n'
