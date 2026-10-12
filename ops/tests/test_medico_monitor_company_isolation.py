#!/usr/bin/env python3
from __future__ import annotations

# cauce:requiere docker
import datetime
import importlib.machinery
import importlib.util
import json
import pathlib
import sys
from types import SimpleNamespace

import pytest
from test_conversaciones_paralelas_postgres import postgres_fixture

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "guardias/cauce-v3-medico-monitor"
loader = importlib.machinery.SourceFileLoader("medico_company", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)

SCHEMA = """
create table tenants(id text primary key, company_id text not null);
create table agents(tenant_id text references tenants, alias text, container_name text,
                    runtime_key text unique, enabled boolean);
create table messages(id bigint primary key, tenant_id text references tenants, actor_alias text,
  auth_channel text, body jsonb, room_id text, lane text, priority int, request_id text, origin jsonb);
create table deliveries(id bigint primary key, message_id bigint references messages,
  recipient_tenant text references tenants, recipient_alias text, status text, attempt int,
  created_at timestamptz, claimed_at timestamptz, execution_started_at timestamptz,
  updated_at timestamptz, terminal_at timestamptz, claim_expires_at timestamptz, last_error text, result jsonb);
create table delivery_acks(delivery_id bigint references deliveries, applied boolean, status text, payload jsonb);
create table channel_bridge_cursors(tenant_id text references tenants, alias text, next_update_id bigint, updated_at timestamptz);
create table dead_letters(tenant_id text references tenants, resolved_at timestamptz, created_at timestamptz);
create table outbox_dead_letters(tenant_id text references tenants, resolved_at timestamptz, created_at timestamptz);
insert into tenants values ('Steven','humanizar'),('LocalB','humanizar'),('ForeignTenant','outside');
insert into agents values ('Steven','shared','fixture-a','local-a',true),('LocalB','shared','fixture-b','local-b',true),
 ('Steven','zeus','fixture-z','zeus',true),('ForeignTenant','shared','foreign-container','foreign-runtime',true),
 ('ForeignTenant','foreign-alias','foreign-container','foreign-extra',true);
insert into channel_bridge_cursors values ('Steven','shared',11,now()-interval '1 hour'),
 ('LocalB','shared',22,now()-interval '2 hours'),('ForeignTenant','shared',999,now());
with seed(id,source,recipient,alias,status,error,body,age) as (values
 (1,'Steven','Steven','shared','failed','own-agent-error-canary','{"type":"agent.response","text":"This is the sufficiently long response from a local agent in Humanizar."}',120),
 (2,'LocalB','LocalB','shared','failed','ACK timeout own-transport-error-canary','{"type":"agent.response","text":"This is another sufficiently long response from a local agent in Humanizar."}',110),
 (3,'LocalB','LocalB','shared','done',null,'{"type":"agent.response","text":"This is the sufficiently long response from a local agent in Humanizar."}',100),
 (4,'ForeignTenant','ForeignTenant','shared','failed','foreign-last-error','{"type":"agent.response","text":"foreign-private-body"}',100),
 (5,'ForeignTenant','Steven','shared','failed','foreign-cross-source','{"type":"agent.response"}',100),
 (6,'Steven','ForeignTenant','shared','failed','foreign-cross-dest','{"type":"agent.response"}',100),
 (7,'Steven','Steven','shared','leased',null,'{}',30),
 (8,'ForeignTenant','ForeignTenant','shared','leased',null,'{"private":"foreign-body"}',30),
 (9,'Steven','Steven','zeus','dead','own-notice-error-canary','{"guardia":"cauce-medico-monitor"}',90),
 (10,'ForeignTenant','ForeignTenant','shared','dead','foreign-last-error','{"guardia":"cauce-medico-monitor"}',90),
 (11,'Steven','Steven','shared','done',null,'{}',30),
 (12,'Steven','Steven','shared','done',null,'{}',20),
 (13,'ForeignTenant','ForeignTenant','shared','done',null,'{"private":"foreign-body"}',30),
 (14,'ForeignTenant','ForeignTenant','shared','done',null,'{"private":"foreign-body"}',20)
), m as (
 insert into messages select id,source,case when source='ForeignTenant' then 'foreign-actor' else 'local-actor' end,
 'console',body::jsonb,'grp.steven','interactive',7,'request-local',null from seed returning id
)
insert into deliveries select s.id,s.id,s.recipient,s.alias,s.status,1,
 now()-s.age*interval '1 minute',now(),now(),now(),now(),now()+interval '1 minute',s.error,'{}'
 from seed s join m using(id);
insert into delivery_acks values
 (11,true,'done','{"result":{"harness_consumption_v1":{"native_session_id":"local001"}}}'),
 (12,true,'done','{"result":{"harness_consumption_v1":{"native_session_id":"local002"}}}'),
 (13,true,'done','{"result":{"harness_consumption_v1":{"native_session_id":"foreign1"}}}'),
 (14,true,'done','{"result":{"harness_consumption_v1":{"native_session_id":"foreign2"}}}');
insert into dead_letters values ('Steven',null,now()),('ForeignTenant',null,now());
insert into outbox_dead_letters values ('LocalB',null,now()),('ForeignTenant',null,now());
"""


