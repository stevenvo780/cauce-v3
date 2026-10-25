"""Plan, apply and revert the standard space without replacing original units."""
from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import importlib
import io
import json
import os
import pathlib
import re
import stat
import sys
import tarfile
import time
import uuid

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "ops/container-runtime"))
sys.path.insert(0, str(ROOT / "ops/scripts"))
import live_adapter as adapter  # noqa: E402
from cauce_container_base import bundle_digest  # noqa: E402
from container_alias_lib import load_container_aliases  # noqa: E402

OWNER = "s2b-espacio-estandar-prod-1025"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
NAME = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
REMOTE = (HERE / "espacio-estandar.remoto.py").read_text()
CANONICAL_DIGEST = (ROOT / "ops/container-runtime/cauce_container_base.py").read_text()


class Failure(RuntimeError):
    pass


def fail(code):
    raise Failure(code)


def now():
    return datetime.datetime.now(datetime.UTC).isoformat()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def read_json(filename, *, receipt=False):
    path = pathlib.Path(adapter.absolute(str(filename)))
    if path.resolve() != path:
        fail("SPACE_JSON_PATH_LINKED")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), encoding="utf8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4_194_304:
            fail("SPACE_JSON_FILE_INVALID")
        if receipt and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            fail("SPACE_RECEIPT_NOT_PRIVATE")
        value = json.load(stream)
    if receipt:
        expected = value.pop("receipt_sha256", None)
        if expected != fingerprint(value):
            fail("SPACE_RECEIPT_HASH_DIFFERS")
    return value


def checkpoint(path, receipt, phase, *, create=False):
    receipt.update(phase=phase, updated_at=now())
    receipt.pop("receipt_sha256", None)
    receipt["receipt_sha256"] = fingerprint(receipt)
    path = pathlib.Path(adapter.absolute(str(path)))
    current = path.parent
    while not current.exists():
        current = current.parent
    if current.resolve() != current or current.stat().st_mode & 0o022:
        fail("SPACE_RECEIPT_PARENT_UNSAFE")
    if not create:
        previous = read_json(path, receipt=True)
        if previous.get("operation") != receipt["operation"]:
            fail("SPACE_RECEIPT_OPERATION_CHANGED")
    adapter.save(path, receipt, create=create)


def inventory(path):
    value = read_json(path)
    rows = value.get("agents")
    if value.get("version") != 1 or not isinstance(rows, list) or not 1 <= len(rows) <= 16:
        fail("SPACE_INVENTORY_INVALID")
    seen = set()
    for row in rows:
        alias = row.get("alias", "")
        if not NAME.fullmatch(alias) or alias in seen:
            fail("SPACE_ALIAS_INVALID_OR_DUPLICATE")
        seen.add(alias)
        if row.get("kind") not in {"container", "native"} or row.get("transport") not in {"ssh", "docker"}:
            fail("SPACE_STRATEGY_OR_TRANSPORT_INVALID")
        for key in ("uid", "runtime_uid"):
            if not isinstance(row.get(key), int) or isinstance(row[key], bool) or row[key] <= 0:
                fail("SPACE_UID_INVALID")
        for key in ("manager", "runtime_user"):
            if not re.fullmatch(r"[a-z_][a-z0-9_-]*", row.get(key, "")):
                fail("SPACE_USER_INVALID")
        if not re.fullmatch(r"[A-Za-z0-9_.@-]+[.]service", row.get("unit", "")):
            fail("SPACE_UNIT_INVALID")
        for key in ("state_directory", "release_root"):
            adapter.absolute(row.get(key))
        for key in ("node_executable", "ops_root", "bundle_root", "config_root", "adapter_entry"):
            if row.get(key) is not None:
                adapter.absolute(row[key])
        destination = pathlib.Path(row["release_root"])
        if any(part in {"private", "credentials"} for part in destination.parts):
            fail("SPACE_RELEASE_DESTINATION_UNSAFE")
        for key in ("state_directory", "ops_root", "bundle_root", "config_root"):
            if row.get(key):
                existing = pathlib.Path(row[key])
                if destination.is_relative_to(existing) or existing.is_relative_to(destination):
                    fail("SPACE_RELEASE_DESTINATION_OVERLAPS_RUNTIME")
        if row["kind"] == "native" and (not row.get("node_executable") or row["runtime_uid"] != row["uid"]):
            fail("SPACE_NATIVE_IDENTITY_REQUIRED")
        if row["kind"] == "container" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", row.get("container", "")):
            fail("SPACE_CONTAINER_REQUIRED")
        if row.get("verification_scope", "roundtrip") not in {"roundtrip", "process_lease"}:
            fail("SPACE_VERIFICATION_SCOPE_INVALID")
        if not isinstance(row.get("preserve_paths", []), list) or len(row.get("preserve_paths", [])) > 64:
            fail("SPACE_PRESERVED_PATHS_INVALID")
        for item in row.get("preserve_paths", []):
            adapter.absolute(item)
        if row["transport"] == "ssh" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", row.get("host", "")):
            fail("SPACE_SSH_TARGET_INVALID")
    return rows


