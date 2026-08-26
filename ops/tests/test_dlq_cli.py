#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, os.fspath(ROOT / "scripts"))

import dlq_cli  # noqa: E402


SHA = "a" * 64
OTHER_SHA = "b" * 64
LETTER_ID = "00000000-0000-4000-8000-000000000030"


class FakeRunner:
    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.queries: list[str] = []

    def query_json(self, sql: str) -> dict[str, object]:
        self.queries.append(sql)
        return dict(self.response)


class DlqCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-dlq-cli-")
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def private_file(self, name: str, value: object) -> pathlib.Path:
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        path.chmod(0o600)
        return path

    def output(self, name: str = "evidence.json") -> pathlib.Path:
        return self.root / name

    def test_tenant_shape_has_no_embedded_catalog(self) -> None:
        dlq_cli.validate_actor("FutureTenant_2030", "future_operator")
        for tenant in ("", "bad.tenant", "-invalid", "x" * 65):
            with self.subTest(tenant=tenant), self.assertRaises(dlq_cli.CliError):
                dlq_cli.validate_actor(tenant, "future_operator")
        source = (ROOT / "scripts" / "dlq_cli.py").read_text(encoding="utf-8")
        self.assertNotIn("TENANTS =", source)
        self.assertNotIn("{'Steven'", source)

    def test_private_input_and_output_are_fail_closed(self) -> None:
        request = self.private_file("request.json", {"schemaVersion": 1})
        self.assertEqual(dlq_cli.private_json(request), {"schemaVersion": 1})
        request.chmod(0o644)
        with self.assertRaisesRegex(dlq_cli.CliError, "0400/0600"):
            dlq_cli.private_json(request)

        target = self.private_file("target.json", {"schemaVersion": 1})
        link = self.root / "link.json"
        link.symlink_to(target)
        with self.assertRaises(dlq_cli.CliError):
            dlq_cli.private_json(link)

        evidence = self.output()
        dlq_cli.write_evidence(evidence, {"safe": True})
        self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o600)
        with self.assertRaisesRegex(dlq_cli.CliError, "already exists"):
            dlq_cli.write_evidence(evidence, {"safe": False})

    def test_container_transport_verifies_exact_compose_identity_and_sanitizes_errors(self) -> None:
        calls: list[list[str]] = []

        def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            if command[:2] == ["docker", "inspect"]:
                return subprocess.CompletedProcess(command, 0, "cauce-v3-prod|postgres|true\n", "")
            return subprocess.CompletedProcess(command, 1, "", "secret database diagnostics")

        runner = dlq_cli.PostgresRunner(postgres_container="cauce-postgres", run=run)
        with self.assertRaisesRegex(dlq_cli.CliError, "rejected the requested") as rejected:
            runner.query_json("SELECT 1")
        self.assertNotIn("secret", str(rejected.exception))
        self.assertEqual(calls[0][:2], ["docker", "inspect"])

        def wrong_identity(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(command, 0, "other|postgres|true\n", "")

        with self.assertRaisesRegex(dlq_cli.CliError, "canonical running production"):
            dlq_cli.PostgresRunner(postgres_container="cauce-postgres", run=wrong_identity)

    def test_manual_replay_requires_explicit_ack_and_emits_only_sanitized_evidence(self) -> None:
        request_value = {
            "schemaVersion": 1,
            "requestId": LETTER_ID,
            "id": LETTER_ID,
            "evidenceSha256": OTHER_SHA,
            "chunkIndex": 0,
            "effectSha256": SHA,
            "expectedReplayCount": 0,
            "reason": "approved incident review",
            "actorTenant": "FutureTenant_2030",
            "actorAlias": "future_operator",
            "duplicateRiskAcknowledged": True,
        }
        request = self.private_file("manual.json", request_value)
        runner = FakeRunner({
            "schemaVersion": 1,
            "suite": "cauce-v3-telegram-manual-replay",
            "phase": "scheduled",
            "appliedCount": 1,
            "alreadyApplied": False,
            "replaySequence": 1,
            "effectSha256": SHA,
            "evidenceSha256": OTHER_SHA,
            "duplicateRisk": True,
            "warning": "duplicate delivery remains possible",
        })
        output = self.output("manual-evidence.json")
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner):
            result = dlq_cli.private_request_main("telegram-manual-replay", [
                "--request", os.fspath(request), "--output", os.fspath(output),
                "--postgres-container", "unused-by-fake",
            ])
        self.assertEqual(result, 0)
        self.assertIn("FutureTenant_2030", runner.queries[0])
        self.assertTrue(runner.queries[0].rstrip().endswith(f"'{OTHER_SHA}',0)::text;"))
        serialized = output.read_text(encoding="utf-8")
        self.assertNotIn("internal-effect-030", serialized)
        self.assertNotIn("approved incident review", serialized)
        self.assertNotIn("future_operator", serialized)

        request_value["duplicateRiskAcknowledged"] = False
        rejected = self.private_file("manual-rejected.json", request_value)
        runner.queries.clear()
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner), self.assertRaisesRegex(
            dlq_cli.CliError, "not acknowledged"
        ):
            dlq_cli.private_request_main("telegram-manual-replay", [
                "--request", os.fspath(rejected), "--output", os.fspath(self.output("unused.json")),
                "--postgres-container", "unused-by-fake",
            ])
        self.assertEqual(runner.queries, [])

    def test_no_replay_request_keeps_both_risk_acknowledgements_explicit(self) -> None:
        request = self.private_file("resolve.json", {
            "schemaVersion": 1,
            "target": "outbox",
            "id": LETTER_ID,
            "evidenceSha256": SHA,
            "reason": "reviewed with no replay",
            "actorTenant": "Steven",
            "actorAlias": "kant",
            "possibleDuplicateAcknowledged": False,
            "possibleNoDeliveryAcknowledged": True,
        })
        runner = FakeRunner({
            "schemaVersion": 1,
            "suite": "cauce-v3-dlq-no-replay-resolution",
            "phase": "resolved",
            "appliedCount": 1,
            "alreadyApplied": False,
            "evidenceSha256": SHA,
            "reasonSha256": OTHER_SHA,
            "possibleDuplicateAcknowledged": False,
            "possibleNoDeliveryAcknowledged": True,
        })
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner):
            self.assertEqual(dlq_cli.private_request_main("resolve-without-replay", [
                "--request", os.fspath(request), "--output", os.fspath(self.output()),
                "--postgres-container", "unused-by-fake",
            ]), 0)
        self.assertIn(",false,true)::text;", runner.queries[0])

    def test_private_replay_inspect_is_scoped_and_emits_only_safe_effect_coordinates(self) -> None:
        request = self.private_file("inspect-replay.json", {
            "schemaVersion": 1, "id": LETTER_ID, "evidenceSha256": SHA,
            "actorTenant": "Steven", "actorAlias": "kant",
        })
        runner = FakeRunner({
            "schemaVersion": 1,
            "suite": "cauce-v3-telegram-replay-inspect",
            "phase": "inspect",
            "id": LETTER_ID,
            "evidenceSha256": SHA,
            "items": [{
                "chunkIndex": 0, "effectSha256": OTHER_SHA,
                "state": "prepared", "replayCount": 0, "duplicateRisk": False,
            }],
            "total": 1,
        })
        output = self.output("inspect-replay-evidence.json")
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner):
            self.assertEqual(dlq_cli.private_replay_inspect_main([
                "--request", os.fspath(request), "--output", os.fspath(output),
                "--postgres-container", "unused-by-fake",
            ]), 0)
        self.assertIn("cauce_inspect_telegram_replay_030", runner.queries[0])
        self.assertIn(f"'{LETTER_ID}'::uuid", runner.queries[0])
        serialized = output.read_text(encoding="utf-8")
        self.assertNotIn("internal-effect-030", serialized)
        self.assertIn('"chunkIndex":0', serialized)
        self.assertNotIn("actorAlias", serialized)
        self.assertNotIn("provider", serialized)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

    def test_safe_list_rejects_extra_or_sensitive_fields(self) -> None:
        item = {
            "target": "outbox", "id": LETTER_ID, "tenantId": "Steven", "kind": "origin_relay",
            "adapter": "telegram", "disposition": "ambiguous", "open": True,
            "actionable": True, "evidenceSha256": SHA, "attempts": 3,
            "resolutionRule": None, "createdAt": "2026-08-26T00:00:00Z",
            "dispositionAt": "2026-08-26T00:01:00Z", "resolvedAt": None,
            "reopenCount": 0, "lastReopenedAt": None,
        }
        runner = FakeRunner({
            "schemaVersion": 1, "items": [item], "total": 1,
            "truncated": False, "nextCursor": None,
        })
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner):
            self.assertEqual(dlq_cli.list_main([
                "--actor-tenant", "Steven", "--actor-alias", "kant",
                "--output", os.fspath(self.output()), "--postgres-container", "unused-by-fake",
            ]), 0)
        self.assertIn(",200,NULL)::text;", runner.queries[0])

        runner.response = {
            "schemaVersion": 1, "items": [item], "total": 2,
            "truncated": True, "nextCursor": "aa",
        }
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner):
            self.assertEqual(dlq_cli.list_main([
                "--actor-tenant", "Steven", "--actor-alias", "kant", "--cursor", "aa",
                "--output", os.fspath(self.output("page-2.json")),
                "--postgres-container", "unused-by-fake",
            ]), 0)
        self.assertIn(",200,'aa')::text;", runner.queries[1])

        runner.response = {
            "schemaVersion": 1,
            "items": [{**item, "payload": {"secret": True}}],
            "total": 1,
            "truncated": False,
            "nextCursor": None,
        }
        with mock.patch.object(dlq_cli, "runner_from", return_value=runner), self.assertRaisesRegex(
            dlq_cli.CliError, "versioned contract"
        ):
            dlq_cli.list_main([
                "--actor-tenant", "Steven", "--actor-alias", "kant",
                "--output", os.fspath(self.output("bad.json")), "--postgres-container", "unused-by-fake",
            ])


