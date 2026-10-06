from __future__ import annotations

import hashlib
import json
import os
import pathlib
from urllib.parse import parse_qs, urlsplit

from descriptor import InstanceError, canonical
from resources import inspect_resource, run, verify_owned_resources

GLOBAL_TABLES = {"role_policies", "harness_definitions", "agent_chain_policies"}
EXCLUDED_TABLES = {"schema_migrations", "schema_migration_ledger", "schema_migration_verifications", "cauce_instance_ownership", "cauce_baseline_ownership"}


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def psql(container, database, sql):
    return run(["docker", "exec", "-i", container, "psql", "-XAtq", "-U", "cauce", "-d", database,
                "--set=ON_ERROR_STOP=1"], data=sql)


def validate_database_reference(plan):
    path = pathlib.Path(plan["descriptor"]["identityRefs"]["secretFiles"]["CAUCE_DATABASE_URL_SECRET_PATH"])
    try:
        url = urlsplit(path.read_text().strip())
        params = parse_qs(url.query)
        valid = url.scheme in {"postgres", "postgresql"} and url.hostname == "postgres" and url.port in {None, 5432}
        valid = valid and url.username == "cauce" and url.path == "/cauce" and bool(url.password)
        valid = valid and params.get("sslmode") == ["verify-full"] and params.get("sslrootcert") == ["/run/secrets/postgres_ca"]
        valid = valid and set(params) <= {"sslmode", "sslrootcert"}
        if not valid:
            raise InstanceError("database reference must target the owned Compose postgres with verified TLS")
    except (OSError, ValueError) as exc:
        raise InstanceError("database reference is unreadable or invalid") from exc


def table_columns(container, database):
    sql = """
    SELECT COALESCE(jsonb_object_agg(tablename, columns),'{}'::jsonb) FROM (
      SELECT table_name AS tablename, jsonb_agg(column_name ORDER BY ordinal_position)
        FILTER (WHERE data_type NOT IN ('timestamp with time zone','timestamp without time zone')) AS columns
      FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')
      GROUP BY table_name
    ) AS tables;
    """
    return {key: columns for key, columns in json.loads(psql(container, database, sql)).items() if key not in EXCLUDED_TABLES}


def snapshot_query(columns):
    entries = []
    for table, names in sorted(columns.items()):
        if not all(name.replace("_", "").isalnum() for name in [table, *names]):
            raise InstanceError("unexpected database identifier")
        row = "jsonb_build_object(" + ",".join(literal(name) + ', "' + name + '"' for name in names) + ")"
        entries.append("(" + literal(table) + ", (SELECT COALESCE(jsonb_agg(data ORDER BY data::text),'[]'::jsonb) FROM (SELECT " + row + ' AS data FROM "' + table + '") AS rows))')
    return "SELECT jsonb_object_agg(name,payload) FROM (VALUES " + ",".join(entries) + ") AS content(name,payload);"


def verify_runtime_migrations(plan):
    code = pathlib.Path(plan["descriptor"]["codeRoot"])
    wanted = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted((code / "packages/store/migrations").glob("*.sql"))}
    script = "const fs=require('fs'),crypto=require('crypto');const p='/app/packages/store/migrations/';process.stdout.write(JSON.stringify(Object.fromEntries(fs.readdirSync(p).filter(n=>n.endsWith('.sql')).sort().map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(p+n)).digest('hex')]))))"
    actual = json.loads(run(["docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only", "--entrypoint", "node",
                             plan["descriptor"]["release"]["runtimeImage"], "-e", script]))
    if wanted != actual:
        raise InstanceError("runtime release migration sources differ from codeRoot")


