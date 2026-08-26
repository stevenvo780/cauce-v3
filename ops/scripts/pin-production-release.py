#!/usr/bin/env python3
"""Atomically compare-and-swap the complete production release selector set.

The production env contains secret-bearing path configuration, so this helper never
sources it and never prints values. Runtime, console, authenticated override manifest
path/hash, rollback-baseline path/hash, and external-writer recovery snapshot path/hash are
compared and replaced as one selector set.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import struct
import subprocess
import sys
from collections.abc import Callable


IMAGE_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$"
)
LEGACY_IMAGE_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*"
    r"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$"
)
LEGACY_BARE_DIGEST_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$"
)
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
CONTAINER_ID = re.compile(r"^[a-f0-9]{12,64}$")
COMPOSE_SERVICE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")
ALLOWED_COMPOSE_PROFILES = (
    "origin-relay",
    "telegram",
    "terminal",
    "shadow",
    "observability",
)
DENIED_COMPOSE_CONTROLS = {
    "COMPOSE_FILE",
    "COMPOSE_PATH_SEPARATOR",
    "COMPOSE_ENV_FILES",
    "COMPOSE_DISABLE_ENV_FILE",
    "COMPOSE_IGNORE_ORPHANS",
    "COMPOSE_REMOVE_ORPHANS",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
}
KEYS = (
    "CAUCE_RUNTIME_IMAGE",
    "CAUCE_CONSOLE_IMAGE",
    "CAUCE_COMPOSE_OVERRIDE_MANIFEST",
    "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256",
    "CAUCE_ROLLBACK_BASELINE_FILE",
    "CAUCE_ROLLBACK_BASELINE_SHA256",
    "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE",
    "CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256",
)
SIX_SELECTOR_KEYS = tuple(
    key for key in KEYS if not key.startswith("CAUCE_ROLLBACK_WRITER_SNAPSHOT_")
)
LEGACY_KEYS = tuple(
    key for key in SIX_SELECTOR_KEYS if key != "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"
)
_ARTIFACT_TEST_READ_COUNTS: dict[str, int] = {}


class PinError(ValueError):
    pass


_OFD_LOCK_FORMAT = "hhqqi"


def _ofd_lock_payload(lock_type: int) -> bytes:
    """Build Linux's native ``struct flock`` for one private lock byte."""
    if not hasattr(fcntl, "F_OFD_SETLK"):
        raise PinError("open-file-description locks are unavailable")
    return struct.pack(_OFD_LOCK_FORMAT, lock_type, os.SEEK_SET, 0, 1, 0)


def _try_ofd_lock(descriptor: int) -> bool:
    """Try to own the transition byte on this exact open-file description."""
    try:
        fcntl.fcntl(
            descriptor,
            fcntl.F_OFD_SETLK,
            _ofd_lock_payload(fcntl.F_WRLCK),
        )
        return True
    except OSError as error:
        if error.errno in {errno.EACCES, errno.EAGAIN}:
            return False
        raise


def _ofd_lock_conflicts(descriptor: int) -> bool:
    """Report whether another open-file description owns the lock byte."""
    if not hasattr(fcntl, "F_OFD_GETLK"):
        raise PinError("open-file-description lock queries are unavailable")
    result = fcntl.fcntl(
        descriptor,
        fcntl.F_OFD_GETLK,
        _ofd_lock_payload(fcntl.F_WRLCK),
    )
    lock_type, _whence, _start, _length, _pid = struct.unpack(
        _OFD_LOCK_FORMAT,
        result,
    )
    if lock_type == fcntl.F_UNLCK:
        return False
    if lock_type not in {fcntl.F_RDLCK, fcntl.F_WRLCK}:
        raise PinError("open-file-description lock query returned an invalid state")
    return True


def _metadata_signature(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _directory_identity(metadata: os.stat_result) -> tuple[int, ...]:
    """Return the stable identity/security fields for an opened directory."""
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
    )


def _private_name_identity(metadata: os.stat_result) -> tuple[int, ...]:
    """Return fields that bind one private directory entry to its opened FD."""
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
    )


def _canonical_path(
    path: pathlib.Path, *, label: str, final_may_be_absent: bool
) -> pathlib.Path:
    """Reject lexical aliases and symlinked parents before a security-sensitive path lookup."""
    if not path.is_absolute() or not path.name or path.name in {".", ".."}:
        raise PinError(f"{label} path is invalid")
    if os.path.normpath(os.fspath(path)) != os.fspath(path):
        raise PinError(f"{label} path is not canonical")
    try:
        resolved_parent = path.parent.resolve(strict=True)
    except OSError as error:
        raise PinError(f"{label} parent is unavailable") from error
    if resolved_parent != path.parent:
        raise PinError(f"{label} parent must not contain symlink aliases")
    canonical = resolved_parent / path.name
    if not final_may_be_absent:
        try:
            resolved = path.resolve(strict=True)
        except OSError as error:
            raise PinError(f"{label} is unavailable") from error
        if resolved != canonical:
            raise PinError(f"{label} must not be a symlink alias")
    return canonical


def _open_protected_parent(
    path: pathlib.Path, *, label: str
) -> tuple[int, tuple[int, ...]]:
    """Open and authenticate the canonical parent used for a create-only publication."""
    canonical = _canonical_path(path, label=label, final_may_be_absent=True)
    parent = canonical.parent
    try:
        named = parent.lstat()
    except OSError as error:
        raise PinError(f"{label} parent is unavailable") from error
    if (
        not stat.S_ISDIR(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or named.st_uid not in {0, os.geteuid()}
        or stat.S_IMODE(named.st_mode) & 0o022
    ):
        raise PinError(f"{label} parent is not owned and protected")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(parent, flags)
    except OSError as error:
        raise PinError(f"{label} parent cannot be opened safely") from error
    try:
        opened = os.fstat(descriptor)
        if _directory_identity(opened) != _directory_identity(named):
            raise PinError(f"{label} parent changed before it was opened")
        return descriptor, _directory_identity(opened)
    except Exception:
        os.close(descriptor)
        raise


def _revalidate_parent(
    path: pathlib.Path,
    descriptor: int,
    expected: tuple[int, ...],
    *,
    label: str,
) -> None:
    """Prove that a held directory descriptor still names the requested protected parent."""
    canonical = _canonical_path(path, label=label, final_may_be_absent=True)
    try:
        named = canonical.parent.lstat()
        opened = os.fstat(descriptor)
    except OSError as error:
        raise PinError(f"{label} parent identity is unavailable") from error
    if (
        _directory_identity(named) != expected
        or _directory_identity(opened) != expected
        or stat.S_IMODE(opened.st_mode) & 0o022
        or opened.st_uid not in {0, os.geteuid()}
    ):
        raise PinError(f"{label} parent identity or protection changed")


def _validate_private_file(path: pathlib.Path, *, label: str) -> os.stat_result:
    if not path.is_absolute():
        raise PinError(f"{label} must be an absolute path")
    try:
        metadata = path.lstat()
    except OSError as error:
        raise PinError(f"{label} is missing or unreadable") from error
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise PinError(f"{label} must be a regular non-symlink file")
    if metadata.st_nlink != 1:
        raise PinError(f"{label} must have exactly one hard link")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise PinError(f"{label} must have mode 0600")
    if metadata.st_uid not in {0, os.geteuid()}:
        raise PinError(f"{label} must be owned by root or the invoking user")
    return metadata


def _validate_manifest(path_text: str, *, label: str) -> None:
    if not path_text or any(ord(character) < 32 for character in path_text):
        raise PinError(f"{label} is invalid")
    path = pathlib.Path(path_text)
    if not path.is_absolute():
        raise PinError(f"{label} must be an absolute path")
    try:
        metadata = path.lstat()
    except OSError as error:
        raise PinError(f"{label} is missing or unreadable") from error
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise PinError(f"{label} must be a regular non-symlink file")
    if metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise PinError(f"{label} must be a single-link mode-0600 file")
    if metadata.st_uid not in {0, os.geteuid()}:
        raise PinError(f"{label} must be owned by root or the invoking user")


def _manifest_digest(path_text: str, *, label: str) -> str:
    """Read a private artifact and prove its pathname still names the opened inode."""
    _validate_manifest(path_text, label=label)
    path = pathlib.Path(path_text)
    directory, parent_identity = _open_protected_parent(path, label=label)
    try:
        content, _ = _read_private_name(
            path,
            directory,
            parent_identity,
            label=label,
            recover_interrupted_link=False,
            after_read=lambda: _artifact_test_barrier_after_read(path),
        )
    finally:
        os.close(directory)
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def _artifact_test_barrier_after_read(path: pathlib.Path) -> None:
    """Expose one deterministic artifact-name race only to explicit tests."""
    selected = os.environ.get("CAUCE_PIN_TEST_ARTIFACT_PATH", "")
    if selected != os.fspath(path):
        return
    raw_occurrence = os.environ.get("CAUCE_PIN_TEST_ARTIFACT_OCCURRENCE", "")
    if re.fullmatch(r"[1-9][0-9]*", raw_occurrence) is None:
        raise PinError("test artifact barrier occurrence is invalid")
    observed = _ARTIFACT_TEST_READ_COUNTS.get(selected, 0) + 1
    _ARTIFACT_TEST_READ_COUNTS[selected] = observed
    if observed == int(raw_occurrence):
        _test_barrier("artifact-digest-after-read")


def _validate_manifest_digest(path_text: str, expected: str, *, label: str) -> None:
    if DIGEST.fullmatch(expected) is None:
        raise PinError(f"{label} SHA-256 is invalid")
    if _manifest_digest(path_text, label=label) != expected:
        raise PinError(f"{label} differs from its authorized SHA-256")


def _validate_isolated_evidence_context(
    root: pathlib.Path,
    env_file: pathlib.Path,
    *,
    env_content: bytes,
    expected_manifest: str,
    target_manifest: str,
    expected_baseline: str,
    target_baseline: str,
    expected_baseline_sha256: str,
    target_baseline_sha256: str,
    expected_writer_snapshot: str,
    target_writer_snapshot: str,
    expected_writer_snapshot_sha256: str,
    target_writer_snapshot_sha256: str,
) -> None:
    """Authenticate the non-production selector used by rollback evidence.

    Bridge evidence cannot consume the production rollback baseline that it is
    itself required to authorize.  This narrowly-scoped mode therefore verifies
    a complete eight-field selector in an owned 0700 scratch directory and binds
    its placeholder baseline by SHA-256.  Production ``check``/``swap`` never
    enter this path unless the explicit evidence root is supplied.
    """

    if os.environ.get("CAUCE_ROLLBACK_EVIDENCE_MODE") != "isolated-compose-v1":
        raise PinError("isolated rollback evidence capability is absent")
    if not root.is_absolute():
        raise PinError("isolated rollback evidence root must be absolute")
    try:
        root_metadata = root.lstat()
        resolved_root = root.resolve(strict=True)
    except OSError as error:
        raise PinError("isolated rollback evidence root is unavailable") from error
    if (
        resolved_root != root
        or not stat.S_ISDIR(root_metadata.st_mode)
        or stat.S_ISLNK(root_metadata.st_mode)
        or stat.S_IMODE(root_metadata.st_mode) != 0o700
        or root_metadata.st_uid not in {0, os.geteuid()}
    ):
        raise PinError(
            "isolated rollback evidence root must be an owned canonical mode-0700 directory"
        )
    allowed = {
        root / "release.env",
        root / "candidate.manifest",
        root / "bridge.manifest",
        root / "rollback-baseline.json",
        root / "writer-snapshot.json",
    }
    selected_paths = {
        env_file,
        pathlib.Path(expected_manifest),
        pathlib.Path(target_manifest),
        pathlib.Path(expected_baseline),
        pathlib.Path(target_baseline),
        pathlib.Path(expected_writer_snapshot),
        pathlib.Path(target_writer_snapshot),
    }
    if not selected_paths.issubset(allowed) or env_file != root / "release.env":
        raise PinError("isolated rollback evidence selector escaped its scratch root")
    if (
        expected_baseline != target_baseline
        or expected_baseline_sha256 != target_baseline_sha256
    ):
        raise PinError("isolated rollback evidence cannot change its baseline identity")
    if (
        expected_writer_snapshot != target_writer_snapshot
        or expected_writer_snapshot_sha256 != target_writer_snapshot_sha256
    ):
        raise PinError(
            "isolated rollback evidence cannot change its writer snapshot identity"
        )
    try:
        env_text = env_content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PinError("isolated rollback evidence selector is not UTF-8") from error
    env_lines, env_values = _parse(env_text)
    if (
        len(env_lines) != len(KEYS)
        or any(
            not env_lines[index].startswith(f"{key}=") for index, key in enumerate(KEYS)
        )
        or set(env_values) != set(KEYS)
    ):
        raise PinError(
            "isolated rollback evidence selector must contain exactly eight canonical fields"
        )
    baseline_path = pathlib.Path(target_baseline)
    _validate_private_file(baseline_path, label="isolated rollback evidence baseline")
    baseline_content, _ = _read_exact(baseline_path)
    observed = f"sha256:{hashlib.sha256(baseline_content).hexdigest()}"
    if observed != target_baseline_sha256:
        raise PinError(
            "isolated rollback evidence baseline differs from its SHA-256 selector"
        )
    _validate_manifest_digest(
        target_writer_snapshot,
        target_writer_snapshot_sha256,
        label="isolated rollback evidence writer snapshot",
    )


def _parse(
    content: str,
    required_keys: tuple[str, ...] = KEYS,
) -> tuple[list[str], dict[str, tuple[int, str]]]:
    lines = content.splitlines(keepends=True)
    if content and not content.endswith(("\n", "\r")):
        raise PinError("production env must end with a newline")
    found: dict[str, tuple[int, str]] = {}
    for index, raw_line in enumerate(lines):
        line = raw_line.removesuffix("\n").removesuffix("\r")
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key not in required_keys:
            continue
        if key in found:
            raise PinError(f"production env contains duplicate {key}")
        found[key] = (index, value)
    for key in required_keys:
        if key not in found:
            raise PinError(f"production env is missing {key}")
    return lines, found


def _parse_current_or_six_selector(
    content: str,
) -> tuple[list[str], dict[str, tuple[int, str]]]:
    """Read the current eight-selector contract or the one authorized six-field bootstrap input."""
    present = {
        raw.split("=", 1)[0]
        for raw in content.splitlines()
        if raw and not raw.startswith("#") and "=" in raw
    }
    writer_keys = set(KEYS) - set(SIX_SELECTOR_KEYS)
    selected_writer_keys = present & writer_keys
    if selected_writer_keys == writer_keys:
        return _parse(content, KEYS)
    if not selected_writer_keys:
        return _parse(content, SIX_SELECTOR_KEYS)
    raise PinError(
        "production env contains a partial rollback writer snapshot selector"
    )


def _validate_canonical_compose_controls(content: str) -> None:
    """Reject ambiguous project/profile/daemon authority before first publication."""
    values: dict[str, str] = {}
    for number, raw in enumerate(content.splitlines(), start=1):
        if not raw or raw.startswith("#"):
            continue
        if "=" not in raw:
            raise PinError(f"bootstrap candidate env line {number} is invalid")
        key, value = raw.split("=", 1)
        if ENV_KEY.fullmatch(key) is None:
            raise PinError(f"bootstrap candidate env key at line {number} is invalid")
        if key in values:
            raise PinError(f"bootstrap candidate env contains duplicate {key}")
        values[key] = value
    if values.get("COMPOSE_PROJECT_NAME") != "cauce-v3-prod":
        raise PinError("bootstrap COMPOSE_PROJECT_NAME must be exactly cauce-v3-prod")
    if DENIED_COMPOSE_CONTROLS.intersection(values):
        raise PinError(
            "bootstrap candidate env contains forbidden Docker/Compose controls"
        )
    raw_profiles = values.get("COMPOSE_PROFILES", "")
    profiles = [item.strip() for item in raw_profiles.split(",") if item.strip()]
    if len(profiles) != len(set(profiles)) or any(
        item not in ALLOWED_COMPOSE_PROFILES for item in profiles
    ):
        raise PinError(
            "bootstrap COMPOSE_PROFILES contains duplicates or an unsupported profile"
        )


def _open_lock(
    path: pathlib.Path,
    directory: int,
    parent_identity: tuple[int, ...],
) -> int:
    _revalidate_parent(
        path,
        directory,
        parent_identity,
        label="production release lock",
    )
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path.name, flags, 0o600, dir_fd=directory)
    except OSError as error:
        raise PinError("production release lock cannot be opened safely") from error
    try:
        metadata = os.fstat(descriptor)
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if (
            _private_name_identity(metadata) != _private_name_identity(named)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}
        ):
            raise PinError(
                "production release lock must be a single-link private regular file"
            )
        # Keep the traditional flock for process-wide serialization and a
        # Linux OFD lock for exact inherited-capability authentication.  Unlike
        # flock(), an OFD lock lets a child prove that its descriptor refers to
        # the already-locked open-file description without acquiring a missing
        # lock inside the verifier.
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        if not _try_ofd_lock(descriptor):
            raise PinError("production release OFD lock could not be acquired")
        _revalidate_parent(
            path,
            directory,
            parent_identity,
            label="production release lock",
        )
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if _private_name_identity(os.fstat(descriptor)) != _private_name_identity(
            named
        ):
            raise PinError("production release lock name changed after acquisition")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _inherited_lock(
    path: pathlib.Path,
    raw_descriptor: int,
    directory: int,
    parent_identity: tuple[int, ...],
) -> int:
    """Authenticate an inherited capability for an already-held transition lock.

    ``rollback.sh`` is executed by ``locked-exec`` while the parent helper keeps
    this flock for the complete deploy/health/compensation transaction.  Nested
    field/check/swap calls reuse a duplicate of the same open-file description;
    they must never release and reacquire the lock between phases.
    """
    if raw_descriptor < 3:
        raise PinError("inherited production release lock descriptor is invalid")
    _revalidate_parent(
        path,
        directory,
        parent_identity,
        label="production release lock",
    )
    try:
        descriptor = os.dup(raw_descriptor)
        metadata = os.fstat(descriptor)
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
    except OSError as error:
        raise PinError("inherited production release lock is unavailable") from error
    try:
        if (
            (metadata.st_dev, metadata.st_ino) != (named.st_dev, named.st_ino)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}
        ):
            raise PinError("inherited production release lock identity is invalid")
        token = os.environ.get("CAUCE_RELEASE_TRANSITION_LOCK_TOKEN", "")
        if re.fullmatch(r"[a-f0-9]{64}", token) is None:
            raise PinError("inherited production release lock capability is absent")
        if os.pread(descriptor, 65, 0) != f"{token}\n".encode("ascii"):
            raise PinError(
                "inherited production release lock capability does not match"
            )

        flags = os.O_RDWR | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        probe = os.open(path.name, flags, dir_fd=directory)
        try:
            # Probe before touching either lock through the supplied FD.  If a
            # separate open can take flock or OFD ownership, the caller handed
            # us an initially-unlocked inode and must be rejected.
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fcntl.flock(probe, fcntl.LOCK_UN)
                raise PinError(
                    "inherited production release flock was not already exclusive"
                )

            if not _ofd_lock_conflicts(probe):
                raise PinError(
                    "inherited production release OFD lock was not already exclusive"
                )

            # OFD_GETLK ignores locks owned by the queried open-file
            # description.  A true inherited duplicate therefore sees no
            # conflict, whereas a separately opened descriptor sees the
            # parent's lock and fails closed without modifying either lock.
            if _ofd_lock_conflicts(descriptor):
                raise PinError(
                    "inherited production release lock is not owned by this transition"
                )

            # Recheck after the ownership query.  A real inherited duplicate
            # keeps both locks alive even if its parent exits; a racing foreign
            # owner cannot disappear between probes and turn an unlocked FD
            # into a valid capability.
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fcntl.flock(probe, fcntl.LOCK_UN)
                raise PinError("inherited production release flock ownership was lost")
            if not _ofd_lock_conflicts(probe):
                raise PinError("inherited production release OFD ownership was lost")
        finally:
            os.close(probe)
        _revalidate_parent(
            path,
            directory,
            parent_identity,
            label="production release lock",
        )
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if _private_name_identity(os.fstat(descriptor)) != _private_name_identity(
            named
        ):
            raise PinError("inherited production release lock name changed")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _transition_lock(
    env_file: pathlib.Path,
    inherited: int | None,
    directory: int,
    parent_identity: tuple[int, ...],
) -> int:
    lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
    return (
        _open_lock(lock_path, directory, parent_identity)
        if inherited is None
        else _inherited_lock(lock_path, inherited, directory, parent_identity)
    )


