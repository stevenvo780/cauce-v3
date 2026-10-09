#!/usr/bin/env python3
"""Publish one alias's Telegram bridge config row and bot token so the two never disagree.

The generator builds the next config.json in a private scratch copy; the token destination is
read back from the row it emitted, so the writer and the generator agree by construction. The
token lands at <runtime>/<tenant>/<alias>.token; while any config still names the flat
<runtime>/<alias>.token, a hard link keeps that path on the same inode. The live config.json is
replaced atomically only after the token exists (and, with --preflight, after the secret-free
cutover preflight passes), so a bridge restart never meets a row whose token is missing.
Token bytes are never printed, logged or passed on a command line.
"""
from __future__ import annotations

import argparse
import contextlib
import getpass
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import tempfile
from typing import Any

SCRIPTS = pathlib.Path(__file__).resolve().parent
TOKEN_RE = re.compile(r"^[0-9]{6,20}:[A-Za-z0-9_-]{20,200}$")
TOKEN_MODE = 0o600
DIRECTORY_MODE = 0o750
NEW_CONFIG_MODE = 0o640


class PublishError(Exception):
    """Raised when the alias cannot be published without breaking the bridge."""


def _load(name: str) -> Any:
    path = SCRIPTS / name
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GENERATOR = _load("generate-telegram-config.py")
MOUNT = pathlib.PurePosixPath(GENERATOR.DEFAULT_RUNTIME_DIR)


def _owner(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"([0-9]{1,10}):([0-9]{1,10})", value)
    if match is None:
        raise argparse.ArgumentTypeError("owner must be UID:GID")
    return int(match.group(1)), int(match.group(2))


def _is_flat(row: Any) -> bool:
    return isinstance(row, dict) and pathlib.PurePosixPath(str(row.get("token_file", ""))).parent == MOUNT


def token_destination(document: dict[str, Any], alias: str, runtime: pathlib.Path) -> tuple[pathlib.Path, dict]:
    """Host path of the token_file the generator emitted for this alias."""
    rows = [row for row in document["aliases"] if pathlib.PurePosixPath(row["token_file"]).name == f"{alias}.token"]
    if len(rows) != 1:
        raise PublishError(f"the generated config has {len(rows)} rows for {alias}.token")
    relative = pathlib.PurePosixPath(rows[0]["token_file"]).relative_to(MOUNT)
    if len(relative.parts) != 2 or relative.parts[0] != rows[0]["tenant_id"]:
        raise PublishError("the generator did not emit the <tenant>/<alias>.token layout")
    return runtime.joinpath(*relative.parts), rows[0]


