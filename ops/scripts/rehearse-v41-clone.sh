#!/usr/bin/env bash
# Rehearses release R1 (migrations 052-054) on a disposable clone restored from a production dump.
# The clone lives on an internal network with its data on tmpfs and is destroyed on every exit;
# with --delete-dump the dump is deleted on every exit too, failures included.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: rehearse-v41-clone.sh --dump FILE --image RUNTIME_IMAGE --postgres-image IMAGE@sha256:DIGEST
         --expected-admins UUID[,UUID...] [--platform-admin UUID --owner UUID:EMAIL [--owner UUID:EMAIL ...]]
         [--max-migration-ms MS] [--tmpfs-size SIZE] [--delete-dump]
--postgres-image is the exact digest production runs: CAUCE_POSTGRES_IMAGE in /etc/cauce-v3/prod.env.
EOF
  exit 2
}
die() { printf 'rehearsal failed: %s\n' "$*" >&2; exit 1; }
step() { printf '== %s\n' "$*"; }

DUMP=; IMAGE=; EXPECTED=; ADMIN=; OWNERS=(); MAX_MS=2000
POSTGRES_IMAGE=; TMPFS_SIZE=4g; DELETE_DUMP=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump) DUMP=${2:-}; shift 2 ;;
    --image) IMAGE=${2:-}; shift 2 ;;
    --expected-admins) EXPECTED=${2:-}; shift 2 ;;
    --platform-admin) ADMIN=${2:-}; shift 2 ;;
    --owner) OWNERS+=("${2:-}"); shift 2 ;;
    --max-migration-ms) MAX_MS=${2:-}; shift 2 ;;
    --postgres-image) POSTGRES_IMAGE=${2:-}; shift 2 ;;
    --tmpfs-size) TMPFS_SIZE=${2:-}; shift 2 ;;
    --delete-dump) DELETE_DUMP=1; shift ;;
    *) usage ;;
  esac
done
NAME="cauce-v41-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)-$$"
PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
window_file=
cleanup() {
  docker rm -f "$NAME-pg" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
  [ -z "$window_file" ] || rm -f -- "$window_file"
  [ -n "$DUMP" ] || return 0
  if [ "$DELETE_DUMP" = 1 ]; then rm -f -- "$DUMP"; else printf 'the dump holds production data: delete %s\n' "$DUMP" >&2; fi
}
trap cleanup EXIT
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
[ -r "$DUMP" ] && [ -n "$IMAGE" ] || usage
printf '%s\n' "$POSTGRES_IMAGE" | grep -Eqx '[^[:space:]]+@sha256:[0-9a-f]{64}' \
  || die '--postgres-image must pin the digest production runs'
printf '%s\n' "$EXPECTED" | grep -Eqx "$UUID(,$UUID)*" || die '--expected-admins needs full UUIDs'
printf '%s\n' "$MAX_MS" | grep -Eqx '[1-9][0-9]*' || die '--max-migration-ms must be a positive integer'
if [ "${#OWNERS[@]}" -gt 0 ]; then
  printf '%s\n' "$ADMIN" | grep -Eqx "$UUID" || die '--owner needs --platform-admin'
  for owner in "${OWNERS[@]}"; do printf '%s\n' "$owner" | grep -Eqx "$UUID:[^:'[:space:]]+@[^:'[:space:]]+" || die "invalid --owner $owner"; done
fi

