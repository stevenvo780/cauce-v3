from __future__ import annotations

import json
import os
import pathlib
import secrets
import stat

from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, path
from secure_path import open_absolute_directory


def publish_gateway_registry(policy: dict) -> None:
    destination = policy.get("transport", {}).get("registry_directory")
    if destination is None:
        return
    root = path(destination)
    descriptor = open_absolute_directory(root)
    try:
        details = os.fstat(descriptor)
        if details.st_uid != os.geteuid() or details.st_mode & 0o022:
            raise SafeFailure("gateway registry view has unsafe ownership or mode")
        for name in ("mtls_identities.json", "token_hashes.json"):
            source = pathlib.Path(policy["roots"]["identities"]) / name
            raw = checked_file(source) if source.exists() else b'{"version":1,"identities":[]}'
            document = json.loads(raw)
            if (
                set(document) != {"version", "identities"}
                or document["version"] != 1
                or not isinstance(document["identities"], list)
            ):
                raise SafeFailure("gateway registry source has invalid shape")
            if any(
                not isinstance(entry, dict)
                or set(entry) - {"certificate_sha256", "token_sha256", "expires_at", "principal"}
                for entry in document["identities"]
            ):
                raise SafeFailure("gateway registry view may only contain digests and principals")
            temporary = "." + name + "." + secrets.token_hex(16)
            output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
            try:
                offset = 0
                while offset < len(raw):
                    offset += os.write(output, raw[offset:])
                os.fchmod(output, 0o644)
                os.fsync(output)
            finally:
                os.close(output)
            try:
                try:
                    current = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if current and (
                    not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_uid != os.geteuid()
                ):
                    raise SafeFailure("gateway registry destination was replaced")
                os.replace(temporary, name, src_dir_fd=descriptor, dst_dir_fd=descriptor)
                os.fsync(descriptor)
            finally:
                try:
                    os.unlink(temporary, dir_fd=descriptor)
                except FileNotFoundError:
                    pass
    finally:
        os.close(descriptor)
