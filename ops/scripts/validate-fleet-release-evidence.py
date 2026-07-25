#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "tests" / "fleet-release" / "artifacts"
SCHEMA = ROOT / "tests" / "fleet-release" / "fleet-release-report.schema.json"


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(message: str) -> None:
    raise SystemExit(f"fleet-release evidence failed: {message}")


try:
    report = json.loads((ARTIFACTS / "report.json").read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    fail(str(error))

errors = sorted(
    Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(report),
    key=lambda item: list(item.absolute_path),
)
if errors:
    fail("; ".join(
        f"{'.'.join(map(str, error.absolute_path)) or '<root>'}: {error.message}"
        for error in errors
    ))

current_source = subprocess.run(
    [sys.executable, str(ROOT / "ops" / "scripts" / "source-digest.py")],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
if report["sourceDigest"] != current_source:
    fail("sourceDigest does not match current final-image sources")
if report["summary"] != {"aliases": 14, "passed": 14, "failed": 0}:
    fail("the exact 14-alias matrix did not pass")
if len({item["alias"] for item in report["aliases"]}) != 14:
    fail("alias results are not unique")
if any(item["status"] != "passed" or not all(item["checks"].values()) for item in report["aliases"]):
    fail("an alias has a failed required check")

manifest_lines: list[str] = []
for path in sorted((ROOT / "ops" / "manifests").glob("*.yaml")):
    alias = path.stem
    manifest_lines.append(f"{digest(path)}  {alias}")
manifest_digest = hashlib.sha256("\n".join(manifest_lines).encode()).hexdigest()
if report["manifestMatrix"]["manifestsSha256"] != manifest_digest:
    fail("manifest matrix digest does not match the 14 current manifests")

for binary in report["adapterBinaries"]:
    path = ROOT / binary["path"]
    if not path.is_file() or digest(path) != binary["sha256"]:
        fail(f"packaged adapter digest differs: {binary['path']}")

manifest_path = ARTIFACTS / "SHA256SUMS"
try:
    lines = [line for line in manifest_path.read_text(encoding="utf-8").splitlines() if line]
except OSError as error:
    fail(str(error))
expected_names = {"report.json", "junit.xml", "binaries.sha256"}
observed_names: set[str] = set()
for line in lines:
    parts = line.split("  ", 1)
    if len(parts) != 2 or not all(character in "0123456789abcdef" for character in parts[0]) or len(parts[0]) != 64:
        fail("SHA256SUMS has an invalid line")
    checksum, name = parts
    if name in observed_names or name not in expected_names:
        fail("SHA256SUMS has duplicate or unexpected paths")
    observed_names.add(name)
    if digest(ARTIFACTS / name) != checksum:
        fail(f"SHA256SUMS mismatch for {name}")
if observed_names != expected_names:
    fail("SHA256SUMS does not cover the exact fleet artifact set")

print("fleet-release evidence passed: 14 manifests, 5 packaged adapters, source/SHA bound")
