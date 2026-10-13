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
alter table messages add column created_at timestamptz default now();
alter table deliveries add column late_result_at timestamptz;
create table audit_events(tenant_id text, message_id bigint, action text, metadata jsonb, company_id text);
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
insert into audit_events(tenant_id,message_id,action,metadata) values ('Steven',1,'local-audit','{}'),
 (null,2,'local-message-audit','{}'),('Steven',null,'local-tenant-audit','{}'),
 ('ForeignTenant',4,'foreign-audit','{}'),('ForeignTenant',1,'foreign-cross-audit','{}'),
 ('Steven',4,'foreign-cross-message-audit','{}'),(null,null,'unowned-audit','{}');
insert into audit_events values ('Steven',1,'foreign-explicit-company','{}','outside');
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


@pytest.fixture
def finding_inventory(monkeypatch):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "humanizar")
    inventory = {("Steven", "zeus"): {"contenedor_db": "ws-zeus", "runtime_key": "zeus"},
                 ("Steven", "jarvis"): {"contenedor_db": "ws-jarvis", "runtime_key": "jarvis"}}
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", inventory)
    monkeypatch.setattr(doctor, "DOCTOR_CONTAINER_SCOPES", {"foreign-container": False}, raising=False)
    return inventory


def test_account_findings_keep_independent_memory(finding_inventory):
    records = [{"tipo": "cuenta_ia", "alias": label, "detalle": "exhausted"}
               for label in ("steven", "b2b")]
    scoped = doctor.scope_findings(records)
    assert scoped == records
    now = datetime.datetime.now(datetime.UTC)
    memory = {f"cuenta_ia|-|{record['alias']}": {"ultimo_visto": now.isoformat()} for record in scoped}
    assert set(doctor.memoria_hallazgos({}, memory, now)) == {"cuenta_ia|-|steven", "cuenta_ia|-|b2b"}


@pytest.mark.parametrize("kind", ["bucle_de_cuota", "bucle_de_cuota_barato",
                                  "bucle_de_cuota_adjudicado", "sonda_bucle"])
def test_container_findings_resolve_local_and_preserve_unknown(finding_inventory, kind):
    scoped = doctor.scope_findings([{"tipo": kind, "alias": container, "detalle": "alarm"}
                                    for container in ("ws-zeus", "unknown-container", "foreign-container")])
    assert scoped == [{"tipo": kind, "tenant": "Steven", "alias": "zeus", "contenedor": "ws-zeus", "detalle": "alarm"},
                      {"tipo": kind, "alias": "-", "contenedor": "unknown-container", "detalle": "alarm"}]
    now = datetime.datetime.now(datetime.UTC)
    memory = {doctor.finding_memory_key(record): {"ultimo_visto": now.isoformat()} for record in scoped}
    assert set(memory) == {f"{kind}|Steven|zeus", f"{kind}|-|unknown-container"}
    assert doctor.memoria_hallazgos({}, memory, now) == memory


def test_credential_scope_round_trip_keeps_memory(finding_inventory):
    record, = doctor.scope_findings([{"tipo": "credencial", "alias": "Steven/jarvis", "detalle": "expired"}])
    assert (record["tenant"], record["alias"]) == ("Steven", "jarvis")
    now = datetime.datetime.now(datetime.UTC)
    key = f"{record['tipo']}|{record['tenant']}|{record['alias']}"
    memory = {key: {"ultimo_visto": now.isoformat(), "ultimo_despacho": now.isoformat(), "veces": 1}}
    assert doctor.memoria_hallazgos({}, memory, now) == memory
    assert doctor.scope_finding_memory(memory) == memory


@pytest.mark.parametrize("kind,subject", [("cuenta_ia", "steven"), ("bucle_de_cuota", "unknown-container")])
def test_global_fallback_does_not_keep_an_agent_tenant(finding_inventory, kind, subject):
    record, = doctor.scope_findings([{"tipo": kind, "tenant": "Steven", "alias": subject}])
    now = datetime.datetime.now(datetime.UTC)
    memory = {doctor.finding_memory_key(record): {"ultimo_visto": now.isoformat()}}
    assert set(doctor.memoria_hallazgos({}, memory, now)) == {f"{kind}|-|{subject}"}


