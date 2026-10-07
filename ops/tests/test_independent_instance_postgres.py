from __future__ import annotations

import hashlib
import os
import pathlib
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "instances/common"))
import resources
from bootstrap import bootstrap_fresh, psql, update_database_marker
from descriptor import InstanceError, canonical
from test_independent_instance import bootstrap_document

CODE = pathlib.Path(__file__).resolve().parents[2]
POSTGRES_IMAGE = os.environ.get("CAUCE_INSTANCE_TEST_POSTGRES_IMAGE")


@unittest.skipUnless(POSTGRES_IMAGE, "explicit digest-pinned disposable PostgreSQL image required")
class OwnedPostgresTest(unittest.TestCase):
    def setUp(self):
        if "@sha256:" not in POSTGRES_IMAGE:
            self.fail("test PostgreSQL must be digest pinned")
        self.owner = uuid.uuid4().hex
        self.name = "cauce-instance-test-" + self.owner[:12]
        self.volume = self.name + "-data"
        self.plan = {"descriptor": {"instanceId": self.name, "companyId": "EmpresaNueva", "codeRoot": str(CODE)},
                     "dockerResources": {"volume": [self.volume], "network": []},
                     "resources": {"project": self.name}, "compose": {"services": {}, "volumes": {"cauce_pgdata": {"name": self.volume}}}, "planHash": "a" * 64,
                     "bootstrap": bootstrap_document(), "bootstrapHash": hashlib.sha256(canonical(bootstrap_document())).hexdigest()}
        self.receipt = {"schemaVersion": 1, "instanceId": self.name, "companyId": "EmpresaNueva",
                        "planHash": self.plan["planHash"], "owner": self.owner, "docker": {}, "files": {}, "stages": {}}
        self.addCleanup(self.cleanup_owned)
        resources.verify_owned_resources(self.plan, self.receipt)
        resources.create_owned_resources(self.plan, self.receipt, lambda: None)
        resources.run(["docker", "run", "-d", "--name", self.name, "--network", "none",
                       "--label", "io.cauce.owner=" + self.owner, "--label", "io.cauce.installation=" + self.name,
                       "--mount", f"type=volume,source={self.volume},target=/var/lib/postgresql/data",
                       "-e", "POSTGRES_DB=cauce", "-e", "POSTGRES_USER=cauce", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                       POSTGRES_IMAGE])
        for _ in range(80):
            try:
                if psql(self.name, "cauce", "SELECT 1;").strip() == "1":
                    break
            except InstanceError:
                time.sleep(0.15)
        else:
            self.fail("disposable PostgreSQL did not become ready")
        sources = sorted((CODE / "packages/store/migrations").glob("*.sql"))
        psql(self.name, "cauce", "BEGIN;\n" + "\n".join(path.read_text() for path in sources) + "\nCOMMIT;")

    def cleanup_owned(self):
        result = resources.run(["docker", "ps", "-aq", "--filter", "label=io.cauce.owner=" + self.owner]).split()
        for container in result:
            resources.run(["docker", "rm", "-f", container])
        item = resources.inspect_resource("volume", self.volume)
        if item and item["Labels"].get("io.cauce.owner") == self.owner:
            resources.run(["docker", "volume", "rm", self.volume])

    def test_unknown_empty_volume_rejected_and_receipt_identity_proven(self):
        unknown = self.name + "-unknown"
        resources.run(["docker", "volume", "create", unknown])
        try:
            self.plan["dockerResources"]["volume"].append(unknown)
            with self.assertRaisesRegex(InstanceError, "unknown Docker"):
                resources.verify_owned_resources(self.plan, self.receipt)
            self.plan["dockerResources"]["volume"].remove(unknown)
            resources.verify_owned_resources(self.plan, self.receipt)
            self.plan["resources"]["adapterContainerNames"] = [self.name]
            with self.assertRaisesRegex(InstanceError, "unknown existing adapter"):
                resources.verify_owned_resources(self.plan, self.receipt)
            self.plan["resources"].pop("adapterContainerNames")
            self.plan["compose"]["services"]["gateway"] = {"container_name": self.name}
            with self.assertRaisesRegex(InstanceError, "unknown existing core container"):
                resources.verify_owned_resources(self.plan, self.receipt)
            self.plan["compose"]["services"].pop("gateway")
            self.receipt["docker"]["volume:" + self.volume] = "forged"
            with self.assertRaisesRegex(InstanceError, "identity drift"):
                resources.verify_owned_resources(self.plan, self.receipt)
        finally:
            resources.run(["docker", "volume", "rm", unknown])

    def test_existing_database_never_seed_cleaned_even_empty(self):
        with self.assertRaisesRegex(InstanceError, "freshly created"):
            bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "5")
        self.receipt["stages"]["freshStorage"] = True
        psql(self.name, "postgres", "CREATE DATABASE cauce_baseline_" + self.owner + ";")
        with self.assertRaisesRegex(InstanceError, "unknown baseline"):
            bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "5")

    def test_unexpected_empty_database_in_fresh_volume_is_rejected(self):
        self.receipt["stages"]["freshStorage"] = True
        psql(self.name, "postgres", "CREATE DATABASE unrelated_empty;")
        with self.assertRaisesRegex(InstanceError, "unexpected database"):
            bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "5")

    def test_exact_fresh_baseline_bootstrap_idempotency_and_foreign_owner(self):
        self.receipt["stages"]["freshStorage"] = True
        bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT string_agg(id,',') FROM tenants;").strip(), "EmpresaNueva")
        self.assertEqual(psql(self.name, "cauce", "SELECT string_agg(alias,',') FROM agents;").strip(), "operador")
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM acl_edges;").strip(), "0")
        psql(self.name, "cauce", "INSERT INTO tenants(id) VALUES ('AfterBootstrap');")
        bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "2")
        self.receipt["stages"]["updatePreviousPlanHash"] = self.plan["planHash"]
        self.plan["planHash"] = "b" * 64
        update_database_marker(self.plan, self.receipt, self.name)
        update_database_marker(self.plan, self.receipt, self.name)
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "2")
        self.receipt["owner"] = "foreign"
        with self.assertRaisesRegex(InstanceError, "ownership marker"):
            bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)

    def test_baseline_create_and_migration_commit_crashes_recover_exact_owned_identity(self):
        import json
        import subprocess
        import tempfile
        self.receipt["stages"]["freshStorage"] = True
        for cut in ("after-create", "after-migration"):
            with self.subTest(cut=cut), tempfile.TemporaryDirectory(prefix="cauce-baseline-cut-") as directory:
                receipt_path = pathlib.Path(directory) / "receipt.json"
                plan_path = pathlib.Path(directory) / "plan.json"
                resources.atomic_json(receipt_path, self.receipt)
                plan_path.write_bytes(canonical(self.plan))
                program = """import json,os,pathlib,sys
sys.path.insert(0,sys.argv[1])
import bootstrap,resources
plan=json.loads(pathlib.Path(sys.argv[2]).read_text())
receipt_path=pathlib.Path(sys.argv[3])
receipt=json.loads(receipt_path.read_text())
container=sys.argv[4]
cut=sys.argv[5]
original=bootstrap.psql
def interrupted(container,database,sql):
 result=original(container,database,sql)
 if (sql.startswith("CREATE DATABASE") and cut=="after-create") or ("INSERT INTO cauce_baseline_ownership" in sql and cut=="after-migration"):
  os._exit(81)
 return result
bootstrap.psql=interrupted
bootstrap.bootstrap_fresh(plan,receipt,container,lambda: resources.atomic_json(receipt_path,receipt))
"""
                if cut == "after-migration":
                    self.receipt = json.loads(receipt_path.read_text())
                crashed = subprocess.run([sys.executable, "-c", program,
                    str(CODE / "ops/instances/common"), str(plan_path), str(receipt_path), self.name, cut])
                self.assertEqual(crashed.returncode, 81)
                self.receipt = json.loads(receipt_path.read_text())
                self.assertIn("baselineIntent", self.receipt["stages"])
                self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "5")
        bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT string_agg(id,',') FROM tenants;").strip(), "EmpresaNueva")

    def test_baseline_changed_aborts_transaction_without_cleaning(self):
        self.receipt["stages"]["freshStorage"] = True
        psql(self.name, "cauce", "UPDATE memberships SET enabled=false WHERE alias='kant';")
        with self.assertRaises(InstanceError):
            bootstrap_fresh(self.plan, self.receipt, self.name, lambda: None)
        self.assertEqual(psql(self.name, "cauce", "SELECT count(*) FROM tenants;").strip(), "5")
        self.assertEqual(psql(self.name, "cauce", "SELECT to_regclass('cauce_instance_ownership') IS NULL;").strip(), "t")


if __name__ == "__main__":
    unittest.main()
