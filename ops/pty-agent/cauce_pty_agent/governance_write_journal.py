from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from typing import Any

from .framing import IDENTITY_RE, SESSION_ID_RE

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_RECORD_BYTES = 64 * 1024


class JournalError(Exception):
    """A write receipt could not be safely created, verified or finalized."""

    code = "unavailable"


class JournalConflict(JournalError):
    code = "conflict"


class JournalIdentityError(JournalError):
    code = "conflict"


@dataclass(frozen=True)
class GovernanceWriteReceipt:
    operation_id: str
    operation_generation: str
    request_id: str
    tenant_id: str
    alias: str
    container_id: str
    runtime_generation: str
    writer_instance_id: str
    token_digest: str
    entries: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class GovernanceWriteStatus:
    state: str
    operation_id: str | None = None
    operation_generation: str | None = None
    request_id: str | None = None
    tenant_id: str | None = None
    alias: str | None = None
    container_id: str | None = None
    runtime_generation: str | None = None
    writer_instance_id: str | None = None
    entries: tuple[dict[str, Any], ...] = ()


def _uuid(value: Any) -> bool:
    if not isinstance(value, str) or not SESSION_ID_RE.fullmatch(value):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _canonical_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith("/") or len(value.encode("utf-8")) > 4096:
        return False
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return False
    components = value.split("/")[1:]
    return bool(components) and all(component not in ("", ".", "..") for component in components)


