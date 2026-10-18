from __future__ import annotations

import datetime
import hashlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

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
                    "verified_at_utc": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
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
                    "run_started_utc": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "run_finished_utc": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
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

    def test_bootstrap_preserves_current_roles_and_profiles(self) -> None:
        sql = (INSTANCE / "bootstrap.sql").read_text(encoding="utf-8")
        templates = sql[sql.index("INSERT INTO agent_role_templates"):sql.index("INSERT INTO harness_definitions")]
        self.assertIn("ON CONFLICT (slug) DO NOTHING", templates)
        agents = sql[sql.index("INSERT INTO agents("):sql.index("INSERT INTO memberships(")]
        update = agents[agents.index("ON CONFLICT"):]
        self.assertNotIn("role_brief =", update)
        self.assertNotIn("role_template_slug =", update)
        self.assertIn("WHERE agent_profiles.purpose IS NULL", sql)
        self.assertIn("perseo:hospital-agent-muse-frontend-1:hospital-praxis-developer", sql)
        self.assertIn("teseo:hospital-agent-muse-backend-1:hospital-praxis-developer", sql)

    def test_redeploy_refuses_to_bypass_a_missing_backup(self) -> None:
        script = (INSTANCE / "bootstrap-core.sh").read_text(encoding="utf-8")

        self.assertIn('docker volume inspect "$PG_VOLUME"', script)
        self.assertIn("backup-monitor.sh", script)
        self.assertIn("La instancia ya tiene almacenamiento", script)
        checkpoint = script.index('"$REPO/ops/instances/hospital/backup.sh"')
        deploy = script.index('"$REPO/deploy/deploy.sh"')
        self.assertLess(checkpoint, deploy)

    def test_agent_provision_restarts_adapters_so_the_new_bundle_runs(self) -> None:
        script = (INSTANCE / "provision-agents.sh").read_text(encoding="utf-8")

        self.assertNotIn("systemctl enable --now", script)
        self.assertIn('systemctl restart "cauce-v3-container-$alias.service"', script)
        self.assertIn("status IN ('leased','accepted','started')", script)
        self.assertLess(script.index('[ "$inflight" = 0 ]'), script.index("systemctl restart"))

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