def lab_guard(agent, laboratory):
    if agent["transport"] == "ssh":
        if laboratory:
            fail("SPACE_LABORATORY_CANNOT_TARGET_SSH")
        return
    if not laboratory or not agent["alias"].startswith("zz-canary-") or agent.get("owner") != OWNER \
            or not re.fullmatch(r"[a-f0-9]{12}", agent.get("namespace", "")):
        fail("SPACE_LABORATORY_SCOPE_REQUIRED")
    namespace = agent["namespace"]
    host = agent.get("host", "")
    if not host.startswith("zz-canary-" + OWNER + "-" + namespace + "-"):
        fail("SPACE_LABORATORY_MANAGER_NAME_INVALID")
    context = os.environ.get("DOCKER_CONTEXT", "")
    home = os.environ.get("HOME", "")
    in_runner = home.startswith("/tmp/cauce-e2e-home-s2b-") and os.environ.get("DOCKER_HOST", "").startswith("unix://")
    if context not in {"lab", "lab2", "lab3"} and not in_runner:
        fail("SPACE_LABORATORY_DOCKER_ENDPOINT_REQUIRED")
    for target, manager in [(host, True)] + ([(agent["container"], False)] if agent["kind"] == "container" else []):
        if not target.startswith("zz-canary-") or namespace not in target:
            fail("SPACE_LABORATORY_CONTAINER_NAME_INVALID")
        output = adapter.checked(["docker", "inspect", "--format", "{{json .Config.Labels}}", target], timeout=30)
        labels = json.loads(output)
        if labels.get("cauce.e2e.owner") != OWNER or not manager and labels.get("cauce.e2e.run") != namespace:
            fail("SPACE_LABORATORY_OWNERSHIP_DIFFERS")
        if manager and labels.get("cauce.e2e.run") not in {None, namespace}:
            fail("SPACE_LABORATORY_NAMESPACE_DIFFERS")