@pytest.fixture(scope="module")
def pg():
    with postgres_fixture() as database:
        result = database.run_sql(SCHEMA)
        assert result.returncode == 0, result.stderr
        yield database


@pytest.fixture
def transport(pg, monkeypatch):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "humanizar")
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", None)

    def sql_only(host, command, entrada=None, **_kwargs):
        assert host == "agora" and command == doctor.PG and entrada.startswith("COPY (")
        result = pg.run_sql(entrada)
        return result.returncode, result.stdout, result.stderr

    monkeypatch.setattr(doctor, "sh", sql_only)
    return sql_only


def no_private(*values):
    text = repr(values)
    for secret in ("ForeignTenant", "foreign-", "foreign1", "foreign2", "own-agent-error-canary",
                   "own-transport-error-canary", "own-notice-error-canary"):
        assert secret not in text


def test_pg_scopes_readers_and_keeps_colliding_aliases_separate(transport, monkeypatch):
    inventory = doctor.inventario()
    assert set(inventory) == {("Steven", "shared"), ("LocalB", "shared"), ("Steven", "zeus")}
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", inventory)
    cursors = doctor.cursores()
    assert {key: value["cursor"] for key, value in cursors.items()} == {
        ("Steven", "shared"): 11, ("LocalB", "shared"): 22}
    blocked = doctor.entregas_trabadas()
    assert [row["id"] for row in blocked] == ["7"]
    with pytest.raises(ValueError, match="unambiguous"):
        doctor.captura_en_vuelo("shared")
    captured = doctor.captura_en_vuelo("shared", "Steven")
    assert [row["delivery"] for row in captured] == ["7"]
    lost, rejected = doctor.respuestas_perdidas()
    assert set(lost) == {("LocalB", "shared")}
    assert set(rejected) == {("Steven", "shared")}
    assert rejected[("Steven", "shared")][0]["rescatada"] is False
    parallel = doctor.conversaciones_paralelas()
    assert set(parallel) == {("Steven", "shared")}
    failed = doctor.lost_work_rows()
    assert {tuple(row[:2]) for row in failed} == set(inventory)
    notices = doctor.avisos_propios_muertos(doctor.doctor_failed_notices())
    assert [row["alias"] for row in notices] == ["zeus"]
    dlq = doctor.sql("select tenant_id from dead_letters union all select tenant_id from outbox_dead_letters", columnas=1)
    assert dlq == [["Steven"], ["LocalB"]]
    no_private(inventory, cursors, blocked, captured, lost, rejected, parallel, notices, dlq)


def test_sql_foreign_company_and_invalid_queries_fail_before_any_unscoped_sink(transport, monkeypatch):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "outside")
    inventory = doctor.inventario()
    assert set(inventory) == {("ForeignTenant", "shared"), ("ForeignTenant", "foreign-alias")}
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", inventory)
    monkeypatch.setattr(doctor, "sh", lambda *_args, **_kwargs: pytest.fail("foreign scope reached a transport"))
    assert doctor.publicar("ForeignTenant", "shared", "foreign-private", "key") == (False, "OUT_OF_SCOPE_RECIPIENT")
    assert doctor.avisar("foreign-private") == (False, "OUT_OF_SCOPE_NOTICE")
    assert doctor.despachar_a_zeus("foreign-private", "key") == (False, "OUT_OF_SCOPE_NOTICE")
    for query in ("select * from public.agents", "select * from unscoped_table"):
        with pytest.raises(ValueError, match="unscoped relation"):
            doctor.sql(query)
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "invalid'; --")
    with pytest.raises(ValueError, match="CAUCE_GUARD_COMPANY_ID"):
        doctor.sql("select * from agents")


