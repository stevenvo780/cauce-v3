#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from typing import Any

from atomic_file import atomic_write
from fleet_derive import manifest_doc

OPS_ROOT = pathlib.Path(__file__).resolve().parents[1]
ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]*$")
PLAIN_SCALAR_RE = re.compile(r"^[A-Za-z0-9._:/-]+$")


class GeneratorError(ValueError):
    pass


def load_fleet(path: pathlib.Path) -> dict[str, dict[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GeneratorError(f"cannot read fleet snapshot {path}: {error}") from error
    if not isinstance(document, dict) or document.get("schemaVersion") != 1:
        raise GeneratorError("fleet snapshot must use schemaVersion 1")
    fleet = document.get("fleet")
    if not isinstance(fleet, dict) or not fleet:
        raise GeneratorError("fleet snapshot must contain a non-empty fleet object")
    for alias, row in fleet.items():
        if not isinstance(alias, str) or not ALIAS_RE.fullmatch(alias):
            raise GeneratorError(f"fleet contains an invalid manifest alias: {alias!r}")
        if not isinstance(row, dict) or row.get("enabled") is not True:
            raise GeneratorError(f"fleet.{alias} must be an enabled agent object")
        for field in ("tenant", "room", "harness"):
            value = row.get(field)
            if not isinstance(value, str) or not PLAIN_SCALAR_RE.fullmatch(value):
                raise GeneratorError(f"fleet.{alias}.{field} is not a safe plain YAML scalar")
        home = row.get("home")
        if (
            not isinstance(home, str)
            or not home.startswith("/")
            or not PLAIN_SCALAR_RE.fullmatch(home)
            or str(pathlib.PurePosixPath(home)) != home
        ):
            raise GeneratorError(f"fleet.{alias}.home is not a canonical absolute path")
    return fleet


def render_manifest(alias: str, row: dict[str, Any]) -> str:
    document = manifest_doc(alias, row)
    spec = document["spec"]
    profile = spec["profile"]
    profile_text = "{seedOnConnect: true, configScope: alias"
    if "workspace" in profile:
        profile_text += f", workspace: {profile['workspace']}"
    profile_text += "}"
    process = spec["process"]
    if spec["harness"] == "hermes":
        process_text = (
            "  process:\n"
            f"    executablePathEnv: {process['executablePathEnv']}\n"
            f"    operationalModelEnv: {process['operationalModelEnv']}"
        )
    elif spec["harness"] == "claude":
        process_text = f"  process:\n    executablePathEnv: {process['executablePathEnv']}"
    else:
        process_text = f"  process: {{executablePathEnv: {process['executablePathEnv']}}}"
    secrets = spec["secretPathEnv"]
    return f"""apiVersion: {document["apiVersion"]}
kind: {document["kind"]}
metadata:
  name: {document["metadata"]["name"]}
spec:
  tenant: {spec["tenant"]}
  room: {spec["room"]}
  alias: {spec["alias"]}
  harness: {spec["harness"]}
  profile: {profile_text}
  origin: {{transport: {spec["origin"]["transport"]}}}
  relay: {{urlPathEnv: {spec["relay"]["urlPathEnv"]}, requiredScheme: {spec["relay"]["requiredScheme"]}}}
  secretPathEnv:
    token: {secrets["token"]}
    clientCertificate: {secrets["clientCertificate"]}
    clientKey: {secrets["clientKey"]}
    certificateAuthority: {secrets["certificateAuthority"]}
{process_text}
  stateDirectory: {spec["stateDirectory"]}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate alias manifests from the fleet snapshot")
    parser.add_argument("--snapshot", type=pathlib.Path, default=OPS_ROOT / "flota.json")
    parser.add_argument("--output", type=pathlib.Path, default=OPS_ROOT / "manifests")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        fleet = load_fleet(args.snapshot)
        rendered = {alias: render_manifest(alias, fleet[alias]) for alias in sorted(fleet)}
        args.output.mkdir(parents=True, exist_ok=True)
        for alias, body in rendered.items():
            destination = args.output / f"{alias}.yaml"
            atomic_write(destination, body)
            print(destination)
        expected = set(fleet)
        for stale in sorted(args.output.glob("*.yaml")):
            if stale.stem not in expected:
                stale.unlink()
                print(f"retired {stale}")
    except (GeneratorError, KeyError, TypeError, ValueError) as error:
        print(f"manifest generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
