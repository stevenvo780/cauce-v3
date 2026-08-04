#!/bin/sh
# Envoltorio del chequeo de credenciales.
# Va en un script y no dentro de ExecStart= porque systemd NO hace sustitucion de comandos:
# un $(date) inline se expande mal y el log queda escribiendo basura (paso: "rc=/bin/fish").
EST=/home/stev/.local/state
mkdir -p "$EST"
/usr/bin/python3 /home/stev/.local/bin/cred-guard.py > "$EST/cred-guard.txt" 2>&1
RC=$?
printf '%s rc=%s %s\n' "$(date -u +%FT%TZ)" "$RC" "$(tail -1 "$EST/cred-guard.txt")" >> "$EST/cred-guard.log"
exit 0
