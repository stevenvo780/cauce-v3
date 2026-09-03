#!/usr/bin/env python3
"""Verify a sealed Hermes source/venv release without reading its mutable profile."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys
import urllib.parse


class VerificationError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise VerificationError(message)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inside(path: pathlib.Path, root: pathlib.Path) -> bool:
    return path == root or root in path.parents


def regular(path: pathlib.Path, owner_uid: int) -> None:
    details = os.lstat(path)
    if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
        fail("required runtime file is not regular")
    if details.st_uid != owner_uid or details.st_mode & 0o222:
        fail("required runtime file is not sealed by its owner")


def inspect_editable_metadata(venv: pathlib.Path, source: pathlib.Path) -> None:
    site_packages = sorted(venv.glob("lib/python*/site-packages"))
    if len(site_packages) != 1:
        fail("Hermes venv has an ambiguous site-packages layout")
    site = site_packages[0]
    for pth in site.glob("*.pth"):
        for raw in pth.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("import "):
                continue
            candidate = pathlib.Path(line)
            if candidate.is_absolute() and not inside(candidate.resolve(strict=True), source):
                fail("editable .pth escapes the immutable source")
    for direct_url in site.glob("*.dist-info/direct_url.json"):
        payload = json.loads(direct_url.read_text(encoding="utf-8"))
        url = payload.get("url")
        if not isinstance(url, str):
            fail("editable direct_url metadata is invalid")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "file":
            fail("Hermes distribution is not bound to the local immutable source")
        candidate = pathlib.Path(urllib.parse.unquote(parsed.path)).resolve(strict=True)
        if not inside(candidate, source):
            fail("editable direct_url escapes the immutable source")
    for finder in site.glob("__editable__*_finder.py"):
        tree = ast.parse(finder.read_text(encoding="utf-8"), filename=os.fspath(finder))
        mappings: list[dict[object, object]] = []
        for node in tree.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(isinstance(target, ast.Name) and target.id == "MAPPING" for target in targets):
                    value = ast.literal_eval(node.value)
                    if isinstance(value, dict):
                        mappings.append(value)
        for mapping in mappings:
            for value in mapping.values():
                if not isinstance(value, str):
                    fail("editable finder contains a non-path mapping")
                if not inside(pathlib.Path(value).resolve(strict=True), source):
                    fail("editable finder escapes the immutable source")


def run_import_probe(venv: pathlib.Path, source: pathlib.Path, version: str) -> None:
    probe = r"""
import importlib.metadata
import pathlib
import sys
import hermes_cli.oneshot

source = pathlib.Path(sys.argv[1]).resolve(strict=True)
venv = pathlib.Path(sys.argv[2]).resolve(strict=True)
module = pathlib.Path(hermes_cli.oneshot.__file__).resolve(strict=True)
if source not in module.parents:
    raise SystemExit(1)
if pathlib.Path(sys.prefix).resolve(strict=True) != venv:
    raise SystemExit(1)
if importlib.metadata.version("hermes-agent") != sys.argv[3]:
    raise SystemExit(1)
"""
    completed = subprocess.run(
        [os.fspath(venv / "bin/python"), "-c", probe, os.fspath(source), os.fspath(venv), version],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        fail("Hermes import does not resolve from the immutable runtime")


def verify(arguments: argparse.Namespace) -> None:
    allowed_root = pathlib.Path(arguments.allowed_root)
    runtime = pathlib.Path(arguments.runtime_dir)
    if not allowed_root.is_absolute() or not runtime.is_absolute():
        fail("runtime paths must be absolute")
    allowed_resolved = allowed_root.resolve(strict=True)
    runtime_resolved = runtime.resolve(strict=True)
    if allowed_resolved != allowed_root or runtime_resolved != runtime:
        fail("runtime anchor or release follows a symlink")
    relative = runtime.relative_to(allowed_root)
    if len(relative.parts) != 2:
        fail("runtime release is outside the alias/runtime-id layout")
    for directory in (allowed_root, runtime.parent, runtime):
        details = os.lstat(directory)
        if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
            fail("runtime ancestor is not a real directory")
        if details.st_uid != arguments.owner_uid or details.st_mode & 0o022:
            fail("runtime ancestor ownership or mode is unsafe")

    source = runtime / "source"
    venv = runtime / "venv"
    marker = runtime / ".cauce-runtime"
    uv = runtime / "uv"
    for required in (marker, source / "uv.lock", uv):
        regular(required, arguments.owner_uid)
    expected_marker = "\n".join(
        (
            arguments.source_commit,
            arguments.package_version,
            arguments.uv_version,
            arguments.uv_target,
            arguments.uv_sha256,
            arguments.uv_lock_sha256,
            arguments.uv_archive_url,
            arguments.uv_archive_sha256,
        )
    ) + "\n"
    if marker.read_text(encoding="utf-8") != expected_marker:
        fail("Hermes ready marker differs")
    if sha256(uv) != arguments.uv_sha256 or sha256(source / "uv.lock") != arguments.uv_lock_sha256:
        fail("Hermes uv or uv.lock digest differs")

    head = subprocess.run(
        ["git", "--no-optional-locks", "-C", os.fspath(source), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    dirty = subprocess.run(
        ["git", "--no-optional-locks", "-C", os.fspath(source), "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    if head.returncode != 0 or head.stdout.strip() != arguments.source_commit:
        fail("Hermes source commit differs")
    if dirty.returncode != 0 or dirty.stdout:
        fail("Hermes source contains modified, untracked or ignored entries")

    system_python = pathlib.Path(arguments.system_python).resolve(strict=True)
    for current, directories, files in os.walk(runtime, followlinks=False):
        for name in [*directories, *files]:
            path = pathlib.Path(current) / name
            details = os.lstat(path)
            if details.st_uid != arguments.owner_uid:
                fail("Hermes runtime contains an entry owned by another uid")
            if stat.S_ISLNK(details.st_mode):
                resolved = path.resolve(strict=True)
                if resolved != system_python and not inside(resolved, runtime):
                    fail("Hermes runtime symlink escapes the release")
            elif stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode):
                if details.st_mode & 0o222:
                    fail("Hermes runtime contains a writable entry")
            else:
                fail("Hermes runtime contains a special filesystem entry")

    inspect_editable_metadata(venv, source)
    run_import_probe(venv, source, arguments.package_version)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--allowed-root", required=True)
    result.add_argument("--runtime-dir", required=True)
    result.add_argument("--source-commit", required=True)
    result.add_argument("--package-version", required=True)
    result.add_argument("--uv-version", required=True)
    result.add_argument("--uv-target", required=True)
    result.add_argument("--uv-sha256", required=True)
    result.add_argument("--uv-lock-sha256", required=True)
    result.add_argument("--uv-archive-url", required=True)
    result.add_argument("--uv-archive-sha256", required=True)
    result.add_argument("--owner-uid", type=int, default=0)
    result.add_argument("--system-python", default="/usr/bin/python3")
    return result


def main() -> int:
    try:
        verify(parser().parse_args())
        return 0
    except (VerificationError, OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError, SyntaxError):
        print("verify-hermes-runtime: immutable runtime verification failed", file=sys.stderr)
        return 78


if __name__ == "__main__":
    raise SystemExit(main())
