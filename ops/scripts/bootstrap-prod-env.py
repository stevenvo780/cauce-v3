#!/usr/bin/env python3
"""Build a mode-0600 production env from an explicit private reference file.

The input and output are parsed/written as data and no values are printed.  This deliberately does
not inspect container environments or shell history: if the operator cannot name an authorized
source for a reference, bootstrap fails instead of guessing it.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import stat
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_TEMPLATE = ROOT / "ops" / "config" / "prod.env.example"
KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")
DIGEST_IMAGE = re.compile(r"^.+@sha256:[a-f0-9]{64}$")


class BootstrapError(ValueError):
    pass


def parse_env(path: pathlib.Path, label: str) -> tuple[list[str], dict[str, str]]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise BootstrapError(f"{label} is unreadable") from error
    order: list[str] = []
    values: dict[str, str] = {}
    for number, raw_line in enumerate(raw.splitlines(), start=1):
        line = raw_line.removesuffix("\r")
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise BootstrapError(f"{label} line {number} is not KEY=VALUE")
        key, value = line.split("=", 1)
        if not KEY.fullmatch(key):
            raise BootstrapError(f"{label} line {number} has an invalid key")
        if key in values:
            raise BootstrapError(f"{label} contains duplicate key {key}")
        if any(ord(character) < 32 and character != "\t" for character in value):
            raise BootstrapError(f"{label} value for {key} contains a control character")
        order.append(key)
        values[key] = value
    return order, values


def private_regular_file(path: pathlib.Path, label: str) -> None:
    if not path.is_absolute() or path.is_symlink():
        raise BootstrapError(f"{label} must be an absolute regular non-symlink file")
    try:
        metadata = path.stat()
    except OSError as error:
        raise BootstrapError(f"{label} must be an absolute regular non-symlink file") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise BootstrapError(f"{label} must be an absolute regular non-symlink file")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise BootstrapError(f"{label} must not be accessible by group or other users")
    if metadata.st_uid not in {0, os.geteuid()}:
        raise BootstrapError(f"{label} must be owned by root or the invoking user")


def nonempty(values: dict[str, str], key: str) -> str:
    value = values.get(key, "")
    if not value:
        raise BootstrapError(f"authorized references do not resolve required key {key}")
    return value


def validate(values: dict[str, str]) -> None:
    manifest = pathlib.Path(nonempty(values, "CAUCE_COMPOSE_OVERRIDE_MANIFEST"))
    if not manifest.is_absolute() or manifest.is_symlink() or not manifest.is_file():
        raise BootstrapError("CAUCE_COMPOSE_OVERRIDE_MANIFEST must reference an absolute regular manifest")
    local_postgres = nonempty(values, "CAUCE_LOCAL_POSTGRES")
    if local_postgres not in {"0", "1"}:
        raise BootstrapError("CAUCE_LOCAL_POSTGRES must be 0 or 1")

    profiles = {item.strip() for item in nonempty(values, "COMPOSE_PROFILES").split(",") if item.strip()}
    image_keys = ["CAUCE_RUNTIME_IMAGE", "CAUCE_CONSOLE_IMAGE"]
    if "observability" in profiles:
        image_keys.extend(["CAUCE_OTEL_IMAGE", "CAUCE_PROMETHEUS_IMAGE"])
    if local_postgres == "1":
        image_keys.append("CAUCE_POSTGRES_IMAGE")
    for key in image_keys:
        if not DIGEST_IMAGE.fullmatch(nonempty(values, key)):
            raise BootstrapError(f"{key} must be an immutable @sha256 reference")

    if nonempty(values, "CAUCE_TERMINAL_ENABLED") != "1":
        raise BootstrapError("this release requires CAUCE_TERMINAL_ENABLED=1")
    terminal_required = (
        "CAUCE_TERMINAL_CONFIG_DIR",
        "CAUCE_TERMINAL_TICKET_KEY_PATH",
        "CAUCE_TERMINAL_RELAY_TOKEN_PATH",
        "CAUCE_TERMINAL_RELAY_URL",
        "CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH",
        "CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH",
        "CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH",
        "CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_PATH",
        "CAUCE_TERMINAL_RELAY_TLS_CERT_PATH",
        "CAUCE_TERMINAL_RELAY_TLS_KEY_PATH",
    )
    for key in terminal_required:
        nonempty(values, key)


def publish(output: pathlib.Path, content: str) -> None:
    if not output.is_absolute() or output.parent.is_symlink() or not output.parent.is_dir():
        raise BootstrapError("output must be an absolute path in an existing non-symlink directory")
    if output.exists() or output.is_symlink():
        raise BootstrapError("output already exists; refusing to overwrite private configuration")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, output)
        output.chmod(0o600)
    except FileExistsError as error:
        raise BootstrapError("output appeared concurrently; refusing to overwrite it") from error
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authorized-references", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--template", type=pathlib.Path, default=DEFAULT_TEMPLATE)
    arguments = parser.parse_args()
    try:
        private_regular_file(arguments.authorized_references, "authorized reference file")
        template_order, template = parse_env(arguments.template, "template")
        _, authorized = parse_env(arguments.authorized_references, "authorized reference file")
        unknown = sorted(set(authorized) - set(template))
        if unknown:
            raise BootstrapError(f"authorized reference file has unknown keys: {', '.join(unknown)}")
        values = {**template, **authorized}
        validate(values)
        content = "\n".join(f"{key}={values[key]}" for key in template_order) + "\n"
        publish(arguments.output, content)
    except BootstrapError as error:
        print(f"production env bootstrap failed: {error}", file=sys.stderr)
        return 1
    print("production env bootstrap passed: private mode-0600 file published from authorized references")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
