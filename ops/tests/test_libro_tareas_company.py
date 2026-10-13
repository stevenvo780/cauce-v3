from __future__ import annotations

# cauce:requiere docker
import ast
import datetime
import importlib.machinery
import importlib.util
import json
import pathlib
import shutil
import sys
from types import SimpleNamespace

import pytest
from test_conversaciones_paralelas_postgres import postgres_fixture
from test_medico_monitor_company_isolation import doctor

ROOT = pathlib.Path(__file__).resolve().parents[2]
GUARDS = ROOT / "ops/guardias"
BOOK = GUARDS / "libro_tareas.py"
book = doctor.libro_tareas

SCHEMA = """
create table tenants(id text primary key, company_id text not null);
create table messages(id text primary key, tenant_id text references tenants, actor_alias text,
                     created_at timestamptz, body jsonb);
create table deliveries(id text primary key, message_id text references messages,
  recipient_tenant text references tenants, recipient_alias text, status text, attempt int,
  created_at timestamptz, terminal_at timestamptz, last_error text, result jsonb, late_result_at timestamptz);
create table audit_events(tenant_id text, message_id text, action text, metadata jsonb, company_id text);
create table dead_letters(tenant_id text references tenants, resolved_at timestamptz, created_at timestamptz);
create table outbox_dead_letters(tenant_id text references tenants, resolved_at timestamptz, created_at timestamptz);
insert into tenants values ('AlphaA','alpha'),('AlphaB','alpha'),('Beta','beta');
with seed(id,source,recipient,alias,kind,status,text) as (values
 ('101','AlphaA','AlphaA','worker','agent.message','failed',repeat('necesito revisar la tarea ',8)),
 ('102','AlphaB','AlphaB','helper','agent.message','done',repeat('necesito verificar el trabajo ',8)),
 ('201','Beta','Beta','worker','agent.message','failed',repeat('necesito foreign-private ',8)),
 ('301','Beta','AlphaA','worker','agent.message','failed',repeat('necesito foreign-source ',8)),
 ('302','AlphaA','Beta','worker','agent.message','failed',repeat('necesito foreign-target ',8)),
 ('401','AlphaA','AlphaA','worker','agent.response','done','replayed without owned audit'),
 ('501','Beta','AlphaA','requester','agent.response','done','completed 101 foreign closure')
), inserted as (
 insert into messages select id,source,'requester',now()-interval '2 hours',
    jsonb_build_object('type',kind,'text',text,'guardia','cauce-medico-monitor') from seed returning id
)
insert into deliveries select id,id,recipient,alias,status,1,now()-interval '2 hours',now()-interval '1 hour',
 null,jsonb_build_object('output',jsonb_build_object('reply','voy a revisar el trabajo')),null
 from seed join inserted using(id);
update messages set created_at=now() where id='501';
insert into audit_events values
 ('AlphaA','401','delivery.replay','{"replayed_from_message_id":"101"}','beta'),
 ('Beta','401','delivery.replay','{"replayed_from_message_id":"101"}',null),
 ('AlphaA','201','delivery.replay','{"replayed_from_message_id":"101"}',null);
insert into dead_letters values ('AlphaA',null,now()),('Beta',null,now());
insert into outbox_dead_letters values ('AlphaB',null,now()),('Beta',null,now());
"""


@pytest.fixture(scope="module")
def pg():
    with postgres_fixture() as database:
        result = database.run_sql(SCHEMA)
        assert result.returncode == 0, result.stderr
        yield database


@pytest.fixture
def scoped_sql(pg, monkeypatch):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "alpha")

    def read(query):
        scoped = doctor.company_scoped_query(query.rstrip().rstrip(";"))
        result = pg.run_sql(scoped)
        assert result.returncode == 0, result.stderr
        return [line.split("\t") for line in result.stdout.splitlines()]

    return read


