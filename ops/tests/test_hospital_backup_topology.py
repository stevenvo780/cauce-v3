from __future__ import annotations

# cauce:requiere docker
# PostgreSQL restore and membership checks exceed the two-minute default.
# cauce:timeout-ms 300000
import contextlib
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import time
import uuid

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKUP = ROOT / "ops/instances/hospital/backup.sh"
BOOTSTRAP = ROOT / "ops/instances/hospital/bootstrap.sql"
RESTORE_ALIASES = ROOT / "ops/instances/hospital/restore-developer-aliases.sql"
CONTAINER_SCRIPT = """
import { GenericContainer, Wait } from 'testcontainers';
const container = await new GenericContainer('postgres:16-alpine')
  .withName(process.argv[1])
  .withLabels({ 'cauce.hospital.backup-topology-test': process.argv[1] })
  .withNetworkMode('none')
  .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: 'cauce_restore', POSTGRES_HOST_AUTH_METHOD: 'trust' })
  .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres -d cauce_restore'],
    interval: 1000, timeout: 3000, retries: 60, startPeriod: 1000 })
  .withWaitStrategy(Wait.forHealthCheck())
  .withStartupTimeout(120000)
  .start();
console.log(JSON.stringify({ id: container.getId() }));
await new Promise(resolve => process.stdin.once('data', resolve));
await container.stop();
process.stdin.destroy();
"""
SCHEMA_AND_DATA = """
CREATE TABLE schema_migrations (version integer PRIMARY KEY);
CREATE TABLE tenants (id text PRIMARY KEY);
CREATE TABLE rooms (tenant_id text NOT NULL, id text NOT NULL);
CREATE TABLE agents (tenant_id text NOT NULL, alias text NOT NULL,
                     role_template_slug text NOT NULL, enabled boolean NOT NULL);
CREATE TABLE agent_profiles (tenant_id text NOT NULL, alias text NOT NULL);
CREATE TABLE memberships (tenant_id text NOT NULL, room_id text NOT NULL,
                          alias text NOT NULL, role text NOT NULL, enabled boolean NOT NULL);
CREATE TABLE acl_edges (id integer PRIMARY KEY);
INSERT INTO schema_migrations SELECT generate_series(1, 39);
INSERT INTO tenants VALUES ('Hospital');
INSERT INTO rooms VALUES ('Hospital', 'grp.hospital');
INSERT INTO agents VALUES
  ('Hospital', 'operador', 'hospital-lider', true),
  ('Hospital', 'perseo', 'hospital-praxis-developer', true),
  ('Hospital', 'teseo', 'hospital-praxis-developer', true);
INSERT INTO agent_profiles SELECT tenant_id, alias FROM agents;
INSERT INTO memberships VALUES
  ('Hospital', 'console-proxy', 'console-proxy', 'operator', false),
  ('Hospital', 'grp.hospital', 'console-proxy', 'operator', true),
  ('Hospital', 'grp.hospital', 'operador', 'operator', true),
  ('Hospital', 'grp.hospital', 'perseo', 'agent', true),
  ('Hospital', 'grp.hospital', 'teseo', 'agent', true);
"""
SUPERVISOR = ("INSERT INTO memberships(tenant_id, room_id, alias, role, enabled) "
              "VALUES ('Hospital', 'grp.hospital', 'praxis-supervisor', 'operator', true);")


class PostgresFixture:
    def __init__(self, identifier: str):
        self.id = identifier

    def execute(self, query: str, database: str = "cauce_source") -> subprocess.CompletedProcess:
        return subprocess.run(
            ["docker", "exec", "-i", self.id, "psql", "-X", "-Atq", "-v", "ON_ERROR_STOP=1",
             "-U", "postgres", "-d", database],
            input=query, text=True, capture_output=True, timeout=60, check=False,
        )

    def sql(self, query: str, database: str = "cauce_source") -> None:
        result = self.execute(query, database)
        assert result.returncode == 0, result.stderr

    def restore_and_check(self) -> subprocess.CompletedProcess:
        dump = subprocess.run(
            ["docker", "exec", self.id, "pg_dump", "-U", "postgres", "-d", "cauce_source",
             "--format=custom", "--no-owner", "--no-acl"],
            capture_output=True, timeout=60, check=False,
        )
        assert dump.returncode == 0, dump.stderr.decode()
        self.sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;", "cauce_restore")
        restore = subprocess.run(
            ["docker", "exec", "-i", self.id, "pg_restore", "-U", "postgres", "-d", "cauce_restore",
             "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl"],
            input=dump.stdout, capture_output=True, timeout=60, check=False,
        )
        assert restore.returncode == 0, restore.stderr.decode()
        script = BACKUP.read_text(encoding="utf-8")
        start = script.index("IFS=$'\\t' read -r migrations")
        end = script.index('docker rm -f "$restore_container" >/dev/null\nrestore_container=', start)
        return subprocess.run(
            ["bash", "-euo", "pipefail", "-c", script[start:end]],
            env={**os.environ, "restore_container": self.id},
            capture_output=True, text=True, timeout=60, check=False,
        )


