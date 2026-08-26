#!/usr/bin/env python3
from __future__ import annotations

import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker
from manifest_lib import safe_schema_diagnostic, schema_error_sort_key


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
ERRORS: list[str] = []

# Remediation guidance printed next to a stale-digest failure.
#
# This is part of the fix, not decoration. Evidence gets hand-edited when the operator believes a
# failure means re-running the expensive thing. Under the old whole-tree digest that belief was
# usually correct, because every change invalidated everything. With domains it is usually wrong, so
# the gate now states which artifact went stale and what it costs to regenerate it.
REBUILD_IMAGES = "regenerate with `make -C ops release-build` (image rebuild only)"
RERUN_AUTHENTIC = (
    "regenerate with `make -C ops release-build` and then the Compose-authentic smoke on the release"
    " host; never hand-edit the artifact"
)
CONSOLE_ONLY = (
    "console sources changed. Only the console image entry went stale: "
    + REBUILD_IMAGES
    + ". The compose-authentic fault evidence does NOT depend on apps/console and must not be re-run"
    " or edited to satisfy this check"
)
FINAL_SERVICES = {"gateway", "dispatcher", "relay-worker", "telegram-bridge", "shadow-router"}
APPROVED_UNTRACKED_PREFIX = "apps/console/src/features/_grafo/"
RUNTIME_PACKAGE_COMPONENTS = [
    "gateway",
    "dispatcher",
    "relay-worker",
    "telegram-bridge",
    "shadow-router",
    "terminal-relay",
    "outbox-metrics",
]
REQUIRED_FAULTS = {"gateway-process-kill", "postgres-container-kill"}
# Fault mechanisms observed to flake on CPU-loaded release hosts (agora-storage), confirmed against a
# control run. They are still REQUIRED and still must pass -- this set only changes the wording of
# the failure so a timing flake is not mistaken for tampering, which would push the operator back
# towards editing the artifact instead of re-running it.
FLAKY_ON_LOADED_HOSTS = {"gateway-process-kill", "postgres-container-kill"}
BASE_REPOSITORIES = {
    "node": "docker.io/library/node",
    "python": "docker.io/library/python",
    "nginx": "docker.io/nginxinc/nginx-unprivileged",
}
SINGLE_MANIFEST_MEDIA_TYPES = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
LINUX_AMD64 = {"os": "linux", "architecture": "amd64"}


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
    failures = sorted(validator.iter_errors(instance), key=schema_error_sort_key)
    for failure in failures:
        ERRORS.append(f"{label}.{safe_schema_diagnostic(failure)}")
    return not failures


