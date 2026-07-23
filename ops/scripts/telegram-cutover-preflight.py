#!/usr/bin/env python3
"""Host-side, secret-free preflight for a Telegram bridge alias cutover.

Before an operator adds an alias to CAUCE_TELEGRAM_ALIASES and recreates the
`telegram` compose profile, this tool proves — WITHOUT reading any token — that the
declarative config, the reused-bot token file and the V2-shutdown marker are all
present and correct, and that they live where the container can actually read them.

It fails closed on the exact conditions that would otherwise let an alias "activate"
while silently dropping every human message or refusing to poll:

  * config.json does not validate against services/telegram-bridge/src/config.ts
    (reuses generate-telegram-config.py's validate_config, the schema mirror).
  * a selected alias is absent from config.json.
  * token_file / v2_shutdown_marker_file are not under the compose mount
    (deploy/compose.yaml binds CAUCE_TELEGRAM_RUNTIME_DIR -> /run/cauce-telegram, ro),
    so the container could never open them.
  * the host token file is missing, a symlink, not mode 0600, or not owned by the
    service uid (config.ts readTelegramToken). Its CONTENTS are never read.
  * the host marker file is missing, a symlink, group/other-writable, or its content
    is not exactly `v2-poller-disabled:<alias>` (config.ts assertV2PollerDisabled).
  * the allowlists are still the generator's shared sentinel placeholders, which the
    poller would treat as "deny everything" (gap G3).

This tool NEVER stops, starts or writes V2; it is read-only and prints no secrets.
Marker content is an operational sentinel, not a credential, and is only compared.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import stat
import sys

SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_MOUNT = "/run/cauce-telegram"
DEFAULT_SERVICE_UID = 1000  # deploy/compose.yaml runtime services run as user "1000:1000"
TOKEN_MODE = 0o600          # config.ts readTelegramToken requires exactly 0600
MARKER_WRITE_MASK = 0o022   # config.ts assertV2PollerDisabled: no group/other write bits


def _load_generator():
    """Import generate-telegram-config.py (hyphenated name) for its schema mirror."""
    path = SCRIPTS_DIR / "generate-telegram-config.py"
    spec = importlib.util.spec_from_file_location("generate_telegram_config", path)
    if not spec or not spec.loader:
        raise PreflightError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PreflightError(Exception):
    """Fatal usage/IO error (distinct from a per-alias validation failure)."""


def _container_to_host(container_path: str, mount: str, runtime_dir: pathlib.Path) -> pathlib.Path:
    mount_root = mount.rstrip("/")
    pure = pathlib.PurePosixPath(container_path)
    try:
        relative = pure.relative_to(mount_root)
    except ValueError as exc:
        raise ValueError(f"{container_path} is not under the compose mount {mount_root}") from exc
    if relative == pathlib.PurePosixPath("."):
        raise ValueError(f"{container_path} must name a file under {mount_root}")
    return runtime_dir / relative


def _check_token(host_path: pathlib.Path, expected_uid: int, findings: list[str]) -> None:
    try:
        info = host_path.lstat()
    except FileNotFoundError:
        findings.append(f"token file missing on host: {host_path}")
        return
    except OSError as exc:
        findings.append(f"token file unreadable: {host_path} ({exc})")
        return
    if stat.S_ISLNK(info.st_mode):
        findings.append(f"token file must not be a symlink: {host_path}")
        return
    if not stat.S_ISREG(info.st_mode):
        findings.append(f"token file must be a regular file: {host_path}")
        return
    if stat.S_IMODE(info.st_mode) != TOKEN_MODE:
        findings.append(f"token file mode must be 0600, found {oct(stat.S_IMODE(info.st_mode))}: {host_path}")
    if expected_uid >= 0 and info.st_uid != expected_uid:
        findings.append(f"token file must be owned by uid {expected_uid}, found {info.st_uid}: {host_path}")
    # Contents are never read: 0600 + ownership are the only host-observable guarantees.


def _check_marker(host_path: pathlib.Path, alias: str, findings: list[str]) -> None:
    try:
        info = host_path.lstat()
    except FileNotFoundError:
        findings.append(f"V2-shutdown marker missing on host: {host_path}")
        return
    except OSError as exc:
        findings.append(f"marker unreadable: {host_path} ({exc})")
        return
    if stat.S_ISLNK(info.st_mode):
        findings.append(f"marker must not be a symlink: {host_path}")
        return
    if not stat.S_ISREG(info.st_mode):
        findings.append(f"marker must be a regular file: {host_path}")
        return
    if stat.S_IMODE(info.st_mode) & MARKER_WRITE_MASK:
        findings.append(f"marker must not be group/other-writable, found {oct(stat.S_IMODE(info.st_mode))}: {host_path}")
    expected = f"v2-poller-disabled:{alias}"
    try:
        content = host_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        findings.append(f"marker unreadable: {host_path} ({exc})")
        return
    if content != expected:
        findings.append(f"marker content must be exactly '{expected}' for {alias}")


def _check_allowlists(row: dict, gen, allow_placeholders: bool, findings: list[str]) -> None:
    sentinels = {gen.PLACEHOLDER_USER_ID, gen.PLACEHOLDER_CHAT_ID}
    for field in ("allowed_user_ids", "allowed_chat_ids"):
        values = row.get(field) or []
        if not allow_placeholders and any(value in sentinels for value in values):
            findings.append(
                f"{field} still contains the sentinel placeholder (the poller would deny all traffic); "
                f"inject real ids via --allowlist-file"
            )


def preflight_alias(
    alias: str,
    config: dict,
    *,
    mount: str,
    runtime_dir: pathlib.Path,
    expected_uid: int,
    allow_placeholders: bool,
) -> dict:
    gen = _PREFLIGHT_GEN
    findings: list[str] = []
    row = next((entry for entry in config["aliases"] if entry.get("alias") == alias), None)
    if row is None:
        return {"alias": alias, "ok": False, "findings": [f"alias '{alias}' is absent from config.json"]}

    for field in ("token_file", "v2_shutdown_marker_file"):
        container_path = row[field]
        try:
            host_path = _container_to_host(container_path, mount, runtime_dir)
        except ValueError as exc:
            findings.append(str(exc))
            continue
        if field == "token_file":
            _check_token(host_path, expected_uid, findings)
        else:
            _check_marker(host_path, alias, findings)

    _check_allowlists(row, gen, allow_placeholders, findings)
    return {"alias": alias, "ok": not findings, "findings": findings}


def run(
    config_path: pathlib.Path,
    selected: list[str] | None,
    *,
    mount: str = DEFAULT_MOUNT,
    runtime_dir: pathlib.Path | None = None,
    expected_uid: int = DEFAULT_SERVICE_UID,
    allow_placeholders: bool = False,
) -> dict:
    gen = _PREFLIGHT_GEN
    try:
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PreflightError(f"cannot read config {config_path}: {exc}") from exc
    try:
        config = gen.validate_config(document)
    except gen.GeneratorError as exc:
        raise PreflightError(f"config.json does not validate against config.ts: {exc}") from exc

    available = [entry["alias"] for entry in config["aliases"]]
    aliases = selected if selected is not None else available
    unknown = [alias for alias in aliases if alias not in available]
    if unknown:
        raise PreflightError(f"selected aliases absent from config: {unknown}; config has {available}")

    resolved_runtime = runtime_dir or config_path.resolve().parent
    results = [
        preflight_alias(
            alias, config, mount=mount, runtime_dir=resolved_runtime,
            expected_uid=expected_uid, allow_placeholders=allow_placeholders,
        )
        for alias in aliases
    ]
    return {
        "config": str(config_path),
        "runtime_dir": str(resolved_runtime),
        "mount": mount,
        "ok": all(result["ok"] for result in results),
        "aliases": results,
    }


def _render_human(report: dict) -> str:
    lines = [
        f"config      : {report['config']}",
        f"runtime dir : {report['runtime_dir']}  (mounted at {report['mount']})",
        "",
    ]
    for result in report["aliases"]:
        status = "PASS" if result["ok"] else "FAIL"
        lines.append(f"[{status}] {result['alias']}")
        for finding in result["findings"]:
            lines.append(f"        - {finding}")
    lines.append("")
    lines.append("RESULT: " + ("PASS — safe to enable the selected alias(es)" if report["ok"]
                                else "FAIL — do NOT enable; resolve the findings above"))
    return "\n".join(lines)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="telegram-cutover-preflight.py",
        description="Secret-free preflight for a Telegram bridge alias cutover.",
    )
    parser.add_argument("--config", type=pathlib.Path, required=True, help="host path to the generated config.json")
    parser.add_argument("--aliases", help="comma-separated aliases to check; default = every alias in config")
    parser.add_argument(
        "--runtime-dir",
        type=pathlib.Path,
        default=os.environ.get("CAUCE_TELEGRAM_RUNTIME_DIR"),
        help="host dir bind-mounted into the container; default = $CAUCE_TELEGRAM_RUNTIME_DIR or the config's dir",
    )
    parser.add_argument("--mount", default=DEFAULT_MOUNT, help=f"container mount for tokens/markers (default {DEFAULT_MOUNT})")
    parser.add_argument(
        "--expected-uid",
        type=int,
        default=DEFAULT_SERVICE_UID,
        help=f"expected token owner uid (default {DEFAULT_SERVICE_UID}; -1 to skip, e.g. userns-remap)",
    )
    parser.add_argument("--allow-placeholders", action="store_true", help="do not fail on sentinel allowlists (unsafe)")
    parser.add_argument("--json", action="store_true", help="emit a machine-readable JSON report")
    return parser.parse_args(argv)


_PREFLIGHT_GEN = _load_generator()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    selected: list[str] | None = None
    if args.aliases is not None:
        selected = [alias.strip() for alias in args.aliases.split(",") if alias.strip()]
        if not selected:
            print("error: --aliases was empty", file=sys.stderr)
            return 2
    try:
        report = run(
            args.config,
            selected,
            mount=args.mount,
            runtime_dir=args.runtime_dir,
            expected_uid=args.expected_uid,
            allow_placeholders=args.allow_placeholders,
        )
    except PreflightError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(_render_human(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
