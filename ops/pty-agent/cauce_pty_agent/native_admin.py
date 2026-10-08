from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from .native_admin_paths import (
    ID,
    NativeError,
    digest,
    directory,
    durable_read_path,
    kind_directory,
    piece_path,
    read_at,
    read_path,
    roots,
    write_private,
)
from .native_admin_projection import descriptor, markdown, project_mcp, public_server, servers
from .native_admin_vendor import recognize


def valid_uuid(value: Any) -> bool:
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value and uuid.UUID(value).version == 4
    except (ValueError, AttributeError):
        return False


def identity(bundle: dict[str, Any], writer: str) -> dict[str, str]:
    return {"generation": bundle["generation"], "container_id": bundle["container_id"], "writer_instance_id": writer}


@contextmanager
def private_state(bundle: dict[str, Any]) -> Iterator[int]:
    _, root = roots(bundle)
    with directory(root + "/.cauce-native-admin", create=True) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise NativeError("unsafe_path")
        lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            if os.fstat(lock).st_uid != os.geteuid() or os.fstat(lock).st_mode & 0o077:
                raise NativeError("unsafe_path")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield fd
        except BlockingIOError:
            raise NativeError("conflict") from None
        finally:
            os.close(lock)


def mutation_plan(bundle: dict[str, Any], mutation: dict[str, Any]) -> tuple[dict[str, Any], bytes | None, bytes | None]:
    if (not isinstance(mutation, dict) or not set(mutation).issubset({"kind", "id", "action", "expected_sha", "value"})
            or not {"kind", "id", "action", "expected_sha"}.issubset(mutation)):
        raise NativeError("invalid_input")
    kind, identifier, action = mutation["kind"], mutation["id"], mutation["action"]
    if not isinstance(identifier, str) or not ID.fullmatch(identifier) or action not in ("put", "delete"):
        raise NativeError("invalid_input")
    expected = mutation["expected_sha"]
    if expected is not None and (not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected)):
        raise NativeError("invalid_input")
    path = piece_path(bundle, kind, identifier)
    before = read_path(path)
    if digest(before) != expected:
        raise NativeError("conflict")
    if action == "delete" and (expected is None or "value" in mutation):
        raise NativeError("invalid_input")
    if kind == "mcp":
        entries = servers(bundle["harness"], before)
        if action == "delete" and identifier not in entries:
            raise NativeError("not_found")
        value = mutation.get("value")
        if action == "put" and (not isinstance(value, dict) or set(value) != {"mcp"}):
            raise NativeError("invalid_input")
        after = project_mcp(bundle["harness"], before, identifier, descriptor(value["mcp"]) if action == "put" else None)
    else:
        after = markdown(kind, identifier, mutation.get("value")) if action == "put" else None
    return ({"type": "plan", "kind": kind, "id": identifier, "path": path,
             "before_sha": digest(before), "target_sha": digest(after), "bytes": len(after) if after else 0}, before, after)


def inspect(bundle: dict[str, Any], kind: str, identifier: str) -> dict[str, Any]:
    path = piece_path(bundle, kind, identifier)
    raw = read_path(path)
    piece: dict[str, Any] = {"kind": kind, "id": identifier, "sha": digest(raw), "editable": True}
    if kind == "mcp":
        entry = servers(bundle["harness"], raw).get(identifier)
        if entry is not None:
            public = public_server(bundle["harness"], entry)
            piece["editable"] = public is not None
            if public is not None:
                piece["value"] = {"mcp": public}
    elif raw is not None:
        if len(raw) > 16384:
            raise NativeError("too_large")
        try:
            piece["value"] = {"content": raw.decode()}
        except UnicodeError:
            raise NativeError("unsupported") from None
    return {"type": "piece", "piece": piece}