def _read_exact(path: pathlib.Path) -> tuple[bytes, os.stat_result]:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise PinError("production env cannot be opened safely") from error
    try:
        before = os.fstat(descriptor)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if _metadata_signature(before) != _metadata_signature(after):
            raise PinError("production env changed while it was being read")
        return b"".join(chunks), before
    finally:
        os.close(descriptor)


def _replace(
    path: pathlib.Path,
    content: bytes,
    original: bytes,
    metadata: os.stat_result,
    directory: int,
    parent_identity: tuple[int, ...],
    *,
    require_named_parent: bool = True,
) -> None:
    if require_named_parent:
        _revalidate_parent(
            path,
            directory,
            parent_identity,
            label="production env",
        )
    temporary = f".{path.name}.release-pin-{os.getpid()}-{secrets.token_hex(8)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    temporary_identity: tuple[int, ...] | None = None
    try:
        descriptor = os.open(temporary, flags, 0o600, dir_fd=directory)
        os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
        try:
            os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        except PermissionError as error:
            if (metadata.st_uid, metadata.st_gid) != (os.geteuid(), os.getegid()):
                raise PinError(
                    "production env ownership could not be preserved"
                ) from error
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        temporary_identity = _private_name_identity(os.fstat(descriptor))
        os.close(descriptor)
        descriptor = -1

        current, current_metadata = _read_private_name(
            path,
            directory,
            parent_identity,
            label="production env",
            recover_interrupted_link=False,
            require_named_parent=require_named_parent,
        )
        if current != original or _metadata_signature(
            current_metadata
        ) != _metadata_signature(metadata):
            raise PinError(
                "compare-and-swap failed: production env changed during update"
            )
        if require_named_parent:
            _revalidate_parent(
                path,
                directory,
                parent_identity,
                label="production env",
            )
        os.replace(
            temporary,
            path.name,
            src_dir_fd=directory,
            dst_dir_fd=directory,
        )
        os.fsync(directory)
        if require_named_parent:
            _revalidate_parent(
                path,
                directory,
                parent_identity,
                label="production env",
            )
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if _private_name_identity(named) != temporary_identity:
            raise PinError(
                "production env replacement name differs from its published inode"
            )
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def _replace_with_compensating_admission(
    path: pathlib.Path,
    replacement: bytes,
    original: bytes,
    metadata: os.stat_result,
    directory: int,
    parent_identity: tuple[int, ...],
    *,
    barrier: str,
    label: str,
    admit: Callable[[], None],
) -> None:
    """Replace once, then restore the exact old selector if a selected input raced."""
    try:
        _replace(
            path,
            replacement,
            original,
            metadata,
            directory,
            parent_identity,
        )
        _test_barrier(barrier)
        admit()
    except Exception as admission_error:
        try:
            current, current_metadata = _read_private_name(
                path,
                directory,
                parent_identity,
                label="production env",
                recover_interrupted_link=False,
                require_named_parent=False,
            )
            if current == original:
                raise admission_error
            if current != replacement:
                raise PinError(f"{label} selector changed before compensation")
            _replace(
                path,
                original,
                replacement,
                current_metadata,
                directory,
                parent_identity,
                require_named_parent=False,
            )
            restored, restored_metadata = _read_private_name(
                path,
                directory,
                parent_identity,
                label="production env",
                recover_interrupted_link=False,
                require_named_parent=False,
            )
            if (
                restored != original
                or stat.S_IMODE(restored_metadata.st_mode)
                != stat.S_IMODE(metadata.st_mode)
                or restored_metadata.st_uid != metadata.st_uid
                or restored_metadata.st_gid != metadata.st_gid
            ):
                raise PinError(f"{label} selector compensation failed its read-back")
        except Exception as compensation_error:
            if compensation_error is admission_error:
                raise
            raise PinError(
                f"{label} post-publication admission failed and selector compensation failed"
            ) from compensation_error
        raise PinError(
            f"{label} post-publication admission failed; selector restored"
        ) from admission_error


def _admit_recovered_replacement_or_restore(
    path: pathlib.Path,
    replacement: bytes,
    original: bytes,
    metadata: os.stat_result,
    directory: int,
    parent_identity: tuple[int, ...],
    *,
    label: str,
    admit: Callable[[], None],
) -> None:
    """Finish an exact durable replacement, or restore its authenticated pre-state."""
    try:
        admit()
    except Exception as admission_error:
        try:
            current, current_metadata = _read_private_name(
                path,
                directory,
                parent_identity,
                label="production env",
                recover_interrupted_link=False,
                require_named_parent=False,
            )
            if current != replacement:
                raise PinError(f"{label} selector changed before recovery")
            _replace(
                path,
                original,
                replacement,
                current_metadata,
                directory,
                parent_identity,
                require_named_parent=False,
            )
            restored, restored_metadata = _read_private_name(
                path,
                directory,
                parent_identity,
                label="production env",
                recover_interrupted_link=False,
                require_named_parent=False,
            )
            if (
                restored != original
                or stat.S_IMODE(restored_metadata.st_mode)
                != stat.S_IMODE(metadata.st_mode)
                or restored_metadata.st_uid != metadata.st_uid
                or restored_metadata.st_gid != metadata.st_gid
            ):
                raise PinError(f"{label} recovery failed its restored read-back")
        except Exception as recovery_error:
            raise PinError(
                f"{label} interrupted replacement admission failed and recovery failed"
            ) from recovery_error
        raise PinError(
            f"{label} interrupted replacement admission failed; selector restored"
        ) from admission_error


