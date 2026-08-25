#!/bin/sh
# Cauce V3 host-level backup orchestrator — runs on the DB host (agora-storage).
#
# Backs up Cauce PostgreSQL and, only when explicitly enabled, the independent
# ut-nexus SQLite database. Keeping the optional workload behind an explicit
# switch prevents a removed/unrelated service from making the Cauce backup
# permanently red while still failing closed on hosts that declare it required.
#
#   1. Cauce V3 production Postgres (container cauce-v3-prod-postgres-1), via
#      `docker exec pg_dump`. The host has neither a pg_dump/psql client nor the
#      DB password; `docker exec` uses the container's local peer/trust auth, so
#      no secret ever needs to be read or handled by this script.
#   2. Optional: Ultimate Terminal's ut-nexus SQLite, via the existing WAL-consistent
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

restore_container=""
cleanup() {
  if [ -n "$restore_container" ]; then
    docker rm -f "$restore_container" >/dev/null 2>&1 || true
    restore_container=""
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s [host-backup] %s\n' "$(ts)" "$*"; }
err() { printf '%s [host-backup] ERROR %s\n' "$(ts)" "$*" >&2; }
json_escape() {
  printf '%s' "$1" | LC_ALL=C tr '\001-\011\013-\037' ' ' \
    | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '
}

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
CAUCE_BACKUP_SKIP_RETENTION=${CAUCE_BACKUP_SKIP_RETENTION:-0}
case "$DB_RETENTION_DAYS" in
  ''|*[!0-9]*) err "DB_RETENTION_DAYS must be a positive integer"; exit 2 ;;
esac
[ "$DB_RETENTION_DAYS" -ge 1 ] || { err "DB_RETENTION_DAYS must be a positive integer"; exit 2; }
case "$CAUCE_BACKUP_SKIP_RETENTION" in
  0|1) ;;
  *) err "CAUCE_BACKUP_SKIP_RETENTION must be 0 or 1"; exit 2 ;;
esac

UT_NEXUS_BACKUP_SCRIPT=${UT_NEXUS_BACKUP_SCRIPT:-/opt/_archive/ultimate-terminal/backup-ut-nexus.py}
UT_NEXUS_OUT_ROOT=${UT_NEXUS_OUT_ROOT:-/opt/_archive/ultimate-terminal}
UT_NEXUS_RETENTION_DAYS=${UT_NEXUS_RETENTION_DAYS:-30}
UT_NEXUS_ENABLED=${UT_NEXUS_ENABLED:-0}
case "$UT_NEXUS_ENABLED" in
  0|1) ;;
  *) err "UT_NEXUS_ENABLED must be 0 or 1"; exit 2 ;;
esac

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
restore_status=skipped; restore_detail=""
restore_evidence_file=""
retention_status=not-run
ut_status=disabled; ut_detail=""
offsite_db_status=skipped; offsite_db_detail=""
offsite_ut_status=disabled; offsite_ut_detail=""
overall_rc=0