def inventory(bundle: dict[str, Any], kind: str) -> dict[str, Any]:
    if kind == "mcp":
        raw = read_path(piece_path(bundle, kind, "inventory"))
        entries = servers(bundle["harness"], raw)
        candidates = [{"id": name, "editable": public_server(bundle["harness"], value) is not None}
                      for name, value in entries.items() if ID.fullmatch(name)]
    else:
        try:
            with directory(kind_directory(bundle, kind)) as fd:
                with os.scandir(fd) as iterator:
                    names = [entry.name for _, entry in zip(range(1001), iterator, strict=False)]
                candidates = []
                for name in names[:1000]:
                    identifier = name if kind == "skill" else name.removesuffix(".md")
                    if ID.fullmatch(identifier) and (kind == "skill" or name.endswith(".md")):
                        try:
                            if read_path(piece_path(bundle, kind, identifier)) is not None:
                                candidates.append({"id": identifier, "editable": True})
                        except NativeError:
                            continue
        except NativeError as error:
            if error.code != "not_found":
                raise
            candidates = []
    candidates.sort(key=lambda item: item["id"])
    omitted = len(entries) != len(candidates) if kind == "mcp" else len(names) > 1000 if "names" in locals() else False
    return {"type": "inventory", "kind": kind, "items": candidates[:100], "truncated": len(candidates) > 100 or omitted}


