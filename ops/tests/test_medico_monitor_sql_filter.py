#!/usr/bin/env python3
"""Hermetic regressions for the doctor's closed, company-scoped SQL reader."""
from __future__ import annotations

import ast
import importlib.machinery
import importlib.util
import pathlib

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "guardias/cauce-v3-medico-monitor"
loader = importlib.machinery.SourceFileLoader("medico_sql_filter", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


@pytest.fixture(autouse=True)
def no_external_operations(monkeypatch):
    monkeypatch.setenv("CAUCE_GUARD_COMPANY_ID", "alpha")
    monkeypatch.setattr(doctor, "DOCTOR_INVENTORY", {})

    def forbidden_transport(*_args, **_kwargs):
        pytest.fail("A hermetic SQL test attempted an external operation")

    monkeypatch.setattr(doctor, "sh", forbidden_transport)
    monkeypatch.setattr(doctor.subprocess, "run", forbidden_transport)


@pytest.mark.parametrize("query", [
    "UPDATE messages SET priority=priority RETURNING *",
    "DELETE FROM messages RETURNING *",
    "SELECT query_to_xml('select * from messages',true,false,'')",
    "SELECT table_to_xml('messages',true,false,'')",
    "SELECT schema_to_xml('public',true,false,'')",
    "SELECT * FROM cauce_oauth_tokens t WINDOW cauce_oauth_tokens AS (ORDER BY 1)",
    "SELECT u.* FROM provider_accounts u WHERE EXISTS (WITH provider_accounts AS (SELECT 1) SELECT 1)",
    "WITH a AS (SELECT * FROM secret_handoffs), secret_handoffs AS (SELECT 1) SELECT * FROM a",
])
def test_review_attacks_fail_before_any_transport(query):
    with pytest.raises(ValueError):
        doctor.company_scoped_query(query)
    with pytest.raises(ValueError):
        doctor.sql(query)


@pytest.mark.parametrize("query", [
    "WITH change AS (INSERT INTO messages DEFAULT VALUES RETURNING *) SELECT * FROM change",
    "WITH change AS (UPDATE messages SET priority=priority RETURNING *) SELECT * FROM change",
    "WITH change AS (DELETE FROM messages RETURNING *) SELECT * FROM change",
    "MERGE INTO messages USING tenants ON false WHEN MATCHED THEN DELETE",
    "SELECT * INTO copied FROM messages",
    "TRUNCATE messages",
    "COPY messages TO STDOUT",
    "CALL mutate_messages()",
    "DO 'BEGIN DELETE FROM messages; END'",
    "GRANT SELECT ON messages TO reader",
    "ALTER TABLE messages ADD COLUMN stolen text",
    "CREATE TABLE copied AS SELECT * FROM messages",
    "DROP TABLE messages",
    "VALUES (1)",
    "(SELECT * FROM messages)",
    "",
])
def test_only_read_queries_and_no_write_tokens_are_accepted(query):
    with pytest.raises(ValueError):
        doctor.company_scoped_query(query)


@pytest.mark.parametrize("expression", [
    "query_to_xml_and_xmlschema('select * from messages',true,false,'')",
    "table_to_xmlschema('messages',true,false,'')",
    "schema_to_xmlschema('public',true,false,'')",
    "database_to_xml(true,false,'')",
    "table_to_json('messages')",
    "dblink('connection', 'select * from messages')",
    "dblink_exec('connection', 'delete from messages')",
    "lo_get(1)",
    "pg_read_file('fixture')",
    "pg_ls_dir('fixture')",
    "pg_sleep(1)",
    "current_setting('fixture')",
    "set_config('fixture','value',false)",
    "nextval('fixture')",
    "custom_reader('messages')",
    "public.count(*)",
    "pg_catalog.count(*)",
    "count(public.custom_reader('messages'))",
    "by('messages')",
    "materialized('messages')",
    "cast('messages' AS regclass)",
    "'messages'::regclass",
    "cast('messages' AS custom_type)",
    "cast('messages' AS public.custom_type)",
    "'messages'::custom_type",
    "public.custom_type 'messages'",
    "public . interval 'messages'",
    "public . timestamp 'messages'",
])
def test_unknown_or_qualified_functions_and_relation_casts_are_rejected(expression):
    with pytest.raises(ValueError):
        doctor.company_scoped_query("SELECT " + expression)


@pytest.mark.parametrize("query", [
    "SELECT * FROM provider_accounts",
    "SELECT * FROM secret_handoffs",
    "SELECT * FROM cauce_oauth_tokens",
    "WITH a AS (SELECT * FROM future), future AS (SELECT 1) SELECT * FROM a",
    "WITH a AS (SELECT * FROM a) SELECT * FROM a",
    "WITH a AS (SELECT 1), a AS (SELECT 2) SELECT * FROM a",
    "WITH messages AS (SELECT 1) SELECT * FROM messages",
    "SELECT * FROM messages WHERE EXISTS (WITH a AS (SELECT 1) SELECT * FROM a)",
    "WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) SELECT * FROM a",
    "WITH RECURSIVE a AS (SELECT 1) SELECT * FROM a",
    "SELECT * FROM messages WHERE EXISTS (WITH RECURSIVE a AS (SELECT 1) SELECT * FROM a)",
    "SELECT count(*) OVER w FROM messages WINDOW w AS (ORDER BY id)",
    "WITH a(id) AS (SELECT 1) SELECT * FROM a",
    "WITH a AS (SELECT 1) TABLE a",
    "WITH a AS (VALUES (1)) SELECT * FROM a",
    "SELECT * FROM public.messages",
    "SELECT * FROM (messages m JOIN tenants t ON true)",
    "SELECT * FROM messages m, messages other",
    "SELECT * FROM (SELECT * FROM messages",
    "SELECT * FROM messages)",
])
def test_cte_scope_and_relation_subset_fail_closed(query):
    with pytest.raises(ValueError):
        doctor.company_scoped_query(query)


@pytest.mark.parametrize("query", [
    "SELECT substring(body::text FROM 2) FROM messages",
    "SELECT trim(' ' FROM body::text) FROM messages",
    "SELECT * FROM messages WHERE id IS DISTINCT FROM 1",
    "SELECT * FROM generate_series(1,2)",
    "SELECT * FROM unnest(ARRAY[1,2])",
    "SELECT * FROM count(*)",
])
def test_documented_unsupported_expressions_and_function_relations_are_rejected(query):
    with pytest.raises(ValueError):
        doctor.company_scoped_query(query)


@pytest.mark.parametrize("query", [
    "SELECT 1",
    "SELECT 'delete update copy query_to_xml(secret_handoffs) WITH RECURSIVE WINDOW'",
    "SELECT tenant_id,'escaped '' literal' FROM messages",
    "SELECT count(*) FROM messages WHERE tenant_id IN ('Fixture','Other')",
    "SELECT cast('1' AS integer)",
    "SELECT extract(epoch FROM (now()-created_at)) FROM messages",
    "SELECT m.id FROM messages m JOIN tenants t ON t.id=m.tenant_id",
    "SELECT id FROM messages UNION ALL SELECT id FROM messages",
    "SELECT * FROM (SELECT id FROM messages) owned",
    "WITH a AS (SELECT id FROM messages) SELECT * FROM a",
    "WITH a AS (SELECT id FROM messages), b AS (SELECT * FROM a) SELECT * FROM b",
    "WITH a AS MATERIALIZED (SELECT id FROM messages), "
    "b AS NOT MATERIALIZED (SELECT * FROM a) SELECT * FROM b",
    "WITH a AS (SELECT 1) SELECT * FROM a WHERE EXISTS (SELECT * FROM a)",
])
def test_supported_queries_preserve_literals_and_scope_all_data_relations(query):
    scoped = doctor.company_scoped_query(query)
    assert query.lstrip().removeprefix("WITH ") in scoped
    if "FROM messages" in query:
        assert "messages AS (SELECT * FROM public.messages" in scoped
        assert "company_id='alpha'" in scoped


def test_sql_wraps_copy_in_quiet_read_only_transaction(monkeypatch):
    def transport(host, command, entrada=None):
        assert host == "agora" and command == doctor.PG
        assert "-XqAt" in command
        assert entrada == (
            "BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog;\n"
            "COPY (SELECT 1) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);\nCOMMIT;"
        )
        return 0, '"1"\n', ""

    monkeypatch.setattr(doctor, "sh", transport)
    assert doctor.sql("SELECT 1", columnas=1) == [["1"]]


def test_all_doctor_book_and_evidence_queries_pass_without_database(monkeypatch):
    captured = []

    def transport(host, command, entrada=None):
        assert host == "agora" and command == doctor.PG
        assert entrada.startswith("BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog;\nCOPY (")
        assert entrada.endswith(";\nCOMMIT;")
        assert "company_id='alpha'" in entrada
        captured.append(entrada)
        return 0, "", ""

    monkeypatch.setattr(doctor, "sh", transport)
    context = {**vars(doctor), "tenant": "Fixture", "alias": "worker", "horas": 24}
    sources = [SCRIPT, *SCRIPT.parent.glob("cauce-v3-medico-monitor-*-lib.py")]
    calls = 0
    evidence = set()
    for source in sources:
        for node in ast.walk(ast.parse(source.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "sql":
                query = eval(compile(ast.Expression(node.args[0]), str(source), "eval"), context)
                kwargs = {keyword.arg: eval(compile(ast.Expression(keyword.value), str(source), "eval"), context)
                          for keyword in node.keywords}
                doctor.sql(query, **kwargs)
                calls += 1
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values, strict=True):
                    if isinstance(key, ast.Constant) and key.value == "consulta":
                        for table in ("dead_letters", "outbox_dead_letters"):
                            evidence.add(eval(compile(ast.Expression(value), str(source), "eval"),
                                              {**context, "tabla": table}))
    assert calls == 11, "Update coverage for new doctor SQL calls"
    assert len(evidence) == 3, "Update coverage for new evidence query templates"
    for hours in (24, doctor.libro_tareas.VENTANA_DERIVACION_H):
        doctor.sql(doctor.libro_tareas.consulta(hours), columnas=1)
    for query in sorted(evidence):
        doctor.sql(query)
    assert len(captured) == 16


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
