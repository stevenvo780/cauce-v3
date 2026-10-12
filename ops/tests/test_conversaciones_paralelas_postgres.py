from __future__ import annotations

# cauce:requiere docker
import contextlib
import datetime
import importlib.util
import json
import pathlib
import select
import subprocess
import sys
import tempfile
import time
import uuid

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("parallel_guard_pg", ROOT / "ops/guardias/cauce-conversaciones-paralelas.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

CONTAINER_SCRIPT = """
import { GenericContainer, Wait } from 'testcontainers';
const container = await new GenericContainer('postgres:16-alpine')
  .withName(process.argv[1])
  .withNetworkMode('none')
  .withEnvironment({ POSTGRES_USER: 'guard_test', POSTGRES_DB: 'cauce_test_guard', POSTGRES_HOST_AUTH_METHOD: 'trust' })
  .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U guard_test -d cauce_test_guard'],
    interval: 1000, timeout: 3000, retries: 60, startPeriod: 1000 })
  .withWaitStrategy(Wait.forHealthCheck())
  .withStartupTimeout(120000)
  .start();
console.log(JSON.stringify({ id: container.getId(), name: process.argv[1] }));
await new Promise(resolve => process.stdin.once('data', resolve));
await container.stop();
process.stdin.destroy();
"""


class PostgresFixture:
    def __init__(self, identifier: str, name: str):
        self.id, self.name = identifier, name
        self.command = ["docker", "exec", "-i", identifier, "psql", "-h", "127.0.0.1", "-U", "guard_test",
                        "-d", "cauce_test_guard", "-X", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1"]

    def run_sql(self, query: str) -> subprocess.CompletedProcess:
        return subprocess.run(self.command, input=query, capture_output=True, text=True, timeout=60, check=False)


@contextlib.contextmanager
def postgres_fixture():
    name = f"zz-canary-paralelas-{uuid.uuid4().hex}"
    with tempfile.TemporaryFile(mode="w+") as errors:
        process = subprocess.Popen(["node", "--input-type=module", "--eval", CONTAINER_SCRIPT, name],
                                   cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True)
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
            ready = json.loads(line)
            fixture = PostgresFixture(ready["id"], ready["name"])
            yield fixture
        finally:
            if process.poll() is None:
                process.communicate("stop\n", timeout=60)
            if process.returncode:
                errors.seek(0)
                raise RuntimeError(f"Testcontainers rc={process.returncode}: {errors.read()}")
            if fixture:
                removed = subprocess.run(["docker", "inspect", fixture.id], capture_output=True, timeout=15, check=False)
                assert removed.returncode != 0, "The disposable test container was not removed"


SCHEMA_AND_DATA = """
create table tenants (id text primary key, company_id text not null);
create table messages (id bigint primary key, tenant_id text references tenants, auth_channel text, body jsonb);
create table deliveries (id bigint primary key, message_id bigint references messages, recipient_tenant text references tenants,
                         recipient_alias text, terminal_at timestamptz, last_error text);
create table delivery_acks (delivery_id bigint references deliveries, applied boolean, status text, payload jsonb);
create table human_message_initiators (message_id bigint references messages, initiating_human_id uuid);
insert into tenants values ('LocalA','humanizar'),('LocalB','humanizar'),('ForeignTenant','outside');
with seed(id, source, recipient, alias, session, channel, body, human) as (values
  (1,'LocalA','LocalA','shared','aaaa0001','console','{}','11111111-1111-1111-1111-111111111111'),
  (2,'LocalA','LocalA','shared','aaaa0002','console','{}','11111111-1111-1111-1111-111111111111'),
  (3,'LocalB','LocalB','shared','bbbb0001','console','{}','22222222-2222-2222-2222-222222222222'),
  (4,'LocalB','LocalB','shared','bbbb0002','telegram','{"type":"telegram.message"}',null),
  (5,'ForeignTenant','ForeignTenant','shared','foreign1','foreign-channel','{}','ffffffff-ffff-ffff-ffff-ffffffffffff'),
  (6,'ForeignTenant','ForeignTenant','shared','foreign2','foreign-channel','{}','ffffffff-ffff-ffff-ffff-ffffffffffff'),
  (7,'ForeignTenant','ForeignTenant','foreign-alias','foreign3','foreign-channel','{}','ffffffff-ffff-ffff-ffff-ffffffffffff'),
  (8,'ForeignTenant','ForeignTenant','foreign-alias','foreign4','foreign-channel','{}','ffffffff-ffff-ffff-ffff-ffffffffffff'),
  (9,'ForeignTenant','LocalA','shared','crosssrc','foreign-channel','{}','ffffffff-ffff-ffff-ffff-ffffffffffff'),
  (10,'LocalA','ForeignTenant','shared','crossdst','console','{}','11111111-1111-1111-1111-111111111111'),
  (11,'LocalA','LocalA','shared','agent001','adapter','{}',null)
), message_rows as (
  insert into messages select id,source,channel,body::jsonb from seed returning id
), delivery_rows as (
  insert into deliveries select s.id,s.id,s.recipient,s.alias,now(),'foreign-last-error'
    from seed s join message_rows m using(id) returning id
), ack_rows as (
  insert into delivery_acks select d.id,true,'done',
    jsonb_build_object('result',jsonb_build_object('harness_consumption_v1',jsonb_build_object('native_session_id',s.session)))
    from delivery_rows d join seed s using(id)
)
insert into human_message_initiators select id,human::uuid from seed where human is not null;
"""


@pytest.fixture(scope="module")
def pg():
    with postgres_fixture() as database:
        result = database.run_sql(SCHEMA_AND_DATA)
        assert result.returncode == 0, result.stderr
        yield database


def test_sql_isolates_both_message_source_and_recipient_and_keeps_tenant_identity(pg, monkeypatch):
    monkeypatch.setattr(guard, "PG", pg.command)
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "humanizar")
    rows = guard.sql(guard.CONSULTA)
    assert {(row[1], row[2], row[3]) for row in rows} == {
        ("LocalA", "shared", "aaaa0001"), ("LocalA", "shared", "aaaa0002"),
        ("LocalB", "shared", "bbbb0001"), ("LocalB", "shared", "bbbb0002")}
    payloads = []

    def accept(payload):
        payloads.append(payload)
        return 202

    now = datetime.datetime.now(datetime.UTC)
    memory, output = guard.corrida(rows, {"outside/ForeignTenant/shared:foreign1,foreign2": now.isoformat()}, now, accept)
    assert set(memory) == {"humanizar/LocalA/shared:aaaa0001,aaaa0002", "humanizar/LocalB/shared:bbbb0001,bbbb0002"}
    assert "LocalA/shared" in output and "LocalB/shared" in output
    for result in (str(rows), str(memory), output, json.dumps(payloads)):
        for private in ("ForeignTenant", "foreign", "crosssrc", "crossdst", "agent001", "11111111", "22222222", "ffffffff"):
            assert private not in result


def test_configurable_company_can_read_its_rows_but_cannot_publish_to_humanizar(pg, monkeypatch):
    monkeypatch.setattr(guard, "PG", pg.command)
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "outside")
    rows = guard.sql(guard.CONSULTA)
    assert {row[3] for row in rows} == {"foreign1", "foreign2", "foreign3", "foreign4"}
    output = guard.texto(guard.paralelas(rows))
    assert "ForeignTenant/shared" in output and "ForeignTenant/foreign-alias" in output
    assert "LocalA" not in output and "LocalB" not in output and "ffffffff" not in output
    with pytest.raises(RuntimeError, match="destino"):
        guard.corrida(rows, {}, datetime.datetime.now(datetime.UTC), lambda _: pytest.fail("Foreign data reached the sink"))


def test_real_psql_error_does_not_expose_tenant_or_agent_written_error(pg, monkeypatch):
    monkeypatch.setattr(guard, "PG", pg.command)
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "humanizar")
    with pytest.raises(RuntimeError) as failure:
        guard.sql("do $$ begin raise exception 'ForeignTenant foreign-alias foreign-human foreign-last-error'; end $$;")
    assert str(failure.value) == "psql rc=3"


def test_invalid_company_stops_before_the_database_transport(monkeypatch):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "outside'; select 1; --")
    monkeypatch.setattr(guard, "PG", ["this-command-must-never-run"])
    with pytest.raises(ValueError, match="CAUCE_GUARD_COMPANY_ID inválido"):
        guard.sql(guard.CONSULTA)


if __name__ == "__main__":
    sys.exit(pytest.main(["-q", __file__]))