def test_psql_error_redacts_free_text(transport):
    with pytest.raises(RuntimeError) as error:
        doctor.sql("select cast('ForeignTenant foreign-last-error' as integer)")
    assert "psql rc=" in str(error.value) and "stderr_chars=" in str(error.value)
    no_private(str(error.value))


@pytest.mark.parametrize("response", [(1, "500\nForeignTenant foreign-last-error", "foreign-stderr"),
                                     (0, "ForeignTenant foreign-status", "foreign-stderr")])
def test_publication_transport_never_returns_agent_or_foreign_error_text(transport, monkeypatch, response):
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", {("Steven", "zeus"): {"runtime_key": "zeus"}})
    monkeypatch.setattr(doctor, "sh", lambda *_args, **_kwargs: response)
    ok, detail = doctor.publicar("Steven", "zeus", "local-body", "local-key")
    assert ok is False and "stdout_chars=" in detail and "stderr_chars=" in detail
    no_private(detail)
    _, restart_detail = doctor.reiniciar_puente_telegram()
    assert "stderr_chars=" in restart_detail
    no_private(restart_detail)


def test_injected_findings_state_units_and_telegram_are_filtered(transport, monkeypatch):
    inventory = doctor.inventario()
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", inventory)
    records = [{"tenant": "Steven", "alias": "shared", "detalle": "local"},
               {"tenant": "ForeignTenant", "alias": "shared", "detalle": "foreign-private"},
               {"tenant": "ForeignTenant", "alias": "-", "detalle": "foreign-private"},
               {"company_id": "outside", "alias": "-", "detalle": "foreign-private"},
               {"alias": "shared", "detalle": "ambiguous"}]
    assert doctor.scope_findings(records) == [records[0]]
    now = datetime.datetime.now(datetime.UTC)
    state = {"kind|Steven|shared": {"ultimo_visto": now.isoformat()},
             "kind|ForeignTenant|shared": {"ultimo_visto": now.isoformat()},
             "kind|foreign-alias": {"ultimo_visto": now.isoformat()}}
    memory = doctor.memoria_hallazgos(state, state, now)
    assert set(memory) == {"kind|Steven|shared"}
    units = doctor.scope_units({"local-a": {"state": "local"}, "foreign-runtime": {"state": "foreign-private"}}, inventory)
    assert set(units) == {("Steven", "shared")}
    monkeypatch.setattr(doctor, "sh", lambda *_args, **_kwargs: (0, json.dumps([
        {"tenant": "Steven", "alias": "shared", "status": {"pendientes": 1}},
        {"tenant": "ForeignTenant", "alias": "shared", "status": {"error": "foreign-private"}}]), ""))
    telegram, error = doctor.sonda_telegram()
    assert error is None and set(telegram) == {("Steven", "shared")}
    no_private(doctor.scope_findings(records), memory, units, telegram)


def test_task_book_refuses_unscoped_persistence_without_loading_it(transport, monkeypatch, tmp_path):
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", {("Steven", "zeus"): {"runtime_key": "zeus"}})
    libro = tmp_path / "book.json"
    libro.write_text(json.dumps({"encargos": {"foreign-alias": {"detalle": "foreign-private"}}}))
    monkeypatch.setattr(doctor, "LIBRO_JSON", str(libro))
    monkeypatch.setattr(doctor, "EVIDENCIA_JSON", str(tmp_path / "evidence.json"))
    with pytest.raises(RuntimeError, match="no verified company scope"):
        doctor.check_book_scope()
    libro.write_text(json.dumps({"_doctor_company_id": "outside"}))
    with pytest.raises(RuntimeError, match="no verified company scope"):
        doctor.check_book_scope()
    libro.unlink()
    doctor.check_book_scope()
    libro.write_text("{}")
    doctor.mark_book_scope()
    doctor.check_book_scope()
    assert json.loads(libro.read_text())["_doctor_company_id"] == "humanizar"