log "=== starting (db retention=${DB_RETENTION_DAYS}d, ut-nexus enabled=${UT_NEXUS_ENABLED}) ==="

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
    # A catalog listing proves only that the archive header is readable. Restore the entire dump
    # into an isolated, networkless, tmpfs-backed PostgreSQL container before publishing it.
    restore_image=$(docker inspect -f '{{.Image}}' "$CAUCE_DB_CONTAINER" 2>>"$tmperr" || true)
    restore_container="cauce-v3-backup-verify-${stamp}-$$"
    printf '%s\n' "$restore_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || restore_image=""
    if [ -n "$restore_image" ] \
       && docker run -d --name "$restore_container" --network none \
            --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2147483648 \
            -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=cauce_restore \
            -e POSTGRES_USER=postgres "$restore_image" >/dev/null 2>>"$tmperr"
    then
      attempt=0
      until docker exec "$restore_container" pg_isready -U postgres -d cauce_restore >/dev/null 2>>"$tmperr"; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 60 ]; then break; fi
        sleep 1
      done
      restored_tables=""
      restored_migrations=""
      if [ "$attempt" -lt 60 ] \
         && docker exec -i "$restore_container" pg_restore -U postgres -d cauce_restore \
              --exit-on-error --single-transaction --no-owner --no-acl <"$tmp" 2>>"$tmperr" \
         && restored_tables=$(docker exec "$restore_container" psql -X -U postgres -d cauce_restore -Atqc \
              "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('schema_migrations','tenants','rooms','memberships','messages','deliveries','adapter_outbox','connection_leases')" 2>>"$tmperr") \
         && restored_migrations=$(docker exec "$restore_container" psql -X -U postgres -d cauce_restore -Atqc \
              'SELECT count(*) FROM schema_migrations' 2>>"$tmperr") \
         && [ "$restored_tables" = 8 ] \
         && [ "${restored_migrations:-0}" -gt 0 ] 2>/dev/null
      then
        restore_status=ok
        restore_detail="isolated networkless full restore passed"
      else
        restore_status=failed
        restore_detail="isolated full restore or catalog invariants failed"
      fi
    else
      restore_status=failed
      restore_detail="could not start isolated restore verifier from the running database image"
    fi
    cleanup

    if [ "$restore_status" = ok ]; then
      mv "$tmp" "$final"
      (cd "$DB_BACKUP_DIR" && sha256sum "$(basename "$final")" >"$(basename "$final").sha256")
      restore_evidence_file="$final.restore.json"
      cat >"$restore_evidence_file" <<JSON
{
  "schema_version": 1,
  "suite": "cauce-v3-host-backup-restore",
  "verified_at_utc": "$(ts)",
  "dump_file": "$(basename "$final")",
  "dump_sha256": "$(cut -d' ' -f1 "$final.sha256")",
  "database_image_digest": "$restore_image",
  "isolated": true,
  "network": "none",
  "full_restore": true,
  "core_table_count": $restored_tables,
  "applied_migration_count": $restored_migrations
}
JSON
      chmod 0600 "$restore_evidence_file"
      db_status=ok
      db_file=$final
      log "[db] OK -> $final ($(wc -c <"$final" | tr -d ' ') bytes, isolated restore verified)"
    else
      db_status=failed
      db_detail="$restore_detail: $(tail -c 1000 "$tmperr" 2>/dev/null | tr '\n' ' ')"
      err "[db] $db_detail"
      overall_rc=1
    fi
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
if [ "$UT_NEXUS_ENABLED" = 1 ]; then
  ut_status=skipped
  offsite_ut_status=skipped
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
else
  log "[ut-nexus] disabled explicitly; Cauce backup is independent of that workload"
fi

