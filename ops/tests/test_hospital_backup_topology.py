from __future__ import annotations

# cauce:requiere docker
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
SUPERVISOR = "INSERT INTO memberships VALUES ('Hospital', 'grp.hospital', 'praxis-supervisor', 'operator', true);"


class PostgresFixture:
    def __init__(self, identifier: str):
        self.id = identifier

    def sql(self, query: str, database: str = "cauce_source") -> None:
        result = subprocess.run(
            ["docker", "exec", "-i", self.id, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
             "-U", "postgres", "-d", database],
            input=query, text=True, capture_output=True, timeout=60, check=False,
        )
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