psql_on() { local database=$1; shift; docker exec -i "$NAME-pg" psql -X -q -At -v ON_ERROR_STOP=1 -U cauce -d "$database" "$@"; }
migrate() {
  docker run --rm --network "$NAME" -e NODE_ENV=test -e "DATABASE_URL=postgresql://cauce:$PASSWORD@$NAME-pg:5432/$1" \
    "$IMAGE" node packages/store/dist/migrate-cli.js
}
now_ms() { date +%s%3N; }
down_file() { docker run --rm --entrypoint cat "$IMAGE" "packages/store/migrations/down/$1"; }
# A reader holds ACCESS SHARE on one table of cauce_contended until it is released.
reader() {
  docker exec -d -e "PGAPPNAME=rehearsal-$1" "$NAME-pg" psql -X -U cauce -d cauce_contended \
    -c 'BEGIN' -c "SELECT count(*) FROM $1" -c 'SELECT pg_sleep(120)'
}
readers() {
  for _ in $(seq 40); do
    [ "$(psql_on postgres -c "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'rehearsal-%'
      AND query LIKE 'SELECT pg_sleep%'")" = "$1" ] && return 0
    sleep 0.25
  done
  die 'the contending readers did not start'
}
release() { psql_on postgres -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name='rehearsal-$1'" >/dev/null; }
# Releases tenants 3 s after the migration starts waiting for it, while rooms stays held.
release_tenants_later() {
  for _ in $(seq 120); do
    if [ "$(psql_on cauce_contended -c "SELECT count(*) FROM pg_locks WHERE NOT granted AND mode='AccessExclusiveLock'
        AND relation='public.tenants'::regclass AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")" = 1 ]; then
      sleep 3; release tenants; return 0
    fi
    sleep 0.25
  done
}
contend() {
  local expected=$1 bound=$2 started output elapsed
  started=$(now_ms)
  if output=$(migrate cauce_contended 2>&1); then die "migration ran behind contended locks instead of failing on $expected"; fi
  elapsed=$(( $(now_ms) - started ))
  printf '%s\n' "$output" | grep -q "$expected" || die "the contended migration failed for another reason: $output"
  [ "$elapsed" -lt "$bound" ] || die "the $expected path took ${elapsed} ms"
  [ "$(psql_on cauce_contended -c "SELECT count(*) FROM schema_migrations WHERE version>'051_companies.sql'")" = 0 ] \
    || die 'a contended migration left later migrations applied'
  psql_on postgres -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname='cauce_contended' AND pid<>pg_backend_pid()" >/dev/null
  printf 'contended attempt failed on %s after %s ms\n' "$expected" "$elapsed"
}
# Data identical to the baseline except the columns 053 adds and the hosts its backfill registers.
assert_unchanged() {
  psql_on "$1" -c 'SELECT rehearsal.assert_unchanged()' >/dev/null || die "$2"
}

step "restoring $(basename "$DUMP") into PostgreSQL ($POSTGRES_IMAGE) on an internal network"
docker network create --internal "$NAME" >/dev/null
docker run -d --name "$NAME-pg" --network "$NAME" --tmpfs "/var/lib/postgresql/data:rw,size=$TMPFS_SIZE" \
  -e POSTGRES_USER=cauce -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=cauce "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 60); do docker exec "$NAME-pg" pg_isready -q -U cauce -d cauce && break; sleep 1; done
docker exec "$NAME-pg" pg_isready -q -U cauce -d cauce || die 'PostgreSQL did not become ready'
docker exec -i "$NAME-pg" pg_restore --list <"$DUMP" >/dev/null || die 'the dump is not a readable custom-format archive'
docker exec -i "$NAME-pg" pg_restore -U cauce -d cauce --no-owner --no-acl --exit-on-error <"$DUMP"
[ "$(psql_on cauce -c "SELECT max(version) FROM schema_migrations")" = 051_companies.sql ] || die 'the dump is not at schema 051'

step 'capturing the per-table baseline and the placed hosts nobody registered'
psql_on cauce <<'SQL'
CREATE SCHEMA rehearsal;
CREATE TABLE rehearsal.added(table_name text PRIMARY KEY, columns text[] NOT NULL);
INSERT INTO rehearsal.added SELECT table_name,'{company_id}' FROM unnest(ARRAY['rooms','console_users','agents','provider_accounts',
  'alias_routing_ceiling','agent_account_bindings','quota_window_state','console_agent_favorites','human_tenant_memberships',
  'fleet_hosts','fleet_operations']) table_name;
INSERT INTO rehearsal.added VALUES('config_revisions','{scope,company_id,actor_human_id,platform_override}'),
  ('audit_events','{company_id,actor_human_id}');
CREATE TABLE rehearsal.unregistered_hosts AS
  SELECT host_id FROM public.agents WHERE host_id IS NOT NULL EXCEPT SELECT host_id FROM public.fleet_hosts;
CREATE TABLE rehearsal.baseline(table_name text PRIMARY KEY, row_count bigint NOT NULL, digest text NOT NULL);
CREATE FUNCTION rehearsal.capture(p_table text, OUT row_count bigint, OUT digest text) LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($query$SELECT count(*),md5(COALESCE(string_agg(value::text,E'\n' ORDER BY value::text),''))
    FROM (SELECT to_jsonb(entry)-COALESCE((SELECT columns FROM rehearsal.added WHERE table_name=%L),'{}') AS value
      FROM public.%I entry WHERE %s) rows$query$,
    p_table,p_table,CASE WHEN p_table='fleet_hosts'
      THEN 'entry.host_id NOT IN (SELECT host_id FROM rehearsal.unregistered_hosts)' ELSE 'true' END) INTO row_count,digest;
END
$$;
CREATE FUNCTION rehearsal.assert_unchanged() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected record;
  observed record;
BEGIN
  FOR expected IN SELECT * FROM rehearsal.baseline LOOP
    SELECT * INTO observed FROM rehearsal.capture(expected.table_name);
    IF observed.row_count<>expected.row_count OR observed.digest<>expected.digest THEN
      RAISE EXCEPTION 'table % differs from the 051 baseline',expected.table_name;
    END IF;
  END LOOP;
END
$$;
INSERT INTO rehearsal.baseline SELECT tablename,captured.row_count,captured.digest FROM pg_tables
  CROSS JOIN LATERAL rehearsal.capture(tablename) captured
  WHERE schemaname='public' AND tablename NOT LIKE 'schema\_migration%';
SQL
printf 'placed hosts that V4.0 never registered: {%s}\n' \
  "$(psql_on cauce -c "SELECT COALESCE(string_agg(host_id,',' ORDER BY host_id),'') FROM rehearsal.unregistered_hosts")"
psql_on postgres -c 'CREATE DATABASE cauce_contended TEMPLATE cauce'

step 'migrating behind contended locks must fail fast without applying anything'
reader tenants; readers 1
contend 'lock timeout' 15000
# Short readers keep every single wait under lock_timeout, and statement_timeout still ends the lock phase.
reader tenants; reader rooms; readers 2
release_tenants_later & releaser=$!
contend 'statement timeout' 12000
wait "$releaser"
migrate cauce_contended >/dev/null
printf 'the retry without contention applied cleanly\n'

step 'migrating the clone'
# The migrator holds the exclusive schema lock for its whole transaction, so that span is the
# window during which live traffic would wait. A watcher in another database samples it.
window_file=$(mktemp)
psql_on postgres >"$window_file" <<'SQL' &
CREATE FUNCTION pg_temp.migration_window() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  watched integer;
  began timestamptz;
  last_seen timestamptz;
  deadline timestamptz := clock_timestamp()+interval '180 seconds';
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    SELECT activity.pid,activity.xact_start INTO watched,began FROM pg_stat_activity activity
      WHERE activity.datname='cauce' AND activity.xact_start IS NOT NULL LIMIT 1;
    EXIT WHEN watched IS NOT NULL;
    IF clock_timestamp()>deadline THEN RETURN -1; END IF;
    PERFORM pg_sleep(0.005);
  END LOOP;
  LOOP
    PERFORM pg_stat_clear_snapshot();
    last_seen := clock_timestamp();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=watched AND xact_start=began);
    PERFORM pg_sleep(0.005);
  END LOOP;
  RETURN ceil(extract(epoch FROM last_seen-began)*1000);