@contextlib.contextmanager
def postgres_fixture():
    name = f"zz-canary-hospital-backup-{uuid.uuid4().hex}"
    with tempfile.TemporaryFile(mode="w+") as errors:
        process = subprocess.Popen(
            ["node", "--input-type=module", "--eval", CONTAINER_SCRIPT, name],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True,
        )
        fixture = None
        try:
            deadline = time.monotonic() + 150
            while not select.select([process.stdout], [], [], 1)[0]:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Testcontainers did not start the isolated PostgreSQL fixture")
            line = process.stdout.readline()
            if not line:
                errors.seek(0)
                raise RuntimeError(f"Testcontainers startup failed: {errors.read()}")
            fixture = PostgresFixture(json.loads(line)["id"])
            fixture.sql("CREATE DATABASE cauce_source;", "cauce_restore")
            yield fixture
        finally:
            original_error = sys.exc_info()[1]
            cleanup_errors = []
            try:
                if process.poll() is None:
                    try:
                        process.communicate("stop\n", timeout=60)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate(timeout=15)
                        cleanup_errors.append("Testcontainers cleanup timed out")
            except Exception as failure:
                cleanup_errors.append(f"Could not stop Testcontainers: {failure}")
            identifier = fixture.id if fixture else name
            try:
                owner = subprocess.run(
                    ["docker", "inspect", "--format",
                     '{{ index .Config.Labels "cauce.hospital.backup-topology-test" }}', identifier],
                    capture_output=True, text=True, timeout=15, check=False,
                )
                if owner.returncode == 0:
                    if owner.stdout.strip() == name:
                        removal = subprocess.run(
                            ["docker", "rm", "-f", "-v", identifier],
                            capture_output=True, text=True, timeout=30, check=False,
                        )
                        if removal.returncode:
                            cleanup_errors.append("Could not remove the owned test container")
                    else:
                        cleanup_errors.append("Refused to remove a container without the test ownership label")
            except Exception as failure:
                cleanup_errors.append(f"Could not clean up the owned test container: {failure}")
            try:
                removed = subprocess.run(
                    ["docker", "inspect", identifier], capture_output=True, text=True, timeout=15, check=False,
                )
                missing = removed.stderr.lower()
                if (removed.returncode != 1 or identifier not in removed.stderr
                        or not any(message in missing for message in ("no such object", "no such container"))):
                    cleanup_errors.append("The disposable test container removal was not verified")
            except Exception as failure:
                cleanup_errors.append(f"Could not verify test container removal: {failure}")
            if process.returncode:
                errors.seek(0)
                cleanup_errors.append(f"Testcontainers rc={process.returncode}: {errors.read()}")
            if cleanup_errors:
                detail = "; ".join(cleanup_errors)
                if original_error is not None:
                    original_error.add_note(detail)
                else:
                    raise RuntimeError(detail)


@pytest.fixture(scope="module")
def database():
    with postgres_fixture() as fixture:
        yield fixture


@pytest.fixture
def pg(database):
    database.sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;" + SCHEMA_AND_DATA)
    return database


def test_restored_legacy_memberships_are_accepted(pg):
    result = pg.restore_and_check()
    assert result.returncode == 0, result.stderr