def source_digest(domain: str) -> str:
    """Digest of one source domain, always recomputed here from the working tree.

    The gate compares an artifact only against the domain that can change that artifact's result.
    Comparing every artifact against a whole-tree digest is what made an apps/console edit invalidate
    the compose-authentic fault evidence, and that pressure is what produced hand-edited evidence.
    ops/scripts/source-digest.py documents each domain and why every exclusion is causally safe.
    """
    return subprocess.run(
        [sys.executable, str(OPS / "scripts" / "source-digest.py"), "--domain", domain],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def timestamp(value: str, label: str) -> datetime.datetime | None:
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone is required")
        return parsed.astimezone(datetime.timezone.utc)
    except (AttributeError, ValueError) as error:
        ERRORS.append(f"{label}: invalid timestamp: {error}")
        return None


def validate_platform_evidence(build: dict, label: str = "build") -> None:
    """Enforce cross-field meaning that JSON Schema cannot express."""
    bases = build.get("baseImages", {})
    if not isinstance(bases, dict):
        ERRORS.append(f"{label}.baseImages is not an object")
        return
    identifiers: list[str] = []
    manifest_digests: list[str] = []
    references: list[str] = []
    for role, expected_repository in BASE_REPOSITORIES.items():
        base = bases.get(role)
        if not isinstance(base, dict):
            ERRORS.append(f"{label}.baseImages.{role} is absent")
            continue
        reference = base.get("repositoryDigest")
        manifest_digest = base.get("manifestDigest")
        if base.get("role") != role:
            ERRORS.append(f"{label}.baseImages.{role}.role does not match its evidence slot")
        if not isinstance(reference, str) or not reference.startswith(f"{expected_repository}@"):
            ERRORS.append(f"{label}.baseImages.{role} uses the wrong repository role")
        elif reference.rsplit("@", 1)[1] != manifest_digest:
            ERRORS.append(f"{label}.baseImages.{role} manifestDigest differs from its RepoDigest")
        if base.get("mediaType") not in SINGLE_MANIFEST_MEDIA_TYPES:
            ERRORS.append(f"{label}.baseImages.{role} is not a single image manifest")
        if base.get("platform") != LINUX_AMD64:
            ERRORS.append(f"{label}.baseImages.{role} is not linux/amd64")
        if isinstance(reference, str):
            references.append(reference)
        if isinstance(manifest_digest, str):
            manifest_digests.append(manifest_digest)
        identifier = base.get("imageId")
        if isinstance(identifier, str):
            identifiers.append(identifier)
    if len(references) == 3 and len(set(references)) != 3:
        ERRORS.append(f"{label}.baseImages reuses one RepoDigest across different roles")
    if len(manifest_digests) == 3 and len(set(manifest_digests)) != 3:
        ERRORS.append(f"{label}.baseImages reuses one manifest across different roles")
    if len(identifiers) == 3 and len(set(identifiers)) != 3:
        ERRORS.append(f"{label}.baseImages reuses one image ID across different roles")

    final_references: list[str] = []
    for image_name in ("runtime", "console"):
        image = build.get(image_name)
        if not isinstance(image, dict):
            continue
        reference = image.get("repositoryDigest")
        manifest_digest = image.get("manifestDigest")
        if not isinstance(reference, str) or "@" not in reference:
            continue
        if reference.rsplit("@", 1)[1] != manifest_digest:
            ERRORS.append(f"{label}.{image_name}.manifestDigest differs from its RepoDigest")
        if image.get("mediaType") not in SINGLE_MANIFEST_MEDIA_TYPES:
            ERRORS.append(f"{label}.{image_name} is not a single image manifest")
        if image.get("platform") != LINUX_AMD64:
            ERRORS.append(f"{label}.{image_name} is not linux/amd64")
        final_references.append(reference)
    if len(final_references) == 2 and final_references[0] == final_references[1]:
        ERRORS.append(f"{label} runtime and console reuse one final RepoDigest")


def release_checkout_is_clean() -> bool:
    """Require clean tracked/index state and tolerate only the exact operator scratch prefix."""
    for arguments in (("diff", "--quiet", "--no-ext-diff", "--"),
                      ("diff", "--cached", "--quiet", "--no-ext-diff", "--")):
        if subprocess.run(["git", "-C", str(ROOT), *arguments], check=False).returncode != 0:
            return False
    status = subprocess.run(
        ["git", "-C", str(ROOT), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        check=True, capture_output=True, text=True,
    ).stdout
    entries = [entry for entry in status.split("\0") if entry]
    return all(entry.startswith(f"?? {APPROVED_UNTRACKED_PREFIX}") for entry in entries)


build_path = OPS / "artifacts" / "release" / "build.json"
report_path = OPS / "artifacts" / "compose-authentic" / "report.json"
build = load(build_path)
report = load(report_path)
build_valid = validate_schema(build, "build-evidence.schema.json", "build")
report_valid = validate_schema(report, "test-evidence.schema.json", "compose-authentic")

if build_valid:
    validate_platform_evidence(build)
    expected_dockerfile = f"sha256:{hashlib.sha256((ROOT / 'deploy' / 'Dockerfile').read_bytes()).hexdigest()}"
    if build["dockerfileSha256"] != expected_dockerfile:
        ERRORS.append("build.dockerfileSha256 does not match the current Dockerfile")
    expected_dockerignore = f"sha256:{hashlib.sha256((ROOT / '.dockerignore').read_bytes()).hexdigest()}"
    if build["dockerignoreSha256"] != expected_dockerignore:
        ERRORS.append("build.dockerignoreSha256 does not match the current build-context policy")
    try:
        current_commit = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD^{commit}"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        current_tree = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD^{tree}"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        checkout_clean = release_checkout_is_clean()
    except subprocess.CalledProcessError:
        ERRORS.append("release evidence requires the exact Git release candidate checkout")
    else:
        revision = build["sourceRevision"]
        if revision["commit"] != current_commit or revision["tree"] != current_tree:
            ERRORS.append("build sourceRevision differs from the checked-out release candidate")
        if not checkout_clean:
            ERRORS.append("release evidence validation requires clean tracked/index state and only the approved operator scratch")
    if build["sourceDigest"] != source_digest("runtime"):
        ERRORS.append(f"build.sourceDigest does not match current runtime-domain sources; {RERUN_AUTHENTIC}")
    if build["runtime"]["sourceDigest"] != build["sourceDigest"]:
        ERRORS.append("build runtime image is not bound to the top-level runtime source digest")
    # The console image is built from its own source family. Binding it separately is what lets the
    # runtime domain drop apps/console without the console losing any coverage: a console change
    # still has to move a digest, just not the runtime one -- and the artifact it invalidates is the
    # cheap one (an image rebuild), not the expensive fault-injection run.
    if build["console"]["sourceDigest"] != source_digest("console"):
        ERRORS.append(f"build.console.sourceDigest does not match current console-domain sources; {CONSOLE_ONLY}")
    if build["console"]["sourceDigest"] == build["sourceDigest"]:
        ERRORS.append("build console and runtime source digests are identical; the domains were not separated")
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
    for label in ("runtime", "console"):
        image = build[label]
        repository = image["repositoryDigest"].split("@", 1)[0]
        if image["tag"] != f"{repository}:rc-{build['sourceRevision']['commit']}":
            ERRORS.append(f"build {label} tag is not the unique tag for its committed RC")
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
    # The harness decides what a fault-injection run reports, so evidence that is not bound to it
    # proves less than it claims. Before the domain split the whole of ops/ was outside every
    # digest, which meant the runner and the fault drivers could be weakened without moving
    # anything the gate checks.
    if report["harnessDigest"] != source_digest("harness"):
        ERRORS.append(
            "compose-authentic.harnessDigest does not match the current authentic harness; the run that"
            f" produced this evidence used a different harness, so {RERUN_AUTHENTIC}"
        )
    if report["harnessDigest"] == report["sourceDigest"]:
        ERRORS.append("compose-authentic harness and runtime source digests are identical; the domains were not separated")
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
    failing_critical = sorted(
        item["mechanism"] for item in tests if item["critical"] and item["status"] != "passed"
    )
    if failing_critical:
        # A fault that fails here is NOT evidence of fraud. gateway-process-kill and
        # postgres-container-kill are known to be CPU-timing sensitive on agora-storage and have
        # flaked there under load (confirmed against a control run). The honest remedy is to re-run
        # the suite and keep whatever the re-run reports; editing a status into this artifact is the
        # failure mode this gate was redesigned to remove, and it is detectable because the row would
        # no longer be consistent with the image/source/harness digests it is bound to.
        flaky = [name for name in failing_critical if name in FLAKY_ON_LOADED_HOSTS]
        hint = (
            f" ({', '.join(flaky)} is timing sensitive under CPU pressure; re-run the suite, do not"
            " edit the artifact)"
            if flaky
            else ""
        )
        ERRORS.append(
            f"every critical compose-authentic test must pass; failing: {', '.join(failing_critical)}{hint}"
        )
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
    package = build.get("runtimePackage", {})
    if package.get("components") != RUNTIME_PACKAGE_COMPONENTS or package.get("status") != "passed":
        ERRORS.append("release build lacks passing final-image terminal-relay/outbox packaging evidence")
    latest_migration = max(path.name for path in (ROOT / "packages" / "store" / "migrations").glob("*.sql"))
    compatibility = build.get("schemaCompatibility", {})
    if (compatibility.get("label") != "io.cauce.schema.compatible-through"
            or compatibility.get("compatibleThrough") != latest_migration):
        ERRORS.append("release build schema compatibility label is stale or absent")
    if report["imageDigest"] != build["runtime"]["imageDigest"]:
        ERRORS.append("compose-authentic imageDigest differs from the release runtime build")
    if report["sourceDigest"] != build["sourceDigest"]:
        ERRORS.append("compose-authentic sourceDigest differs from the release build")
    # Both artifacts must be talking about the same domain. The schemas pin these to constants, so
    # this only fires if someone hand-edits an artifact and forgets to keep the labels coherent --
    # exactly the tampering mode this redesign exists to make visible instead of tempting.
    if build["sourceDigestDomain"] != report["sourceDigestDomain"]:
        ERRORS.append("release build and compose-authentic declare different source domains")

if ERRORS:
    for error in ERRORS:
        print(f"release evidence failed: {error}", file=sys.stderr)
    raise SystemExit(1)
print("release evidence passed: one final image, compose-authentic faults, zero critical skips")