END
$$;
SELECT pg_temp.migration_window();
SQL
watcher=$!
sleep 1
started=$(now_ms); migrate cauce; applied_ms=$(( $(now_ms) - started ))
wait "$watcher"
window_ms=$(tail -n 1 "$window_file")
migrate cauce >/dev/null
printf 'migrator run %s ms; migration transaction %s ms (target < %s ms); the idle rerun reverified the schema\n' \
  "$applied_ms" "$window_ms" "$MAX_MS"
[ "$window_ms" -ge 0 ] && [ "$window_ms" -lt "$MAX_MS" ] || die "the migration transaction lasted ${window_ms} ms"

step 'asserting that Humanizar data is identical and authority was backfilled'
assert_unchanged cauce 'the migration changed legacy data'
psql_on cauce <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT host_id FROM agents WHERE host_id IS NOT NULL EXCEPT SELECT host_id FROM fleet_hosts)
    OR EXISTS (SELECT 1 FROM rehearsal.unregistered_hosts placed LEFT JOIN fleet_hosts host USING (host_id)
      WHERE host.company_id IS DISTINCT FROM 'humanizar' OR host.display_name<>placed.host_id) THEN
    RAISE EXCEPTION 'a placed host is not registered in humanizar';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgenabled='O' AND tgname IN ('cauce_oauth_membership_revision',
      'human_membership_preserved','agents_role_brief_journal','agent_runtime_key_reservation',
      'agents_role_template_coherence','fleet_operations_history'))<>6 THEN
    RAISE EXCEPTION 'a trigger paused by the backfill is not enabled again';
  END IF;
  IF EXISTS (SELECT 1 FROM company_admins WHERE role<>'admin' OR source<>'v4.0-hub-operator') THEN
    RAISE EXCEPTION 'the backfill granted more than the current people administrators';
  END IF;
  IF EXISTS (SELECT company_id,kind,tenant_id,room_id,actor_alias,principal_alias,recipient_alias,notify_handle
      FROM company_system_principals EXCEPT VALUES
        ('humanizar','gate_probe','Steven','grp.steven','kant','gate-probe',NULL::text,NULL::text),
        ('humanizar','director','Steven',NULL,NULL,'argos',NULL,NULL))
    OR (SELECT count(*) FROM company_system_principals)<>2
    OR EXISTS (SELECT company_id,role,tenant_id,alias FROM company_agent_roles EXCEPT VALUES
        ('humanizar','infra_escalation','Steven','zeus'),('humanizar','coordination','Steven','kant'))
    OR (SELECT count(*) FROM company_agent_roles)<>2 THEN
    RAISE EXCEPTION 'the Humanizar principals and roles are not exactly gate_probe, director, infra_escalation and coordination';
  END IF;