def test_restored_supervisor_operator_is_accepted(pg):
    pg.sql(SUPERVISOR)
    result = pg.restore_and_check()
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("mutation", [
    SUPERVISOR + "UPDATE memberships SET role='agent' WHERE alias='praxis-supervisor';",
    "INSERT INTO memberships VALUES ('Hospital', 'grp.hospital', 'unknown', 'operator', true);",
    "UPDATE memberships SET alias='unknown' WHERE alias='console-proxy' AND enabled;",
    "UPDATE memberships SET tenant_id='ForeignTenant' WHERE alias='console-proxy' AND enabled;",
    "UPDATE memberships SET room_id='grp.foreign' WHERE alias='console-proxy' AND enabled;",
    SUPERVISOR + "INSERT INTO memberships VALUES ('Hospital', 'grp.hospital', 'extra', 'operator', true);",
    "DELETE FROM agent_profiles WHERE alias='perseo';",
    "UPDATE agents SET enabled=false WHERE alias='teseo';",
    "UPDATE memberships SET role='agent' WHERE alias='console-proxy' AND enabled;",
    "INSERT INTO acl_edges VALUES (1);",
], ids=["supervisor-role", "unknown-fifth", "replaced-console", "foreign-tenant", "foreign-room",
        "sixth-membership", "missing-profile", "disabled-agent", "console-role", "acl-edge"])
def test_restored_invalid_topology_is_rejected(pg, mutation):
    pg.sql(mutation)
    result = pg.restore_and_check()
    assert result.returncode != 0, "The restore gate accepted a corrupted Hospital topology"
    assert "La restauración aislada no conserva la topología Hospital" in result.stderr


@pytest.fixture
def hospital_pg(database):
    migrations = sorted(path for path in (ROOT / "packages/store/migrations").glob("*.sql")
                        if int(path.name.split("_", 1)[0]) <= 43)
    database.sql("BEGIN; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" +
                 "\n".join(path.read_text(encoding="utf-8") for path in migrations) + "COMMIT;")
    database.sql(BOOTSTRAP.read_text(encoding="utf-8"))
    return database


def membership_snapshot(pg, alias=None):
    result = pg.execute("SELECT row_to_json(m) FROM memberships m ORDER BY tenant_id, room_id, alias;")
    assert result.returncode == 0, result.stderr
    if alias is None:
        return result.stdout
    return [json.loads(line) for line in result.stdout.splitlines() if json.loads(line)["alias"] == alias]


def prepare_restore(pg, topology):
    for table in ("agents", "memberships"):
        pg.sql(f"""
          INSERT INTO {table}
          SELECT (jsonb_populate_record(NULL::{table}, to_jsonb(source) || jsonb_build_object(
            'alias', CASE alias WHEN 'teseo' THEN 'backend' ELSE 'frontend' END, 'enabled', false))).*
            FROM {table} source WHERE tenant_id='Hospital' AND alias IN ('teseo', 'perseo');
        """)
    if topology == "old":
        for table in ("agents", "memberships"):
            pg.sql(f"UPDATE {table} SET enabled = alias NOT IN ('teseo', 'perseo') WHERE tenant_id='Hospital';")


@pytest.mark.parametrize("supervisor", [False, True], ids=["four-members", "five-members"])
@pytest.mark.parametrize("legacy_developers", [False, True], ids=["fresh", "disabled-legacy"])
def test_bootstrap_preserves_exact_memberships_on_rerun(hospital_pg, supervisor, legacy_developers):
    if legacy_developers:
        prepare_restore(hospital_pg, "new")
    if supervisor:
        hospital_pg.sql(SUPERVISOR)
    before = membership_snapshot(hospital_pg)
    for _ in range(2):
        result = hospital_pg.execute(BOOTSTRAP.read_text(encoding="utf-8"))
        assert result.returncode == 0, result.stderr
        assert membership_snapshot(hospital_pg) == before


