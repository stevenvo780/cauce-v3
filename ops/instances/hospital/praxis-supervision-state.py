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


def trusted_file(path: Path, directory: bool = False) -> None:
    metadata = path.lstat()
    valid_type = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not valid_type or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise SupervisionError("untrusted_control_file")


def read_bytes(path: Path, maximum: int = 4_000_000) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise SupervisionError("unsafe_artifact")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise SupervisionError("artifact_too_large")
    return data


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


def causal_binding(receipt: dict, body_hash: str) -> dict:
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
            "body_sha256": body_hash}


def receipt_matches(receipt: dict, root: dict) -> bool:
    deliveries = receipt.get("deliveries")
    if not isinstance(deliveries, list) or len(deliveries) != 1:
        return False
    body = receipt.get("body")
    if not isinstance(body, dict) or body.get("type") != "praxis.supervision.continue":
        return False
    if (receipt.get("request_id") != root.get("request_id") or receipt.get("trace_id") != root.get("trace_id")
            or not root.get("body_sha256") or digest(canonical(body)) != root["body_sha256"]):
        return False
    return (all(isinstance(row, dict) and row.get("tenant_id") == "Hospital" and row.get("alias") == "operador"
                for row in deliveries)
            and [row.get("delivery_id") for row in deliveries] == root.get("delivery_ids"))
