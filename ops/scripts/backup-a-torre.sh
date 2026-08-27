#!/usr/bin/env bash
# Respaldo fuera de sitio hacia la torre (kratos) y de ahi a Drive (rclone del propio kratos).
# Cubre: dumps de BD (/var/backups/cauce-v3) y /etc/cauce-v3 (pki+secrets, tar 0600).
# La VPS es el centro de mando; la torre y Drive son el seguro contra el RAID 0.
set -euo pipefail

DESTINO="kratos"
CARPETA="cauce-v3-respaldo"
SELLO=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

tar -C /etc -czf "$TMP/etc-cauce-v3-$SELLO.tar.gz" cauce-v3
chmod 0600 "$TMP/etc-cauce-v3-$SELLO.tar.gz"

ssh -o BatchMode=yes "$DESTINO" "bash -c 'mkdir -p $CARPETA/db $CARPETA/etc'"
rsync -az /var/backups/cauce-v3/ "$DESTINO:$CARPETA/db/"
rsync -az "$TMP/etc-cauce-v3-$SELLO.tar.gz" "$DESTINO:$CARPETA/etc/"
ssh -o BatchMode=yes "$DESTINO" "bash -c 'ls -1t $CARPETA/etc/etc-cauce-v3-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm --'"
ssh -o BatchMode=yes "$DESTINO" "bash -c 'rclone copy $CARPETA gdrive:cauce-v3-respaldo --max-age 72h -q'"
echo "respaldo a torre+Drive OK ($SELLO)"