@pytest.mark.parametrize("topology", ["new", "old"])
@pytest.mark.parametrize("supervisor", [False, True], ids=["four-members", "five-members"])
def test_developer_restore_preserves_optional_supervisor(hospital_pg, topology, supervisor):
    prepare_restore(hospital_pg, topology)
    if supervisor:
        hospital_pg.sql(SUPERVISOR)
    supervisor_before = membership_snapshot(hospital_pg, "praxis-supervisor")
    for _ in range(2):
        result = hospital_pg.execute(RESTORE_ALIASES.read_text(encoding="utf-8"))
        assert result.returncode == 0, result.stderr
        aliases = hospital_pg.execute("SELECT string_agg(alias, ',' ORDER BY alias) FROM agents WHERE enabled;")
        assert aliases.stdout.strip() == "backend,frontend,operador"
        members = hospital_pg.execute("SELECT string_agg(alias || ':' || role, ',' ORDER BY alias) "
                                      "FROM memberships WHERE enabled;")
        expected = "backend:agent,console-proxy:operator,frontend:agent,operador:operator"
        if supervisor:
            expected += ",praxis-supervisor:operator"
        assert members.stdout.strip() == expected
        assert membership_snapshot(hospital_pg, "praxis-supervisor") == supervisor_before


@pytest.mark.parametrize("topology", ["bootstrap", "new", "old"])
@pytest.mark.parametrize("mutation", [
    "INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES ('Hospital','grp.hospital','unknown','operator');",
    "INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES ('Hospital','grp.hospital','praxis-supervisor','agent');",
    "INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES ('Hospital','grp.hospital','praxis-supervisor','operator'), ('Hospital','grp.hospital','extra','operator');",
    "UPDATE memberships SET role='agent' WHERE alias='console-proxy';",
    "UPDATE memberships SET role='operator' WHERE alias IN ('perseo', 'frontend') AND enabled;",
    "DELETE FROM memberships WHERE alias='console-proxy';",
    "UPDATE memberships SET alias='unknown' WHERE alias='console-proxy';",
    "UPDATE memberships SET enabled=false WHERE alias IN ('perseo', 'frontend') AND enabled;",
    "INSERT INTO rooms(id, tenant_id) VALUES ('grp.other', 'Hospital'); "
    "INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES ('Hospital','grp.other','praxis-supervisor','operator');",
    "INSERT INTO tenants(id) VALUES ('ForeignTenant'); INSERT INTO rooms(id, tenant_id) VALUES ('grp.foreign', 'ForeignTenant'); "
    "INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES ('ForeignTenant','grp.foreign','praxis-supervisor','operator');",
], ids=["unknown-fifth", "supervisor-role", "sixth-member", "console-role", "developer-role",
        "missing-console", "replaced-console", "disabled-developer",
        "supervisor-room", "supervisor-tenant"])
def test_hospital_sql_rejects_membership_drift_without_rewriting(hospital_pg, topology, mutation):
    if topology != "bootstrap":
        prepare_restore(hospital_pg, topology)
    hospital_pg.sql(mutation)
    before = membership_snapshot(hospital_pg)
    script = BOOTSTRAP if topology == "bootstrap" else RESTORE_ALIASES
    result = hospital_pg.execute(script.read_text(encoding="utf-8"))
    assert result.returncode != 0, "The Hospital SQL accepted a corrupted membership topology"
    expected_error = ("hospital topology drifted; bootstrap refuses to rewrite it" if topology == "bootstrap"
                      else "hospital developer restore requires an exact membership topology")
    assert expected_error in result.stderr, result.stderr
    assert membership_snapshot(hospital_pg) == before


@pytest.mark.parametrize("supervisor", [False, True], ids=["four-members", "five-members"])
@pytest.mark.parametrize("mutation", [
    "UPDATE memberships SET role='operator' WHERE alias='frontend';",
    "DELETE FROM memberships WHERE alias='frontend';",
    "INSERT INTO rooms(id, tenant_id) VALUES ('grp.other', 'Hospital'); "
    "UPDATE memberships SET room_id='grp.other' WHERE alias='frontend';",
], ids=["legacy-role", "missing-legacy", "legacy-room"])
def test_developer_restore_rolls_back_invalid_legacy_memberships(hospital_pg, supervisor, mutation):
    prepare_restore(hospital_pg, "new")
    if supervisor:
        hospital_pg.sql(SUPERVISOR)
    hospital_pg.sql(mutation)
    before = membership_snapshot(hospital_pg)
    result = hospital_pg.execute(RESTORE_ALIASES.read_text(encoding="utf-8"))
    assert result.returncode != 0, "The developer restore accepted corrupted legacy memberships"
    assert "hospital developer restore verification failed" in result.stderr, result.stderr
    assert membership_snapshot(hospital_pg) == before


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