# ---------------------------------------------------------------------------
# 3. Off-host copy to nass-stev (operator NAS, dedicated restricted key)
# ---------------------------------------------------------------------------
if [ -r "$OFFSITE_KEY" ]; then
  ssh_cmd="ssh -i $OFFSITE_KEY -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes"

  if [ "$db_status" = ok ]; then
    log "[offsite] syncing $DB_BACKUP_DIR -> $OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_DB_PATH"
    off_log="$STATUS_DIR/last-offsite-db.log"
    verify_log="$STATUS_DIR/last-offsite-db-verify.log"
    if (cd "$DB_BACKUP_DIR" && sha256sum -c "$(basename "$db_file").sha256") >>"$off_log" 2>&1 \
       && rsync -a --ignore-existing -e "$ssh_cmd" "$DB_BACKUP_DIR/" "$OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_DB_PATH" >>"$off_log" 2>&1 \
       && rsync -a --checksum --dry-run --itemize-changes -e "$ssh_cmd" \
            "$DB_BACKUP_DIR/" "$OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_DB_PATH" >"$verify_log" 2>&1 \
       && [ ! -s "$verify_log" ]
    then
      offsite_db_status=ok
      log "[offsite] db append-only mirror OK (no remote deletion/overwrite, checksum dry-run clean)"
      # Retention runs only after the new dump exists off-host. It is local-only: remote history is
      # append-only, so a local deletion or corrupted retention policy cannot propagate.
      if [ "$CAUCE_BACKUP_SKIP_RETENTION" = 1 ]; then
        retention_status=preserved-for-release
        log "[db] local retention deliberately skipped for release snapshot"
      else
        pruned=$(find "$DB_BACKUP_DIR" -maxdepth 1 -type f \
          \( -name 'cauce-*.dump' -o -name 'cauce-*.dump.sha256' -o -name 'cauce-*.dump.restore.json' \) \
          -mtime "+$DB_RETENTION_DAYS" -print -delete)
        retention_status=local-pruned-after-offsite
        [ -n "$pruned" ] && log "[db] local retention pruned after offsite verification: $(printf '%s' "$pruned" | tr '\n' ' ')"
      fi
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
    if rsync -a --ignore-existing -e "$ssh_cmd" "$UT_NEXUS_OUT_ROOT/" "$OFFSITE_USER@$OFFSITE_HOST:$OFFSITE_UT_PATH" >"$off_log" 2>&1; then
      offsite_ut_status=ok
      log "[offsite] ut-nexus mirror OK"
    else
      offsite_ut_status=failed
      offsite_ut_detail=$(tail -c 1000 "$off_log" | tr '\n' ' ')
      err "[offsite] ut-nexus mirror FAILED: $offsite_ut_detail"
      overall_rc=1
    fi
  else
    [ "$ut_status" = disabled ] || log "[offsite] skipping ut-nexus mirror (local ut-nexus backup was not ok this run)"
  fi
else
  offsite_db_status=failed
  offsite_db_detail="offsite key not readable at $OFFSITE_KEY"
  if [ "$UT_NEXUS_ENABLED" = 1 ]; then
    offsite_ut_status=failed
    offsite_ut_detail="$offsite_db_detail"
  fi
  err "[offsite] $offsite_db_detail -- off-host copy DID NOT RUN"
  overall_rc=1
fi

# ---------------------------------------------------------------------------
# Status file + summary
# ---------------------------------------------------------------------------
overall_word="ok"
[ "$overall_rc" -ne 0 ] && overall_word="failed"
ut_enabled_json=false
[ "$UT_NEXUS_ENABLED" = 1 ] && ut_enabled_json=true
skip_retention_json=false
[ "$CAUCE_BACKUP_SKIP_RETENTION" = 1 ] && skip_retention_json=true

cat >"$STATUS_FILE" <<JSON
{
  "schema_version": 4,
  "run_started_utc": "$run_start",
  "run_finished_utc": "$(ts)",
  "host": "$(hostname)",
  "db": {"status": "$db_status", "file": "$(json_escape "$db_file")", "detail": "$(json_escape "$db_detail")"},
  "restore": {"status": "$restore_status", "detail": "$(json_escape "$restore_detail")", "evidence_file": "$(json_escape "$restore_evidence_file")", "isolated": true, "network": "none"},
  "retention": {"skip_requested": $skip_retention_json, "status": "$retention_status", "days": $DB_RETENTION_DAYS},
  "ut_nexus": {"enabled": $ut_enabled_json, "status": "$ut_status", "detail": "$(json_escape "$ut_detail")"},
  "offsite": {
    "host": "$OFFSITE_HOST", "strategy": "append-only-no-delete",
    "db_status": "$offsite_db_status", "db_detail": "$(json_escape "$offsite_db_detail")",
    "ut_nexus_status": "$offsite_ut_status", "ut_nexus_detail": "$(json_escape "$offsite_ut_detail")"
  },
  "overall": "$overall_word"
}
JSON

if [ "$overall_rc" -ne 0 ]; then
  err "=== FINISHED WITH FAILURES -- see $STATUS_FILE and journalctl -u cauce-v3-host-backup.service ==="
else
  log "=== finished OK -- db=$db_file ut-nexus=$ut_status offsite(db)=$offsite_db_status offsite(ut-nexus)=$offsite_ut_status ==="
fi
exit "$overall_rc"
