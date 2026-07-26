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
OUTPUT = OPS / "artifacts" / "release-candidate"
ERRORS: list[str] = []


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: pathlib.Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("root is not an object")
        return value
    except (OSError, ValueError, json.JSONDecodeError) as error:
        ERRORS.append(f"{path.relative_to(ROOT)}: {error}")
        return {}


def schema(instance: dict, schema_path: pathlib.Path, label: str) -> None:
    definition = load(schema_path)
    if not instance or not definition:
        return
    validator = Draft202012Validator(definition, format_checker=FormatChecker())
    for error in sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path)):
        location = ".".join(map(str, error.absolute_path)) or "<root>"
        ERRORS.append(f"{label}.{location}: {error.message}")


def verify_sha_directory(directory: pathlib.Path, expected: set[str]) -> None:
    manifest = directory / "SHA256SUMS"
    try:
        lines = [line for line in manifest.read_text(encoding="utf-8").splitlines() if line]
    except OSError as error:
        ERRORS.append(f"{manifest.relative_to(ROOT)}: {error}")
        return
    observed: set[str] = set()
    for line in lines:
        parts = line.split("  ", 1)
        if len(parts) != 2 or len(parts[0]) != 64 or any(character not in "0123456789abcdef" for character in parts[0]):
            ERRORS.append(f"{manifest.relative_to(ROOT)} has an invalid line")
            continue
        checksum, name = parts
        if name in observed or name not in expected or "/" in name or "\\" in name:
            ERRORS.append(f"{manifest.relative_to(ROOT)} has a duplicate or unexpected path: {name}")
            continue
        observed.add(name)
        path = directory / name
        if not path.is_file() or sha256(path) != checksum:
            ERRORS.append(f"{manifest.relative_to(ROOT)} mismatch: {name}")
    if observed != expected:
        ERRORS.append(f"{manifest.relative_to(ROOT)} does not cover the exact expected artifact set")


def passing_summary(report: dict, label: str, require_critical: bool = False) -> None:
    summary = report.get("summary", {})
    if summary.get("failed") != 0 or summary.get("skipped") != 0:
        ERRORS.append(f"{label} has failures or skips")
    if require_critical and summary.get("criticalSkipped") != 0:
        ERRORS.append(f"{label} has critical skips")


