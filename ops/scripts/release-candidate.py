#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker
from manifest_lib import safe_schema_diagnostic, schema_error_sort_key


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
    for error in sorted(validator.iter_errors(instance), key=schema_error_sort_key):
        ERRORS.append(f"{label}.{safe_schema_diagnostic(error)}")


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


def validate_platform_evidence(build: dict, label: str = "build") -> None:
    """Reject schema-valid evidence whose roles, digests or platform disagree."""
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
        if isinstance(base.get("imageId"), str):
            identifiers.append(base["imageId"])
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
        if isinstance(reference, str) and "@" in reference:
            if reference.rsplit("@", 1)[1] != image.get("manifestDigest"):
                ERRORS.append(f"{label}.{image_name}.manifestDigest differs from its RepoDigest")
            final_references.append(reference)
        if image.get("mediaType") not in SINGLE_MANIFEST_MEDIA_TYPES:
            ERRORS.append(f"{label}.{image_name} is not a single image manifest")
        if image.get("platform") != LINUX_AMD64:
            ERRORS.append(f"{label}.{image_name} is not linux/amd64")
    if len(final_references) == 2 and final_references[0] == final_references[1]:
        ERRORS.append(f"{label} runtime and console reuse one final RepoDigest")


def without_observation_time(report: dict) -> dict:
    """Compare live evidence semantically while allowing its observation instant to advance."""
    return {key: value for key, value in report.items() if key != "generatedAt"}


def object_entries(report: dict, label: str) -> list[dict]:
    value = report.get("entries")
    if not isinstance(value, list) or any(not isinstance(entry, dict) for entry in value):
        ERRORS.append(f"{label} entries must be an array of objects")
        return []
    return value


def validate_migration_pair(pre_report: dict, post_report: dict, expected_sources: dict[str, str]) -> None:
    pre_entries = object_entries(pre_report, "pre-migration evidence")
    observed_pre = {entry.get("version"): entry.get("sourceSha256") for entry in pre_entries}
    if (pre_report.get("phase") != "pre" or observed_pre != expected_sources
            or len(pre_entries) != len(observed_pre)):
        ERRORS.append("pre-migration evidence is not bound to the exact release migration sources")

    post_entries = object_entries(post_report, "post-migration evidence")
    observed_post = {entry.get("version"): entry.get("sourceSha256") for entry in post_entries}
    if (post_report.get("phase") != "post" or observed_post != expected_sources
            or len(post_entries) != len(observed_post)):
        ERRORS.append("post-migration evidence is not bound to the exact release migration sources")
    if any(not entry.get("applied") for entry in post_entries):
        ERRORS.append("post-migration evidence contains pending migrations")
    if any(
        entry.get("sourceOrigin") != "applied-atomically"
        or entry.get("verificationMethod") != "atomic-ledger-v1"
        for entry in post_entries if str(entry.get("version", "")) >= "026_agent_profile.sql"
    ):
        ERRORS.append("post-migration evidence contains a release migration without its atomic ledger")
    if post_report.get("migrationSetSha256") != pre_report.get("migrationSetSha256"):
        ERRORS.append("pre/post migration evidence describes different migration source sets")
    try:
        pre_generated_at = datetime.datetime.fromisoformat(
            str(pre_report.get("generatedAt", "")).replace("Z", "+00:00")
        )
        post_generated_at = datetime.datetime.fromisoformat(
            str(post_report.get("generatedAt", "")).replace("Z", "+00:00")
        )
        if post_generated_at < pre_generated_at:
            ERRORS.append("post-migration evidence predates pre-migration evidence")
    except (TypeError, ValueError):
        # The schema error is already reported by the caller; retain a
        # deterministic gate diagnostic instead of crashing on its timestamp.
        ERRORS.append("pre/post migration evidence has an invalid generatedAt timestamp")

    legacy_pre = [
        entry for entry in pre_entries if entry.get("version") == "024_agent_role_templates.sql"
    ]
    if (len(legacy_pre) != 1 or not legacy_pre[0].get("applied")
            or not legacy_pre[0].get("observedSchemaSha256")):
        ERRORS.append("pre-migration evidence lacks exact structural equivalence for legacy 024")
    legacy_post = [
        entry for entry in post_entries if entry.get("version") == "024_agent_role_templates.sql"
    ]
    if (len(legacy_post) != 1 or not legacy_post[0].get("applied")
            or not legacy_post[0].get("observedSchemaSha256")):
        ERRORS.append("post-migration evidence lacks exact structural equivalence for legacy 024")
    if (len(legacy_pre) == 1 and len(legacy_post) == 1
            and legacy_pre[0].get("observedSchemaSha256") != legacy_post[0].get("observedSchemaSha256")):
        ERRORS.append("legacy 024 structural fingerprint changed between pre and post evidence")


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