def test_credential_probe_emits_separate_tenant_and_alias(finding_inventory, monkeypatch):
    monkeypatch.setattr(doctor, "sh", lambda *_args, **_kwargs: (0, json.dumps({
        "huella": None, "exp": (doctor.time.time() - 3600) * 1000}), ""))
    problems, _ = doctor.sonda_credenciales({("Steven", "jarvis"): {"host": "fixture", "contenedor": "ws-jarvis"}})
    assert len(problems) == 1
    assert (problems[0]["tenant"], problems[0]["alias"]) == ("Steven", "jarvis")


def test_credential_expiry_is_stable_for_dispatch_hash():
    assert doctor._texto_estable("access vence en -1 h") == doctor._texto_estable("access vence en -2 h")


@pytest.mark.parametrize("materialization", ["MATERIALIZED", "NOT MATERIALIZED"])
def test_pg_materialized_cte_stays_company_scoped(transport, materialization):
    rows = doctor.sql(f"WITH cierres AS {materialization} (SELECT tenant_id FROM messages) "
                      "SELECT DISTINCT tenant_id FROM cierres ORDER BY tenant_id", columnas=1)
    assert rows == [["LocalB"], ["Steven"]]


def test_pg_audit_scope_excludes_cross_company_events(transport):
    assert doctor.sql("SELECT action FROM audit_events ORDER BY action", columnas=1) == [
        ["local-audit"], ["local-message-audit"], ["local-tenant-audit"]]


def test_pg_container_scope_exposes_only_ownership(transport):
    rows = doctor.sql("SELECT container_name,in_company FROM doctor_container_scopes ORDER BY container_name", columnas=2)
    assert rows == [["fixture-a", "t"], ["fixture-b", "t"], ["fixture-z", "t"], ["foreign-container", "f"]]


def test_task_book_query_runs_on_scoped_postgres(transport, pg):
    result = pg.run_sql("UPDATE messages SET body=jsonb_build_object('type','agent.message', 'text',repeat('work ',40)) "
                        "WHERE id IN (1,2,4)")
    assert result.returncode == 0, result.stderr
    try:
        rows = [json.loads(row[0]) for row in doctor.sql(doctor.libro_tareas.consulta(), columnas=1)]
        assert {row["encargo_id"] for row in rows} == {1, 2}
        assert {row["tenant"] for row in rows} == {"Steven", "LocalB"}
    finally:
        pg.run_sql("UPDATE messages SET body=jsonb_build_object('type','agent.response','text',repeat('response ',30)) "
                   "WHERE id IN (1,2,4)")


def prepare_alarm_run(transport, monkeypatch, tmp_path, inventory, cron_lines):
    for variable, name in (("ESTADO_DIR", ""), ("LOCK", "lock"), ("BITACORA_JSONL", "log.jsonl"),
                           ("BITACORA_LOG", "log.txt"), ("ESTADO_JSON", "state.json"), ("LIBRO_JSON", "book.json"),
                           ("LIBRO_MD", "book.md"), ("EVIDENCIA_JSON", "evidence.json")):
        monkeypatch.setattr(doctor, variable, str(tmp_path / name))
    clock = [datetime.datetime.now(datetime.UTC)]
    monkeypatch.setattr(doctor, "ahora", lambda: clock[0])
    monkeypatch.setattr(doctor, "inventario", lambda: inventory)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--solo-detectar", "--sin-aviso"])
    for reader in ("entregas_trabadas", "lost_work_rows", "doctor_failed_notices"):
        monkeypatch.setattr(doctor, reader, lambda: [])
    monkeypatch.setattr(doctor, "respuestas_perdidas", lambda: ({}, {}))
    monkeypatch.setattr(doctor, "conversaciones_paralelas", lambda: {})
    monkeypatch.setattr(doctor, "robo_cpu_agora", lambda: None)
    monkeypatch.setattr(doctor, "git_commit", lambda _: None)
    monkeypatch.setattr(doctor, "procesos", lambda host: [
        {"host": host, "pid": 100+i, "etimes": 10, "pcpu": 0, "rss": 0,
         "args": f"python cauce-container-runtime.py run --alias {row['runtime_key']} --container-id a{i}"}
        for i, row in enumerate(inventory.values())])
    monkeypatch.setattr(doctor, "unidades", lambda host: {
        row["runtime_key"]: {"host": host, "active": "active", "sub": "running", "unidad": row["runtime_key"]}
        for row in inventory.values()})
    summary = {"libro": {}, "hallazgos": [], "reenviados": [], "cuentas": {}, "total": 0, "plan": {"saltados": []}}
    monkeypatch.setattr(doctor, "libro_tareas", SimpleNamespace(
        correr=lambda *_args: summary, fusionar_hallazgos=lambda *_args: ([], [])))
    publications = []

    def host_transport(host, command, entrada=None, **kwargs):
        if command == doctor.PG:
            return transport(host, command, entrada, **kwargs)
        if command.startswith("cat "):
            return 0, json.dumps({"capturedAt": clock[0].isoformat(), "accounts": [
                {"label": label, "ok": True, "remainingPercent": 0, "resetInSeconds": 86400, "window": "weekly"}
                for label in ("steven", "b2b")]}), ""
        if command.startswith("for C "):
            return 0, cron_lines, ""
        if "openclaw cron show" in command:
            return 1, "", ""
        if command == "python3 -" and "getWebhookInfo" in entrada:
            return 0, "[]", ""
        if command == "python3 -":
            publications.append(entrada)
            return 0, "202\n{}", ""
        pytest.fail(f"Unexpected host operation: {host} {command}")

    monkeypatch.setattr(doctor, "sh", host_transport)
    return clock, publications


