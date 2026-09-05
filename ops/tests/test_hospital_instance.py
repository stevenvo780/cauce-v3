from __future__ import annotations

import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

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
        self.assertIn('expected_text = "/start " + sys.argv[3]', script)
        self.assertIn('message["date"] >= issued_at', script)
        self.assertNotIn('message.get("text") == "/start"', script)
        self.assertIn("trap cleanup EXIT", script)
        self.assertIn('rm -f "$TEMP_TOKEN"', script)

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