def transition(
    env_file: pathlib.Path,
    *,
    expected_runtime: str,
    target_runtime: str,
    expected_console: str,
    target_console: str,
    expected_manifest: str,
    target_manifest: str,
    expected_baseline: str,
    target_baseline: str,
    expected_baseline_sha256: str,
    target_baseline_sha256: str,
    expected_writer_snapshot: str,
    target_writer_snapshot: str,
    expected_writer_snapshot_sha256: str,
    target_writer_snapshot_sha256: str,
    baseline_forward_release_commit: str,
    baseline_forward_runtime_image: str,
    baseline_forward_runtime_source_digest: str,
    write: bool,
    expected_manifest_sha256: str | None = None,
    target_manifest_sha256: str | None = None,
    inherited_lock: int | None = None,
    isolated_evidence_root: pathlib.Path | None = None,
) -> None:
    image_values = (expected_runtime, target_runtime, expected_console, target_console)
    if any(IMAGE_REF.fullmatch(value) is None for value in image_values):
        raise PinError(
            "image selectors must be immutable repository @sha256 references"
        )
    _validate_manifest(expected_manifest, label="expected override manifest")
    _validate_manifest(target_manifest, label="target override manifest")
    _validate_manifest(expected_baseline, label="expected rollback baseline")
    _validate_manifest(target_baseline, label="target rollback baseline")
    _validate_manifest(
        expected_writer_snapshot, label="expected rollback writer snapshot"
    )
    _validate_manifest(target_writer_snapshot, label="target rollback writer snapshot")
    if expected_manifest_sha256 is None or target_manifest_sha256 is None:
        raise PinError(
            "both expected and target override manifest SHA-256 values are required"
        )
    if (
        DIGEST.fullmatch(expected_manifest_sha256) is None
        or DIGEST.fullmatch(target_manifest_sha256) is None
    ):
        raise PinError("override manifest SHA-256 values are invalid")
    if (
        DIGEST.fullmatch(expected_baseline_sha256) is None
        or DIGEST.fullmatch(target_baseline_sha256) is None
    ):
        raise PinError("rollback baseline SHA-256 selectors are invalid")
    if (
        DIGEST.fullmatch(expected_writer_snapshot_sha256) is None
        or DIGEST.fullmatch(target_writer_snapshot_sha256) is None
    ):
        raise PinError("rollback writer snapshot SHA-256 selectors are invalid")
    directory, parent_identity = _open_protected_parent(
        env_file,
        label="production env",
    )
    lock_descriptor = _transition_lock(
        env_file,
        inherited_lock,
        directory,
        parent_identity,
    )
    try:
        _validate_manifest_digest(
            expected_manifest,
            expected_manifest_sha256,
            label="expected override manifest",
        )
        _validate_manifest_digest(
            target_manifest, target_manifest_sha256, label="target override manifest"
        )
        _validate_manifest_digest(
            expected_baseline,
            expected_baseline_sha256,
            label="expected rollback baseline",
        )
        _validate_manifest_digest(
            target_baseline,
            target_baseline_sha256,
            label="target rollback baseline",
        )
        _validate_manifest_digest(
            expected_writer_snapshot,
            expected_writer_snapshot_sha256,
            label="expected rollback writer snapshot",
        )
        _validate_manifest_digest(
            target_writer_snapshot,
            target_writer_snapshot_sha256,
            label="target rollback writer snapshot",
        )
        original, opened_metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="production env",
            recover_interrupted_link=False,
        )
        if isolated_evidence_root is not None:
            _validate_isolated_evidence_context(
                isolated_evidence_root,
                env_file,
                env_content=original,
                expected_manifest=expected_manifest,
                target_manifest=target_manifest,
                expected_baseline=expected_baseline,
                target_baseline=target_baseline,
                expected_baseline_sha256=expected_baseline_sha256,
                target_baseline_sha256=target_baseline_sha256,
                expected_writer_snapshot=expected_writer_snapshot,
                target_writer_snapshot=target_writer_snapshot,
                expected_writer_snapshot_sha256=expected_writer_snapshot_sha256,
                target_writer_snapshot_sha256=target_writer_snapshot_sha256,
            )
        try:
            decoded = original.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PinError("production env is not valid UTF-8") from error
        lines, values = _parse(decoded)
        observed_runtime = values["CAUCE_RUNTIME_IMAGE"][1]
        observed_console = values["CAUCE_CONSOLE_IMAGE"][1]
        observed_manifest = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1]
        observed_manifest_sha256 = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1]
        observed_baseline = values["CAUCE_ROLLBACK_BASELINE_FILE"][1]
        observed_baseline_sha256 = values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]
        observed_writer_snapshot = values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][1]
        observed_writer_snapshot_sha256 = values[
            "CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"
        ][1]
        if (
            observed_runtime != expected_runtime
            or observed_console != expected_console
            or observed_manifest != expected_manifest
            or observed_manifest_sha256 != expected_manifest_sha256
            or observed_baseline != expected_baseline
            or observed_baseline_sha256 != expected_baseline_sha256
            or observed_writer_snapshot != expected_writer_snapshot
            or observed_writer_snapshot_sha256 != expected_writer_snapshot_sha256
        ):
            raise PinError(
                "compare-and-swap failed: configured release selectors changed"
            )
        if isolated_evidence_root is None:
            try:
                subprocess.run(
                    [
                        sys.executable,
                        os.fspath(
                            pathlib.Path(__file__).with_name("rollback-baseline.py")
                        ),
                        "check",
                        "--baseline",
                        target_baseline,
                        "--expected-baseline-sha256",
                        target_baseline_sha256,
                        "--expected-forward-release-commit",
                        baseline_forward_release_commit,
                        "--expected-forward-runtime-image",
                        baseline_forward_runtime_image,
                        "--expected-forward-runtime-source-digest",
                        baseline_forward_runtime_source_digest,
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except (OSError, subprocess.CalledProcessError) as error:
                raise PinError(
                    "target rollback baseline did not pass fail-closed validation"
                ) from error
        # Baseline validation can pull multiple images and validate external evidence. Re-read
        # every content-addressed selector immediately before the CAS so a same-path byte
        # replacement cannot ride through that interval.
        _validate_manifest_digest(
            expected_manifest,
            expected_manifest_sha256,
            label="expected override manifest",
        )
        _validate_manifest_digest(
            target_manifest, target_manifest_sha256, label="target override manifest"
        )
        _validate_manifest_digest(
            expected_baseline,
            expected_baseline_sha256,
            label="expected rollback baseline",
        )
        _validate_manifest_digest(
            target_baseline,
            target_baseline_sha256,
            label="target rollback baseline",
        )
        _validate_manifest_digest(
            expected_writer_snapshot,
            expected_writer_snapshot_sha256,
            label="expected rollback writer snapshot",
        )
        _validate_manifest_digest(
            target_writer_snapshot,
            target_writer_snapshot_sha256,
            label="target rollback writer snapshot",
        )
        if not write:
            return
        lines[values["CAUCE_RUNTIME_IMAGE"][0]] = (
            f"CAUCE_RUNTIME_IMAGE={target_runtime}\n"
        )
        lines[values["CAUCE_CONSOLE_IMAGE"][0]] = (
            f"CAUCE_CONSOLE_IMAGE={target_console}\n"
        )
        lines[values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][0]] = (
            f"CAUCE_COMPOSE_OVERRIDE_MANIFEST={target_manifest}\n"
        )
        lines[values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][0]] = (
            f"CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256={target_manifest_sha256}\n"
        )
        lines[values["CAUCE_ROLLBACK_BASELINE_FILE"][0]] = (
            f"CAUCE_ROLLBACK_BASELINE_FILE={target_baseline}\n"
        )
        lines[values["CAUCE_ROLLBACK_BASELINE_SHA256"][0]] = (
            f"CAUCE_ROLLBACK_BASELINE_SHA256={target_baseline_sha256}\n"
        )
        lines[values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][0]] = (
            f"CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE={target_writer_snapshot}\n"
        )
        lines[values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"][0]] = (
            f"CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256={target_writer_snapshot_sha256}\n"
        )
        replacement = "".join(lines).encode("utf-8")

        def admit_published_selector() -> None:
            published, published_metadata = _read_private_name(
                env_file,
                directory,
                parent_identity,
                label="production env",
                recover_interrupted_link=False,
            )
            if (
                published != replacement
                or stat.S_IMODE(published_metadata.st_mode)
                != stat.S_IMODE(opened_metadata.st_mode)
                or published_metadata.st_uid != opened_metadata.st_uid
                or published_metadata.st_gid != opened_metadata.st_gid
            ):
                raise PinError("complete release selector failed its atomic read-back")
            _validate_manifest_digest(
                target_manifest,
                target_manifest_sha256,
                label="selected target override manifest",
            )
            _validate_manifest_digest(
                target_baseline,
                target_baseline_sha256,
                label="selected target rollback baseline",
            )
            _validate_manifest_digest(
                target_writer_snapshot,
                target_writer_snapshot_sha256,
                label="selected rollback writer snapshot",
            )

        _replace_with_compensating_admission(
            env_file,
            replacement,
            original,
            opened_metadata,
            directory,
            parent_identity,
            barrier="complete-selector-after-replace",
            label="complete release selector",
            admit=admit_published_selector,
        )
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def read_selector(
    env_file: pathlib.Path, name: str, inherited_lock: int | None = None
) -> str:
    directory, parent_identity = _open_protected_parent(
        env_file,
        label="production env",
    )
    lock_descriptor = _transition_lock(
        env_file,
        inherited_lock,
        directory,
        parent_identity,
    )
    try:
        content, _ = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="production env",
            recover_interrupted_link=False,
        )
        try:
            decoded = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PinError("production env is not valid UTF-8") from error
        _, values = _parse_current_or_six_selector(decoded)
        if name not in values:
            raise PinError(
                "production env has not bootstrapped the requested writer snapshot selector"
            )
        return values[name][1]
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def _add_transition_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--env-file", required=True, type=pathlib.Path)
    parser.add_argument("--expected-runtime-image", required=True)
    parser.add_argument("--target-runtime-image", required=True)
    parser.add_argument("--expected-console-image", required=True)
    parser.add_argument("--target-console-image", required=True)
    parser.add_argument("--expected-override-manifest", required=True)
    parser.add_argument("--target-override-manifest", required=True)
    parser.add_argument("--expected-override-manifest-sha256", required=True)
    parser.add_argument("--target-override-manifest-sha256", required=True)
    parser.add_argument("--expected-rollback-baseline", required=True)
    parser.add_argument("--target-rollback-baseline", required=True)
    parser.add_argument("--expected-rollback-baseline-sha256", required=True)
    parser.add_argument("--target-rollback-baseline-sha256", required=True)
    parser.add_argument("--expected-writer-snapshot", required=True)
    parser.add_argument("--target-writer-snapshot", required=True)
    parser.add_argument("--expected-writer-snapshot-sha256", required=True)
    parser.add_argument("--target-writer-snapshot-sha256", required=True)
    parser.add_argument("--baseline-forward-release-commit", required=True)
    parser.add_argument("--baseline-forward-runtime-image", required=True)
    parser.add_argument("--baseline-forward-runtime-source-digest", required=True)
    parser.add_argument("--lock-fd", type=int)
    parser.add_argument("--isolated-evidence-root", type=pathlib.Path)


def locked_exec(env_file: pathlib.Path, command: list[str]) -> int:
    if not command or not command[0]:
        raise PinError("locked transition command is absent")
    directory, parent_identity = _open_protected_parent(
        env_file,
        label="production env",
    )
    lock_descriptor = _transition_lock(
        env_file,
        None,
        directory,
        parent_identity,
    )
    try:
        _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="production env",
            recover_interrupted_link=False,
        )
        token = secrets.token_hex(32)
        os.ftruncate(lock_descriptor, 0)
        payload = f"{token}\n".encode("ascii")
        if os.pwrite(lock_descriptor, payload, 0) != len(payload):
            raise PinError("production release lock capability could not be recorded")
        os.fsync(lock_descriptor)
        environment = os.environ.copy()
        environment["CAUCE_RELEASE_TRANSITION_LOCK_FD"] = str(lock_descriptor)
        environment["CAUCE_RELEASE_TRANSITION_LOCK_TOKEN"] = token
        completed = subprocess.run(
            command,
            check=False,
            env=environment,
            pass_fds=(lock_descriptor,),
        )
        return completed.returncode
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def manifest_digest_under_lock(
    env_file: pathlib.Path,
    manifest: pathlib.Path,
    *,
    expected_sha256: str | None,
    require_selected: bool,
    inherited_lock: int | None,
) -> str:
    """Authenticate manifest bytes while holding the production selector lock."""
    directory, parent_identity = _open_protected_parent(
        env_file,
        label="production env",
    )
    lock_descriptor = _transition_lock(
        env_file,
        inherited_lock,
        directory,
        parent_identity,
    )
    try:
        content, metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="production env",
            recover_interrupted_link=False,
        )
        try:
            decoded = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PinError("production env is not valid UTF-8") from error
        _, values = _parse_current_or_six_selector(decoded)
        if require_selected:
            if values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1] != os.fspath(manifest):
                raise PinError(
                    "manifest path is not the selected production override manifest"
                )
            selected_sha256 = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1]
            if DIGEST.fullmatch(selected_sha256) is None:
                raise PinError(
                    "selected production override manifest SHA-256 is invalid"
                )
            if expected_sha256 is not None and expected_sha256 != selected_sha256:
                raise PinError(
                    "expected manifest SHA-256 differs from the selected production selector"
                )
            expected_sha256 = selected_sha256
        current = os.stat(
            env_file.name,
            dir_fd=directory,
            follow_symlinks=False,
        )
        if _metadata_signature(metadata) != _metadata_signature(current):
            raise PinError("production env changed during manifest admission")
        observed = _manifest_digest(os.fspath(manifest), label="override manifest")
        if expected_sha256 is not None:
            if DIGEST.fullmatch(expected_sha256) is None:
                raise PinError("override manifest SHA-256 is invalid")
            if observed != expected_sha256:
                raise PinError("override manifest differs from its authorized SHA-256")
        return observed
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def _fault_injection(point: str) -> None:
    """Crash only when an explicit test-only fault point is requested."""
    if os.environ.get("CAUCE_PIN_TEST_FAULT") == point:
        os._exit(86)