def evidence_queries(tenant):
    queries = set()
    sources = [GUARDS / "cauce-v3-medico-monitor", *GUARDS.glob("cauce-v3-medico-monitor-*-lib.py")]
    for source in sources:
        for node in ast.walk(ast.parse(source.read_text())):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values, strict=True):
                if isinstance(key, ast.Constant) and key.value == "consulta":
                    expression = compile(ast.Expression(value), str(source), "eval")
                    for table in ("dead_letters", "outbox_dead_letters"):
                        queries.add(eval(expression, {"tabla": table, "tenant": tenant, "alias": "worker"}))
    assert len(queries) == 3, "Update coverage for new evidence query templates"
    return sorted(queries)


@pytest.mark.parametrize("hours", [24, book.VENTANA_DERIVACION_H])
@pytest.mark.parametrize("company,ids,tenants", [
    ("alpha", {"101", "102"}, {"AlphaA", "AlphaB"}), ("beta", {"201"}, {"Beta"}),
])
def test_real_book_query_isolates_both_sides_and_correlated_evidence(scoped_sql, monkeypatch, hours, company, ids, tenants):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", company)
    rows = [json.loads(row[0]) for row in scoped_sql(book.consulta(hours))]
    assert {row["encargo_id"] for row in rows} == ids
    assert {row["tenant"] for row in rows} == tenants
    assert all(not row["reintento_exitoso"] and not row["retomado_por_mensaje_nuevo"] for row in rows)


def test_own_replay_and_own_closure_remain_visible(scoped_sql, pg):
    result = pg.run_sql("""
    begin;
    insert into audit_events values ('AlphaA','401','delivery.replay','{"replayed_from_message_id":"101"}','alpha');
    insert into messages values ('601','AlphaA','worker',now(),'{"type":"agent.response","text":"completed 101"}');
    insert into deliveries(id,message_id,recipient_tenant,recipient_alias,status)
      values ('601','601','AlphaA','requester','done');
    commit;
    """)
    assert result.returncode == 0, result.stderr
    try:
        rows = {row["encargo_id"]: row for row in book.leer_filas(scoped_sql)}
        assert rows["101"]["reintento_exitoso"] is True
        assert rows["101"]["retomado_por_mensaje_nuevo"] is True
        assert rows["102"]["reintento_exitoso"] is False
        assert rows["102"]["retomado_por_mensaje_nuevo"] is False
    finally:
        result = pg.run_sql("DELETE FROM audit_events WHERE company_id='alpha'; "
                            "DELETE FROM deliveries WHERE id='601'; DELETE FROM messages WHERE id='601';")
        assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("company,tenant,other", [("alpha", "AlphaA", "Beta"), ("beta", "Beta", "AlphaA")])
def test_each_known_evidence_query_uses_real_scoped_postgres(scoped_sql, monkeypatch, company, tenant, other):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", company)
    for query in evidence_queries(tenant):
        rows = scoped_sql(query)
        assert rows, query
        assert other not in repr(rows)
        assert "foreign-source" not in repr(rows) and "foreign-target" not in repr(rows)
        assert book.verificar({"tipo": "sql_no_vacio", "consulta": query}, {"sql": scoped_sql})["ok"] is True
    assert book.verificar({"tipo": "sql_no_vacio"}, {"sql": scoped_sql})["ok"] is False
    foreign_only = f"select * from messages where tenant_id='{other}'"
    assert book.verificar({"tipo": "sql_no_vacio", "consulta": foreign_only}, {"sql": scoped_sql})["ok"] is False


def test_real_book_run_persists_only_owned_tasks_and_verified_evidence(scoped_sql, tmp_path):
    paths = {key: str(tmp_path / name) for key, name in (
        ("libro", "book.json"), ("md", "book.md"), ("evidencia", "evidence.json"))}
    pathlib.Path(paths["evidencia"]).write_text(json.dumps({"reglas": [{
        "cuando": {"responsable": "helper"},
        "espera": [{"tipo": "sql_no_vacio", "consulta": "select * from messages where id='102'"}],
    }]}))
    outcome = book.correr({"sql": scoped_sql, "reenviar": False}, paths)
    assert set(outcome["libro"]["encargos"]) == {"101", "102"}
    assert outcome["libro"]["encargos"]["101"]["estado"] == book.ENTREGADO_SV
    assert outcome["libro"]["encargos"]["102"]["estado"] == book.CUMPLIDO
    assert outcome["reenviados"] == []
    persisted = pathlib.Path(paths["libro"]).read_text() + pathlib.Path(paths["md"]).read_text()
    assert "Beta" not in persisted and "foreign-" not in persisted
    again = book.correr({"sql": scoped_sql, "reenviar": False}, paths)
    assert again["nuevos"] == 0 and again["total"] == 2


