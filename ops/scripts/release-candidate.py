#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
OUTPUT = OPS / "artifacts" / "release-candidate"
ERRORS: list[str] = []
ARGUMENT_PARSER = argparse.ArgumentParser(description="Build pre-release or final release-host evidence")
ARGUMENT_PARSER.add_argument(
    "--release-host-ready",
    action="store_true",
    help="run the complete host gate, then re-verify canonical Compose and registry pins before emitting release-ready",
)
ARGUMENTS = ARGUMENT_PARSER.parse_args()
RUNTIME_PACKAGE_COMPONENTS = [
    "gateway",
    "dispatcher",
    "relay-worker",
    "telegram-bridge",
    "shadow-router",
    "terminal-relay",
    "outbox-metrics",
]
APPROVED_UNTRACKED_PREFIX = "apps/console/src/features/_grafo/"


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


def release_checkout_revision() -> tuple[str, str]:
    for arguments in (("diff", "--quiet", "--no-ext-diff", "--"),
                      ("diff", "--cached", "--quiet", "--no-ext-diff", "--")):
        result = subprocess.run(
            ["git", "-C", str(ROOT), *arguments], check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            raise ValueError("release candidate index or tracked worktree is not clean")
    status = subprocess.run(
        ["git", "-C", str(ROOT), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        check=True, capture_output=True, text=True,
    ).stdout
    if any(
        not entry.startswith(f"?? {APPROVED_UNTRACKED_PREFIX}")
        for entry in status.split("\0") if entry
    ):
        raise ValueError("release candidate contains an unapproved untracked path")
    commit = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD^{commit}"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    tree = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD^{tree}"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return commit, tree


def production_selectors(path: pathlib.Path) -> tuple[str, str, pathlib.Path, pathlib.Path, str]:
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("production env must be an absolute regular non-symlink file")
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1 or metadata.st_uid not in {0, os.geteuid()}):
        raise ValueError("production env must be an owned single-link mode-0600 regular file")
    wanted = {
        "CAUCE_RUNTIME_IMAGE", "CAUCE_CONSOLE_IMAGE", "CAUCE_COMPOSE_OVERRIDE_MANIFEST",
        "CAUCE_ROLLBACK_BASELINE_FILE", "CAUCE_ROLLBACK_BASELINE_SHA256",
    }
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line or raw_line.startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.removesuffix("\r").split("=", 1)
        if key not in wanted:
            continue
        if key in values:
            raise ValueError(f"production env contains duplicate {key}")
        values[key] = value
    missing = sorted(wanted - values.keys())
    if missing:
        raise ValueError(f"production env is missing {missing[0]}")
    manifest = pathlib.Path(values["CAUCE_COMPOSE_OVERRIDE_MANIFEST"])
    if not manifest.is_absolute() or manifest.is_symlink():
        raise ValueError("production override manifest must be an absolute regular non-symlink file")
    manifest_metadata = manifest.lstat()
    if (not stat.S_ISREG(manifest_metadata.st_mode) or stat.S_IMODE(manifest_metadata.st_mode) != 0o600
            or manifest_metadata.st_nlink != 1 or manifest_metadata.st_uid not in {0, os.geteuid()}):
        raise ValueError("production override manifest must be an owned single-link mode-0600 regular file")
    baseline = pathlib.Path(values["CAUCE_ROLLBACK_BASELINE_FILE"])
    if not baseline.is_absolute() or baseline.is_symlink():
        raise ValueError("production rollback baseline must be an absolute regular non-symlink file")
    baseline_metadata = baseline.lstat()
    if (not stat.S_ISREG(baseline_metadata.st_mode) or stat.S_IMODE(baseline_metadata.st_mode) != 0o600
            or baseline_metadata.st_nlink != 1 or baseline_metadata.st_uid not in {0, os.geteuid()}):
        raise ValueError("production rollback baseline must be an owned single-link mode-0600 regular file")
    baseline_sha256 = values["CAUCE_ROLLBACK_BASELINE_SHA256"]
    if (len(baseline_sha256) != 71 or not baseline_sha256.startswith("sha256:")
            or any(character not in "0123456789abcdef" for character in baseline_sha256[7:])):
        raise ValueError("production rollback baseline SHA-256 selector is invalid")
    return (
        values["CAUCE_RUNTIME_IMAGE"], values["CAUCE_CONSOLE_IMAGE"], manifest,
        baseline, baseline_sha256,
    )


def docker_image_id(reference: str) -> str:
    subprocess.run(
        ["docker", "pull", reference], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    identifier = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    repo_digests_text = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", reference],
        check=True, capture_output=True, text=True,
    ).stdout
    repo_digests = json.loads(repo_digests_text)
    if reference not in repo_digests:
        raise ValueError("pulled image is not bound to its requested repository digest")
    if (not isinstance(identifier, str) or len(identifier) != 71 or not identifier.startswith("sha256:")
            or any(character not in "0123456789abcdef" for character in identifier[7:])):
        raise ValueError("pulled image has an invalid image ID")
    return identifier


def verify_final_release_host(build: dict) -> list[dict[str, object]]:
    env_value = os.environ.get("CAUCE_ENV_FILE", "")
    if not env_value:
        raise ValueError("CAUCE_ENV_FILE is required for final release-host evidence")
    env_file = pathlib.Path(env_value)

    canonical_environment = os.environ.copy()
    for key in (
        "CAUCE_RUNTIME_IMAGE", "CAUCE_CONSOLE_IMAGE", "CAUCE_COMPOSE_OVERRIDE_MANIFEST",
        "CAUCE_ROLLBACK_BASELINE_FILE", "CAUCE_ROLLBACK_BASELINE_SHA256",
        "CAUCE_COMPOSE_OVERRIDES_DIR", "CAUCE_LOCAL_POSTGRES",
    ):
        canonical_environment.pop(key, None)
    canonical_environment["CAUCE_ENV_FILE"] = os.fspath(env_file)

    # This is intentionally a live execution, not a marker or remembered stdout.
    # release-gate invokes this script in pre-release mode; after it returns, this
    # outer invocation re-checks the selectors so drift cannot become a ready RC.
    subprocess.run(
        [str(OPS / "scripts" / "release-gate.sh")], check=True, env=canonical_environment,
    )

    runtime_reference, console_reference, override_manifest, rollback_baseline, baseline_sha256 = (
        production_selectors(env_file)
    )
    if runtime_reference != build.get("runtime", {}).get("repositoryDigest"):
        raise ValueError("production runtime selector differs from release build repositoryDigest")
    if console_reference != build.get("console", {}).get("repositoryDigest"):
        raise ValueError("production console selector differs from release build repositoryDigest")

    subprocess.run(
        [
            str(OPS / "scripts" / "rollback-baseline.py"), "check",
            "--baseline", os.fspath(rollback_baseline),
            "--expected-baseline-sha256", baseline_sha256,
            "--expected-forward-release-commit", build["sourceRevision"]["commit"],
            "--expected-forward-runtime-image", runtime_reference,
            "--expected-forward-runtime-image-id", build["runtime"]["imageId"],
            "--expected-forward-runtime-source-digest", build["sourceDigest"],
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    override_environment = canonical_environment.copy()
    override_environment["CAUCE_COMPOSE_OVERRIDE_MANIFEST"] = os.fspath(override_manifest)
    override_command = [str(OPS / "scripts" / "compose-files.sh"), "overrides"]
    active_overrides = subprocess.run(
        override_command,
        check=True, capture_output=True, text=True, env=override_environment,
    ).stdout
    if active_overrides:
        raise ValueError("release-candidate override manifest contains an active historical override")
    compose_text = subprocess.run(
        [str(OPS / "scripts" / "compose.sh"), "prod", "config", "--format", "json"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    compose = json.loads(compose_text)
    services = compose.get("services") or {}
    runtime_services = {
        "migrator", "gateway", "terminal-relay", "dispatcher", "outbox-metrics",
        "relay-worker", "telegram-bridge", "shadow-router", "shadow-guard",
    }
    for service in sorted(runtime_services):
        if services.get(service, {}).get("image") != runtime_reference:
            raise ValueError(f"canonical Compose runtime image differs for {service}")
    if services.get("console", {}).get("image") != console_reference:
        raise ValueError("canonical Compose console image differs from the production selector")

    if docker_image_id(runtime_reference) != build["runtime"]["imageId"]:
        raise ValueError("registry runtime digest did not recover the tested image ID")
    if docker_image_id(console_reference) != build["console"]["imageId"]:
        raise ValueError("registry console digest did not recover the tested image ID")

    commit, tree = release_checkout_revision()
    revision = build.get("sourceRevision", {})
    if revision.get("commit") != commit or revision.get("tree") != tree:
        raise ValueError("release candidate source changed during the host gate")
    refreshed = {domain: source_digest_for(domain) for domain in SOURCE_DIGESTS}
    if refreshed != SOURCE_DIGESTS:
        raise ValueError("release candidate source digests changed during the host gate")

    # Last-moment CAS admission plus a second effective-Compose resolution.
    # This is deliberately repeated after the registry and source checks: a
    # successful earlier release-gate stdout is not a durable attestation.
    subprocess.run(
        [
            str(OPS / "scripts" / "pin-production-release.py"), "check",
            "--env-file", os.fspath(env_file),
            "--expected-runtime-image", runtime_reference,
            "--target-runtime-image", runtime_reference,
            "--expected-console-image", console_reference,
            "--target-console-image", console_reference,
            "--expected-override-manifest", os.fspath(override_manifest),
            "--target-override-manifest", os.fspath(override_manifest),
            "--expected-rollback-baseline", os.fspath(rollback_baseline),
            "--target-rollback-baseline", os.fspath(rollback_baseline),
            "--expected-rollback-baseline-sha256", baseline_sha256,
            "--target-rollback-baseline-sha256", baseline_sha256,
            "--baseline-forward-release-commit", build["sourceRevision"]["commit"],
            "--baseline-forward-runtime-image", runtime_reference,
            "--baseline-forward-runtime-source-digest", build["sourceDigest"],
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if subprocess.run(
        override_command, check=True, capture_output=True, text=True, env=override_environment,
    ).stdout:
        raise ValueError("release-candidate override manifest changed to include an active override")
    refreshed_compose = json.loads(subprocess.run(
        [str(OPS / "scripts" / "compose.sh"), "prod", "config", "--format", "json"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout)
    if refreshed_compose != compose:
        raise ValueError("canonical production Compose changed during final re-verification")
    return [
        {"name": "complete live release-host gate returned success", "status": "passed", "evidenceKind": "release-build"},
        {"name": "production env and every Compose runtime service resolve exact release RepoDigests", "status": "passed", "evidenceKind": "release-build"},
        {"name": "registry pull recovered the runtime and console image IDs that passed QA", "status": "passed", "evidenceKind": "release-build"},
        {"name": "clean RC revision and source domains remained unchanged through the host gate", "status": "passed", "evidenceKind": "release-build"},
        {"name": "durable rollback baseline recovered exact bridge runtime and console image IDs", "status": "passed", "evidenceKind": "release-build"},
    ]


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
    "migration-integrity-pre": "runtime",
    "outbox-reconciliation-pre": "runtime",
}

verification_dir = OPS / "artifacts" / "verification"
build_dir = OPS / "artifacts" / "release"
compose_dir = OPS / "artifacts" / "compose-authentic"
runtime_dir = OPS / "artifacts" / "runtime-authentic"
mock_dir = OPS / "artifacts" / "mock"
fleet_dir = ROOT / "tests" / "fleet-release" / "artifacts"
migration_dir = OPS / "artifacts" / "migration-integrity"
outbox_reconciliation_dir = OPS / "artifacts" / "outbox-reconciliation"

verification = load(verification_dir / "report.json")
build = load(build_dir / "build.json") if (build_dir / "build.json").is_file() else {}
compose = load(compose_dir / "report.json") if (compose_dir / "report.json").is_file() else {}
runtime = load(runtime_dir / "report.json")
mock = load(mock_dir / "report.json")
fleet = load(fleet_dir / "report.json")
migration = load(migration_dir / "pre.json")
outbox_reconciliation = load(outbox_reconciliation_dir / "pre.json")

schema(verification, OPS / "schemas" / "verification-evidence.schema.json", "verification")
if build:
    schema(build, OPS / "schemas" / "build-evidence.schema.json", "build")
if compose:
    schema(compose, OPS / "schemas" / "test-evidence.schema.json", "compose-authentic")
schema(runtime, OPS / "schemas" / "test-evidence.schema.json", "runtime-authentic")
schema(fleet, ROOT / "tests" / "fleet-release" / "fleet-release-report.schema.json", "fleet-release")
schema(migration, OPS / "schemas" / "migration-integrity-evidence.schema.json", "migration-integrity-pre")

verify_sha_directory(verification_dir, {"report.json", "junit.xml"})
if build:
    verify_sha_directory(build_dir, {"build.json"})
if compose:
    verify_sha_directory(compose_dir, {"report.json", "junit.xml"})
verify_sha_directory(runtime_dir, {"report.json", "junit.xml"})
verify_sha_directory(mock_dir, {"report.json", "junit.xml"})
verify_sha_directory(fleet_dir, {"report.json", "junit.xml", "binaries.sha256"})
verify_sha_directory(
    migration_dir,
    {"pre.json"} | ({"post.json"} if (migration_dir / "post.json").is_file() else set()),
)
verify_sha_directory(outbox_reconciliation_dir, {"pre.json"})

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
    package = build.get("runtimePackage", {})
    if package.get("status") != "passed" or package.get("components") != RUNTIME_PACKAGE_COMPONENTS:
        ERRORS.append("build does not prove final-image terminal-relay and outbox packaging")
    latest_migration = max(path.name for path in (ROOT / "packages" / "store" / "migrations").glob("*.sql"))
    schema_compatibility = build.get("schemaCompatibility", {})
    if (schema_compatibility.get("label") != "io.cauce.schema.compatible-through"
            or schema_compatibility.get("compatibleThrough") != latest_migration):
        ERRORS.append("build image does not declare compatibility through the exact release schema")
    try:
        checkout_commit, checkout_tree = release_checkout_revision()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        ERRORS.append(f"release source checkout is not an admissible RC: {error}")
    else:
        revision = build.get("sourceRevision", {})
        if revision.get("commit") != checkout_commit or revision.get("tree") != checkout_tree:
            ERRORS.append("build sourceRevision differs from the checked-out committed RC")

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
if fleet.get("summary") != {"aliases": 15, "passed": 15, "failed": 0}:
    ERRORS.append("fleet-release exact 15-alias matrix did not pass")
if len(fleet.get("adapterBinaries", [])) != 5:
    ERRORS.append("fleet-release does not bind exactly five packaged adapters")
local_migrations = sorted((ROOT / "packages" / "store" / "migrations").glob("*.sql"))
expected_migration_sources = {path.name: sha256(path) for path in local_migrations}
observed_migration_sources = {
    entry.get("version"): entry.get("sourceSha256") for entry in migration.get("entries", [])
    if isinstance(entry, dict)
}
if migration.get("phase") != "pre" or observed_migration_sources != expected_migration_sources:
    ERRORS.append("pre-migration evidence is not bound to the exact release migration sources")
legacy_024 = [
    entry for entry in migration.get("entries", [])
    if isinstance(entry, dict) and entry.get("version") == "024_agent_role_templates.sql"
]
if len(legacy_024) != 1 or not legacy_024[0].get("applied") or not legacy_024[0].get("observedSchemaSha256"):
    ERRORS.append("pre-migration evidence lacks exact structural equivalence for legacy 024")
outbox_counts = outbox_reconciliation.get("counts", {})
if (outbox_reconciliation.get("phase") != "pre"
        or outbox_counts.get("candidates") not in (0, 1)
        or outbox_counts.get("staleProcessing") != 0
        or outbox_counts.get("inconsistentDeadLetters") != 0):
    ERRORS.append("pre-release outbox evidence has unexpected or unsafe legacy console rows")
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
if len(units) != 15:
    ERRORS.append(f"generated systemd fleet has {len(units)} units instead of 15")
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
    ("migration-integrity-pre", migration_dir / "pre.json"),
    ("outbox-reconciliation-pre", outbox_reconciliation_dir / "pre.json"),
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
    {"name": "15 manifests and five packaged adapters passed fleet release", "status": "passed", "evidenceKind": "fleet-release"},
    {"name": "Testcontainers real QA and restart durability passed", "status": "passed", "evidenceKind": "testcontainers-real"},
    {"name": "mock contract evidence remained separate", "status": "passed", "evidenceKind": "mock-contract"},
    {"name": "five final services passed docker-run authentic fallback", "status": "passed", "evidenceKind": "runtime-authentic"},
    {"name": "15 generated units passed exact SHA verification", "status": "passed", "evidenceKind": "systemd-manifest"},
    {"name": "legacy migration 024 passed structural fingerprint before dependent migrations", "status": "passed", "evidenceKind": "migration-integrity-pre"},
    {"name": "legacy console outbox backlog was bounded and free of claimed/inconsistent rows", "status": "passed", "evidenceKind": "outbox-reconciliation-pre"},
]
if build:
    checks.append({
        "name": "terminal relay and outbox metrics passed final-image packaging smoke",
        "status": "passed",
        "evidenceKind": "release-build",
    })
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
        "id": "durable-rollback-baseline",
        "status": "required-external",
        "description": "Publish and atomically pin the mode-0600 rollback baseline bound to the tested schema-029 bridge, console RepoDigest, manifest and release commit.",
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
release_host_checks: list[dict[str, object]] = []
if ARGUMENTS.release_host_ready:
    if not build:
        print("release candidate failed: final release-host evidence requires release build evidence", file=sys.stderr)
        raise SystemExit(1)
    try:
        release_host_checks = verify_final_release_host(build)
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        # Do not include subprocess output or env-derived selector values. The
        # failing live gate has already emitted its own sanitized diagnostic.
        print(
            f"release candidate failed: final release-host re-verification did not pass ({type(error).__name__})",
            file=sys.stderr,
        )
        raise SystemExit(1) from error

candidate_status = (
    "release-ready" if ARGUMENTS.release_host_ready
    else "code-runtime-passed-release-host-blocked"
)
release_host_gate: dict[str, object]
if ARGUMENTS.release_host_ready:
    release_host_gate = {
        "status": "passed",
        "criticalSkipped": 0,
        "checks": release_host_checks,
    }
else:
    release_host_gate = {
        "status": "blocked",
        "reason": "Production credentials, registry publication and distributed host evidence are intentionally external to this workspace run.",
        "prerequisites": prerequisites,
    }
report = {
    "schemaVersion": 2,
    "suite": "cauce-v3-release-candidate",
    # The candidate aggregates artifacts from every domain, so its own binding is the union.
    "sourceDigest": full_source_digest,
    "sourceDigestDomain": "full",
    "sourceDigests": SOURCE_DIGESTS,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "candidateStatus": candidate_status,
    "fleet": {"manifests": 15, "packagedAdapters": 5},
    "gates": {
        "codeRuntime": {"status": "passed", "criticalSkipped": 0, "checks": checks},
        "releaseHost": release_host_gate,
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
release_host_status = "passed" if ARGUMENTS.release_host_ready else "blocked"
release_host_test = (
    "release-host-live-gate-and-final-reverification"
    if ARGUMENTS.release_host_ready else "release-host-prerequisites-explicit"
)
junit_text = "\n".join((
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuite name="cauce-v3-release-candidate" tests="2" failures="0" skipped="0">',
    f'  <properties><property name="sourceDigest" value="{full_source_digest}"/>'
    f'<property name="runtimeSourceDigest" value="{runtime_source_digest}"/>'
    f'<property name="releaseHostGate" value="{release_host_status}"/></properties>',
    '  <testcase classname="cauce.release" name="code-runtime-gate"/>',
    f'  <testcase classname="cauce.release" name="{release_host_test}"/>',
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
if ARGUMENTS.release_host_ready:
    print("code/runtime gate: passed; release-host gate: passed after live gate and final re-verification")
else:
    print("code/runtime gate: passed; release-host gate: blocked on explicit external prerequisites")