def _test_barrier(point: str) -> None:
    """Coordinate a deterministic race in tests without weakening production admission."""
    if os.environ.get("CAUCE_PIN_TEST_BARRIER") != point:
        return
    ready_text = os.environ.get("CAUCE_PIN_TEST_BARRIER_READY", "")
    release_text = os.environ.get("CAUCE_PIN_TEST_BARRIER_RELEASE", "")
    ready = pathlib.Path(ready_text)
    release = pathlib.Path(release_text)
    if not ready.is_absolute() or not release.is_absolute():
        raise PinError("test barrier paths are invalid")
    descriptor = os.open(
        ready,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
        0o600,
    )
    try:
        os.write(descriptor, b"ready\n")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    for _attempt in range(3000):
        if release.exists():
            return
        # This capability is reachable only through an explicit test environment.
        import time

        time.sleep(0.01)
    raise PinError("test barrier timed out")


def _bootstrap_temporary_prefix(path: pathlib.Path) -> str:
    return f".{path.name}.release-bootstrap-"


def _clean_orphan_bootstrap_temporaries(
    path: pathlib.Path,
    directory: int,
    parent_identity: tuple[int, ...],
    *,
    label: str,
) -> None:
    """Remove only reserved, fully authenticated temporaries from an interrupted publication."""
    _revalidate_parent(path, directory, parent_identity, label=label)
    prefix = _bootstrap_temporary_prefix(path)
    changed = False
    for name in os.listdir(directory):
        if not name.startswith(prefix):
            continue
        try:
            metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except OSError as error:
            raise PinError(
                f"{label} interrupted temporary cannot be authenticated"
            ) from error
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}
        ):
            raise PinError(f"{label} interrupted temporary is unsafe")
        os.unlink(name, dir_fd=directory)
        changed = True
    if changed:
        os.fsync(directory)
    _revalidate_parent(path, directory, parent_identity, label=label)


def _read_private_name(
    path: pathlib.Path,
    directory: int,
    parent_identity: tuple[int, ...],
    *,
    label: str,
    recover_interrupted_link: bool,
    require_named_parent: bool = True,
    after_read: Callable[[], None] | None = None,
) -> tuple[bytes, os.stat_result]:
    """Read one private name relative to its authenticated parent and recover a link crash."""
    if require_named_parent:
        _revalidate_parent(path, directory, parent_identity, label=label)
    try:
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
    except OSError as error:
        raise PinError(f"{label} is missing or unreadable") from error
    if (
        not stat.S_ISREG(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or stat.S_IMODE(named.st_mode) != 0o600
        or named.st_uid not in {0, os.geteuid()}
    ):
        raise PinError(f"{label} must be an owned mode-0600 regular file")
    if named.st_nlink != 1:
        if not recover_interrupted_link:
            raise PinError(f"{label} must have exactly one hard link")
        aliases: list[str] = []
        prefix = _bootstrap_temporary_prefix(path)
        for name in os.listdir(directory):
            try:
                candidate = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except OSError as error:
                raise PinError(f"{label} hard-link inventory changed") from error
            if (candidate.st_dev, candidate.st_ino) == (named.st_dev, named.st_ino):
                aliases.append(name)
        if (
            path.name not in aliases
            or len(aliases) != named.st_nlink
            or any(
                name != path.name and not name.startswith(prefix) for name in aliases
            )
        ):
            raise PinError(f"{label} has an unauthenticated hard-link alias")
        for name in aliases:
            if name != path.name:
                os.unlink(name, dir_fd=directory)
        os.fsync(directory)
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if named.st_nlink != 1:
            raise PinError(f"{label} interrupted publication could not be recovered")

    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path.name, flags, dir_fd=directory)
    except OSError as error:
        raise PinError(f"{label} cannot be opened safely") from error
    try:
        before = os.fstat(descriptor)
        if _metadata_signature(before) != _metadata_signature(named):
            raise PinError(f"{label} changed before it was opened")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if _metadata_signature(after) != _metadata_signature(before):
            raise PinError(f"{label} changed while it was read")
    finally:
        os.close(descriptor)
    if after_read is not None:
        after_read()
    if require_named_parent:
        _revalidate_parent(path, directory, parent_identity, label=label)
    current = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
    if _metadata_signature(current) != _metadata_signature(named):
        raise PinError(f"{label} changed after it was read")
    return b"".join(chunks), named


def _publish_absent_at(
    path: pathlib.Path,
    content: bytes,
    metadata: os.stat_result,
    directory: int,
    parent_identity: tuple[int, ...],
    *,
    label: str,
) -> None:
    """Publish create-only through one authenticated directory descriptor."""
    _revalidate_parent(path, directory, parent_identity, label=label)
    _clean_orphan_bootstrap_temporaries(
        path,
        directory,
        parent_identity,
        label=label,
    )
    temporary = (
        f"{_bootstrap_temporary_prefix(path)}{os.getpid()}-{secrets.token_hex(8)}"
    )
    descriptor = -1
    linked = False
    published = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, flags, 0o600, dir_fd=directory)
        os.fchmod(descriptor, 0o600)
        try:
            os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        except PermissionError as error:
            if (metadata.st_uid, metadata.st_gid) != (os.geteuid(), os.getegid()):
                raise PinError(f"{label} ownership could not be preserved") from error
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise PinError(f"{label} write made no progress")
            view = view[written:]
        os.fsync(descriptor)
        _fault_injection("publish-after-file-fsync")
        _revalidate_parent(path, directory, parent_identity, label=label)
        try:
            os.link(
                temporary,
                path.name,
                src_dir_fd=directory,
                dst_dir_fd=directory,
                follow_symlinks=False,
            )
        except FileExistsError as error:
            raise PinError(f"{label} already exists") from error
        linked = True
        _fault_injection("publish-after-link")
        os.unlink(temporary, dir_fd=directory)
        _fault_injection("publish-after-unlink")
        os.fsync(directory)
        _fault_injection("publish-after-directory-fsync")
        _revalidate_parent(path, directory, parent_identity, label=label)
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        opened = os.fstat(descriptor)
        if (
            (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino)
            or named.st_nlink != 1
            or stat.S_IMODE(named.st_mode) != 0o600
        ):
            raise PinError(f"{label} publication identity is invalid")
        published = True
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if not published:
            if linked:
                try:
                    os.unlink(path.name, dir_fd=directory)
                except FileNotFoundError:
                    pass
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.fsync(directory)


def _publish_absent(
    path: pathlib.Path, content: bytes, metadata: os.stat_result
) -> None:
    directory, parent_identity = _open_protected_parent(
        path,
        label="bootstrap production env",
    )
    try:
        _publish_absent_at(
            path,
            content,
            metadata,
            directory,
            parent_identity,
            label="bootstrap production env",
        )
    finally:
        os.close(directory)