def bootstrap_fresh(plan, receipt, container, save):
    marker = psql(container, "cauce", "SELECT to_regclass('public.cauce_instance_ownership') IS NOT NULL;").strip()
    if marker == "t":
        identity = json.loads(psql(container, "cauce", "SELECT row_to_json(t) FROM cauce_instance_ownership t;"))
        wanted = {"instance_id": receipt["instanceId"], "owner": receipt["owner"],
                  "plan_hash": plan["planHash"], "bootstrap_hash": plan["bootstrapHash"]}
        if identity != wanted:
            raise InstanceError("database ownership marker mismatch")
        return
    if not receipt["stages"].get("freshStorage"):
        raise InstanceError("seed cleanup requires receipt for freshly created storage")
    verify_owned_resources(plan, receipt)
    actual_container = inspect_resource("container", container)
    labels = actual_container["Config"].get("Labels") or {}
    mounts = [mount for mount in actual_container["Mounts"] if mount["Destination"] == "/var/lib/postgresql/data"]
    volume = plan["compose"]["volumes"]["cauce_pgdata"]["name"]
    if (labels.get("io.cauce.owner") != receipt["owner"] or labels.get("io.cauce.installation") != receipt["instanceId"]
            or len(mounts) != 1 or mounts[0]["Type"] != "volume" or mounts[0]["Name"] != volume
            or "volume:" + volume not in receipt["docker"]):
        raise InstanceError("baseline requires the exact owned fresh PostgreSQL volume")
    if psql(container, "cauce", "SELECT to_regclass('public.cauce_baseline_ownership') IS NOT NULL;").strip() != "f":
        raise InstanceError("baseline ownership table exists outside its disposable database")
    baseline = "cauce_baseline_" + receipt["owner"]
    if len(receipt["owner"]) != 32 or any(c not in "0123456789abcdef" for c in receipt["owner"]):
        raise InstanceError("invalid baseline owner nonce")
    code = pathlib.Path(plan["descriptor"]["codeRoot"])
    sources = sorted((code / "packages/store/migrations").glob("*.sql"))
    migration_sql = "\n".join(path.read_text() for path in sources)
    wanted_intent = {"databaseName": baseline, "owner": receipt["owner"], "installerUid": os.getuid(),
                     "planHash": plan["planHash"], "sourceHash": hashlib.sha256(migration_sql.encode()).hexdigest()}
    intent = receipt["stages"].get("baselineIntent")
    existing = psql(container, "postgres", f"SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname={literal(baseline)});").strip()
    databases = json.loads(psql(container, "postgres", "SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate;"))
    if set(databases) - {"postgres", "cauce", baseline}:
        raise InstanceError("unexpected database in freshly created PostgreSQL volume")
    if intent is None:
        if existing == "t":
            raise InstanceError("unknown baseline database, including empty database")
        receipt["stages"]["baselineIntent"] = wanted_intent
        save()
    elif intent != wanted_intent:
        raise InstanceError("baseline intent identity differs")
    if existing == "f":
        if receipt["stages"].get("baselineOid"):
            raise InstanceError("owned baseline database disappeared")
        psql(container, "postgres", f"CREATE DATABASE {baseline};")
    metadata = json.loads(psql(container, "postgres", "SELECT json_build_object('oid',oid,'owner',pg_get_userbyid(datdba),'template',datistemplate) FROM pg_database WHERE datname=" + literal(baseline) + ";"))
    if metadata["owner"] != "cauce" or metadata["template"] or (receipt["stages"].get("baselineOid") is not None and receipt["stages"]["baselineOid"] != metadata["oid"]):
        raise InstanceError("baseline database physical identity differs")
    receipt["stages"]["baselineOid"] = metadata["oid"]
    save()
    marker = psql(container, baseline, "SELECT to_regclass('public.cauce_baseline_ownership') IS NOT NULL;").strip()
    identity = {"owner": receipt["owner"], "plan_hash": plan["planHash"], "source_hash": wanted_intent["sourceHash"]}
    if marker == "t":
        actual = json.loads(psql(container, baseline, "SELECT row_to_json(t) FROM cauce_baseline_ownership t;"))
        if actual != identity:
            raise InstanceError("baseline committed migration owner or sources differ")
    else:
        if psql(container, baseline, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';").strip() != "0":
            raise InstanceError("unknown nonempty baseline database")
        ownership = "CREATE TABLE cauce_baseline_ownership(owner text PRIMARY KEY, plan_hash text NOT NULL, source_hash text NOT NULL);"
        ownership += "INSERT INTO cauce_baseline_ownership VALUES (" + ",".join(literal(value) for value in identity.values()) + ");"
        psql(container, baseline, "BEGIN;\n" + migration_sql + "\n" + ownership + "\nCOMMIT;")
    receipt["stages"]["baselineMigrated"] = True
    save()
    columns = table_columns(container, baseline)
    if columns != table_columns(container, "cauce"):
        raise InstanceError("fresh baseline database structure differs")
    query = snapshot_query(columns)
    expected = json.loads(psql(container, baseline, query))
    receipt["stages"]["baselineHash"] = hashlib.sha256(canonical(expected)).hexdigest()
    mutable = sorted(set(columns) - GLOBAL_TABLES)
    lock = "LOCK TABLE " + ", ".join('"' + table + '"' for table in sorted(columns)) + " IN ACCESS EXCLUSIVE MODE;"
    check = "DO $guard$ BEGIN IF (" + query.rstrip(";") + ") IS DISTINCT FROM " + literal(json.dumps(expected)) + "::jsonb THEN RAISE EXCEPTION 'fresh seed baseline mismatch'; END IF; END $guard$;"
    cleanup = "TRUNCATE " + ", ".join('"' + table + '"' for table in mutable) + " RESTART IDENTITY;"
    inserts = []
    for source, table in (("tenants", "tenants"), ("rooms", "rooms"), ("memberships", "memberships"),
                          ("agents", "agents"), ("aclEdges", "acl_edges")):
        for row in plan["bootstrap"][source]:
            fields = list(row)
            values = ["true" if value is True else "false" if value is False else literal(value) for value in row.values()]
            inserts.append("INSERT INTO " + table + "(" + ",".join(fields) + ") VALUES (" + ",".join(values) + ");")
    ownership = "CREATE TABLE cauce_instance_ownership (instance_id text PRIMARY KEY, owner text NOT NULL, plan_hash text NOT NULL, bootstrap_hash text NOT NULL);"
    ownership += "INSERT INTO cauce_instance_ownership VALUES (" + ",".join(literal(value) for value in
                 (receipt["instanceId"], receipt["owner"], plan["planHash"], plan["bootstrapHash"])) + ");"
    psql(container, "cauce", "BEGIN; " + lock + check + cleanup + "\n".join(inserts) + ownership + " COMMIT;")
    save()

def update_database_marker(plan, receipt, container):
    marker = psql(container, "cauce", "SELECT to_regclass('public.cauce_instance_ownership') IS NOT NULL;").strip()
    if marker != "t":
        raise InstanceError("update requires an owned database marker")
    identity = json.loads(psql(container, "cauce", "SELECT row_to_json(t) FROM cauce_instance_ownership t;"))
    if identity["instance_id"] != receipt["instanceId"] or identity["owner"] != receipt["owner"] or identity["bootstrap_hash"] != plan["bootstrapHash"]:
        raise InstanceError("database owner mismatch before update")
    old_hash = receipt["stages"]["updatePreviousPlanHash"]
    if identity["plan_hash"] not in {old_hash, plan["planHash"]}:
        raise InstanceError("database plan identity mismatch before update")
    statement = "DO $guard$ BEGIN UPDATE cauce_instance_ownership SET plan_hash=" + literal(plan["planHash"]) + " WHERE owner=" + literal(receipt["owner"]) + " AND plan_hash IN (" + literal(old_hash) + "," + literal(plan["planHash"]) + "); IF NOT FOUND THEN RAISE EXCEPTION 'owned database update mismatch'; END IF; END $guard$;"
    psql(container, "cauce", "BEGIN; " + statement + " COMMIT;")


def validate_existing_database(plan, receipt, container):
    marker = psql(container, "cauce", "SELECT to_regclass('public.cauce_instance_ownership') IS NOT NULL;").strip()
    if marker != "t":
        raise InstanceError("existing database requires an ownership marker before migration")
    identity = json.loads(psql(container, "cauce", "SELECT row_to_json(t) FROM cauce_instance_ownership t;"))
    allowed_hashes = {receipt["planHash"], receipt["stages"].get("updatePreviousPlanHash")}
    if identity["instance_id"] != receipt["instanceId"] or identity["owner"] != receipt["owner"] or identity["bootstrap_hash"] != plan["bootstrapHash"] or identity["plan_hash"] not in allowed_hashes:
        raise InstanceError("existing database ownership drift before migration")
