#!/usr/bin/env bash
# Rehearses every migration a runtime image bundles after the schema of a production dump, on a
# disposable clone: contended locks fail fast without applying anything, readers shaped like the
# gateway and the dispatcher metrics never hang it, the bundle commits within the target window,
# legacy rows stay identical, the owners resolve, every down returns to the dump
# schema and the bundle applies again. Added columns and tables are derived from the catalog, not
# listed. The clone lives on an internal network with its data on tmpfs and is destroyed on every
# exit; with --delete-dump the dump is deleted on every exit too, failures included.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: rehearse-migrations-clone.sh --dump FILE --image RUNTIME_IMAGE --postgres-image IMAGE@sha256:DIGEST
         --expected-admins UUID[,UUID...] [--platform-admin UUID[:EMAIL] --owner UUID:EMAIL [--owner UUID:EMAIL ...]]
         [--company ID] [--base-version VERSION] [--max-migration-ms MS] [--tmpfs-size SIZE] [--delete-dump]
--postgres-image is the exact digest production runs: CAUCE_POSTGRES_IMAGE in /etc/cauce-v3/prod.env.
--expected-admins are the people administrators the authority backfill must keep as company admins.
--platform-admin seeds platform_admins only when it is empty and the EMAIL confirms the person.
--base-version makes the rehearsal fail unless the dump is at that schema (default: whatever it is).
EOF
  exit 2
}
die() { printf 'rehearsal failed: %s\n' "$*" >&2; exit 1; }
step() { printf '== %s\n' "$*"; }

DUMP=; IMAGE=; EXPECTED=; ADMIN=; OWNERS=(); MAX_MS=2000; COMPANY=humanizar; BASE_VERSION=
POSTGRES_IMAGE=; TMPFS_SIZE=4g; DELETE_DUMP=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump) DUMP=${2:-}; shift 2 ;;
    --image) IMAGE=${2:-}; shift 2 ;;
    --expected-admins) EXPECTED=${2:-}; shift 2 ;;
    --platform-admin) ADMIN=${2:-}; shift 2 ;;
    --owner) OWNERS+=("${2:-}"); shift 2 ;;
    --company) COMPANY=${2:-}; shift 2 ;;
    --base-version) BASE_VERSION=${2:-}; shift 2 ;;
    --max-migration-ms) MAX_MS=${2:-}; shift 2 ;;
    --postgres-image) POSTGRES_IMAGE=${2:-}; shift 2 ;;
    --tmpfs-size) TMPFS_SIZE=${2:-}; shift 2 ;;
    --delete-dump) DELETE_DUMP=1; shift ;;
    *) usage ;;
  esac
done
NAME="cauce-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Passed to docker by name only, so the password never reaches a command line.
POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
PGPASSWORD=$POSTGRES_PASSWORD
export POSTGRES_PASSWORD PGPASSWORD
scratch=
cleanup() {
  docker rm -f "$NAME-pg" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
  [ -z "$scratch" ] || rm -rf -- "$scratch"
  [ -n "$DUMP" ] || return 0
  if [ "$DELETE_DUMP" = 1 ]; then rm -f -- "$DUMP"; else printf 'the dump holds production data and was left at %s\n' "$DUMP" >&2; fi
}
trap cleanup EXIT
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
EMAIL="[^:'[:space:]]+@[^:'[:space:]]+"
[ -r "$DUMP" ] && [ -n "$IMAGE" ] || usage
printf '%s\n' "$POSTGRES_IMAGE" | grep -Eqx '[^[:space:]]+@sha256:[0-9a-f]{64}' \
  || die '--postgres-image must pin the digest production runs'
printf '%s\n' "$EXPECTED" | grep -Eqx "$UUID(,$UUID)*" || die '--expected-admins needs full UUIDs'
printf '%s\n' "$MAX_MS" | grep -Eqx '[1-9][0-9]*' || die '--max-migration-ms must be a positive integer'
printf '%s\n' "$COMPANY" | grep -Eqx '[a-z][a-z0-9_-]{0,63}' || die '--company must be a company id'
[ -z "$BASE_VERSION" ] || printf '%s\n' "$BASE_VERSION" | grep -Eqx '[0-9]{3}_[a-z0-9_]+\.sql' \
  || die '--base-version must name a migration file'
