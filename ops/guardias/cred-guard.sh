#!/bin/sh
# Wrapper around the credentials check.
# It lives in a script and not inside ExecStart= because systemd does NOT do command
# substitution there: an inline $(date) expands wrong and the log ends up writing garbage.
EST=/home/stev/.local/state
mkdir -p "$EST"
/usr/bin/python3 /home/stev/.local/bin/cred-guard.py > "$EST/cred-guard.txt" 2>&1
RC=$?
printf '%s rc=%s %s\n' "$(date -u +%FT%TZ)" "$RC" "$(tail -1 "$EST/cred-guard.txt")" >> "$EST/cred-guard.log"
exit 0