def test_main_with_real_pg_and_mocked_host_probes_has_no_foreign_output_or_memory(transport, monkeypatch, tmp_path, capsys):
    for variable, name in (("ESTADO_DIR", ""), ("LOCK", "lock"), ("BITACORA_JSONL", "log.jsonl"),
                           ("BITACORA_LOG", "log.txt"), ("ESTADO_JSON", "state.json"), ("LIBRO_JSON", "book.json"),
                           ("LIBRO_MD", "book.md"), ("EVIDENCIA_JSON", "evidence.json")):
        monkeypatch.setattr(doctor, variable, str(tmp_path / name))
    now = datetime.datetime.now(datetime.UTC)
    pathlib.Path(doctor.ESTADO_JSON).write_text(json.dumps({"hallazgos_vistos": {
        "kind|ForeignTenant|shared": {"ultimo_visto": now.isoformat(), "private": "foreign-private"}}}))
    pathlib.Path(doctor.LIBRO_JSON).write_text(json.dumps({"encargos": {"foreign-alias": "foreign-private"}}))
    book = SimpleNamespace(correr=lambda *_args, **_kwargs: pytest.fail("Unscoped book was loaded"),
                           entrega_progresa=lambda _: (True, "local-progress"),
                           bloqueado_por_acceso=lambda _: (False, None))
    monkeypatch.setattr(doctor, "libro_tareas", book)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--solo-detectar", "--sin-aviso"])
    monkeypatch.setattr(doctor, "sonda_credenciales", lambda _: ([], {}))
    monkeypatch.setattr(doctor, "robo_cpu_agora", lambda: None)
    monkeypatch.setattr(doctor, "git_commit", lambda _: None)
    real_lost_work = doctor.lost_work_rows

    def missing_output_rows():
        rows = real_lost_work()
        for row in rows:
            if row[:2] == ["Steven", "zeus"]:
                row[3] = "Harness exited without structured output"
        return rows

    monkeypatch.setattr(doctor, "lost_work_rows", missing_output_rows)
    monkeypatch.setattr(doctor, "panel_del_alias", lambda *_args: ("own-panel-canary not logged in", None))
    monkeypatch.setattr(doctor, "procesos", lambda host: [
        {"host": host, "pid": 100+i, "etimes": 10, "pcpu": 0, "rss": 0,
         "args": f"python cauce-container-runtime.py run --alias {runtime} --container-id a{i}"}
        for i, runtime in enumerate(("local-a", "local-b", "zeus", "foreign-runtime"))])
    monkeypatch.setattr(doctor, "unidades", lambda host: {
        runtime: {"host": host, "active": "active", "sub": "running", "unidad": runtime}
        for runtime in ("local-a", "local-b", "zeus", "foreign-runtime")})
    publications = []

    def hermetic_host(host, command, entrada=None, **kwargs):
        if command == doctor.PG:
            return transport(host, command, entrada, **kwargs)
        if command == "python3 -" and "getWebhookInfo" in entrada:
            return 0, "[]", ""
        if command == "python3 -":
            publications.append(entrada)
            return 0, "202\n{}", ""
        if command.startswith("cat "):
            return 0, "", ""
        if command.startswith("for C "):
            return 0, "", ""
        pytest.fail(f"Unexpected host operation: {host} {command}")

    monkeypatch.setattr(doctor, "sh", hermetic_host)
    assert doctor.main() == 0
    output = capsys.readouterr().out
    state = json.loads(pathlib.Path(doctor.ESTADO_JSON).read_text())
    logs = pathlib.Path(doctor.BITACORA_JSONL).read_text() + pathlib.Path(doctor.BITACORA_LOG).read_text()
    assert publications and "LAST_ERROR_AGENT" in logs and "panel chars" in logs
    assert "own-panel-canary" not in repr((output, state, logs, publications))
    assert "aviso_propio_muerto|Steven|zeus" in state["hallazgos_vistos"]
    assert state["hallazgos_vistos"]["aviso_propio_muerto|Steven|zeus"]["ultimo_despacho"]
    no_private(output, state, logs, publications)


if __name__ == "__main__":
    sys.exit(pytest.main(["-q", __file__]))
