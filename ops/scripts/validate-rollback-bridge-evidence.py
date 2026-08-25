#!/usr/bin/env python3
"""Validate immutable, source-bound rollback bridge evidence without printing its contents."""

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
import tempfile

from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
IMAGE_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$"
)


class BridgeError(ValueError):
    pass


def private_file(path: pathlib.Path) -> bytes:
    if not path.is_absolute():
        raise BridgeError("evidence path must be absolute")
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}):
        raise BridgeError("evidence must be an owned single-link mode-0600 regular file")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise BridgeError("evidence changed before it was opened")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns,
        ):
            raise BridgeError("evidence changed while it was read")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def instant(value: object, label: str) -> datetime.datetime:
    if not isinstance(value, str):
        raise BridgeError(f"{label} must be an RFC3339 timestamp")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise BridgeError(f"{label} must be an RFC3339 timestamp") from error
    if parsed.tzinfo is None:
        raise BridgeError(f"{label} must include a timezone")
    return parsed.astimezone(datetime.timezone.utc)


def verify_source_revision(report: dict) -> None:
    revision = report["sourceRevision"]
    patch_commit = revision["patchSourceCommit"]
    origin_commit = revision["originBaseCommit"]
    patch_path = revision["patchPath"]
    try:
        subprocess.run(
            ["git", "-C", str(ROOT), "cat-file", "-e", f"{patch_commit}^{{commit}}"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["git", "-C", str(ROOT), "merge-base", "--is-ancestor", patch_commit, "HEAD"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        patch = subprocess.run(
            ["git", "-C", str(ROOT), "show", f"{patch_commit}:{patch_path}"],
            check=True, capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise BridgeError("versioned rollback patch provenance cannot be resolved from Git") from error
    if f"sha256:{hashlib.sha256(patch).hexdigest()}" != revision["patchSetSha256"]:
        raise BridgeError("versioned rollback patch differs from its recorded SHA-256")
    with tempfile.TemporaryDirectory(prefix="cauce-bridge-index-") as directory:
        environment = os.environ.copy()
        environment["GIT_INDEX_FILE"] = os.fspath(pathlib.Path(directory) / "index")
        try:
            subprocess.run(
                ["git", "-C", str(ROOT), "read-tree", f"{origin_commit}^{{tree}}"],
                check=True, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                ["git", "-C", str(ROOT), "apply", "--cached", "--whitespace=nowarn", "-"],
                input=patch, check=True, env=environment,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            resulting_tree = subprocess.run(
                ["git", "-C", str(ROOT), "write-tree"],
                check=True, env=environment, capture_output=True, text=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise BridgeError("versioned rollback patch does not reproduce from its origin tree") from error
    if resulting_tree != revision["resultingBridgeTree"]:
        raise BridgeError("versioned rollback patch produced a different bridge tree")


def validate(
    evidence_path: pathlib.Path,
    *,
    expected_evidence_sha256: str,
    expected_repository_digest: str,
    expected_image_id: str,
    expected_candidate_repository_digest: str | None,
    expected_candidate_image_id: str | None,
    expected_candidate_source_digest: str | None,
    max_age_hours: int,
) -> None:
    if DIGEST.fullmatch(expected_evidence_sha256) is None:
        raise BridgeError("expected evidence SHA-256 is invalid")
    if IMAGE_REF.fullmatch(expected_repository_digest) is None:
        raise BridgeError("expected repository digest is invalid")
    if DIGEST.fullmatch(expected_image_id) is None:
        raise BridgeError("expected image ID is invalid")
    expected_candidate_values = (
        expected_candidate_repository_digest,
        expected_candidate_image_id,
        expected_candidate_source_digest,
    )
    if sum(value is not None for value in expected_candidate_values) not in {0, 3}:
        raise BridgeError("candidate repository digest, image ID and source digest must be expected together")
    if (expected_candidate_repository_digest is not None
            and IMAGE_REF.fullmatch(expected_candidate_repository_digest) is None):
        raise BridgeError("expected candidate repository digest is invalid")
    if expected_candidate_image_id is not None and DIGEST.fullmatch(expected_candidate_image_id) is None:
        raise BridgeError("expected candidate image ID is invalid")
    if expected_candidate_source_digest is not None and DIGEST.fullmatch(expected_candidate_source_digest) is None:
        raise BridgeError("expected candidate source digest is invalid")
    content = private_file(evidence_path)
    observed_sha = f"sha256:{hashlib.sha256(content).hexdigest()}"
    if observed_sha != expected_evidence_sha256:
        raise BridgeError("evidence SHA-256 differs from the authorized rollback record")
    try:
        report = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BridgeError("evidence is not valid UTF-8 JSON") from error
    schema = json.loads((OPS / "schemas" / "rollback-bridge.schema.json").read_text(encoding="utf-8"))
    failures = sorted(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(report),
        key=lambda item: list(item.absolute_path),
    )
    if failures:
        location = ".".join(map(str, failures[0].absolute_path)) or "<root>"
        raise BridgeError(f"evidence schema failed at {location}")

    verify_source_revision(report)

    runtime = report["runtime"]
    if runtime["repositoryDigest"] != expected_repository_digest:
        raise BridgeError("bridge evidence repository digest differs from the rollback target")
    if runtime["imageId"] != expected_image_id:
        raise BridgeError("bridge evidence image ID differs from the registry-recovered target")
    if runtime["sourceDigest"] != report["sourceDigest"]:
        raise BridgeError("bridge runtime and top-level source digests differ")

    candidate = report["candidateRuntime"]
    if (expected_candidate_repository_digest is not None
            and candidate["repositoryDigest"] != expected_candidate_repository_digest):
        raise BridgeError("bridge cycle candidate digest differs from the forward release")
    if expected_candidate_image_id is not None and candidate["imageId"] != expected_candidate_image_id:
        raise BridgeError("bridge cycle candidate image ID differs from the forward release")
    if expected_candidate_source_digest is not None and candidate["sourceDigest"] != expected_candidate_source_digest:
        raise BridgeError("bridge cycle candidate source digest differs from the forward release")

    database = report["database"]
    snapshots = database["snapshots"]
    for field, label in (
        ("migrationLedgerSha256", "migration ledger or verification state"),
        ("reconciliationSha256", "fleet reconciliation state"),
        ("profileContentSha256", "canonical profile content"),
        ("profileRevisionSha256", "profile revision or applied-revision state"),
        ("leasesSha256", "connection leases"),
    ):
        if len({snapshot[field] for snapshot in snapshots}) != 1:
            raise BridgeError(f"bridge lifecycle changed {label}")

    generated = instant(report["generatedAt"], "generatedAt")
    valid_until = instant(report["validUntil"], "validUntil")
    now = datetime.datetime.now(datetime.timezone.utc)
    maximum = datetime.timedelta(hours=max_age_hours)
    if generated > now + datetime.timedelta(minutes=5):
        raise BridgeError("bridge evidence is from the future")
    if valid_until <= generated or valid_until - generated > maximum:
        raise BridgeError("bridge evidence validity window exceeds policy")
    if now > valid_until or now - generated > maximum:
        raise BridgeError("bridge evidence is stale")

    operations_digest = subprocess.run(
        [sys.executable, str(OPS / "scripts" / "container_ops_digest.py")],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if report["operationsDigest"] != operations_digest:
        raise BridgeError("bridge evidence used different rollback and verification operations")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    parser.add_argument("--expected-evidence-sha256", required=True)
    parser.add_argument("--expected-repository-digest", required=True)
    parser.add_argument("--expected-image-id", required=True)
    parser.add_argument("--expected-candidate-repository-digest")
    parser.add_argument("--expected-candidate-image-id")
    parser.add_argument("--expected-candidate-source-digest")
    parser.add_argument("--max-age-hours", type=int, default=168)
    arguments = parser.parse_args(argv)
    if arguments.max_age_hours < 1 or arguments.max_age_hours > 168:
        print("rollback bridge evidence failed: max age must be between 1 and 168 hours", file=sys.stderr)
        return 2
    try:
        validate(
            arguments.evidence,
            expected_evidence_sha256=arguments.expected_evidence_sha256,
            expected_repository_digest=arguments.expected_repository_digest,
            expected_image_id=arguments.expected_image_id,
            expected_candidate_repository_digest=arguments.expected_candidate_repository_digest,
            expected_candidate_image_id=arguments.expected_candidate_image_id,
            expected_candidate_source_digest=arguments.expected_candidate_source_digest,
            max_age_hours=arguments.max_age_hours,
        )
    except (OSError, BridgeError, subprocess.CalledProcessError) as error:
        print(f"rollback bridge evidence failed: {error}", file=sys.stderr)
        return 1
    print("rollback bridge evidence passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
