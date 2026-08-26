#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker
from manifest_lib import safe_schema_diagnostic, schema_error_sort_key


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
    key=schema_error_sort_key,
)
if errors:
    fail("; ".join(safe_schema_diagnostic(error) for error in errors))

# The fleet matrix drives the real gateway, the real store and the packaged adapters against
# harness doubles. Nothing in it touches apps/console, so it is bound to the runtime domain only:
# a console edit must not invalidate a 15-alias fleet run. See ops/scripts/source-digest.py.
current_source = subprocess.run(
    [sys.executable, str(ROOT / "ops" / "scripts" / "source-digest.py"), "--domain", "runtime"],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
if report["sourceDigest"] != current_source:
    fail("sourceDigest does not match current runtime-domain sources")
if report["sourceDigestDomain"] != "runtime":
    fail("fleet evidence must declare the runtime source domain")
if report["summary"] != {"aliases": 15, "passed": 15, "failed": 0}:
    fail("the exact 15-alias matrix did not pass")
if any(item["status"] != "passed" or not all(item["checks"].values()) for item in report["aliases"]):
    fail("an alias has a failed required check")

manifest_lines: list[str] = []
manifest_aliases: set[str] = set()
for path in sorted((ROOT / "ops" / "manifests").glob("*.yaml")):
    alias = path.stem
    manifest_aliases.add(alias)
    manifest_lines.append(f"{digest(path)}  {alias}")
result_aliases = {item["alias"] for item in report["aliases"]}
if len(manifest_aliases) != 15 or len(result_aliases) != 15 or result_aliases != manifest_aliases:
    fail("alias results do not match the exact 15-manifest fleet")
manifest_digest = hashlib.sha256("\n".join(manifest_lines).encode()).hexdigest()
if report["manifestMatrix"]["manifestsSha256"] != manifest_digest:
    fail("manifest matrix digest does not match the 15 current manifests")

binary_digests: dict[str, str] = {}
for binary in report["adapterBinaries"]:
    path = ROOT / binary["path"]
    if not path.is_file() or digest(path) != binary["sha256"]:
        fail(f"packaged adapter digest differs: {binary['path']}")
    binary_digests[binary["path"]] = binary["sha256"]

try:
    binary_lines = [
        line for line in (ARTIFACTS / "binaries.sha256").read_text(encoding="utf-8").splitlines()
        if line
    ]
except OSError as error:
    fail(str(error))
observed_binary_digests: dict[str, str] = {}
for line in binary_lines:
    parts = line.split("  ", 1)
    if (len(parts) != 2 or len(parts[0]) != 64
            or any(character not in "0123456789abcdef" for character in parts[0])):
        fail("binaries.sha256 has an invalid line")
    checksum, name = parts
    if name in observed_binary_digests:
        fail("binaries.sha256 has a duplicate path")
    observed_binary_digests[name] = checksum
if observed_binary_digests != binary_digests:
    fail("binaries.sha256 does not match the five packaged adapter digests")

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

print("fleet-release evidence passed: 15 manifests, 5 packaged adapters, source/SHA bound")
