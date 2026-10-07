from __future__ import annotations

import datetime
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import tarfile
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
    def write_blob_archive(self, path: pathlib.Path, blobs: dict[str, bytes]) -> None:
        with tarfile.open(path, "w") as archive:
            root = tarfile.TarInfo(".")
            root.type = tarfile.DIRTYPE
            archive.addfile(root)
            for digest, content in sorted(blobs.items()):
                member = tarfile.TarInfo(f"./{digest}")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        path.chmod(0o600)

    def backup_fixture(
        self, directory: pathlib.Path, blobs: dict[str, bytes] | None = None
    ) -> pathlib.Path:
        if blobs is None:
            payload = b"verified-blob"
            blobs = {hashlib.sha256(payload).hexdigest(): payload}
        dump_root = directory / "dumps"
        dump_root.mkdir(mode=0o700)
        dump = dump_root / "cauce-hospital-fixture.dump"
        dump.write_bytes(b"verified-dump")
        dump.chmod(0o600)
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        sidecar = pathlib.Path(f"{dump}.sha256")
        sidecar.write_text(f"{digest}  {dump.name}\n", encoding="ascii")
        sidecar.chmod(0o600)
        archive = pathlib.Path(f"{dump}.blobs.tar")
        self.write_blob_archive(archive, blobs)
        archive_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive_sidecar = pathlib.Path(f"{archive}.sha256")
        archive_sidecar.write_text(f"{archive_digest}  {archive.name}\n", encoding="ascii")
        archive_sidecar.chmod(0o600)
        manifest = pathlib.Path(f"{dump}.blobs.tsv")
        manifest.write_text(
            "".join(f"{name}\t{len(content)}\n" for name, content in sorted(blobs.items())),
            encoding="ascii",
        )
        manifest.chmod(0o600)
        manifest_digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
        evidence = pathlib.Path(f"{dump}.restore.json")
        evidence.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "suite": "hospital-cauce-backup-restore",
                    "dump_file": dump.name,
                    "dump_sha256": digest,
                    "blob_archive_file": archive.name,
                    "blob_archive_sha256": archive_digest,
                    "blob_manifest_file": manifest.name,
                    "blob_manifest_sha256": manifest_digest,
                    "blob_row_count": len(blobs),
                    "blob_row_bytes": sum(map(len, blobs.values())),
                    "archived_blob_count": len(blobs),
                    "blob_table_present": True,
                    "blob_volume_present": True,
                    "blob_volume": "hospital-cauce_blobs_data",
                    "blob_restore_verified": True,
                    "blob_restore_uid": 1000,
                    "blob_restore_network": "none",
                    "blob_restore_row_count": len(blobs),
                    "database_image_digest": "sha256:" + "a" * 64,
                    "migration_count": 41,
                    "tenant_count": 1,
                    "room_count": 1,
                    "agent_count": 3,
                    "profile_count": 3,
                    "membership_count": 4,
                    "acl_edge_count": 0,
                    "agent_topology": "operador:hospital-lider:operator,perseo:hospital-praxis-developer:agent,teseo:hospital-praxis-developer:agent",
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
                    "schema_version": 2,
                    "overall": "ok",
                    "run_started_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "run_finished_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "dump_file": str(dump),
                    "dump_sha256": digest,
                    "restore_evidence_file": str(evidence),
                    "blob_archive_file": str(archive),
                    "blob_archive_sha256": archive_digest,
                    "blob_manifest_file": str(manifest),
                    "blob_manifest_sha256": manifest_digest,
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

    def run_monitor(
        self, status: pathlib.Path, require_blob_volume: bool = False
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(INSTANCE / "backup-monitor.sh")],
            env=dict(
                os.environ,
                STATUS_FILE=str(status),
                MAX_AGE_HOURS="24",
                REQUIRE_BLOB_VOLUME="1" if require_blob_volume else "0",
            ),
            text=True,
            capture_output=True,
            check=False,
        )

    def reseal_blob_archive(self, status: pathlib.Path) -> None:
        document = json.loads(status.read_text(encoding="utf-8"))
        archive = pathlib.Path(document["blob_archive_file"])
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        document["blob_archive_sha256"] = digest
        status.write_text(json.dumps(document) + "\n", encoding="utf-8")
        status.chmod(0o600)
        sidecar = pathlib.Path(f"{archive}.sha256")
        sidecar.write_text(f"{digest}  {archive.name}\n", encoding="ascii")
        sidecar.chmod(0o600)
        evidence = pathlib.Path(document["restore_evidence_file"])
        proof = json.loads(evidence.read_text(encoding="utf-8"))
        proof["blob_archive_sha256"] = digest
        evidence.write_text(json.dumps(proof) + "\n", encoding="utf-8")
        evidence.chmod(0o600)

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
        self.assertNotIn("--aliases operador teseo", script)
        self.assertIn('"operador": {"user_ids": [candidate]', script)

    def test_installation_entries_require_descriptor_before_mutating_any_resource(self) -> None:
        for name in ("install.sh", "bootstrap-core.sh", "provision-agents.sh"):
            with self.subTest(name=name):
                result=subprocess.run(["bash", str(INSTANCE/name)],capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,64)
                self.assertIn("--descriptor",result.stderr)
                script=(INSTANCE/name).read_text()
                for forbidden in ("docker ", "systemctl ", "deploy.sh", "/etc/", "/opt/", "sudo", "bootstrap.sql"):
                    self.assertNotIn(forbidden,script)
        source=(INSTANCE/"install-profile.py").read_text()
        self.assertIn("instance.load_instance_descriptor",source)
        self.assertIn("common/cauce-instance",source)
        self.assertIn("os.execv",source)
        self.assertIn("supervision integration requires explicit project profile",source)












    def test_update_wrapper_requires_descriptor_and_forwards_to_common_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            binary=pathlib.Path(temporary)/"python3"
            binary.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
            binary.chmod(0o700)
            for name in ("install.sh","bootstrap-core.sh","provision-agents.sh"):
                with self.subTest(name=name):
                    result=subprocess.run(["bash",str(INSTANCE/name),"update","--descriptor","/synthetic/descriptor.json"],
                        capture_output=True,text=True,env={**os.environ,"PATH":temporary+":/usr/bin:/bin"},timeout=10)
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertEqual(result.stdout.splitlines()[1:],["update","--descriptor","/synthetic/descriptor.json"])

    def test_container_units_drop_the_expectation_hook_when_asked(self) -> None:
        generator = ROOT / "ops" / "scripts" / "generate-container-units.py"
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            subprocess.run(
                ["python3", str(generator), "--rootless", "--home", "/home/dev",
                 "--no-profile-expectation", "--output", str(output)],
                check=True, capture_output=True,
            )
            units = sorted(output.glob("cauce-v3-container-*.service"))
            self.assertTrue(units)
            for unit in units:
                self.assertNotIn("profile-expectation", unit.read_text(encoding="utf-8"))
            self.assertFalse((output / "cauce-v3-profile-expectation@.service").exists())



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

    def test_backup_monitor_requires_blob_archive_and_restored_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            archive = root / "dumps" / "cauce-hospital-fixture.dump.blobs.tar"
            archive.unlink()
            self.assertNotEqual(self.run_monitor(status).returncode, 0)

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            archive = root / "dumps" / "cauce-hospital-fixture.dump.blobs.tar"
            self.write_blob_archive(archive, {})
            self.reseal_blob_archive(status)
            failure = self.run_monitor(status)
            self.assertNotEqual(failure.returncode, 0)
            self.assertIn("faltan blobs de la base restaurada", failure.stderr)

    def test_backup_monitor_rejects_blob_bytes_even_with_resealed_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            archive = root / "dumps" / "cauce-hospital-fixture.dump.blobs.tar"
            digest = (root / "dumps" / "cauce-hospital-fixture.dump.blobs.tsv").read_text().split("\t")[0]
            self.write_blob_archive(archive, {digest: b"tampered-blob"})
            self.reseal_blob_archive(status)
            failure = self.run_monitor(status)
            self.assertNotEqual(failure.returncode, 0)
            self.assertIn("blob archivado no coincide", failure.stderr)

    def test_backup_monitor_rejects_tampered_blob_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            evidence = root / "dumps" / "cauce-hospital-fixture.dump.restore.json"
            proof = json.loads(evidence.read_text(encoding="utf-8"))
            proof["blob_row_count"] = 0
            evidence.write_text(json.dumps(proof) + "\n", encoding="utf-8")
            evidence.chmod(0o600)
            self.assertIn("evidencia de restauración incompleta", self.run_monitor(status).stderr)

    def test_backup_monitor_accepts_empty_blob_volume_and_table(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            status = self.backup_fixture(pathlib.Path(temporary), blobs={})
            result = self.run_monitor(status)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("0 blobs verificados", result.stdout)

    def test_backup_monitor_accepts_legacy_checkpoint_without_blob_table_or_volume(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            status = self.backup_fixture(pathlib.Path(temporary), blobs={})
            document = json.loads(status.read_text(encoding="utf-8"))
            evidence = pathlib.Path(document["restore_evidence_file"])
            proof = json.loads(evidence.read_text(encoding="utf-8"))
            proof["blob_table_present"] = False
            proof["blob_volume_present"] = False
            evidence.write_text(json.dumps(proof) + "\n", encoding="utf-8")
            evidence.chmod(0o600)
            self.assertEqual(self.run_monitor(status).returncode, 0)
            strict = self.run_monitor(status, require_blob_volume=True)
            self.assertNotEqual(strict.returncode, 0)
            self.assertIn("falta backup verificado de tabla y volumen", strict.stderr)

    def test_backup_monitor_strict_mode_accepts_empty_post_migration_volume(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            status = self.backup_fixture(pathlib.Path(temporary), blobs={})
            result = self.run_monitor(status, require_blob_volume=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_backup_monitor_rejects_unproven_blob_restore(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            status = self.backup_fixture(pathlib.Path(temporary))
            document = json.loads(status.read_text(encoding="utf-8"))
            evidence = pathlib.Path(document["restore_evidence_file"])
            proof = json.loads(evidence.read_text(encoding="utf-8"))
            proof["blob_restore_verified"] = False
            evidence.write_text(json.dumps(proof) + "\n", encoding="utf-8")
            evidence.chmod(0o600)
            failure = self.run_monitor(status, require_blob_volume=True)
            self.assertNotEqual(failure.returncode, 0)
            self.assertIn("evidencia de restauración incompleta", failure.stderr)

    def test_backup_restores_only_into_a_generated_temporary_volume(self) -> None:
        script = (INSTANCE / "backup.sh").read_text(encoding="utf-8")
        validation = script.index("blob_counts=$(python3")
        create = script.index("docker volume create --label cauce.hospital.backup-verify=true")
        restore = script.index('"$database_image" tar -C /blobs -xf - <"$blob_partial"')
        readback = script.index('"$database_image" tar -C /blobs -cf - . >/dev/null')
        checksum = script.index('actual=$(sha256sum "$file")')
        remove = script.index('docker volume rm "$restore_blob_volume" >/dev/null\nrestore_blob_volume=')
        publish = script.index("publishing=1")
        self.assertLess(validation, create)
        self.assertLess(create, restore)
        self.assertLess(restore, readback)
        self.assertLess(readback, checksum)
        self.assertLess(checksum, remove)
        self.assertLess(remove, publish)
        self.assertIn('[[ "$restore_blob_volume" =~ ^[a-f0-9]{64}$ ]]', script)
        self.assertNotIn('docker volume rm "$BLOB_VOLUME"', script)

    def test_backup_monitor_rejects_non_exact_topology(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = self.backup_fixture(root)
            document = json.loads(status.read_text(encoding="utf-8"))
            evidence = pathlib.Path(document["restore_evidence_file"])
            evidence_document = json.loads(evidence.read_text(encoding="utf-8"))
            for field, value in (
                ("acl_edge_count", 1),
                ("agent_topology", "operador:hospital-lider:operator,perseo:hospital-developer:agent,teseo:hospital-developer:agent"),
                ("agent_topology", "operador:hospital-lider:operator,perseo:hospital-praxis-developer:agent,teseo:hospital-developer:agent"),
            ):
                altered = {**evidence_document, field: value}
                evidence.write_text(
                    json.dumps(altered, sort_keys=True, separators=(",", ":")) + "\n",
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
