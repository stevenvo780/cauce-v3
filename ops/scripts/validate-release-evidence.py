#!/usr/bin/env python3
from __future__ import annotations

import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
ERRORS: list[str] = []
FINAL_SERVICES = {"gateway", "dispatcher", "relay-worker", "telegram-bridge", "shadow-router"}
REQUIRED_FAULTS = {"gateway-process-kill", "postgres-container-kill"}


def load(path: pathlib.Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("root is not an object")
        return value
    except (OSError, ValueError, json.JSONDecodeError) as error:
        ERRORS.append(f"{path}: {error}")
        return {}


def validate_schema(instance: dict, schema_name: str, label: str) -> bool:
    schema = load(OPS / "schemas" / schema_name)
    if not instance or not schema:
        return False
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    failures = sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path))
    for failure in failures:
        location = ".".join(str(part) for part in failure.absolute_path) or "<root>"
        ERRORS.append(f"{label}.{location}: {failure.message}")
    return not failures


def timestamp(value: str, label: str) -> datetime.datetime | None:
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone is required")
        return parsed.astimezone(datetime.timezone.utc)
    except (AttributeError, ValueError) as error:
        ERRORS.append(f"{label}: invalid timestamp: {error}")
        return None


build_path = OPS / "artifacts" / "release" / "build.json"
report_path = OPS / "artifacts" / "compose-authentic" / "report.json"
build = load(build_path)
report = load(report_path)
build_valid = validate_schema(build, "build-evidence.schema.json", "build")
report_valid = validate_schema(report, "test-evidence.schema.json", "compose-authentic")

if build_valid:
    expected_dockerfile = f"sha256:{hashlib.sha256((ROOT / 'deploy' / 'Dockerfile').read_bytes()).hexdigest()}"
    if build["dockerfileSha256"] != expected_dockerfile:
        ERRORS.append("build.dockerfileSha256 does not match the current Dockerfile")
    current_source = subprocess.run(
        [sys.executable, str(OPS / "scripts" / "source-digest.py")],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if build["sourceDigest"] != current_source:
        ERRORS.append("build.sourceDigest does not match current final-image sources")
    current_operations = subprocess.run(
        [sys.executable, str(OPS / "scripts" / "container_ops_digest.py")],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if build["operationsDigest"] != current_operations:
        ERRORS.append("build.operationsDigest does not match the current container operational sources")
    checked_in_operations = (OPS / "generated" / "container-systemd" / "OPERATIONS.sha256").read_text(encoding="utf-8").strip()
    if build["operationsDigest"] != checked_in_operations:
        ERRORS.append("build.operationsDigest differs from the checked-in OPERATIONS.sha256 release artifact")
    if build["imageDigest"] != build["runtime"]["imageDigest"]:
        ERRORS.append("build top-level imageDigest must equal runtime.imageDigest")
    if build["runtime"]["imageId"] != build["runtime"]["imageDigest"]:
        ERRORS.append("build runtime imageId/imageDigest differ")
    if build["console"]["imageId"] != build["console"]["imageDigest"]:
        ERRORS.append("build console imageId/imageDigest differ")
    started = timestamp(build["timestamps"]["startedAt"], "build.timestamps.startedAt")
    finished = timestamp(build["timestamps"]["finishedAt"], "build.timestamps.finishedAt")
    if started and finished:
        if finished < started:
            ERRORS.append("build timestamps are reversed")
        if datetime.datetime.now(datetime.timezone.utc) - finished > datetime.timedelta(days=7):
            ERRORS.append("build evidence is older than seven days")

if report_valid:
    if report["mode"] != "compose-authentic" or report["evidenceClass"] != "compose-authentic":
        ERRORS.append("release requires compose-authentic evidence; runtime-authentic is local fallback only")
    if report["mechanism"] != "docker-compose-final-binaries":
        ERRORS.append("release evidence was not produced by Docker Compose final binaries")
    summary = report["summary"]
    tests = report["tests"]
    counts = {
        "tests": len(tests),
        "passed": sum(item["status"] == "passed" for item in tests),
        "failed": sum(item["status"] == "failed" for item in tests),
        "skipped": sum(item["status"] == "skipped" for item in tests),
        "criticalSkipped": sum(item["critical"] and item["status"] == "skipped" for item in tests),
        "protocolDouble": sum(item["evidenceClass"] == "protocol-double" for item in tests),
        "authentic": sum(item["status"] == "passed" and item["evidenceClass"] != "protocol-double" for item in tests),
        "real": sum(item["status"] == "passed" and item["evidenceClass"] != "protocol-double" for item in tests),
    }
    for name, expected in counts.items():
        if summary[name] != expected:
            ERRORS.append(f"compose-authentic.summary.{name} is {summary[name]}, expected {expected}")
    if summary["failed"] != 0 or summary["skipped"] != 0 or summary["criticalSkipped"] != 0:
        ERRORS.append("compose-authentic has failures, skips, or critical skips")
    if any(item["critical"] and item["status"] != "passed" for item in tests):
        ERRORS.append("every critical compose-authentic test must pass")
    if any(item["evidenceClass"] == "protocol-double" and item["status"] == "passed"
           for item in tests) and summary["protocolDouble"] == 0:
        ERRORS.append("protocol-double evidence was incorrectly omitted from its counter")
    if any(item["imageDigest"] != report["imageDigest"] for item in tests):
        ERRORS.append("a test is not tied to the report imageDigest")
    if any(item["sourceDigest"] != report["sourceDigest"] for item in tests):
        ERRORS.append("a test is not tied to the report sourceDigest")
    mechanisms = {item["mechanism"] for item in tests if item["critical"] and item["status"] == "passed"}
    missing_faults = sorted(REQUIRED_FAULTS - mechanisms)
    if missing_faults:
        ERRORS.append(f"missing required authentic fault mechanisms: {', '.join(missing_faults)}")
    services = report["deployment"]["services"]
    names = {item["name"] for item in services}
    if names != FINAL_SERVICES or len(services) != len(FINAL_SERVICES):
        ERRORS.append("deployment must contain each of the five final runtime services exactly once")
    if any(item["imageDigest"] != report["imageDigest"] for item in services):
        ERRORS.append("a deployed final service differs from report.imageDigest")
    started = timestamp(report["timestamps"]["startedAt"], "compose-authentic.timestamps.startedAt")
    finished = timestamp(report["timestamps"]["finishedAt"], "compose-authentic.timestamps.finishedAt")
    if started and finished and finished < started:
        ERRORS.append("compose-authentic timestamps are reversed")

if build_valid and report_valid:
    if report["imageDigest"] != build["runtime"]["imageDigest"]:
        ERRORS.append("compose-authentic imageDigest differs from the release runtime build")
    if report["sourceDigest"] != build["sourceDigest"]:
        ERRORS.append("compose-authentic sourceDigest differs from the release build")

if ERRORS:
    for error in ERRORS:
        print(f"release evidence failed: {error}", file=sys.stderr)
    raise SystemExit(1)
print("release evidence passed: one final image, compose-authentic faults, zero critical skips")