END
$$;
SQL
admins=$(psql_on cauce -c "SELECT COALESCE(string_agg(human_id::text,',' ORDER BY human_id::text),'') FROM company_admins")
expected_admins=$(printf '%s\n' "$EXPECTED" | tr ',' '\n' | sort | paste -sd,)
[ "$admins" = "$expected_admins" ] || die "company_admins is {$admins}, expected {$expected_admins}"
printf 'company_admins = {%s}; companies = {%s}; the four Humanizar principals and roles are seeded\n' \
  "$admins" "$(psql_on cauce -c "SELECT string_agg(id,',' ORDER BY id) FROM companies")"

psql_on postgres -c 'CREATE DATABASE cauce_unseeded TEMPLATE cauce'
if [ "${#OWNERS[@]}" -gt 0 ]; then
  step 'seeding the owners in one transaction'
  {
    printf 'BEGIN;\n'
    for owner in "${OWNERS[@]}"; do
      printf "SELECT cauce_platform_grant_admin('humanizar','%s','%s','owner','%s');\n" "${owner%%:*}" "${owner#*:}" "$ADMIN"
    done
    printf 'COMMIT;\n'
  } | psql_on cauce >/dev/null
  for owner in "${OWNERS[@]}"; do
    [ "$(psql_on cauce -c "SELECT company_role FROM cauce_company_authority('${owner%%:*}',NULL)")" = owner ] \
      || die "${owner%%:*} does not resolve as company owner"
  done
  if refusal=$(down_file 054_company_admins.sql | psql_on cauce -1 2>&1); then die 'down/054 accepted a database with owners'; fi
  printf '%s\n' "$refusal" | grep -q 'preserves company authority' || die "down/054 failed for another reason: $refusal"
  printf 'owners resolve as company_owner and down/054 refuses the seeded clone\n'
fi

step 'rolling the unseeded copy back to 051 and forward again'
for version in $(docker run --rm --entrypoint ls "$IMAGE" packages/store/migrations/down | sort -r); do
  [[ "$version" > 051_companies.sql ]] || continue
  down_file "$version" | psql_on cauce_unseeded -1 >/dev/null
done
[ "$(psql_on cauce_unseeded -c 'SELECT max(version) FROM schema_migrations')" = 051_companies.sql ] || die 'the rollback did not reach 051'
assert_unchanged cauce_unseeded 'the rollback did not restore the 051 data'
migrate cauce_unseeded >/dev/null
assert_unchanged cauce_unseeded 'reapplying after the rollback changed legacy data'
[ "$(psql_on cauce_unseeded -c "SELECT COALESCE(string_agg(human_id::text,',' ORDER BY human_id::text),'') FROM company_admins")" \
  = "$expected_admins" ] || die 'reapplying after the rollback backfilled other company administrators'
printf 'up, down and up again keep every legacy row; hosts registered by the backfill stay registered\n'

step 'rehearsal passed; the clone is destroyed on exit'
cat <<'EOF'
Still blocking before R1 (design §4.7):
  4. create the runtime logins on a clone with provision-db-roles.py, run gateway, dispatcher and
     telegram-bridge with them, run smoke.sh and confirm 0 errors with SQLSTATE 42501 in their logs;
  5. seed the owners on that clone and confirm Miguel's session resolves as company_owner.
EOF
