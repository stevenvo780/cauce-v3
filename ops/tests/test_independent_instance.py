from __future__ import annotations

import copy
import importlib
import json
import multiprocessing
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

COMMON = pathlib.Path(__file__).resolve().parents[1] / "instances/common"
sys.path.insert(0, str(COMMON))
resources = importlib.import_module("resources")
descriptor_module = importlib.import_module("descriptor")
InstanceError = descriptor_module.InstanceError
canonical = descriptor_module.canonical
validate_bootstrap = descriptor_module.validate_bootstrap
validate_descriptor = descriptor_module.validate_descriptor
apply_instance = importlib.import_module("instance").apply_instance
planning = importlib.import_module("planning")
REQUIRED_SECRET_VARS = planning.REQUIRED_SECRET_VARS
plan_instance = planning.plan_instance

CODE = pathlib.Path(__file__).resolve().parents[2]
IMAGE = "test.invalid/cauce@sha256:" + "a" * 64


def bootstrap_document(tenant="EmpresaNueva", room="sala.42"):
    return {"schemaVersion": 1, "tenants": [{"id": tenant}], "rooms": [{"id": room, "tenant_id": tenant}],
            "memberships": [{"tenant_id": tenant, "room_id": room, "alias": "operador", "role": "operator"}],
            "agents": [{"tenant_id": tenant, "alias": "operador", "harness_id": "codex", "enabled": True,
                        "container_name": "empresa-agente", "runtime_user": "dev", "home_directory": "/home/dev",
                        "state_directory": "/home/dev/.local/state/cauce-v3/operador"}], "aclEdges": []}


def make_descriptor(root, name="empresa-a", offset=0):
    root = pathlib.Path(root)
    paths = {key: str(root / name / key) for key in ("config", "state", "bundles", "pki", "backups", "locks")}
    config = pathlib.Path(paths["config"])
    config.mkdir(parents=True)
    bootstrap = bootstrap_document()
    bootstrap["agents"][0]["container_name"] = name + "-agente"
    (config / "bootstrap.json").write_bytes(canonical(bootstrap))
    return {"schemaVersion": 1, "instanceId": name, "companyId": "EmpresaNueva",
            "release": {key: IMAGE for key in ("runtimeImage", "consoleImage", "postgresImage", "otelImage", "prometheusImage")},
            "codeRoot": str(CODE), "inventoryRoot": str(root / name / "inventory"), "paths": paths,
            "compose": {"project": name}, "endpoints": {"bindIp": "127.0.0.1", "gatewayPort": 48101 + offset,
            "consolePort": 48102 + offset, "relayPort": 48103 + offset, "origins": ["https://empresa.invalid"]},
            "identityRefs": {"bootstrap": str(config / "bootstrap.json"),
            "secretFiles": {key: str(config / key.lower()) for key in REQUIRED_SECRET_VARS}}}


def reserve_worker(registry, request, start, output):
    resources.REGISTRY_ROOT = pathlib.Path(registry)
    start.wait()
    try:
        with resources.reservation_lock():
            resources.check_reservations(request)
            resources.atomic_json(resources.REGISTRY_ROOT / (request["resources"]["instanceId"] + ".json"),
                                  {"resources": request["resources"], "planHash": request["planHash"], "installerUid": os.getuid()})
        output.put("reserved")
    except InstanceError:
        output.put("collision")


class DescriptorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-instance-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.document = make_descriptor(self.temporary.name)

    def test_generic_company_room_and_optional_project(self):
        document = validate_descriptor(self.document)
        self.assertNotIn("integrations", document)
        self.assertEqual(validate_bootstrap(bootstrap_document())["rooms"][0]["id"], "sala.42")
        document["integrations"] = {"custom": {"config": document["paths"]["config"] + "/project.json",
                                                   "workspace": self.temporary.name + "/customer-workspace"}}
        validate_descriptor(document)

    def test_strict_unknown_version_digest_and_mutable_path_overlap(self):
        mutations = [
            lambda d: d.update(unrecognized=True), lambda d: d.update(schemaVersion=True),
            lambda d: d["release"].update(runtimeImage="image:latest"),
            lambda d: d["paths"].update(pki=d["paths"]["config"] + "/pki"),
            lambda d: d.update(inventoryRoot=d["codeRoot"] + "/ops"),
            lambda d: d["endpoints"].update(gatewayPort=d["endpoints"]["consolePort"]),
            lambda d: d["identityRefs"].update(bootstrap="/etc/cauce-v3/bootstrap.json"),
        ]
        for mutation in mutations:
            changed = copy.deepcopy(self.document)
            mutation(changed)
            with self.subTest(document=changed), self.assertRaises(InstanceError):
                validate_descriptor(changed)

    def test_symlink_owner_and_shared_code_readonly_exception(self):
        link = pathlib.Path(self.temporary.name) / "link"
        link.symlink_to(pathlib.Path(self.document["paths"]["config"]), target_is_directory=True)
        changed = copy.deepcopy(self.document)
        changed["paths"]["pki"] = str(link)
        with self.assertRaisesRegex(InstanceError, "symlink"):
            validate_descriptor(changed)
        with patch("descriptor.os.getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(InstanceError, "owner"):
                validate_descriptor(self.document)
        second = make_descriptor(self.temporary.name, "empresa-b", 10)
        self.assertEqual(validate_descriptor(second)["codeRoot"], self.document["codeRoot"])

    def test_bootstrap_alias_unique_and_membership_ownership(self):
        document = bootstrap_document()
        other = dict(document["agents"][0], tenant_id="OtraEmpresa")
        document["tenants"].append({"id": "OtraEmpresa"})
        document["agents"].append(other)
        with self.assertRaisesRegex(InstanceError, "duplicate"):
            validate_bootstrap(document)
        document = bootstrap_document()
        document["memberships"][0]["room_id"] = "absent"
        with self.assertRaisesRegex(InstanceError, "room/tenant"):
            validate_bootstrap(document)
        for tenant in ("bad tenant", "Empresa.Dot", "42Company"):
            with self.assertRaises(InstanceError):
                validate_bootstrap(bootstrap_document(tenant))

    def test_plan_does_not_create_paths_and_never_references_central_secrets(self):
        before = sorted(str(p) for p in pathlib.Path(self.temporary.name).rglob("*"))
        plan = plan_instance(self.document)
        after = sorted(str(p) for p in pathlib.Path(self.temporary.name).rglob("*"))
        self.assertEqual(before, after)
        self.assertNotIn("/etc/cauce-v3", json.dumps(plan))
        self.assertEqual(plan["environment"]["CAUCE_INSTALLATION_ID"], "empresa-a")
        self.assertNotIn("CAUCE_INSTANCE_ID", plan["environment"])
        self.assertEqual(plan["compose"]["services"]["postgres"]["volumes"][0]["source"], "cauce_pgdata")
        self.assertTrue(plan["compose"]["volumes"]["cauce_pgdata"]["external"])
        self.assertTrue(all(n.startswith("cauce-empresa-a-") for n in plan["dockerResources"]["volume"]))

    def test_tampered_plan_aborts_before_any_mutation(self):
        plan = plan_instance(self.document)
        plan["commands"][0] = ["false"]
        with self.assertRaisesRegex(InstanceError, "plan changed"):
            apply_instance(plan)

    def test_receipt_identity_and_generated_file_drift(self):
        plan = plan_instance(self.document)
        receipt = {"schemaVersion": 1, "instanceId": "other", "companyId": "EmpresaNueva",
                   "planHash": plan["planHash"], "owner": "a", "docker": {}, "files": {}, "stages": {}, "immutableHash": plan["immutableHash"]}
        with self.assertRaisesRegex(InstanceError, "identity drift"):
            resources.verify_receipt(plan, receipt)
        receipt["instanceId"] = "empresa-a"
        path = pathlib.Path(self.temporary.name) / "managed.json"
        path.write_text("changed")
        receipt["files"][str(path)] = "b" * 64
        with self.assertRaisesRegex(InstanceError, "file drift"):
            resources.verify_receipt(plan, receipt)

    def test_bound_port_preflight(self):
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            with self.assertRaisesRegex(InstanceError, "unavailable"):
                resources.check_ports({"bindIp": "127.0.0.1", "ports": [server.getsockname()[1]]})

    def test_host_reservation_race_wildcard_and_disjoint_roots(self):
        a = plan_instance(self.document)
        b = plan_instance(make_descriptor(self.temporary.name, "empresa-b"))
        a["resources"]["bindIp"] = "0.0.0.0"
        b["resources"]["bindIp"] = "127.0.0.1"
        self.assertTrue(resources.conflicts(a["resources"], b["resources"]))
        self.assertTrue(resources.binds_overlap("::", "127.0.0.1"))
        start = multiprocessing.Event()
        output = multiprocessing.Queue()
        registry = pathlib.Path(self.temporary.name) / "registry"
        processes = [multiprocessing.Process(target=reserve_worker, args=(str(registry), plan, start, output)) for plan in (a, b)]
        for process in processes:
            process.start()
        start.set()
        results = [output.get(timeout=10), output.get(timeout=10)]
        for process in processes:
            process.join(timeout=10)
            self.assertEqual(process.exitcode, 0)
        self.assertCountEqual(results, ["reserved", "collision"])

    def test_container_names_and_mutable_workspaces_reserve_host_ownership(self):
        a = plan_instance(self.document)
        b = plan_instance(make_descriptor(self.temporary.name, "empresa-b", 10))
        b["resources"]["containerNames"] = list(a["resources"]["containerNames"])
        self.assertTrue(resources.conflicts(a["resources"], b["resources"]))
        document = copy.deepcopy(self.document)
        document["integrations"] = {"project": {"config": document["paths"]["config"] + "/project.json",
                                                "workspace": self.temporary.name + "/customer-workspace"}}
        pathlib.Path(document["integrations"]["project"]["config"]).write_text("{}")
        self.assertIn(document["integrations"]["project"]["workspace"], plan_instance(document)["resources"]["roots"])

    def test_shared_registry_required_without_private_fallback(self):
        with patch.object(resources, "REGISTRY_ROOT", None):
            with self.assertRaisesRegex(InstanceError, "explicit CAUCE_INSTANCE_REGISTRY_ROOT"):
                with resources.reservation_lock(require_shared=True):
                    self.fail("private fallback must not acquire host reservation")

    def test_reservation_physical_identity_rejects_forged_uid_links_and_write_modes(self):
        path = pathlib.Path(self.temporary.name) / "reservation.json"
        document = {"installerUid": os.getuid(), "resources": plan_instance(self.document)["resources"]}
        for uid in (os.getuid() + 1, str(os.getuid()), True, None):
            with self.subTest(uid=uid):
                resources.atomic_json(path, {**document, "installerUid": uid}, mode=0o640)
                with self.assertRaises(InstanceError):
                    resources.read_reservation(path)
        resources.atomic_json(path, document, mode=0o640)
        self.assertEqual(resources.read_reservation(path, own=True), document)
        hard = path.with_name("hard.json")
        os.link(path, hard)
        with self.assertRaises(InstanceError):
            resources.read_reservation(path)
        hard.unlink()
        linked = path.with_name("linked.json")
        linked.symlink_to(path)
        with self.assertRaises(InstanceError):
            resources.read_reservation(linked)
        for mode in (0o660, 0o606, 0o666):
            path.chmod(mode)
            with self.assertRaises(InstanceError):
                resources.read_reservation(path)
        path.chmod(0o640)
        self.assertEqual(resources.read_reservation(path), document)

    @unittest.skipUnless(os.environ.get("CAUCE_INSTANCE_TEST_FOREIGN_REGISTRY"), "explicit fixture with foreign physical UID required")
    def test_foreign_uid_registry_is_readonly_for_collisions_and_never_adopted(self):
        fixture = pathlib.Path(os.environ["CAUCE_INSTANCE_TEST_FOREIGN_REGISTRY"])
        legitimate = fixture / "legit.json"
        forged = fixture / "forged.fixture"
        self.assertNotEqual(legitimate.stat().st_uid, os.getuid())
        record = resources.read_reservation(legitimate)
        self.assertEqual(record["installerUid"], legitimate.stat().st_uid)
        before = legitimate.read_bytes()
        with self.assertRaises(InstanceError):
            resources.read_reservation(legitimate, own=True)
        with self.assertRaises(InstanceError):
            resources.read_reservation(forged)
        plan = plan_instance(self.document)
        registry = pathlib.Path(self.temporary.name) / "foreign-registry"
        registry.mkdir()
        with patch.object(resources, "REGISTRY_ROOT", fixture):
            resources.check_reservations(plan)
            colliding = copy.deepcopy(plan)
            colliding["resources"]["project"] = record["resources"]["project"]
            with self.assertRaisesRegex(InstanceError, "collides"):
                resources.check_reservations(colliding)
            colliding["resources"]["instanceId"] = record["resources"]["instanceId"]
            with self.assertRaisesRegex(InstanceError, "another operator UID"):
                resources.check_reservations(colliding)
        with self.assertRaises(InstanceError):
            importlib.import_module("instance").initialize_receipt(plan, legitimate, registry / "receipt.json")
        self.assertFalse((registry / "receipt.json").exists())
        self.assertEqual(legitimate.read_bytes(), before)

    def test_crashed_update_recovers_reservation_from_owned_durable_receipt(self):
        plan = plan_instance(self.document)
        state = pathlib.Path(self.temporary.name) / "transition"
        state.mkdir(mode=0o700)
        receipt_path = state / "receipt.json"
        registry_path = state / "reservation.json"
        old_hash = "b" * 64
        nonce = "synthetic-owner"
        receipt = {"planHash": old_hash, "owner": nonce, "stages": {}}
        reservation = {"planHash": old_hash, "owner": nonce, "immutableHash": plan["immutableHash"],
                       "installerUid": os.getuid(), "resources": plan["resources"]}
        resources.atomic_json(receipt_path, receipt)
        resources.atomic_json(registry_path, reservation)
        child = """import json,os,pathlib,sys
sys.path.insert(0,sys.argv[1])
from resources import atomic_json
path=pathlib.Path(sys.argv[2])
receipt=json.loads(path.read_text())
receipt["stages"]["updatePreviousPlanHash"]=receipt["planHash"]
receipt["planHash"]=sys.argv[3]
atomic_json(path,receipt)
os._exit(77)
"""
        crashed = subprocess.run([sys.executable, "-c", child, str(COMMON), str(receipt_path), plan["planHash"]])
        self.assertEqual(crashed.returncode, 77)
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(json.loads(registry_path.read_text())["planHash"], old_hash)
        synchronize = importlib.import_module("instance").synchronize_update_reservation
        synchronize(plan, receipt, registry_path)
        healed = json.loads(registry_path.read_text())
        self.assertEqual(healed["planHash"], plan["planHash"])
        self.assertEqual(healed["owner"], nonce)
        self.assertEqual(healed["installerUid"], os.getuid())
        self.assertEqual(healed["resources"], plan["resources"])
        inode = registry_path.stat().st_ino
        synchronize(plan, receipt, registry_path)
        self.assertEqual(registry_path.stat().st_ino, inode)
        for field, value in (("owner", "foreign"), ("installerUid", os.getuid() + 1),
                             ("planHash", "c" * 64), ("immutableHash", "d" * 64)):
            foreign = dict(reservation)
            foreign[field] = value
            resources.atomic_json(registry_path, foreign)
            before = registry_path.read_bytes()
            with self.assertRaises(InstanceError):
                synchronize(plan, receipt, registry_path)
            self.assertEqual(registry_path.read_bytes(), before)

    def test_owned_file_writes_recover_every_durable_cut_without_adopting_drift(self):
        write_owned = importlib.import_module("instance").write_owned
        for existed in (False, True):
            for cut in ("before-replace", "after-replace", "before-receipt", "after-receipt"):
                with self.subTest(existing=existed, cut=cut), tempfile.TemporaryDirectory(prefix="cauce-write-cut-") as directory:
                    plan = plan_instance(make_descriptor(directory))
                    target = pathlib.Path(plan["descriptor"]["inventoryRoot"]) / "ops/generated/instance/compose.json"
                    target.parent.mkdir(parents=True, mode=0o700)
                    receipt_path = pathlib.Path(directory) / "receipt.json"
                    receipt = {"schemaVersion": 1, "instanceId": plan["descriptor"]["instanceId"], "companyId": "EmpresaNueva",
                               "planHash": plan["planHash"], "immutableHash": plan["immutableHash"],
                               "owner": "0" * 32, "docker": {}, "files": {}, "stages": {}}
                    if existed:
                        target.write_bytes(b"old generated bytes")
                        target.chmod(0o600)
                        receipt["files"][str(target)] = __import__("hashlib").sha256(target.read_bytes()).hexdigest()
                    resources.atomic_json(receipt_path, receipt)
                    plan_path = pathlib.Path(directory) / "plan.json"
                    plan_path.write_bytes(canonical(plan))
                    program = """import json,os,pathlib,sys
sys.path.insert(0,sys.argv[1])
import resources
from instance import write_owned
plan=json.loads(pathlib.Path(sys.argv[2]).read_text())
receipt_path=pathlib.Path(sys.argv[3])
target=pathlib.Path(sys.argv[4])
cut=sys.argv[5]
receipt=json.loads(receipt_path.read_text())
original_replace=resources.os.replace
def interrupted_replace(source,destination):
 if pathlib.Path(destination)==target and cut=="before-replace": os._exit(71)
 original_replace(source,destination)
 if pathlib.Path(destination)==target and cut=="after-replace": os._exit(72)
resources.os.replace=interrupted_replace
def save():
 if "fileWriteIntent" not in receipt["stages"] and cut=="before-receipt": os._exit(73)
 resources.atomic_json(receipt_path,receipt)
 if "fileWriteIntent" not in receipt["stages"] and cut=="after-receipt": os._exit(74)
write_owned(target,b"new generated bytes",receipt,save,plan=plan)
"""
                    crashed = subprocess.run([sys.executable, "-c", program, str(COMMON), str(plan_path), str(receipt_path), str(target), cut])
                    self.assertIn(crashed.returncode, (71, 72, 73, 74))
                    receipt = json.loads(receipt_path.read_text())
                    resources.verify_receipt(plan, receipt)
                    resources.recover_file_write(plan, receipt, lambda receipt_path=receipt_path, receipt=receipt: resources.atomic_json(receipt_path, receipt))
                    self.assertEqual(target.read_bytes(), b"new generated bytes")
                    self.assertNotIn("fileWriteIntent", receipt["stages"])
                    resources.verify_receipt(plan, receipt)
                    inode = target.stat().st_ino
                    write_owned(target, b"new generated bytes", receipt, lambda receipt_path=receipt_path, receipt=receipt: resources.atomic_json(receipt_path, receipt), plan=plan)
                    self.assertEqual(target.stat().st_ino, inode)
                    if cut == "before-replace":
                        receipt["files"][str(target)] = __import__("hashlib").sha256(target.read_bytes()).hexdigest()
                        target.write_bytes(b"unexpected operator bytes")
                        with self.assertRaises(InstanceError):
                            resources.verify_receipt(plan, receipt)
                        self.assertEqual(target.read_bytes(), b"unexpected operator bytes")

    def test_pending_file_write_rejects_foreign_temporary_and_target_bytes(self):
        write_owned = importlib.import_module("instance").write_owned
        for tamper in ("temporary-symlink", "temporary-bytes", "target-bytes"):
            with self.subTest(tamper=tamper), tempfile.TemporaryDirectory(prefix="cauce-write-tamper-") as directory:
                plan = plan_instance(make_descriptor(directory))
                target = pathlib.Path(plan["descriptor"]["inventoryRoot"]) / "ops/generated/instance/compose.json"
                target.parent.mkdir(parents=True, mode=0o700)
                target.write_bytes(b"original")
                target.chmod(0o600)
                receipt = {"schemaVersion": 1, "instanceId": plan["descriptor"]["instanceId"], "companyId": "EmpresaNueva",
                           "planHash": plan["planHash"], "immutableHash": plan["immutableHash"], "owner": "0" * 32,
                           "docker": {}, "files": {str(target): __import__("hashlib").sha256(b"original").hexdigest()}, "stages": {}}
                def cut_before_replace():
                    raise InterruptedError("durable intent saved")
                with self.assertRaises(InterruptedError):
                    write_owned(target, b"planned", receipt, cut_before_replace, plan=plan)
                temporary = pathlib.Path(receipt["stages"]["fileWriteIntent"]["temporary"])
                sentinel = pathlib.Path(directory) / "sentinel"
                sentinel.write_bytes(b"unrelated")
                if tamper == "temporary-symlink":
                    temporary.unlink()
                    temporary.symlink_to(sentinel)
                elif tamper == "temporary-bytes":
                    temporary.write_bytes(b"unrelated")
                else:
                    target.write_bytes(b"unrelated")
                with self.assertRaises(InstanceError):
                    resources.recover_file_write(plan, receipt, lambda: None)
                self.assertEqual(sentinel.read_bytes(), b"unrelated")
                self.assertEqual(target.read_bytes(), b"unrelated" if tamper == "target-bytes" else b"original")
                if tamper == "temporary-symlink":
                    self.assertTrue(temporary.is_symlink())
                self.assertIn("fileWriteIntent", receipt["stages"])

    def test_readonly_release_bind_bytes_and_symlinks_affect_exact_plan(self):
        code = pathlib.Path(self.temporary.name) / "release"
        for relative in ("deploy/compose.yaml", "deploy/compose.postgres.yaml", "ops/instances/common/cauce-instance",
                         "ops/schemas/instance-descriptor.schema.json", "ops/schemas/alias-manifest.schema.json"):
            target = code / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"source")
        source = code / "deploy/postgres/postgres-tls-entrypoint.sh"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"first release bytes")
        compose = {"services": {"postgres": {"volumes": [{"type": "bind", "source": str(source), "read_only": True}]}}}
        descriptor = {"codeRoot": str(code)}
        before = planning.source_hash(descriptor, compose)
        source.write_bytes(b"changed release bytes")
        self.assertNotEqual(planning.source_hash(descriptor, compose), before)
        source.unlink()
        source.symlink_to(code / "deploy/compose.yaml")
        with self.assertRaises(InstanceError):
            planning.source_hash(descriptor, compose)

    def test_initial_reservation_recovers_crashes_before_and_after_receipt(self):
        initialize = importlib.import_module("instance").initialize_receipt
        for cut in ("after-reservation", "after-receipt"):
            with self.subTest(cut=cut), tempfile.TemporaryDirectory(prefix="cauce-initialize-cut-") as directory:
                plan = plan_instance(make_descriptor(directory))
                receipt = {"schemaVersion": 1, "instanceId": plan["descriptor"]["instanceId"], "companyId": "EmpresaNueva",
                           "planHash": plan["planHash"], "immutableHash": plan["immutableHash"],
                           "owner": "0" * 32, "docker": {}, "files": {}, "stages": {}}
                registry_path = pathlib.Path(directory) / "reservation.json"
                receipt_path = pathlib.Path(plan["descriptor"]["paths"]["state"]) / "installation-receipt.json"
                request = pathlib.Path(directory) / "request.json"
                request.write_bytes(canonical({"plan": plan, "receipt": receipt}))
                program = """import json,os,pathlib,sys
sys.path.insert(0,sys.argv[1])
import instance
request=json.loads(pathlib.Path(sys.argv[2]).read_text())
registry=pathlib.Path(sys.argv[3])
receipt=pathlib.Path(sys.argv[4])
cut=sys.argv[5]
original=instance.atomic_json
def interrupted(path,document,mode=0o600):
 original(path,document,mode)
 if (path==registry and "receiptSeed" in document and cut=="after-reservation") or (path==receipt and cut=="after-receipt"):
  os._exit(79)
instance.atomic_json=interrupted
instance.initialize_receipt(request["plan"],registry,receipt,seed=request["receipt"])
"""
                crashed = subprocess.run([sys.executable, "-c", program, str(COMMON), str(request), str(registry_path), str(receipt_path), cut])
                self.assertEqual(crashed.returncode, 79)
                intent = json.loads(registry_path.read_text())
                self.assertEqual(intent["receiptSeed"], receipt)
                if cut == "after-reservation":
                    self.assertFalse(receipt_path.exists())
                recovered = initialize(plan, registry_path, receipt_path)
                self.assertEqual(recovered, receipt)
                self.assertNotIn("receiptSeed", json.loads(registry_path.read_text()))
                self.assertEqual(json.loads(receipt_path.read_text()), receipt)
                self.assertEqual(initialize(plan, registry_path, receipt_path), receipt)
                registry_path.unlink()
                with self.assertRaises(InstanceError):
                    initialize(plan, registry_path, receipt_path, seed=receipt)

    def test_atomic_metadata_writes_do_not_follow_or_remove_fixed_temporary(self):
        path = pathlib.Path(self.temporary.name) / "metadata.json"
        sentinel = pathlib.Path(self.temporary.name) / "sentinel"
        sentinel.write_bytes(b"unrelated")
        fixed = path.with_name(path.name + ".tmp")
        fixed.symlink_to(sentinel)
        resources.atomic_json(path, {"first": True})
        resources.atomic_json(path, {"second": True})
        self.assertEqual(json.loads(path.read_text()), {"second": True})
        self.assertTrue(fixed.is_symlink())
        self.assertEqual(sentinel.read_bytes(), b"unrelated")

    def test_same_alias_allowed_in_distinct_instances(self):
        a = plan_instance(self.document)
        b = plan_instance(make_descriptor(self.temporary.name, "empresa-b", 10))
        self.assertFalse(resources.conflicts(a["resources"], b["resources"]))
        self.assertEqual(a["bootstrap"]["agents"][0]["alias"], b["bootstrap"]["agents"][0]["alias"])


if __name__ == "__main__":
    unittest.main()
