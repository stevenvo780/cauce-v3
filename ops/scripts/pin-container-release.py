#!/usr/bin/env python3
"""Atomically pin one container adapter alias to an immutable host bundle.

The alias config is intentionally non-secret.  This helper never opens the PKI
tree and only changes BUNDLE_RELEASE/BUNDLE_SHA256 while preserving every other
config line byte-for-byte.
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
from collections.abc import Iterator

from container_alias_lib import load_container_aliases

ALIAS_RE = re.compile(r"[a-z][a-z0-9-]*\Z")
RELEASE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
DIGEST_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
CONFIG_LINE_RE = re.compile(r"([A-Z][A-Z0-9_]*)=(.*)\Z")


class PinError(RuntimeError):
    pass


def defaults() -> tuple[pathlib.Path, pathlib.Path]:
    if os.geteuid() == 0:
        return (
            pathlib.Path("/etc/cauce-v3/container-aliases"),
            pathlib.Path("/opt/cauce-v3-adapter"),
        )
    config_home = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config"))
    data_home = pathlib.Path(os.environ.get("XDG_DATA_HOME", pathlib.Path.home() / ".local/share"))
    return (
        config_home / "cauce-v3/container-aliases",
        data_home / "cauce-v3-adapter",
    )


def validate_absolute(path: pathlib.Path, label: str) -> None:
    raw = os.fspath(path)
    if not raw.startswith("/") or "//" in raw or "\x00" in raw:
        raise PinError(f"{label} must be a canonical absolute path")
    components = raw.split("/")[1:]
    if not components or any(component in ("", ".", "..") for component in components):
        raise PinError(f"{label} must be a canonical absolute path")


def open_absolute_directory(path: pathlib.Path, label: str) -> int:
    """Open an absolute directory without following any pathname component."""

    validate_absolute(path, label)
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in os.fspath(path).split("/")[1:]:
            following = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=current,
            )
            os.close(current)
            current = following
        return current
    except Exception:
        os.close(current)
        raise


def assert_owned_secure_directory(fd: int, label: str) -> os.stat_result:
    details = os.fstat(fd)
    if not stat.S_ISDIR(details.st_mode):
        raise PinError(f"{label} must be a directory")
    if details.st_uid != os.geteuid() or details.st_mode & 0o022:
        raise PinError(f"{label} must have the required owner and not be group/world writable")
    return details


def open_regular_at(
    directory_fd: int,
    name: str,
    flags: int,
    *,
    mode: int | None = None,
) -> int:
    options = flags | os.O_NOFOLLOW | os.O_CLOEXEC
    if mode is None:
        return os.open(name, options, dir_fd=directory_fd)
    return os.open(name, options, mode, dir_fd=directory_fd)


def assert_config_file(fd: int) -> os.stat_result:
    details = os.fstat(fd)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or details.st_uid != os.geteuid()
        or stat.S_IMODE(details.st_mode) != 0o600
    ):
        raise PinError("container alias config must be a single-link regular file owned by the caller with mode 0600")
    return details


def file_identity(details: os.stat_result) -> tuple[int, ...]:
    return (
        details.st_dev,
        details.st_ino,
        details.st_size,
        details.st_mtime_ns,
        details.st_ctime_ns,
        details.st_uid,
        details.st_gid,
        stat.S_IMODE(details.st_mode),
        details.st_nlink,
    )


def read_config(
    fd: int, *, allow_legacy_current: bool = False
) -> tuple[list[str], dict[str, tuple[int, str]]]:
    details = os.fstat(fd)
    if details.st_size > 1024 * 1024:
        raise PinError("container alias config is too large")
    os.lseek(fd, 0, os.SEEK_SET)
    raw = b""
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        raw += chunk
        if len(raw) > 1024 * 1024:
            raise PinError("container alias config is too large")
    try:
        body = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PinError("container alias config is not valid UTF-8") from error
    if "\r" in body or "\x00" in body:
        raise PinError("container alias config contains forbidden bytes")
    lines = body.splitlines(keepends=True)
    if body and (not lines or not lines[-1].endswith("\n")):
        raise PinError("container alias config must end with a newline")
    parsed: dict[str, tuple[int, str]] = {}
    for index, line_with_newline in enumerate(lines):
        line = line_with_newline.removesuffix("\n")
        if not line or line.startswith("#"):
            continue
        match = CONFIG_LINE_RE.fullmatch(line)
        if match is None or not match.group(2):
            raise PinError("container alias config has invalid syntax")
        key, value = match.groups()
        if key in parsed:
            raise PinError(f"container alias config key is duplicated: {key}")
        parsed[key] = (index, value)
    if "BUNDLE_SHA256" not in parsed:
        raise PinError("container alias config is missing: BUNDLE_SHA256")
    if allow_legacy_current:
        if "BUNDLE_CURRENT" not in parsed or "BUNDLE_RELEASE" in parsed:
            raise PinError("legacy migration requires only BUNDLE_CURRENT")
    else:
        if "BUNDLE_CURRENT" in parsed:
            raise PinError("legacy BUNDLE_CURRENT is forbidden; migrate the alias to BUNDLE_RELEASE")
        if "BUNDLE_RELEASE" not in parsed:
            raise PinError("container alias config is missing: BUNDLE_RELEASE")
    return lines, parsed


def iter_bundle_entries(release_path: pathlib.Path) -> Iterator[tuple[pathlib.Path, os.stat_result]]:
    for current, directory_names, file_names in os.walk(release_path, topdown=True, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = pathlib.Path(current)
        for name in list(directory_names):
            child = current_path / name
            details = os.lstat(child)
            yield child, details
            if stat.S_ISLNK(details.st_mode):
                directory_names.remove(name)
        for name in file_names:
            child = current_path / name
            yield child, os.lstat(child)


def validate_release(
    bundle_root: pathlib.Path,
    release: str,
    expected_digest: str,
    runtime_helper: pathlib.Path,
) -> pathlib.Path:
    if RELEASE_RE.fullmatch(release) is None or release == "current":
        raise PinError("bundle release name is invalid")
    if DIGEST_RE.fullmatch(expected_digest) is None:
        raise PinError("bundle digest must be an exact sha256 digest")

    bundle_fd = open_absolute_directory(bundle_root, "bundle root")
    try:
        assert_owned_secure_directory(bundle_fd, "bundle root")
        releases_fd = os.open(
            "releases",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=bundle_fd,
        )
    except Exception:
        os.close(bundle_fd)
        raise
    try:
        assert_owned_secure_directory(releases_fd, "bundle releases directory")
        release_fd = os.open(
            release,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=releases_fd,
        )
    except Exception:
        os.close(releases_fd)
        os.close(bundle_fd)
        raise
    try:
        release_details = os.fstat(release_fd)
        if (
            release_details.st_uid != os.geteuid()
            or not stat.S_ISDIR(release_details.st_mode)
            or release_details.st_mode & 0o222
        ):
            raise PinError("bundle release must be caller-owned and immutable")
    finally:
        os.close(release_fd)
        os.close(releases_fd)
        os.close(bundle_fd)

    release_path = bundle_root / "releases" / release
    release_prefix = os.fspath(release_path) + os.sep
    for entry, details in iter_bundle_entries(release_path):
        if details.st_uid != os.geteuid():
            raise PinError("bundle entries must have the required owner")
        if stat.S_ISREG(details.st_mode) or stat.S_ISDIR(details.st_mode):
            if details.st_mode & 0o222:
                raise PinError("bundle entries must have no write bits")
        elif stat.S_ISLNK(details.st_mode):
            resolved = os.path.realpath(entry)
            if not resolved.startswith(release_prefix):
                raise PinError("bundle symlink escapes its immutable release")
        else:
            raise PinError("bundle contains an unsupported entry type")

    try:
        result = subprocess.run(
            [sys.executable, os.fspath(runtime_helper), "bundle-digest", os.fspath(release_path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
            env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PinError("cannot calculate bundle digest") from error
    calculated = result.stdout.strip()
    if result.returncode != 0 or DIGEST_RE.fullmatch(calculated) is None:
        raise PinError("cannot calculate bundle digest")
    if calculated != expected_digest:
        raise PinError("requested bundle digest differs from the immutable release")
    return release_path


def update_config(
    *,
    config_root: pathlib.Path,
    alias: str,
    target_release: str,
    target_digest: str,
    expected_release: str | None,
    expected_current: str | None,
    expected_digest: str,
    bundle_root: pathlib.Path,
    runtime_helper: pathlib.Path,
) -> None:
    config_root_fd = open_absolute_directory(config_root, "container alias config root")
    try:
        assert_owned_secure_directory(config_root_fd, "container alias config root")
        lock_name = f".{alias}.release-pin.lock"
        lock_fd = open_regular_at(
            config_root_fd,
            lock_name,
            os.O_RDWR | os.O_CREAT,
            mode=0o600,
        )
        try:
            lock_details = os.fstat(lock_fd)
            if (
                not stat.S_ISREG(lock_details.st_mode)
                or lock_details.st_nlink != 1
                or lock_details.st_uid != os.geteuid()
                or stat.S_IMODE(lock_details.st_mode) != 0o600
            ):
                raise PinError("release pin lock must be a single-link caller-owned regular file with mode 0600")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            config_name = f"{alias}.env"
            config_fd = open_regular_at(config_root_fd, config_name, os.O_RDONLY)
            try:
                original = assert_config_file(config_fd)
                lines, parsed = read_config(
                    config_fd,
                    allow_legacy_current=expected_current is not None,
                )
            finally:
                os.close(config_fd)

            current_digest = parsed["BUNDLE_SHA256"][1]
            if expected_current is not None:
                current_selector = parsed["BUNDLE_CURRENT"][1]
                if current_selector != expected_current or current_digest != expected_digest:
                    raise PinError("compare-and-swap failed: configured legacy pointer or digest changed")
            else:
                current_release = parsed["BUNDLE_RELEASE"][1]
                if current_release != expected_release or current_digest != expected_digest:
                    raise PinError("compare-and-swap failed: configured release or digest changed")

            validate_release(bundle_root, target_release, target_digest, runtime_helper)
            selector_key = (
                "BUNDLE_CURRENT" if expected_current is not None else "BUNDLE_RELEASE"
            )
            lines[parsed[selector_key][0]] = f"BUNDLE_RELEASE={target_release}\n"
            lines[parsed["BUNDLE_SHA256"][0]] = f"BUNDLE_SHA256={target_digest}\n"
            body = "".join(lines).encode("utf-8")
            temporary_name = f".{config_name}.pin-{os.getpid()}-{secrets.token_hex(8)}"
            temporary_fd: int | None = None
            try:
                temporary_fd = open_regular_at(
                    config_root_fd,
                    temporary_name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    mode=0o600,
                )
                os.fchown(temporary_fd, original.st_uid, original.st_gid)
                os.fchmod(temporary_fd, 0o600)
                offset = 0
                while offset < len(body):
                    offset += os.write(temporary_fd, body[offset:])
                os.fsync(temporary_fd)
                os.close(temporary_fd)
                temporary_fd = None
                current_fd = open_regular_at(config_root_fd, config_name, os.O_RDONLY)
                try:
                    current = assert_config_file(current_fd)
                    if file_identity(current) != file_identity(original):
                        raise PinError("compare-and-swap failed: container alias config changed during update")
                finally:
                    os.close(current_fd)
                os.replace(
                    temporary_name,
                    config_name,
                    src_dir_fd=config_root_fd,
                    dst_dir_fd=config_root_fd,
                )
                os.fsync(config_root_fd)
            finally:
                if temporary_fd is not None:
                    os.close(temporary_fd)
                try:
                    os.unlink(temporary_name, dir_fd=config_root_fd)
                except FileNotFoundError:
                    pass
        finally:
            os.close(lock_fd)
    finally:
        os.close(config_root_fd)


def main() -> int:
    default_config_root, default_bundle_root = defaults()
    parser = argparse.ArgumentParser(
        description="Atomically pin or roll back one Cauce container alias bundle using CAS",
    )
    parser.add_argument("action", choices=("pin", "rollback", "migrate"))
    parser.add_argument("alias")
    parser.add_argument("--release", required=True, help="target immutable release name")
    parser.add_argument("--sha256", required=True, help="target sha256:<64 lowercase hex> digest")
    parser.add_argument("--expected-release", help="currently configured release")
    parser.add_argument(
        "--expected-current",
        help="exact legacy BUNDLE_CURRENT path; valid only for one-time migrate",
    )
    parser.add_argument("--expected-sha256", required=True, help="currently configured digest")
    parser.add_argument("--config-root", type=pathlib.Path, default=default_config_root)
    parser.add_argument("--bundle-root", type=pathlib.Path, default=default_bundle_root)
    parser.add_argument(
        "--runtime-helper",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parents[1]
        / "container-runtime/cauce-container-runtime.py",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    if ALIAS_RE.fullmatch(args.alias) is None:
        raise PinError("container adapter alias is invalid")
    ops_root = pathlib.Path(__file__).resolve().parents[1]
    if args.alias not in load_container_aliases(ops_root):
        raise PinError("container adapter alias is not declared")
    if args.action == "migrate":
        if args.expected_release is not None or args.expected_current is None:
            raise PinError("migrate requires --expected-current and forbids --expected-release")
        validate_absolute(pathlib.Path(args.expected_current), "expected legacy bundle pointer")
    else:
        if args.expected_current is not None or args.expected_release is None:
            raise PinError("pin/rollback require --expected-release and forbid --expected-current")
        if RELEASE_RE.fullmatch(args.expected_release) is None or args.expected_release == "current":
            raise PinError("expected release name is invalid")
    if DIGEST_RE.fullmatch(args.expected_sha256) is None:
        raise PinError("expected digest must be an exact sha256 digest")
    validate_absolute(args.config_root, "container alias config root")
    validate_absolute(args.bundle_root, "bundle root")
    validate_absolute(args.runtime_helper, "runtime helper")
    helper_details = os.lstat(args.runtime_helper)
    if not stat.S_ISREG(helper_details.st_mode) or stat.S_ISLNK(helper_details.st_mode):
        raise PinError("runtime helper must be a regular non-symlink file")

    update_config(
        config_root=args.config_root,
        alias=args.alias,
        target_release=args.release,
        target_digest=args.sha256,
        expected_release=args.expected_release,
        expected_current=args.expected_current,
        expected_digest=args.expected_sha256,
        bundle_root=args.bundle_root,
        runtime_helper=args.runtime_helper,
    )
    print(f"{args.action} ok: {args.alias} release={args.release} digest={args.sha256}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, PinError) as error:
        print(f"container release pin failed: {error}", file=sys.stderr)
        raise SystemExit(78) from None
