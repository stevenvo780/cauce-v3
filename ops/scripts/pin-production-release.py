#!/usr/bin/env python3
"""Atomically compare-and-swap the complete production release selector set.

The production env contains secret-bearing path configuration, so this helper never
sources it and never prints values. Runtime, console, authenticated override manifest,
and the rollback-baseline path/hash are compared and replaced as one selector set.
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys


IMAGE_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$"
)
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
KEYS = (
    "CAUCE_RUNTIME_IMAGE",
    "CAUCE_CONSOLE_IMAGE",
    "CAUCE_COMPOSE_OVERRIDE_MANIFEST",
    "CAUCE_ROLLBACK_BASELINE_FILE",
    "CAUCE_ROLLBACK_BASELINE_SHA256",
)


class PinError(ValueError):
    pass


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


def _parse(content: str) -> tuple[list[str], dict[str, tuple[int, str]]]:
    lines = content.splitlines(keepends=True)
    if content and not content.endswith(("\n", "\r")):
        raise PinError("production env must end with a newline")
    found: dict[str, tuple[int, str]] = {}
    for index, raw_line in enumerate(lines):
        line = raw_line.removesuffix("\n").removesuffix("\r")
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key not in KEYS:
            continue
        if key in found:
            raise PinError(f"production env contains duplicate {key}")
        found[key] = (index, value)
    for key in KEYS:
        if key not in found:
            raise PinError(f"production env is missing {key}")
    return lines, found


def _open_lock(path: pathlib.Path) -> int:
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise PinError("production release lock cannot be opened safely") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}
        ):
            raise PinError("production release lock must be a single-link private regular file")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


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


def _replace(path: pathlib.Path, content: bytes, original: bytes, metadata: os.stat_result) -> None:
    temporary = path.parent / f".{path.name}.release-pin-{os.getpid()}-{secrets.token_hex(8)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(temporary, flags, 0o600)
        os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
        try:
            os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        except PermissionError as error:
            if (metadata.st_uid, metadata.st_gid) != (os.geteuid(), os.getegid()):
                raise PinError("production env ownership could not be preserved") from error
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1

        current, current_metadata = _read_exact(path)
        if current != original or _metadata_signature(current_metadata) != _metadata_signature(metadata):
            raise PinError("compare-and-swap failed: production env changed during update")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


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
    baseline_forward_release_commit: str,
    baseline_forward_runtime_image: str,
    baseline_forward_runtime_source_digest: str,
    write: bool,
) -> None:
    image_values = (expected_runtime, target_runtime, expected_console, target_console)
    if any(IMAGE_REF.fullmatch(value) is None for value in image_values):
        raise PinError("image selectors must be immutable repository @sha256 references")
    _validate_manifest(expected_manifest, label="expected override manifest")
    _validate_manifest(target_manifest, label="target override manifest")
    _validate_manifest(expected_baseline, label="expected rollback baseline")
    _validate_manifest(target_baseline, label="target rollback baseline")
    if DIGEST.fullmatch(expected_baseline_sha256) is None or DIGEST.fullmatch(target_baseline_sha256) is None:
        raise PinError("rollback baseline SHA-256 selectors are invalid")
    metadata = _validate_private_file(env_file, label="production env")
    lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
    lock_descriptor = _open_lock(lock_path)
    try:
        original, opened_metadata = _read_exact(env_file)
        if _metadata_signature(metadata) != _metadata_signature(opened_metadata):
            raise PinError("compare-and-swap failed: production env changed before lock acquisition")
        try:
            decoded = original.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PinError("production env is not valid UTF-8") from error
        lines, values = _parse(decoded)
        observed_runtime = values["CAUCE_RUNTIME_IMAGE"][1]
        observed_console = values["CAUCE_CONSOLE_IMAGE"][1]
        observed_manifest = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][1]
        observed_baseline = values["CAUCE_ROLLBACK_BASELINE_FILE"][1]
        observed_baseline_sha256 = values["CAUCE_ROLLBACK_BASELINE_SHA256"][1]
        if (observed_runtime != expected_runtime or observed_console != expected_console
                or observed_manifest != expected_manifest or observed_baseline != expected_baseline
                or observed_baseline_sha256 != expected_baseline_sha256):
            raise PinError("compare-and-swap failed: configured release selectors changed")
        try:
            subprocess.run(
                [
                    sys.executable,
                    os.fspath(pathlib.Path(__file__).with_name("rollback-baseline.py")),
                    "check",
                    "--baseline", target_baseline,
                    "--expected-baseline-sha256", target_baseline_sha256,
                    "--expected-forward-release-commit", baseline_forward_release_commit,
                    "--expected-forward-runtime-image", baseline_forward_runtime_image,
                    "--expected-forward-runtime-source-digest", baseline_forward_runtime_source_digest,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PinError("target rollback baseline did not pass fail-closed validation") from error
        if not write:
            return
        lines[values["CAUCE_RUNTIME_IMAGE"][0]] = f"CAUCE_RUNTIME_IMAGE={target_runtime}\n"
        lines[values["CAUCE_CONSOLE_IMAGE"][0]] = f"CAUCE_CONSOLE_IMAGE={target_console}\n"
        lines[values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"][0]] = (
            f"CAUCE_COMPOSE_OVERRIDE_MANIFEST={target_manifest}\n"
        )
        lines[values["CAUCE_ROLLBACK_BASELINE_FILE"][0]] = (
            f"CAUCE_ROLLBACK_BASELINE_FILE={target_baseline}\n"
        )
        lines[values["CAUCE_ROLLBACK_BASELINE_SHA256"][0]] = (
            f"CAUCE_ROLLBACK_BASELINE_SHA256={target_baseline_sha256}\n"
        )
        _replace(env_file, "".join(lines).encode("utf-8"), original, opened_metadata)
    finally:
        os.close(lock_descriptor)


def read_selector(env_file: pathlib.Path, name: str) -> str:
    metadata = _validate_private_file(env_file, label="production env")
    content, opened_metadata = _read_exact(env_file)
    if _metadata_signature(metadata) != _metadata_signature(opened_metadata):
        raise PinError("production env changed before selector read")
    try:
        decoded = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PinError("production env is not valid UTF-8") from error
    _, values = _parse(decoded)
    return values[name][1]


def _add_transition_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--env-file", required=True, type=pathlib.Path)
    parser.add_argument("--expected-runtime-image", required=True)
    parser.add_argument("--target-runtime-image", required=True)
    parser.add_argument("--expected-console-image", required=True)
    parser.add_argument("--target-console-image", required=True)
    parser.add_argument("--expected-override-manifest", required=True)
    parser.add_argument("--target-override-manifest", required=True)
    parser.add_argument("--expected-rollback-baseline", required=True)
    parser.add_argument("--target-rollback-baseline", required=True)
    parser.add_argument("--expected-rollback-baseline-sha256", required=True)
    parser.add_argument("--target-rollback-baseline-sha256", required=True)
    parser.add_argument("--baseline-forward-release-commit", required=True)
    parser.add_argument("--baseline-forward-runtime-image", required=True)
    parser.add_argument("--baseline-forward-runtime-source-digest", required=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    for action in ("check", "swap"):
        _add_transition_arguments(subparsers.add_parser(action))
    field = subparsers.add_parser("field")
    field.add_argument("--env-file", required=True, type=pathlib.Path)
    field.add_argument("--name", choices=KEYS, required=True)
    arguments = parser.parse_args(argv)
    try:
        if arguments.action == "field":
            print(read_selector(arguments.env_file, arguments.name))
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
            baseline_forward_release_commit=arguments.baseline_forward_release_commit,
            baseline_forward_runtime_image=arguments.baseline_forward_runtime_image,
            baseline_forward_runtime_source_digest=arguments.baseline_forward_runtime_source_digest,
            write=arguments.action == "swap",
        )
    except (OSError, PinError) as error:
        print(f"production release pin failed: {error}", file=sys.stderr)
        return 1
    print(f"production release pin {arguments.action} passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