def source_digest_for(domain: str) -> str:
    return subprocess.run(
        [sys.executable, str(OPS / "scripts" / "source-digest.py"), "--domain", domain],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


# Every artifact is compared against the domain that can actually change its result, not against one
# whole-tree digest. Binding runtime fault evidence to apps/console was pure over-coverage: the
# evidence is expensive to regenerate, the console cannot influence it, and the predictable outcome
# was hand-edited evidence. ops/scripts/source-digest.py justifies each domain boundary.
SOURCE_DIGESTS = {domain: source_digest_for(domain) for domain in ("runtime", "console", "harness", "full")}
runtime_source_digest = SOURCE_DIGESTS["runtime"]
full_source_digest = SOURCE_DIGESTS["full"]
# Artifact kind -> the domain whose digest that artifact must carry.
#
# Narrowing an artifact from `full` to a specific domain LOOSENS its binding, so a kind only appears
# with a narrow domain when the causal boundary was actually established. Anything whose boundary has
# not been worked out stays on `full`, the strictest option.
EVIDENCE_DOMAINS = {
    # Three rounds of install/lint/typecheck/build/test really do cover every domain, including
    # lint:console, build:console and tests/gateway-hardening/console-api-contract.test.ts.
    "verification-three-rounds": "full",
    # Fault injection against the five final binaries, and the build that produced them: no file
    # under apps/console can reach the runtime image, so these carry the runtime domain.
    "runtime-authentic": "runtime",
    "compose-authentic": "runtime",
    "release-build": "runtime",
    # Real gateway, real store, packaged adapters, harness doubles. No console involvement.
    "fleet-release": "runtime",
    "testcontainers-real": "runtime",
    "testcontainers-restarts": "runtime",
    # Deliberately left on `full`. The protocol-double contract run and the generated systemd unit
    # manifest are both cheap to regenerate, and neither has had its causal boundary analysed, so
    # they keep the widest binding rather than gaining an unjustified exclusion.
    "mock-contract": "full",
    "systemd-manifest": "full",
}

verification_dir = OPS / "artifacts" / "verification"
build_dir = OPS / "artifacts" / "release"
compose_dir = OPS / "artifacts" / "compose-authentic"
runtime_dir = OPS / "artifacts" / "runtime-authentic"
mock_dir = OPS / "artifacts" / "mock"
fleet_dir = ROOT / "tests" / "fleet-release" / "artifacts"

verification = load(verification_dir / "report.json")
build = load(build_dir / "build.json") if (build_dir / "build.json").is_file() else {}
compose = load(compose_dir / "report.json") if (compose_dir / "report.json").is_file() else {}
runtime = load(runtime_dir / "report.json")
mock = load(mock_dir / "report.json")
fleet = load(fleet_dir / "report.json")

schema(verification, OPS / "schemas" / "verification-evidence.schema.json", "verification")
if build:
    schema(build, OPS / "schemas" / "build-evidence.schema.json", "build")
if compose:
    schema(compose, OPS / "schemas" / "test-evidence.schema.json", "compose-authentic")
schema(runtime, OPS / "schemas" / "test-evidence.schema.json", "runtime-authentic")
schema(fleet, ROOT / "tests" / "fleet-release" / "fleet-release-report.schema.json", "fleet-release")

verify_sha_directory(verification_dir, {"report.json", "junit.xml"})
if build:
    verify_sha_directory(build_dir, {"build.json"})
if compose:
    verify_sha_directory(compose_dir, {"report.json", "junit.xml"})
verify_sha_directory(runtime_dir, {"report.json", "junit.xml"})
verify_sha_directory(mock_dir, {"report.json", "junit.xml"})
verify_sha_directory(fleet_dir, {"report.json", "junit.xml", "binaries.sha256"})

for label, report, domain in (
    ("verification", verification, "full"),
    ("runtime-authentic", runtime, "runtime"),
    ("fleet-release", fleet, "runtime"),
):
    if report.get("sourceDigest") != SOURCE_DIGESTS[domain]:
        ERRORS.append(f"{label} sourceDigest differs from the current {domain}-domain sources")
    if report.get("sourceDigestDomain") != domain:
        ERRORS.append(f"{label} must declare the {domain} source domain")
if compose:
    if compose.get("sourceDigest") != runtime_source_digest:
        ERRORS.append("compose-authentic sourceDigest differs from the current runtime-domain sources")
    if compose.get("sourceDigestDomain") != "runtime":
        ERRORS.append("compose-authentic must declare the runtime source domain")
# Authentic evidence is only meaningful when it is also bound to the apparatus that produced it.
for label, report in (("runtime-authentic", runtime), ("compose-authentic", compose if compose else None)):
    if report is None:
        continue
    if report.get("harnessDigest") != SOURCE_DIGESTS["harness"]:
        ERRORS.append(f"{label} harnessDigest differs from the current authentic harness")
if build:
    if build.get("sourceDigest") != runtime_source_digest:
        ERRORS.append("build sourceDigest differs from the current runtime-domain sources")
    if build.get("sourceDigestDomain") != "runtime":
        ERRORS.append("build must declare the runtime source domain")
    if build.get("console", {}).get("sourceDigest") != SOURCE_DIGESTS["console"]:
        ERRORS.append("build console sourceDigest differs from the current console-domain sources")

final_services = {"gateway", "dispatcher", "relay-worker", "telegram-bridge", "shadow-router"}
runtime_reports = [("runtime-authentic", runtime)]
if compose:
    runtime_reports.append(("compose-authentic", compose))
for label, report in runtime_reports:
    image_digest = report.get("imageDigest")
    services = report.get("deployment", {}).get("services", [])
    if len(services) != 5 or {item.get("name") for item in services} != final_services:
        ERRORS.append(f"{label} does not contain each final service exactly once")
    if any(item.get("imageDigest") != image_digest for item in services):
        ERRORS.append(f"{label} deployed services do not share report.imageDigest")
    tests = report.get("tests", [])
    if any(item.get("sourceDigest") != runtime_source_digest or item.get("imageDigest") != image_digest for item in tests):
        ERRORS.append(f"{label} test evidence is not source/image digest bound")
    if any(item.get("critical") is not True or item.get("status") != "passed" for item in tests):
        ERRORS.append(f"{label} has a non-passing critical test")

passing_summary(verification, "verification", require_critical=True)
if compose:
    passing_summary(compose, "compose-authentic", require_critical=True)
passing_summary(runtime, "runtime-authentic", require_critical=True)
passing_summary(mock, "mock-contract")
if fleet.get("summary") != {"aliases": 14, "passed": 14, "failed": 0}:
    ERRORS.append("fleet-release exact 14-alias matrix did not pass")
if len(fleet.get("adapterBinaries", [])) != 5:
    ERRORS.append("fleet-release does not bind exactly five packaged adapters")
if compose and (compose.get("mode") != "compose-authentic" or compose.get("mechanism") != "docker-compose-final-binaries"):
    ERRORS.append("compose-authentic is not release-class final-binary evidence")
if runtime.get("mode") != "runtime-authentic" or runtime.get("mechanism") != "docker-run-final-binaries":
    ERRORS.append("runtime-authentic fallback evidence is missing or mislabeled")
if build and compose and build.get("runtime", {}).get("imageDigest") != compose.get("imageDigest"):
    ERRORS.append("release build and compose-authentic runtime image digests differ")
if build and runtime and build.get("runtime", {}).get("imageDigest") != runtime.get("imageDigest"):
    ERRORS.append("release build and runtime-authentic image digests differ")
if compose:
    compose_mechanisms = {item.get("mechanism") for item in compose.get("tests", [])}
    if not {"gateway-process-kill", "postgres-container-kill"}.issubset(compose_mechanisms):
        ERRORS.append("compose-authentic lacks the required gateway/PostgreSQL fault mechanisms")

testcontainer_runs = sorted(
    path for path in (OPS / "artifacts" / "testcontainers").glob("*")
    if (path / "real" / "report.json").is_file() and (path / "restarts" / "report.json").is_file()
)
if not testcontainer_runs:
    ERRORS.append("no complete Testcontainers real/restarts evidence exists")
    testcontainers_dir = OPS / "artifacts" / "testcontainers" / "missing"
    real = {}
    restarts = {}
else:
    testcontainers_dir = testcontainer_runs[-1]
    real = load(testcontainers_dir / "real" / "report.json")
    restarts = load(testcontainers_dir / "restarts" / "report.json")
    passing_summary(real, "testcontainers-real", require_critical=True)
    passing_summary(restarts, "testcontainers-restarts")
    verify_sha_directory(testcontainers_dir / "real", {"report.json", "junit.xml"})
    verify_sha_directory(testcontainers_dir / "restarts", {"report.json", "junit.xml"})

unit_directory = OPS / "generated" / "systemd"
units = sorted(unit_directory.glob("cauce-v3-alias-*.service"))
if len(units) != 14:
    ERRORS.append(f"generated systemd fleet has {len(units)} units instead of 14")
verify_sha_directory(unit_directory, {path.name for path in units})

if ERRORS:
    for error in ERRORS:
        print(f"release candidate failed: {error}", file=sys.stderr)
    raise SystemExit(1)

evidence_paths = [
    ("verification-three-rounds", verification_dir / "report.json"),
    ("runtime-authentic", runtime_dir / "report.json"),
    ("fleet-release", fleet_dir / "report.json"),
    ("testcontainers-real", testcontainers_dir / "real" / "report.json"),
    ("testcontainers-restarts", testcontainers_dir / "restarts" / "report.json"),
    ("mock-contract", mock_dir / "report.json"),
    ("systemd-manifest", unit_directory / "SHA256SUMS"),
]
if build:
    evidence_paths.append(("release-build", build_dir / "build.json"))
if compose:
    evidence_paths.append(("compose-authentic", compose_dir / "report.json"))
# A new evidence kind must declare its domain explicitly; defaulting silently is how an artifact
# would end up carrying a digest that has nothing to do with what it measures.
undeclared = sorted({kind for kind, _ in evidence_paths} - set(EVIDENCE_DOMAINS))
if undeclared:
    for kind in undeclared:
        print(f"release candidate failed: evidence kind '{kind}' does not declare a source domain", file=sys.stderr)
    raise SystemExit(1)
evidence = [
    {
        "kind": kind,
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": sha256(path),
        # Each artifact records the digest of ITS domain, so a reader can tell what a given piece of
        # evidence actually depended on instead of assuming it depended on the whole tree.
        "sourceDigest": SOURCE_DIGESTS[EVIDENCE_DOMAINS[kind]],
        "sourceDigestDomain": EVIDENCE_DOMAINS[kind],
    }
    for kind, path in evidence_paths
]
checks = [
    {"name": "frozen install, lint, global typecheck and build", "status": "passed", "evidenceKind": "verification-three-rounds"},
    {"name": "all standard suites passed three rounds without skips", "status": "passed", "evidenceKind": "verification-three-rounds"},
    {"name": "14 manifests and five packaged adapters passed fleet release", "status": "passed", "evidenceKind": "fleet-release"},
    {"name": "Testcontainers real QA and restart durability passed", "status": "passed", "evidenceKind": "testcontainers-real"},
    {"name": "mock contract evidence remained separate", "status": "passed", "evidenceKind": "mock-contract"},
    {"name": "five final services passed docker-run authentic fallback", "status": "passed", "evidenceKind": "runtime-authentic"},
    {"name": "14 generated units passed exact SHA verification", "status": "passed", "evidenceKind": "systemd-manifest"},
]
prerequisites = [
    {
        "id": "private-production-environment",
        "status": "required-external",
        "description": "Provide the mode-0600 production env outside the repository; do not attach it to this artifact.",
    },
    {
        "id": "release-host-final-build",
        "status": "required-external",
        "description": "Build the final runtime/console images on an authorized release builder; this daemon rejects docker build by administrative policy.",
    },
    {
        "id": "digest-pinned-registry-images",
        "status": "required-external",
        "description": "Publish runtime and console images and set immutable registry name@sha256 references matching release build evidence.",
    },
    {
        "id": "production-postgres-tls",
        "status": "required-external",
        "description": "Provide the production PostgreSQL endpoint with sslmode=verify-full and the host-managed CA material.",
    },
    {
        "id": "production-gateway-identity",
        "status": "required-external",
        "description": "Provide gateway TLS plus the selected mTLS, token-file, or OIDC BFF secret paths; OIDC requires its 32-byte session key.",
    },
    {
        "id": "fleet-host-cli-evidence",
        "status": "required-external",
        "description": "Collect source-bound authentic --version/--help evidence on every assigned fleet host, including OpenClaw only where assigned.",
    },
    {
        "id": "release-host-compose-gate",
        "status": "required-external",
        "description": "Run Compose-authentic and make -C ops release-gate on the actual release host with Docker Compose v2 and locally inspectable digest-pinned images.",
    },
]
report = {
    "schemaVersion": 1,
    "suite": "cauce-v3-release-candidate",
    # The candidate aggregates artifacts from every domain, so its own binding is the union.
    "sourceDigest": full_source_digest,
    "sourceDigestDomain": "full",
    "sourceDigests": SOURCE_DIGESTS,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "candidateStatus": "code-runtime-passed-release-host-blocked",
    "fleet": {"manifests": 14, "packagedAdapters": 5},
    "gates": {
        "codeRuntime": {"status": "passed", "criticalSkipped": 0, "checks": checks},
        "releaseHost": {
            "status": "blocked",
            "reason": "Production credentials, registry publication and distributed host evidence are intentionally external to this workspace run.",
            "prerequisites": prerequisites,
        },
    },
    "evidence": evidence,
}
schema_definition = load(OPS / "schemas" / "release-candidate.schema.json")
validation = list(Draft202012Validator(schema_definition, format_checker=FormatChecker()).iter_errors(report))
if validation:
    for error in validation:
        print(f"release candidate schema failed: {error.message}", file=sys.stderr)
    raise SystemExit(1)

OUTPUT.mkdir(parents=True, exist_ok=True)
source_text = "".join(f"{domain} {value}\n" for domain, value in SOURCE_DIGESTS.items())
json_text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
junit_text = "\n".join((
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuite name="cauce-v3-release-candidate" tests="2" failures="0" skipped="0">',
    f'  <properties><property name="sourceDigest" value="{full_source_digest}"/>'
    f'<property name="runtimeSourceDigest" value="{runtime_source_digest}"/>'
    f'<property name="releaseHostGate" value="blocked"/></properties>',
    '  <testcase classname="cauce.release" name="code-runtime-gate"/>',
    '  <testcase classname="cauce.release" name="release-host-prerequisites-explicit"/>',
    '</testsuite>',
    '',
))
(OUTPUT / "sourceDigest").write_text(source_text, encoding="utf-8")
(OUTPUT / "report.json").write_text(json_text, encoding="utf-8")
(OUTPUT / "junit.xml").write_text(junit_text, encoding="utf-8")
manifest = "".join(
    f"{sha256(OUTPUT / name)}  {name}\n"
    for name in ("sourceDigest", "report.json", "junit.xml")
)
(OUTPUT / "SHA256SUMS").write_text(manifest, encoding="utf-8")
verify_sha_directory(OUTPUT, {"sourceDigest", "report.json", "junit.xml"})
if ERRORS:
    for error in ERRORS:
        print(f"release candidate failed: {error}", file=sys.stderr)
    raise SystemExit(1)
print(f"release candidate evidence: {OUTPUT}")
print("code/runtime gate: passed; release-host gate: blocked on explicit external prerequisites")