@pytest.mark.parametrize("source_state", ["present", "missing", "broken"])
def test_installed_doctor_loads_exact_sibling_even_with_cached_foreign_module(tmp_path, monkeypatch, source_state):
    for source in [GUARDS / "cauce-v3-medico-monitor", GUARDS / "credential_health.py", BOOK,
                   *GUARDS.glob("cauce-v3-medico-monitor-*-lib.py")]:
        shutil.copyfile(source, tmp_path / source.name)
    installed_book = tmp_path / BOOK.name
    if source_state == "missing":
        installed_book.unlink()
    elif source_state == "broken":
        installed_book.write_text("raise RuntimeError('fixture book failure')")
    shadow = SimpleNamespace(consulta=lambda: pytest.fail("A cached foreign book was used"))
    monkeypatch.setitem(sys.modules, "libro_tareas", shadow)
    previous_path = sys.path[:]
    try:
        loader = importlib.machinery.SourceFileLoader("installed_doctor_fixture", str(tmp_path / "cauce-v3-medico-monitor"))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        installed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installed)
    finally:
        sys.path[:] = previous_path
    if source_state == "present":
        assert installed.libro_tareas.__file__ == str(installed_book)
        assert installed.libro_tareas.consulta() == book.consulta()
    else:
        assert installed.libro_tareas is None
        assert ("FileNotFoundError" if source_state == "missing" else "RuntimeError") in installed._MOTIVO_SIN_LIBRO


def test_remote_systemd_configuration_is_neutral_and_validated(monkeypatch):
    for variable in ("CAUCE_LIBRO_LOCAL_HOST", "CAUCE_LIBRO_SYSTEMD_USER", "CAUCE_LIBRO_SYSTEMD_UID"):
        monkeypatch.delenv(variable, raising=False)
    assert book.systemd_command("localhost") == "systemctl --user"
    outcome = book.verificar({"tipo": "unidad_activa", "host": "remote", "unidad": "fixture.service"},
                             {"sh": lambda *_args: pytest.fail("Unconfigured remote probe was executed")})
    assert outcome["ok"] is None
    monkeypatch.setenv("CAUCE_LIBRO_SYSTEMD_USER", "fixture_user")
    monkeypatch.setenv("CAUCE_LIBRO_SYSTEMD_UID", "1234")
    assert book.systemd_command("remote") == "sudo -u fixture_user XDG_RUNTIME_DIR=/run/user/1234 systemctl --user"
    monkeypatch.setenv("CAUCE_LIBRO_SYSTEMD_USER", "bad;command")
    with pytest.raises(ValueError, match="remote systemd evidence"):
        book.systemd_command("remote")


def test_retry_fences_and_failed_publications_keep_the_deployed_limits():
    now = datetime.datetime.now(datetime.UTC)
    pending = {"encargo_id": "fixture-task", "responsable": "worker", "estado": book.PENDIENTE,
               "pedido_en": (now - datetime.timedelta(hours=2)).isoformat()}
    ledger = {"encargos": {pending["encargo_id"]: pending}}
    assert not book.plan_reanudacion(ledger, {"ahora": now, "online": set()})["reenviar"]
    assert not book.plan_reanudacion(ledger, {"ahora": now, "online": {"worker"}, "en_vuelo": {"worker"}})["reenviar"]
    for _ in range(book.MAX_REINTENTOS):
        book.aplicar_reenvio(ledger, pending["encargo_id"], False, now, "fixture publication failed")
    assert pending["reintentos"] == book.MAX_REINTENTOS and pending["estado"] == book.BLOQUEADO
    assert not book.plan_reanudacion(ledger, {"ahora": now, "online": {"worker"}})["reenviar"]
