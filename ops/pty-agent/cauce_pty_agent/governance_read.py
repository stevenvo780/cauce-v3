from __future__ import annotations

import hashlib
import os
import stat
import time
from typing import Any

from .framing import (
    MAX_DATA,
    SESSION_ID_RE,
    TAG_READ_DATA,
    TAG_READ_DONE,
    TAG_READ_ERR,
    TAG_READ_OK,
    ProtocolError,
    encode_data,
    encode_json,
)
from .governance_paths import (
    DIR_SCAN_CAP,
    MAX_DIR_DEPTH,
    MAX_DIR_ENTRIES,
    MAX_DOCUMENT_BYTES,
    MAX_READ_PATH,
    NEVER_SERVE_BASENAMES,
    NEVER_SERVE_SUFFIXES,
    READ_INDEX_BUDGET,
    READ_KINDS,
    ReadPathTypeError,
    ReadSymlinkError,
)
from .session import OUTBOUND_HIGH_WATER


class GovernanceReadMixin:
    # -- lectura de ficheros de gobierno -------------------------------------------------------

    def _on_read(self, request: dict[str, Any]) -> None:
        """TAG_READ: entrega un manual del sitio, o el indice de memoria. Falla CERRADO.

        Nada de lo que llega por aqui abre un proceso ni pasa por un shell: se valida una ruta y se
        lee. Un rechazo se contesta con TAG_READ_ERR y la conexion sigue viva; solo un
        `request_id` mal formado es violacion de protocolo, porque sin el no hay a quien contestar.
        """
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("READ carries an invalid request id")
        kind = request.get("kind")
        if kind not in READ_KINDS:
            self._read_error(request_id, "invalid_path", "kind must be file or dir")
            return
        # The reply can weigh 256 KB. If the outbound queue is already loaded, reject instead of
        # inverting the pressure onto the terminals, which are what truly cannot wait.
        if len(self.outbound) > OUTBOUND_HIGH_WATER:
            self._read_error(request_id, "unavailable", "outbound queue is congested")
            return
        path = request.get("path")
        verdict = self._validate_read_path(path, kind)
        if verdict is not None:
            self._read_error(request_id, verdict[0], verdict[1])
            return
        try:
            if kind == "file":
                self._send_document(request_id, path)
            else:
                self._send_memory_index(request_id, path)
            self._queue(encode_json(TAG_READ_DONE, {"request_id": request_id}))
        except ReadSymlinkError:
            self._read_error(request_id, "symlink_detected", "path contains a symbolic link")
        except ReadPathTypeError:
            self._read_error(request_id, "invalid_path", "path component has the wrong type")
        except PermissionError:
            self._read_error(request_id, "permission_denied", "permission denied")
        except FileNotFoundError:
            # Legitimate race: existed at validation and no longer does. Counted as what it is.
            self._read_error(request_id, "not_found", "vanished while being read")
        except OSError as error:
            self._read_error(request_id, "unknown", f"read failed: {type(error).__name__}")

    def _validate_read_path(self, path: Any, kind: str) -> tuple[str, str] | None:
        """`None` = se puede leer. Si no, `(codigo, motivo)`.

        El orden importa: primero lo sintactico (barato y sin tocar el disco), despues la lista
        blanca, despues la contencion, y solo al final se pregunta al sistema de ficheros. Asi una
        ruta prohibida se rechaza sin que su existencia se pueda deducir del tiempo de respuesta.
        """
        if not isinstance(path, str) or not path:
            return ("invalid_path", "path is required")
        if len(path) > MAX_READ_PATH:
            return ("invalid_path", "path is too long")
        if "\0" in path:
            return ("invalid_path", "path carries a null byte")
        if not path.startswith("/"):
            return ("invalid_path", "path is not absolute")
        segments = path.split("/")
        # Canonical form required: no `..`, `.`, double slashes, or trailing slash. Any other
        # form is rejected rather than normalised, because normalisation is exactly where the
        # differences between what the gateway validates and what the agent opens show up.
        if ".." in segments or "." in segments or "" in segments[1:]:
            return ("invalid_path", "path is not canonical")
        if kind == "dir":
            memory_root = self._memory_root_for_harness()
            if memory_root is None or path != memory_root:
                return ("permission_denied", "path is not the measured memory root")
            home = str(self.bundle["home"]).rstrip("/") or "/"
            if home == "/" or not memory_root.startswith(home + "/"):
                return ("permission_denied", "measured memory root is outside the agent home")
            return None

        base = segments[-1]
        normalized_base = base.casefold()
        if normalized_base in NEVER_SERVE_BASENAMES:
            return ("permission_denied", f"{base} is never served")
        if normalized_base.endswith(NEVER_SERVE_SUFFIXES):
            return ("permission_denied", "looks like credential material")
        if not self._is_readable_governance_file_path(path):
            return ("permission_denied", f"{base} is not a governance document")
        # Project manuals may live in `/workspace`, outside HOME. They are not authorised by a
        # broad containment rule: the exact list above comes from the measured cwd/root. Profile
        # documents remain confined to HOME, also when a test builds the bundle by hand.
        if not self._is_project_manual_path(path):
            home = str(self.bundle["home"]).rstrip("/")
            if not home.startswith("/") or (path != home and not path.startswith(home + "/")):
                return ("permission_denied", "path is outside the agent home")
        # `realpath` resolves ALL components, so this also catches a symlinked parent directory —
        # which is exactly the vector a name blacklist misses.
        try:
            resolved = os.path.realpath(path)
        except OSError:
            return ("unknown", "path could not be resolved")
        if resolved != path:
            return ("symlink_detected", "path resolves somewhere else")
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return ("not_found", "no such file")
        except PermissionError:
            return ("permission_denied", "permission denied")
        except OSError:
            return ("unknown", "stat failed")
        if not stat.S_ISREG(info.st_mode):
            return ("invalid_path", "not a regular file")
        return None

    def _send_document(self, request_id: str, path: str) -> None:
        directory, basename = self._open_governance_parent(path)
        descriptor = os.open(basename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                raise PermissionError("governance target is not a regular file")
            digest = hashlib.sha256()
            raw = bytearray()
            while True:
                chunk = os.read(descriptor, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                if len(raw) < MAX_DOCUMENT_BYTES:
                    raw.extend(chunk[:MAX_DOCUMENT_BYTES - len(raw)])
            info = os.fstat(descriptor)
            identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            identity_after = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if identity_before != identity_after:
                raise OSError("governance file changed while being read")
        finally:
            os.close(descriptor)
            os.close(directory)
        truncated = info.st_size > MAX_DOCUMENT_BYTES
        # Always send valid UTF-8: a byte-wise cut can split a character in half and the relay and
        # gateway decode with no network. A non-text file is sent with replacements, it does not
        # crash the read.
        payload = bytes(raw).decode("utf-8", "replace").encode("utf-8")
        if len(payload) > MAX_DOCUMENT_BYTES:
            payload = payload[:MAX_DOCUMENT_BYTES].decode("utf-8", "ignore").encode("utf-8")
            truncated = True
        chunks = [payload[offset:offset + MAX_DATA] for offset in range(0, len(payload), MAX_DATA)]
        self._queue(encode_json(TAG_READ_OK, {
            "request_id": request_id,
            "kind": "file",
            "path": path,
            # TRUE size of the file, even when the text is truncated: the viewer must be able to
            # see that what they read is not everything.
            "bytes": info.st_size,
            "truncated": truncated,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(info.st_mtime)),
            # Hash of the REAL bytes. For a truncated file it is not the hash of the prefix that
            # travels: the UI never edits it, but it can still identify which version was observed.
            "sha": digest.hexdigest(),
            "chunks": len(chunks),
        }))
        for chunk in chunks:
            self._queue(encode_data(TAG_READ_DATA, request_id, chunk))

    def _send_memory_index(self, request_id: str, root: str) -> None:
        """Indice de memoria: sale METADATO, nunca contenido.

        La raiz se abre una sola vez desde HOME, componente por componente con openat(2). Desde
        ahi el barrido usa exclusivamente descriptores: un rename+symlink entre el descubrimiento
        y la recursion no puede redirigirnos fuera de la memoria medida.
        """
        found: list[tuple[str, int, float]] = []
        capped = False
        scanned = 0
        root_fd = self._open_memory_root(root)

        def walk(directory: int, current: str, depth: int) -> None:
            nonlocal capped, scanned
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        # The cap counts inspected entries, not just publishable files.
                        # Otherwise thousands of directories, sockets, or secret names would make
                        # the scan unbounded even when `found` never grew.
                        if scanned >= DIR_SCAN_CAP:
                            capped = True
                            return
                        scanned += 1
                        name = entry.name
                        normalized_name = name.casefold()
                        if not self._safe_memory_entry_name(name):
                            continue
                        if (normalized_name in NEVER_SERVE_BASENAMES
                                or normalized_name.endswith(NEVER_SERVE_SUFFIXES)):
                            continue
                        logical_path = f"{current}/{name}"
                        if len(logical_path.encode("utf-8")) > MAX_READ_PATH:
                            continue
                        try:
                            discovered = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        except OSError:
                            continue
                        # Symlinks are neither followed nor named: the name of a symlink already
                        # tells that something exists on the other side.
                        if stat.S_ISLNK(discovered.st_mode):
                            continue
                        if stat.S_ISDIR(discovered.st_mode):
                            if depth + 1 < MAX_DIR_DEPTH:
                                try:
                                    child = self._open_memory_directory_at(directory, name)
                                except OSError:
                                    # An unreadable, replaced, or linked subdirectory is skipped.
                                    # O_NOFOLLOW ensures the skip never becomes a leak.
                                    continue
                                try:
                                    walk(child, logical_path, depth + 1)
                                finally:
                                    os.close(child)
                                if capped:
                                    return
                            continue
                        if not stat.S_ISREG(discovered.st_mode):
                            continue
                        info = self._memory_regular_stat_at(directory, name)
                        if info is not None:
                            found.append((logical_path, info.st_size, info.st_mtime))
            except OSError:
                if depth == 0:
                    raise
                # An unreadable subdirectory does not invalidate the index: skipped and continued.

        try:
            walk(root_fd, root, 0)
        finally:
            os.close(root_fd)
        found.sort(key=lambda item: item[2], reverse=True)
        # The index travels in ONE frame and a frame has a hard cap (MAX_FRAME). 200 paths of 4 KB
        # do not fit, and overshooting would not be a truncated index but a ProtocolError that
        # drops the connection and with it the open terminals. Cut by BUDGET, not just by count.
        rows: list[dict[str, Any]] = []
        budget = READ_INDEX_BUDGET
        for item in found[:MAX_DIR_ENTRIES]:
            cost = len(item[0].encode("utf-8")) + 80
            if cost > budget:
                break
            budget -= cost
            rows.append({
                "path": item[0],
                "bytes": item[1],
                "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(item[2])),
            })
        self._queue(encode_json(TAG_READ_OK, {
            "request_id": request_id,
            "kind": "dir",
            "path": root,
            # If the scan cap cut the tree there is no exact total: `null` prevents a downstream
            # layer from turning the observed prefix into a full-disk count. A pure row/byte
            # truncation preserves `total`, because the scan did finish.
            "total": None if capped else len(found),
            "observed_at_least": len(found),
            "truncated": capped or len(rows) < len(found),
            "entries": rows,
        }))

    def _read_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_READ_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))
