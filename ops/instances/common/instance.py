from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import uuid
from datetime import datetime, timezone

import resources
from bootstrap import (
    bootstrap_fresh,
    update_database_marker,
    validate_database_reference,
    validate_existing_database,
    verify_runtime_migrations,
)
from descriptor import InstanceError, canonical, safe_path
from descriptor import load_instance_descriptor as load_instance_descriptor
from planning import load_exporter, plan_instance
from resources import atomic_json, check_ports, create_owned_resources, run, verify_owned_resources, verify_receipt


def receipt_path(plan):
    return pathlib.Path(plan["descriptor"]["paths"]["state"]) / "installation-receipt.json"


def write_owned(path, body, receipt, save, *, plan):
    path = resources.managed_output_path(plan, str(path))
    resources.recover_file_write(plan, receipt, save)
    current = resources.file_details(path)
    old_hash = receipt["files"].get(str(path))
    if (current is not None and old_hash != current["sha256"]) or (current is None and old_hash is not None):
        raise InstanceError(f"unknown or changed generated file: {path}")
    new_hash = hashlib.sha256(body).hexdigest()
    if current is not None and new_hash == old_hash:
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".cauce-write-" + receipt["owner"] + "-", dir=path.parent)
    temporary = pathlib.Path(name)
    with os.fdopen(fd, "wb") as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    details = resources.file_details(temporary)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    receipt["stages"]["fileWriteIntent"] = {
        "path": str(path), "temporary": str(temporary), "oldHash": old_hash, "newHash": new_hash,
        "temporaryIdentity": {key: details[key] for key in ("device", "inode")},
        "owner": receipt["owner"], "installerUid": os.getuid(), "planHash": receipt["planHash"],
    }
    save()
    resources.recover_file_write(plan, receipt, save)


def assert_input_files(plan):
    descriptor = plan["descriptor"]
    for value in [descriptor["identityRefs"]["bootstrap"], *descriptor["identityRefs"]["secretFiles"].values()]:
        path = safe_path(value)
        if not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_nlink != 1:
            raise InstanceError("instance input reference must be an owned regular file")
    for name in ("mtls_identities.json", "token_hashes.json"):
        path = safe_path(str(pathlib.Path(descriptor["paths"]["config"]) / "identities" / name))
        if not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_nlink != 1:
            raise InstanceError("own instance authentication registry is required")
    validate_database_reference(plan)


def current_postgres(plan):
    compose = plan["commands"][0][:6]
    ids = run([*compose, "ps", "-q", "postgres"]).split()
    if len(ids) != 1:
        raise InstanceError("owned postgres container not uniquely present")
    return ids[0]


def synchronize_update_reservation(plan, receipt, registry_path):
    safe_path(str(registry_path))
    reservation = resources.read_reservation(registry_path, own=True)
    if (reservation.get("installerUid") != os.getuid()
            or reservation.get("owner") != receipt["owner"]
            or reservation.get("immutableHash") != plan["immutableHash"]
            or canonical(reservation.get("resources")) != canonical(plan["resources"])):
        raise InstanceError("update reservation ownership or immutable resources differ")
    if reservation["planHash"] == receipt["planHash"] == plan["planHash"]:
        return
    previous_hash = receipt["stages"].get("updatePreviousPlanHash")
    if receipt["planHash"] != plan["planHash"] or reservation["planHash"] != previous_hash:
        raise InstanceError("update reservation does not match the durable receipt transition")
    reservation["planHash"] = plan["planHash"]
    atomic_json(registry_path, reservation, mode=0o640)



def initialize_receipt(plan, registry_path, path, seed=None):
    if seed is not None:
        if registry_path.exists() or path.exists():
            raise InstanceError("initialization cannot adopt an existing resource")
        reservation = {"planHash": plan["planHash"], "immutableHash": plan["immutableHash"], "owner": seed["owner"],
                       "resources": plan["resources"], "installerUid": os.getuid(), "receiptSeed": seed}
        atomic_json(registry_path, reservation, mode=0o640)
    else:
        reservation = resources.read_reservation(registry_path, own=True)
    if path.exists():
        resources.file_details(path)
    seed = reservation.get("receiptSeed")
    if seed is None:
        if not path.is_file():
            raise InstanceError("host reservation has no ownership receipt")
        return json.loads(path.read_text())
    if (reservation.get("installerUid") != os.getuid() or reservation.get("owner") != seed.get("owner")
            or reservation.get("planHash") != plan["planHash"] or reservation.get("immutableHash") != plan["immutableHash"]
            or canonical(reservation.get("resources")) != canonical(plan["resources"])):
        raise InstanceError("initialization reservation identity differs")
    verify_receipt(plan, seed)
    if seed["docker"] or seed["files"] or seed["stages"]:
        raise InstanceError("initialization seed must be pristine")
    verify_owned_resources(plan, seed)
    if path.exists():
        if canonical(json.loads(path.read_text())) != canonical(seed):
            raise InstanceError("initialization receipt differs from its durable seed")
    else:
        for root in plan["resources"]["roots"]:
            safe_path(root).mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_json(path, seed)
    reservation.pop("receiptSeed")
    atomic_json(registry_path, reservation, mode=0o640)
    return seed