def remote(agent, packet, *, timeout=210):
    payload = json.dumps({**packet, "agent": agent, "canonical_digest_source": CANONICAL_DIGEST}, separators=(",", ":")).encode()
    command = ["python3", "-I", "-B", "-c", REMOTE]
    if agent["transport"] == "ssh":
        output = adapter.remote(agent, command, data=payload, timeout=timeout)
    else:
        environment = ["env", "-C", "/", "XDG_RUNTIME_DIR=/run/user/" + str(agent["uid"]),
                       "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + str(agent["uid"]) + "/bus"]
        output = adapter.checked(["docker", "exec", "-i", "--user", str(agent["uid"]), agent["host"], *environment, *command],
                                 data=payload, timeout=timeout)
    result = json.loads(output)
    if result.get("ok") is not True:
        code = result.get("code", "")
        fail(code if re.fullmatch(r"SPACE_[A-Z_]+", code) else "SPACE_REMOTE_RESPONSE_INVALID")
    return result["value"]


def source_tree(directory, expected, kind):
    root = pathlib.Path(adapter.absolute(directory))
    if any(part in {"private", "credentials"} for part in root.parts):
        fail("SPACE_SOURCE_MAY_CONTAIN_CREDENTIALS")
    if root.resolve() != root or not root.is_dir() or not DIGEST.fullmatch(expected):
        fail("SPACE_APPROVED_SOURCE_INVALID")
    paths = [root]
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            if name in {"private", "credentials", "auth.json", ".env"} or name.startswith(".env.") and not name.endswith(".example"):
                fail("SPACE_SOURCE_MAY_CONTAIN_CREDENTIALS")
            paths.append(pathlib.Path(current) / name)
    if len(paths) > 30_000:
        fail("SPACE_APPROVED_SOURCE_TOO_LARGE")
    for path in paths:
        info = path.lstat()
        if not path.is_symlink() and info.st_mode & 0o222:
            fail("SPACE_APPROVED_SOURCE_NOT_IMMUTABLE")
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            fail("SPACE_APPROVED_SOURCE_LINK_ESCAPES")
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            fail("SPACE_APPROVED_SOURCE_TYPE_INVALID")
    required = ("scripts/adapter-space-launcher.sh", "scripts/container-adapter-supervisor.sh", "container-runtime/cauce_container_base.py") \
        if kind == "ops" else ("packages/adapter-sdk/dist/src/context/space-layout.js",)
    if any(not (root / name).is_file() or (root / name).is_symlink() for name in required):
        fail("SPACE_APPROVED_SOURCE_INCOMPLETE")
    if bundle_digest(str(root)) != expected:
        fail("SPACE_APPROVED_SOURCE_DIGEST_DIFFERS")
    return root


def artifact(root, digest, target):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as bundle:
        for path in sorted(root.rglob("*")):
            info = path.lstat()
            entry = tarfile.TarInfo(path.relative_to(root).as_posix())
            entry.mode = stat.S_IMODE(info.st_mode)
            if path.is_symlink():
                entry.type, entry.linkname = tarfile.SYMTYPE, os.readlink(path)
                bundle.addfile(entry)
            elif path.is_dir():
                entry.type = tarfile.DIRTYPE
                bundle.addfile(entry)
            else:
                entry.size = info.st_size
                with path.open("rb") as stream:
                    bundle.addfile(entry, stream)
    if bundle_digest(str(root)) != digest:
        fail("SPACE_APPROVED_SOURCE_CHANGED_DURING_PACK")
    content = output.getvalue()
    if len(content) > 134_217_728:
        fail("SPACE_APPROVED_SOURCE_TOO_LARGE")
    return {"archive": base64.b64encode(content).decode("ascii"), "digest": digest, "target": target}


def container_mapping(root, agent):
    if agent["kind"] != "container":
        return None
    try:
        entry = load_container_aliases(root, hardened=True, resolve_runtime=False)[agent["alias"]]
    except (KeyError, OSError, ValueError):
        fail("SPACE_APPROVED_CONTAINER_MAPPING_UNAVAILABLE")
    expected = {"container": agent["container"], "user": agent["runtime_user"], "stateDirectory": agent["state_directory"],
                "harness": agent["harness"], "tenant": agent["tenant_id"], "room": agent["room_id"], "systemdUser": agent["manager"]}
    if any(entry.get(key) != value for key, value in expected.items()) or entry.get("alias", agent["alias"]) != agent["alias"]:
        fail("SPACE_APPROVED_CONTAINER_MAPPING_DIFFERS")
    workspace = entry.get("workspace")
    declared = agent.get("provider_cwd") or agent.get("workspace")
    if declared is not None and workspace != declared or workspace is not None and workspace not in agent.get("preserve_paths", []):
        fail("SPACE_APPROVED_CONTAINER_WORKSPACE_UNVERIFIED")
    return entry


def targets(agent, ops_digest, sdk_digest):
    root = agent["release_root"]
    return {"ops_target": root + "/ops-" + ops_digest[7:],
            **({"sdk_target": root + "/sdk-" + sdk_digest[7:]} if sdk_digest else {})}


def assert_process(observed, before, *, applied):
    current, original = observed["process"], before["process"]
    if observed["unit_revision"] != before["unit_revision"] or observed["unit"]["KillMode"] != before["unit"]["KillMode"]:
        fail("SPACE_ORIGINAL_UNIT_CHANGED")
    if observed["unit"]["ActiveState"] != "active" or observed["unit"]["NeedDaemonReload"] != "no":
        fail("SPACE_UNIT_NOT_ACTIVE")
    for key in ("uid", "cwd", "entry", "release", "argv_sha256", "preserved"):
        if current[key] != original[key]:
            fail("SPACE_ORIGINAL_PROCESS_CONTRACT_CHANGED")
    if (current["pid"], current["ticks"]) == (original["pid"], original["ticks"]):
        fail("SPACE_ADAPTER_DID_NOT_RESTART")
    for name, entry in current["layout"].items():
        previous = original["layout"][name]
        if not applied and not entry["present"] and not previous["present"]:
            continue
        if not entry["present"] or not entry["directory"] or entry["symlink"] or entry["mode"] != "0700" or entry["uid"] != original["uid"]:
            fail("SPACE_LAYOUT_UNVERIFIED")
        if previous["present"] and entry != previous:
            fail("SPACE_EXISTING_LAYOUT_CHANGED")
    if applied and (not current["root_matches"] or not current["tmp_matches"]):
        fail("SPACE_INITIAL_ENVIRONMENT_UNVERIFIED")
    if not applied and any(current[key] != original[key] for key in ("root_matches", "tmp_matches")):
        fail("SPACE_ORIGINAL_ENVIRONMENT_NOT_RESTORED")


def console_client(args):
    if not args.sesion:
        fail("SPACE_EXISTING_CONSOLE_SESSION_REQUIRED")
    sys.path.insert(0, str(ROOT / "ops/cli"))
    from context_client import ConsoleSessionClient
    return ConsoleSessionClient(args.sesion, args.gateway, args.origin, args.ca_file)


def preflight_console(args, agent):
    probe = importlib.import_module("live_adapter_probe")
    probe.target(agent, agent["alias"])
    client = console_client(args)
    if probe.request(client, "GET", "/v3/auth/session").get("authenticated") is not True:
        fail("SPACE_CONSOLE_SESSION_NOT_AUTHENTICATED")
    return client


def record_failure(receipt, error):
    code = str(error)
    unknown = isinstance(error, adapter.CompletionUnknown) or code == "SPACE_COMMAND_COMPLETION_UNKNOWN"
    receipt.update(status="completion_unknown" if unknown else "recovery_required", completion_unknown=unknown,
                   last_error_code=code if re.fullmatch(r"(?:SPACE|PROBE)_[A-Z_]+", code) else "SPACE_VERIFICATION_OR_COMMAND_FAILED")


def verify(agent, packet, before, args, *, applied):
    deadline = time.monotonic() + args.timeout
    while True:
        try:
            observed = remote(agent, {**packet, "action": "inspect"})
            assert_process(observed, before, applied=applied)
            return observed
        except (Failure, adapter.Failure):
            if time.monotonic() >= deadline:
                raise
            time.sleep(min(1, max(0, deadline - time.monotonic())))


def delivery_probe(agent, packet, before, observed, args, started_at, *, applied):
    probe = importlib.import_module("live_adapter_probe")
    client = console_client(args)
    fixed = observed["process"]

    def physical_check(_agent, release, _client):
        try:
            current = remote(agent, {**packet, "action": "inspect", "include_instance": True})
            assert_process(current, before, applied=applied)
            process = current["process"]
            if any(process[key] != fixed[key] for key in ("pid", "ticks", "entry", "argv_sha256", "release")) or release != process["release"]:
                fail("SPACE_PROCESS_CHANGED_DURING_PROBE")
            instance = process.get("_instance_id")
            if not isinstance(instance, str) or not instance or len(instance) > 200:
                fail("SPACE_PROCESS_INSTANCE_UNVERIFIED")
            return {"process_alive": True, "effective_release": process["release"], "pid": process["pid"], "ticks": process["ticks"],
                    "expected_instance_id": instance}
        except (Failure, adapter.Failure):
            raise probe.ProbeFailure("PROBE_CANONICAL_PROCESS_CHECK_FAILED") from None

    if agent.get("verification_scope", "roundtrip") == "roundtrip":
        return probe.run_probe(agent, agent["alias"], fixed["release"], uuid.uuid4().hex, started_at, client,
                               args.timeout, physical_check=physical_check)
    proof = physical_check(agent, fixed["release"], client)
    deadline = time.monotonic() + args.timeout
    try:
        start = probe.timestamp(started_at)
        while not probe.presence(client, agent["tenant_id"], agent["alias"], start, proof["expected_instance_id"]):
            if time.monotonic() >= deadline:
                result = {"process_alive": True, "lease_observable": False, "lease_valid": False, "delivery_done": False,
                          "reason": "SPACE_FRESH_LEASE_NOT_OBSERVABLE"}
                break
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        else:
            result = {"process_alive": True, "lease_observable": True, "lease_valid": True, "delivery_done": False,
                      "reason": "SPACE_CROSS_COMPANY_ROUNDTRIP_NOT_REQUESTED"}
    except probe.ProbeFailure:
        result = {"process_alive": True, "lease_observable": False, "lease_valid": False, "delivery_done": False,
                  "reason": "SPACE_LEASE_VISIBILITY_OR_CONTRACT_UNAVAILABLE"}
    if physical_check(agent, fixed["release"], client) != proof:
        fail("SPACE_PROCESS_CHANGED_DURING_PROBE")
    return result


def apply(agent, args, ops, sdk):
    mapping = container_mapping(ops, agent)
    preflight_console(args, agent)
    operation = uuid.uuid4().hex
    packet = {"operation": operation, **targets(agent, args.ops_sha256, args.sdk_sha256 if sdk else None)}
    before = remote(agent, {**packet, "action": "plan", "expected_mapping": mapping})
    packet.update(before_revision=before["unit_revision"], dropin_sha256=before["planned_dropin_sha256"])
    receipt = {"version": 1, "owner": OWNER, "operation": operation, "alias": agent["alias"], "status": "applying",
               "agent_sha256": fingerprint(agent), "created_at": now(), "before": before,
               "ops_digest": args.ops_sha256, "sdk_digest": args.sdk_sha256 if sdk else None,
               "packet": packet, "production": agent["transport"] == "ssh", "verification_scope": agent.get("verification_scope", "roundtrip")}
    checkpoint(args.recibo, receipt, "prepared", create=True)
    try:
        archives = [artifact(ops, args.ops_sha256, packet["ops_target"])]
        if sdk:
            archives.append(artifact(sdk, args.sdk_sha256, packet["sdk_target"]))
        checkpoint(args.recibo, receipt, "install_pending")
        receipt["installation"] = remote(agent, {**packet, "action": "install", "artifacts": archives})
        checkpoint(args.recibo, receipt, "dropin_pending")
        receipt["dropin"] = remote(agent, {**packet, "action": "dropin"})
        checkpoint(args.recibo, receipt, "restart_pending")
        receipt["started_at"] = now()
        receipt["restart"] = remote(agent, {**packet, "action": "activate"})
        checkpoint(args.recibo, receipt, "verify_pending")
        receipt["after"] = verify(agent, packet, before, args, applied=True)
        receipt["restart_to_process_seconds"] = time.time() - datetime.datetime.fromisoformat(receipt["started_at"]).timestamp()
        checkpoint(args.recibo, receipt, "probe_pending")
        receipt["probe"] = delivery_probe(agent, packet, before, receipt["after"], args, receipt["started_at"], applied=True)
        receipt["status"] = "complete" if receipt["probe"].get("delivery_done") is True else "partial"
        checkpoint(args.recibo, receipt, "verified")
        return receipt
    except Exception as error:
        record_failure(receipt, error)
        checkpoint(args.recibo, receipt, receipt["phase"])
        raise


def rollback(agent, args):
    receipt = read_json(args.recibo, receipt=True)
    if receipt.get("version") != 1 or receipt.get("owner") != OWNER or receipt.get("alias") != agent["alias"] \
            or receipt.get("agent_sha256") != fingerprint(agent):
        fail("SPACE_ROLLBACK_RECEIPT_TARGET_DIFFERS")
    if receipt.get("status") == "reverted":
        fail("SPACE_RECEIPT_ALREADY_REVERTED")
    if receipt.get("completion_unknown") is True:
        fail("SPACE_UNKNOWN_COMPLETION_REQUIRES_CANONICAL_SETTLEMENT")
    preflight_console(args, agent)
    packet = receipt["packet"]
    checkpoint(args.recibo, receipt, "revert_pending")
    receipt["revert_started_at"] = now()
    try:
        receipt["revert"] = remote(agent, {**packet, "action": "revert"})
        checkpoint(args.recibo, receipt, "revert_verify_pending")
        receipt["reverted"] = verify(agent, packet, receipt["before"], args, applied=False)
        checkpoint(args.recibo, receipt, "revert_probe_pending")
        receipt["revert_probe"] = delivery_probe(agent, packet, receipt["before"], receipt["reverted"], args,
                                                 receipt["revert_started_at"], applied=False)
        receipt["status"] = "reverted"
        checkpoint(args.recibo, receipt, "reverted")
        return receipt
    except Exception as error:
        record_failure(receipt, error)
        checkpoint(args.recibo, receipt, receipt["phase"])
        raise


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--simular", nargs="?", const="*")
    modes.add_argument("--aplicar")
    modes.add_argument("--revertir")
    parser.add_argument("--inventario", default=str(HERE / "espacio-estandar.inventario.json"))
    for option in ("ops-release", "ops-sha256", "sdk-release", "sdk-sha256", "recibo", "sesion", "gateway", "origin", "ca-file"):
        parser.add_argument("--" + option)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--laboratorio", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 900:
        fail("SPACE_TIMEOUT_INVALID")
    if (args.aplicar or args.revertir) and not NAME.fullmatch(args.aplicar or args.revertir):
        fail("SPACE_MUTATION_REQUIRES_ONE_EXACT_ALIAS")
    rows = inventory(args.inventario)
    selected = args.aplicar or args.revertir or args.simular or "*"
    agents = rows if selected == "*" else [row for row in rows if row["alias"] == selected]
    if not agents:
        fail("SPACE_SELECTED_ALIAS_NOT_FOUND")
    for agent in agents:
        lab_guard(agent, args.laboratorio)
    if args.revertir:
        if not args.recibo:
            fail("SPACE_ROLLBACK_RECEIPT_REQUIRED")
        return rollback(agents[0], args)
    mutating = bool(args.aplicar)
    if mutating and (not args.recibo or not args.ops_release or not args.ops_sha256):
        fail("SPACE_APPLY_RECEIPT_AND_OPS_APPROVAL_REQUIRED")
    ops = source_tree(args.ops_release, args.ops_sha256, "ops") if args.ops_release and args.ops_sha256 else None
    needs_sdk = any(agent["kind"] == "native" for agent in agents)
    sdk = source_tree(args.sdk_release, args.sdk_sha256, "sdk") if args.sdk_release and args.sdk_sha256 else None
    if mutating:
        if needs_sdk and not sdk:
            fail("SPACE_NATIVE_SDK_APPROVAL_REQUIRED")
        return apply(agents[0], args, ops, sdk if needs_sdk else None)
    result = {"version": 1, "simulated": True, "writes": False, "http_requests": False, "agents": []}
    for agent in agents:
        packet = {"operation": uuid.uuid4().hex}
        blockers = []
        if not ops:
            blockers.append("SPACE_OPS_APPROVAL_REQUIRED")
        if agent["kind"] == "native" and not sdk:
            blockers.append("SPACE_NATIVE_SDK_APPROVAL_REQUIRED")
        if not blockers:
            packet.update(targets(agent, args.ops_sha256, args.sdk_sha256 if agent["kind"] == "native" else None))
        mapping = container_mapping(ops, agent) if ops else None
        observed = remote(agent, {**packet, "action": "inspect" if blockers else "plan", "expected_mapping": mapping})
        result["agents"].append({"alias": agent["alias"], "kind": agent["kind"], "ready": not blockers,
                                  "blockers": blockers, "before": observed})
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(main(), sort_keys=True, separators=(",", ":")))
    except Exception as error:
        code = str(error) if isinstance(error, Failure) else "SPACE_OPERATION_FAILED_WITHOUT_SECRET_OUTPUT"
        print(json.dumps({"ok": False, "code": code}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1) from None