def test_account_and_loop_reach_logs_dispatch_and_keep_memory(transport, finding_inventory, monkeypatch, tmp_path):
    clock, publications = prepare_alarm_run(transport, monkeypatch, tmp_path, finding_inventory,
        "ws-zeus|alarm every 5m anthropic/claude\nforeign-container|00000000-0000-0000-0000-000000000000 every 5m anthropic/claude")
    monkeypatch.setattr(doctor, "sonda_credenciales", lambda _: ([], {}))
    assert doctor.main() == 0
    record = json.loads(pathlib.Path(doctor.BITACORA_JSONL).read_text().splitlines()[0])
    assert {item["tipo"] for item in record["escalar"]} == {"cuenta_ia", "bucle_de_cuota"}
    assert record["sondas_rotas"] == []
    log = pathlib.Path(doctor.BITACORA_LOG).read_text()
    assert "steven" in log and "b2b" in log and "ws-zeus" in log
    assert len(publications) == 1
    assert all(subject in publications[0] for subject in ("cuenta_ia", "bucle_de_cuota", "steven", "b2b", "ws-zeus"))
    assert "GUARDIA CIEGO" not in publications[0] and "foreign-container" not in log
    state = json.loads(pathlib.Path(doctor.ESTADO_JSON).read_text())["hallazgos_vistos"]
    assert set(state) == {"cuenta_ia|-|steven", "cuenta_ia|-|b2b", "bucle_de_cuota|Steven|zeus"}
    clock[0] += datetime.timedelta(minutes=15)
    assert doctor.main() == 0
    assert len(publications) == 1
    state = json.loads(pathlib.Path(doctor.ESTADO_JSON).read_text())["hallazgos_vistos"]
    assert all(item["veces"] == 2 and item["ultimo_despacho"] for item in state.values())


def test_credential_dispatch_waits_six_hours(transport, finding_inventory, monkeypatch, tmp_path):
    clock, publications = prepare_alarm_run(transport, monkeypatch, tmp_path, finding_inventory, "")
    expiry = [-1]
    monkeypatch.setattr(doctor, "sonda_credenciales", lambda _: ([{
        "tenant": "Steven", "alias": "jarvis", "detalle": f"access vence en {expiry[0]} h"}], {}))
    assert doctor.main() == 0
    assert "credencial" in publications[0]
    clock[0] += datetime.timedelta(hours=1)
    expiry[0] = -2
    assert doctor.main() == 0
    assert len(publications) == 1
    state = json.loads(pathlib.Path(doctor.ESTADO_JSON).read_text())["hallazgos_vistos"]
    assert state["credencial|Steven|jarvis"]["veces"] == 2
    clock[0] += datetime.timedelta(hours=5)
    assert doctor.main() == 0
    assert len(publications) == 2


if __name__ == "__main__":
    sys.exit(pytest.main(["-q", __file__]))