def bootstrap_legacy_env(
    env_file: pathlib.Path,
    candidate_env: pathlib.Path,
    *,
    expected_candidate_sha256: str,
    expected_manifest_sha256: str,
) -> None:
    """Publish the first complete production selector atomically under its normal lock.

    This is intentionally create-only. An existing selector must use compare-and-swap; legacy
    bootstrap can never become a last-writer-wins overwrite escape hatch.
    """
    if DIGEST.fullmatch(expected_candidate_sha256) is None:
        raise PinError("bootstrap candidate env SHA-256 is invalid")
    candidate_metadata = _validate_private_file(
        candidate_env, label="bootstrap candidate env"
    )
    candidate_content, opened = _read_exact(candidate_env)
    if _metadata_signature(candidate_metadata) != _metadata_signature(opened):
        raise PinError("bootstrap candidate env changed before it was read")
    observed_candidate_sha256 = (
        f"sha256:{hashlib.sha256(candidate_content).hexdigest()}"
    )
    if observed_candidate_sha256 != expected_candidate_sha256:
        raise PinError("bootstrap candidate env differs from its authorized SHA-256")
    try:
        decoded = candidate_content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PinError("bootstrap candidate env is not valid UTF-8") from error
    _validate_canonical_compose_controls(decoded)
    _, values = _parse(decoded)
    runtime = values["CAUCE_RUNTIME_IMAGE"][1]
    console = values["CAUCE_CONSOLE_IMAGE"][1]
    manifest = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1]
    manifest_sha256 = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1]
    baseline = values["CAUCE_ROLLBACK_BASELINE_FILE"][1]
    baseline_sha256 = values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]
    writer_snapshot = values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][1]
    writer_snapshot_sha256 = values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"][1]
    if IMAGE_REF.fullmatch(runtime) is None or IMAGE_REF.fullmatch(console) is None:
        raise PinError(
            "bootstrap image selectors must be immutable repository @sha256 references"
        )
    if manifest_sha256 != expected_manifest_sha256:
        raise PinError("bootstrap manifest SHA-256 differs from its candidate selector")
    _validate_manifest_digest(
        manifest, manifest_sha256, label="bootstrap override manifest"
    )
    _validate_manifest(baseline, label="bootstrap rollback baseline")
    if DIGEST.fullmatch(baseline_sha256) is None:
        raise PinError("bootstrap rollback baseline SHA-256 is invalid")
    _validate_manifest_digest(
        writer_snapshot,
        writer_snapshot_sha256,
        label="bootstrap rollback writer snapshot",
    )

    directory, parent_identity = _open_protected_parent(
        env_file,
        label="bootstrap production env",
    )
    lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
    lock_descriptor = _open_lock(lock_path, directory, parent_identity)
    try:
        try:
            os.stat(env_file.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise PinError("bootstrap production env already exists")
        refreshed, refreshed_metadata = _read_exact(candidate_env)
        if refreshed != candidate_content or _metadata_signature(
            refreshed_metadata
        ) != _metadata_signature(opened):
            raise PinError("bootstrap candidate env changed under the transition lock")
        _validate_manifest_digest(
            manifest, expected_manifest_sha256, label="bootstrap override manifest"
        )
        _validate_manifest_digest(
            writer_snapshot,
            writer_snapshot_sha256,
            label="bootstrap rollback writer snapshot",
        )
        try:
            subprocess.run(
                [
                    sys.executable,
                    os.fspath(pathlib.Path(__file__).with_name("rollback-baseline.py")),
                    "check",
                    "--baseline",
                    baseline,
                    "--expected-baseline-sha256",
                    baseline_sha256,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PinError(
                "bootstrap rollback baseline did not pass fail-closed validation"
            ) from error
        _validate_manifest_digest(
            manifest, expected_manifest_sha256, label="bootstrap override manifest"
        )
        _validate_manifest_digest(
            writer_snapshot,
            writer_snapshot_sha256,
            label="bootstrap rollback writer snapshot",
        )
        _publish_absent_at(
            env_file,
            candidate_content,
            opened,
            directory,
            parent_identity,
            label="bootstrap production env",
        )
        published, published_metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="bootstrap production env",
            recover_interrupted_link=False,
        )
        if (
            published != candidate_content
            or stat.S_IMODE(published_metadata.st_mode) != 0o600
        ):
            raise PinError("bootstrap production env failed its atomic read-back")
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def _protected_absent_output(path: pathlib.Path, *, label: str) -> None:
    directory, parent_identity = _open_protected_parent(path, label=label)
    try:
        _revalidate_parent(path, directory, parent_identity, label=label)
        try:
            os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        except OSError as error:
            raise PinError(f"{label} cannot be admitted safely") from error
        raise PinError(f"{label} already exists")
    finally:
        os.close(directory)


def _assert_backup_path_is_separate(
    backup: pathlib.Path,
    *,
    env_file: pathlib.Path,
    env_directory: int,
    env_parent_identity: tuple[int, ...],
    override_manifest: pathlib.Path,
    rollback_baseline: pathlib.Path,
) -> None:
    """Keep the recovery copy outside every selector, lock, and selected artifact identity."""
    canonical_backup = _canonical_path(
        backup,
        label="two-selector production env backup",
        final_may_be_absent=True,
    )
    lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
    _revalidate_parent(
        env_file,
        env_directory,
        env_parent_identity,
        label="production env",
    )
    protected = (
        (env_file, "production env"),
        (lock_path, "production release lock"),
        (override_manifest, "override manifest"),
        (rollback_baseline, "rollback baseline"),
    )
    for path, label in protected:
        if path in {env_file, lock_path}:
            canonical = path
            if canonical_backup == canonical:
                raise PinError(f"two-selector production env backup aliases {label}")
            continue
        try:
            canonical = _canonical_path(
                path,
                label=label,
                final_may_be_absent=not path.exists(),
            )
        except PinError:
            # The artifact validators report a more specific error for existing
            # selectors.  A missing lock still has a canonical future name.
            if path != lock_path:
                raise
            canonical = path.parent.resolve(strict=True) / path.name
        if canonical_backup == canonical:
            raise PinError(f"two-selector production env backup aliases {label}")


def _assert_backup_inode_is_separate(
    backup_metadata: os.stat_result,
    *,
    env_file: pathlib.Path,
    env_directory: int,
    env_parent_identity: tuple[int, ...],
    override_manifest: pathlib.Path,
    rollback_baseline: pathlib.Path,
) -> None:
    """Reject hard-link and bind-mount aliases even when their path strings differ."""
    lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
    _revalidate_parent(
        env_file,
        env_directory,
        env_parent_identity,
        label="production env",
    )
    protected = (
        (env_file, "production env", True),
        (lock_path, "production release lock", True),
        (override_manifest, "override manifest", False),
        (rollback_baseline, "rollback baseline", False),
    )
    for path, label, relative in protected:
        try:
            metadata = (
                os.stat(path.name, dir_fd=env_directory, follow_symlinks=False)
                if relative
                else path.lstat()
            )
        except FileNotFoundError:
            continue
        except OSError as error:
            raise PinError(
                f"{label} identity cannot be compared to the backup"
            ) from error
        if (metadata.st_dev, metadata.st_ino) == (
            backup_metadata.st_dev,
            backup_metadata.st_ino,
        ):
            raise PinError(
                f"two-selector production env backup shares the {label} inode"
            )


def _backup_matches_or_is_absent(
    backup_env_file: pathlib.Path,
    original: bytes,
    *,
    directory: int,
    parent_identity: tuple[int, ...],
    env_file: pathlib.Path,
    env_directory: int,
    env_parent_identity: tuple[int, ...],
    override_manifest: pathlib.Path,
    rollback_baseline: pathlib.Path,
) -> bool:
    """Admit a durable prior backup or an authenticated unused destination."""
    label = "two-selector production env backup"
    _assert_backup_path_is_separate(
        backup_env_file,
        env_file=env_file,
        env_directory=env_directory,
        env_parent_identity=env_parent_identity,
        override_manifest=override_manifest,
        rollback_baseline=rollback_baseline,
    )
    _revalidate_parent(backup_env_file, directory, parent_identity, label=label)
    try:
        os.stat(backup_env_file.name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        _clean_orphan_bootstrap_temporaries(
            backup_env_file,
            directory,
            parent_identity,
            label=label,
        )
        return False
    except OSError as error:
        raise PinError(f"{label} cannot be admitted safely") from error
    backup, metadata = _read_private_name(
        backup_env_file,
        directory,
        parent_identity,
        label=label,
        recover_interrupted_link=True,
    )
    _assert_backup_inode_is_separate(
        metadata,
        env_file=env_file,
        env_directory=env_directory,
        env_parent_identity=env_parent_identity,
        override_manifest=override_manifest,
        rollback_baseline=rollback_baseline,
    )
    if backup != original:
        raise PinError(
            "two-selector production env backup differs from the authorized input"
        )
    return True


def _docker_output(arguments: list[str], *, label: str) -> str:
    """Run a bounded, value-minimal Docker query against the canonical local daemon."""
    try:
        result = subprocess.run(
            ["docker", "--host", "unix:///var/run/docker.sock", *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise PinError(f"two-selector live image proof failed at {label}") from error
    if "\x00" in result.stdout or "\r" in result.stdout:
        raise PinError(f"two-selector live image proof returned invalid {label}")
    return result.stdout


def _local_image_id(reference: str, cache: dict[str, str]) -> str:
    if reference in cache:
        return cache[reference]
    output = _docker_output(
        ["image", "inspect", "--format", "{{.Id}}\t{{json .RepoDigests}}", reference],
        label="image identity",
    ).strip("\n")
    fields = output.split("\t")
    if len(fields) != 2 or DIGEST.fullmatch(fields[0]) is None:
        raise PinError(
            "two-selector live image proof returned an invalid image identity"
        )
    try:
        repository_digests = json.loads(fields[1])
    except json.JSONDecodeError as error:
        raise PinError(
            "two-selector live image proof returned invalid repository metadata"
        ) from error
    if not isinstance(repository_digests, list) or any(
        not isinstance(item, str) for item in repository_digests
    ):
        raise PinError(
            "two-selector live image proof returned invalid repository metadata"
        )
    if (
        IMAGE_REF.fullmatch(reference) is not None
        and reference not in repository_digests
    ):
        raise PinError(
            "two-selector target is not locally bound to its repository digest"
        )
    cache[reference] = fields[0]
    return fields[0]


def _validate_live_image_normalization(
    *,
    legacy_runtime: str,
    legacy_console: str,
    runtime_image: str,
    console_image: str,
) -> None:
    """Prove that 2->6 only names the exact images already selected and running."""
    if (
        LEGACY_IMAGE_REF.fullmatch(legacy_runtime) is None
        or LEGACY_IMAGE_REF.fullmatch(legacy_console) is None
        or "@" in legacy_runtime
        or "@" in legacy_console
        or legacy_runtime == legacy_console
    ):
        raise PinError(
            "two-selector input must contain two distinct mutable image tags"
        )
    cache: dict[str, str] = {}
    runtime_id = _local_image_id(runtime_image, cache)
    console_id = _local_image_id(console_image, cache)
    if runtime_id == console_id:
        raise PinError("two-selector runtime and console resolve to the same image ID")
    if _local_image_id(legacy_runtime, cache) != runtime_id:
        raise PinError(
            "two-selector runtime tag differs from its target repository digest"
        )
    if _local_image_id(legacy_console, cache) != console_id:
        raise PinError(
            "two-selector console tag differs from its target repository digest"
        )

    raw_ids = _docker_output(
        [
            "container",
            "ls",
            "--filter",
            "label=com.docker.compose.project=cauce-v3-prod",
            "--format",
            "{{.ID}}",
        ],
        label="running container inventory",
    )
    container_ids = [line for line in raw_ids.splitlines() if line]
    if (
        not container_ids
        or len(container_ids) != len(set(container_ids))
        or any(CONTAINER_ID.fullmatch(item) is None for item in container_ids)
    ):
        raise PinError(
            "two-selector live image proof has an invalid running container inventory"
        )

    saw_runtime = False
    saw_console = False
    for container_id in container_ids:
        output = _docker_output(
            [
                "container",
                "inspect",
                "--format",
                (
                    "{{.Id}}\t{{.Image}}\t{{.Config.Image}}\t"
                    '{{index .Config.Labels "com.docker.compose.project"}}\t'
                    '{{index .Config.Labels "com.docker.compose.service"}}\t'
                    '{{index .Config.Labels "com.docker.compose.config-hash"}}\t'
                    "{{.State.Status}}"
                ),
                container_id,
            ],
            label="running container identity",
        ).strip("\n")
        fields = output.split("\t")
        if (
            len(fields) != 7
            or CONTAINER_ID.fullmatch(fields[0]) is None
            or not fields[0].startswith(container_id)
            or DIGEST.fullmatch(fields[1]) is None
            or fields[3] != "cauce-v3-prod"
            or COMPOSE_SERVICE.fullmatch(fields[4]) is None
            or re.fullmatch(r"[a-f0-9]{64}", fields[5]) is None
            or fields[6] != "running"
        ):
            raise PinError(
                "two-selector live image proof contains an invalid container record"
            )
        configured = fields[2]
        if configured in {legacy_runtime, runtime_image}:
            expected_id = runtime_id
            saw_runtime = True
        elif configured in {legacy_console, console_image}:
            expected_id = console_id
            saw_console = True
        elif IMAGE_REF.fullmatch(configured) is not None:
            expected_id = _local_image_id(configured, cache)
        else:
            raise PinError(
                "two-selector live project contains an unauthenticated mutable image"
            )
        if fields[1] != expected_id:
            raise PinError(
                "two-selector running container differs from its authenticated image"
            )
    if not saw_runtime or not saw_console:
        raise PinError(
            "two-selector live project does not exercise both legacy image selectors"
        )


def _image_identity(reference: str, *, label: str) -> tuple[str, list[str]]:
    output = _docker_output(
        ["image", "inspect", "--format", "{{.Id}}\t{{json .RepoDigests}}", reference],
        label=label,
    ).strip("\n")
    fields = output.split("\t")
    if len(fields) != 2 or DIGEST.fullmatch(fields[0]) is None:
        raise PinError(f"legacy fleet {label} returned an invalid image identity")
    try:
        raw_digests = json.loads(fields[1])
    except json.JSONDecodeError as error:
        raise PinError(f"legacy fleet {label} returned invalid repository metadata") from error
    if not isinstance(raw_digests, list) or any(not isinstance(item, str) for item in raw_digests):
        raise PinError(f"legacy fleet {label} returned invalid repository metadata")
    digests = sorted(set(item for item in raw_digests if IMAGE_REF.fullmatch(item)))
    if not digests:
        raise PinError(f"legacy fleet {label} has no recoverable repository digest")
    return fields[0], digests


def _legacy_selector_content(
    content: bytes,
    *,
    expected_sha256: str,
) -> tuple[str, str]:
    if f"sha256:{hashlib.sha256(content).hexdigest()}" != expected_sha256:
        raise PinError("legacy production env differs from its authorized SHA-256")
    try:
        decoded = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PinError("legacy production env is not valid UTF-8") from error
    _validate_canonical_compose_controls(decoded)
    present = {
        raw.split("=", 1)[0]
        for raw in decoded.splitlines()
        if raw and not raw.startswith("#") and "=" in raw
    }
    if present & set(KEYS) != set(KEYS[:2]):
        raise PinError("production env is not an exact two-selector legacy input")
    _lines, values = _parse(decoded, KEYS[:2])
    runtime = values["CAUCE_RUNTIME_IMAGE"][1]
    console = values["CAUCE_CONSOLE_IMAGE"][1]
    allowed = lambda value: (
        LEGACY_IMAGE_REF.fullmatch(value) is not None
        or LEGACY_BARE_DIGEST_REF.fullmatch(value) is not None
    )
    if not allowed(runtime) or not allowed(console) or runtime == console:
        raise PinError("legacy production image selectors are invalid or identical")
    return runtime, console


def _legacy_fleet_content(
    legacy_content: bytes,
    *,
    expected_env_sha256: str,
    runtime_image: str,
    console_image: str,
    override_manifest: str,
    override_manifest_sha256: str,
) -> bytes:
    """Capture the real pre-migration mosaic without claiming it is canonical."""
    if IMAGE_REF.fullmatch(runtime_image) is None or IMAGE_REF.fullmatch(console_image) is None:
        raise PinError("legacy normalized images must be immutable repository digests")
    if DIGEST.fullmatch(override_manifest_sha256) is None:
        raise PinError("legacy override manifest SHA-256 is invalid")
    _validate_manifest_digest(
        override_manifest,
        override_manifest_sha256,
        label="legacy override manifest",
    )
    legacy_runtime, legacy_console = _legacy_selector_content(
        legacy_content,
        expected_sha256=expected_env_sha256,
    )
    runtime_id, runtime_digests = _image_identity(runtime_image, label="runtime normalization")
    console_id, console_digests = _image_identity(console_image, label="console normalization")
    if runtime_image not in runtime_digests or console_image not in console_digests \
            or runtime_id == console_id:
        raise PinError("legacy normalized selectors are not locally bound to distinct images")
    selected_runtime_id, _ = _image_identity(legacy_runtime, label="runtime selector")
    selected_console_id, _ = _image_identity(legacy_console, label="console selector")
    if selected_runtime_id != runtime_id or selected_console_id != console_id:
        raise PinError("legacy selector images differ from their normalized repository digests")

    raw_ids = _docker_output(
        [
            "container", "ls", "-a", "--filter",
            "label=com.docker.compose.project=cauce-v3-prod", "--format", "{{.ID}}",
        ],
        label="materialized container inventory",
    )
    container_ids = [line for line in raw_ids.splitlines() if line]
    if not container_ids or len(container_ids) != len(set(container_ids)) \
            or any(CONTAINER_ID.fullmatch(item) is None for item in container_ids):
        raise PinError("legacy fleet has an invalid materialized container inventory")
    services: list[dict[str, object]] = []
    seen_services: set[str] = set()
    saw_runtime = False
    saw_console = False
    saw_migrator = False
    for short_id in container_ids:
        output = _docker_output(
            [
                "container", "inspect", "--format",
                (
                    "{{.Id}}\t{{.Image}}\t{{.Config.Image}}\t"
                    '{{index .Config.Labels "com.docker.compose.project"}}\t'
                    '{{index .Config.Labels "com.docker.compose.service"}}\t'
                    '{{index .Config.Labels "com.docker.compose.config-hash"}}\t'
                    "{{.State.Status}}\t{{.State.ExitCode}}"
                ),
                short_id,
            ],
            label="materialized container identity",
        ).strip("\n")
        fields = output.split("\t")
        if len(fields) != 8:
            raise PinError("legacy fleet contains a malformed container record")
        full_id, image_id, configured, project, service, config_hash, status, exit_code = fields
        if CONTAINER_ID.fullmatch(full_id) is None or not full_id.startswith(short_id) \
                or DIGEST.fullmatch(image_id) is None or project != "cauce-v3-prod" \
                or COMPOSE_SERVICE.fullmatch(service) is None or service in seen_services \
                or re.fullmatch(r"[a-f0-9]{64}", config_hash) is None \
                or re.fullmatch(r"-?[0-9]+", exit_code) is None \
                or any(character in configured for character in "\t\r\n"):
            raise PinError("legacy fleet contains an invalid container identity/config record")
        seen_services.add(service)
        if service == "migrator":
            saw_migrator = True
            if status != "exited" or exit_code != "0":
                raise PinError("legacy fleet migrator must be materialized exited/0")
        elif status != "running" or exit_code != "0":
            raise PinError("legacy fleet long-lived containers must all be running")
        observed_id, repository_digests = _image_identity(
            configured,
            label=f"service {service} image",
        )
        if observed_id != image_id:
            raise PinError("legacy fleet container image differs from Config.Image")
        if configured == runtime_image or image_id == runtime_id:
            repository_digest = runtime_image
            saw_runtime = True
        elif configured == console_image or image_id == console_id:
            repository_digest = console_image
            saw_console = True
        elif IMAGE_REF.fullmatch(configured) is not None and configured in repository_digests:
            repository_digest = configured
        elif len(repository_digests) == 1:
            repository_digest = repository_digests[0]
        else:
            raise PinError("legacy mutable Config.Image is ambiguous across repository digests")
        services.append({
            "configHash": config_hash,
            "configImage": configured,
            "containerId": full_id,
            "exitCode": int(exit_code),
            "imageId": image_id,
            "repositoryDigest": repository_digest,
            "service": service,
            "status": status,
        })
    if not saw_runtime or not saw_console or not saw_migrator:
        raise PinError("legacy fleet omits runtime, console, or the materialized migrator")
    report = {
        "kind": "cauce-v3-legacy-pre-migration-fleet",
        "project": "cauce-v3-prod",
        "schemaVersion": 1,
        "selectors": {
            "console": legacy_console,
            "manifest": override_manifest,
            "manifestSha256": override_manifest_sha256,
            "normalizedConsole": console_image,
            "normalizedRuntime": runtime_image,
            "runtime": legacy_runtime,
        },
        "services": sorted(services, key=lambda item: str(item["service"])),
    }
    _validate_manifest_digest(
        override_manifest,
        override_manifest_sha256,
        label="legacy override manifest",
    )
    return (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def capture_legacy_fleet(
    env_file: pathlib.Path,
    *,
    expected_env_sha256: str,
    runtime_image: str,
    console_image: str,
    override_manifest: str,
    override_manifest_sha256: str,
    output: pathlib.Path,
    backup_env_file: pathlib.Path | None,
    inherited_lock: int | None,
) -> str:
    if DIGEST.fullmatch(expected_env_sha256) is None:
        raise PinError("legacy production env SHA-256 is invalid")
    env_directory, env_parent_identity = _open_protected_parent(
        env_file, label="legacy production env"
    )
    output_directory, output_parent_identity = _open_protected_parent(
        output, label="legacy fleet snapshot"
    )
    lock_descriptor = _transition_lock(
        env_file, inherited_lock, env_directory, env_parent_identity
    )
    try:
        current, current_metadata = _read_private_name(
            env_file,
            env_directory,
            env_parent_identity,
            label="legacy production env",
            recover_interrupted_link=False,
        )
        if f"sha256:{hashlib.sha256(current).hexdigest()}" == expected_env_sha256:
            legacy_content = current
        elif backup_env_file is not None:
            _validate_private_file(backup_env_file, label="legacy selector backup")
            legacy_content, _ = _read_exact(backup_env_file)
            _legacy_selector_content(legacy_content, expected_sha256=expected_env_sha256)
        else:
            raise PinError("legacy production env differs from its authorized SHA-256")
        content = _legacy_fleet_content(
            legacy_content,
            expected_env_sha256=expected_env_sha256,
            runtime_image=runtime_image,
            console_image=console_image,
            override_manifest=override_manifest,
            override_manifest_sha256=override_manifest_sha256,
        )
        try:
            existing, _ = _read_private_name(
                output,
                output_directory,
                output_parent_identity,
                label="legacy fleet snapshot",
                recover_interrupted_link=True,
            )
        except PinError as error:
            if "missing or unreadable" not in str(error):
                raise
            _publish_absent_at(
                output,
                content,
                current_metadata,
                output_directory,
                output_parent_identity,
                label="legacy fleet snapshot",
            )
            existing, _ = _read_private_name(
                output,
                output_directory,
                output_parent_identity,
                label="legacy fleet snapshot",
                recover_interrupted_link=True,
            )
        if existing != content:
            raise PinError("existing legacy fleet snapshot differs from the retry capture")
        return f"sha256:{hashlib.sha256(content).hexdigest()}"
    finally:
        os.close(lock_descriptor)
        os.close(output_directory)
        os.close(env_directory)


def restore_production_legacy(
    env_file: pathlib.Path,
    *,
    expected_env_sha256: str,
    runtime_image: str,
    console_image: str,
    override_manifest: str,
    override_manifest_sha256: str,
    rollback_baseline: str,
    rollback_baseline_sha256: str,
    backup_env_file: pathlib.Path,
    writer_snapshot: str,
    writer_snapshot_sha256: str,
    inherited_lock: int | None,
) -> None:
    """Compensate only the exact 2->6/8 one-time bootstrap replacement."""
    directory, parent_identity = _open_protected_parent(
        env_file, label="legacy production env compensation"
    )
    lock_descriptor = _transition_lock(
        env_file, inherited_lock, directory, parent_identity
    )
    try:
        original, _ = _read_exact(backup_env_file)
        _legacy_selector_content(original, expected_sha256=expected_env_sha256)
        current, current_metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="legacy production env compensation",
            recover_interrupted_link=False,
        )
        if current == original:
            return
        try:
            current_text = current.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PinError("legacy compensation current selector is not UTF-8") from error
        _lines, values = _parse_current_or_six_selector(current_text)
        expected = {
            "CAUCE_RUNTIME_IMAGE": runtime_image,
            "CAUCE_CONSOLE_IMAGE": console_image,
            "CAUCE_COMPOSE_OVERRIDE_MANIFEST": override_manifest,
            "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256": override_manifest_sha256,
            "CAUCE_ROLLBACK_BASELINE_FILE": rollback_baseline,
            "CAUCE_ROLLBACK_BASELINE_SHA256": rollback_baseline_sha256,
        }
        if any(values[key][1] != value for key, value in expected.items()):
            raise PinError("legacy compensation selector is not the exact bootstrap state")
        writer_present = "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE" in values
        if writer_present and (
            values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][1] != writer_snapshot
            or values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"][1]
            != writer_snapshot_sha256
        ):
            raise PinError("legacy compensation writer snapshot is not the exact bootstrap state")

        def admit_original() -> None:
            restored, restored_metadata = _read_private_name(
                env_file,
                directory,
                parent_identity,
                label="legacy production env compensation",
                recover_interrupted_link=False,
            )
            if restored != original or stat.S_IMODE(restored_metadata.st_mode) != 0o600:
                raise PinError("legacy compensation failed its exact read-back")
            _legacy_selector_content(restored, expected_sha256=expected_env_sha256)

        _replace_with_compensating_admission(
            env_file,
            original,
            current,
            current_metadata,
            directory,
            parent_identity,
            barrier="legacy-compensation-after-replace",
            label="legacy production selector compensation",
            admit=admit_original,
        )
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def bootstrap_two_selector_env(
    env_file: pathlib.Path,
    *,
    expected_env_sha256: str,
    runtime_image: str,
    console_image: str,
    override_manifest: str,
    override_manifest_sha256: str,
    rollback_baseline: str,
    rollback_baseline_sha256: str,
    backup_env_file: pathlib.Path,
    legacy_fleet_snapshot: str | None = None,
    legacy_fleet_snapshot_sha256: str | None = None,
    inherited_lock: int | None = None,
) -> None:
    """Upgrade one authenticated two-selector legacy env to the six-selector contract.

    The live host predates release manifests and rollback baselines.  Its unrelated bytes remain
    byte-identical; the two mutable image selectors are replaced only by RepoDigests resolving to
    the exact same live image IDs, and the four content-addressed selectors are inserted atomically
    under the normal transition lock.  A create-only private copy of the exact input is published
    before the replace.
    """
    if DIGEST.fullmatch(expected_env_sha256) is None:
        raise PinError("two-selector production env SHA-256 is invalid")
    if (
        IMAGE_REF.fullmatch(runtime_image) is None
        or IMAGE_REF.fullmatch(console_image) is None
    ):
        raise PinError(
            "two-selector bootstrap images must be immutable repository @sha256 references"
        )
    if DIGEST.fullmatch(override_manifest_sha256) is None:
        raise PinError("two-selector override manifest SHA-256 is invalid")
    if DIGEST.fullmatch(rollback_baseline_sha256) is None:
        raise PinError("two-selector rollback baseline SHA-256 is invalid")
    manifest_path = pathlib.Path(override_manifest)
    baseline_path = pathlib.Path(rollback_baseline)
    production_legacy = legacy_fleet_snapshot is not None
    if production_legacy != (legacy_fleet_snapshot_sha256 is not None):
        raise PinError("legacy fleet snapshot path and SHA-256 must be supplied together")
    if legacy_fleet_snapshot_sha256 is not None \
            and DIGEST.fullmatch(legacy_fleet_snapshot_sha256) is None:
        raise PinError("legacy fleet snapshot SHA-256 is invalid")

    def prepare_original(content: bytes) -> tuple[bytes, str, str]:
        if f"sha256:{hashlib.sha256(content).hexdigest()}" != expected_env_sha256:
            raise PinError(
                "two-selector production env differs from its authorized SHA-256"
            )
        try:
            decoded = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PinError("two-selector production env is not valid UTF-8") from error
        _validate_canonical_compose_controls(decoded)
        present = {
            raw.split("=", 1)[0]
            for raw in decoded.splitlines()
            if raw and not raw.startswith("#") and "=" in raw
        }
        image_keys = set(KEYS[:2])
        if present & set(KEYS) != image_keys:
            raise PinError("production env is not an exact two-selector legacy input")
        lines, values = _parse(decoded, KEYS[:2])
        if values[KEYS[0]][0] >= values[KEYS[1]][0]:
            raise PinError(
                "two-selector production image selectors are not in canonical order"
            )
        legacy_runtime = values["CAUCE_RUNTIME_IMAGE"][1]
        legacy_console = values["CAUCE_CONSOLE_IMAGE"][1]
        if production_legacy:
            _legacy_selector_content(content, expected_sha256=expected_env_sha256)
        lines[values["CAUCE_RUNTIME_IMAGE"][0]] = (
            f"CAUCE_RUNTIME_IMAGE={runtime_image}\n"
        )
        lines[values["CAUCE_CONSOLE_IMAGE"][0]] = (
            f"CAUCE_CONSOLE_IMAGE={console_image}\n"
        )
        insertion = values["CAUCE_CONSOLE_IMAGE"][0] + 1
        lines[insertion:insertion] = [
            f"CAUCE_COMPOSE_OVERRIDE_MANIFEST={override_manifest}\n",
            f"CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256={override_manifest_sha256}\n",
            f"CAUCE_ROLLBACK_BASELINE_FILE={rollback_baseline}\n",
            f"CAUCE_ROLLBACK_BASELINE_SHA256={rollback_baseline_sha256}\n",
        ]
        return "".join(lines).encode("utf-8"), legacy_runtime, legacy_console

    def check_baseline() -> None:
        try:
            subprocess.run(
                [
                    sys.executable,
                    os.fspath(pathlib.Path(__file__).with_name("rollback-baseline.py")),
                    "check",
                    "--baseline",
                    rollback_baseline,
                    "--expected-baseline-sha256",
                    rollback_baseline_sha256,
                    "--expected-forward-runtime-image",
                    runtime_image,
                    "--expected-console-image",
                    console_image,
                    "--expected-override-manifest",
                    override_manifest,
                    *(
                        [
                            "--expected-baseline-kind",
                            "legacy-pre-migration",
                            "--expected-legacy-fleet-snapshot",
                            legacy_fleet_snapshot,
                            "--expected-legacy-fleet-snapshot-sha256",
                            legacy_fleet_snapshot_sha256,
                        ]
                        if production_legacy
                        else []
                    ),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PinError(
                "two-selector rollback baseline did not pass fail-closed validation"
            ) from error

    def admit_selected_inputs(legacy_runtime: str, legacy_console: str) -> None:
        # Re-admit both path-bound artifacts around the live Docker proof.  A
        # race after this check is detected by the identical post-replace pass
        # and compensates the selector while this process still owns the lock.
        _validate_manifest_digest(
            override_manifest,
            override_manifest_sha256,
            label="two-selector override manifest",
        )
        _validate_manifest_digest(
            rollback_baseline,
            rollback_baseline_sha256,
            label="two-selector rollback baseline",
        )
        check_baseline()
        if production_legacy:
            assert legacy_fleet_snapshot is not None
            assert legacy_fleet_snapshot_sha256 is not None
            _validate_manifest_digest(
                legacy_fleet_snapshot,
                legacy_fleet_snapshot_sha256,
                label="legacy fleet snapshot",
            )
            expected_snapshot = _legacy_fleet_content(
                original,
                expected_env_sha256=expected_env_sha256,
                runtime_image=runtime_image,
                console_image=console_image,
                override_manifest=override_manifest,
                override_manifest_sha256=override_manifest_sha256,
            )
            observed_snapshot, _ = _read_exact(pathlib.Path(legacy_fleet_snapshot))
            if observed_snapshot != expected_snapshot:
                raise PinError("legacy fleet changed after its authenticated snapshot")
        else:
            _validate_live_image_normalization(
                legacy_runtime=legacy_runtime,
                legacy_console=legacy_console,
                runtime_image=runtime_image,
                console_image=console_image,
            )
        _validate_manifest_digest(
            override_manifest,
            override_manifest_sha256,
            label="two-selector override manifest",
        )
        _validate_manifest_digest(
            rollback_baseline,
            rollback_baseline_sha256,
            label="two-selector rollback baseline",
        )

    env_directory, env_parent_identity = _open_protected_parent(
        env_file,
        label="two-selector production env",
    )
    backup_directory, backup_parent_identity = _open_protected_parent(
        backup_env_file,
        label="two-selector production env backup",
    )
    try:
        # Outside the selector lock only authenticate the name and held parent.
        # Recovery/cleanup of an interrupted hard-link publication must wait
        # until this process owns the lock, otherwise two bootstrap contenders
        # could unlink each other's in-flight temporary.
        _assert_backup_path_is_separate(
            backup_env_file,
            env_file=env_file,
            env_directory=env_directory,
            env_parent_identity=env_parent_identity,
            override_manifest=manifest_path,
            rollback_baseline=baseline_path,
        )
        _revalidate_parent(
            backup_env_file,
            backup_directory,
            backup_parent_identity,
            label="two-selector production env backup",
        )
        lock_descriptor = _transition_lock(
            env_file,
            inherited_lock,
            env_directory,
            env_parent_identity,
        )
        try:
            current, current_metadata = _read_private_name(
                env_file,
                env_directory,
                env_parent_identity,
                label="two-selector production env",
                recover_interrupted_link=False,
            )
            interrupted_replacement = False
            if f"sha256:{hashlib.sha256(current).hexdigest()}" == expected_env_sha256:
                original = current
                replacement, legacy_runtime, legacy_console = prepare_original(original)
            else:
                _assert_backup_path_is_separate(
                    backup_env_file,
                    env_file=env_file,
                    env_directory=env_directory,
                    env_parent_identity=env_parent_identity,
                    override_manifest=manifest_path,
                    rollback_baseline=baseline_path,
                )
                try:
                    original, backup_metadata = _read_private_name(
                        backup_env_file,
                        backup_directory,
                        backup_parent_identity,
                        label="two-selector production env backup",
                        recover_interrupted_link=True,
                    )
                except PinError as error:
                    raise PinError(
                        "two-selector production env differs from its authorized SHA-256"
                    ) from error
                _assert_backup_inode_is_separate(
                    backup_metadata,
                    env_file=env_file,
                    env_directory=env_directory,
                    env_parent_identity=env_parent_identity,
                    override_manifest=manifest_path,
                    rollback_baseline=baseline_path,
                )
                replacement, legacy_runtime, legacy_console = prepare_original(original)
                if current != replacement:
                    raise PinError(
                        "two-selector production env is neither the authorized input "
                        "nor its exact interrupted replacement"
                    )
                interrupted_replacement = True

            backup_exists = _backup_matches_or_is_absent(
                backup_env_file,
                original,
                directory=backup_directory,
                parent_identity=backup_parent_identity,
                env_file=env_file,
                env_directory=env_directory,
                env_parent_identity=env_parent_identity,
                override_manifest=manifest_path,
                rollback_baseline=baseline_path,
            )
            if not interrupted_replacement:
                admit_selected_inputs(legacy_runtime, legacy_console)
            if not backup_exists:
                _publish_absent_at(
                    backup_env_file,
                    original,
                    current_metadata,
                    backup_directory,
                    backup_parent_identity,
                    label="two-selector production env backup",
                )
            if not _backup_matches_or_is_absent(
                backup_env_file,
                original,
                directory=backup_directory,
                parent_identity=backup_parent_identity,
                env_file=env_file,
                env_directory=env_directory,
                env_parent_identity=env_parent_identity,
                override_manifest=manifest_path,
                rollback_baseline=baseline_path,
            ):
                raise PinError("two-selector production env backup was not published")

            def admit_published_selector() -> None:
                published, published_metadata = _read_private_name(
                    env_file,
                    env_directory,
                    env_parent_identity,
                    label="two-selector production env",
                    recover_interrupted_link=False,
                )
                try:
                    _, published_values = _parse(
                        published.decode("utf-8"),
                        SIX_SELECTOR_KEYS,
                    )
                except UnicodeDecodeError as error:
                    raise PinError(
                        "two-selector published env is not valid UTF-8"
                    ) from error
                if (
                    published != replacement
                    or stat.S_IMODE(published_metadata.st_mode) != 0o600
                    or published_values["CAUCE_RUNTIME_IMAGE"][1] != runtime_image
                    or published_values["CAUCE_CONSOLE_IMAGE"][1] != console_image
                    or published_values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1]
                    != override_manifest
                    or published_values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1]
                    != override_manifest_sha256
                    or published_values["CAUCE_ROLLBACK_BASELINE_FILE"][1]
                    != rollback_baseline
                    or published_values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]
                    != rollback_baseline_sha256
                ):
                    raise PinError("two-selector bootstrap failed its atomic read-back")
                if not _backup_matches_or_is_absent(
                    backup_env_file,
                    original,
                    directory=backup_directory,
                    parent_identity=backup_parent_identity,
                    env_file=env_file,
                    env_directory=env_directory,
                    env_parent_identity=env_parent_identity,
                    override_manifest=manifest_path,
                    rollback_baseline=baseline_path,
                ):
                    raise PinError(
                        "two-selector production env backup identity was lost"
                    )
                admit_selected_inputs(legacy_runtime, legacy_console)

            if interrupted_replacement:
                _admit_recovered_replacement_or_restore(
                    env_file,
                    replacement,
                    original,
                    current_metadata,
                    env_directory,
                    env_parent_identity,
                    label="two-selector bootstrap",
                    admit=admit_published_selector,
                )
            else:
                _replace_with_compensating_admission(
                    env_file,
                    replacement,
                    original,
                    current_metadata,
                    env_directory,
                    env_parent_identity,
                    barrier="two-selector-after-replace",
                    label="two-selector bootstrap",
                    admit=admit_published_selector,
                )
        finally:
            os.close(lock_descriptor)
    finally:
        os.close(backup_directory)
        os.close(env_directory)


def bootstrap_legacy_manifest_sha(
    env_file: pathlib.Path,
    *,
    expected_env_sha256: str,
    expected_manifest: str,
    expected_manifest_sha256: str,
) -> None:
    """Atomically upgrade one authenticated five-selector env to six selectors."""
    if DIGEST.fullmatch(expected_env_sha256) is None:
        raise PinError("legacy production env SHA-256 is invalid")
    if DIGEST.fullmatch(expected_manifest_sha256) is None:
        raise PinError("legacy override manifest SHA-256 is invalid")
    directory, parent_identity = _open_protected_parent(
        env_file,
        label="legacy production env",
    )
    original, opened = _read_private_name(
        env_file,
        directory,
        parent_identity,
        label="legacy production env",
        recover_interrupted_link=False,
    )
    try:
        decoded = original.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PinError("legacy production env is not valid UTF-8") from error
    _validate_canonical_compose_controls(decoded)
    if any(
        raw.split("=", 1)[0] == "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"
        for raw in decoded.splitlines()
        if "=" in raw
    ):
        raise PinError("legacy production env already has a manifest SHA-256 selector")
    if f"sha256:{hashlib.sha256(original).hexdigest()}" != expected_env_sha256:
        raise PinError("legacy production env differs from its authorized SHA-256")
    lines, values = _parse(decoded, LEGACY_KEYS)
    selected_manifest = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1]
    if selected_manifest != expected_manifest:
        raise PinError("legacy production env selected a different override manifest")
    if (
        IMAGE_REF.fullmatch(values["CAUCE_RUNTIME_IMAGE"][1]) is None
        or IMAGE_REF.fullmatch(values["CAUCE_CONSOLE_IMAGE"][1]) is None
    ):
        raise PinError("legacy production image selectors are not immutable")
    _validate_manifest_digest(
        selected_manifest, expected_manifest_sha256, label="legacy override manifest"
    )
    baseline = values["CAUCE_ROLLBACK_BASELINE_FILE"][1]
    baseline_sha256 = values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]
    _validate_manifest(baseline, label="legacy rollback baseline")
    if DIGEST.fullmatch(baseline_sha256) is None:
        raise PinError("legacy rollback baseline SHA-256 selector is invalid")

    lock_descriptor = _transition_lock(
        env_file,
        None,
        directory,
        parent_identity,
    )
    try:
        refreshed, refreshed_metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="legacy production env",
            recover_interrupted_link=False,
        )
        if refreshed != original or _metadata_signature(
            refreshed_metadata
        ) != _metadata_signature(opened):
            raise PinError("legacy production env changed under the transition lock")
        _validate_manifest_digest(
            selected_manifest,
            expected_manifest_sha256,
            label="legacy override manifest",
        )
        try:
            subprocess.run(
                [
                    sys.executable,
                    os.fspath(pathlib.Path(__file__).with_name("rollback-baseline.py")),
                    "check",
                    "--baseline",
                    baseline,
                    "--expected-baseline-sha256",
                    baseline_sha256,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PinError(
                "legacy rollback baseline did not pass fail-closed validation"
            ) from error
        insertion = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][0] + 1
        lines.insert(
            insertion,
            f"CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256={expected_manifest_sha256}\n",
        )
        _replace(
            env_file,
            "".join(lines).encode("utf-8"),
            original,
            refreshed_metadata,
            directory,
            parent_identity,
        )
        published, published_metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="legacy production env",
            recover_interrupted_link=False,
        )
        _, published_values = _parse(published.decode("utf-8"), SIX_SELECTOR_KEYS)
        if (
            published_values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1]
            != expected_manifest_sha256
            or stat.S_IMODE(published_metadata.st_mode) != 0o600
        ):
            raise PinError(
                "legacy manifest SHA-256 bootstrap failed its atomic read-back"
            )
        _validate_manifest_digest(
            selected_manifest,
            expected_manifest_sha256,
            label="selected override manifest",
        )
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def bootstrap_writer_snapshot_selectors(
    env_file: pathlib.Path,
    *,
    expected_env_sha256: str,
    writer_snapshot: str,
    writer_snapshot_sha256: str,
    inherited_lock: int | None = None,
) -> None:
    """Atomically upgrade one authenticated six-selector env to eight selectors."""
    if DIGEST.fullmatch(expected_env_sha256) is None:
        raise PinError("six-selector production env SHA-256 is invalid")
    if DIGEST.fullmatch(writer_snapshot_sha256) is None:
        raise PinError("rollback writer snapshot SHA-256 is invalid")
    directory, parent_identity = _open_protected_parent(
        env_file,
        label="six-selector production env",
    )
    lock_descriptor = _transition_lock(
        env_file,
        inherited_lock,
        directory,
        parent_identity,
    )
    try:
        current, current_metadata = _read_private_name(
            env_file,
            directory,
            parent_identity,
            label="six-selector production env",
            recover_interrupted_link=False,
        )

        def prepare_original(
            content: bytes,
        ) -> tuple[bytes, dict[str, tuple[int, str]]]:
            if f"sha256:{hashlib.sha256(content).hexdigest()}" != expected_env_sha256:
                raise PinError(
                    "six-selector production env differs from its authorized SHA-256"
                )
            try:
                decoded = content.decode("utf-8")
            except UnicodeDecodeError as error:
                raise PinError(
                    "six-selector production env is not valid UTF-8"
                ) from error
            _validate_canonical_compose_controls(decoded)
            present = {
                raw.split("=", 1)[0]
                for raw in decoded.splitlines()
                if raw and not raw.startswith("#") and "=" in raw
            }
            writer_keys = set(KEYS) - set(SIX_SELECTOR_KEYS)
            if present & writer_keys:
                raise PinError(
                    "production env already has a rollback writer snapshot selector"
                )
            lines, values = _parse(decoded, SIX_SELECTOR_KEYS)
            if (
                IMAGE_REF.fullmatch(values["CAUCE_RUNTIME_IMAGE"][1]) is None
                or IMAGE_REF.fullmatch(values["CAUCE_CONSOLE_IMAGE"][1]) is None
            ):
                raise PinError(
                    "six-selector production image selectors are not immutable"
                )
            if (
                DIGEST.fullmatch(values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1])
                is None
            ):
                raise PinError("six-selector override manifest SHA-256 is invalid")
            if DIGEST.fullmatch(values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]) is None:
                raise PinError(
                    "bootstrap rollback baseline SHA-256 selector is invalid"
                )
            insertion = values["CAUCE_ROLLBACK_BASELINE_SHA256"][0] + 1
            lines[insertion:insertion] = [
                f"CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE={writer_snapshot}\n",
                f"CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256={writer_snapshot_sha256}\n",
            ]
            return "".join(lines).encode("utf-8"), values

        interrupted_replacement = False
        if f"sha256:{hashlib.sha256(current).hexdigest()}" == expected_env_sha256:
            original = current
            replacement, values = prepare_original(original)
        else:
            try:
                current_text = current.decode("utf-8")
            except UnicodeDecodeError as error:
                raise PinError(
                    "six-selector production env is neither the authorized input "
                    "nor its exact interrupted replacement"
                ) from error
            current_lines, current_values = _parse(current_text, KEYS)
            writer_file_index = current_values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][0]
            writer_sha_index = current_values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"][
                0
            ]
            baseline_sha_index = current_values["CAUCE_ROLLBACK_BASELINE_SHA256"][0]
            if (
                current_values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][1]
                != writer_snapshot
                or current_values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"][1]
                != writer_snapshot_sha256
                or writer_file_index != baseline_sha_index + 1
                or writer_sha_index != writer_file_index + 1
            ):
                raise PinError(
                    "six-selector production env is neither the authorized input "
                    "nor its exact interrupted replacement"
                )
            del current_lines[writer_sha_index]
            del current_lines[writer_file_index]
            original = "".join(current_lines).encode("utf-8")
            replacement, values = prepare_original(original)
            if current != replacement:
                raise PinError(
                    "six-selector production env is neither the authorized input "
                    "nor its exact interrupted replacement"
                )
            interrupted_replacement = True

        runtime = values["CAUCE_RUNTIME_IMAGE"][1]
        console = values["CAUCE_CONSOLE_IMAGE"][1]
        manifest = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1]
        manifest_sha256 = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"][1]
        baseline = values["CAUCE_ROLLBACK_BASELINE_FILE"][1]
        baseline_sha256 = values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]

        def check_baseline() -> None:
            try:
                subprocess.run(
                    [
                        sys.executable,
                        os.fspath(
                            pathlib.Path(__file__).with_name("rollback-baseline.py")
                        ),
                        "check",
                        "--baseline",
                        baseline,
                        "--expected-baseline-sha256",
                        baseline_sha256,
                        "--expected-forward-runtime-image",
                        runtime,
                        "--expected-console-image",
                        console,
                        "--expected-override-manifest",
                        manifest,
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except (OSError, subprocess.CalledProcessError) as error:
                raise PinError(
                    "bootstrap rollback baseline did not pass fail-closed validation"
                ) from error

        def admit_selected_inputs() -> None:
            # Authenticate all six pre-state selectors, not just the two fields
            # introduced by this transition.  In particular, manifest bytes
            # are bound before and after the semantic baseline check.
            _validate_manifest_digest(
                manifest,
                manifest_sha256,
                label="bootstrap override manifest",
            )
            _validate_manifest_digest(
                baseline,
                baseline_sha256,
                label="bootstrap rollback baseline",
            )
            _validate_manifest_digest(
                writer_snapshot,
                writer_snapshot_sha256,
                label="bootstrap rollback writer snapshot",
            )
            check_baseline()
            _validate_manifest_digest(
                manifest,
                manifest_sha256,
                label="bootstrap override manifest",
            )
            _validate_manifest_digest(
                baseline,
                baseline_sha256,
                label="bootstrap rollback baseline",
            )
            _validate_manifest_digest(
                writer_snapshot,
                writer_snapshot_sha256,
                label="bootstrap rollback writer snapshot",
            )

        if not interrupted_replacement:
            admit_selected_inputs()

        def admit_published_selector() -> None:
            published, published_metadata = _read_private_name(
                env_file,
                directory,
                parent_identity,
                label="six-selector production env",
                recover_interrupted_link=False,
            )
            try:
                _, published_values = _parse(published.decode("utf-8"), KEYS)
            except UnicodeDecodeError as error:
                raise PinError(
                    "published eight-selector env is not valid UTF-8"
                ) from error
            if (
                published != replacement
                or published_values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"][1]
                != writer_snapshot
                or published_values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"][1]
                != writer_snapshot_sha256
                or any(
                    published_values[key][1] != values[key][1]
                    for key in SIX_SELECTOR_KEYS
                )
                or stat.S_IMODE(published_metadata.st_mode) != 0o600
            ):
                raise PinError(
                    "rollback writer snapshot bootstrap failed its atomic read-back"
                )
            admit_selected_inputs()

        if interrupted_replacement:
            _admit_recovered_replacement_or_restore(
                env_file,
                replacement,
                original,
                current_metadata,
                directory,
                parent_identity,
                label="rollback writer snapshot bootstrap",
                admit=admit_published_selector,
            )
        else:
            _replace_with_compensating_admission(
                env_file,
                replacement,
                original,
                current_metadata,
                directory,
                parent_identity,
                barrier="writer-snapshot-after-replace",
                label="rollback writer snapshot bootstrap",
                admit=admit_published_selector,
            )
    finally:
        os.close(lock_descriptor)
        os.close(directory)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    for action in ("check", "swap"):
        _add_transition_arguments(subparsers.add_parser(action))
    field = subparsers.add_parser("field")
    field.add_argument("--env-file", required=True, type=pathlib.Path)
    field.add_argument("--name", choices=KEYS, required=True)
    field.add_argument("--lock-fd", type=int)
    locked = subparsers.add_parser("locked-exec")
    locked.add_argument("--env-file", required=True, type=pathlib.Path)
    locked.add_argument("command", nargs=argparse.REMAINDER)
    manifest = subparsers.add_parser("manifest")
    manifest.add_argument("--env-file", required=True, type=pathlib.Path)
    manifest.add_argument("--path", required=True, type=pathlib.Path)
    manifest.add_argument("--expected-sha256")
    manifest.add_argument("--require-selected", action="store_true")
    manifest.add_argument("--lock-fd", type=int)
    bootstrap = subparsers.add_parser("bootstrap")
    bootstrap.add_argument("--env-file", required=True, type=pathlib.Path)
    bootstrap.add_argument("--candidate-env-file", required=True, type=pathlib.Path)
    bootstrap.add_argument("--expected-candidate-env-sha256", required=True)
    bootstrap.add_argument("--expected-override-manifest-sha256", required=True)
    two_selector = subparsers.add_parser("bootstrap-two-selector")
    two_selector.add_argument("--env-file", required=True, type=pathlib.Path)
    two_selector.add_argument("--expected-env-sha256", required=True)
    two_selector.add_argument("--runtime-image", required=True)
    two_selector.add_argument("--console-image", required=True)
    two_selector.add_argument("--override-manifest", required=True)
    two_selector.add_argument("--override-manifest-sha256", required=True)
    two_selector.add_argument("--rollback-baseline", required=True)
    two_selector.add_argument("--rollback-baseline-sha256", required=True)
    two_selector.add_argument("--backup-env-file", required=True, type=pathlib.Path)
    production_legacy = subparsers.add_parser("bootstrap-production-legacy")
    production_legacy.add_argument("--env-file", required=True, type=pathlib.Path)
    production_legacy.add_argument("--expected-env-sha256", required=True)
    production_legacy.add_argument("--runtime-image", required=True)
    production_legacy.add_argument("--console-image", required=True)
    production_legacy.add_argument("--override-manifest", required=True)
    production_legacy.add_argument("--override-manifest-sha256", required=True)
    production_legacy.add_argument("--rollback-baseline", required=True)
    production_legacy.add_argument("--rollback-baseline-sha256", required=True)
    production_legacy.add_argument("--legacy-fleet-snapshot", required=True)
    production_legacy.add_argument("--legacy-fleet-snapshot-sha256", required=True)
    production_legacy.add_argument("--backup-env-file", required=True, type=pathlib.Path)
    production_legacy.add_argument("--lock-fd", type=int)
    capture_legacy = subparsers.add_parser("capture-production-legacy")
    capture_legacy.add_argument("--env-file", required=True, type=pathlib.Path)
    capture_legacy.add_argument("--expected-env-sha256", required=True)
    capture_legacy.add_argument("--runtime-image", required=True)
    capture_legacy.add_argument("--console-image", required=True)
    capture_legacy.add_argument("--override-manifest", required=True)
    capture_legacy.add_argument("--override-manifest-sha256", required=True)
    capture_legacy.add_argument("--output", required=True, type=pathlib.Path)
    capture_legacy.add_argument("--backup-env-file", type=pathlib.Path)
    capture_legacy.add_argument("--lock-fd", type=int)
    restore_legacy = subparsers.add_parser("restore-production-legacy")
    restore_legacy.add_argument("--env-file", required=True, type=pathlib.Path)
    restore_legacy.add_argument("--expected-env-sha256", required=True)
    restore_legacy.add_argument("--runtime-image", required=True)
    restore_legacy.add_argument("--console-image", required=True)
    restore_legacy.add_argument("--override-manifest", required=True)
    restore_legacy.add_argument("--override-manifest-sha256", required=True)
    restore_legacy.add_argument("--rollback-baseline", required=True)
    restore_legacy.add_argument("--rollback-baseline-sha256", required=True)
    restore_legacy.add_argument("--writer-snapshot", required=True)
    restore_legacy.add_argument("--writer-snapshot-sha256", required=True)
    restore_legacy.add_argument("--backup-env-file", required=True, type=pathlib.Path)
    restore_legacy.add_argument("--lock-fd", type=int)
    legacy_manifest = subparsers.add_parser("bootstrap-manifest-sha")
    legacy_manifest.add_argument("--env-file", required=True, type=pathlib.Path)
    legacy_manifest.add_argument("--expected-env-sha256", required=True)
    legacy_manifest.add_argument("--expected-override-manifest", required=True)
    legacy_manifest.add_argument("--expected-override-manifest-sha256", required=True)
    legacy_writer = subparsers.add_parser("bootstrap-writer-snapshot")
    legacy_writer.add_argument("--env-file", required=True, type=pathlib.Path)
    legacy_writer.add_argument("--expected-env-sha256", required=True)
    legacy_writer.add_argument("--writer-snapshot", required=True)
    legacy_writer.add_argument("--writer-snapshot-sha256", required=True)
    legacy_writer.add_argument("--lock-fd", type=int)
    arguments = parser.parse_args(argv)
    try:
        if arguments.action == "locked-exec":
            command = (
                arguments.command[1:]
                if arguments.command[:1] == ["--"]
                else arguments.command
            )
            return locked_exec(arguments.env_file, command)
        if arguments.action == "manifest":
            observed = manifest_digest_under_lock(
                arguments.env_file,
                arguments.path,
                expected_sha256=arguments.expected_sha256,
                require_selected=arguments.require_selected,
                inherited_lock=arguments.lock_fd,
            )
            if arguments.expected_sha256 is None:
                print(observed)
            else:
                print("production override manifest passed")
            return 0
        if arguments.action == "bootstrap":
            bootstrap_legacy_env(
                arguments.env_file,
                arguments.candidate_env_file,
                expected_candidate_sha256=arguments.expected_candidate_env_sha256,
                expected_manifest_sha256=arguments.expected_override_manifest_sha256,
            )
            print("production release legacy bootstrap passed")
            return 0
        if arguments.action == "bootstrap-two-selector":
            bootstrap_two_selector_env(
                arguments.env_file,
                expected_env_sha256=arguments.expected_env_sha256,
                runtime_image=arguments.runtime_image,
                console_image=arguments.console_image,
                override_manifest=arguments.override_manifest,
                override_manifest_sha256=arguments.override_manifest_sha256,
                rollback_baseline=arguments.rollback_baseline,
                rollback_baseline_sha256=arguments.rollback_baseline_sha256,
                backup_env_file=arguments.backup_env_file,
            )
            print("production release two-selector bootstrap passed")
            return 0
        if arguments.action == "capture-production-legacy":
            print(capture_legacy_fleet(
                arguments.env_file,
                expected_env_sha256=arguments.expected_env_sha256,
                runtime_image=arguments.runtime_image,
                console_image=arguments.console_image,
                override_manifest=arguments.override_manifest,
                override_manifest_sha256=arguments.override_manifest_sha256,
                output=arguments.output,
                backup_env_file=arguments.backup_env_file,
                inherited_lock=arguments.lock_fd,
            ))
            return 0
        if arguments.action == "bootstrap-production-legacy":
            bootstrap_two_selector_env(
                arguments.env_file,
                expected_env_sha256=arguments.expected_env_sha256,
                runtime_image=arguments.runtime_image,
                console_image=arguments.console_image,
                override_manifest=arguments.override_manifest,
                override_manifest_sha256=arguments.override_manifest_sha256,
                rollback_baseline=arguments.rollback_baseline,
                rollback_baseline_sha256=arguments.rollback_baseline_sha256,
                backup_env_file=arguments.backup_env_file,
                legacy_fleet_snapshot=arguments.legacy_fleet_snapshot,
                legacy_fleet_snapshot_sha256=arguments.legacy_fleet_snapshot_sha256,
                inherited_lock=arguments.lock_fd,
            )
            print("production legacy selector bootstrap passed")
            return 0
        if arguments.action == "restore-production-legacy":
            restore_production_legacy(
                arguments.env_file,
                expected_env_sha256=arguments.expected_env_sha256,
                runtime_image=arguments.runtime_image,
                console_image=arguments.console_image,
                override_manifest=arguments.override_manifest,
                override_manifest_sha256=arguments.override_manifest_sha256,
                rollback_baseline=arguments.rollback_baseline,
                rollback_baseline_sha256=arguments.rollback_baseline_sha256,
                writer_snapshot=arguments.writer_snapshot,
                writer_snapshot_sha256=arguments.writer_snapshot_sha256,
                backup_env_file=arguments.backup_env_file,
                inherited_lock=arguments.lock_fd,
            )
            print("production legacy selector compensation passed")
            return 0
        if arguments.action == "bootstrap-manifest-sha":
            bootstrap_legacy_manifest_sha(
                arguments.env_file,
                expected_env_sha256=arguments.expected_env_sha256,
                expected_manifest=arguments.expected_override_manifest,
                expected_manifest_sha256=arguments.expected_override_manifest_sha256,
            )
            print("production release legacy manifest SHA-256 bootstrap passed")
            return 0
        if arguments.action == "bootstrap-writer-snapshot":
            bootstrap_writer_snapshot_selectors(
                arguments.env_file,
                expected_env_sha256=arguments.expected_env_sha256,
                writer_snapshot=arguments.writer_snapshot,
                writer_snapshot_sha256=arguments.writer_snapshot_sha256,
                inherited_lock=arguments.lock_fd,
            )
            print("production release rollback writer snapshot bootstrap passed")
            return 0
        if arguments.action == "field":
            print(read_selector(arguments.env_file, arguments.name, arguments.lock_fd))
            return 0
        transition(
            arguments.env_file,
            expected_runtime=arguments.expected_runtime_image,
            target_runtime=arguments.target_runtime_image,
            expected_console=arguments.expected_console_image,
            target_console=arguments.target_console_image,
            expected_manifest=arguments.expected_override_manifest,
            target_manifest=arguments.target_override_manifest,
            expected_baseline=arguments.expected_rollback_baseline,
            target_baseline=arguments.target_rollback_baseline,
            expected_baseline_sha256=arguments.expected_rollback_baseline_sha256,
            target_baseline_sha256=arguments.target_rollback_baseline_sha256,
            expected_writer_snapshot=arguments.expected_writer_snapshot,
            target_writer_snapshot=arguments.target_writer_snapshot,
            expected_writer_snapshot_sha256=arguments.expected_writer_snapshot_sha256,
            target_writer_snapshot_sha256=arguments.target_writer_snapshot_sha256,
            baseline_forward_release_commit=arguments.baseline_forward_release_commit,
            baseline_forward_runtime_image=arguments.baseline_forward_runtime_image,
            baseline_forward_runtime_source_digest=arguments.baseline_forward_runtime_source_digest,
            write=arguments.action == "swap",
            expected_manifest_sha256=arguments.expected_override_manifest_sha256,
            target_manifest_sha256=arguments.target_override_manifest_sha256,
            inherited_lock=arguments.lock_fd,
            isolated_evidence_root=arguments.isolated_evidence_root,
        )
    except (OSError, PinError) as error:
        print(f"production release pin failed: {error}", file=sys.stderr)
        return 1
    print(f"production release pin {arguments.action} passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