def operation_record(command: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    operation = command.get("operation")
    if (not isinstance(operation, dict) or set(operation) != {"operation_id", "operation_token", "operation_generation"}
            or not all(valid_uuid(value) for value in operation.values())):
        raise NativeError("invalid_input")
    metadata = {"operation_id": operation["operation_id"], "operation_generation": operation["operation_generation"],
                "token_sha": hashlib.sha256(operation["operation_token"].encode()).hexdigest(),
                "mutation_sha": hashlib.sha256(json.dumps(command["mutation"], sort_keys=True).encode()).hexdigest()}
    return operation["operation_id"] + ".json", metadata


def status(bundle: dict[str, Any], writer: str, command: dict[str, Any], fd: int) -> dict[str, Any]:
    name, expected = operation_record(command)
    _, root = roots(bundle)
    raw = read_at(fd, name)
    if raw is None:
        if sum(1 for _ in os.scandir(fd)) >= 4096:
            raise NativeError("too_large")
        mutation = command["mutation"]
        path = piece_path(bundle, mutation["kind"], mutation["id"])
        current = durable_read_path(path, root)
        if digest(current) != mutation.get("expected_sha"):
            raise NativeError("conflict")
        backup = str(uuid.uuid4())
        write_private(fd, backup + ".backup", current if current is not None else b"")
        receipt = {"type": "receipt", "state": "done", "operation_id": expected["operation_id"],
                   "operation_generation": expected["operation_generation"], "identity": identity(bundle, writer),
                   "kind": mutation["kind"], "id": mutation["id"], "path": path, "sha": digest(current),
                   "bytes": len(current) if current else 0, "backup_id": backup}
        write_private(fd, name, json.dumps({**expected, "state": "done", "receipt": receipt}).encode())
        return receipt
    record = json.loads(raw)
    if any(not hmac.compare_digest(str(record.get(key)), value) for key, value in expected.items()):
        raise NativeError("conflict")
    receipt = record.get("receipt")
    if record.get("state") == "writing":
        plan = record.get("plan", {})
        path = piece_path(bundle, command["mutation"]["kind"], command["mutation"]["id"])
        if plan.get("path") != path or plan.get("before_sha") != command["mutation"].get("expected_sha"):
            raise NativeError("conflict")
        current = durable_read_path(path, root)
        sha = digest(current)
        if sha not in (plan.get("before_sha"), plan.get("target_sha")):
            raise NativeError("conflict")
        receipt = {"type": "receipt", "state": "done", "operation_id": expected["operation_id"],
                   "operation_generation": expected["operation_generation"], "identity": identity(bundle, writer),
                   "kind": command["mutation"]["kind"], "id": command["mutation"]["id"], "path": path,
                   "sha": sha, "bytes": len(current) if current else 0, "backup_id": record["backup_id"]}
        temporary = name + ".recovered"
        write_private(fd, temporary, json.dumps({**expected, "state": "done", "receipt": receipt}).encode())
        os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    if (record.get("state") not in ("done", "writing") or not isinstance(receipt, dict)
            or receipt.get("identity") != identity(bundle, writer)
            or receipt.get("path") != piece_path(bundle, command["mutation"]["kind"], command["mutation"]["id"])):
        raise NativeError("unavailable")
    backup = read_at(fd, receipt["backup_id"] + ".backup")
    expected_backup = command["mutation"].get("expected_sha")
    if backup is None or (backup != b"" if expected_backup is None else digest(backup) != expected_backup):
        raise NativeError("unavailable")
    current = durable_read_path(receipt["path"], root)
    if digest(current) != receipt["sha"] or (len(current) if current else 0) != receipt["bytes"]:
        raise NativeError("conflict")
    return receipt


def mutate(bundle: dict[str, Any], writer: str, command: dict[str, Any], fd: int) -> dict[str, Any]:
    name, metadata = operation_record(command)
    if read_at(fd, name) is not None:
        return status(bundle, writer, command, fd)
    if sum(1 for _ in os.scandir(fd)) >= 4096:
        raise NativeError("too_large")
    plan, before, after = mutation_plan(bundle, command["mutation"])
    backup = str(uuid.uuid4())
    write_private(fd, backup + ".backup", before if before is not None else b"")
    write_private(fd, name, json.dumps({**metadata, "state": "writing", "backup_id": backup, "plan": plan}).encode())
    path = plan["path"]
    with directory(os.path.dirname(path), create=True) as parent:
        target = os.path.basename(path)
        if digest(read_at(parent, target)) != plan["before_sha"]:
            raise NativeError("conflict")
        temporary = ".cauce-native-" + backup
        if after is not None:
            write_private(parent, temporary, after)
        if digest(read_at(parent, target)) != plan["before_sha"]:
            if after is not None:
                os.unlink(temporary, dir_fd=parent)
            raise NativeError("conflict")
        if after is None:
            os.unlink(target, dir_fd=parent)
        else:
            os.replace(temporary, target, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
        if digest(read_at(parent, target)) != plan["target_sha"]:
            raise NativeError("unavailable")
    receipt = {"type": "receipt", "state": "done", "operation_id": metadata["operation_id"],
               "operation_generation": metadata["operation_generation"], "identity": identity(bundle, writer),
               "kind": plan["kind"], "id": plan["id"], "path": path, "sha": plan["target_sha"],
               "bytes": plan["bytes"], "backup_id": backup}
    temporary = name + ".done"
    write_private(fd, temporary, json.dumps({**metadata, "state": "done", "receipt": receipt}).encode())
    os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)
    return status(bundle, writer, command, fd)


def execute_native_admin(bundle: dict[str, Any], writer: str, command: dict[str, Any]) -> dict[str, Any]:
    try:
        if command.get("identity") != identity(bundle, writer) or not valid_uuid(command.get("request_id")):
            raise NativeError("conflict")
        op = command.get("op")
        expected = {"request_id", "identity", "op"} | ({"kind"} if op == "list" else {"kind", "id"} if op == "get"
                   else {"kind", "id", "expected_sha"} if op == "recognize"
                   else {"mutation", "operation"} if op in ("mutate", "status") else {"mutation"})
        if set(command) != expected:
            raise NativeError("invalid_input")
        if op == "recognize":
            return recognize(bundle, command["kind"], command["id"], command["expected_sha"])
        if op == "list":
            return inventory(bundle, command["kind"])
        if op == "get":
            return inspect(bundle, command["kind"], command["id"])
        with private_state(bundle) as fd:
            if op == "prepare":
                return mutation_plan(bundle, command["mutation"])[0]
            if op == "status":
                return status(bundle, writer, command, fd)
            if op == "mutate":
                return mutate(bundle, writer, command, fd)
        raise NativeError("invalid_input")
    except NativeError as error:
        return {"type": "error", "error": error.code}
    except (OSError, ValueError, KeyError, TypeError):
        return {"type": "error", "error": "unavailable"}