def production_selectors(
    path: pathlib.Path,
) -> tuple[str, str, pathlib.Path, str, pathlib.Path, str, pathlib.Path, str]:
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("production env must be an absolute regular non-symlink file")
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1 or metadata.st_uid not in {0, os.geteuid()}):
        raise ValueError("production env must be an owned single-link mode-0600 regular file")
    wanted = {
        "CAUCE_RUNTIME_IMAGE", "CAUCE_CONSOLE_IMAGE", "CAUCE_COMPOSE_OVERRIDE_MANIFEST",
        "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256",
        "CAUCE_ROLLBACK_BASELINE_FILE", "CAUCE_ROLLBACK_BASELINE_SHA256",
        "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE", "CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256",
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
    manifest_sha256 = values["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"]
    if (len(manifest_sha256) != 71 or not manifest_sha256.startswith("sha256:")
            or any(character not in "0123456789abcdef" for character in manifest_sha256[7:])):
        raise ValueError("production override manifest SHA-256 selector is invalid")
    manifest_signature = (
        manifest_metadata.st_dev, manifest_metadata.st_ino, manifest_metadata.st_mode,
        manifest_metadata.st_nlink, manifest_metadata.st_uid, manifest_metadata.st_gid,
        manifest_metadata.st_size, manifest_metadata.st_mtime_ns, manifest_metadata.st_ctime_ns,
    )
    manifest_content = manifest.read_bytes()
    refreshed_manifest_metadata = manifest.lstat()
    refreshed_manifest_signature = (
        refreshed_manifest_metadata.st_dev, refreshed_manifest_metadata.st_ino,
        refreshed_manifest_metadata.st_mode, refreshed_manifest_metadata.st_nlink,
        refreshed_manifest_metadata.st_uid, refreshed_manifest_metadata.st_gid,
        refreshed_manifest_metadata.st_size, refreshed_manifest_metadata.st_mtime_ns,
        refreshed_manifest_metadata.st_ctime_ns,
    )
    if refreshed_manifest_signature != manifest_signature:
        raise ValueError("production override manifest changed while reading selectors")
    observed_manifest_sha256 = f"sha256:{hashlib.sha256(manifest_content).hexdigest()}"
    if observed_manifest_sha256 != manifest_sha256:
        raise ValueError("production override manifest differs from its selected SHA-256")
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
    writer_snapshot = pathlib.Path(values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"])
    if not writer_snapshot.is_absolute() or writer_snapshot.is_symlink():
        raise ValueError("production writer snapshot must be an absolute regular non-symlink file")
    writer_metadata = writer_snapshot.lstat()
    if (not stat.S_ISREG(writer_metadata.st_mode) or stat.S_IMODE(writer_metadata.st_mode) != 0o600
            or writer_metadata.st_nlink != 1 or writer_metadata.st_uid not in {0, os.geteuid()}):
        raise ValueError("production writer snapshot must be an owned single-link mode-0600 regular file")
    writer_sha256 = values["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"]
    if (len(writer_sha256) != 71 or not writer_sha256.startswith("sha256:")
            or any(character not in "0123456789abcdef" for character in writer_sha256[7:])):
        raise ValueError("production writer snapshot SHA-256 selector is invalid")
    writer_signature = (
        writer_metadata.st_dev, writer_metadata.st_ino, writer_metadata.st_mode,
        writer_metadata.st_nlink, writer_metadata.st_uid, writer_metadata.st_gid,
        writer_metadata.st_size, writer_metadata.st_mtime_ns, writer_metadata.st_ctime_ns,
    )
    writer_content = writer_snapshot.read_bytes()
    refreshed_writer = writer_snapshot.lstat()
    refreshed_writer_signature = (
        refreshed_writer.st_dev, refreshed_writer.st_ino, refreshed_writer.st_mode,
        refreshed_writer.st_nlink, refreshed_writer.st_uid, refreshed_writer.st_gid,
        refreshed_writer.st_size, refreshed_writer.st_mtime_ns, refreshed_writer.st_ctime_ns,
    )
    if refreshed_writer_signature != writer_signature:
        raise ValueError("production writer snapshot changed while reading selectors")
    if f"sha256:{hashlib.sha256(writer_content).hexdigest()}" != writer_sha256:
        raise ValueError("production writer snapshot differs from its selected SHA-256")
    return (
        values["CAUCE_RUNTIME_IMAGE"], values["CAUCE_CONSOLE_IMAGE"], manifest,
        manifest_sha256, baseline, baseline_sha256, writer_snapshot, writer_sha256,
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


def verify_recovered_final_image(reference: str, build: dict, image_name: str) -> str:
    """Pull and re-attest the final image descriptor, platform and provenance labels."""
    subprocess.run(
        ["docker", "pull", "--platform", "linux/amd64", reference],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    inspected_text = subprocess.run(
        ["docker", "image", "inspect", reference], check=True, capture_output=True, text=True,
    ).stdout
    inspected = json.loads(inspected_text)
    if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
        raise ValueError(f"registry {image_name} inspect result is ambiguous")
    image = inspected[0]
    evidence = build.get(image_name, {})
    descriptor = image.get("Descriptor")
    config = image.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if not isinstance(descriptor, dict) or not isinstance(labels, dict):
        raise ValueError(f"registry {image_name} lacks descriptor or provenance labels")
    if (image.get("Id") != evidence.get("imageId")
            or descriptor.get("digest") != evidence.get("manifestDigest")
            or descriptor.get("mediaType") != evidence.get("mediaType")
            or image.get("Os") != "linux" or image.get("Architecture") != "amd64"
            or evidence.get("platform") != LINUX_AMD64
            or reference not in (image.get("RepoDigests") or [])):
        raise ValueError(f"registry {image_name} identity, manifest or platform differs from build evidence")
    revision = build.get("sourceRevision", {}).get("commit")
    if (labels.get("io.cauce.source.digest") != evidence.get("sourceDigest")
            or labels.get("org.opencontainers.image.revision") != revision
            or labels.get("io.cauce.target-platform") != "linux/amd64"):
        raise ValueError(f"registry {image_name} source, revision or platform label differs")
    bases = build.get("baseImages", {})
    if image_name == "runtime":
        node_reference = bases.get("node", {}).get("repositoryDigest")
        python_reference = bases.get("python", {}).get("repositoryDigest")
        compatibility = build.get("schemaCompatibility", {}).get("compatibleThrough")
        if (labels.get("org.opencontainers.image.base.name") != node_reference
                or labels.get("io.cauce.base.node.repository-digest") != node_reference
                or labels.get("io.cauce.base.python.repository-digest") != python_reference
                or labels.get("io.cauce.schema.compatible-through") != compatibility
                or labels.get("io.cauce.base.nginx.repository-digest") is not None):
            raise ValueError("registry runtime base or schema provenance label differs")
    else:
        nginx_reference = bases.get("nginx", {}).get("repositoryDigest")
        if (labels.get("org.opencontainers.image.base.name") != nginx_reference
                or labels.get("io.cauce.base.nginx.repository-digest") != nginx_reference
                or labels.get("io.cauce.base.node.repository-digest") is not None
                or labels.get("io.cauce.base.python.repository-digest") is not None
                or labels.get("io.cauce.console.publish-journal")
                    != evidence.get("publishJournalCapability")):
            raise ValueError("registry console base provenance label differs")
    return str(image["Id"])


def inherited_transition_lock_fd() -> int | None:
    raw_fd = os.environ.get("CAUCE_RELEASE_TRANSITION_LOCK_FD")
    token = os.environ.get("CAUCE_RELEASE_TRANSITION_LOCK_TOKEN")
    if raw_fd is None and token is None:
        return None
    if raw_fd is None or token is None or re.fullmatch(r"[0-9]+", raw_fd) is None or int(raw_fd) < 3:
        raise ValueError("incomplete or invalid inherited release transition lock")
    descriptor = int(raw_fd)
    os.fstat(descriptor)
    return descriptor


def verify_active_compose_containers(
    compose: dict,
    canonical_environment: dict[str, str],
    *,
    command_runner=None,
    image_id_resolver=None,
) -> list[str]:
    """Bind every materialized Compose service to config, RepoDigest and image ID.

    The materialized/running set must equal the configured long-lived set.  This keeps an enabled
    profile from disappearing behind an otherwise-green core subset.  Every long-lived service
    must have Docker health and be ``healthy``; ``running`` alone admits starting, unhealthy and
    healthcheck-free containers.  The exact one-shot migrator is required in configuration but
    must be absent after its ``docker compose run --rm`` post-integrity execution.
    """
    run = command_runner or subprocess.run
    resolve_image_id = image_id_resolver or docker_image_id
    compose_command = [str(OPS / "scripts" / "compose.sh"), "prod"]
    running_output = run(
        [*compose_command, "ps", "--services", "--status", "running"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    materialized_output = run(
        [*compose_command, "ps", "--all", "--services"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    configured_output = run(
        [*compose_command, "config", "--services"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    running = [line.strip() for line in running_output.splitlines() if line.strip()]
    materialized = [line.strip() for line in materialized_output.splitlines() if line.strip()]
    configured = [line.strip() for line in configured_output.splitlines() if line.strip()]
    if (not running or len(running) != len(set(running))
            or not materialized or len(materialized) != len(set(materialized))
            or not configured or len(configured) != len(set(configured))):
        raise ValueError("configured or materialized Compose service selection is empty or duplicated")
    running_set = set(running)
    materialized_set = set(materialized)
    configured_set = set(configured)
    one_shot_services = {"migrator"}
    if not one_shot_services.issubset(configured_set):
        raise ValueError("configured Compose service set lacks the exact one-shot migrator")
    expected_long_lived = configured_set - one_shot_services
    if materialized_set != expected_long_lived:
        raise ValueError("materialized Compose services differ from the exact configured long-lived set")
    if running_set != expected_long_lived:
        raise ValueError("running Compose services differ from the exact configured long-lived set")
    model_services = compose.get("services")
    if not isinstance(model_services, dict):
        raise ValueError("canonical Compose service model is absent")
    image_ids: dict[str, str] = {}
    container_identity: dict[str, str] = {}
    verified: list[str] = []
    for service in sorted(materialized):
        definition = model_services.get(service)
        if not isinstance(definition, dict):
            raise ValueError(f"active Compose service is absent from the canonical model: {service}")
        reference = definition.get("image")
        if (not isinstance(reference, str)
                or re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}", reference) is None):
            raise ValueError(f"active Compose service is not selected by an immutable RepoDigest: {service}")
        if reference not in image_ids:
            image_ids[reference] = resolve_image_id(reference)
        expected_id = image_ids[reference]

        hash_output = run(
            [*compose_command, "config", "--hash", service],
            check=True, capture_output=True, text=True, env=canonical_environment,
        ).stdout
        hash_lines = [line.strip() for line in hash_output.splitlines() if line.strip()]
        if len(hash_lines) != 1:
            raise ValueError(f"Compose returned an ambiguous config hash for {service}")
        hash_parts = hash_lines[0].split()
        if (len(hash_parts) != 2 or hash_parts[0] != service
                or re.fullmatch(r"[a-f0-9]{64}", hash_parts[1]) is None):
            raise ValueError(f"Compose returned an invalid config hash for {service}")
        expected_config_hash = hash_parts[1]

        ids_output = run(
            [*compose_command, "ps", "--all", "--quiet", service],
            check=True, capture_output=True, text=True, env=canonical_environment,
        ).stdout
        container_ids = [line.strip() for line in ids_output.splitlines() if line.strip()]
        if (not container_ids or len(container_ids) != len(set(container_ids))
                or any(re.fullmatch(r"[a-f0-9]{12,64}", value) is None for value in container_ids)):
            raise ValueError(f"materialized Compose service has no unambiguous container: {service}")
        if len(container_ids) != 1:
            raise ValueError(f"materialized Compose service does not resolve to exactly one container: {service}")
        container_identity[service] = container_ids[0]
        for container_id in container_ids:
            inspect_output = run(
                ["docker", "inspect", container_id], check=True, capture_output=True, text=True,
            ).stdout
            try:
                inspected = json.loads(inspect_output)
            except json.JSONDecodeError as error:
                raise ValueError(f"Docker returned invalid container identity for {service}") from error
            if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
                raise ValueError(f"Docker returned ambiguous container identity for {service}")
            container = inspected[0]
            config = container.get("Config")
            labels = config.get("Labels") if isinstance(config, dict) else None
            state = container.get("State")
            if not isinstance(state, dict):
                raise ValueError(f"Docker container state is absent for {service}")
            if state.get("Status") != "running":
                raise ValueError(f"materialized Compose service is not running: {service}")
            healthcheck = definition.get("healthcheck")
            if not isinstance(healthcheck, dict) or healthcheck.get("disable") is True:
                raise ValueError(f"materialized long-lived Compose service has no healthcheck: {service}")
            health = state.get("Health")
            if not isinstance(health, dict) or health.get("Status") != "healthy":
                raise ValueError(f"materialized Compose service is not Docker-healthy: {service}")
            if not isinstance(config, dict) or config.get("Image") != reference:
                raise ValueError(f"materialized Compose Config.Image differs from its selector for {service}")
            if container.get("Image") != expected_id:
                raise ValueError(f"materialized Compose image ID differs from its RepoDigest for {service}")
            if not isinstance(labels, dict) or labels.get("com.docker.compose.config-hash") != expected_config_hash:
                raise ValueError(f"materialized Compose config hash differs from the canonical service for {service}")
        verified.append(service)
    final_running_output = run(
        [*compose_command, "ps", "--services", "--status", "running"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    final_materialized_output = run(
        [*compose_command, "ps", "--all", "--services"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    final_configured_output = run(
        [*compose_command, "config", "--services"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout
    if ({line.strip() for line in final_running_output.splitlines() if line.strip()} != running_set
            or {line.strip() for line in final_materialized_output.splitlines() if line.strip()}
            != materialized_set
            or {line.strip() for line in final_configured_output.splitlines() if line.strip()}
            != configured_set):
        raise ValueError("materialized Compose service selection changed during identity verification")
    for service, container_id in sorted(container_identity.items()):
        final_ids_output = run(
            [*compose_command, "ps", "--all", "--quiet", service],
            check=True, capture_output=True, text=True, env=canonical_environment,
        ).stdout
        if [line.strip() for line in final_ids_output.splitlines() if line.strip()] != [container_id]:
            raise ValueError(f"materialized Compose container changed during verification: {service}")
        final_inspect_output = run(
            ["docker", "inspect", container_id], check=True, capture_output=True, text=True,
        ).stdout
        try:
            final_inspected = json.loads(final_inspect_output)
        except json.JSONDecodeError as error:
            raise ValueError(f"Docker returned invalid final container state for {service}") from error
        if not isinstance(final_inspected, list) or len(final_inspected) != 1:
            raise ValueError(f"Docker returned ambiguous final container state for {service}")
        final_state = final_inspected[0].get("State") if isinstance(final_inspected[0], dict) else None
        if (not isinstance(final_state, dict) or final_state.get("Status") != "running"
                or not isinstance(final_state.get("Health"), dict)
                or final_state["Health"].get("Status") != "healthy"):
            raise ValueError(f"materialized Compose service degraded during final verification: {service}")
    return verified


def verify_selected_writer_active_set(
    compose: dict,
    canonical_environment: dict[str, str],
    writer_snapshot: pathlib.Path,
    writer_snapshot_sha256: str,
    release_id: str,
) -> int:
    """Re-observe the selected recovery set, including DB leases.

    A content-addressed writer snapshot can remain perfectly valid while no
    longer describing the live fleet (most notably after Zeus is reactivated
    at the end of a bounded maintenance deploy).  Final host evidence therefore
    executes the same restored-state contract used by rollback/recovery instead
    of treating snapshot bytes as an attestation of current state.
    """
    writer_helper = str(OPS / "scripts" / "release-writer-state.py")
    serialized_compose = json.dumps(
        compose, sort_keys=True, separators=(",", ":")
    )
    classified = subprocess.run(
        [
            writer_helper,
            "--ops-root",
            str(OPS),
            "compose-model",
            "--runtime-image",
            str(compose.get("services", {}).get("gateway", {}).get("image", "")),
            "--console-image",
            str(compose.get("services", {}).get("console", {}).get("image", "")),
        ],
        check=True,
        capture_output=True,
        text=True,
        input=serialized_compose,
        env=canonical_environment,
    ).stdout
    compose_writers: list[str] = []
    for raw in classified.splitlines():
        fields = raw.split("\t")
        if len(fields) != 3:
            raise ValueError("writer Compose classification is malformed")
        role, service, _image = fields
        if role == "writer":
            if re.fullmatch(r"[a-z0-9][a-z0-9_-]*", service) is None:
                raise ValueError("writer Compose classification has an invalid service")
            compose_writers.append(service)
    if compose_writers != sorted(set(compose_writers)):
        raise ValueError("writer Compose classification is duplicated or non-canonical")

    fleet = subprocess.run(
        [
            str(OPS / "scripts" / "compose.sh"),
            "prod",
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "migrator",
            "node",
            "deploy/fleet-snapshot.mjs",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=canonical_environment,
    ).stdout
    check_command = [
        writer_helper,
        "--ops-root",
        str(OPS),
        "check",
        "--snapshot",
        os.fspath(writer_snapshot),
        "--expected-sha256",
        writer_snapshot_sha256,
        "--mode",
        "restored",
        "--fleet-stdin",
    ]
    for service in compose_writers:
        check_command.extend(("--compose-writer", service))
    subprocess.run(
        check_command,
        check=True,
        input=fleet,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=canonical_environment,
    )

    snapshot_document = json.loads(writer_snapshot.read_text(encoding="utf-8"))
    writers_expected = snapshot_document.get("writersExpectedCandidate")
    if type(writers_expected) is not int or writers_expected < 0:
        raise ValueError("selected writer snapshot has no canonical writer count")
    subprocess.run(
        [
            writer_helper,
            "--ops-root",
            str(OPS),
            "marker-check",
            "--snapshot",
            os.fspath(writer_snapshot),
            "--expected-sha256",
            writer_snapshot_sha256,
            "--path",
            f"{writer_snapshot}.state.json",
            "--release-id",
            release_id,
            "--mode",
            "candidate",
            "--writers-expected",
            str(writers_expected),
            "--writers-observed",
            str(writers_expected),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=canonical_environment,
    )
    return writers_expected


def verify_final_release_host(build: dict) -> list[dict[str, object]]:
    env_value = os.environ.get("CAUCE_ENV_FILE", "")
    if not env_value:
        raise ValueError("CAUCE_ENV_FILE is required for final release-host evidence")
    env_file = pathlib.Path(env_value)

    canonical_environment = os.environ.copy()
    for key in (
        "CAUCE_RUNTIME_IMAGE", "CAUCE_CONSOLE_IMAGE", "CAUCE_COMPOSE_OVERRIDE_MANIFEST",
        "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256",
        "CAUCE_ROLLBACK_BASELINE_FILE", "CAUCE_ROLLBACK_BASELINE_SHA256",
        "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE", "CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256",
        "CAUCE_COMPOSE_OVERRIDES_DIR", "CAUCE_LOCAL_POSTGRES", "CAUCE_BACKUP_STATUS_FILE",
    ):
        canonical_environment.pop(key, None)
    canonical_environment["CAUCE_ENV_FILE"] = os.fspath(env_file)

    (runtime_reference, console_reference, override_manifest, override_manifest_sha256,
     rollback_baseline, baseline_sha256, writer_snapshot, writer_snapshot_sha256) = (
        production_selectors(env_file)
    )
    subprocess.run(
        [
            str(OPS / "scripts" / "release-writer-state.py"), "--ops-root", str(OPS),
            "validate", "--snapshot", os.fspath(writer_snapshot),
            "--expected-sha256", writer_snapshot_sha256,
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    def validate_selected_writer_snapshot() -> None:
        subprocess.run(
            [
                str(OPS / "scripts" / "release-writer-state.py"), "--ops-root", str(OPS),
                "validate", "--snapshot", os.fspath(writer_snapshot),
                "--expected-sha256", writer_snapshot_sha256,
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
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
    override_environment["CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256"] = override_manifest_sha256
    canonical_environment["CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE"] = os.fspath(writer_snapshot)
    canonical_environment["CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256"] = writer_snapshot_sha256
    override_command = [str(OPS / "scripts" / "compose-files.sh"), "overrides"]
    active_overrides = subprocess.run(
        override_command,
        check=True, capture_output=True, text=True, env=override_environment,
    ).stdout
    if active_overrides:
        raise ValueError("release-candidate override manifest contains an active historical override")
    validate_selected_writer_snapshot()
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
    writer_count = verify_selected_writer_active_set(
        compose,
        canonical_environment,
        writer_snapshot,
        writer_snapshot_sha256,
        build["sourceRevision"]["commit"],
    )

    # This is intentionally a live execution, not a marker or remembered
    # stdout.  First prove the selected recovery set against units and leases;
    # only then run the broad gate, whose nested release-candidate invocation is
    # pre-release mode.  Re-read all eight selectors immediately afterwards so
    # the expensive gate cannot turn an earlier restored check into stale proof.
    subprocess.run(
        [str(OPS / "scripts" / "release-gate.sh")],
        check=True,
        env=canonical_environment,
    )
    if production_selectors(env_file) != (
        runtime_reference,
        console_reference,
        override_manifest,
        override_manifest_sha256,
        rollback_baseline,
        baseline_sha256,
        writer_snapshot,
        writer_snapshot_sha256,
    ):
        raise ValueError("production selectors changed during the live release gate")

    if verify_recovered_final_image(runtime_reference, build, "runtime") != build["runtime"]["imageId"]:
        raise ValueError("registry runtime digest did not recover the tested image ID")
    if verify_recovered_final_image(console_reference, build, "console") != build["console"]["imageId"]:
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
    transition_lock_fd = inherited_transition_lock_fd()
    pin_command = [
        str(OPS / "scripts" / "pin-production-release.py"), "check",
        "--env-file", os.fspath(env_file),
        "--expected-runtime-image", runtime_reference,
        "--target-runtime-image", runtime_reference,
        "--expected-console-image", console_reference,
        "--target-console-image", console_reference,
        "--expected-override-manifest", os.fspath(override_manifest),
        "--target-override-manifest", os.fspath(override_manifest),
        "--expected-override-manifest-sha256", override_manifest_sha256,
        "--target-override-manifest-sha256", override_manifest_sha256,
        "--expected-rollback-baseline", os.fspath(rollback_baseline),
        "--target-rollback-baseline", os.fspath(rollback_baseline),
        "--expected-rollback-baseline-sha256", baseline_sha256,
        "--target-rollback-baseline-sha256", baseline_sha256,
        "--expected-writer-snapshot", os.fspath(writer_snapshot),
        "--target-writer-snapshot", os.fspath(writer_snapshot),
        "--expected-writer-snapshot-sha256", writer_snapshot_sha256,
        "--target-writer-snapshot-sha256", writer_snapshot_sha256,
        "--baseline-forward-release-commit", build["sourceRevision"]["commit"],
        "--baseline-forward-runtime-image", runtime_reference,
        "--baseline-forward-runtime-source-digest", build["sourceDigest"],
    ]
    pin_run_options: dict[str, object] = {}
    if transition_lock_fd is not None:
        pin_command.extend(("--lock-fd", str(transition_lock_fd)))
        pin_run_options["pass_fds"] = (transition_lock_fd,)
    subprocess.run(
        pin_command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        **pin_run_options,
    )
    if subprocess.run(
        override_command, check=True, capture_output=True, text=True, env=override_environment,
    ).stdout:
        raise ValueError("release-candidate override manifest changed to include an active override")
    validate_selected_writer_snapshot()
    refreshed_compose = json.loads(subprocess.run(
        [str(OPS / "scripts" / "compose.sh"), "prod", "config", "--format", "json"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout)
    if refreshed_compose != compose:
        raise ValueError("canonical production Compose changed during final re-verification")
    active_services = verify_active_compose_containers(refreshed_compose, canonical_environment)
    validate_selected_writer_snapshot()
    final_compose = json.loads(subprocess.run(
        [str(OPS / "scripts" / "compose.sh"), "prod", "config", "--format", "json"],
        check=True, capture_output=True, text=True, env=canonical_environment,
    ).stdout)
    if final_compose != refreshed_compose:
        raise ValueError("canonical production Compose changed during live container verification")
    final_writer_count = verify_selected_writer_active_set(
        final_compose,
        canonical_environment,
        writer_snapshot,
        writer_snapshot_sha256,
        build["sourceRevision"]["commit"],
    )
    if final_writer_count != writer_count:
        raise ValueError("selected writer active-set count changed during final verification")
    return [
        {"name": "complete live release-host gate returned success", "status": "passed", "evidenceKind": "release-build"},
        {"name": "production env and every Compose runtime service resolve exact release RepoDigests", "status": "passed", "evidenceKind": "release-build"},
        {"name": "registry pull recovered the runtime and console image IDs that passed QA", "status": "passed", "evidenceKind": "release-build"},
        {"name": "clean RC revision and source domains remained unchanged through the host gate", "status": "passed", "evidenceKind": "release-build"},
        {"name": "durable rollback baseline recovered exact bridge runtime and console image IDs", "status": "passed", "evidenceKind": "release-build"},
        {"name": f"selected writer snapshot, marker and {writer_count} restored writers match live units and leases", "status": "passed", "evidenceKind": "release-build"},
        {"name": f"{len(active_services)} materialized Compose services matched state, RepoDigest, image ID and config hash", "status": "passed", "evidenceKind": "release-build"},
    ]


# Every artifact is compared against the domain that can actually change its result, not against one
# whole-tree digest. Binding runtime fault evidence to apps/console was pure over-coverage: the
# evidence is expensive to regenerate, the console cannot influence it, and the predictable outcome
# was hand-edited evidence. ops/scripts/source-digest.py justifies each domain boundary.
SOURCE_DIGESTS = {
    domain: source_digest_for(domain)
    for domain in ("runtime", "console", "harness", "testcontainers", "verification", "full")
}
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
    "migration-integrity-post": "runtime",
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
migration_post = load(migration_dir / "post.json")
outbox_reconciliation = load(outbox_reconciliation_dir / "pre.json")

schema(verification, OPS / "schemas" / "verification-evidence.schema.json", "verification")
if build:
    schema(build, OPS / "schemas" / "build-evidence.schema.json", "build")
if compose:
    schema(compose, OPS / "schemas" / "test-evidence.schema.json", "compose-authentic")
schema(runtime, OPS / "schemas" / "test-evidence.schema.json", "runtime-authentic")
schema(fleet, ROOT / "tests" / "fleet-release" / "fleet-release-report.schema.json", "fleet-release")
schema(migration, OPS / "schemas" / "migration-integrity-evidence.schema.json", "migration-integrity-pre")
schema(migration_post, OPS / "schemas" / "migration-integrity-evidence.schema.json", "migration-integrity-post")

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
    {"pre.json", "post.json"},
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
    validate_platform_evidence(build)
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
validate_migration_pair(migration, migration_post, expected_migration_sources)
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

testcontainer_runs: list[tuple[datetime.datetime, int, pathlib.Path]] = []
for path in (OPS / "artifacts" / "testcontainers").glob("*"):
    if not (path / "real" / "report.json").is_file() or not (path / "restarts" / "report.json").is_file():
        continue
    match = re.fullmatch(r"(\d{8}T\d{6}Z)-(\d+)", path.name)
    if match is None:
        ERRORS.append(f"complete Testcontainers run has a non-canonical directory name: {path.name}")
        continue
    try:
        started = datetime.datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(
            tzinfo=datetime.timezone.utc,
        )
    except ValueError:
        ERRORS.append(f"complete Testcontainers run has an invalid timestamp: {path.name}")
        continue
    testcontainer_runs.append((started, int(match.group(2)), path))
if not testcontainer_runs:
    ERRORS.append("no complete Testcontainers real/restarts evidence exists")
    testcontainers_dir = OPS / "artifacts" / "testcontainers" / "missing"
    real = {}
    restarts = {}
else:
    testcontainer_started, _, testcontainers_dir = max(testcontainer_runs, key=lambda item: (item[0], item[1]))
    now = datetime.datetime.now(datetime.timezone.utc)
    if testcontainer_started > now + datetime.timedelta(minutes=5):
        ERRORS.append("latest Testcontainers evidence directory is from the future")
    if now - testcontainer_started > datetime.timedelta(hours=168):
        ERRORS.append("latest Testcontainers evidence is older than seven days")
    try:
        subprocess.run(
            [sys.executable, str(OPS / "scripts" / "validate-testcontainers-evidence.py"),
             "--run-dir", str(testcontainers_dir.resolve())],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        ERRORS.append("latest Testcontainers evidence failed schema/source/image/harness validation")
    real = load(testcontainers_dir / "real" / "report.json")
    restarts = load(testcontainers_dir / "restarts" / "report.json")
    schema(real, OPS / "schemas" / "testcontainers-evidence.schema.json", "testcontainers-real")
    schema(restarts, OPS / "schemas" / "testcontainers-evidence.schema.json", "testcontainers-restarts")
    for label, report in (("testcontainers-real", real), ("testcontainers-restarts", restarts)):
        if report.get("sourceDigest") != runtime_source_digest or report.get("sourceDigestDomain") != "runtime":
            ERRORS.append(f"{label} differs from current runtime sources")
        if (report.get("harnessDigest") != SOURCE_DIGESTS["testcontainers"]
                or report.get("harnessDigestDomain") != "testcontainers"):
            ERRORS.append(f"{label} differs from current Testcontainers harness")
    if real.get("databaseImage") != restarts.get("databaseImage"):
        ERRORS.append("Testcontainers real and restart evidence used different database images")
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
    ("migration-integrity-post", migration_dir / "post.json"),
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
    {"name": "all release migrations passed post-integrity with atomic ledgers", "status": "passed", "evidenceKind": "migration-integrity-post"},
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

    # The nested live release gate deliberately re-collects DB evidence.  Never
    # publish the hashes captured before that run: reload the files, require
    # their measured content to remain identical apart from generatedAt, and
    # bind the final candidate to the refreshed bytes.
    refreshed_migration = load(migration_dir / "pre.json")
    refreshed_migration_post = load(migration_dir / "post.json")
    refreshed_outbox = load(outbox_reconciliation_dir / "pre.json")
    schema(
        refreshed_migration,
        OPS / "schemas" / "migration-integrity-evidence.schema.json",
        "migration-integrity-pre-refreshed",
    )
    schema(
        refreshed_migration_post,
        OPS / "schemas" / "migration-integrity-evidence.schema.json",
        "migration-integrity-post-refreshed",
    )
    verify_sha_directory(migration_dir, {"pre.json", "post.json"})
    verify_sha_directory(outbox_reconciliation_dir, {"pre.json"})
    if without_observation_time(refreshed_migration) != without_observation_time(migration):
        ERRORS.append("pre-migration evidence changed semantically during the live host gate")
    if without_observation_time(refreshed_migration_post) != without_observation_time(migration_post):
        ERRORS.append("post-migration evidence changed semantically during the live host gate")
    if without_observation_time(refreshed_outbox) != without_observation_time(outbox_reconciliation):
        ERRORS.append("outbox reconciliation evidence changed semantically during the live host gate")
    try:
        refreshed_pre_at = datetime.datetime.fromisoformat(
            str(refreshed_migration.get("generatedAt", "")).replace("Z", "+00:00")
        )
        refreshed_post_at = datetime.datetime.fromisoformat(
            str(refreshed_migration_post.get("generatedAt", "")).replace("Z", "+00:00")
        )
        if refreshed_post_at < refreshed_pre_at:
            ERRORS.append("refreshed post-migration evidence predates refreshed pre-migration evidence")
    except (TypeError, ValueError):
        ERRORS.append("refreshed pre/post migration evidence has an invalid generatedAt timestamp")
    if ERRORS:
        for error in ERRORS:
            print(f"release candidate failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    evidence = [
        {
            "kind": kind,
            "path": path.relative_to(ROOT).as_posix(),
            "sha256": sha256(path),
            "sourceDigest": SOURCE_DIGESTS[EVIDENCE_DOMAINS[kind]],
            "sourceDigestDomain": EVIDENCE_DOMAINS[kind],
        }
        for kind, path in evidence_paths
    ]

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
validation = sorted(
    Draft202012Validator(schema_definition, format_checker=FormatChecker()).iter_errors(report),
    key=schema_error_sort_key,
)
if validation:
    for error in validation:
        print(f"release candidate schema failed: {safe_schema_diagnostic(error)}", file=sys.stderr)
    raise SystemExit(1)

OUTPUT.mkdir(parents=True, exist_ok=True)
source_text = "".join(f"{domain} {value}\n" for domain, value in SOURCE_DIGESTS.items())
json_text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
release_host_status = "passed" if ARGUMENTS.release_host_ready else "blocked"
release_host_test = (
    "release-host-live-gate-and-final-reverification"
    if ARGUMENTS.release_host_ready else "release-host-prerequisites-explicit"
)
junit_skipped = "0" if ARGUMENTS.release_host_ready else "1"
junit_blocked_detail = "" if ARGUMENTS.release_host_ready else '<skipped message="external release-host prerequisites remain blocked"/>'
junit_text = "\n".join((
    '<?xml version="1.0" encoding="UTF-8"?>',
    f'<testsuite name="cauce-v3-release-candidate" tests="2" failures="0" skipped="{junit_skipped}">',
    f'  <properties><property name="sourceDigest" value="{full_source_digest}"/>'
    f'<property name="runtimeSourceDigest" value="{runtime_source_digest}"/>'
    f'<property name="releaseHostGate" value="{release_host_status}"/></properties>',
    '  <testcase classname="cauce.release" name="code-runtime-gate"/>',
    f'  <testcase classname="cauce.release" name="{release_host_test}">{junit_blocked_detail}</testcase>',
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
