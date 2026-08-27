#!/usr/bin/env python3
"""Create and fail-closed validate the immutable production rollback baseline."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
GIT_OBJECT = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
RELEASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
IMAGE_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$"
)
SAFE_PATH = re.compile(r"^/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$")
FIELDS = {
    "baseline-kind": ("baselineKind",),
    "bridge-runtime-image": ("bridgeRuntime", "repositoryDigest"),
    "bridge-runtime-image-id": ("bridgeRuntime", "imageId"),
    "console-image": ("console", "repositoryDigest"),
    "console-image-id": ("console", "imageId"),
    "override-manifest": ("overrideManifest", "path"),
    "override-manifest-sha256": ("overrideManifest", "sha256"),
    "bridge-evidence": ("bridgeEvidence", "path"),
    "bridge-evidence-sha256": ("bridgeEvidence", "sha256"),
    "forward-release-commit": ("forwardReleaseCommit",),
    "forward-runtime-image": ("forwardRuntime", "repositoryDigest"),
    "forward-runtime-image-id": ("forwardRuntime", "imageId"),
    "forward-runtime-source-digest": ("forwardRuntime", "sourceDigest"),
    "legacy-fleet-snapshot": ("legacyFleetSnapshot", "path"),
    "legacy-fleet-snapshot-sha256": ("legacyFleetSnapshot", "sha256"),
}
LEGACY_SOURCE_SENTINEL = "legacy-pre-migration-unavailable"


class BaselineError(ValueError):
    pass


def _digest(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def _metadata_signature(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _safe_path(value: str, *, label: str) -> pathlib.Path:
    if SAFE_PATH.fullmatch(value) is None:
        raise BaselineError(f"{label} must be a normalized absolute path without whitespace")
    path = pathlib.Path(value)
    if not path.is_absolute() or path != pathlib.Path(os.path.normpath(value)):
        raise BaselineError(f"{label} must be a normalized absolute path")
    return path


def _private_file(path: pathlib.Path, *, label: str) -> tuple[bytes, os.stat_result]:
    if not path.is_absolute():
        raise BaselineError(f"{label} path must be absolute")
    try:
        metadata = path.lstat()
    except OSError as error:
        raise BaselineError(f"{label} is missing or unreadable") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid not in {0, os.geteuid()}
    ):
        raise BaselineError(f"{label} must be an owned single-link mode-0600 regular file")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise BaselineError(f"{label} cannot be opened safely") from error
    try:
        opened = os.fstat(descriptor)
        if _metadata_signature(opened) != _metadata_signature(metadata):
            raise BaselineError(f"{label} changed before it was opened")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if _metadata_signature(after) != _metadata_signature(opened):
            raise BaselineError(f"{label} changed while it was read")
        return b"".join(chunks), opened
    finally:
        os.close(descriptor)


def _schema() -> dict[str, Any]:
    try:
        value = json.loads(
            (OPS / "schemas" / "rollback-baseline.schema.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as error:
        raise BaselineError("rollback baseline schema is missing or invalid") from error
    if not isinstance(value, dict):
        raise BaselineError("rollback baseline schema root is invalid")
    return value


def _validate_report(report: object) -> dict[str, Any]:
    failures = sorted(
        Draft202012Validator(_schema(), format_checker=FormatChecker()).iter_errors(report),
        key=lambda item: list(item.absolute_path),
    )
    if failures:
        location = ".".join(map(str, failures[0].absolute_path)) or "<root>"
        raise BaselineError(f"rollback baseline schema failed at {location}")
    assert isinstance(report, dict)
    try:
        created = datetime.datetime.fromisoformat(report["createdAt"].replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise BaselineError("rollback baseline timestamp is invalid") from error
    if created.tzinfo is None:
        raise BaselineError("rollback baseline timestamp lacks a timezone")
    if created.astimezone(datetime.timezone.utc) > (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)
    ):
        raise BaselineError("rollback baseline timestamp is from the future")
    return report


def _decode_report(content: bytes) -> dict[str, Any]:
    try:
        report = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BaselineError("rollback baseline is not valid UTF-8 JSON") from error
    return _validate_report(report)


def _load_baseline(path: pathlib.Path, expected_sha256: str) -> dict[str, Any]:
    if DIGEST.fullmatch(expected_sha256) is None:
        raise BaselineError("authorized rollback baseline SHA-256 is invalid")
    content, _ = _private_file(path, label="rollback baseline")
    if _digest(content) != expected_sha256:
        raise BaselineError("rollback baseline differs from its authorized SHA-256")
    return _decode_report(content)


def _docker_image(reference: str) -> str:
    if IMAGE_REF.fullmatch(reference) is None:
        raise BaselineError("rollback baseline contains a mutable or invalid image reference")
    try:
        subprocess.run(
            ["docker", "pull", reference],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        identifier = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        repo_digests_text = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", reference],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise BaselineError("rollback image could not be recovered from its registry") from error
    try:
        repo_digests = json.loads(repo_digests_text)
    except json.JSONDecodeError as error:
        raise BaselineError("rollback image registry metadata is invalid") from error
    if not isinstance(repo_digests, list) or reference not in repo_digests:
        raise BaselineError("rollback image is not bound to its requested repository digest")
    if DIGEST.fullmatch(identifier) is None:
        raise BaselineError("rollback image resolved to an invalid image ID")
    return identifier


def _bridge_report(path: pathlib.Path, expected_sha256: str) -> dict[str, Any]:
    if DIGEST.fullmatch(expected_sha256) is None:
        raise BaselineError("rollback bridge evidence SHA-256 is invalid")
    content, _ = _private_file(path, label="rollback bridge evidence")
    if _digest(content) != expected_sha256:
        raise BaselineError("rollback bridge evidence differs from its authorized SHA-256")
    try:
        report = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BaselineError("rollback bridge evidence is not valid UTF-8 JSON") from error
    if not isinstance(report, dict):
        raise BaselineError("rollback bridge evidence root is invalid")
    return report


def _validate_bridge(
    path: pathlib.Path,
    expected_sha256: str,
    repository_digest: str,
    image_id: str,
    candidate_repository_digest: str,
    candidate_image_id: str,
    candidate_source_digest: str,
) -> dict[str, Any]:
    report = _bridge_report(path, expected_sha256)
    try:
        subprocess.run(
            [
                sys.executable,
                str(OPS / "scripts" / "validate-rollback-bridge-evidence.py"),
                "--evidence", os.fspath(path),
                "--expected-evidence-sha256", expected_sha256,
                "--expected-repository-digest", repository_digest,
                "--expected-image-id", image_id,
                "--expected-candidate-repository-digest", candidate_repository_digest,
                "--expected-candidate-image-id", candidate_image_id,
                "--expected-candidate-source-digest", candidate_source_digest,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise BaselineError("rollback bridge evidence did not pass its exact validator") from error
    return report


def _manifest(path: pathlib.Path, expected_sha256: str | None = None) -> str:
    content, _ = _private_file(path, label="rollback override manifest")
    observed = _digest(content)
    if expected_sha256 is not None and observed != expected_sha256:
        raise BaselineError("rollback override manifest differs from the baseline")
    return observed


def _check_expected(report: dict[str, Any], arguments: argparse.Namespace) -> None:
    legacy = report.get("baselineKind") == "legacy-pre-migration"
    comparisons = (
        (arguments.expected_baseline_kind, report.get("baselineKind", "canonical-bridge")),
        (arguments.expected_forward_release_commit, report["forwardReleaseCommit"]),
        (arguments.expected_forward_runtime_image, report["forwardRuntime"]["repositoryDigest"]),
        (arguments.expected_forward_runtime_image_id, report["forwardRuntime"]["imageId"]),
        (
            arguments.expected_forward_runtime_source_digest,
            report["forwardRuntime"].get("sourceDigest", LEGACY_SOURCE_SENTINEL),
        ),
        (
            arguments.expected_runtime_image,
            report.get("bridgeRuntime", {}).get("repositoryDigest"),
        ),
        (arguments.expected_console_image, report["console"]["repositoryDigest"]),
        (arguments.expected_override_manifest, report["overrideManifest"]["path"]),
        (
            arguments.expected_bridge_evidence,
            report.get("bridgeEvidence", {}).get("path"),
        ),
        (
            arguments.expected_bridge_evidence_sha256,
            report.get("bridgeEvidence", {}).get("sha256"),
        ),
        (
            arguments.expected_legacy_fleet_snapshot,
            report.get("legacyFleetSnapshot", {}).get("path"),
        ),
        (
            arguments.expected_legacy_fleet_snapshot_sha256,
            report.get("legacyFleetSnapshot", {}).get("sha256"),
        ),
    )
    if any(expected is not None and expected != observed for expected, observed in comparisons):
        raise BaselineError("rollback baseline differs from an explicitly expected release field")
    if legacy and any(
        value is not None
        for value in (
            arguments.expected_runtime_image,
            arguments.expected_bridge_evidence,
            arguments.expected_bridge_evidence_sha256,
        )
    ):
        raise BaselineError("legacy pre-migration baseline cannot claim a rollback bridge")


def _legacy_fleet_report(path: pathlib.Path, expected_sha256: str) -> dict[str, Any]:
    if DIGEST.fullmatch(expected_sha256) is None:
        raise BaselineError("legacy fleet snapshot SHA-256 is invalid")
    content, _ = _private_file(path, label="legacy fleet snapshot")
    if _digest(content) != expected_sha256:
        raise BaselineError("legacy fleet snapshot differs from its authorized SHA-256")
    try:
        report = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BaselineError("legacy fleet snapshot is not valid UTF-8 JSON") from error
    if not isinstance(report, dict):
        raise BaselineError("legacy fleet snapshot root is invalid")
    required = {"kind", "schemaVersion", "project", "selectors", "services"}
    if set(report) != required or report.get("kind") != "cauce-v3-legacy-pre-migration-fleet" \
            or report.get("schemaVersion") != 1 or report.get("project") != "cauce-v3-prod":
        raise BaselineError("legacy fleet snapshot envelope is invalid")
    selectors = report.get("selectors")
    services = report.get("services")
    if not isinstance(selectors, dict) or set(selectors) != {
        "console", "manifest", "manifestSha256", "normalizedConsole",
        "normalizedRuntime", "runtime",
    } or not isinstance(services, list) or not services:
        raise BaselineError("legacy fleet snapshot selectors or services are invalid")
    seen: set[str] = set()
    saw_migrator = False
    for item in services:
        if not isinstance(item, dict) or set(item) != {
            "configHash", "configImage", "containerId", "exitCode", "imageId",
            "repositoryDigest", "service", "status",
        }:
            raise BaselineError("legacy fleet snapshot service record is invalid")
        service = item["service"]
        if not isinstance(service, str) or re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,127}", service) is None \
                or service in seen:
            raise BaselineError("legacy fleet snapshot service identity is invalid")
        seen.add(service)
        if DIGEST.fullmatch(item["imageId"]) is None or IMAGE_REF.fullmatch(item["repositoryDigest"]) is None \
                or re.fullmatch(r"[a-f0-9]{64}", item["configHash"]) is None \
                or re.fullmatch(r"[a-f0-9]{12,64}", item["containerId"]) is None \
                or not isinstance(item["configImage"], str):
            raise BaselineError("legacy fleet snapshot image/config identity is invalid")
        if service == "migrator":
            saw_migrator = True
            if item["status"] != "exited" or item["exitCode"] != 0:
                raise BaselineError("legacy fleet snapshot migrator is not exited/0")
        elif item["status"] != "running" or item["exitCode"] != 0:
            raise BaselineError("legacy fleet snapshot long-lived service is not running")
    if not saw_migrator:
        raise BaselineError("legacy fleet snapshot omits the materialized migrator")
    return report


def _check_external(report: dict[str, Any]) -> None:
    forward = report["forwardRuntime"]
    console = report["console"]
    forward_id = _docker_image(forward["repositoryDigest"])
    if forward_id != forward["imageId"]:
        raise BaselineError("registry-recovered forward runtime ID differs from the baseline")
    console_id = _docker_image(console["repositoryDigest"])
    if console_id != console["imageId"]:
        raise BaselineError("registry-recovered rollback console ID differs from the baseline")
    manifest = report["overrideManifest"]
    _manifest(_safe_path(manifest["path"], label="rollback override manifest"), manifest["sha256"])
    if report.get("baselineKind") == "legacy-pre-migration":
        snapshot = report["legacyFleetSnapshot"]
        fleet = _legacy_fleet_report(
            _safe_path(snapshot["path"], label="legacy fleet snapshot"),
            snapshot["sha256"],
        )
        selectors = fleet["selectors"]
        if selectors["normalizedRuntime"] != forward["repositoryDigest"] \
                or selectors["normalizedConsole"] != console["repositoryDigest"] \
                or selectors["manifest"] != manifest["path"] \
                or selectors["manifestSha256"] != manifest["sha256"]:
            raise BaselineError("legacy fleet snapshot differs from baseline selectors")
        recovered: dict[str, str] = {}
        for item in fleet["services"]:
            reference = item["repositoryDigest"]
            if reference not in recovered:
                recovered[reference] = _docker_image(reference)
            image_id = recovered[reference]
            if image_id != item["imageId"]:
                raise BaselineError("registry-recovered legacy fleet image ID differs from snapshot")
        return
    runtime = report["bridgeRuntime"]
    runtime_id = _docker_image(runtime["repositoryDigest"])
    if runtime_id != runtime["imageId"]:
        raise BaselineError("registry-recovered bridge runtime ID differs from the baseline")
    evidence = report["bridgeEvidence"]
    bridge = _validate_bridge(
        _safe_path(evidence["path"], label="rollback bridge evidence"),
        evidence["sha256"],
        runtime["repositoryDigest"],
        runtime_id,
        forward["repositoryDigest"],
        forward_id,
        forward["sourceDigest"],
    )
    try:
        source_digest = bridge["sourceDigest"]
        patch_source_commit = bridge["sourceRevision"]["patchSourceCommit"]
        resulting_bridge_tree = bridge["sourceRevision"]["resultingBridgeTree"]
    except (KeyError, TypeError) as error:
        raise BaselineError("rollback bridge evidence lacks source provenance") from error
    if (source_digest != runtime["sourceDigest"]
            or patch_source_commit != runtime["patchSourceCommit"]
            or resulting_bridge_tree != runtime["resultingBridgeTree"]):
        raise BaselineError("rollback baseline bridge provenance differs from its evidence")


def _publish(output: pathlib.Path, content: bytes) -> None:
    output_text = os.fspath(output)
    _safe_path(output_text, label="rollback baseline output")
    parent = output.parent
    try:
        if parent.resolve(strict=True) != parent:
            raise BaselineError("rollback baseline output directory must not traverse symlinks")
    except OSError as error:
        raise BaselineError("rollback baseline output directory is missing") from error
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        directory = os.open(parent, flags)
    except OSError as error:
        raise BaselineError("rollback baseline output directory cannot be opened safely") from error
    temporary = f".{output.name}.baseline-{os.getpid()}-{secrets.token_hex(8)}"
    descriptor = -1
    linked = False
    published = False
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
            0o600,
            dir_fd=directory,
        )
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.link(
            temporary,
            output.name,
            src_dir_fd=directory,
            dst_dir_fd=directory,
            follow_symlinks=False,
        )
        linked = True
        os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)
        published = True
    except FileExistsError as error:
        raise BaselineError("rollback baseline already exists or appeared concurrently") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if not published:
            if linked:
                try:
                    os.unlink(output.name, dir_fd=directory)
                except FileNotFoundError:
                    pass
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.fsync(directory)
        os.close(directory)


def _create(arguments: argparse.Namespace) -> str:
    if GIT_OBJECT.fullmatch(arguments.forward_release_commit) is None:
        raise BaselineError("forward release commit must be a full Git object ID")
    if DIGEST.fullmatch(arguments.forward_runtime_source_digest) is None:
        raise BaselineError("forward runtime source digest is invalid")
    forward_runtime_id = _docker_image(arguments.forward_runtime_image)
    runtime_id = _docker_image(arguments.bridge_runtime_image)
    console_id = _docker_image(arguments.console_image)
    manifest_path = _safe_path(arguments.override_manifest, label="rollback override manifest")
    evidence_path = _safe_path(arguments.bridge_evidence, label="rollback bridge evidence")
    manifest_sha = _manifest(manifest_path)
    bridge = _validate_bridge(
        evidence_path,
        arguments.bridge_evidence_sha256,
        arguments.bridge_runtime_image,
        runtime_id,
        arguments.forward_runtime_image,
        forward_runtime_id,
        arguments.forward_runtime_source_digest,
    )
    try:
        source_digest = bridge["sourceDigest"]
        patch_source_commit = bridge["sourceRevision"]["patchSourceCommit"]
        resulting_bridge_tree = bridge["sourceRevision"]["resultingBridgeTree"]
    except (KeyError, TypeError) as error:
        raise BaselineError("rollback bridge evidence lacks source provenance") from error
    report = _validate_report({
        "schemaVersion": 1,
        "suite": "cauce-v3-rollback-baseline",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "forwardReleaseCommit": arguments.forward_release_commit,
        "forwardRuntime": {
            "repositoryDigest": arguments.forward_runtime_image,
            "imageId": forward_runtime_id,
            "sourceDigest": arguments.forward_runtime_source_digest,
        },
        "bridgeRuntime": {
            "repositoryDigest": arguments.bridge_runtime_image,
            "imageId": runtime_id,
            "sourceDigest": source_digest,
            "patchSourceCommit": patch_source_commit,
            "resultingBridgeTree": resulting_bridge_tree,
        },
        "console": {
            "repositoryDigest": arguments.console_image,
            "imageId": console_id,
        },
        "overrideManifest": {"path": os.fspath(manifest_path), "sha256": manifest_sha},
        "bridgeEvidence": {
            "path": os.fspath(evidence_path),
            "sha256": arguments.bridge_evidence_sha256,
        },
    })
    content = (json.dumps(report, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    _publish(arguments.output, content)
    published, _ = _private_file(arguments.output, label="published rollback baseline")
    if published != content:
        raise BaselineError("published rollback baseline failed its atomic read-back")
    return _digest(content)


def _create_legacy(arguments: argparse.Namespace) -> str:
    """Publish the one-time pre-migration baseline without inventing a bridge."""
    if RELEASE_ID.fullmatch(arguments.forward_release_commit) is None:
        raise BaselineError("legacy release ID is invalid")
    runtime_id = _docker_image(arguments.forward_runtime_image)
    console_id = _docker_image(arguments.console_image)
    manifest_path = _safe_path(arguments.override_manifest, label="rollback override manifest")
    snapshot_path = _safe_path(arguments.legacy_fleet_snapshot, label="legacy fleet snapshot")
    manifest_sha = _manifest(manifest_path)
    fleet = _legacy_fleet_report(snapshot_path, arguments.legacy_fleet_snapshot_sha256)
    selectors = fleet["selectors"]
    if selectors["normalizedRuntime"] != arguments.forward_runtime_image \
            or selectors["normalizedConsole"] != arguments.console_image \
            or selectors["manifest"] != os.fspath(manifest_path) \
            or selectors["manifestSha256"] != manifest_sha:
        raise BaselineError("legacy fleet snapshot does not bind the requested selectors")
    service_ids = {item["imageId"] for item in fleet["services"]}
    if runtime_id not in service_ids or console_id not in service_ids:
        raise BaselineError("legacy fleet does not exercise both normalized image selectors")
    report = _validate_report({
        "schemaVersion": 2,
        "suite": "cauce-v3-rollback-baseline",
        "baselineKind": "legacy-pre-migration",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "forwardReleaseCommit": arguments.forward_release_commit,
        "forwardRuntime": {
            "repositoryDigest": arguments.forward_runtime_image,
            "imageId": runtime_id,
        },
        "console": {
            "repositoryDigest": arguments.console_image,
            "imageId": console_id,
        },
        "overrideManifest": {"path": os.fspath(manifest_path), "sha256": manifest_sha},
        "legacyFleetSnapshot": {
            "path": os.fspath(snapshot_path),
            "sha256": arguments.legacy_fleet_snapshot_sha256,
        },
    })
    if arguments.output.exists() or arguments.output.is_symlink():
        existing_content, _ = _private_file(arguments.output, label="legacy rollback baseline")
        existing = _decode_report(existing_content)
        if existing.get("baselineKind") != "legacy-pre-migration":
            raise BaselineError("existing rollback baseline is not a legacy pre-migration baseline")
        comparable_existing = dict(existing)
        comparable_report = dict(report)
        comparable_existing.pop("createdAt", None)
        comparable_report.pop("createdAt", None)
        if comparable_existing != comparable_report:
            raise BaselineError("existing legacy rollback baseline differs from the retry candidate")
        _check_external(existing)
        return _digest(existing_content)
    content = (json.dumps(report, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    _publish(arguments.output, content)
    published, _ = _private_file(arguments.output, label="published legacy rollback baseline")
    if published != content:
        raise BaselineError("published legacy rollback baseline failed its atomic read-back")
    _check_external(report)
    return _digest(content)


def _add_expected(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--expected-baseline-kind")
    parser.add_argument("--expected-forward-release-commit")
    parser.add_argument("--expected-forward-runtime-image")
    parser.add_argument("--expected-forward-runtime-image-id")
    parser.add_argument("--expected-forward-runtime-source-digest")
    parser.add_argument("--expected-runtime-image")
    parser.add_argument("--expected-console-image")
    parser.add_argument("--expected-override-manifest")
    parser.add_argument("--expected-bridge-evidence")
    parser.add_argument("--expected-bridge-evidence-sha256")
    parser.add_argument("--expected-legacy-fleet-snapshot")
    parser.add_argument("--expected-legacy-fleet-snapshot-sha256")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--output", required=True, type=pathlib.Path)
    create.add_argument("--forward-release-commit", required=True)
    create.add_argument("--forward-runtime-image", required=True)
    create.add_argument("--forward-runtime-source-digest", required=True)
    create.add_argument("--bridge-runtime-image", required=True)
    create.add_argument("--console-image", required=True)
    create.add_argument("--override-manifest", required=True)
    create.add_argument("--bridge-evidence", required=True)
    create.add_argument("--bridge-evidence-sha256", required=True)
    legacy = subparsers.add_parser("create-legacy")
    legacy.add_argument("--output", required=True, type=pathlib.Path)
    legacy.add_argument("--forward-release-commit", required=True)
    legacy.add_argument("--forward-runtime-image", required=True)
    legacy.add_argument("--console-image", required=True)
    legacy.add_argument("--override-manifest", required=True)
    legacy.add_argument("--legacy-fleet-snapshot", required=True)
    legacy.add_argument("--legacy-fleet-snapshot-sha256", required=True)
    check = subparsers.add_parser("check")
    check.add_argument("--baseline", required=True, type=pathlib.Path)
    check.add_argument("--expected-baseline-sha256", required=True)
    _add_expected(check)
    field = subparsers.add_parser("field")
    field.add_argument("--baseline", required=True, type=pathlib.Path)
    field.add_argument("--expected-baseline-sha256", required=True)
    field.add_argument("--name", choices=tuple(FIELDS), required=True)
    arguments = parser.parse_args(argv)
    try:
        if arguments.action == "create":
            print(_create(arguments))
            return 0
        if arguments.action == "create-legacy":
            print(_create_legacy(arguments))
            return 0
        report = _load_baseline(arguments.baseline, arguments.expected_baseline_sha256)
        if arguments.action == "field":
            if arguments.name == "baseline-kind":
                value: object = report.get("baselineKind", "canonical-bridge")
            elif arguments.name == "forward-runtime-source-digest" \
                    and report.get("baselineKind") == "legacy-pre-migration":
                value = LEGACY_SOURCE_SENTINEL
            else:
                value = report
                for key in FIELDS[arguments.name]:
                    assert isinstance(value, dict)
                    value = value[key]
            if not isinstance(value, str) or "\n" in value or "\r" in value:
                raise BaselineError("rollback baseline field is invalid")
            print(value)
            return 0
        _check_expected(report, arguments)
        _check_external(report)
    except (OSError, BaselineError, KeyError) as error:
        print(f"rollback baseline failed: {error}", file=sys.stderr)
        return 1
    print("rollback baseline passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
