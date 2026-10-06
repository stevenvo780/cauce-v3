"""Protect supervisor controls and atomically preserve causal state."""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import stat
import tempfile
import uuid
from pathlib import Path

# cauce:requiere none

class SupervisionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def command_identity(command: list[str]) -> dict:
    if command[:2] != ["git", "-C"]:
        return {}
    owner = Path(command[2]).stat()
    if owner.st_uid == 0:
        raise SupervisionError("git_workspace_requires_unprivileged_owner")
    if os.geteuid() != 0:
        raise SupervisionError("git_requires_actor_isolation")
    if command[2] != "/opt/hospital-agent/runtime/praxis/operator" or owner.st_uid != 1000:
        raise SupervisionError("git_workspace_requires_actor_isolation")
    return {}


def isolated_command(command: list[str]) -> list[str]:
    if command[:2] != ["git", "-C"]:
        return command
    command_identity(command)
    return ["docker", "exec", "-u", "1000:1000", "hospital-agent-openclaw-operator-gateway-1",
            "git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C",
            "/home/node/.openclaw/workspace/praxis", *command[3:]]


def trusted_file(path: Path, directory: bool = False) -> None:
    metadata = path.lstat()
    valid_type = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not valid_type or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise SupervisionError("untrusted_control_file")


def readonly_descriptor(path: Path) -> int:
    absolute = Path(os.path.abspath(path))
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in absolute.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(absolute.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    except OSError as error:
        raise SupervisionError("unsafe_artifact") from error
    finally:
        os.close(directory)


def read_bytes(path: Path, maximum: int = 4_000_000) -> bytes:
    descriptor = readonly_descriptor(path)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > maximum:
            raise SupervisionError("unsafe_artifact")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise SupervisionError("artifact_too_large")
        return data
    finally:
        os.close(descriptor)


def scoped(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise SupervisionError("artifact_scope")
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()):
        raise SupervisionError("artifact_scope")
    if any(part.lower() in {".env", "secrets", "credentials", "sessions", ".git"}
           for part in Path(relative).parts):
        raise SupervisionError("artifact_scope")
    if (path.name.endswith((".token", ".key")) or path.name.startswith(".env")
            or path.name in {"auth.json", "settings.local.json"}):
        raise SupervisionError("artifact_scope")
    return path


def atomic_save(path: Path, value: dict) -> None:
    trusted_file(path.parent, directory=True)
    if path.exists() or path.is_symlink():
        trusted_file(path)
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class StateLock:
    def __init__(self, path: Path):
        self.path = path
        self.fd = None

    def __enter__(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        trusted_file(self.path.parent, directory=True)
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            trusted_file(self.path)
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            os.close(self.fd)
            self.fd = None
            raise SupervisionError("already_running") from error
        except (SupervisionError, OSError):
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)


def utc_day(now: float) -> str:
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y-%m-%d")


def reserve_notice_post(state: dict, now: float, limit: int) -> bool:
    day = utc_day(now)
    attempts = state.setdefault("notice_post_attempts", {})
    count = attempts.get(day, 0)
    if type(count) is not int or count < 0:
        raise SupervisionError("invalid_notice_fuel")
    if count >= limit:
        return False
    attempts[day] = count + 1
    return True


def seed_body_type(seed: dict) -> str:
    body = seed.get("body")
    encoded = body.get("type") if isinstance(body, dict) else None
    declared = seed.get("body_type")
    if declared and encoded and declared != encoded:
        raise SupervisionError("invalid_bootstrap_type")
    expected = declared or encoded
    if expected not in {"request", "praxis.supervision.continue"}:
        raise SupervisionError("invalid_bootstrap_type")
    return expected


def causal_binding(receipt: dict, body_hash: str, body_type: str) -> dict:
    try:
        request_id = str(uuid.UUID(receipt["request_id"]))
        delivery_ids = receipt["delivery_ids"]
        trace_id = receipt["trace_id"]
        if (not isinstance(delivery_ids, list) or len(delivery_ids) != 1
                or not isinstance(trace_id, str) or not 1 <= len(trace_id) <= 256
                or any(ord(char) < 32 for char in trace_id) or not re.fullmatch(r"[a-f0-9]{64}", body_hash)):
            raise ValueError("invalid binding")
        delivery_ids = [str(uuid.UUID(identifier)) for identifier in delivery_ids]
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise SupervisionError("invalid_causal_binding") from error
    return {"request_id": request_id, "trace_id": trace_id, "delivery_ids": delivery_ids,
            "body_sha256": body_hash, "body_type": body_type}


def receipt_matches(receipt: dict, root: dict) -> bool:
    deliveries = receipt.get("deliveries")
    if not isinstance(deliveries, list) or len(deliveries) != 1:
        return False
    body = receipt.get("body")
    expected_type = root.get("body_type")
    if (expected_type not in {"request", "praxis.supervision.continue"}
            or not isinstance(body, dict) or body.get("type") != expected_type):
        return False
    if (receipt.get("request_id") != root.get("request_id") or receipt.get("trace_id") != root.get("trace_id")
            or not root.get("body_sha256") or digest(canonical(body)) != root["body_sha256"]):
        return False
    return (all(isinstance(row, dict) and row.get("tenant_id") == "Hospital" and row.get("alias") == "operador"
                for row in deliveries)
            and [row.get("delivery_id") for row in deliveries] == root.get("delivery_ids"))


def auth_resume_event(goal_hash: str, now: float) -> dict:
    if not re.fullmatch(r"[a-f0-9]{64}", goal_hash):
        raise SupervisionError("invalid_goal_digest")
    return {"schema_version": 1, "goal_sha256": goal_hash, "reason": "provider_reauthenticated",
            "nonce": str(uuid.uuid4()), "created_at": dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat().replace("+00:00", "Z")}


def consume_auth_resume(state: dict, path: Path, goal_hash: str, now: float) -> bool:
    if state.get("phase") != "circuit_paused" or state.get("pause_reason") != "unauthorized" or state.get("active_root"):
        return False
    if not path.exists() and not path.is_symlink():
        return False
    trusted_file(path.parent, directory=True)
    trusted_file(path)
    if stat.S_IMODE(path.lstat().st_mode) != 0o600:
        raise SupervisionError("untrusted_resume_mode")
    value = json.loads(read_bytes(path, 8192))
    required = {"schema_version", "goal_sha256", "reason", "nonce", "created_at"}
    try:
        if (not isinstance(value, dict) or set(value) != required or type(value["schema_version"]) is not int
                or value["schema_version"] != 1 or value["goal_sha256"] != goal_hash
                or value["reason"] != "provider_reauthenticated"):
            raise ValueError("invalid resume scope")
        nonce = uuid.UUID(value["nonce"])
        if nonce.version != 4 or str(nonce) != value["nonce"]:
            raise ValueError("invalid resume nonce")
        created = dt.datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
        if not created.tzinfo:
            raise ValueError("invalid resume timestamp")
        consumed = state.get("auth_resume_nonces", [])
        if value["nonce"] in consumed:
            return False
        if not 0 <= now - created.timestamp() <= 86400:
            raise ValueError("expired resume event")
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise SupervisionError("invalid_auth_resume") from error
    record = {"nonce": value["nonce"], "created_at": value["created_at"], "consumed_at": now,
              "pause_reason": state["pause_reason"], "backoff_until": state.get("backoff_until"),
              "failed_root": state.get("last_finished", {}).get("root")}
    state.setdefault("auth_resume_nonces", []).append(value["nonce"])
    state.setdefault("auth_recoveries", []).append(record)
    state["phase"] = "observing"
    state["auth_retry_earned"] = True
    state.pop("backoff_until", None)
    return True


def apply_auth_resume_control(state: dict, path: Path, goal_hash: str, now: float) -> bool:
    try:
        return consume_auth_resume(state, path, goal_hash, now)
    except (SupervisionError, OSError, ValueError, TypeError, AttributeError, RecursionError) as error:
        code = error.code if isinstance(error, SupervisionError) else "invalid_auth_resume"
        state["auth_resume_rejection"] = {"code": code, "observed_at": now}
        return False


def resume_measured_progress(state: dict, engineering: dict, now: float, made_progress) -> bool:
    if (state.get("phase") != "circuit_paused" or state.get("active_root")
            or state.get("pause_reason") not in {"no_measured_progress", "no_new_progress"}
            or engineering.get("goal_sha256") != state.get("goal_sha256")
            or engineering.get("verified_engineering") is not True):
        return False
    previous = state.get("progress_pause_baseline", state.get("last_finished", {}).get("engineering"))
    if not isinstance(previous, dict) or not made_progress(previous, engineering):
        return False
    recoveries = state.setdefault("progress_recoveries", [])
    recoveries.append({"at": now, "reason": state["pause_reason"], "root": state.get("last_finished", {}).get("root"),
                       "baseline_sha256": digest(canonical(previous)), "evidence_sha256": digest(canonical(engineering))})
    del recoveries[:-24]
    state["phase"] = "observing"
    state["continuation_earned"] = True
    state.pop("progress_pause_baseline", None)
    return True