class DlqSchemaTests(unittest.TestCase):
    def validate(self, schema_name: str, value: object) -> None:
        schema = json.loads((ROOT / "schemas" / schema_name).read_text(encoding="utf-8"))
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)

    def test_request_and_safe_list_schemas_accept_exact_contracts(self) -> None:
        self.validate("telegram-manual-replay-request.schema.json", {
            "schemaVersion": 1, "requestId": LETTER_ID, "id": LETTER_ID,
            "evidenceSha256": OTHER_SHA, "chunkIndex": 0, "effectSha256": SHA,
            "expectedReplayCount": 0,
            "reason": "reviewed", "actorTenant": "FutureTenant_2030",
            "actorAlias": "future_operator", "duplicateRiskAcknowledged": True,
        })
        self.validate("telegram-replay-inspect-request.schema.json", {
            "schemaVersion": 1, "id": LETTER_ID, "evidenceSha256": SHA,
            "actorTenant": "Steven", "actorAlias": "kant",
        })
        self.validate("telegram-replay-inspect.schema.json", {
            "schemaVersion": 1, "suite": "cauce-v3-telegram-replay-inspect",
            "phase": "inspect", "generatedAt": "2026-08-26T00:00:00Z",
            "id": LETTER_ID, "evidenceSha256": SHA, "total": 1,
            "items": [{
                "chunkIndex": 0, "effectSha256": OTHER_SHA,
                "state": "prepared", "replayCount": 0, "duplicateRisk": False,
            }],
        })
        self.validate("dlq-no-replay-resolution-request.schema.json", {
            "schemaVersion": 1, "target": "delivery", "id": LETTER_ID,
            "evidenceSha256": SHA, "reason": "reviewed", "actorTenant": "Steven",
            "actorAlias": "kant", "possibleDuplicateAcknowledged": True,
            "possibleNoDeliveryAcknowledged": True,
        })
        self.validate("dlq-safe-list.schema.json", {
            "schemaVersion": 1, "suite": "cauce-v3-dlq-safe-list", "phase": "list",
            "generatedAt": "2026-08-26T00:00:00Z", "total": 1, "truncated": False,
            "nextCursor": None,
            "items": [{
                "target": "delivery", "id": LETTER_ID, "tenantId": "Steven",
                "kind": "delivery", "adapter": None, "disposition": "safe_retry",
                "open": False, "actionable": False, "evidenceSha256": SHA, "attempts": 3,
                "resolutionRule": "operator_no_replay_v1", "createdAt": "2026-08-26T00:00:00Z",
                "dispositionAt": "2026-08-26T00:01:00Z", "resolvedAt": "2026-08-26T00:02:00Z",
                "reopenCount": 0, "lastReopenedAt": None,
            }],
        })


if __name__ == "__main__":
    unittest.main()