def _metadata_entries(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 7:
        raise JournalIdentityError("write receipt entries are invalid")
    entries: list[dict[str, Any]] = []
    paths: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise JournalIdentityError("write receipt entry is invalid")
        mode = raw.get("mode")
        path = raw.get("path")
        operation = raw.get("operation")
        size = raw.get("bytes")
        if (not _canonical_path(path) or path in paths
                or mode not in ("write", "verify")
                or not isinstance(size, int) or isinstance(size, bool) or size < 0):
            raise JournalIdentityError("write receipt entry is invalid")
        paths.add(path)
        entry: dict[str, Any] = {"mode": mode, "path": path, "operation": operation, "bytes": size}
        if mode == "write":
            content_sha = raw.get("content_sha")
            expected_sha = raw.get("expected_sha")
            if (operation not in ("create", "replace") or not isinstance(content_sha, str)
                    or not _SHA_RE.fullmatch(content_sha)
                    or (operation == "replace" and (not isinstance(expected_sha, str)
                        or not _SHA_RE.fullmatch(expected_sha)))
                    or (operation == "create" and expected_sha is not None)):
                raise JournalIdentityError("write receipt entry is invalid")
            entry["content_sha"] = content_sha
            if expected_sha is not None:
                entry["expected_sha"] = expected_sha
        else:
            expected_sha = raw.get("expected_sha")
            if (size != 0 or operation not in ("present", "absent")
                    or (operation == "present" and (not isinstance(expected_sha, str)
                        or not _SHA_RE.fullmatch(expected_sha)))
                    or (operation == "absent" and expected_sha is not None)):
                raise JournalIdentityError("write receipt entry is invalid")
            if expected_sha is not None:
                entry["expected_sha"] = expected_sha
        entries.append(entry)
    return tuple(entries)


class GovernanceWriteJournal:
    """Private durable receipts for a single authenticated pty-agent process."""

    def __init__(self, directory: str, identity: dict[str, Any], writer_instance_id: str) -> None:
        if (not isinstance(directory, str) or not os.path.isabs(directory)
                or os.path.normpath(directory) != directory or os.path.realpath(directory) != directory
                or not _uuid(writer_instance_id)):
            raise JournalIdentityError("write journal configuration is invalid")
        required = ("tenant_id", "alias", "container_id", "generation")
        if any(not isinstance(identity.get(key), str) or not IDENTITY_RE.fullmatch(identity[key])
               for key in required):
            raise JournalIdentityError("write journal identity is invalid")
        try:
            info = os.lstat(directory)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o700):
                raise JournalIdentityError("write journal directory is not private")
            self._directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as error:
            raise JournalError("write journal directory is unavailable") from error
        self.directory = directory
        self.identity = {key: identity[key] for key in required}
        self.writer_instance_id = writer_instance_id
        self._uncertain: set[str] = set()

    def close(self) -> None:
        descriptor = getattr(self, "_directory_fd", None)
        if descriptor is not None:
            os.close(descriptor)
            self._directory_fd = None

    def validate_descriptor(self, descriptor: dict[str, Any], request_id: str) -> None:
        if (not isinstance(descriptor, dict)
                or set(descriptor) != {
                    "operation_id", "operation_token", "operation_generation", "request_id", "runtime_generation",
                }
                or not _uuid(descriptor.get("operation_id"))
                or not _uuid(descriptor.get("operation_generation"))
                or not _uuid(descriptor.get("request_id"))
                or descriptor.get("request_id") != request_id
                or descriptor.get("request_id") != descriptor.get("operation_id")
                or not _uuid(descriptor.get("operation_token"))
                or uuid.UUID(descriptor["operation_token"]).version != 4
                or descriptor.get("runtime_generation") != self.identity["generation"]):
            raise JournalIdentityError("write operation descriptor is invalid")

    def begin(
        self,
        descriptor: dict[str, Any],
        entries: list[dict[str, Any]],
    ) -> GovernanceWriteReceipt:
        request_id = descriptor.get("request_id") if isinstance(descriptor, dict) else None
        self.validate_descriptor(descriptor, request_id)
        metadata = _metadata_entries(entries)
        operation_id = descriptor["operation_id"]
        token_digest = hashlib.sha256(descriptor["operation_token"].encode("ascii")).hexdigest()
        record = {
            "version": 1,
            "state": "writing",
            "operation_id": operation_id,
            "operation_generation": descriptor["operation_generation"],
            "request_id": request_id,
            **self.identity,
            "writer_instance_id": self.writer_instance_id,
            "token_sha256": token_digest,
            "entries": list(metadata),
        }
        name = f"{operation_id}.json"
        encoded = self._encode(record)
        try:
            descriptor_fd = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=self._directory_fd,
            )
            try:
                self._write_all(descriptor_fd, encoded)
                os.fsync(descriptor_fd)
            finally:
                os.close(descriptor_fd)
            os.fsync(self._directory_fd)
        except FileExistsError as error:
            raise JournalConflict("write operation already exists") from error
        except OSError as error:
            self._uncertain.add(operation_id)
            raise JournalError("write journal could not persist the writing state") from error
        return GovernanceWriteReceipt(
            operation_id=operation_id,
            operation_generation=descriptor["operation_generation"],
            request_id=request_id,
            tenant_id=self.identity["tenant_id"],
            alias=self.identity["alias"],
            container_id=self.identity["container_id"],
            runtime_generation=self.identity["generation"],
            writer_instance_id=self.writer_instance_id,
            token_digest=token_digest,
            entries=metadata,
        )

    def complete(self, receipt: GovernanceWriteReceipt, result: list[dict[str, Any]]) -> None:
        try:
            record = self._read_record(receipt.operation_id)
        except OSError as error:
            self._uncertain.add(receipt.operation_id)
            raise JournalError("write journal record is unavailable") from error
        self._validate_receipt(record, receipt)
        if record["state"] != "writing":
            raise JournalConflict("write operation is already terminal")
        normalized = self._validate_result(receipt.entries, result)
        record["state"] = "done"
        record["result"] = normalized
        self._replace_record(receipt.operation_id, record)

    def status(self, descriptor: dict[str, Any]) -> GovernanceWriteStatus:
        operation_id = descriptor.get("operation_id") if isinstance(descriptor, dict) else None
        if not _uuid(operation_id):
            return GovernanceWriteStatus("unknown")
        try:
            self.validate_descriptor(descriptor, descriptor.get("request_id"))
            record = self._read_record(operation_id)
            self._validate_descriptor_record(record, descriptor)
            entries = _metadata_entries(record.get("entries"))
            if record["state"] == "done":
                self._validate_result(entries, record.get("result"))
        except (JournalError, OSError, ValueError, TypeError, KeyError):
            return GovernanceWriteStatus("unknown")
        if operation_id in self._uncertain or record["writer_instance_id"] != self.writer_instance_id:
            return GovernanceWriteStatus("unknown")
        return GovernanceWriteStatus(
            record["state"], operation_id=operation_id, request_id=record["request_id"],
            operation_generation=record["operation_generation"],
            tenant_id=record["tenant_id"], alias=record["alias"],
            container_id=record["container_id"], runtime_generation=record["generation"],
            writer_instance_id=record["writer_instance_id"],
            entries=tuple(record.get("result", entries)),
        )

    def _validate_receipt(self, record: dict[str, Any], receipt: GovernanceWriteReceipt) -> None:
        if (record.get("operation_id") != receipt.operation_id
                or record.get("operation_generation") != receipt.operation_generation
                or record.get("request_id") != receipt.request_id
                or record.get("writer_instance_id") != self.writer_instance_id
                or not isinstance(record.get("token_sha256"), str)
                or not hmac.compare_digest(record["token_sha256"], receipt.token_digest)
                or tuple(record.get("entries", ())) != receipt.entries
                or any(record.get(key) != self.identity[key]
                       for key in ("tenant_id", "alias", "container_id", "generation"))):
            raise JournalIdentityError("write receipt no longer belongs to this writer")

    def _validate_descriptor_record(self, record: dict[str, Any], descriptor: dict[str, Any]) -> None:
        token_digest = hashlib.sha256(descriptor["operation_token"].encode("ascii")).hexdigest()
        if (record.get("operation_id") != descriptor["operation_id"]
                or record.get("operation_generation") != descriptor["operation_generation"]
                or record.get("request_id") != descriptor["request_id"]
                or record.get("generation") != descriptor["runtime_generation"]
                or not isinstance(record.get("token_sha256"), str)
                or not hmac.compare_digest(record["token_sha256"], token_digest)
                or any(record.get(key) != self.identity[key]
                       for key in ("tenant_id", "alias", "container_id", "generation"))
                or record.get("state") not in ("writing", "done")):
            raise JournalIdentityError("write operation status is unknown")

    def _validate_result(
        self,
        entries: tuple[dict[str, Any], ...],
        result: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not isinstance(result, list) or len(result) != len(entries):
            raise JournalIdentityError("write result does not match the operation")
        by_path: dict[str, dict[str, Any]] = {}
        for raw in result:
            if not isinstance(raw, dict) or set(raw) != {"path", "operation", "sha", "bytes"}:
                raise JournalIdentityError("write result is invalid")
            if not _canonical_path(raw.get("path")) or raw["path"] in by_path:
                raise JournalIdentityError("write result is invalid")
            by_path[raw["path"]] = raw
        normalized: list[dict[str, Any]] = []
        for entry in entries:
            answer = by_path.get(entry["path"])
            if answer is None or not isinstance(answer.get("bytes"), int) or isinstance(answer.get("bytes"), bool):
                raise JournalIdentityError("write result does not match the operation")
            if entry["mode"] == "write":
                valid = (answer["operation"] in (entry["operation"], "unchanged")
                         and answer["sha"] == entry["content_sha"]
                         and answer["bytes"] == entry["bytes"])
            elif entry["operation"] == "present":
                valid = (answer["operation"] == "unchanged" and answer["sha"] == entry["expected_sha"]
                         and answer["bytes"] >= 0)
            else:
                valid = (answer["operation"] == "absent" and answer["sha"] is None and answer["bytes"] == 0)
            if not valid:
                raise JournalIdentityError("write result does not match the operation")
            normalized.append({key: answer[key] for key in ("path", "operation", "sha", "bytes")})
        return normalized

    def _read_record(self, operation_id: str) -> dict[str, Any]:
        descriptor = os.open(f"{operation_id}.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self._directory_fd)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_RECORD_BYTES):
                raise JournalIdentityError("write journal record is unsafe")
            chunks: list[bytes] = []
            remaining = _MAX_RECORD_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(remaining, 8192))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw = b"".join(chunks)
            if len(raw) > _MAX_RECORD_BYTES:
                raise JournalIdentityError("write journal record is oversized")
        finally:
            os.close(descriptor)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise JournalIdentityError("write journal record is malformed") from error
        if not isinstance(value, dict) or value.get("version") != 1:
            raise JournalIdentityError("write journal record is malformed")
        return value

    def _replace_record(self, operation_id: str, record: dict[str, Any]) -> None:
        temporary = f".{operation_id}.{uuid.uuid4()}.tmp"
        descriptor = -1
        try:
            descriptor = os.open(
                temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=self._directory_fd,
            )
            self._write_all(descriptor, self._encode(record))
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, f"{operation_id}.json",
                       src_dir_fd=self._directory_fd, dst_dir_fd=self._directory_fd)
            os.fsync(self._directory_fd)
        except OSError as error:
            self._uncertain.add(operation_id)
            raise JournalError("write journal could not persist the terminal state") from error
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=self._directory_fd)
            except FileNotFoundError:
                pass
            except OSError:
                self._uncertain.add(operation_id)

    @staticmethod
    def _encode(record: dict[str, Any]) -> bytes:
        try:
            encoded = json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise JournalIdentityError("write journal record is invalid") from error
        if len(encoded) > _MAX_RECORD_BYTES:
            raise JournalIdentityError("write journal record is too large")
        return encoded

    @staticmethod
    def _write_all(descriptor: int, data: bytes) -> None:
        view = memoryview(data)
        offset = 0
        while offset < len(view):
            written = os.write(descriptor, view[offset:])
            if written <= 0:
                raise OSError("short write to governance journal")
            offset += written
