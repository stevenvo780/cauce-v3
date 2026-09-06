from __future__ import annotations

import datetime
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock

# cauce:requiere none

ROOT = pathlib.Path(__file__).resolve().parents[2]
INSTANCE = ROOT / "ops" / "instances" / "hospital"


class HospitalInstanceTests(unittest.TestCase):
    def backup_fixture(self, directory: pathlib.Path) -> pathlib.Path:
        dump_root = directory / "dumps"
        dump_root.mkdir(mode=0o700)
        dump = dump_root / "cauce-hospital-fixture.dump"
        dump.write_bytes(b"verified-dump")
        dump.chmod(0o600)
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        sidecar = pathlib.Path(f"{dump}.sha256")
        sidecar.write_text(f"{digest}  {dump.name}\n", encoding="ascii")
        sidecar.chmod(0o600)
        evidence = pathlib.Path(f"{dump}.restore.json")
        evidence.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "suite": "hospital-cauce-backup-restore",
                    "dump_file": dump.name,
                    "dump_sha256": digest,
                    "database_image_digest": "sha256:" + "a" * 64,
                    "migration_count": 41,
                    "tenant_count": 1,
                    "room_count": 1,
                    "agent_count": 3,
                    "profile_count": 3,
                    "membership_count": 4,
                    "acl_edge_count": 0,
                    "agent_topology": "backend:hospital-developer:agent,frontend:hospital-developer:agent,operador:hospital-lider:operator",
                    "public_table_count": 30,
                    "isolated": True,
                    "network": "none",
                    "full_restore": True,
                    "verified_at_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        evidence.chmod(0o600)
        status = directory / "status.json"
        status.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "overall": "ok",
                    "run_started_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "run_finished_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "dump_file": str(dump),
                    "dump_sha256": digest,
                    "restore_evidence_file": str(evidence),
                    "offsite": False,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        status.chmod(0o600)
        return status

    def run_monitor(self, status: pathlib.Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(INSTANCE / "backup-monitor.sh")],
            env={**os.environ, "STATUS_FILE": str(status), "MAX_AGE_HOURS": "24"},
            text=True,
            capture_output=True,
            check=False,
        )

    def test_telegram_activation_uses_a_fresh_one_time_challenge(self) -> None:
        script = (INSTANCE / "activate-telegram.sh").read_text(encoding="utf-8")

        self.assertIn('activation_nonce="hospital-$(openssl rand -hex 8)"', script)
        self.assertIn('"offset": -1', script)
        self.assertIn('link = f"https://t.me/{expected_bot}?start={nonce}"', script)
        self.assertIn("deadline = time.monotonic() + 300", script)
        self.assertIn('parts[0] in {"/start", f"/start@{expected_bot}"}', script)
        self.assertIn('message["date"] >= issued_at', script)
        self.assertIn("actualizaciones={observed}", script)
        self.assertNotIn("read -r _confirmation", script)
        self.assertIn("trap cleanup EXIT", script)
        self.assertIn('rm -f "$TEMP_TOKEN"', script)

    def test_telegram_activation_discards_backlog_and_accepts_deep_link_command(self) -> None:
        script = (INSTANCE / "activate-telegram.sh").read_text(encoding="utf-8")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY", script, re.DOTALL)
        self.assertEqual(len(blocks), 3)
        enrollment = compile(blocks[1], "telegram-enrollment", "exec")
        calls: list[str] = []

        class Response(io.BytesIO):
            def __enter__(self) -> Response:
                return self

            def __exit__(self, *_args: object) -> None:
                self.close()

        def urlopen(url: str, timeout: int) -> Response:
            self.assertGreater(timeout, 0)
            calls.append(url)
            parsed = urllib.parse.urlparse(url)
            method = parsed.path.rsplit("/", 1)[-1]
            query = urllib.parse.parse_qs(parsed.query)
            if method == "getWebhookInfo":
                result: object = {"url": ""}
            elif query.get("offset") == ["-1"]:
                result = [{"update_id": 40}]
            elif query.get("offset") == ["41"]:
                result = [
                    {
                        "update_id": 41,
                        "message": {
                            "date": int(time.time()),
                            "text": "/start@hospitales_builder_developer_bot\u00a0hospital-fixture",
                            "chat": {"id": 123456, "type": "private"},
                            "from": {"id": 123456},
                        },
                    }
                ]
            elif query.get("offset") == ["42"]:
                result = []
            else:
                self.fail(f"unexpected Telegram request: {url}")
            return Response(json.dumps({"ok": True, "result": result}).encode("utf-8"))

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            token = root / "token"
            target = root / "allowlist.json"
            token.write_text("123456:fixture", encoding="utf-8")
            stdout = io.StringIO()
            argv = [
                "enroll",
                str(token),
                str(target),
                "hospital-fixture",
                "hospitales_builder_developer_bot",
            ]
            with (
                mock.patch.object(urllib.request, "urlopen", side_effect=urlopen),
                mock.patch("sys.argv", argv),
                mock.patch("sys.stdout", stdout),
            ):
                exec(enrollment, {})

            document = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(
                document,
                {"aliases": {"operador": {"chat_ids": ["123456"], "user_ids": ["123456"]}}},
            )
            self.assertIn("https://t.me/hospitales_builder_developer_bot?start=hospital-fixture", stdout.getvalue())
            self.assertEqual(len(calls), 4)
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(calls[1]).query)["offset"], ["-1"])
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(calls[2]).query)["offset"], ["41"])
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(calls[3]).query)["offset"], ["42"])

    def test_telegram_token_validation_rejects_malformed_input_before_network(self) -> None:
        script = (INSTANCE / "activate-telegram.sh").read_text(encoding="utf-8")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY", script, re.DOTALL)
        probe = compile(blocks[0], "telegram-token-probe", "exec")
        with tempfile.TemporaryDirectory() as temporary:
            token = pathlib.Path(temporary) / "token"
            token.write_text("valor pegado incompleto", encoding="utf-8")
            with (
                mock.patch.object(urllib.request, "urlopen") as urlopen,
                mock.patch("sys.argv", ["probe", str(token), "hospitales_builder_developer_bot"]),
                self.assertRaisesRegex(SystemExit, "no tiene formato de token de BotFather"),
            ):
                exec(probe, {})
            urlopen.assert_not_called()

    def test_telegram_token_validation_sanitizes_real_http_failure(self) -> None:
        script = (INSTANCE / "activate-telegram.sh").read_text(encoding="utf-8")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY", script, re.DOTALL)
        probe = compile(blocks[0], "telegram-token-probe", "exec")
        synthetic = "1234567890:" + "A" * 35
        error = urllib.error.HTTPError(
            f"https://api.telegram.org/bot{synthetic}/getMe",
            404,
            "Not Found",
            hdrs=None,
            fp=None,
        )
        with tempfile.TemporaryDirectory() as temporary:
            token = pathlib.Path(temporary) / "token"
            token.write_text(synthetic, encoding="utf-8")
            argv = ["probe", str(token), "hospitales_builder_developer_bot"]
            with (
                mock.patch.object(urllib.request, "urlopen", side_effect=error),
                mock.patch("sys.argv", argv),
                self.assertRaises(SystemExit) as raised,
            ):
                exec(probe, {})
        message = str(raised.exception)
        self.assertEqual(
            message,
            "Telegram rechazó el token (HTTP 404); copiá el último token completo desde BotFather",
        )
        self.assertNotIn(synthetic, message)
        self.assertNotIn("api.telegram.org", message)

    def test_only_the_leader_is_enrolled_in_telegram(self) -> None:
        script = (INSTANCE / "activate-telegram.sh").read_text(encoding="utf-8")

        self.assertIn("--aliases operador", script)
        self.assertNotIn("--aliases operador backend", script)
        self.assertIn('"operador": {"user_ids": [candidate]', script)

    def test_bootstrap_declares_exactly_three_hospital_agents(self) -> None:
        sql = (INSTANCE / "bootstrap.sql").read_text(encoding="utf-8")

        for alias in ("operador", "backend", "frontend"):
            self.assertIn(f"'Hospital', '{alias}'", sql)
        self.assertNotIn("ADD CONSTRAINT tenants_known", sql)
        self.assertIn("requires a fresh migrated database", sql)
        self.assertIn("hospital topology verification failed", sql)

    def test_redeploy_refuses_to_bypass_a_missing_backup(self) -> None:
        script = (INSTANCE / "bootstrap-core.sh").read_text(encoding="utf-8")

        self.assertIn('docker volume inspect "$PG_VOLUME"', script)
        self.assertIn("backup-monitor.sh", script)
        self.assertIn("La instancia ya tiene almacenamiento", script)
        checkpoint = script.index('"$REPO/ops/instances/hospital/backup.sh"')
        deploy = script.index('"$REPO/deploy/deploy.sh"')
        self.assertLess(checkpoint, deploy)

    def test_compose_secret_bind_permissions_are_exercised(self) -> None:
        script = (INSTANCE / "bootstrap-core.sh").read_text(encoding="utf-8")

        self.assertIn("--user 1000:1000", script)
        self.assertIn("--user 101:101", script)
        self.assertIn("/probe/identities/mtls_identities.json", script)
        self.assertIn("/probe/release-state", script)

    def test_agent_provision_waits_for_real_fresh_leases(self) -> None:
        script = (INSTANCE / "provision-agents.sh").read_text(encoding="utf-8")

        self.assertIn("for _attempt in $(seq 1 24)", script)
        self.assertIn("last_heartbeat_at > now() - interval '60 seconds'", script)
        self.assertLess(script.index('[ "$leases" = 3 ] ||'), script.index("CAUCE_SMOKE_EXPECTED_AGENTS"))

    def test_access_helper_survives_a_late_provision_failure(self) -> None:
        script = (INSTANCE / "install.sh").read_text(encoding="utf-8")

        self.assertLess(script.index("hospital-cauce-access"), script.index("provision-agents.sh"))

    def test_backup_is_installed_and_restore_verified_before_the_timer(self) -> None:
        script = (INSTANCE / "bootstrap-core.sh").read_text(encoding="utf-8")
        backup = (INSTANCE / "backup.sh").read_text(encoding="utf-8")

        self.assertIn("/usr/local/sbin/hospital-cauce-backup", script)
        self.assertLess(
            script.index("/usr/local/sbin/hospital-cauce-backup\n"),
            script.index("systemctl enable --now hospital-cauce-backup.timer"),
        )
        self.assertIn("--network none", backup)
        self.assertIn("--single-transaction", backup)
        self.assertIn("agent_topology", backup)

    def test_backup_monitor_accepts_exact_evidence_and_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            self.assertEqual(self.run_monitor(status).returncode, 0)

            dump = root / "dumps" / "cauce-hospital-fixture.dump"
            dump.write_bytes(b"tampered")
            dump.chmod(0o600)
            failure = self.run_monitor(status)
            self.assertNotEqual(failure.returncode, 0)
            self.assertIn("digest del dump no coincide", failure.stderr)

    def test_backup_monitor_rejects_non_exact_topology(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            document = json.loads(status.read_text(encoding="utf-8"))
            evidence = pathlib.Path(document["restore_evidence_file"])
            evidence_document = json.loads(evidence.read_text(encoding="utf-8"))
            evidence_document["acl_edge_count"] = 1
            evidence.write_text(
                json.dumps(evidence_document, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            evidence.chmod(0o600)
            self.assertNotEqual(self.run_monitor(status).returncode, 0)

    def test_backup_monitor_rejects_a_dump_outside_its_instance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            document = json.loads(status.read_text(encoding="utf-8"))
            document["dump_file"] = str(root / "foreign.dump")
            status.write_text(
                json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            status.chmod(0o600)
            self.assertNotEqual(self.run_monitor(status).returncode, 0)


if __name__ == "__main__":
    unittest.main()