def _fsync_directory(directory: pathlib.Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _hand_over(descriptor: int, owner: tuple[int, int], label: str) -> None:
    details = os.fstat(descriptor)
    if (details.st_uid, details.st_gid) == owner:
        return
    try:
        os.fchown(descriptor, *owner)
    except PermissionError as exc:
        raise PublishError(f"cannot hand {label} to {owner[0]}:{owner[1]}; run as root or as that user") from exc


def _directory(path: pathlib.Path, owner: tuple[int, int], *, enforce: bool) -> None:
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise PublishError(f"{path} must be a real directory")
    if not path.exists():
        path.mkdir(mode=DIRECTORY_MODE)
        enforce = True
    if enforce:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fchmod(descriptor, DIRECTORY_MODE)
            _hand_over(descriptor, owner, str(path))
        finally:
            os.close(descriptor)


def _atomic_bytes(destination: pathlib.Path, body: bytes, mode: int, owner: tuple[int, int]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        os.fchmod(descriptor, mode)
        _hand_over(descriptor, owner, str(destination))
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        pathlib.Path(temporary).unlink(missing_ok=True)


def usable_token(path: pathlib.Path) -> bool:
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(details.st_mode) and details.st_size > 0 and stat.S_IMODE(details.st_mode) == TOKEN_MODE


def _read_token(args: argparse.Namespace, alias: str) -> str:
    if args.token_file is not None:
        try:
            token = args.token_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise PublishError(f"cannot read the token file {args.token_file}") from exc
    elif args.token_stdin:
        token = sys.stdin.readline().strip()
    else:
        try:
            with open("/dev/tty", encoding="utf-8"):
                pass
        except OSError as exc:
            raise PublishError("the token is missing: run from a terminal or pass --token-file") from exc
        token = getpass.getpass(f"BotFather token for {alias} (hidden): ", stream=sys.stderr).strip()
    if TOKEN_RE.fullmatch(token) is None:
        raise PublishError("the value does not look like a BotFather token; nothing was written")
    return token


def hard_link(source: pathlib.Path, name: pathlib.Path) -> bool:
    """Make `name` another link of the source inode; False when it already was."""
    if name.exists() and not name.is_symlink() and os.path.samestat(name.lstat(), source.lstat()):
        return False
    temporary = name.with_name(f".{name.name}.link-{os.getpid()}")
    temporary.unlink(missing_ok=True)
    os.link(source, temporary)
    os.replace(temporary, name)
    _fsync_directory(name.parent)
    return True


def _generate(args: argparse.Namespace, live: pathlib.Path, scratch: pathlib.Path) -> tuple[dict, bytes]:
    draft = scratch / "config.json"
    if live.exists():
        shutil.copyfile(live, draft)
    argv = ["--ops-dir", str(args.ops_dir), "--aliases", args.alias, "--output", str(draft)]
    if args.allowlist_file is not None:
        argv += ["--allowlist-file", str(args.allowlist_file)]
    argv += ["--reuse-existing-allowlist"] if args.reuse_existing_allowlist else []
    argv += ["--no-cross-check"] if args.no_cross_check else []
    with contextlib.redirect_stdout(sys.stderr):
        if GENERATOR.main(argv) != 0:
            raise PublishError("generate-telegram-config.py rejected the alias; nothing was written")
    body = draft.read_bytes()
    return json.loads(body), body


def publish(args: argparse.Namespace) -> list[str]:
    runtime = args.runtime_dir
    if not runtime.is_absolute() or runtime.is_symlink():
        raise PublishError("--runtime-dir must be an absolute, real directory")
    live = runtime / "config.json"
    previous = json.loads(live.read_text(encoding="utf-8")) if live.exists() else {"aliases": []}
    with tempfile.TemporaryDirectory(prefix="cauce-telegram-") as scratch:
        document, body = _generate(args, live, pathlib.Path(scratch))
        token, row = token_destination(document, args.alias, runtime)
        flat = runtime / f"{args.alias}.token"
        flat_layout = any(_is_flat(entry) for entry in previous["aliases"] + document["aliases"])
        report = [f"config: {live} (alias={row['alias']} tenant={row['tenant_id']})"]
        if args.dry_run:
            state = "present" if usable_token(token) else "adopt flat" if usable_token(flat) else "ask"
            report += [f"would publish token: {token} ({state})",
                       f"would keep flat link: {flat}" if flat_layout or flat.exists() else "flat link: not needed"]
            return report
        _directory(runtime, args.owner, enforce=False)
        _directory(token.parent, args.owner, enforce=True)
        explicit = args.token_file is not None or args.token_stdin
        if not explicit and usable_token(token):
            report.append(f"token: {token} (kept)")
        elif not explicit and usable_token(flat):
            hard_link(flat, token)
            report.append(f"token: {token} (adopted from the flat layout)")
        else:
            _atomic_bytes(token, _read_token(args, args.alias).encode("utf-8"), TOKEN_MODE, args.owner)
            report.append(f"token: {token} (written)")
        if flat_layout or flat.exists() or flat.is_symlink():
            linked = hard_link(token, flat)
            report.append(f"flat link: {flat} ({'linked' if linked else 'already the same inode'})")
        if args.preflight:
            preflight = _load("telegram-cutover-preflight.py")
            try:
                result = preflight.run(pathlib.Path(scratch) / "config.json", [row["alias"]], runtime_dir=runtime,
                                       expected_uid=args.expected_uid)
            except preflight.PreflightError as exc:
                raise PublishError(f"preflight failed; config.json untouched: {exc}") from exc
            if not result["ok"]:
                findings = [finding for entry in result["aliases"] for finding in entry["findings"]]
                raise PublishError("preflight failed; config.json untouched: " + "; ".join(findings))
        mode = stat.S_IMODE(live.stat().st_mode) if live.exists() else NEW_CONFIG_MODE
        _atomic_bytes(live, body, mode, args.owner)
        report.append(f"config.json replaced ({len(document['aliases'])} aliases)")
    return report


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="publish-telegram-token.py", description=__doc__.splitlines()[0])
    parser.add_argument("--runtime-dir", type=pathlib.Path, required=True, help="host dir mounted at /run/cauce-telegram")
    parser.add_argument("--alias", required=True, help="fleet key of the alias to publish")
    parser.add_argument("--ops-dir", type=pathlib.Path, default=SCRIPTS.parent)
    parser.add_argument("--owner", type=_owner, default=(1000, 1000), help="service UID:GID (default 1000:1000)")
    parser.add_argument("--allowlist-file", type=pathlib.Path)
    parser.add_argument("--reuse-existing-allowlist", action="store_true")
    parser.add_argument("--no-cross-check", action="store_true", help=argparse.SUPPRESS)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--token-file", type=pathlib.Path, help="rotate: read the new token from this file")
    source.add_argument("--token-stdin", action="store_true", help="rotate: read the new token from stdin")
    parser.add_argument("--preflight", action="store_true", help="run telegram-cutover-preflight before the swap")
    parser.add_argument("--expected-uid", type=int, help="preflight token owner (default: the --owner uid)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.expected_uid is None:
        args.expected_uid = args.owner[0]
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        for line in publish(args):
            print(line)
    except (PublishError, OSError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