ADMIN_ID=${ADMIN%%:*}; ADMIN_EMAIL=
[[ "$ADMIN" != *:* ]] || ADMIN_EMAIL=${ADMIN#*:}
if [ "${#OWNERS[@]}" -gt 0 ]; then
  printf '%s\n' "$ADMIN_ID" | grep -Eqx "$UUID" || die '--owner needs --platform-admin'
  [ -z "$ADMIN_EMAIL" ] || printf '%s\n' "$ADMIN_EMAIL" | grep -Eqx "$EMAIL" || die 'invalid --platform-admin email'
  for owner in "${OWNERS[@]}"; do printf '%s\n' "$owner" | grep -Eqx "$UUID:$EMAIL" || die "invalid --owner $owner"; done
fi

psql_on() { local database=$1; shift; docker exec -i "$NAME-pg" psql -X -q -At -v ON_ERROR_STOP=1 -U cauce -d "$database" "$@"; }
migrate() {
  docker run --rm --network "$NAME" -e NODE_ENV=test -e PGPASSWORD \
    -e "DATABASE_URL=postgresql://cauce@$NAME-pg:5432/$1" "$IMAGE" node packages/store/dist/migrate-cli.js
}
now_ms() { date +%s%3N; }
core_counts() {
  psql_on "$1" -c "SELECT format('tenants=%s rooms=%s agents=%s memberships=%s console_users=%s',
    (SELECT count(*) FROM tenants),(SELECT count(*) FROM rooms),(SELECT count(*) FROM agents),
    (SELECT count(*) FROM memberships),(SELECT count(*) FROM console_users))"
}
# Applies every down after the base, newest first, each in one transaction exactly as an operator would:
# each down deregisters its own version and refuses while a later one is still applied.
refused_version=; refused_output=
roll_back() {
  local database=$1 version output
  refused_version=; refused_output=
  for version in "${DOWNS[@]}"; do
    if ! output=$(psql_on "$database" -1 <"$migrations/down/$version" 2>&1 >/dev/null); then
      refused_version=$version; refused_output=$output; return 1
    fi
  done
}
# An open transaction keeps the lock of one statement on a table of cauce_contended (by default a read,
# ACCESS SHARE) until it is released.
reader() {
  docker exec -d -e "PGAPPNAME=rehearsal-$1" "$NAME-pg" psql -X -U cauce -d cauce_contended \
    -c 'BEGIN' -c "${2:-SELECT count(*) FROM $1}" -c 'SELECT pg_sleep(120)'
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
# Releases a table 3 s after the migration starts waiting for it.
release_later() {
  for _ in $(seq 120); do
    if [ "$(psql_on cauce_contended -c "SELECT count(*) FROM pg_locks WHERE NOT granted AND mode='AccessExclusiveLock'
        AND relation='public.$1'::regclass AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")" = 1 ]; then
      sleep 3; release "$1"; return 0
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
  [ "$(psql_on cauce_contended -c "SELECT count(*) FROM schema_migrations WHERE version>'$BASE'")" = 0 ] \
    || die 'a contended migration left later migrations applied'
  psql_on postgres -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname='cauce_contended' AND pid<>pg_backend_pid()" >/dev/null
  printf 'contended attempt failed on %s after %s ms\n' "$expected" "$elapsed"
}
# Autocommit readers shaped like the dispatcher metrics and the gateway (readiness probe, history, quotas,
# claims) run with pgbench on a copy of the clone while the bundle migrates it. A reader that dies of a
# deadlock shows in the pgbench failures; the migrator must apply or fail fast with nothing applied.
write_load() {
  docker exec -i "$NAME-pg" sh -c 'cat >/tmp/rehearsal-metrics.sql' <<'SQL'
SELECT lane,status,count(*) FROM jobs WHERE kind<>'context_write_quarantine' GROUP BY lane,status;
SELECT m.lane,d.status,count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id GROUP BY m.lane,d.status;
SELECT m.lane,d.status,count(*),COALESCE(extract(epoch FROM now()-min(d.created_at)),0) FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.status IN ('pending','retry','leased','accepted','started') GROUP BY m.lane,d.status;
SELECT COALESCE(j.lane,m.lane),count(*) FROM dead_letters dl LEFT JOIN jobs j ON j.id=dl.job_id LEFT JOIN deliveries d ON d.id=dl.delivery_id LEFT JOIN messages m ON m.id=d.message_id WHERE dl.resolved_at IS NULL GROUP BY 1;
SELECT m.lane,count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.status IN ('leased','accepted','started') AND d.claim_expires_at>now() GROUP BY m.lane;
SELECT count(*) FROM connection_leases WHERE lease_until>now();
SELECT m.lane,o.status,count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id WHERE o.kind='origin_relay' GROUP BY m.lane,o.status;
SQL
  docker exec -i "$NAME-pg" sh -c 'cat >/tmp/rehearsal-gateway.sql' <<'SQL'
SELECT a.alias,(SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.recipient_tenant=a.tenant_id AND d.recipient_alias=a.alias AND d.status IN ('leased','accepted','started')) FROM agents a LEFT JOIN connection_leases l ON l.tenant_id=a.tenant_id AND l.alias=a.alias;
SELECT count(*) FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id WHERE m.room_id IN (SELECT room_id FROM memberships WHERE enabled);
SELECT count(*) FROM quota_provider_reports pr JOIN quota_collections qc ON qc.id=pr.collection_id JOIN tenants t ON t.id=qc.collector_tenant;
SELECT id FROM deliveries WHERE status IN ('pending','retry') ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED;
SQL
}
loaded_output=; loaded_status=; loaded_ms=; loaded_readers=
migrate_under_load() {
  local started
  psql_on postgres -c 'CREATE DATABASE cauce_load TEMPLATE cauce'
  docker exec "$NAME-pg" pgbench -n -U cauce -d cauce_load -T 12 --max-tries=1 --failures-detailed "$@" >"$scratch/load" 2>&1 &
  local loader=$!
  sleep 2
  started=$(now_ms); loaded_status=0
  loaded_output=$(migrate cauce_load 2>&1) || loaded_status=$?
  loaded_ms=$(( $(now_ms) - started ))
  wait "$loader" || die "pgbench aborted a reader: $(tail -n 5 "$scratch/load")"
  loaded_readers=$(awk -F': ' '/^number of transactions actually processed/{t=$2} /^number of failed transactions/{f=$2}
    /^number of deadlock failures/{d=$2} END{printf "%s reader rounds, failed %s, deadlocks %s", t, (f==""?"0":f), (d==""?"0":d)}' "$scratch/load")
}
loaded_head() { psql_on cauce_load -c 'SELECT max(version) FROM schema_migrations'; }
reader_deadlocks() { awk -F': ' '/^number of deadlock failures/{split($2,n," "); print n[1]+0; f=1} END{if(!f) print 0}' "$scratch/load"; }
# Every baseline row must still be there, unchanged in its baseline columns; a new row is accepted only
# where a migration of the bundle documents it (rehearsal.tolerated), and a baseline column may be gone
# only where one documents the drop and the schema still derives its value (rehearsal.dropped).
compare() {
  local output
  output=$(psql_on "$1" -c "SELECT rehearsal.compare('$2')" 2>&1) || die "$3: $output"
  printf '%s\n' "$output"
}
catalog_drift() {
  psql_on "$1" -c "(SELECT '+ '||line FROM rehearsal.catalog() line EXCEPT SELECT '+ '||line FROM rehearsal.baseline_catalog)
    UNION ALL (SELECT '- '||line FROM rehearsal.baseline_catalog EXCEPT SELECT '- '||line FROM rehearsal.catalog() line) ORDER BY 1"
}

scratch=$(mktemp -d)
step "reading the migration bundle of $IMAGE"
container=$(docker create "$IMAGE")
docker cp "$container:$(docker image inspect --format '{{.Config.WorkingDir}}' "$IMAGE")/packages/store/migrations" \
  "$scratch/migrations" >/dev/null
docker rm "$container" >/dev/null
migrations=$scratch/migrations

step "restoring $(basename "$DUMP") into PostgreSQL ($POSTGRES_IMAGE) on an internal network"
docker network create --internal "$NAME" >/dev/null
docker run -d --name "$NAME-pg" --network "$NAME" --tmpfs "/var/lib/postgresql/data:rw,size=$TMPFS_SIZE" \
  -e POSTGRES_USER=cauce -e POSTGRES_PASSWORD -e POSTGRES_DB=cauce "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 60); do docker exec "$NAME-pg" pg_isready -q -U cauce -d cauce && break; sleep 1; done
docker exec "$NAME-pg" pg_isready -q -U cauce -d cauce || die 'PostgreSQL did not become ready'
docker exec -i "$NAME-pg" pg_restore --list <"$DUMP" >/dev/null || die 'the dump is not a readable custom-format archive'
docker exec -i "$NAME-pg" pg_restore -U cauce -d cauce --no-owner --no-acl --exit-on-error <"$DUMP"
BASE=$(psql_on cauce -c 'SELECT max(version) FROM schema_migrations')
[ -z "$BASE_VERSION" ] || [ "$BASE" = "$BASE_VERSION" ] || die "the dump is at schema $BASE, not $BASE_VERSION"
PENDING=(); DOWNS=()
for file in "$migrations"/[0-9]*.sql; do
  version=$(basename "$file")
  [[ "$version" > "$BASE" ]] || continue
  [ -f "$migrations/down/$version" ] || die "$version has no down migration"
  PENDING+=("$version")
done
[ "${#PENDING[@]}" -gt 0 ] || die "the image bundles nothing after $BASE"
for (( index=${#PENDING[@]}-1; index>=0; index-- )); do
  DOWNS+=("${PENDING[index]}")
done
printf 'dump schema %s; bundle %s..%s (%s migrations)\n' "$BASE" "${PENDING[0]}" "${PENDING[-1]}" "${#PENDING[@]}"

step 'capturing the baseline: catalog, rows and the placed hosts nobody registered'
psql_on cauce <<'SQL'
CREATE SCHEMA rehearsal;
CREATE FUNCTION rehearsal.catalog() RETURNS SETOF text LANGUAGE sql STABLE AS $$
  SELECT format('relation %s %s',c.relname,c.relkind) FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S')
  UNION ALL
  SELECT format('column %s.%s %s notnull=%s generated=%s default=%s',c.relname,a.attname,
      format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid))
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('constraint %s %s %s',c.conrelid::regclass,c.conname,pg_get_constraintdef(c.oid))
    FROM pg_constraint c WHERE c.connamespace='public'::regnamespace
  UNION ALL
  SELECT format('index %s',pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE c.relnamespace='public'::regnamespace
  UNION ALL
  SELECT format('trigger %s enabled=%s %s',t.tgrelid::regclass,t.tgenabled,pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
  UNION ALL
  SELECT format('function %s definer=%s volatility=%s config=%s source=%s',p.oid::regprocedure,p.prosecdef,
      p.provolatile,p.proconfig,md5(p.prosrc))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
$$;
CREATE TABLE rehearsal.baseline_catalog AS SELECT line FROM rehearsal.catalog() line;
-- Legacy tables, their columns and one hash per row. Later columns are dropped from the comparison.
CREATE TABLE rehearsal.baseline_tables AS SELECT c.relname::text AS table_name FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relispartition
    AND c.relname NOT LIKE 'schema\_migration%';
CREATE TABLE rehearsal.baseline_columns AS SELECT c.relname::text AS table_name,a.attname::text AS column_name,
    format_type(a.atttypid,a.atttypmod) AS column_type
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN rehearsal.baseline_tables t ON t.table_name=c.relname
  WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped;
CREATE FUNCTION rehearsal.legacy_rows(p_table text) RETURNS TABLE(row_hash uuid,value jsonb) LANGUAGE plpgsql AS $$
DECLARE
  added text[];
BEGIN
  SELECT COALESCE(array_agg(a.attname::text),'{}') INTO added FROM pg_attribute a
    WHERE a.attrelid=format('public.%I',p_table)::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND NOT EXISTS (SELECT 1 FROM rehearsal.baseline_columns b WHERE b.table_name=p_table AND b.column_name=a.attname);
  RETURN QUERY EXECUTE format('SELECT md5(projected.value::text)::uuid,projected.value
    FROM (SELECT to_jsonb(entry)-$1 AS value FROM public.%I entry) projected',p_table) USING added;
END
$$;
CREATE TABLE rehearsal.baseline_rows AS SELECT t.table_name,r.row_hash FROM rehearsal.baseline_tables t
  CROSS JOIN LATERAL rehearsal.legacy_rows(t.table_name) r;
CREATE INDEX ON rehearsal.baseline_rows(table_name,row_hash);
-- The baseline columns a migration of the bundle drops on purpose: gone exactly while that version is
-- applied, back with their type and values once its down ran. Every other column of every baseline row
-- stays identical, and the schema must still derive the dropped value: derived is an expression over a
-- baseline row (value) that is NULL for the rows it does not cover and must equal value->>column_name for
-- every row it covers, at least one.
CREATE TABLE rehearsal.dropped(table_name text,column_name text,version text NOT NULL,derived text NOT NULL,
  reason text NOT NULL,PRIMARY KEY(table_name,column_name));
INSERT INTO rehearsal.dropped VALUES
  ('human_tenant_memberships','role','081_membresia_rol_derivado.sql',$r$(SELECT person.role FROM public.console_users person
      WHERE person.id=(value->>'human_id')::uuid AND person.tenant_id=value->>'tenant_id')$r$,
    '081 derives the role of each home membership from console_users.role');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rehearsal.dropped d WHERE NOT EXISTS (SELECT 1 FROM rehearsal.baseline_columns b
      WHERE b.table_name=d.table_name AND b.column_name=d.column_name)) THEN
    RAISE EXCEPTION 'rehearsal.dropped names a column the baseline does not have';
  END IF;
END
$$;
-- The whole baseline rows of the tables that lose a column, to compare the rest and check the derivation.
CREATE TABLE rehearsal.baseline_values AS SELECT t.table_name,r.value FROM (SELECT DISTINCT table_name FROM rehearsal.dropped) t
  CROSS JOIN LATERAL rehearsal.legacy_rows(t.table_name) r;
CREATE TABLE rehearsal.unregistered_hosts AS
  SELECT host_id FROM public.agents WHERE host_id IS NOT NULL EXCEPT SELECT host_id FROM public.fleet_hosts;
CREATE TABLE rehearsal.backfilled_directors(tenant_id text,alias text,PRIMARY KEY(tenant_id,alias));
-- The rows a migration of the bundle adds to a legacy table on purpose, per stage.
CREATE TABLE rehearsal.tolerated(table_name text,stage text,rule text NOT NULL,reason text NOT NULL,
  PRIMARY KEY(table_name,stage));
INSERT INTO rehearsal.tolerated VALUES
  ('fleet_hosts','migrated',$r$value->>'host_id' IN (SELECT host_id FROM rehearsal.unregistered_hosts)$r$,
    '053 registers the hosts V4.0 placed agents on'),
  ('fleet_hosts','rolled-back',$r$value->>'host_id' IN (SELECT host_id FROM rehearsal.unregistered_hosts)$r$,
    'down/053 keeps the hosts the backfill registered'),
  ('role_policies','migrated',$r$value->>'role'='context_broker'$r$,'063 adds the route-only context broker role'),
  ('harness_definitions','migrated',$r$value->>'id' IN ('grok','muse','fake2')$r$,'073 seeds the grok, muse and fake2 harnesses'),
  ('agents','migrated',$r$(value->>'tenant_id',value->>'alias') IN (SELECT tenant_id,alias FROM rehearsal.backfilled_directors)$r$,
    '063 creates a context director for each enabled company without one'),
  ('memberships','migrated',$r$(value->>'tenant_id',value->>'alias') IN (SELECT tenant_id,alias FROM rehearsal.backfilled_directors)$r$,
    '063 joins each backfilled director to a hub room as context broker');
CREATE FUNCTION rehearsal.compare(p_stage text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  legacy record;
  rule text;
  reason text;
  documented record;
  dropped text[];
  covered bigint;
  underived bigint;
  missing bigint;
  added bigint;
  accepted bigint;
  identical bigint := 0;
  failures text[] := '{}';
BEGIN
  FOR legacy IN SELECT t.table_name,(SELECT count(*) FROM rehearsal.baseline_rows r WHERE r.table_name=t.table_name) AS row_count
      FROM rehearsal.baseline_tables t ORDER BY t.table_name LOOP
    IF to_regclass(format('public.%I',legacy.table_name)) IS NULL THEN
      failures := failures||format('%s was dropped',legacy.table_name); CONTINUE;
    END IF;
    SELECT COALESCE(array_agg(d.column_name ORDER BY d.column_name),'{}') INTO dropped FROM rehearsal.dropped d
      WHERE d.table_name=legacy.table_name AND EXISTS (SELECT 1 FROM public.schema_migrations m WHERE m.version=d.version);
    IF EXISTS (SELECT 1 FROM rehearsal.baseline_columns b WHERE b.table_name=legacy.table_name AND b.column_name<>ALL(dropped)
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=format('public.%I',legacy.table_name)::regclass AND a.attnum>0
          AND NOT a.attisdropped AND a.attname=b.column_name AND format_type(a.atttypid,a.atttypmod)=b.column_type)) THEN
      failures := failures||format('%s lost or retyped a baseline column',legacy.table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=format('public.%I',legacy.table_name)::regclass AND a.attnum>0
        AND NOT a.attisdropped AND a.attname=ANY(dropped)) THEN
      failures := failures||format('%s kept a column documented as dropped',legacy.table_name);
    END IF;
    SELECT t.rule,t.reason INTO rule,reason FROM rehearsal.tolerated t WHERE t.table_name=legacy.table_name AND t.stage=p_stage;
    -- A documented drop compares the baseline rows without the dropped columns; every other row compares whole.
    EXECUTE format($query$
      WITH current_rows AS (SELECT row_hash,value,row_number() OVER (PARTITION BY row_hash) AS n FROM rehearsal.legacy_rows(%L)),
        baseline AS (SELECT row_hash,row_number() OVER (PARTITION BY row_hash) AS n FROM (%s) projected),
        added AS (SELECT current_rows.value FROM current_rows LEFT JOIN baseline USING (row_hash,n) WHERE baseline.row_hash IS NULL)
      SELECT (SELECT count(*) FROM baseline LEFT JOIN current_rows USING (row_hash,n) WHERE current_rows.row_hash IS NULL),
        (SELECT count(*) FROM added),(SELECT count(*) FROM added WHERE %s)$query$,
      legacy.table_name,
      CASE WHEN cardinality(dropped)=0 THEN format('SELECT row_hash FROM rehearsal.baseline_rows WHERE table_name=%L',legacy.table_name)
        ELSE format('SELECT md5((value-%L::text[])::text)::uuid AS row_hash FROM rehearsal.baseline_values WHERE table_name=%L',
          dropped,legacy.table_name) END,
      COALESCE(rule,'false')) INTO missing,added,accepted;
    FOR documented IN SELECT d.column_name,d.derived,d.reason FROM rehearsal.dropped d
        WHERE d.table_name=legacy.table_name AND d.column_name=ANY(dropped) ORDER BY d.column_name LOOP
      EXECUTE format($query$
        SELECT count(*) FILTER (WHERE derived IS NOT NULL),count(*) FILTER (WHERE derived IS DISTINCT FROM value->>%L AND derived IS NOT NULL)
          FROM (SELECT value,(%s)::text AS derived FROM rehearsal.baseline_values WHERE table_name=%L) baseline$query$,
        documented.column_name,documented.derived,legacy.table_name) INTO covered,underived;
      IF underived>0 THEN
        failures := failures||format('%s: %s of %s rows covered by the drop of %s no longer derive their baseline value',
          legacy.table_name,underived,covered,documented.column_name);
      ELSIF covered=0 AND legacy.row_count>0 THEN
        failures := failures||format('%s: no baseline row is covered by the derivation of the dropped %s',
          legacy.table_name,documented.column_name);
      ELSE
        RETURN NEXT format('  %s: -%s, %s of %s baseline rows derive it again (%s)',legacy.table_name,documented.column_name,
          covered,legacy.row_count,documented.reason);
      END IF;
    END LOOP;
    IF missing>0 THEN failures := failures||format('%s: %s baseline rows changed or disappeared',legacy.table_name,missing); END IF;
    IF added>accepted THEN failures := failures||format('%s: %s rows nobody documented',legacy.table_name,added-accepted); END IF;
    IF accepted>0 THEN RETURN NEXT format('  %s: +%s rows (%s)',legacy.table_name,accepted,reason); END IF;
    identical := identical+legacy.row_count-missing;
  END LOOP;
  IF cardinality(failures)>0 THEN RAISE EXCEPTION '%',array_to_string(failures,'; '); END IF;
  RETURN NEXT format('  %s legacy tables, %s baseline rows identical in their baseline columns',
    (SELECT count(*) FROM rehearsal.baseline_tables),identical);
END
$$;
SQL
printf 'baseline: %s legacy tables, %s rows; %s\n' "$(psql_on cauce -c 'SELECT count(*) FROM rehearsal.baseline_tables')" \
  "$(psql_on cauce -c 'SELECT count(*) FROM rehearsal.baseline_rows')" "$(core_counts cauce)"
printf 'placed hosts that V4.0 never registered: {%s}\n' \
  "$(psql_on cauce -c "SELECT COALESCE(string_agg(host_id,',' ORDER BY host_id),'') FROM rehearsal.unregistered_hosts")"
psql_on postgres -c 'CREATE DATABASE cauce_contended TEMPLATE cauce'

step 'migrating behind contended locks must fail fast without applying anything'
# The migrator takes every table lock of the bundle before the first migration, each wait under a 5 s
# lock_timeout: an open transaction that read tenants or deliveries, or wrote connection_leases, stops it.
for table in tenants deliveries; do
  reader "$table"; readers 1
  contend 'lock timeout' 15000
done
reader connection_leases 'UPDATE connection_leases SET lease_until=lease_until WHERE false'; readers 1
contend 'lock timeout' 15000
# The pre-lock is one statement: 6 s statement_timeout for all its waits. Readers on two tables it locks
# exclusively, the first released 3 s after the wait starts, keep each wait under lock_timeout while
# the whole phase overruns.
reader agent_account_bindings; reader rooms; readers 2
release_later agent_account_bindings & releaser=$!
contend 'statement timeout' 12000
wait "$releaser"
# 063 takes SHARE ROW EXCLUSIVE on connection_leases, which ACCESS SHARE does not conflict with.
reader connection_leases; readers 1
migrate cauce_contended >/dev/null
printf 'with an open reader of connection_leases and no other contention the bundle applied cleanly\n'
release connection_leases
psql_on postgres -c 'DROP DATABASE cauce_contended WITH (FORCE)'

step 'migrating while readers like the gateway and the dispatcher metrics run'
write_load
for script in metrics gateway; do
  docker exec "$NAME-pg" pgbench -n -U cauce -d cauce -t 1 -f "/tmp/rehearsal-$script.sql" >/dev/null 2>&1 \
    || die "the $script readers do not run on the dump schema"
done
migrate_under_load -c 6 -j 3 -f /tmp/rehearsal-metrics.sql
[ "$loaded_status" = 0 ] || die "the bundle failed under the dispatcher metrics: $loaded_output"
[ "$(loaded_head)" = "${PENDING[-1]}" ] && [ "$(reader_deadlocks)" = 0 ] || die "deadlock or partial bundle under the dispatcher metrics: $loaded_readers"
printf 'dispatcher metrics, 6 clients: applied in %s ms; %s\n' "$loaded_ms" "$loaded_readers"
psql_on postgres -c 'DROP DATABASE cauce_load WITH (FORCE)'
migrate_under_load -c 8 -j 4 -f /tmp/rehearsal-metrics.sql -f /tmp/rehearsal-gateway.sql
[ "$loaded_ms" -lt 20000 ] || die "the bundle took ${loaded_ms} ms under the mixed readers"
if [ "$loaded_status" = 0 ]; then
  [ "$(loaded_head)" = "${PENDING[-1]}" ] || die 'the bundle applied partially under the mixed readers'
  printf 'gateway and metrics, 8 clients unthrottled: applied in %s ms; %s\n' "$loaded_ms" "$loaded_readers"
else
  printf '%s\n' "$loaded_output" | grep -Eq 'lock timeout|deadlock detected' || die "the bundle failed under load for another reason: $loaded_output"
  [ "$(loaded_head)" = "$BASE" ] || die 'a failed bundle left migrations applied under load'
  printf 'gateway and metrics, 8 clients unthrottled: failed clean in %s ms (%s); %s\n' "$loaded_ms" \
    "$(printf '%s\n' "$loaded_output" | grep -Eo 'lock timeout|deadlock detected' | head -n 1)" "$loaded_readers"
fi
psql_on postgres -c 'DROP DATABASE cauce_load WITH (FORCE)'
migrate_under_load -c 2 -j 2 -R 5 -f /tmp/rehearsal-metrics.sql -f /tmp/rehearsal-gateway.sql
[ "$loaded_status" = 0 ] && [ "$(loaded_head)" = "${PENDING[-1]}" ] || die "the bundle did not apply under light load: $loaded_output"
[ "$(reader_deadlocks)" = 0 ] || die "a reader deadlocked under light load: $loaded_readers"
printf 'light load (5 reader rounds/s): applied in %s ms; %s\n' "$loaded_ms" "$loaded_readers"
psql_on postgres -c 'DROP DATABASE cauce_load WITH (FORCE)'

step 'migrating the clone'
# The migrator holds the exclusive schema lock for its whole transaction, so that span is the
# window during which live traffic would wait. A watcher in another database samples it; only client
# backends count, since autovacuum keeps analyzing the fresh restore in transactions of its own.
psql_on postgres >"$scratch/window" <<'SQL' &
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
      WHERE activity.datname='cauce' AND activity.backend_type='client backend' AND activity.xact_start IS NOT NULL LIMIT 1;
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
window_ms=$(tail -n 1 "$scratch/window")
migrate cauce >/dev/null
printf 'migrator run %s ms; migration transaction %s ms (target < %s ms); the idle rerun reverified the schema\n' \
  "$applied_ms" "$window_ms" "$MAX_MS"
[ "$window_ms" -ge 0 ] && [ "$window_ms" -lt "$MAX_MS" ] || die "the migration transaction lasted ${window_ms} ms"
[ "$(psql_on cauce -c 'SELECT max(version) FROM schema_migrations')" = "${PENDING[-1]}" ] || die 'the bundle did not apply entirely'

step 'asserting that legacy data is identical and the backfills did what the bundle documents'
psql_on cauce -c "INSERT INTO rehearsal.backfilled_directors SELECT tenant_id,principal_alias FROM company_system_principals
  WHERE delivery_source_only ON CONFLICT DO NOTHING"
compare cauce migrated 'the migration changed legacy data'
printf '  added: %s\n' "$(psql_on cauce -c "SELECT format('%s columns on %s legacy tables, %s new relations',
  count(*) FILTER (WHERE line LIKE 'column %' AND split_part(split_part(line,' ',2),'.',1) IN (SELECT table_name FROM rehearsal.baseline_tables)),
  count(DISTINCT split_part(split_part(line,' ',2),'.',1)) FILTER (WHERE line LIKE 'column %'
    AND split_part(split_part(line,' ',2),'.',1) IN (SELECT table_name FROM rehearsal.baseline_tables)),
  count(*) FILTER (WHERE line LIKE 'relation %'))
  FROM (SELECT line FROM rehearsal.catalog() line EXCEPT SELECT line FROM rehearsal.baseline_catalog) added")"
printf '  %s\n' "$(core_counts cauce)"
psql_on cauce >/dev/null <<SQL
SET client_min_messages=warning;
DO \$\$
BEGIN
  -- Every trigger a backfill paused (053) is enabled again: no trigger is disabled that was not before.
  IF EXISTS (SELECT line FROM rehearsal.catalog() line WHERE line ~ '^trigger [^ ]+ enabled=D '
      EXCEPT SELECT line FROM rehearsal.baseline_catalog) THEN
    RAISE EXCEPTION 'a trigger paused by a backfill is not enabled again';
  END IF;
  -- 053: every placed host is registered in the company of its agents, under its own name.
  IF EXISTS (SELECT 1 FROM agents agent LEFT JOIN fleet_hosts host USING (host_id)
      WHERE agent.host_id IS NOT NULL AND host.company_id IS DISTINCT FROM agent.company_id)
    OR EXISTS (SELECT 1 FROM rehearsal.unregistered_hosts placed JOIN fleet_hosts host USING (host_id)
      WHERE host.display_name<>placed.host_id) THEN
    RAISE EXCEPTION 'a placed host is not registered in the company of its agents';
  END IF;
  -- 054 keeps the current people administrators as admins and nothing more; 055 versions each of them.
  IF EXISTS (SELECT 1 FROM company_admins WHERE role<>'admin' OR source<>'v4.0-hub-operator')
    OR EXISTS (SELECT company_id,human_id,version FROM company_admins
      EXCEPT SELECT company_id,human_id,version FROM company_admin_versions) THEN
    RAISE EXCEPTION 'the authority backfill granted more than the current people administrators';
  END IF;
  -- 054 seeds the Humanizar principals and roles; 063 adds a source-only director to any enabled company
  -- still without one, so every enabled company ends with exactly one director.
  IF EXISTS (SELECT company_id,kind,tenant_id,room_id,actor_alias,principal_alias,recipient_alias,notify_handle
      FROM company_system_principals WHERE NOT delivery_source_only EXCEPT VALUES
        ('humanizar','gate_probe','Steven','grp.steven','kant','gate-probe',NULL::text,NULL::text),
        ('humanizar','director','Steven',NULL,NULL,'argos',NULL,NULL))
    OR (SELECT count(*) FROM company_system_principals WHERE NOT delivery_source_only)<>2
    OR EXISTS (SELECT 1 FROM company_system_principals WHERE delivery_source_only AND kind<>'director')
    OR EXISTS (SELECT 1 FROM companies company WHERE company.enabled AND company.retired_at IS NULL
      AND (SELECT count(*) FROM company_system_principals principal
        WHERE principal.company_id=company.id AND principal.kind='director')<>1)
    OR EXISTS (SELECT company_id,role,tenant_id,alias FROM company_agent_roles EXCEPT VALUES
        ('humanizar','infra_escalation','Steven','zeus'),('humanizar','coordination','Steven','kant'))
    OR (SELECT count(*) FROM company_agent_roles)<>2 THEN
    RAISE EXCEPTION 'the principals and roles are not the Humanizar seeds plus one director per company';
  END IF;
END
\$\$;
-- A restore made with --no-acl loses every grant; the replay of 052 and 065 must restore them.
SELECT cauce_apply_runtime_grants();
DO \$\$
BEGIN
  IF NOT has_table_privilege('cauce_runtime','public.agents','SELECT,INSERT,UPDATE,DELETE')
    OR NOT has_table_privilege('cauce_runtime','public.company_admins','SELECT')
    OR has_table_privilege('cauce_runtime','public.company_admins','INSERT')
    OR NOT has_function_privilege('cauce_runtime','public.cauce_company_authority(uuid,text)','EXECUTE')
    OR NOT has_function_privilege('cauce_runtime','public.cauce_ensure_context_director_anchor(text,text,text,bigint,text)','EXECUTE') THEN
    RAISE EXCEPTION 'cauce_apply_runtime_grants() did not replay the runtime grants';
  END IF;
END
\$\$;
SQL
admins=$(psql_on cauce -c "SELECT COALESCE(string_agg(human_id::text,',' ORDER BY human_id::text),'') FROM company_admins")
expected_admins=$(printf '%s\n' "$EXPECTED" | tr ',' '\n' | sort | paste -sd,)
[ "$admins" = "$expected_admins" ] || die "company_admins is {$admins}, expected {$expected_admins}"
printf 'company_admins = {%s}; companies = {%s}; directors = {%s}; the runtime grants replay\n' "$admins" \
  "$(psql_on cauce -c "SELECT string_agg(id,',' ORDER BY id) FROM companies")" \
  "$(psql_on cauce -c "SELECT string_agg(company_id||':'||principal_alias||CASE WHEN delivery_source_only THEN ' (063)' ELSE '' END,','
    ORDER BY company_id) FROM company_system_principals WHERE kind='director'")"
psql_on cauce -c 'SELECT line FROM rehearsal.catalog() line ORDER BY 1' >"$scratch/catalog.migrated"
migrated_counts=$(core_counts cauce)
psql_on postgres -c 'CREATE DATABASE cauce_unseeded TEMPLATE cauce'

if [ "${#OWNERS[@]}" -gt 0 ]; then
  step "seeding the platform administrator and the owners of $COMPANY in one transaction"
  {
    printf 'BEGIN;\n'
    if [ -n "$ADMIN_EMAIL" ]; then
      printf "INSERT INTO platform_admins(human_id) SELECT person.id FROM console_users person
  WHERE NOT EXISTS (SELECT 1 FROM platform_admins) AND person.id='%s' AND person.email_normalized=lower(btrim('%s'))
    AND person.active AND person.role='operator' AND person.company_id='%s';\n" "$ADMIN_ID" "$ADMIN_EMAIL" "$COMPANY"
    fi
    printf "DO \$\$ BEGIN
  IF (SELECT count(*) FROM platform_admins)<>1 OR NOT EXISTS (SELECT 1 FROM platform_admins WHERE human_id='%s') THEN
    RAISE EXCEPTION 'platform_admins must be exactly the confirmed platform administrator';
  END IF;
END \$\$;\n" "$ADMIN_ID"
    for owner in "${OWNERS[@]}"; do
      printf "SELECT cauce_platform_grant_admin('%s','%s','%s','owner','%s');\n" "$COMPANY" "${owner%%:*}" "${owner#*:}" "$ADMIN_ID"
    done
    printf 'COMMIT;\n'
  } | psql_on cauce >/dev/null
  expected_owners=$(for owner in "${OWNERS[@]}"; do printf '%s\n' "${owner%%:*}"; done | sort | paste -sd,)
  [ "$(psql_on cauce -c "SELECT string_agg(human_id::text,',' ORDER BY human_id::text) FROM company_admins
    WHERE company_id='$COMPANY' AND role='owner'")" = "$expected_owners" ] || die "the owners of $COMPANY are not {$expected_owners}"
  for owner in "${OWNERS[@]}"; do
    [ "$(psql_on cauce -c "SELECT company_role||':'||company_enabled FROM cauce_company_authority('${owner%%:*}',NULL)")" = owner:true ] \
      || die "${owner%%:*} does not resolve as company owner"
  done
  [ "$(psql_on cauce -c "SELECT platform_admin FROM cauce_company_authority('$ADMIN_ID',NULL)")" = t ] \
    || die "$ADMIN_ID does not resolve as platform administrator"
  psql_on cauce -c "SELECT cauce_assert_qualified_company_owner('$COMPANY')" >/dev/null \
    || die "$COMPANY has no qualified owner for the company administration of 055"
  [ "$(psql_on cauce -c "SELECT count(*) FROM platform_authority_events WHERE action='admin.grant' AND company_id='$COMPANY'")" \
    = "${#OWNERS[@]}" ] || die 'the owner grants were not journaled'
  [ "$(core_counts cauce)" = "$migrated_counts" ] || die 'seeding the owners changed tenants, rooms, agents, memberships or people'
  printf 'platform_admins = {%s}; owners of %s = {%s} resolve as company_owner; %s\n' \
    "$(psql_on cauce -c "SELECT string_agg(human_id::text,',' ORDER BY human_id::text) FROM platform_admins")" \
    "$COMPANY" "$expected_owners" "$(core_counts cauce)"
  psql_on postgres -c 'CREATE DATABASE cauce_seeded TEMPLATE cauce'
  if roll_back cauce_seeded; then die 'the downs removed the seeded company authority'; fi
  printf '%s\n' "$refused_output" | grep -q 'preserves company authority' \
    || die "down/$refused_version failed for another reason: $refused_output"
  printf 'down/%s refuses to roll the seeded clone back past its owners\n' "$refused_version"
  psql_on postgres -c 'DROP DATABASE cauce_seeded'
fi

step "rolling the unseeded copy back to $BASE and forward again"
roll_back cauce_unseeded || die "down/$refused_version failed: $refused_output"
[ "$(psql_on cauce_unseeded -c 'SELECT max(version) FROM schema_migrations')" = "$BASE" ] || die "the rollback did not reach $BASE"
[ "$(psql_on cauce_unseeded -c "SELECT count(*) FROM schema_migration_ledger WHERE version>'$BASE'")" = 0 ] \
  || die 'the rollback left later versions in the ledger'
drift=$(catalog_drift cauce_unseeded)
[ -z "$drift" ] || die "the rollback did not restore the $BASE catalog:
$drift"
compare cauce_unseeded rolled-back 'the rollback did not restore the baseline data'
printf '  %s\n' "$(core_counts cauce_unseeded)"
migrate cauce_unseeded >/dev/null
psql_on cauce_unseeded -c "INSERT INTO rehearsal.backfilled_directors SELECT tenant_id,principal_alias FROM company_system_principals
  WHERE delivery_source_only ON CONFLICT DO NOTHING"
compare cauce_unseeded migrated 'reapplying after the rollback changed legacy data'
psql_on cauce_unseeded -c 'SELECT line FROM rehearsal.catalog() line ORDER BY 1' | diff -u "$scratch/catalog.migrated" - >&2 \
  || die 'reapplying after the rollback produced another catalog'
[ "$(psql_on cauce_unseeded -c "SELECT COALESCE(string_agg(human_id::text,',' ORDER BY human_id::text),'') FROM company_admins")" \
  = "$expected_admins" ] || die 'reapplying after the rollback backfilled other company administrators'
[ "$(core_counts cauce_unseeded)" = "$migrated_counts" ] || die 'reapplying after the rollback changed the core counts'
printf 'up, down to %s and up again keep every legacy row and reproduce the same catalog\n' "$BASE"

step 'rehearsal passed; the clone is destroyed on exit'
cat <<'EOF'
Not covered here: runtime logins (provision-db-roles.py) with gateway, dispatcher and telegram-bridge
on a clone, smoke.sh with 0 errors with SQLSTATE 42501, and GET /v3/auth/session on a running stack.
EOF