def apply_instance(plan, *, update=False):
    reconstructed = plan_instance(plan["descriptor"])
    if canonical(plan) != canonical(reconstructed):
        raise InstanceError("plan changed or code/inputs drifted")
    plan = reconstructed
    with resources.reservation_lock(require_shared=True):
        resources.check_reservations(plan, update=update)
        registry_path = resources.REGISTRY_ROOT / (plan["descriptor"]["instanceId"] + ".json")
        path = safe_path(str(receipt_path(plan)))
        fresh = not registry_path.exists()
        if fresh:
            if update:
                raise InstanceError("update requires an installed ownership receipt")
            if path.exists():
                raise InstanceError("receipt without host reservation cannot adopt resources")
            assert_input_files(plan)
            check_ports(plan["resources"])
            inventory_root = safe_path(plan["descriptor"]["inventoryRoot"])
            if inventory_root.exists() and any(inventory_root.iterdir()):
                raise InstanceError("unknown inventory directory")
            state = safe_path(plan["descriptor"]["paths"]["state"])
            if state.exists() and any(state.iterdir()):
                raise InstanceError("unknown state directory, including unowned storage")
            receipt = {"schemaVersion": 1, "instanceId": plan["descriptor"]["instanceId"],
                       "companyId": plan["descriptor"]["companyId"], "planHash": plan["planHash"],
                       "owner": uuid.uuid4().hex, "docker": {}, "files": {}, "stages": {}, "immutableHash": plan["immutableHash"]}
            verify_owned_resources(plan, receipt)
            verify_runtime_migrations(plan)
            receipt = initialize_receipt(plan, registry_path, path, seed=receipt)
        else:
            receipt = initialize_receipt(plan, registry_path, path)
            if path.stat().st_uid != os.getuid() or path.stat().st_nlink != 1 or path.stat().st_mode & 0o077:
                raise InstanceError("ownership receipt metadata is unsafe")
            receipt = json.loads(path.read_text())
            reservation = resources.read_reservation(registry_path, own=True)
            if reservation["owner"] != receipt["owner"]:
                raise InstanceError("receipt owner differs from host reservation")
            verify_receipt(plan, receipt, update=update)
            assert_input_files(plan)
            verify_owned_resources(plan, receipt)
        def save():
            atomic_json(path, receipt)
        resources.recover_file_write(plan, receipt, save)
        if update and receipt["planHash"] != plan["planHash"]:
            if receipt["stages"].get("updatePreviousPlanHash"):
                raise InstanceError("another exact update plan is already pending")
            if not receipt["stages"].get("bootstrapped"):
                raise InstanceError("update requires completed bootstrap")
            verify_runtime_migrations(plan)
            old_hash = receipt["planHash"]
            receipt["planHash"] = plan["planHash"]
            receipt["stages"]["updatePreviousPlanHash"] = old_hash
            for stage in ("configuration", "migrated", "snapshot", "units", "started"):
                receipt["stages"].pop(stage, None)
            save()
        synchronize_update_reservation(plan, receipt, registry_path)
        create_owned_resources(plan, receipt, save)
        receipt["stages"]["freshStorage"] = True
        save()
        descriptor = plan["descriptor"]
        inventory = pathlib.Path(descriptor["inventoryRoot"]) / "ops"
        generated = inventory / "generated/instance"
        compose = json.loads(canonical(plan["compose"]))
        for service in compose["services"].values():
            service.setdefault("labels", {}).update({"io.cauce.installation": receipt["instanceId"], "io.cauce.owner": receipt["owner"]})
        if not receipt["stages"].get("configuration"):
            write_owned(generated / "compose.json", canonical(compose), receipt, save, plan=plan)
            env_body = "".join(key + "=" + value + "\n" for key, value in sorted(plan["environment"].items()) if key.startswith(("CAUCE_", "COMPOSE_", "GATEWAY_", "CONSOLE_", "TERMINAL_", "POSTGRES_")))
            write_owned(generated / "instance.env", env_body.encode(), receipt, save, plan=plan)
            writer_path = pathlib.Path(descriptor["paths"]["state"]) / "writer"
            writer_snapshot = canonical({"schemaVersion": 1, "installationId": receipt["instanceId"], "writers": []})
            write_owned(writer_path, writer_snapshot, receipt, save, plan=plan)
            marker = {"kind": "cauce-v3-release-state", "mode": "candidate", "releaseId": "cauce-" + receipt["instanceId"],
                      "schemaVersion": 1, "snapshotPath": str(writer_path),
                      "snapshotSha256": "sha256:" + hashlib.sha256(writer_snapshot).hexdigest(),
                      "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                      "writersExpected": 0, "writersObserved": 0}
            marker_bytes = (json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n").encode()
            write_owned(writer_path.with_name("writer.state.json"), marker_bytes, receipt, save, plan=plan)
            for name in ("terminal", "telegram"):
                (pathlib.Path(descriptor["paths"]["config"]) / name).mkdir(mode=0o700, exist_ok=True)
            (pathlib.Path(descriptor["paths"]["state"]) / "media").mkdir(mode=0o700, exist_ok=True)
            receipt["stages"]["configuration"] = True
            save()
        if receipt["stages"].get("bootstrapped"):
            validate_existing_database(plan, receipt, current_postgres(plan))
        if not receipt["stages"].get("migrated"):
            run(plan["commands"][0], env=plan["environment"])
            run(plan["commands"][1], env=plan["environment"])
            receipt["stages"]["migrated"] = plan["sourceHash"]
            save()
        if receipt["stages"].get("updatePreviousPlanHash"):
            update_database_marker(plan, receipt, current_postgres(plan))
            receipt["stages"].pop("updatePreviousPlanHash")
            save()
        if not receipt["stages"].get("bootstrapped"):
            container = current_postgres(plan)
            bootstrap_fresh(plan, receipt, container, save)
            receipt["stages"]["bootstrapped"] = plan["bootstrapHash"]
            save()
        if not receipt["stages"].get("snapshot"):
            exporter = load_exporter(descriptor["codeRoot"])
            source = exporter.query_database(postgres_container=current_postgres(plan))
            snapshot = exporter.snapshot_document(source)
            write_owned(inventory / "flota.json", exporter.canonical_bytes(snapshot), receipt, save, plan=plan)
            code = pathlib.Path(descriptor["codeRoot"])
            spec = importlib.util.spec_from_file_location("instance_alias_generator", code / "ops/scripts/generate-container-aliases.py")
            generator = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(generator)
            aliases = generator.render(generator.load_snapshot(inventory / "flota.json"))
            write_owned(inventory / "container-aliases.json", aliases.encode(), receipt, save, plan=plan)
            receipt["stages"]["snapshot"] = hashlib.sha256(exporter.canonical_bytes(snapshot)).hexdigest()
            save()
        if not receipt["stages"].get("units"):
            with tempfile.TemporaryDirectory(prefix="unit-stage-", dir=descriptor["paths"]["state"]) as stage_name:
                stage = pathlib.Path(stage_name)
                code = pathlib.Path(descriptor["codeRoot"])
                run(["python3", str(code / "ops/scripts/generate-container-units.py"), "--instance-id", descriptor["instanceId"],
                     "--ops-root", str(inventory), "--inventory-prefix", str(inventory), "--install-prefix", str(code),
                     "--rootless", "--config-root", str(pathlib.Path(descriptor["paths"]["config"]) / "container-aliases"),
                     "--pki-root", descriptor["paths"]["pki"], "--bundle-root", descriptor["paths"]["bundles"],
                     "--lock-root", descriptor["paths"]["locks"], "--no-profile-expectation", "--output", str(stage / "container-systemd")])
                for source in sorted(stage.rglob("*")):
                    if source.is_file():
                        write_owned(inventory / "generated" / source.relative_to(stage), source.read_bytes(), receipt, save, plan=plan)
            receipt["stages"]["units"] = plan["sourceHash"]
            save()
        if not receipt["stages"].get("started"):
            run(plan["commands"][2], env=plan["environment"])
            receipt["stages"]["started"] = True
            save()
        verify_owned_resources(plan, receipt)
        return receipt


def status_instance(descriptor):
    plan = plan_instance(descriptor)
    path = safe_path(str(receipt_path(plan)))
    if not path.is_file():
        return {"instanceId": descriptor["instanceId"], "status": "not-installed"}
    with resources.reservation_lock(require_shared=True, readonly=True):
        resources.check_reservations(plan)
        receipt = json.loads(path.read_text())
        verify_receipt(plan, receipt)
        reservation = resources.read_reservation(resources.REGISTRY_ROOT / (descriptor["instanceId"] + ".json"), own=True)
        if receipt["owner"] != reservation["owner"]:
            raise InstanceError("receipt owner differs from host reservation")
        verify_owned_resources(plan, receipt)
    return {"instanceId": descriptor["instanceId"], "status": "installed" if receipt["stages"].get("started") else "incomplete",
            "planHash": receipt["planHash"], "stages": receipt["stages"]}
