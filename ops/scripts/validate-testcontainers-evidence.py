#!/usr/bin/env python3
"""Validate one complete Testcontainers run and its source/image/harness bindings."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import stat
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")


class EvidenceError(ValueError):
    pass


def load_regular(path: pathlib.Path, maximum: int) -> bytes:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_size > maximum:
        raise EvidenceError(f"{path.name} is not a bounded regular file")
    content = path.read_bytes()
    after = path.lstat()
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
        metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns,
    ):
        raise EvidenceError(f"{path.name} changed while reading")
    return content


def source_digest(domain: str) -> str:
    value = subprocess.run(
        [sys.executable, str(OPS / "scripts" / "source-digest.py"), "--domain", domain],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if DIGEST.fullmatch(value) is None:
        raise EvidenceError(f"current {domain} digest is invalid")
    return value


def verify_manifest(directory: pathlib.Path) -> None:
    manifest = load_regular(directory / "SHA256SUMS", 4096).decode("ascii")
    expected: dict[str, str] = {}
    for line in manifest.splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  (report\.json|junit\.xml)", line)
        if match is None or match.group(2) in expected:
            raise EvidenceError("Testcontainers SHA256SUMS is malformed")
        expected[match.group(2)] = match.group(1)
    if set(expected) != {"report.json", "junit.xml"}:
        raise EvidenceError("Testcontainers SHA256SUMS is incomplete")
    for name, digest in expected.items():
        observed = hashlib.sha256(load_regular(directory / name, 8 * 1024 * 1024)).hexdigest()
        if observed != digest:
            raise EvidenceError(f"Testcontainers {name} differs from SHA256SUMS")


def instant(value: object, label: str) -> datetime.datetime:
    if not isinstance(value, str):
        raise EvidenceError(f"{label} is not a timestamp")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceError(f"{label} is not a timestamp") from error
    if parsed.tzinfo is None:
        raise EvidenceError(f"{label} lacks a timezone")
    return parsed


def validate(run_directory: pathlib.Path) -> None:
    if not run_directory.is_absolute():
        raise EvidenceError("run directory must be absolute")
    schema = json.loads((OPS / "schemas" / "testcontainers-evidence.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    runtime_digest = source_digest("runtime")
    harness_digest = source_digest("testcontainers")
    reports: list[dict[str, object]] = []
    for name, suite in (("real", "cauce-v3-real-e2e"), ("restarts", "cauce-v3-restart-e2e")):
        directory = run_directory / name
        verify_manifest(directory)
        try:
            report = json.loads(load_regular(directory / "report.json", 8 * 1024 * 1024))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise EvidenceError(f"{name} report is not UTF-8 JSON") from error
        failures = sorted(validator.iter_errors(report), key=lambda item: list(item.absolute_path))
        if failures:
            location = ".".join(map(str, failures[0].absolute_path)) or "<root>"
            raise EvidenceError(f"{name} report schema failed at {location}")
        if report.get("suite") != suite:
            raise EvidenceError(f"{name} report has another suite")
        if report.get("sourceDigest") != runtime_digest or report.get("sourceDigestDomain") != "runtime":
            raise EvidenceError(f"{name} report differs from current runtime sources")
        if report.get("harnessDigest") != harness_digest or report.get("harnessDigestDomain") != "testcontainers":
            raise EvidenceError(f"{name} report differs from current Testcontainers harness")
        tests = report["tests"]
        summary = report["summary"]
        if summary["tests"] != len(tests) or summary["passed"] != len(tests):
            raise EvidenceError(f"{name} summary is not the exact all-passing test set")
        if instant(report["finishedAt"], f"{name}.finishedAt") < instant(report["startedAt"], f"{name}.startedAt"):
            raise EvidenceError(f"{name} report finishes before it starts")
        reports.append(report)
    if reports[0]["databaseImage"] != reports[1]["databaseImage"]:
        raise EvidenceError("real and restart reports exercised different Testcontainers images")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=pathlib.Path)
    arguments = parser.parse_args(argv)
    try:
        validate(arguments.run_dir.resolve())
    except (OSError, EvidenceError, subprocess.CalledProcessError) as error:
        print(f"Testcontainers evidence failed: {error}", file=sys.stderr)
        return 1
    print("Testcontainers evidence passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
