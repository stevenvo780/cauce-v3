#!/bin/sh
# Cauce V3 host-level backup orchestrator — runs on the DB host (agora-storage).
#
# Backs up, in one run, everything that lived on that single disk with no other
# copy anywhere (verified 2026-07-25 — there was no automated backup of either
# of these before this script):
#
#   1. Cauce V3 production Postgres (container cauce-v3-prod-postgres-1), via
#      `docker exec pg_dump`. The host has neither a pg_dump/psql client nor the
#      DB password; `docker exec` uses the container's local peer/trust auth, so
#      no secret ever needs to be read or handled by this script.
#   2. Ultimate Terminal's ut-nexus SQLite, via the existing WAL-consistent
#      online-backup script (sqlite3 Connection.backup() API). A plain `cp` of
#      nexus.db alone is stale (the newest pages live in the WAL) and copying
#      db+wal+shm concurrently while the service writes can produce a torn
#      copy — see ops/scripts/ut-nexus-backup.py's own header for the measured
#      evidence.
#   3. An off-host mirror of both (plus checksums/manifests) to nass-stev, the
#      operator's NAS on the tailnet — a backup that lives on the same disk as
#      what it protects is not a backup.
#
# Each of the three stages is independent: one failing does not skip the
# others. The run as a whole exits non-zero if ANY stage failed, so the
# systemd service that wraps this script lands in `failed` state (visible via
# `systemctl --failed` / `journalctl -p err -u cauce-v3-host-backup.service`)
# and its OnFailure= alert fires. A machine-readable summary is also written to
# $STATUS_FILE on every run (success or failure) so staleness can be checked
# without re-running anything — see host-backup-monitor.sh.
#
# Deliberately NOT deployed through the app release pipeline (/opt/cauce-v3):
# backups must keep working across app deploys, rollbacks, and bad releases.
# The canonical source is this file in git; the host runs a copy installed at
# /usr/local/sbin/cauce-v3-host-backup (see ops/runbooks/backup-restore.md for
# the deploy step). Safe to re-run any time; every artifact name is
# timestamped and nothing is ever overwritten in place.
set -u
umask 077

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s [host-backup] %s\n' "$(ts)" "$*"; }
err() { printf '%s [host-backup] ERROR %s\n' "$(ts)" "$*" >&2; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

run_start=$(ts)

STATUS_DIR=${STATUS_DIR:-/var/log/cauce-v3-backup}
STATUS_FILE="$STATUS_DIR/status.json"
mkdir -p "$STATUS_DIR" || { err "cannot create $STATUS_DIR"; exit 2; }
chmod 750 "$STATUS_DIR" 2>/dev/null || true

CAUCE_DB_CONTAINER=${CAUCE_DB_CONTAINER:-cauce-v3-prod-postgres-1}
CAUCE_DB_USER=${CAUCE_DB_USER:-cauce}
CAUCE_DB_NAME=${CAUCE_DB_NAME:-cauce}
DB_BACKUP_DIR=${DB_BACKUP_DIR:-/opt/_archive/cauce-v3-db-backups}
DB_RETENTION_DAYS=${DB_RETENTION_DAYS:-14}

UT_NEXUS_BACKUP_SCRIPT=${UT_NEXUS_BACKUP_SCRIPT:-/opt/_archive/ultimate-terminal/backup-ut-nexus.py}
UT_NEXUS_OUT_ROOT=${UT_NEXUS_OUT_ROOT:-/opt/_archive/ultimate-terminal}
UT_NEXUS_RETENTION_DAYS=${UT_NEXUS_RETENTION_DAYS:-30}

# IP, not the "nass-stev" MagicDNS name: matches the existing prizma-crm
# off-host precedent and is what root@agora-storage's known_hosts already
# trusts (StrictHostKeyChecking=yes below -- no blind trust-on-first-use in
# the production path; the host key was pinned once during setup, see
# backup-restore.md).
OFFSITE_HOST=${OFFSITE_HOST:-100.64.0.4}
OFFSITE_USER=${OFFSITE_USER:-nas}
OFFSITE_KEY=${OFFSITE_KEY:-/root/.ssh/id_ed25519_cauce_backup_offsite}
# rrsync's forced command in authorized_keys already confines this key to
# /mnt/pool/backups/cauce-v3/ on the NAS (see backup-restore.md): client-side
# paths are relative to THAT root, not the NAS's real filesystem root, so
# these must stay "/db/" and "/ut-nexus/", NOT the real absolute path -- an
# absolute-looking path here gets nested inside the confined root instead
# (verified 2026-07-25: passing the real path doubled it).
OFFSITE_DB_PATH=${OFFSITE_DB_PATH:-/db/}
OFFSITE_UT_PATH=${OFFSITE_UT_PATH:-/ut-nexus/}

db_status=skipped; db_file=""; db_detail=""
ut_status=skipped; ut_detail=""
offsite_db_status=skipped; offsite_db_detail=""
offsite_ut_status=skipped; offsite_ut_detail=""
overall_rc=0

log "=== starting (db retention=${DB_RETENTION_DAYS}d, ut-nexus retention=${UT_NEXUS_RETENTION_DAYS}d) ==="

# ---------------------------------------------------------------------------
# 1. Cauce V3 Postgres
# ---------------------------------------------------------------------------
log "[db] checking container $CAUCE_DB_CONTAINER"
if [ "$(docker inspect -f '{{.State.Running}}' "$CAUCE_DB_CONTAINER" 2>/dev/null)" = "true" ]; then
  mkdir -p "$DB_BACKUP_DIR" && chmod 700 "$DB_BACKUP_DIR"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  final="$DB_BACKUP_DIR/cauce-$stamp.dump"
  tmp="$final.partial"
  tmperr="$final.partial.err"
  : > "$tmperr"
  log "[db] pg_dump --format=custom -> $tmp"
  if docker exec "$CAUCE_DB_CONTAINER" pg_dump -U "$CAUCE_DB_USER" -d "$CAUCE_DB_NAME" \
       --format=custom --compress=9 --no-owner --no-acl --serializable-deferrable \
       >"$tmp" 2>"$tmperr" \
     && [ -s "$tmp" ] \
     && docker exec -i "$CAUCE_DB_CONTAINER" pg_restore --list <"$tmp" >/dev/null 2>>"$tmperr"
  then
    mv "$tmp" "$final"
    (cd "$DB_BACKUP_DIR" && sha256sum "$(basename "$final")" >"$(basename "$final").sha256")
    pruned=$(find "$DB_BACKUP_DIR" -maxdepth 1 -type f \( -name 'cauce-*.dump' -o -name 'cauce-*.dump.sha256' \) -mtime "+$DB_RETENTION_DAYS" -print -delete)
    [ -n "$pruned" ] && log "[db] retention pruned: $(printf '%s' "$pruned" | tr '\n' ' ')"
    db_status=ok
    db_file=$final
    log "[db] OK -> $final ($(wc -c <"$final" | tr -d ' ') bytes, verified with pg_restore --list)"
  else
    db_status=failed
    db_detail="pg_dump/pg_restore --list failed: $(tail -c 1000 "$tmperr" 2>/dev/null | tr '\n' ' ')"
    err "[db] $db_detail"
    overall_rc=1
  fi
  rm -f "$tmp" "$tmperr" 2>/dev/null
else
  db_status=failed
  db_detail="container $CAUCE_DB_CONTAINER is not running (or docker inspect failed)"
  err "[db] $db_detail"
  overall_rc=1
fi

# ---------------------------------------------------------------------------
# 2. ut-nexus SQLite (WAL-consistent online backup)
# ---------------------------------------------------------------------------
log "[ut-nexus] running $UT_NEXUS_BACKUP_SCRIPT"
if [ -f "$UT_NEXUS_BACKUP_SCRIPT" ]; then
  ut_log="$STATUS_DIR/last-ut-nexus-run.log"
  if python3 "$UT_NEXUS_BACKUP_SCRIPT" --out-root "$UT_NEXUS_OUT_ROOT" --keep "$UT_NEXUS_RETENTION_DAYS" >"$ut_log" 2>&1; then
    ut_status=ok
    log "[ut-nexus] OK ($(tail -n1 "$ut_log" | tr -d '\n'))"
  else
    ut_status=failed
    ut_detail=$(tail -c 1000 "$ut_log" | tr '\n' ' ')
    err "[ut-nexus] backup FAILED: $ut_detail"
    overall_rc=1
  fi
else
  ut_status=failed
  ut_detail="backup script not found at $UT_NEXUS_BACKUP_SCRIPT"
  err "[ut-nexus] $ut_detail"
  overall_rc=1
fi

# ---------------------------------------------------------------------------
# 3. Off-host copy to nass-stev (operator NAS, dedicated restricted key)
# ---------------------------------------------------------------------------
if [ -r "$OFFSITE_KEY" ]; then
  ssh_cmd="ssh -i $OFFSITE_KEY -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes"

  if [ "$db_status" = ok ]; then
    log "[offsite] syncing $DB_BACKUP_DIR -> $OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_DB_PATH"
    off_log="$STATUS_DIR/last-offsite-db.log"
    if rsync -a --delete -e "$ssh_cmd" "$DB_BACKUP_DIR/" "$OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_DB_PATH" >"$off_log" 2>&1; then
      offsite_db_status=ok
      log "[offsite] db mirror OK"
    else
      offsite_db_status=failed
      offsite_db_detail=$(tail -c 1000 "$off_log" | tr '\n' ' ')
      err "[offsite] db mirror FAILED: $offsite_db_detail"
      overall_rc=1
    fi
  else
    log "[offsite] skipping db mirror (local db backup was not ok this run)"
  fi

  if [ "$ut_status" = ok ]; then
    log "[offsite] syncing $UT_NEXUS_OUT_ROOT -> $OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_UT_PATH"
    off_log="$STATUS_DIR/last-offsite-ut-nexus.log"
    if rsync -a --delete -e "$ssh_cmd" "$UT_NEXUS_OUT_ROOT/" "$OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_UT_PATH" >"$off_log" 2>&1; then
      offsite_ut_status=ok
      log "[offsite] ut-nexus mirror OK"
    else
      offsite_ut_status=failed
      offsite_ut_detail=$(tail -c 1000 "$off_log" | tr '\n' ' ')
      err "[offsite] ut-nexus mirror FAILED: $offsite_ut_detail"
      overall_rc=1
    fi
  else
    log "[offsite] skipping ut-nexus mirror (local ut-nexus backup was not ok this run)"
  fi
else
  offsite_db_status=failed
  offsite_ut_status=failed
  offsite_db_detail="offsite key not readable at $OFFSITE_KEY"
  offsite_ut_detail="$offsite_db_detail"
  err "[offsite] $offsite_db_detail -- off-host copy DID NOT RUN"
  overall_rc=1
fi

# ---------------------------------------------------------------------------
# Status file + summary
# ---------------------------------------------------------------------------
overall_word="ok"
[ "$overall_rc" -ne 0 ] && overall_word="failed"

cat >"$STATUS_FILE" <<JSON
{
  "run_started_utc": "$run_start",
  "run_finished_utc": "$(ts)",
  "host": "$(hostname)",
  "db": {"status": "$db_status", "file": "$(json_escape "$db_file")", "detail": "$(json_escape "$db_detail")"},
  "ut_nexus": {"status": "$ut_status", "detail": "$(json_escape "$ut_detail")"},
  "offsite": {
    "host": "$OFFSITE_HOST",
    "db_status": "$offsite_db_status", "db_detail": "$(json_escape "$offsite_db_detail")",
    "ut_nexus_status": "$offsite_ut_status", "ut_nexus_detail": "$(json_escape "$offsite_ut_detail")"
  },
  "overall": "$overall_word"
}
JSON

if [ "$overall_rc" -ne 0 ]; then
  err "=== FINISHED WITH FAILURES -- see $STATUS_FILE and journalctl -u cauce-v3-host-backup.service ==="
else
  log "=== finished OK -- db=$db_file ut-nexus=ok offsite(db)=$offsite_db_status offsite(ut-nexus)=$offsite_ut_status ==="
fi
exit "$overall_rc"
