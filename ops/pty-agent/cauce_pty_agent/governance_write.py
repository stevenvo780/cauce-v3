from __future__ import annotations

import hashlib
import os
import stat
from typing import Any

from .framing import (
    MAX_DATA,
    SESSION_ID_RE,
    TAG_WRITE_BATCH_ERR,
    TAG_WRITE_BATCH_OK,
    TAG_WRITE_ERR,
    TAG_WRITE_OK,
    ProtocolError,
    encode_json,
)
from .governance_paths import (
    MAX_DOCUMENT_BYTES,
    MAX_READ_PATH,
    MAX_WRITE_BATCH_BYTES,
    MAX_WRITE_BATCH_FILES,
    MAX_WRITE_TRANSACTIONS,
    NEVER_SERVE_BASENAMES,
    NEVER_SERVE_SUFFIXES,
    SHA256_RE,
)

MOUNTINFO_PATH = "/proc/self/mountinfo"
_OCTAL_DIGITS = frozenset("01234567")


class GovernanceBindMountError(Exception):
    """The destination is a bind-mounted file and the caller cannot commit it with a rename."""


def _read_mountinfo() -> str | None:
    try:
        with open(MOUNTINFO_PATH, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def _unescape_mountinfo(field: str) -> str:
    """mountinfo escapes space, tab, newline and backslash as a backslash and three octal digits."""
    if "\\" not in field:
        return field
    out: list[str] = []
    index = 0
    while index < len(field):
        digits = field[index + 1:index + 4]
        if field[index] == "\\" and len(digits) == 3 and _OCTAL_DIGITS.issuperset(digits):
            out.append(chr(int(digits, 8)))
            index += 4
            continue
        out.append(field[index])
        index += 1
    return "".join(out)


def _mountinfo_lists_path(path: str) -> bool:
    """Exact match against the mount point field; unreadable mountinfo answers False, not a guess."""
    raw = _read_mountinfo()
    if raw is None:
        return False
    for line in raw.splitlines():
        fields = line.split(" ")
        if len(fields) > 4 and _unescape_mountinfo(fields[4]) == path:
            return True
    return False


def _read_at(fd: int, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = os.pread(fd, size - len(data), len(data))
        if not chunk:
            break
        data.extend(chunk)
    return bytes(data)


def _write_at(fd: int, data: bytes) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        amount = os.pwrite(fd, view[written:], written)
        if amount <= 0:
            raise OSError("short in-place governance write")
        written += amount


class GovernanceWrite:
    """Una escritura correlacionada y acotada que todavía no llegó completa."""

    def __init__(
        self,
        request_id: str,
        path: str,
        operation: str,
        expected_sha: str | None,
        content_sha: str,
        content_bytes: int,
        chunks: int,
    ) -> None:
        self.request_id = request_id
        self.path = path
        self.operation = operation
        self.expected_sha = expected_sha
        self.content_sha = content_sha
        self.content_bytes = content_bytes
        self.chunks = chunks
        self.received_chunks = 0
        self.content = bytearray()


class GovernanceBatchEntry:
    def __init__(
        self,
        path: str,
        mode: str,
        operation: str,
        expected_sha: str | None,
        content_sha: str | None,
        content_bytes: int,
        chunks: int,
    ) -> None:
        self.path = path
        self.mode = mode
        self.operation = operation
        self.expected_sha = expected_sha
        self.content_sha = content_sha
        self.content_bytes = content_bytes
        self.chunks = chunks
        self.received_chunks = 0
        self.content = bytearray()


class GovernanceWriteBatch:
    def __init__(self, request_id: str, entries: list[GovernanceBatchEntry]) -> None:
        self.request_id = request_id
        self.entries = entries

    def receiving_entry(self) -> GovernanceBatchEntry | None:
        return next((entry for entry in self.entries if entry.received_chunks < entry.chunks), None)

    def complete(self) -> bool:
        return all(entry.received_chunks == entry.chunks for entry in self.entries)


class GovernanceWriteMixin:

    def _on_write(self, request: dict[str, Any]) -> None:
        """Empieza una escritura sin abrir procesos ni interpretar el contenido.

        La capacidad se negocia en el hello. Aun así, todo el pedido vuelve a validarse aquí: un
        relay comprometido no puede nombrar otra ruta, omitir la precondición ni mandar un cuerpo
        por encima del tope. El contenido llega en WRITE_DATA y sólo se toca el disco cuando llegó
        completo y su SHA coincide.
        """
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE carries an invalid request id")
        if request_id in self.pending_writes:
            self.pending_writes.pop(request_id, None)
            self._write_error(request_id, "conflict", "duplicate write request id")
            return
        if len(self.pending_writes) >= MAX_WRITE_TRANSACTIONS:
            self._write_error(request_id, "unavailable", "too many governance writes in flight")
            return

        path = request.get("path")
        operation = request.get("operation")
        expected_sha = request.get("expected_sha")
        content_sha = request.get("content_sha")
        content_bytes = request.get("bytes")
        chunks = request.get("chunks")
        verdict = self._validate_write_shape(path)
        if verdict is not None:
            self._write_error(request_id, verdict[0], verdict[1])
            return
        if operation not in ("replace", "create"):
            self._write_error(request_id, "invalid_path", "operation must be replace or create")
            return
        if operation == "replace":
            if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
                self._write_error(request_id, "invalid_path", "replace requires a lowercase SHA-256 precondition")
                return
        elif expected_sha is not None:
            self._write_error(request_id, "invalid_path", "create must use the absent precondition")
            return
        if not isinstance(content_sha, str) or not SHA256_RE.fullmatch(content_sha):
            self._write_error(request_id, "invalid_path", "content_sha must be a lowercase SHA-256")
            return
        if (not isinstance(content_bytes, int) or isinstance(content_bytes, bool)
                or content_bytes < 0 or content_bytes > MAX_DOCUMENT_BYTES):
            self._write_error(request_id, "too_large", "content size is outside the governance limit")
            return
        max_chunks = (MAX_DOCUMENT_BYTES + MAX_DATA - 1) // MAX_DATA
        if (not isinstance(chunks, int) or isinstance(chunks, bool)
                or chunks < 0 or chunks > max_chunks
                or (content_bytes == 0) != (chunks == 0)):
            self._write_error(request_id, "invalid_path", "chunk count does not match the content size")
            return

        pending = GovernanceWrite(
            request_id, path, operation, expected_sha, content_sha, content_bytes, chunks,
        )
        self.pending_writes[request_id] = pending
        if chunks == 0:
            self._finish_write(pending)

    def _on_write_data(self, request_id: str, data: bytes) -> None:
        pending = self.pending_writes.get(request_id)
        # May arrive late after WRITE_CANCEL/timeout. Stale, not a violation that could drop the
        # connection and with it the PTYs that share the socket.
        if pending is None:
            return
        pending.received_chunks += 1
        if pending.received_chunks > pending.chunks or len(pending.content) + len(data) > pending.content_bytes:
            self.pending_writes.pop(request_id, None)
            self._write_error(request_id, "too_large", "write data exceeds the announced content")
            return
        pending.content.extend(data)
        if pending.received_chunks == pending.chunks:
            self._finish_write(pending)

    def _on_write_cancel(self, request: dict[str, Any]) -> None:
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE_CANCEL carries an invalid request id")
        self.pending_writes.pop(request_id, None)

    def _on_write_batch(self, request: dict[str, Any]) -> None:
        """Recibe el manifiesto completo antes de aceptar un solo byte o tocar el disco."""
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE_BATCH carries an invalid request id")
        if request_id in self.pending_write_batches or request_id in self.pending_writes:
            self.pending_write_batches.pop(request_id, None)
            self._write_batch_error(request_id, "conflict", "duplicate write batch request id")
            return
        if len(self.pending_writes) + len(self.pending_write_batches) >= MAX_WRITE_TRANSACTIONS:
            self._write_batch_error(request_id, "unavailable", "too many governance writes in flight")
            return
        raw_entries = request.get("entries")
        if (not isinstance(raw_entries, list) or not raw_entries
                or len(raw_entries) > MAX_WRITE_BATCH_FILES):
            self._write_batch_error(request_id, "too_large", "batch must contain one to seven files")
            return

        entries: list[GovernanceBatchEntry] = []
        seen: set[str] = set()
        total_bytes = 0
        total_chunks = 0
        max_chunks = (MAX_WRITE_BATCH_BYTES + MAX_DATA - 1) // MAX_DATA
        # Each document can end with a partial frame independently of the batch byte budget.
        max_batch_chunks = max_chunks + len(raw_entries) - 1
        for raw in raw_entries:
            if not isinstance(raw, dict):
                self._write_batch_error(request_id, "invalid_path", "batch entry must be an object")
                return
            path = raw.get("path")
            mode = raw.get("mode")
            operation = raw.get("operation")
            expected_sha = raw.get("expected_sha")
            content_sha = raw.get("content_sha")
            content_bytes = raw.get("bytes")
            chunks = raw.get("chunks")
            verdict = self._validate_write_shape(path)
            if verdict is not None:
                self._write_batch_error(request_id, verdict[0], verdict[1])
                return
            if path in seen:
                self._write_batch_error(request_id, "conflict", "batch contains duplicate paths")
                return
            seen.add(path)
            if (not isinstance(content_bytes, int) or isinstance(content_bytes, bool)
                    or not isinstance(chunks, int) or isinstance(chunks, bool)
                    or content_bytes < 0 or chunks < 0):
                self._write_batch_error(request_id, "invalid_path", "batch sizes must be non-negative integers")
                return

            if mode == "write":
                if operation not in ("replace", "create"):
                    self._write_batch_error(request_id, "invalid_path", "write operation must be replace or create")
                    return
                if operation == "replace":
                    if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
                        self._write_batch_error(request_id, "invalid_path", "replace requires a SHA-256 precondition")
                        return
                elif expected_sha is not None:
                    self._write_batch_error(request_id, "invalid_path", "create must use the absent precondition")
                    return
                if not isinstance(content_sha, str) or not SHA256_RE.fullmatch(content_sha):
                    self._write_batch_error(request_id, "invalid_path", "write content_sha must be a SHA-256")
                    return
                if (content_bytes > MAX_DOCUMENT_BYTES or chunks > max_chunks
                        or (content_bytes == 0) != (chunks == 0)):
                    self._write_batch_error(request_id, "too_large", "batch entry exceeds the governance limit")
                    return
            elif mode == "verify":
                if operation == "present":
                    if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
                        self._write_batch_error(request_id, "invalid_path", "verify present requires a SHA-256")
                        return
                elif operation == "absent":
                    if expected_sha is not None:
                        self._write_batch_error(request_id, "invalid_path", "verify absent cannot carry a SHA-256")
                        return
                else:
                    self._write_batch_error(request_id, "invalid_path", "verify operation must be present or absent")
                    return
                if content_sha is not None or content_bytes != 0 or chunks != 0:
                    self._write_batch_error(request_id, "invalid_path", "verify entries cannot carry content")
                    return
            else:
                self._write_batch_error(request_id, "invalid_path", "batch mode must be write or verify")
                return

            total_bytes += content_bytes
            total_chunks += chunks
            if total_bytes > MAX_WRITE_BATCH_BYTES or total_chunks > max_batch_chunks:
                self._write_batch_error(request_id, "too_large", "batch exceeds the total governance limit")
                return
            entries.append(GovernanceBatchEntry(
                path, mode, operation, expected_sha, content_sha, content_bytes, chunks,
            ))

        pending = GovernanceWriteBatch(request_id, entries)
        self.pending_write_batches[request_id] = pending
        if pending.complete():
            self._finish_write_batch(pending)

    def _on_write_batch_data(self, request_id: str, data: bytes) -> None:
        pending = self.pending_write_batches.get(request_id)
        if pending is None:
            return
        entry = pending.receiving_entry()
        if entry is None:
            self.pending_write_batches.pop(request_id, None)
            self._write_batch_error(request_id, "conflict", "batch received unannounced data")
            return
        entry.received_chunks += 1
        if entry.received_chunks > entry.chunks or len(entry.content) + len(data) > entry.content_bytes:
            self.pending_write_batches.pop(request_id, None)
            self._write_batch_error(request_id, "too_large", "batch data exceeds its announced entry")
            return
        entry.content.extend(data)
        if pending.complete():
            self._finish_write_batch(pending)

    def _on_write_batch_cancel(self, request: dict[str, Any]) -> None:
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE_BATCH_CANCEL carries an invalid request id")
        self.pending_write_batches.pop(request_id, None)

    def _finish_write_batch(self, pending: GovernanceWriteBatch) -> None:
        self.pending_write_batches.pop(pending.request_id, None)
        for entry in pending.entries:
            if entry.mode != "write":
                continue
            content = bytes(entry.content)
            if (len(content) != entry.content_bytes
                    or hashlib.sha256(content).hexdigest() != entry.content_sha):
                self._write_batch_error(
                    pending.request_id, "conflict", "batch content does not match its announced digest",
                )
                return
            try:
                content.decode("utf-8", "strict")
            except UnicodeDecodeError:
                self._write_batch_error(
                    pending.request_id, "invalid_path", "governance content must be UTF-8 text",
                )
                return
        try:
            acknowledgements = self._apply_governance_batch(pending)
        except GovernanceBindMountError as error:
            self._write_batch_error(pending.request_id, "bind_mount_target", str(error))
        except FileExistsError:
            self._write_batch_error(pending.request_id, "conflict", "an absent precondition failed")
        except FileNotFoundError:
            self._write_batch_error(pending.request_id, "not_found", "a required file is absent")
        except PermissionError:
            self._write_batch_error(pending.request_id, "permission_denied", "permission denied")
        except ValueError as error:
            self._write_batch_error(pending.request_id, "conflict", str(error))
        except OSError as error:
            self._write_batch_error(
                pending.request_id, "unknown", f"batch write failed: {type(error).__name__}",
            )
        else:
            self._queue(encode_json(TAG_WRITE_BATCH_OK, {
                "request_id": pending.request_id, "files": acknowledgements,
            }))

    def _apply_governance_batch(self, pending: GovernanceWriteBatch) -> list[dict[str, Any]]:
        """Preflight, stage, revalidate and commit; any failed commit rolls the prefix back."""
        plans: list[dict[str, Any]] = []
        try:
            # COMPLETE PRE-FLIGHT. Nothing is created, truncated, renamed, or touched before this loop ends.
            for index, entry in enumerate(pending.entries):
                directory, basename = self._open_governance_parent(entry.path)
                plan: dict[str, Any] = {
                    "entry": entry, "directory": directory, "basename": basename,
                    "index": index, "temporary": None, "backup": None, "committed": False,
                }
                plans.append(plan)
                try:
                    current_sha, current_info = self._hash_regular_at(directory, basename)
                    exists = True
                except FileNotFoundError:
                    current_sha, current_info, exists = None, None, False
                plan.update({"current_sha": current_sha, "current_info": current_info, "exists": exists})

                if entry.mode == "verify":
                    if entry.operation == "present":
                        if not exists:
                            raise FileNotFoundError(basename)
                        if current_sha != entry.expected_sha:
                            raise ValueError(f"{basename} changed; SHA-256 precondition failed")
                        plan["ack_operation"] = "unchanged"
                    else:
                        if exists:
                            raise FileExistsError(basename)
                        plan["ack_operation"] = "absent"
                    continue

                if exists and current_sha == entry.content_sha:
                    plan["ack_operation"] = "unchanged"
                    continue
                if entry.operation == "create":
                    if exists:
                        raise FileExistsError(basename)
                else:
                    if not exists:
                        raise FileNotFoundError(basename)
                    if current_sha != entry.expected_sha:
                        raise ValueError(f"{basename} changed; SHA-256 precondition failed")
                    if self._target_is_mount_point(directory, entry.path, current_info):
                        # The rollback of this transaction is a hardlink to the ORIGINAL inode
                        # restored with os.replace: over a mounted destination there is no inode
                        # to link and no name to put back. Refusing keeps the mount whole.
                        raise GovernanceBindMountError(
                            f"{basename} is a bind-mounted file; a transactional profile cannot commit it",
                        )
                plan["ack_operation"] = entry.operation

            # COMPLETE STAGING. Temporaries are not served names and do not change destinations.
            for plan in plans:
                entry = plan["entry"]
                if entry.mode != "write" or plan["ack_operation"] == "unchanged":
                    continue
                directory = plan["directory"]
                temporary = f".cauce-profile-{pending.request_id}-{plan['index']}.tmp"
                temp_fd = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600, dir_fd=directory,
                )
                plan["temporary"] = temporary
                try:
                    content = memoryview(bytes(entry.content))
                    written = 0
                    while written < len(content):
                        amount = os.write(temp_fd, content[written:])
                        if amount <= 0:
                            raise OSError("short governance batch write")
                        written += amount
                    current_info = plan["current_info"]
                    if current_info is not None:
                        os.fchmod(temp_fd, stat.S_IMODE(current_info.st_mode))
                        if current_info.st_uid != os.geteuid() or current_info.st_gid != os.getegid():
                            os.fchown(temp_fd, current_info.st_uid, current_info.st_gid)
                    os.fsync(temp_fd)
                    staged = os.fstat(temp_fd)
                    plan["staged_inode"] = (staged.st_dev, staged.st_ino)
                finally:
                    os.close(temp_fd)

            # GLOBAL REVALIDATION. Verifies and no-ops are also re-measured right before.
            for plan in plans:
                entry = plan["entry"]
                directory = plan["directory"]
                basename = plan["basename"]
                try:
                    latest_sha, latest_info = self._hash_regular_at(directory, basename)
                    latest_exists = True
                except FileNotFoundError:
                    latest_sha, latest_info, latest_exists = None, None, False
                if plan["exists"] != latest_exists:
                    raise ValueError(f"{basename} changed after preflight")
                if latest_exists and self._stat_identity(latest_info) != self._stat_identity(plan["current_info"]):
                    raise ValueError(f"{basename} changed after preflight")
                if latest_sha != plan["current_sha"]:
                    raise ValueError(f"{basename} changed after preflight")
                if entry.mode == "write" and plan["ack_operation"] == "replace":
                    backup = f".cauce-profile-{pending.request_id}-{plan['index']}.bak"
                    os.link(basename, backup, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                    plan["backup"] = backup
                    # Creating the rollback hardlink changes the inode's ctime/nlink even though
                    # nobody edited its bytes. That post-link identity is the one that must reach commit.
                    plan["commit_identity"] = self._stat_identity(
                        os.stat(basename, dir_fd=directory, follow_symlinks=False),
                    )
                elif latest_info is not None:
                    plan["commit_identity"] = self._stat_identity(latest_info)

            # COMMIT. Each step is atomic; if one fails, the prefix is reverted in reverse order.
            try:
                for plan in plans:
                    entry = plan["entry"]
                    operation = plan["ack_operation"]
                    if entry.mode != "write" or operation == "unchanged":
                        continue
                    directory = plan["directory"]
                    basename = plan["basename"]
                    temporary = plan["temporary"]
                    if operation == "create":
                        os.link(
                            temporary, basename,
                            src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False,
                        )
                        os.unlink(temporary, dir_fd=directory)
                        plan["temporary"] = None
                    else:
                        latest = os.stat(basename, dir_fd=directory, follow_symlinks=False)
                        if self._stat_identity(latest) != plan["commit_identity"]:
                            raise ValueError(f"{basename} changed before commit")
                        os.replace(temporary, basename, src_dir_fd=directory, dst_dir_fd=directory)
                        plan["temporary"] = None
                    plan["committed"] = True
                    os.fsync(directory)
            except BaseException:
                rollback_failed = False
                for plan in reversed(plans):
                    if not plan["committed"]:
                        continue
                    directory = plan["directory"]
                    basename = plan["basename"]
                    try:
                        current_sha, current = self._hash_regular_at(directory, basename)
                        entry = plan["entry"]
                        if ((current.st_dev, current.st_ino) != plan["staged_inode"]
                                or current_sha != entry.content_sha):
                            rollback_failed = True
                            continue
                        if plan["ack_operation"] == "create":
                            os.unlink(basename, dir_fd=directory)
                        else:
                            os.replace(
                                plan["backup"], basename,
                                src_dir_fd=directory, dst_dir_fd=directory,
                            )
                            plan["backup"] = None
                        os.fsync(directory)
                    except OSError:
                        rollback_failed = True
                if rollback_failed:
                    raise OSError("governance batch rollback could not restore every file") from None
                raise

            acknowledgements: list[dict[str, Any]] = []
            for plan in plans:
                entry = plan["entry"]
                if plan["ack_operation"] == "absent":
                    digest, size = None, 0
                elif entry.mode == "write":
                    digest, size = entry.content_sha, entry.content_bytes
                else:
                    digest, size = entry.expected_sha, plan["current_info"].st_size
                acknowledgements.append({
                    "path": entry.path,
                    "operation": plan["ack_operation"],
                    "sha": digest,
                    "bytes": size,
                })
            return acknowledgements
        finally:
            for plan in plans:
                directory = plan["directory"]
                for key in ("temporary", "backup"):
                    name = plan.get(key)
                    if name is not None:
                        try:
                            os.unlink(name, dir_fd=directory)
                        except OSError:
                            pass
                os.close(directory)

    def _write_batch_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_WRITE_BATCH_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))

    def _finish_write(self, pending: GovernanceWrite) -> None:
        self.pending_writes.pop(pending.request_id, None)
        content = bytes(pending.content)
        if len(content) != pending.content_bytes or hashlib.sha256(content).hexdigest() != pending.content_sha:
            self._write_error(pending.request_id, "conflict", "content does not match its announced digest")
            return
        try:
            content.decode("utf-8", "strict")
        except UnicodeDecodeError:
            self._write_error(pending.request_id, "invalid_path", "governance content must be UTF-8 text")
            return
        try:
            self._apply_governance_write(pending, content)
        except FileExistsError:
            self._write_error(pending.request_id, "conflict", "the file exists; create precondition failed")
        except FileNotFoundError:
            self._write_error(pending.request_id, "not_found", "the file vanished before replacement")
        except PermissionError:
            self._write_error(pending.request_id, "permission_denied", "permission denied")
        except ValueError as error:
            self._write_error(pending.request_id, "conflict", str(error))
        except OSError as error:
            self._write_error(pending.request_id, "unknown", f"write failed: {type(error).__name__}")

    def _validate_write_shape(self, path: Any) -> tuple[str, str] | None:
        if not isinstance(path, str) or not path:
            return ("invalid_path", "path is required")
        if len(path) > MAX_READ_PATH or "\0" in path or not path.startswith("/"):
            return ("invalid_path", "path is not a bounded absolute path")
        segments = path.split("/")
        if ".." in segments or "." in segments or "" in segments[1:]:
            return ("invalid_path", "path is not canonical")
        base = segments[-1]
        normalized_base = base.casefold()
        if normalized_base in NEVER_SERVE_BASENAMES:
            return ("permission_denied", f"{base} is never served")
        if normalized_base.endswith(NEVER_SERVE_SUFFIXES):
            return ("permission_denied", "looks like credential material")
        if not self._is_writable_governance_file_path(path):
            return ("permission_denied", f"{base} is not a governance document")
        home = str(self.bundle["home"]).rstrip("/")
        if not home.startswith("/") or not path.startswith(home + "/"):
            return ("permission_denied", "path is outside the agent home")
        return None

    def _apply_governance_write(self, pending: GovernanceWrite, content: bytes) -> None:
        """Commits with the mechanism the destination needs, decided once before anything is staged.

        `create` commits with link(2), which fails with EEXIST and never overwrites a creation
        that won the race. A mounted destination must keep its inode, so it is written in place
        and no temporary is staged: its parent directory may not be writable.
        """
        directory, basename = self._open_governance_parent(pending.path)
        temporary = f".cauce-governance-{pending.request_id}.tmp"
        temp_fd: int | None = None
        temp_exists = False
        try:
            try:
                current_sha, current_info = self._hash_regular_at(directory, basename)
                exists = True
            except FileNotFoundError:
                current_sha, current_info, exists = None, None, False

            # Lost ACK: repeating the same operation must not turn a real success into a conflict.
            if exists and current_sha == pending.content_sha:
                self._write_ok(pending)
                return
            if pending.operation == "create" and exists:
                raise FileExistsError(basename)
            if pending.operation == "replace":
                if not exists:
                    raise FileNotFoundError(basename)
                if current_sha != pending.expected_sha:
                    raise ValueError("the file changed; SHA-256 precondition failed")

            in_place = exists and self._target_is_mount_point(directory, pending.path, current_info)
            if not in_place:
                temp_fd = os.open(
                    temporary,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=directory,
                )
                temp_exists = True
                view = memoryview(content)
                written = 0
                while written < len(view):
                    amount = os.write(temp_fd, view[written:])
                    if amount <= 0:
                        raise OSError("short governance write")
                    written += amount
                if current_info is not None:
                    os.fchmod(temp_fd, stat.S_IMODE(current_info.st_mode))
                    if current_info.st_uid != os.geteuid() or current_info.st_gid != os.getegid():
                        os.fchown(temp_fd, current_info.st_uid, current_info.st_gid)
                os.fsync(temp_fd)
                os.close(temp_fd)
                temp_fd = None

            if pending.operation == "create":
                # linkat fails with EEXIST: unlike replace(), it never overwrites a creation that
                # won the race between the check and the commit.
                os.link(
                    temporary, basename,
                    src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False,
                )
                os.unlink(temporary, dir_fd=directory)
                temp_exists = False
            else:
                # Revalidate the SAME identity right before commit. Serialises this agent's writes
                # and catches external edits that happened during staging.
                latest = os.stat(basename, dir_fd=directory, follow_symlinks=False)
                if (self._stat_identity(latest) != self._stat_identity(current_info)
                        or not stat.S_ISREG(latest.st_mode)):
                    raise ValueError("the file changed before the atomic commit")
                if in_place:
                    self._commit_in_place(directory, basename, latest, content)
                else:
                    os.replace(temporary, basename, src_dir_fd=directory, dst_dir_fd=directory)
                    temp_exists = False
            os.fsync(directory)
            self._write_ok(pending)
        finally:
            if temp_fd is not None:
                os.close(temp_fd)
            if temp_exists:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except OSError:
                    pass
            os.close(directory)

    @staticmethod
    def _target_is_mount_point(directory: int, path: str, info: os.stat_result) -> bool:
        """True when the destination is mounted, by either of two independent signals.

        mountinfo answers exactly, including the `mount --bind` of a file onto the SAME
        filesystem, which st_dev cannot see. The st_dev comparison is the only signal left
        when /proc is not mounted, so neither replaces the other.
        """
        if _mountinfo_lists_path(path):
            return True
        return info.st_dev != os.fstat(directory).st_dev

    @staticmethod
    def _commit_in_place(directory: int, basename: str, expected: os.stat_result, content: bytes) -> None:
        """Overwrites a mounted destination through its own descriptor, keeping its inode.

        The document is never observed empty and its old bytes are never lost: the previous
        content is read first, the new content is written at offset 0, and the truncation is
        last; a failure after the first write restores the previous bytes through the same
        descriptor. The identity is re-checked on the descriptor already opened O_RDWR, so a
        swap between the stat and the open cannot redirect these bytes.
        """
        fd = os.open(basename, os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory)
        try:
            opened = os.fstat(fd)
            if ((opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
                    or not stat.S_ISREG(opened.st_mode)):
                raise ValueError("the file changed before the in-place commit")
            if opened.st_size > MAX_DOCUMENT_BYTES:
                raise ValueError("the destination exceeds the governance document cap")
            previous = _read_at(fd, opened.st_size)
            try:
                _write_at(fd, content)
                os.fsync(fd)
                os.ftruncate(fd, len(content))
            except BaseException:
                _write_at(fd, previous)
                os.ftruncate(fd, len(previous))
                os.fsync(fd)
                raise
        finally:
            os.close(fd)

    def _write_ok(self, pending: GovernanceWrite) -> None:
        self._queue(encode_json(TAG_WRITE_OK, {
            "request_id": pending.request_id,
            "path": pending.path,
            "operation": pending.operation,
            "sha": pending.content_sha,
            "bytes": pending.content_bytes,
        }))

    def _write_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_WRITE_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))
