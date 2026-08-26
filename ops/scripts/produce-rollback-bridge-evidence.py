#!/usr/bin/env python3
"""Produce private, source-bound rollback bridge evidence from an isolated PG16 restore.

The producer never accepts a production connection string.  It reconstructs the versioned bridge,
builds and registry-recovers that exact tree, restores one authorized backup into an ephemeral
Compose project whose only network is internal, and exercises candidate -> bridge -> candidate plus
the shared rollback transaction and compensation engine.  Failures are intentionally reported by phase only:
command output can contain database data and is never echoed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import pwd
import re
import secrets
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
COMPOSE_FILE = OPS / "compose.rollback-bridge.yaml"
SCHEMA_FILE = OPS / "schemas" / "rollback-bridge.schema.json"
BUILD_SCHEMA_FILE = OPS / "schemas" / "build-evidence.schema.json"
BRIDGE_METADATA_FILE = OPS / "rollback-bridge" / "metadata.json"
BRIDGE_BUILD = OPS / "rollback-bridge" / "build.sh"
BRIDGE_TEST = OPS / "rollback-bridge" / "test.sh"

DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
GIT_OBJECT_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
REPOSITORY_RE = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$"
)
IMAGE_RE = re.compile(REPOSITORY_RE.pattern[:-1] + r"@sha256:[a-f0-9]{64}$")
RESTORE_MAX_AGE_HOURS = 30
RESTORE_MAX_FUTURE_SKEW_SECONDS = 300
TARGET_PLATFORM = "linux/amd64"
LINUX_AMD64 = {"os": "linux", "architecture": "amd64"}
TARGET_SCHEMA = "037_console_publish_intent_indexes.sql"
CONNECTION_FENCING_SCHEMA = "031_connection_session_fencing.sql"
TERMINAL_CLAIM_FENCING_SCHEMA = "032_terminal_session_claim_fencing.sql"
BROWSER_OWNER_FENCING_SCHEMA = "033_terminal_browser_owner_fencing.sql"
RELAY_INSTANCE_FENCING_SCHEMA = "034_terminal_relay_instance_fencing.sql"
PROFILE_RUNTIME_ADOPTION_SCHEMA = "035_agent_profile_runtime_adoption.sql"
SHADOW_TARGET_PHASE_SCHEMA = "036_shadow_router_target_phase.sql"
CONSOLE_PUBLISH_INTENT_SCHEMA = "037_console_publish_intent_indexes.sql"
HISTORICAL_FLEET_MIGRATION = "029_reconcile_declared_fleet.sql"
BRIDGE_KIND = "origin-main-plus-schema029-shims-central-only-schema037"
EVIDENCE_SCHEMA_VERSION = 11
SHADOW_PHASE_CONSTRAINT_SHA256 = "3744b38b5e27f0def89f983afce9987b6bfb225a120dbec432fdb426008a262c"
SHADOW_PHASE_FUNCTION_SHA256 = "7c24fde424d76277733cb0403399378cc88942a186fff9754afa3355fc11f54c"
SHADOW_MAPPING_MONOTONIC_FUNCTION_SHA256 = (
    "ce8ca46fd783f4d05d00ce59fad7d08c2ebf26bfd8c47c38b3082b4164dc84fa"
)
SHADOW_MAPPING_RECONCILE_FUNCTION_SHA256 = (
    "12c9f73d21b93bdf6f283b156c35590ccd082183f69833d3b245123166ae7eb5"
)
REQUIRED_UP_MIGRATIONS = (
    "024_agent_role_templates.sql", "026_agent_profile.sql", "027_rol_agent_notify.sql",
    "028_canonical_agent_role.sql", "029_reconcile_declared_fleet.sql",
    "030_dlq_causal_reconciliation.sql", "031_connection_session_fencing.sql",
    "032_terminal_session_claim_fencing.sql", "033_terminal_browser_owner_fencing.sql",
    "034_terminal_relay_instance_fencing.sql", "035_agent_profile_runtime_adoption.sql",
    "036_shadow_router_target_phase.sql",
    "037_console_publish_intent_indexes.sql",
)
REQUIRED_DOWN_MIGRATIONS = (
    "024_agent_role_templates.sql", "026_agent_profile.sql", "028_canonical_agent_role.sql",
    "029_reconcile_declared_fleet.sql", "030_dlq_causal_reconciliation.sql",
    "031_connection_session_fencing.sql", "032_terminal_session_claim_fencing.sql",
    "033_terminal_browser_owner_fencing.sql", "034_terminal_relay_instance_fencing.sql",
    "035_agent_profile_runtime_adoption.sql", "036_shadow_router_target_phase.sql",
    "037_console_publish_intent_indexes.sql",
)
CHILD_MANIFEST_MEDIA_TYPES = (
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
)

EXPECTED_ENABLED_AGENTS = (
    "Isa:salva", "Jhon:hegel", "Miguel:atlas", "Miguel:iza", "Miguel:janus",
    "Miguel:kratos", "Pablo:dedalo", "Pablo:midas", "Pablo:seneca", "Pablo:vulcano",
    "Steven:argos", "Steven:jarvis", "Steven:kant", "Steven:socrates", "Steven:zeus",
)
EXPECTED_ENABLED_MEMBERSHIPS = (
    "Isa:salva:grp.isa:agent", "Jhon:hegel:grp.jhon:agent",
    "Miguel:atlas:grp.miguel:agent", "Miguel:iza:grp.miguel:agent",
    "Miguel:janus:grp.miguel:operator", "Miguel:kratos:grp.miguel:agent",
    "Pablo:dedalo:grp.pablo:agent", "Pablo:midas:grp.pablo:agent",
    "Pablo:seneca:grp.pablo:agent", "Pablo:vulcano:grp.pablo:agent",
    "Steven:argos:grp.steven:agent", "Steven:jarvis:grp.steven:agent_notify",
    "Steven:kant:grp.steven:operator", "Steven:quota-collector:grp.steven:operator",
    "Steven:socrates:grp.steven:agent_notify", "Steven:zeus:grp.steven:agent_notify",
)
EXPECTED_DISABLED_AGENTS = ("Jhon:heraclito", "Jhon:tales", "Miguel:gaia")

DIGEST_CONTRACT = {
    "algorithm": "sha256",
    "encoding": "postgresql-jsonb-canonical-text-utf8",
    "migrationLedger": (
        "schema_migrations(*)|schema_migration_ledger(*)|schema_migration_verifications(*);"
        "all-columns;all-rows;tables-listed-order;rows-primary-key-order"
    ),
    "reconciliation": (
        "fleet_reconciliation_runs(*)|fleet_reconciliation_history(*);"
        "all-columns;all-rows;tables-listed-order;rows-primary-key-order"
    ),
    "profileContent": (
        "agent_profiles(*-revision-applied_revision)|agents(tenant_id,alias,role_brief,"
        "role_template_slug)|agent_role_templates(*)|agent_role_brief_history(*);"
        "all-rows;tables-listed-order;rows-primary-key-order"
    ),
    "profileRevision": (
        "agent_profiles(tenant_id,alias,revision,applied_revision);all-rows;"
        "rows-tenant_id-alias-order"
    ),
    "profileRuntime": (
        "agent_profile_runtime_expectations(*)|agent_profile_runtime_adoptions(*);"
        "all-columns;all-rows;tables-listed-order;rows-primary-key-order"
    ),
    "shadowTargetPhase": (
        "shadow_router_inbox(*)|shadow_router_mappings(*);all-columns;all-rows;"
        "tables-listed-order;rows-direction-source-event-id-order"
    ),
    "leases": (
        "connection_leases(*);capabilities-jsonb;all-columns;all-rows;"
        "rows-tenant_id-alias-order"
    ),
    "authSessions": (
        "gateway_oidc_sessions(*);all-columns-including-updated_at;all-rows;"
        "rows-kind-key_hash-order"
    ),
    "publishJournal": (
        "audit_events(action-like-console.publish.%)|messages(*)|idempotency_keys(*)|"
        "deliveries(*)|delivery_acks(*)|adapter_outbox(*);all-columns;all-rows;"
        "tables-listed-order;audit-rows-id-order;other-rows-primary-key-order"
    ),
    "fullDatabaseState": (
        "public ordinary tables(*)|public sequences(last_value,is_called);all-columns;all-rows;"
        "objects-name-order;rows-jsonb-text-order"
    ),
}


class ProductionError(RuntimeError):
    """A sanitized, operator-actionable fail-closed error."""


def canonical_child_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Return the sole Docker/tool authority used by bridge production.

    Inputs remain command arguments or private files; ambient Docker, Compose,
    Python and shell controls never reach a child process.  Registry credentials
    continue to live in the invoking account's protected local Docker config.
    """
    try:
        account = pwd.getpwuid(os.geteuid())
    except KeyError as error:
        raise ProductionError("invoking account has no trusted identity") from error
    home = pathlib.Path(account.pw_dir)
    try:
        home_metadata = home.lstat()
    except OSError as error:
        raise ProductionError("invoking account has no trusted home") from error
    if (
        not home.is_absolute()
        or not stat.S_ISDIR(home_metadata.st_mode)
        or home.is_symlink()
        or home_metadata.st_uid not in {0, os.geteuid()}
        or stat.S_IMODE(home_metadata.st_mode) & 0o022
    ):
        raise ProductionError("invoking account home is not owned and protected")
    docker_config = home / ".docker"
    if docker_config.exists() or docker_config.is_symlink():
        metadata = docker_config.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or docker_config.is_symlink()
            or metadata.st_uid not in {0, os.geteuid()}
            or stat.S_IMODE(metadata.st_mode) & 0o022
        ):
            raise ProductionError("trusted Docker config directory is unsafe")
    environment = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": os.fspath(home),
        "USER": account.pw_name,
        "LOGNAME": account.pw_name,
        "LC_ALL": "C",
        "PYTHONDONTWRITEBYTECODE": "1",
        "DOCKER_HOST": "unix:///var/run/docker.sock",
        "DOCKER_CONFIG": os.fspath(docker_config),
    }
    if extra:
        environment.update(extra)
    return environment


def sha256_bytes(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def require_digest(value: str, label: str) -> str:
    if DIGEST_RE.fullmatch(value) is None:
        raise ProductionError(f"{label} must be sha256:<64 lowercase hex>")
    return value


def require_image(value: str, label: str) -> str:
    if IMAGE_RE.fullmatch(value) is None:
        raise ProductionError(f"{label} must be a canonical immutable repository digest")
    return value


def require_repository(value: str, label: str) -> str:
    if REPOSITORY_RE.fullmatch(value) is None:
        raise ProductionError(f"{label} must be a canonical registry repository without tag or digest")
    return value


def require_git_object(value: str, label: str) -> str:
    if GIT_OBJECT_RE.fullmatch(value) is None:
        raise ProductionError(f"{label} must be a full Git object ID")
    return value


def _secure_metadata(path: pathlib.Path, label: str) -> os.stat_result:
    if not path.is_absolute():
        raise ProductionError(f"{label} path must be absolute")
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise ProductionError(f"{label} is absent") from error
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}):
        raise ProductionError(f"{label} must be an owned single-link mode-0600 regular file")
    return metadata


def private_file(path: pathlib.Path, label: str, *, maximum: int = 16 * 1024 * 1024) -> bytes:
    metadata = _secure_metadata(path, label)
    if metadata.st_size > maximum:
        raise ProductionError(f"{label} exceeds its maximum accepted size")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ProductionError(f"{label} changed before it was opened")
        content = bytearray()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            content.extend(chunk)
        after = os.fstat(descriptor)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns,
        ):
            raise ProductionError(f"{label} changed while it was read")
        return bytes(content)
    finally:
        os.close(descriptor)


def private_digest(path: pathlib.Path, label: str) -> str:
    metadata = _secure_metadata(path, label)
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    digest = hashlib.sha256()
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ProductionError(f"{label} changed before it was opened")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns,
        ):
            raise ProductionError(f"{label} changed while it was hashed")
    finally:
        os.close(descriptor)
    return f"sha256:{digest.hexdigest()}"


def private_copy(path: pathlib.Path, destination: pathlib.Path, label: str, expected_digest: str) -> None:
    """Copy a stable private input into owned scratch and bind later work to those exact bytes."""
    metadata = _secure_metadata(path, label)
    source_flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
    source = os.open(path, source_flags)
    try:
        target = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    except Exception:
        os.close(source)
        raise
    digest = hashlib.sha256()
    try:
        opened = os.fstat(source)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ProductionError(f"{label} changed before its isolated copy")
        while True:
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            offset = 0
            while offset < len(chunk):
                written = os.write(target, chunk[offset:])
                if written < 1:
                    raise ProductionError(f"{label} isolated copy could not progress")
                offset += written
        os.fsync(target)
        after = os.fstat(source)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns,
        ):
            raise ProductionError(f"{label} changed while its isolated copy was made")
    finally:
        os.close(target)
        os.close(source)
    if f"sha256:{digest.hexdigest()}" != expected_digest:
        destination.unlink(missing_ok=True)
        raise ProductionError(f"{label} isolated copy differs from the authorized SHA-256")


def private_json(path: pathlib.Path, label: str) -> tuple[dict[str, Any], bytes]:
    content = private_file(path, label)
    try:
        value = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProductionError(f"{label} must be valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ProductionError(f"{label} must contain a JSON object")
    return value, content


def validate_schema(value: object, schema_path: pathlib.Path, label: str) -> None:
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProductionError(f"{label} schema is unavailable") from error
    failures = sorted(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value),
        key=lambda failure: list(failure.absolute_path),
    )
    if failures:
        location = ".".join(map(str, failures[0].absolute_path)) or "<root>"
        raise ProductionError(f"{label} schema failed at {location}")


def run_checked(
    arguments: list[str], *, phase: str, environment: dict[str, str] | None = None,
    input_bytes: bytes | None = None, capture: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            arguments, input=input_bytes,
            env=environment if environment is not None else canonical_child_environment(), check=False,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise ProductionError(f"{phase} could not start") from error
    if result.returncode != 0:
        raise ProductionError(f"{phase} failed")
    return result


def git_output(arguments: list[str], phase: str) -> str:
    return run_checked(
        ["git", "-C", os.fspath(ROOT), *arguments], phase=phase, capture=True,
    ).stdout.decode("ascii").strip()


def verify_clean_source(patch_source_commit: str) -> tuple[str, str]:
    head = git_output(["rev-parse", "--verify", "HEAD^{commit}"], "resolve repository HEAD")
    tree = git_output(["rev-parse", "--verify", "HEAD^{tree}"], "resolve repository tree")
    if head != patch_source_commit:
        raise ProductionError("patch source commit must equal the checked-out full HEAD")
    run_checked(
        ["git", "-C", os.fspath(ROOT), "diff", "--quiet", "--no-ext-diff", "--"],
        phase="tracked worktree cleanliness",
    )
    run_checked(
        ["git", "-C", os.fspath(ROOT), "diff", "--cached", "--quiet", "--no-ext-diff", "--"],
        phase="index cleanliness",
    )
    status = run_checked(
        ["git", "-C", os.fspath(ROOT), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        phase="untracked source policy", capture=True,
    ).stdout.decode("utf-8", "strict")
    for entry in filter(None, status.split("\0")):
        if not entry.startswith("?? apps/console/src/features/_grafo/"):
            raise ProductionError("source contains an unapproved untracked path")
    return head, tree


def verify_restore_input(
    backup: pathlib.Path, backup_digest: str, evidence: dict[str, Any], evidence_digest: str,
    *, now: dt.datetime | None = None,
) -> dict[str, str]:
    if evidence.get("schema_version") != 1 or evidence.get("suite") != "cauce-v3-host-backup-restore":
        raise ProductionError("restore evidence is not host-backup full-restore evidence")
    required = {
        "isolated": True, "network": "none", "full_restore": True,
    }
    if any(evidence.get(key) != expected for key, expected in required.items()):
        raise ProductionError("restore evidence did not use an isolated full restore")
    if evidence.get("dump_file") != backup.name:
        raise ProductionError("restore evidence names a different backup file")
    if evidence.get("dump_sha256") != backup_digest.removeprefix("sha256:"):
        raise ProductionError("restore evidence names a different backup digest")
    restore_image_id = evidence.get("database_image_digest")
    if not isinstance(restore_image_id, str):
        raise ProductionError("restore evidence has no PostgreSQL image ID")
    require_digest(restore_image_id, "restore evidence PostgreSQL image ID")
    if not isinstance(evidence.get("core_table_count"), int) or evidence["core_table_count"] < 8:
        raise ProductionError("restore evidence did not verify the complete core table set")
    if not isinstance(evidence.get("applied_migration_count"), int) or evidence["applied_migration_count"] < 1:
        raise ProductionError("restore evidence did not verify applied migrations")
    verified_raw = evidence.get("verified_at_utc")
    if not isinstance(verified_raw, str):
        raise ProductionError("restore evidence has no verification timestamp")
    try:
        verified_at = dt.datetime.strptime(verified_raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise ProductionError("restore evidence verification timestamp is invalid") from error
    observed_now = now or dt.datetime.now(dt.timezone.utc)
    if verified_at > observed_now + dt.timedelta(seconds=RESTORE_MAX_FUTURE_SKEW_SECONDS):
        raise ProductionError("restore evidence verification timestamp exceeds clock-skew policy")
    if observed_now - verified_at > dt.timedelta(hours=RESTORE_MAX_AGE_HOURS):
        raise ProductionError("restore evidence is older than rollback production policy")
    require_digest(evidence_digest, "restore evidence digest")
    return {
        "postgresImageId": restore_image_id,
        "verifiedAt": verified_at.isoformat().replace("+00:00", "Z"),
    }


def verify_candidate_evidence(
    evidence: dict[str, Any], *, expected_image: str, expected_commit: str,
) -> dict[str, Any]:
    validate_schema(evidence, BUILD_SCHEMA_FILE, "candidate build evidence")
    revision = evidence["sourceRevision"]
    runtime = evidence["runtime"]
    if revision["commit"] != expected_commit:
        raise ProductionError("candidate build evidence commit differs from the authorized candidate")
    if runtime["repositoryDigest"] != expected_image:
        raise ProductionError("candidate build evidence repository digest differs from the authorized image")
    if runtime["imageId"] != evidence["imageDigest"] or runtime["sourceDigest"] != evidence["sourceDigest"]:
        raise ProductionError("candidate build evidence has inconsistent runtime identities")
    if runtime["manifestDigest"] != expected_image.rsplit("@", 1)[1]:
        raise ProductionError("candidate build evidence manifest differs from its authorized RepoDigest")
    if runtime["mediaType"] not in CHILD_MANIFEST_MEDIA_TYPES or runtime["platform"] != LINUX_AMD64:
        raise ProductionError("candidate build evidence is not a linux/amd64 child manifest")
    if evidence["schemaCompatibility"]["compatibleThrough"] != TARGET_SCHEMA:
        raise ProductionError(f"candidate image is not compatible through {TARGET_SCHEMA}")
    base_images = evidence["baseImages"]
    node_base = base_images["node"]["repositoryDigest"]
    python_base = base_images["python"]["repositoryDigest"]
    return {
        "imageId": runtime["imageId"], "sourceDigest": runtime["sourceDigest"],
        "sourceCommit": revision["commit"], "sourceTree": revision["tree"],
        "manifestDigest": runtime["manifestDigest"], "mediaType": runtime["mediaType"],
        "platform": runtime["platform"], "nodeBase": node_base, "pythonBase": python_base,
        "expectedLabels": {
            "io.cauce.schema.compatible-through": TARGET_SCHEMA,
            "io.cauce.source.digest": runtime["sourceDigest"],
            "io.cauce.base.node.repository-digest": node_base,
            "io.cauce.base.python.repository-digest": python_base,
            "io.cauce.target-platform": TARGET_PLATFORM,
            "org.opencontainers.image.revision": revision["commit"],
            "org.opencontainers.image.base.name": node_base,
        },
    }


def verify_bridge_migration_payload(root: pathlib.Path, metadata: dict[str, Any]) -> None:
    schema_contract = metadata.get("schemaContract")
    if not isinstance(schema_contract, dict):
        raise ProductionError("rollback bridge migration contract is unavailable")
    for key, relative, required in (
        ("candidateMigrationInputs", pathlib.Path("packages/store/migrations"), REQUIRED_UP_MIGRATIONS),
        (
            "candidateDownMigrationInputs", pathlib.Path("packages/store/migrations/down"),
            REQUIRED_DOWN_MIGRATIONS,
        ),
    ):
        values = schema_contract.get(key)
        if not isinstance(values, dict) or set(values) != set(required):
            raise ProductionError(f"rollback bridge {key} is incomplete or ambiguous")
        for name in required:
            expected = values.get(name)
            if not isinstance(expected, str) or DIGEST_RE.fullmatch(expected) is None:
                raise ProductionError(f"rollback bridge {key} contains an invalid digest")
            path = root / relative / name
            try:
                details = path.lstat()
                content = path.read_bytes()
            except OSError as error:
                raise ProductionError(f"rollback bridge {key} payload is unavailable") from error
            if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
                raise ProductionError(f"rollback bridge {key} payload is not a regular file")
            if sha256_bytes(content) != expected:
                raise ProductionError(f"rollback bridge {key} payload differs from metadata")


def read_bridge_metadata() -> dict[str, Any]:
    try:
        value = json.loads(BRIDGE_METADATA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProductionError("rollback bridge metadata is unavailable") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 7:
        raise ProductionError("rollback bridge metadata is invalid")
    publication = value.get("imagePublication")
    schema_contract = value.get("schemaContract")
    if (not isinstance(publication, dict)
            or publication.get("lifecycleEvidenceSchemaVersion") != EVIDENCE_SCHEMA_VERSION
            or not isinstance(schema_contract, dict)
            or schema_contract.get("schemaLatest") != TARGET_SCHEMA):
        raise ProductionError(f"rollback bridge metadata is not accredited through {TARGET_SCHEMA}")
    verify_bridge_migration_payload(ROOT, value)
    return value


def safe_extract(archive: pathlib.Path, destination: pathlib.Path) -> None:
    destination_resolved = destination.resolve()
    try:
        with tarfile.open(archive, "r:") as bundle:
            for member in bundle.getmembers():
                if member.isdev() or member.issym() or member.islnk():
                    raise ProductionError("rollback bridge archive contains a non-regular link or device")
                target = (destination / member.name).resolve()
                if target != destination_resolved and destination_resolved not in target.parents:
                    raise ProductionError("rollback bridge archive escapes its extraction directory")
            bundle.extractall(destination, filter="data")
    except (OSError, tarfile.TarError) as error:
        raise ProductionError("rollback bridge archive extraction failed") from error


def image_inspect(image: str, phase: str) -> dict[str, Any]:
    result = run_checked(["docker", "image", "inspect", image], phase=phase, capture=True)
    try:
        values = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProductionError(f"{phase} returned invalid metadata") from error
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise ProductionError(f"{phase} returned an ambiguous image")
    return values[0]


def pull_mode() -> bool:
    value = os.environ.get("CAUCE_BRIDGE_PULL", "1")
    if value not in {"0", "1"}:
        raise ProductionError("CAUCE_BRIDGE_PULL must be 0 or 1")
    return value == "1"


def normalized_repository(value: str) -> str:
    first = value.split("/", 1)[0]
    if "." not in first and ":" not in first and first != "localhost":
        value = f"docker.io/{value}" if "/" in value else f"docker.io/library/{value}"
    if value.startswith("index.docker.io/"):
        value = "docker.io/" + value.removeprefix("index.docker.io/")
    return value


def labels_from_image(metadata: dict[str, Any], phase: str) -> dict[str, str]:
    config = metadata.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if not isinstance(labels, dict) or any(
        not isinstance(key, str) or not isinstance(value, str) for key, value in labels.items()
    ):
        raise ProductionError(f"{phase} returned invalid image labels")
    return labels


def verify_recovered_image(
    image: str, expected_id: str | None, phase: str, *, pull_enabled: bool,
    expected_labels: dict[str, str] | None = None,
) -> dict[str, Any]:
    require_image(image, f"{phase} repository digest")
    if pull_enabled:
        run_checked(["docker", "pull", "--platform", TARGET_PLATFORM, image], phase=f"{phase} pull")
    metadata = image_inspect(image, f"{phase} inspect")
    identifier = metadata.get("Id")
    if not isinstance(identifier, str):
        raise ProductionError(f"{phase} inspect returned no image ID")
    require_digest(identifier, f"{phase} image ID")
    if expected_id is not None and identifier != expected_id:
        raise ProductionError(f"{phase} registry recovery returned another image ID")
    repository, manifest_digest = image.rsplit("@", 1)
    descriptor = metadata.get("Descriptor")
    if not isinstance(descriptor, dict) or descriptor.get("digest") != manifest_digest:
        raise ProductionError(f"{phase} descriptor differs from the authorized child manifest")
    media_type = descriptor.get("mediaType")
    if media_type not in CHILD_MANIFEST_MEDIA_TYPES:
        raise ProductionError(f"{phase} is not a supported child manifest")
    platform = {"os": metadata.get("Os"), "architecture": metadata.get("Architecture")}
    if platform != LINUX_AMD64:
        raise ProductionError(f"{phase} is not linux/amd64")
    repo_digests = metadata.get("RepoDigests")
    if not isinstance(repo_digests, list) or not any(
        isinstance(value, str) and "@" in value
        and normalized_repository(value.rsplit("@", 1)[0]) == normalized_repository(repository)
        and value.rsplit("@", 1)[1] == manifest_digest
        for value in repo_digests
    ):
        raise ProductionError(f"{phase} inspect did not retain the authorized repository digest")
    identity: dict[str, Any] = {
        "repositoryDigest": image,
        "imageId": identifier,
        "manifestDigest": manifest_digest,
        "mediaType": media_type,
        "platform": platform,
    }
    if expected_labels is not None:
        observed_labels = labels_from_image(metadata, phase)
        if any(observed_labels.get(key) != value for key, value in expected_labels.items()):
            raise ProductionError(f"{phase} provenance labels differ from their expected values")
        identity["labels"] = dict(expected_labels)
    return identity


def verify_local_runtime(
    image: str, phase: str, *, expected_labels: dict[str, str], expected_id: str | None = None,
) -> str:
    metadata = image_inspect(image, f"{phase} inspect")
    identifier = metadata.get("Id")
    if not isinstance(identifier, str):
        raise ProductionError(f"{phase} inspect returned no image ID")
    require_digest(identifier, f"{phase} image ID")
    if expected_id is not None and identifier != expected_id:
        raise ProductionError(f"{phase} image ID differs from the tested image")
    if {"os": metadata.get("Os"), "architecture": metadata.get("Architecture")} != LINUX_AMD64:
        raise ProductionError(f"{phase} is not linux/amd64")
    observed_labels = labels_from_image(metadata, phase)
    if any(observed_labels.get(key) != value for key, value in expected_labels.items()):
        raise ProductionError(f"{phase} provenance labels differ from their expected values")
    return identifier


def runtime_stage_identity(identity: dict[str, Any]) -> dict[str, Any]:
    return {
        key: identity[key]
        for key in ("repositoryDigest", "imageId", "manifestDigest", "mediaType", "platform", "labels")
    }


def image_stage_identity(identity: dict[str, Any]) -> dict[str, Any]:
    return {
        key: identity[key]
        for key in ("repositoryDigest", "imageId", "manifestDigest", "mediaType", "platform")
    }


def bridge_build_command(
    *, context: pathlib.Path, tag: str, node_base: str, python_base: str,
    source_digest: str, bridge_tree: str, patch_digest: str, patch_commit: str,
    pull_enabled: bool,
) -> list[str]:
    command = ["docker", "build"]
    if pull_enabled:
        command.append("--pull")
    command.extend([
        "--platform", TARGET_PLATFORM, "--target", "runtime",
        "--build-arg", f"CAUCE_NODE_BASE={node_base}",
        "--build-arg", f"CAUCE_PYTHON_BASE={python_base}",
        "--build-arg", f"CAUCE_SCHEMA_COMPATIBLE_THROUGH={TARGET_SCHEMA}",
        "--build-arg", f"CAUCE_SOURCE_DIGEST={source_digest}",
        "--build-arg", f"CAUCE_BRIDGE_TREE={bridge_tree}",
        "--build-arg", f"CAUCE_BRIDGE_PATCH_SHA256={patch_digest}",
        "--build-arg", f"CAUCE_TARGET_PLATFORM={TARGET_PLATFORM}",
        "--label", f"io.cauce.rollback-bridge.tree={bridge_tree}",
        "--label", f"io.cauce.rollback-bridge.patch-sha256={patch_digest}",
        "--label", f"io.cauce.rollback-bridge.patch-source-commit={patch_commit}",
        "--label", "io.cauce.rollback-bridge.read-only=server-v2",
        "--label", f"io.cauce.source.runtime={source_digest}",
        "-t", tag, "-f", os.fspath(context / "deploy" / "Dockerfile"), os.fspath(context),
    ])
    return command


def one_repository_digest(tag: str, repository: str) -> str:
    metadata = image_inspect(tag, "bridge pushed image inspect")
    values = metadata.get("RepoDigests")
    matches = sorted({
        value.rsplit("@", 1)[1]
        for value in values or []
        if isinstance(value, str) and "@" in value
        and normalized_repository(value.rsplit("@", 1)[0]) == normalized_repository(repository)
        and DIGEST_RE.fullmatch(value.rsplit("@", 1)[1])
    })
    if len(matches) != 1:
        raise ProductionError("bridge push did not yield one exact repository digest")
    return f"{repository}@{matches[0]}"


def validate_compose_source() -> None:
    try:
        model = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ProductionError("rollback bridge Compose topology is unavailable") from error
    if not isinstance(model, dict) or set((model.get("services") or {}).keys()) != {"postgres", "candidate", "bridge"}:
        raise ProductionError("rollback bridge Compose must contain exactly postgres, candidate and bridge")
    networks = model.get("networks")
    if not isinstance(networks, dict) or set(networks) != {"rollback_bridge"} \
            or networks["rollback_bridge"].get("internal") is not True:
        raise ProductionError("rollback bridge Compose network must be internal-only")
    forbidden_service_keys = {
        "devices", "device_cgroup_rules", "dns", "dns_search", "env_file", "extra_hosts",
        "ipc", "links", "network_mode", "pid", "ports", "privileged", "uts",
    }
    for name, service in model["services"].items():
        if not isinstance(service, dict) or any(key in service for key in forbidden_service_keys):
            raise ProductionError(f"rollback bridge Compose service {name} exposes a forbidden network surface")
        declared = service.get("networks")
        if declared is not None and declared != ["rollback_bridge"]:
            raise ProductionError(f"rollback bridge Compose service {name} uses another network")
    postgres_mounts = model["services"]["postgres"].get("volumes") or []
    backup_mounts = [mount for mount in postgres_mounts if isinstance(mount, dict)
                     and mount.get("target") == "/backup/source.dump"]
    if len(backup_mounts) != 1 or backup_mounts[0].get("read_only") is not True:
        raise ProductionError("rollback bridge backup mount must be exactly read-only")
    if set(model.get("secrets") or {}) != {"postgres_password", "database_url"}:
        raise ProductionError("rollback bridge Compose must use only its two generated secrets")
    if set(model.get("volumes") or {}) != {"rollback_bridge_pgdata"}:
        raise ProductionError("rollback bridge Compose has an unexpected persistent volume")
    postgres = model["services"]["postgres"]
    if set(postgres.get("environment") or {}) != {"POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD_FILE"}:
        raise ProductionError("rollback bridge PostgreSQL environment is not exact")
    for name in ("candidate", "bridge"):
        runtime = model["services"][name]
        if runtime.get("read_only") is not True or runtime.get("user") != "0:0":
            raise ProductionError(f"rollback bridge {name} runtime confinement is incomplete")
        if runtime.get("cap_drop") != ["ALL"] or runtime.get("cap_add") != ["DAC_OVERRIDE"]:
            raise ProductionError(f"rollback bridge {name} capabilities are not exact")
        if runtime.get("environment") != {
            "DATABASE_URL_FILE": "/run/secrets/database_url", "NODE_ENV": "rollback-bridge-test",
        }:
            raise ProductionError(f"rollback bridge {name} environment is not exact")
        if runtime.get("secrets") != ["database_url"]:
            raise ProductionError(f"rollback bridge {name} secret surface is not exact")
        probe_mounts = runtime.get("volumes") or []
        if (len(probe_mounts) != 1 or probe_mounts[0].get("target") != "/rollback-probes"
                or probe_mounts[0].get("read_only") is not True):
            raise ProductionError(f"rollback bridge {name} probe mount is not exact")


def validate_resolved_compose(model: dict[str, Any], candidate: str, bridge: str, postgres: str) -> None:
    services = model.get("services")
    if not isinstance(services, dict) or set(services) != {"postgres", "candidate", "bridge"}:
        raise ProductionError("resolved rollback bridge Compose has an unexpected service")
    expected = {"postgres": postgres, "candidate": candidate, "bridge": bridge}
    for name, image in expected.items():
        service = services.get(name)
        if not isinstance(service, dict) or service.get("image") != image:
            raise ProductionError("resolved rollback bridge Compose changed an immutable image")
        if service.get("ports"):
            raise ProductionError("resolved rollback bridge Compose publishes a port")
    networks = model.get("networks")
    if not isinstance(networks, dict) or len(networks) != 1:
        raise ProductionError("resolved rollback bridge Compose has an unexpected network")
    only = next(iter(networks.values()))
    if not isinstance(only, dict) or only.get("internal") is not True or only.get("external") is True:
        raise ProductionError("resolved rollback bridge Compose network is not internal")


def git_tree_for_directory(directory: pathlib.Path) -> str:
    """Hash an extracted build context as a Git tree using an isolated index."""
    git_directory = git_output(["rev-parse", "--absolute-git-dir"], "resolve Git object directory")
    with tempfile.TemporaryDirectory(prefix="cauce-bridge-tree-index-") as temporary:
        environment = canonical_child_environment({
            "GIT_INDEX_FILE": os.fspath(pathlib.Path(temporary) / "index"),
        })
        command = ["git", f"--git-dir={git_directory}", f"--work-tree={directory}"]
        run_checked([*command, "read-tree", "--empty"], phase="initialize bridge context tree", environment=environment)
        run_checked([*command, "add", "--all", "--force", "--", "."], phase="hash bridge build context", environment=environment)
        tree = run_checked(
            [*command, "write-tree"], phase="write bridge build context tree", environment=environment, capture=True,
        ).stdout.decode("ascii").strip()
    return require_git_object(tree, "extracted rollback bridge tree")


def atomic_publish(output: pathlib.Path, payload: bytes) -> str:
    """Publish evidence plus SHA sidecar; interrupted pairs remain validator-invalid."""
    if not output.is_absolute():
        raise ProductionError("output path must be absolute")
    parent = output.parent
    try:
        parent_metadata = parent.lstat()
    except FileNotFoundError as error:
        raise ProductionError("output parent does not exist") from error
    if (not stat.S_ISDIR(parent_metadata.st_mode) or stat.S_ISLNK(parent_metadata.st_mode)
            or parent_metadata.st_uid not in {0, os.geteuid()}
            or stat.S_IMODE(parent_metadata.st_mode) & 0o022):
        raise ProductionError("output parent must be an owned non-writable-by-others directory")
    sidecar = pathlib.Path(os.fspath(output) + ".sha256")
    if output.exists() or output.is_symlink() or sidecar.exists() or sidecar.is_symlink():
        raise ProductionError("refusing to overwrite evidence or its SHA sidecar")
    digest = sha256_bytes(payload)
    nonce = f"{os.getpid()}.{secrets.token_hex(8)}"
    temporary_evidence = parent / f".{output.name}.{nonce}.partial"
    temporary_sidecar = parent / f".{output.name}.sha256.{nonce}.partial"
    published_evidence = False
    published_sidecar = False
    try:
        for path, content in ((temporary_evidence, payload), (temporary_sidecar, f"{digest}\n".encode("ascii"))):
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
            try:
                offset = 0
                while offset < len(content):
                    offset += os.write(descriptor, content[offset:])
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        os.link(temporary_evidence, output, follow_symlinks=False)
        published_evidence = True
        os.link(temporary_sidecar, sidecar, follow_symlinks=False)
        published_sidecar = True
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
            temporary_evidence.unlink()
            temporary_sidecar.unlink()
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        if published_sidecar:
            sidecar.unlink(missing_ok=True)
        if published_evidence:
            output.unlink(missing_ok=True)
        raise
    finally:
        temporary_evidence.unlink(missing_ok=True)
        temporary_sidecar.unlink(missing_ok=True)
    return digest


SNAPSHOT_SQL = r"""
BEGIN;
CREATE TEMP TABLE rollback_bridge_full_state(
  object_name text PRIMARY KEY,
  object_kind text NOT NULL,
  row_count bigint NOT NULL,
  content jsonb NOT NULL
) ON COMMIT DROP;
DO $rollback_bridge_snapshot$
DECLARE
  item record;
  item_content jsonb;
  item_count bigint;
BEGIN
  FOR item IN
    SELECT n.nspname schema_name,c.relname object_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb),count(*) FROM %I.%I t',
      item.schema_name,item.object_name
    ) INTO item_content,item_count;
    INSERT INTO rollback_bridge_full_state VALUES(item.object_name,'table',item_count,item_content);
  END LOOP;
  FOR item IN
    SELECT n.nspname schema_name,c.relname object_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='S'
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT jsonb_build_object(''last_value'',last_value,''is_called'',is_called) FROM %I.%I',
      item.schema_name,item.object_name
    ) INTO item_content;
    INSERT INTO rollback_bridge_full_state VALUES(item.object_name,'sequence',1,item_content);
  END LOOP;
END
$rollback_bridge_snapshot$;
WITH
  full_database_state AS (
    SELECT coalesce(jsonb_object_agg(object_name,jsonb_build_object(
      'kind',object_kind,'rowCount',row_count,'content',content
    ) ORDER BY object_name),'{}'::jsonb) value
      FROM rollback_bridge_full_state
  ),
  migrations AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb) value,count(*)::int count
      FROM schema_migrations t
  ),
  ledger AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb) value,count(*)::int count
      FROM schema_migration_ledger t
  ),
  verifications AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version,bundled_source_sha256,observed_schema_sha256),'[]'::jsonb) value,
           count(*)::int count FROM schema_migration_verifications t
  ),
  reconciliation_runs AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM fleet_reconciliation_runs t
  ),
  reconciliation_history AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY run_id,entity,tenant_id,alias,room_id),'[]'::jsonb) value,
           count(*)::int count FROM fleet_reconciliation_history t
  ),
  profiles AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t)-'revision'-'applied_revision' ORDER BY tenant_id,alias),'[]'::jsonb) value,
           count(*)::int count FROM agent_profiles t
  ),
  profile_revisions AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id,alias),'[]'::jsonb) value,count(*)::int count
      FROM (SELECT tenant_id,alias,revision,applied_revision FROM agent_profiles) t
  ),
  agent_roles AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id,alias),'[]'::jsonb) value,count(*)::int count
      FROM (SELECT tenant_id,alias,role_brief,role_template_slug FROM agents) t
  ),
  role_templates AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY slug),'[]'::jsonb) value,count(*)::int count
      FROM agent_role_templates t
  ),
  role_history AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM agent_role_brief_history t
  ),
  leases AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id,alias),'[]'::jsonb) value,count(*)::int count
      FROM connection_leases t
  ),
  auth_sessions AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY kind,key_hash),'[]'::jsonb) value,count(*)::int count
      FROM gateway_oidc_sessions t
  ),
  messages_journal AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM messages t
  ),
  idempotency_journal AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id,actor_alias,idempotency_key),'[]'::jsonb) value,
           count(*)::int count FROM idempotency_keys t
  ),
  deliveries_journal AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM deliveries t
  ),
  delivery_acks_journal AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM delivery_acks t
  ),
  adapter_outbox_journal AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM adapter_outbox t
  ),
  console_publish_audit_journal AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) value,count(*)::int count
      FROM audit_events t WHERE action LIKE 'console.publish.%'
  ),
  profile_runtime_expectations AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id,alias),'[]'::jsonb) value,count(*)::int count
      FROM agent_profile_runtime_expectations t
  ),
  profile_runtime_adoptions AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id,alias,revision,generation),'[]'::jsonb) value,
           count(*)::int count FROM agent_profile_runtime_adoptions t
  ),
  shadow_inbox AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY direction,source_event_id),'[]'::jsonb) value,
           count(*)::int count FROM shadow_router_inbox t
  ),
  shadow_mappings AS (
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY direction,source_event_id),'[]'::jsonb) value,
           count(*)::int count FROM shadow_router_mappings t
  )
SELECT jsonb_build_object(
  'migrationLedgerSha256','sha256:'||encode(digest(convert_to(jsonb_build_object(
    'schema_migrations',migrations.value,'schema_migration_ledger',ledger.value,
    'schema_migration_verifications',verifications.value)::text,'UTF8'),'sha256'),'hex'),
  'reconciliationSha256','sha256:'||encode(digest(convert_to(jsonb_build_object(
    'fleet_reconciliation_runs',reconciliation_runs.value,
    'fleet_reconciliation_history',reconciliation_history.value)::text,'UTF8'),'sha256'),'hex'),
  'profileContentSha256','sha256:'||encode(digest(convert_to(jsonb_build_object(
    'agent_profiles',profiles.value,'agents',agent_roles.value,
    'agent_role_templates',role_templates.value,'agent_role_brief_history',role_history.value
  )::text,'UTF8'),'sha256'),'hex'),
  'profileRevisionSha256','sha256:'||encode(digest(convert_to(profile_revisions.value::text,'UTF8'),'sha256'),'hex'),
  'profileRuntimeSha256','sha256:'||encode(digest(convert_to(jsonb_build_object(
    'agent_profile_runtime_expectations',profile_runtime_expectations.value,
    'agent_profile_runtime_adoptions',profile_runtime_adoptions.value
  )::text,'UTF8'),'sha256'),'hex'),
  'shadowTargetPhaseSha256','sha256:'||encode(digest(convert_to(jsonb_build_object(
    'shadow_router_inbox',shadow_inbox.value,
    'shadow_router_mappings',shadow_mappings.value
  )::text,'UTF8'),'sha256'),'hex'),
  'leasesSha256','sha256:'||encode(digest(convert_to(leases.value::text,'UTF8'),'sha256'),'hex'),
  'authSessionSha256','sha256:'||encode(digest(convert_to(auth_sessions.value::text,'UTF8'),'sha256'),'hex'),
  'publishJournalSha256','sha256:'||encode(digest(convert_to(jsonb_build_object(
    'console_publish_audit_events',console_publish_audit_journal.value,
    'messages',messages_journal.value,'idempotency_keys',idempotency_journal.value,
    'deliveries',deliveries_journal.value,'delivery_acks',delivery_acks_journal.value,
    'adapter_outbox',adapter_outbox_journal.value
  )::text,'UTF8'),'sha256'),'hex'),
  'fullDatabaseStateSha256','sha256:'||encode(digest(convert_to(
    full_database_state.value::text,'UTF8'),'sha256'),'hex'),
  'rowCounts',jsonb_build_object(
    'schemaMigrations',migrations.count,'migrationLedger',ledger.count,
    'migrationVerifications',verifications.count,'reconciliationRuns',reconciliation_runs.count,
    'reconciliationHistory',reconciliation_history.count,'profiles',profiles.count,
    'agentRoles',agent_roles.count,'roleTemplates',role_templates.count,
    'roleHistory',role_history.count,'leases',leases.count,
    'gatewayOidcSessions',auth_sessions.count,
    'consolePublishAuditEvents',console_publish_audit_journal.count,
    'messages',messages_journal.count,'idempotencyKeys',idempotency_journal.count,
    'deliveries',deliveries_journal.count,'deliveryAcks',delivery_acks_journal.count,
    'adapterOutbox',adapter_outbox_journal.count,
    'profileRuntimeExpectations',profile_runtime_expectations.count,
    'profileRuntimeAdoptions',profile_runtime_adoptions.count,
    'shadowRouterInbox',shadow_inbox.count,
    'shadowRouterMappings',shadow_mappings.count)
)::text
FROM full_database_state,migrations,ledger,verifications,reconciliation_runs,reconciliation_history,profiles,
     profile_revisions,agent_roles,role_templates,role_history,leases,
     auth_sessions,
     console_publish_audit_journal,
     messages_journal,idempotency_journal,deliveries_journal,delivery_acks_journal,
     adapter_outbox_journal,
     profile_runtime_expectations,profile_runtime_adoptions,shadow_inbox,shadow_mappings;
COMMIT;
"""

FLEET_SQL = r"""
SELECT jsonb_build_object(
  'enabledAgents',coalesce((SELECT jsonb_agg(tenant_id||':'||alias ORDER BY tenant_id,alias)
    FROM agents WHERE enabled),'[]'::jsonb),
  'enabledMemberships',coalesce((SELECT jsonb_agg(tenant_id||':'||alias||':'||room_id||':'||role
    ORDER BY tenant_id,alias,room_id) FROM memberships WHERE enabled),'[]'::jsonb),
  'disabledHistoricalAgents',coalesce((SELECT jsonb_agg(tenant_id||':'||alias ORDER BY tenant_id,alias)
    FROM agents WHERE NOT enabled),'[]'::jsonb),
  'systemPrincipalAgentRowCount',(SELECT count(*) FROM agents WHERE alias IN ('gate-probe','quota-collector')),
  'gateProbeMembershipCount',(SELECT count(*) FROM memberships WHERE alias='gate-probe'),
  'quotaCollectorEnabledMembershipCount',(SELECT count(*) FROM memberships
    WHERE tenant_id='Steven' AND alias='quota-collector' AND enabled),
  'agentNotifyRole',(SELECT jsonb_build_object('allowRoute',allow_route,'allowRead',allow_read,
    'allowControl',allow_control,'allowNotify',allow_notify) FROM role_policies WHERE role='agent_notify'),
  'activeReconciliationRunCount',(SELECT count(*) FROM fleet_reconciliation_runs WHERE active),
  'activeReconciliationMigration',(SELECT migration_version FROM fleet_reconciliation_runs WHERE active)
)::text;
"""

ROUNDTRIP_SQL = r"""
BEGIN;
WITH published AS (
  INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
  VALUES(gen_random_uuid(),'rollback-bridge-model-free','Steven','grp.steven','kant',
         '{"type":"agent.message","content":"isolated rollback bridge probe"}'::jsonb,'interactive',0)
  RETURNING id
), claimed AS (
  INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,claimed_at,
                         claim_expires_at,consumer_instance_id,consumer_epoch,claim_token,ack_deadline_at)
  SELECT id,'Steven','socrates','leased',1,now(),now()+interval '1 minute',
         'rollback-bridge',1,gen_random_uuid(),now()+interval '1 minute' FROM published
  RETURNING id,claim_token
), acked AS (
  INSERT INTO delivery_acks(id,delivery_id,status,instance_id,epoch,applied,payload,claim_token,attempt,event_id)
  SELECT -9223372036854775808,id,'done','rollback-bridge',1,true,'{}'::jsonb,claim_token,1,gen_random_uuid()
    FROM claimed
  RETURNING delivery_id
)
UPDATE deliveries SET status='done',last_ack_rank=3,terminal_at=now(),updated_at=now()
 WHERE id=(SELECT delivery_id FROM acked);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM deliveries WHERE status='done' AND consumer_instance_id='rollback-bridge')
  THEN RAISE EXCEPTION 'model-free roundtrip did not reach done'; END IF;
END $$;
ROLLBACK;
"""

TERMINAL_CLAIM_CAS_SQL = r"""
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $$
DECLARE
  probe_id uuid := gen_random_uuid();
  claim_a bytea := digest('cauce-rollback-bridge-terminal-claim-a','sha256');
  claim_b bytea := digest('cauce-rollback-bridge-terminal-claim-b','sha256');
  affected integer;
  observed_epoch bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE trace_id='rollback-bridge-terminal-claim-cas-probe'
  ) THEN
    RAISE EXCEPTION 'terminal claim probe identity is not isolated';
  END IF;

  INSERT INTO terminal_sessions(
    id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
    mode,ticket_sha256,reason,trace_id,expires_at,consumed_at
  ) VALUES (
    probe_id,'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev',
    'shell',digest('rollback-bridge-terminal-ticket','sha256'),'schema-032-cas-probe',
    'rollback-bridge-terminal-claim-cas-probe',clock_timestamp()+interval '5 minutes',
    clock_timestamp()
  );

  UPDATE terminal_sessions
     SET relay_claim_sha256=claim_a,relay_claim_epoch=1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes'
   WHERE id=probe_id AND closed_at IS NULL AND consumed_at IS NOT NULL
     AND relay_claim_sha256 IS NULL AND relay_claim_epoch=0
     AND relay_claimed_at IS NULL AND relay_claim_expires_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'initial terminal claim CAS failed'; END IF;

  UPDATE terminal_sessions
     SET relay_claim_sha256=claim_b,relay_claim_epoch=relay_claim_epoch+1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes'
   WHERE id=probe_id AND closed_at IS NULL
     AND relay_claim_expires_at<=clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'live terminal claim admitted a competing owner'; END IF;

  UPDATE terminal_sessions
     SET relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes'
   WHERE id=probe_id AND closed_at IS NULL
     AND relay_claim_sha256=claim_a AND relay_claim_epoch=1
     AND relay_claim_expires_at>clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'exact live terminal claim renewal failed'; END IF;

  UPDATE terminal_sessions
     SET relay_claimed_at=clock_timestamp()-interval '2 minutes',
         relay_claim_expires_at=clock_timestamp()-interval '1 minute'
   WHERE id=probe_id AND relay_claim_sha256=claim_a AND relay_claim_epoch=1;

  UPDATE terminal_sessions
     SET relay_claim_sha256=claim_b,relay_claim_epoch=relay_claim_epoch+1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes'
   WHERE id=probe_id AND closed_at IS NULL
     AND relay_claim_expires_at<=clock_timestamp()
  RETURNING relay_claim_epoch INTO observed_epoch;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 OR observed_epoch <> 2 THEN
    RAISE EXCEPTION 'expired terminal claim takeover did not rotate one epoch';
  END IF;

  UPDATE terminal_sessions SET closed_at=clock_timestamp(),close_reason='stale-close'
   WHERE id=probe_id AND closed_at IS NULL
     AND relay_claim_sha256=claim_a AND relay_claim_epoch=1;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'stale terminal close crossed the rotated fence'; END IF;

  UPDATE terminal_sessions SET closed_at=clock_timestamp(),close_reason='exact-close'
   WHERE id=probe_id AND closed_at IS NULL
     AND relay_claim_sha256=claim_b AND relay_claim_epoch=2;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'exact terminal close failed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE id=probe_id AND close_reason='exact-close'
       AND relay_claim_sha256=claim_b AND relay_claim_epoch=2
  ) THEN
    RAISE EXCEPTION 'terminal close did not preserve its durable fence';
  END IF;
END
$$;
ROLLBACK;
SELECT count(*) FROM terminal_sessions
 WHERE trace_id='rollback-bridge-terminal-claim-cas-probe';
"""

BROWSER_OWNER_CAS_SQL = r"""
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $$
DECLARE
  probe_id uuid := gen_random_uuid();
  stable_request_id uuid := gen_random_uuid();
  request_digest bytea := digest('cauce-rollback-bridge-browser-request','sha256');
  other_request_digest bytea := digest('cauce-rollback-bridge-browser-request-other','sha256');
  owner_a bytea := digest('cauce-rollback-bridge-browser-owner-a','sha256');
  owner_b bytea := digest('cauce-rollback-bridge-browser-owner-b','sha256');
  affected integer;
  observed_generation bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE trace_id IN (
       'rollback-bridge-browser-owner-cas-probe',
       'rollback-bridge-browser-owner-unique-probe'
     )
  ) THEN
    RAISE EXCEPTION 'browser owner probe identity is not isolated';
  END IF;

  INSERT INTO terminal_sessions(
    id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
    operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
    mode,ticket_sha256,reason,trace_id,expires_at,consumed_at
  ) VALUES (
    probe_id,stable_request_id,request_digest,owner_a,1,
    'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev',
    'shell',digest('rollback-bridge-browser-ticket','sha256'),'schema-033-cas-probe',
    'rollback-bridge-browser-owner-cas-probe',clock_timestamp()+interval '5 minutes',
    clock_timestamp()
  );

  PERFORM id FROM terminal_sessions
   WHERE request_id=stable_request_id AND request_sha256=request_digest
     AND browser_owner_sha256=owner_a AND browser_owner_generation=1
   FOR UPDATE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'exact browser POST recovery failed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE id=probe_id AND browser_owner_sha256=owner_a AND browser_owner_generation=1
  ) THEN
    RAISE EXCEPTION 'exact browser POST recovery rotated ownership';
  END IF;

  PERFORM id FROM terminal_sessions
   WHERE request_id=stable_request_id AND request_sha256=other_request_digest
   FOR UPDATE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'browser request id admitted different semantics'; END IF;

  BEGIN
    INSERT INTO terminal_sessions(
      id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
      operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
      mode,ticket_sha256,reason,trace_id,expires_at
    ) VALUES (
      gen_random_uuid(),stable_request_id,request_digest,owner_a,1,
      'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev',
      'shell',digest('rollback-bridge-browser-ticket-duplicate','sha256'),
      'schema-033-unique-probe','rollback-bridge-browser-owner-unique-probe',
      clock_timestamp()+interval '5 minutes'
    );
    RAISE EXCEPTION 'browser request id uniqueness was not enforced';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  UPDATE terminal_sessions
     SET browser_owner_sha256=owner_b,
         browser_owner_generation=browser_owner_generation+1
   WHERE id=probe_id AND closed_at IS NULL
     AND request_id=stable_request_id AND request_sha256=request_digest
     AND browser_owner_sha256=owner_a AND browser_owner_generation=1
  RETURNING browser_owner_generation INTO observed_generation;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 OR observed_generation <> 2 THEN
    RAISE EXCEPTION 'browser ownership takeover did not rotate exactly once';
  END IF;

  UPDATE terminal_sessions
     SET browser_owner_sha256=owner_a,
         browser_owner_generation=browser_owner_generation+1
   WHERE id=probe_id AND closed_at IS NULL
     AND browser_owner_sha256=owner_a AND browser_owner_generation=1;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'stale browser takeover crossed the owner fence'; END IF;

  UPDATE terminal_sessions SET closed_at=clock_timestamp(),close_reason='stale-browser-delete'
   WHERE id=probe_id AND closed_at IS NULL
     AND browser_owner_sha256=owner_a AND browser_owner_generation=1;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'stale browser DELETE crossed the owner fence'; END IF;

  UPDATE terminal_sessions SET closed_at=clock_timestamp(),close_reason='exact-browser-delete'
   WHERE id=probe_id AND closed_at IS NULL
     AND browser_owner_sha256=owner_b AND browser_owner_generation=2;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'exact browser DELETE failed'; END IF;
END
$$;
ROLLBACK;
SELECT count(*) FROM terminal_sessions
 WHERE trace_id IN (
   'rollback-bridge-browser-owner-cas-probe',
   'rollback-bridge-browser-owner-unique-probe'
 );
"""

RELAY_INSTANCE_CAS_SQL = r"""
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $$
DECLARE
  probe_id uuid := gen_random_uuid();
  stable_request_id uuid := gen_random_uuid();
  relay_a text := repeat('a',64);
  relay_b text := repeat('b',64);
  boot_a uuid := gen_random_uuid();
  boot_b uuid := gen_random_uuid();
  claim_a bytea := digest('cauce-rollback-bridge-relay-instance-claim-a','sha256');
  claim_b bytea := digest('cauce-rollback-bridge-relay-instance-claim-b','sha256');
  affected integer;
  observed_epoch bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE trace_id='rollback-bridge-relay-instance-cas-probe'
  ) THEN
    RAISE EXCEPTION 'relay instance probe identity is not isolated';
  END IF;

  BEGIN
    INSERT INTO terminal_sessions(
      id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
      relay_instance_id,relay_boot_id,
      operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
      mode,ticket_sha256,reason,trace_id,expires_at
    ) VALUES (
      gen_random_uuid(),gen_random_uuid(),digest('relay-invalid-legacy-request','sha256'),
      digest('relay-invalid-legacy-owner','sha256'),1,NULL,NULL,
      'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev','shell',
      digest('relay-invalid-legacy-ticket','sha256'),'schema-034-negative-probe',
      'rollback-bridge-relay-instance-negative-legacy',clock_timestamp()+interval '5 minutes'
    );
    RAISE EXCEPTION 'schema-034 admitted a usable legacy NULL relay fence';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO terminal_sessions(
      id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
      relay_instance_id,relay_boot_id,
      operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
      mode,ticket_sha256,reason,trace_id,expires_at
    ) VALUES (
      gen_random_uuid(),gen_random_uuid(),digest('relay-invalid-instance-request','sha256'),
      digest('relay-invalid-instance-owner','sha256'),1,repeat('A',64),NULL,
      'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev','shell',
      digest('relay-invalid-instance-ticket','sha256'),'schema-034-negative-probe',
      'rollback-bridge-relay-instance-negative-format',clock_timestamp()+interval '5 minutes'
    );
    RAISE EXCEPTION 'schema-034 admitted a non-canonical relay instance id';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO terminal_sessions(
      id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
      relay_instance_id,relay_boot_id,
      operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
      mode,ticket_sha256,reason,trace_id,expires_at
    ) VALUES (
      gen_random_uuid(),gen_random_uuid(),digest('relay-invalid-boot-request','sha256'),
      digest('relay-invalid-boot-owner','sha256'),1,relay_a,boot_a,
      'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev','shell',
      digest('relay-invalid-boot-ticket','sha256'),'schema-034-negative-probe',
      'rollback-bridge-relay-instance-negative-boot',clock_timestamp()+interval '5 minutes'
    );
    RAISE EXCEPTION 'schema-034 admitted a boot id before relay claim epoch one';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO terminal_sessions(
    id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
    relay_instance_id,relay_boot_id,
    operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
    mode,ticket_sha256,reason,trace_id,expires_at
  ) VALUES (
    probe_id,stable_request_id,digest('rollback-bridge-relay-request','sha256'),
    digest('rollback-bridge-relay-owner','sha256'),1,relay_a,NULL,
    'rollback-bridge',false,'Steven:kant','Steven','kant','probe','stev',
    'shell',digest('rollback-bridge-relay-ticket','sha256'),'schema-034-cas-probe',
    'rollback-bridge-relay-instance-cas-probe',clock_timestamp()+interval '5 minutes'
  );

  UPDATE terminal_sessions
     SET consumed_at=clock_timestamp(),relay_claim_sha256=claim_a,relay_claim_epoch=1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes',relay_boot_id=boot_a
   WHERE id=probe_id AND closed_at IS NULL AND revoked_at IS NULL
     AND relay_instance_id=relay_b AND relay_boot_id IS NULL
     AND relay_claim_sha256 IS NULL AND relay_claim_epoch=0;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'another relay instance claimed the pinned session'; END IF;

  UPDATE terminal_sessions
     SET consumed_at=clock_timestamp(),relay_claim_sha256=claim_a,relay_claim_epoch=1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes',relay_boot_id=boot_a
   WHERE id=probe_id AND closed_at IS NULL AND revoked_at IS NULL
     AND relay_instance_id=relay_a AND relay_boot_id IS NULL
     AND relay_claim_sha256 IS NULL AND relay_claim_epoch=0;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'pinned relay instance initial claim failed'; END IF;

  UPDATE terminal_sessions
     SET relay_claim_sha256=claim_b,relay_claim_epoch=relay_claim_epoch+1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes',relay_boot_id=boot_b
   WHERE id=probe_id AND closed_at IS NULL AND revoked_at IS NULL
     AND relay_instance_id=relay_a AND relay_claim_expires_at<=clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'live relay boot admitted a competing takeover'; END IF;

  UPDATE terminal_sessions
     SET relay_claimed_at=clock_timestamp()-interval '2 minutes',
         relay_claim_expires_at=clock_timestamp()-interval '1 minute'
   WHERE id=probe_id AND relay_instance_id=relay_a AND relay_boot_id=boot_a
     AND relay_claim_sha256=claim_a AND relay_claim_epoch=1;

  UPDATE terminal_sessions
     SET relay_claim_sha256=claim_b,relay_claim_epoch=relay_claim_epoch+1,
         relay_claimed_at=clock_timestamp(),
         relay_claim_expires_at=clock_timestamp()+interval '2 minutes',relay_boot_id=boot_b
   WHERE id=probe_id AND closed_at IS NULL AND revoked_at IS NULL
     AND relay_instance_id=relay_a AND relay_claim_expires_at<=clock_timestamp()
  RETURNING relay_claim_epoch INTO observed_epoch;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 OR observed_epoch <> 2 THEN
    RAISE EXCEPTION 'expired relay boot takeover did not rotate one epoch';
  END IF;

  UPDATE terminal_sessions SET closed_at=clock_timestamp(),close_reason='stale-relay-boot-close'
   WHERE id=probe_id AND closed_at IS NULL AND revoked_at IS NULL
     AND relay_instance_id=relay_a AND relay_boot_id=boot_a
     AND relay_claim_sha256=claim_a AND relay_claim_epoch=1;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'stale relay boot crossed the rotated fence'; END IF;

  UPDATE terminal_sessions SET closed_at=clock_timestamp(),close_reason='exact-relay-boot-close'
   WHERE id=probe_id AND closed_at IS NULL AND revoked_at IS NULL
     AND relay_instance_id=relay_a AND relay_boot_id=boot_b
     AND relay_claim_sha256=claim_b AND relay_claim_epoch=2;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'exact relay boot close failed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE id=probe_id AND close_reason='exact-relay-boot-close'
       AND relay_instance_id=relay_a AND relay_boot_id=boot_b
       AND relay_claim_sha256=claim_b AND relay_claim_epoch=2
  ) THEN
    RAISE EXCEPTION 'relay close did not preserve its durable instance fence';
  END IF;
END
$$;
ROLLBACK;
SELECT count(*) FROM terminal_sessions
 WHERE trace_id='rollback-bridge-relay-instance-cas-probe';
"""

PROFILE_RUNTIME_ADOPTION_CAS_SQL = r"""
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $$
DECLARE
  probe_id uuid := gen_random_uuid();
  message_id uuid := gen_random_uuid();
  delivery_id uuid := gen_random_uuid();
  profile_revision bigint;
  generation_a text := 'rollback-bridge-' || probe_id::text;
  generation_b text := 'rollback-bridge-next-' || probe_id::text;
  documents_a jsonb := jsonb_build_array(jsonb_build_object(
    'name','AGENTS.md','path','/rollback-probe/AGENTS.md','sha',repeat('a',64)
  ));
  documents_b jsonb := jsonb_build_array(jsonb_build_object(
    'name','AGENTS.md','path','/rollback-probe/AGENTS.md','sha',repeat('b',64)
  ));
  affected integer;
BEGIN
  IF EXISTS (SELECT 1 FROM messages WHERE trace_id='rollback-bridge-profile-adoption-probe') THEN
    RAISE EXCEPTION 'profile adoption probe identity is not isolated';
  END IF;

  INSERT INTO agent_profiles(tenant_id,alias,role_summary)
  VALUES('Steven','socrates','Rollback bridge profile adoption probe')
  ON CONFLICT(tenant_id,alias) DO NOTHING;
  SELECT revision INTO STRICT profile_revision FROM agent_profiles
   WHERE tenant_id='Steven' AND alias='socrates';

  INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
  VALUES(message_id,gen_random_uuid(),'rollback-bridge-profile-adoption-probe',
         'Steven','grp.steven','kant','{"text":"profile adoption probe"}'::jsonb,'interactive',0);
  INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias)
  VALUES(delivery_id,message_id,'Steven','socrates');

  INSERT INTO agent_profile_runtime_expectations(
    tenant_id,alias,revision,generation,documents
  ) VALUES('Steven','socrates',profile_revision,generation_a,documents_a)
  ON CONFLICT(tenant_id,alias) DO UPDATE SET
    revision=EXCLUDED.revision,generation=EXCLUDED.generation,documents=EXCLUDED.documents,
    updated_at=clock_timestamp();

  BEGIN
    INSERT INTO agent_profile_runtime_adoptions(
      tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch
    ) VALUES(
      'Steven','socrates',profile_revision,generation_a,documents_b,
      delivery_id,1,'rollback-bridge-adapter',1
    );
    RAISE EXCEPTION 'profile adoption admitted mismatched document evidence';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO agent_profile_runtime_adoptions(
    tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch
  ) VALUES(
    'Steven','socrates',profile_revision,generation_a,documents_a,
    delivery_id,1,'rollback-bridge-adapter',1
  );
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'exact profile adoption was not recorded once'; END IF;

  UPDATE agent_profile_runtime_expectations
     SET generation=generation_b,updated_at=clock_timestamp()
   WHERE tenant_id='Steven' AND alias='socrates';
  IF NOT EXISTS (
    SELECT 1 FROM agent_profile_runtime_adoptions
     WHERE tenant_id='Steven' AND alias='socrates'
       AND revision=profile_revision AND generation=generation_a AND documents=documents_a
  ) THEN
    RAISE EXCEPTION 'profile adoption history was not retained after expectation advance';
  END IF;

  BEGIN
    INSERT INTO agent_profile_runtime_adoptions(
      tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch
    ) VALUES(
      'Steven','socrates',profile_revision,generation_b,documents_a,
      delivery_id,1,'rollback-bridge-adapter',1
    );
    RAISE EXCEPTION 'one delivery produced more than one profile adoption';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$$;
ROLLBACK;
SELECT count(*) FROM messages WHERE trace_id='rollback-bridge-profile-adoption-probe';
"""

SHADOW_TARGET_PHASE_CAS_SQL = r"""
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $$
DECLARE
  source_prefix text := 'rollback-bridge-shadow-phase-' || gen_random_uuid()::text;
  source_id text;
  inbox_id uuid;
  claim uuid;
  row_state record;
BEGIN
  -- A lease released before target dispatch consumes no attempt.
  source_id := source_prefix || '-unstarted';
  INSERT INTO shadow_router_inbox(direction,source_event_id,tenant_id,mode,correlation,envelope)
  VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'{}'::jsonb)
  RETURNING id INTO inbox_id;
  claim := gen_random_uuid();
  UPDATE shadow_router_inbox SET status='processing',claimed_by='bridge-probe',claim_token=claim,
         claim_expires_at=now()+interval '1 minute'
   WHERE id=inbox_id;
  UPDATE shadow_router_inbox SET status='pending',available_at=now(),claimed_by=NULL,
         claim_token=NULL,claim_expires_at=NULL,claim_target_started=false,
         last_error='shadow inbox lease released before target dispatch: bridge probe'
   WHERE id=inbox_id AND claim_token=claim;
  SELECT status,attempts,claim_target_started INTO STRICT row_state
    FROM shadow_router_inbox WHERE id=inbox_id;
  IF row_state.status<>'pending' OR row_state.attempts<>0 OR row_state.claim_target_started THEN
    RAISE EXCEPTION 'unstarted shadow phase consumed an attempt';
  END IF;

  -- Every pre-036 eager claim is rejected after migration rather than coexisting ambiguously.
  source_id := source_prefix || '-eager';
  INSERT INTO shadow_router_inbox(direction,source_event_id,tenant_id,mode,correlation,envelope)
  VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'{}'::jsonb)
  RETURNING id INTO inbox_id;
  BEGIN
    UPDATE shadow_router_inbox SET status='processing',attempts=attempts+1,
           claimed_by='old-bridge-probe',claim_token=gen_random_uuid(),
           claim_expires_at=now()+interval '1 minute' WHERE id=inbox_id;
    RAISE EXCEPTION 'pre-036 eager claim was admitted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  SELECT status,attempts INTO STRICT row_state FROM shadow_router_inbox WHERE id=inbox_id;
  IF row_state.status<>'pending' OR row_state.attempts<>0 THEN
    RAISE EXCEPTION 'rejected eager claim changed durable state';
  END IF;

  -- An armed dispatch whose outcome is lost is replayed without consumption; a later observed
  -- failure consumes exactly one attempt.
  source_id := source_prefix || '-armed';
  INSERT INTO shadow_router_inbox(
    direction,source_event_id,tenant_id,mode,correlation,envelope
  ) VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'{}'::jsonb)
  RETURNING id INTO inbox_id;
  claim := gen_random_uuid();
  UPDATE shadow_router_inbox SET status='processing',claimed_by='bridge-probe',claim_token=claim,
         claim_expires_at=now()+interval '1 minute' WHERE id=inbox_id;
  UPDATE shadow_router_inbox SET claim_target_started=true WHERE id=inbox_id AND claim_token=claim;
  UPDATE shadow_router_inbox SET status='failed',available_at=now(),claimed_by=NULL,
         claim_token=NULL,claim_expires_at=NULL,claim_target_started=false,
         last_error='shadow target dispatch outcome was lost; replaying idempotently'
   WHERE id=inbox_id AND claim_token=claim;
  SELECT status,attempts INTO STRICT row_state FROM shadow_router_inbox WHERE id=inbox_id;
  IF row_state.status<>'failed' OR row_state.attempts<>0 THEN
    RAISE EXCEPTION 'ambiguous shadow dispatch consumed an attempt';
  END IF;
  claim := gen_random_uuid();
  UPDATE shadow_router_inbox SET status='processing',claimed_by='bridge-probe',claim_token=claim,
         claim_expires_at=now()+interval '1 minute' WHERE id=inbox_id;
  UPDATE shadow_router_inbox SET claim_target_started=true WHERE id=inbox_id AND claim_token=claim;
  UPDATE shadow_router_inbox SET status='failed',attempts=attempts+1,available_at=now(),
         claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,claim_target_started=false,
         last_error='shadow target settlement observed: bridge probe'
   WHERE id=inbox_id AND claim_token=claim;
  SELECT status,attempts INTO STRICT row_state FROM shadow_router_inbox WHERE id=inbox_id;
  IF row_state.status<>'failed' OR row_state.attempts<>1 THEN
    RAISE EXCEPTION 'observed shadow settlement did not consume exactly one attempt';
  END IF;

  -- Terminal mapping success wins both orders of the expired-A/live-B race and cannot be
  -- overwritten by a late failure.
  source_id := source_prefix || '-terminal-first';
  INSERT INTO shadow_router_inbox(
    direction,source_event_id,tenant_id,mode,correlation,envelope,attempts,max_attempts
  ) VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'{}'::jsonb,4,5)
  RETURNING id INTO inbox_id;
  claim := gen_random_uuid();
  UPDATE shadow_router_inbox SET status='processing',claimed_by='lease-a',claim_token=claim,
         claim_expires_at=now()+interval '1 minute' WHERE id=inbox_id;
  INSERT INTO shadow_router_mappings(
    direction,source_event_id,tenant_id,mode,correlation,status
  ) VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'processing');
  UPDATE shadow_router_inbox SET claim_target_started=true WHERE id=inbox_id AND claim_token=claim;
  UPDATE shadow_router_inbox SET status='failed',available_at=now(),claimed_by=NULL,
         claim_token=NULL,claim_expires_at=NULL,claim_target_started=false,
         last_error='shadow target dispatch outcome was lost; replaying idempotently'
   WHERE id=inbox_id AND claim_token=claim;
  claim := gen_random_uuid();
  UPDATE shadow_router_inbox SET status='processing',claimed_by='lease-b',claim_token=claim,
         claim_expires_at=now()+interval '1 minute' WHERE id=inbox_id;
  UPDATE shadow_router_inbox SET claim_target_started=true WHERE id=inbox_id AND claim_token=claim;
  UPDATE shadow_router_mappings SET status='shadowed',updated_at=clock_timestamp()
   WHERE direction='v2-to-v3' AND source_event_id=source_id;
  UPDATE shadow_router_mappings SET status='failed',updated_at=clock_timestamp()
   WHERE direction='v2-to-v3' AND source_event_id=source_id;
  SELECT inbox.status,inbox.attempts,mapping.status AS mapping_status
    INTO STRICT row_state
    FROM shadow_router_inbox inbox
    JOIN shadow_router_mappings mapping USING(direction,source_event_id)
   WHERE inbox.id=inbox_id;
  IF row_state.status<>'done' OR row_state.attempts<>5 OR row_state.mapping_status<>'shadowed' THEN
    RAISE EXCEPTION 'terminal shadow mapping was not monotonic and reconciled';
  END IF;

  -- If the competing failure reaches dead first, a later terminal mapping repairs it to done
  -- without double-consuming the final attempt.
  source_id := source_prefix || '-dead-first';
  INSERT INTO shadow_router_inbox(
    direction,source_event_id,tenant_id,mode,correlation,envelope,attempts,max_attempts
  ) VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'{}'::jsonb,4,5)
  RETURNING id INTO inbox_id;
  INSERT INTO shadow_router_mappings(
    direction,source_event_id,tenant_id,mode,correlation,status
  ) VALUES('v2-to-v3',source_id,'Steven','shadow','{}'::jsonb,'processing');
  claim := gen_random_uuid();
  UPDATE shadow_router_inbox SET status='processing',claimed_by='lease-b',claim_token=claim,
         claim_expires_at=now()+interval '1 minute' WHERE id=inbox_id;
  UPDATE shadow_router_inbox SET claim_target_started=true WHERE id=inbox_id AND claim_token=claim;
  UPDATE shadow_router_inbox SET status='dead',attempts=attempts+1,claimed_by=NULL,
         claim_token=NULL,claim_expires_at=NULL,claim_target_started=false,
         last_error='shadow target settlement observed: bridge probe'
   WHERE id=inbox_id AND claim_token=claim;
  UPDATE shadow_router_mappings SET status='shadowed',updated_at=clock_timestamp()
   WHERE direction='v2-to-v3' AND source_event_id=source_id;
  SELECT inbox.status,inbox.attempts,mapping.status AS mapping_status
    INTO STRICT row_state
    FROM shadow_router_inbox inbox
    JOIN shadow_router_mappings mapping USING(direction,source_event_id)
   WHERE inbox.id=inbox_id;
  IF row_state.status<>'done' OR row_state.attempts<>5 OR row_state.mapping_status<>'shadowed' THEN
    RAISE EXCEPTION 'late terminal shadow mapping did not repair false dead';
  END IF;
END
$$;
ROLLBACK;
SELECT count(*) FROM shadow_router_inbox
 WHERE source_event_id LIKE 'rollback-bridge-shadow-phase-%';
"""


class IsolatedCycle:
    def __init__(
        self, *, scratch: pathlib.Path, candidate_image: str, bridge_image: str,
        postgres_image: str, backup: pathlib.Path, candidate_image_id: str,
        bridge_image_id: str, postgres_image_id: str,
    ) -> None:
        self.scratch = scratch
        self.project = f"cauce-rollback-bridge-{secrets.token_hex(8)}"
        self.candidate_image = candidate_image
        self.bridge_image = bridge_image
        self.image_ids = {
            "candidate": candidate_image_id,
            "bridge": bridge_image_id,
            "postgres": postgres_image_id,
        }
        self.probe_dir = scratch / "probes"
        self.probe_dir.mkdir(mode=0o755)
        health_probe = self.probe_dir / "database-health.mjs"
        health_probe.write_text(
            "import {createPool} from '/app/packages/store/dist/db.js';\n"
            "const pool=createPool(process.env.DATABASE_URL,{max:1,connectionTimeoutMillis:2000,"
            "applicationName:'rollback-bridge'});\n"
            "try { const r=await pool.query(\"SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1\");"
            f"if(r.rows[0]?.version!=='{TARGET_SCHEMA}') throw new Error('schema mismatch'); }}"
            " finally { await pool.end(); }\n",
            encoding="utf-8",
        )
        health_probe.chmod(0o444)
        password = secrets.token_urlsafe(36)
        self.password_file = scratch / "postgres-password"
        self.database_url_file = scratch / "database-url"
        self.password_file.write_text(password + "\n", encoding="utf-8")
        encoded = urllib.parse.quote(password, safe="")
        self.database_url_file.write_text(
            f"postgresql://cauce_rollback_bridge:{encoded}@postgres:5432/cauce_rollback_bridge\n",
            encoding="utf-8",
        )
        self.password_file.chmod(0o600)
        self.database_url_file.chmod(0o600)
        self.environment = canonical_child_environment({
            "COMPOSE_PROJECT_NAME": self.project,
            "DOCKER_DEFAULT_PLATFORM": TARGET_PLATFORM,
            "CAUCE_ROLLBACK_POSTGRES_IMAGE": postgres_image,
            "CAUCE_ROLLBACK_CANDIDATE_IMAGE": candidate_image,
            "CAUCE_ROLLBACK_BRIDGE_IMAGE": bridge_image,
            "CAUCE_ROLLBACK_BACKUP_FILE": os.fspath(backup),
            "CAUCE_ROLLBACK_PROBE_DIR": os.fspath(self.probe_dir),
            "CAUCE_ROLLBACK_POSTGRES_PASSWORD_FILE": os.fspath(self.password_file),
            "CAUCE_ROLLBACK_DATABASE_URL_FILE": os.fspath(self.database_url_file),
        })
        self.base = ["docker", "compose", "-f", os.fspath(COMPOSE_FILE), "--project-name", self.project]

    def command(self, *arguments: str, phase: str, capture: bool = False) -> subprocess.CompletedProcess[bytes]:
        return run_checked([*self.base, *arguments], phase=phase, environment=self.environment, capture=capture)

    def psql(self, sql: str, phase: str, *, capture: bool = False) -> bytes:
        command = [
            *self.base, "exec", "-T", "--user", "0:0", "postgres", "sh", "-ec",
            'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec "$@"', "sh",
            "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "cauce_rollback_bridge",
            "-d", "cauce_rollback_bridge", "-Atq", "-c", sql,
        ]
        return run_checked(command, phase=phase, environment=self.environment, capture=capture).stdout

    def run_runtime(self, service: str, *command: str, phase: str, capture: bool = False) -> bytes:
        if service not in {"candidate", "bridge"}:
            raise ProductionError(f"{phase} requested an invalid runtime service")
        container_name = f"{self.project}-{service}-probe-{secrets.token_hex(6)}"
        arguments = [
            *self.base, "--profile", "probe", "run", "--no-deps", "--pull", "never",
            "--name", container_name, service,
        ]
        arguments.extend(command)
        try:
            result = run_checked(arguments, phase=phase, environment=self.environment, capture=capture)
            running_id = run_checked(
                ["docker", "inspect", "--format", "{{.Image}}", container_name],
                phase=f"{phase} container image identity", capture=True,
            ).stdout.decode("ascii").strip()
            if running_id != self.image_ids[service]:
                raise ProductionError(f"{phase} executed another image ID")
            run_checked(["docker", "rm", container_name], phase=f"{phase} container removal")
            return result.stdout
        except Exception:
            subprocess.run(
                ["docker", "rm", "--force", container_name], check=False,
                env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            raise

    def resolve(self, candidate: str, bridge: str, postgres: str) -> None:
        output = self.command(
            "--profile", "probe", "config", "--format", "json",
            phase="resolve isolated Compose", capture=True,
        ).stdout
        try:
            model = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("resolved rollback bridge Compose is not JSON") from error
        if not isinstance(model, dict):
            raise ProductionError("resolved rollback bridge Compose is invalid")
        validate_resolved_compose(model, candidate, bridge, postgres)

    def start_and_restore(self) -> None:
        self.command("up", "-d", "--pull", "never", "postgres", phase="start isolated PostgreSQL")
        container_id = self.command(
            "ps", "-q", "postgres", phase="resolve isolated PostgreSQL container", capture=True,
        ).stdout.decode("ascii").strip()
        if not container_id or "\n" in container_id:
            raise ProductionError("isolated PostgreSQL container identity is ambiguous")
        running_id = run_checked(
            ["docker", "inspect", "--format", "{{.Image}}", container_id],
            phase="verify isolated PostgreSQL image identity", capture=True,
        ).stdout.decode("ascii").strip()
        if running_id != self.image_ids["postgres"]:
            raise ProductionError("isolated PostgreSQL executed another image ID")
        ready = False
        for _ in range(60):
            result = subprocess.run(
                [*self.base, "exec", "-T", "postgres", "pg_isready", "-U", "cauce_rollback_bridge",
                 "-d", "cauce_rollback_bridge"],
                env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
            if result.returncode == 0:
                ready = True
                break
            time.sleep(1)
        if not ready:
            raise ProductionError("isolated PostgreSQL did not become ready")
        self.command(
            "exec", "-T", "--user", "0:0", "postgres", "pg_restore", "--list", "/backup/source.dump",
            phase="validate backup archive",
        )
        self.command(
            "exec", "-T", "--user", "0:0", "postgres", "sh", "-ec",
            'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_restore '
            '--exit-on-error --single-transaction --no-owner --no-acl '
            '-U cauce_rollback_bridge -d cauce_rollback_bridge /backup/source.dump',
            phase="restore backup into isolated PostgreSQL",
        )
        version = self.psql("SHOW server_version_num", "verify PostgreSQL major", capture=True).decode().strip()
        if not version.isdigit() or int(version) // 10000 != 16:
            raise ProductionError("isolated restore did not run on PostgreSQL 16")

    def integrity(self, service: str, phase_name: str) -> None:
        output = self.run_runtime(
            service, "node", "deploy/migration-integrity.mjs", phase_name,
            phase=f"{service} {phase_name}-migration integrity", capture=True,
        )
        try:
            report = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError(f"{service} migration integrity returned invalid evidence") from error
        if report.get("suite") != "cauce-v3-migration-integrity" or report.get("phase") != phase_name:
            raise ProductionError(f"{service} migration integrity returned another phase")
        entries = report.get("entries")
        if not isinstance(entries, list) or not entries:
            raise ProductionError(f"{service} migration integrity returned no entries")
        if phase_name == "post" and any(entry.get("applied") is not True for entry in entries):
            raise ProductionError("candidate post-migration integrity retained pending migrations")

    def migrate(self, service: str, phase: str) -> None:
        self.run_runtime(service, "node", "deploy/migrate.mjs", phase=phase)

    def health(self, service: str, phase: str) -> None:
        self.run_runtime(service, "node", "deploy/runtime-package-smoke.mjs", phase=f"{phase} package smoke")
        self.run_runtime(service, "node", "/rollback-probes/database-health.mjs", phase=f"{phase} database health")

    def http_read_only_probe(self) -> None:
        output = self.run_runtime(
            "bridge", "node", "deploy/rollback-bridge-http-probe.mjs",
            phase="bridge OIDC HTTP read-only gate", capture=True,
        ).decode("utf8").strip()
        if output != "rollback bridge OIDC read-only probe passed":
            raise ProductionError("bridge OIDC HTTP read-only probe returned invalid evidence")

    def snapshot(self, stage: str) -> dict[str, Any]:
        output = self.psql("SET TIME ZONE 'UTC';" + SNAPSHOT_SQL, f"capture {stage}", capture=True)
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError(f"{stage} canonical snapshot is invalid") from error
        if not isinstance(value, dict):
            raise ProductionError(f"{stage} canonical snapshot is not an object")
        for field in ("migrationLedgerSha256", "reconciliationSha256", "profileContentSha256",
                      "profileRevisionSha256", "profileRuntimeSha256", "shadowTargetPhaseSha256",
                      "leasesSha256", "authSessionSha256",
                      "publishJournalSha256", "fullDatabaseStateSha256"):
            require_digest(value.get(field, ""), f"{stage} {field}")
        counts = value.get("rowCounts")
        if not isinstance(counts, dict) or any(not isinstance(item, int) or item < 0 for item in counts.values()):
            raise ProductionError(f"{stage} canonical row counts are invalid")
        return {"stage": stage, **value}

    def attested_snapshot(
        self, stage: str, runtime_role: str, runtime_identity: dict[str, Any],
        postgres_identity: dict[str, Any], runtime_observation: str,
    ) -> dict[str, Any]:
        if runtime_role not in {"candidate", "bridge"}:
            raise ProductionError(f"{stage} runtime role is invalid")
        if runtime_observation not in {
            "probe-containers-attested-and-drained",
            "writers-drained-image-selected",
            "compensated-running-container-attested",
        }:
            raise ProductionError(f"{stage} runtime observation is invalid")
        expected_runtime = runtime_stage_identity(runtime_identity)
        observed_runtime = verify_recovered_image(
            expected_runtime["repositoryDigest"], expected_runtime["imageId"],
            f"{stage} runtime", pull_enabled=False, expected_labels=expected_runtime["labels"],
        )
        expected_postgres = image_stage_identity(postgres_identity)
        observed_postgres = verify_recovered_image(
            expected_postgres["repositoryDigest"], expected_postgres["imageId"],
            f"{stage} PostgreSQL", pull_enabled=False,
        )
        if observed_runtime != expected_runtime or observed_postgres != expected_postgres:
            raise ProductionError(f"{stage} image identity changed during the lifecycle")
        snapshot = self.snapshot(stage)
        snapshot["images"] = {
            "runtimeRole": runtime_role,
            "runtimeObservation": runtime_observation,
            "runtime": expected_runtime,
            "postgres": expected_postgres,
        }
        return snapshot

    def fleet(self) -> dict[str, Any]:
        output = self.psql(FLEET_SQL, "verify exact schema-029 fleet", capture=True)
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-029 fleet probe returned invalid JSON") from error
        expected = {
            "enabledAgents": list(EXPECTED_ENABLED_AGENTS),
            "enabledMemberships": list(EXPECTED_ENABLED_MEMBERSHIPS),
            "disabledHistoricalAgents": list(EXPECTED_DISABLED_AGENTS),
            "systemPrincipalAgentRowCount": 0,
            "gateProbeMembershipCount": 0,
            "quotaCollectorEnabledMembershipCount": 1,
            "agentNotifyRole": {"allowRoute": True, "allowRead": True, "allowControl": False, "allowNotify": True},
            "activeReconciliationRunCount": 1,
            "activeReconciliationMigration": HISTORICAL_FLEET_MIGRATION,
        }
        if value != expected:
            raise ProductionError("schema-029 fleet differs from the exact declared contract")
        return {
            "enabledAgentCount": len(EXPECTED_ENABLED_AGENTS),
            "enabledAgents": list(EXPECTED_ENABLED_AGENTS),
            "enabledMembershipCount": len(EXPECTED_ENABLED_MEMBERSHIPS),
            "enabledMemberships": list(EXPECTED_ENABLED_MEMBERSHIPS),
            "disabledHistoricalAgentCount": len(EXPECTED_DISABLED_AGENTS),
            **expected,
        }

    def connection_fencing(self) -> dict[str, Any]:
        output = self.psql(
            r"""
SELECT jsonb_build_object(
  'migration','031_connection_session_fencing.sql',
  'table','connection_leases',
  'column','connection_token',
  'dataType',coalesce((SELECT data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='connection_leases'
      AND column_name='connection_token'),'absent'),
  'nullable',coalesce((SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='connection_leases'
      AND column_name='connection_token'),'absent'),
  'totalLeaseCount',(SELECT count(*) FROM connection_leases),
  'nonNullTokenCount',(SELECT count(connection_token) FROM connection_leases),
  'distinctTokenCount',(SELECT count(DISTINCT connection_token) FROM connection_leases),
  'nullTokenCount',(SELECT count(*) FROM connection_leases WHERE connection_token IS NULL)
)::text;
""",
            "verify schema-031 connection fencing",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-031 connection fencing probe returned invalid JSON") from error
        if not isinstance(value, dict):
            raise ProductionError("schema-031 connection fencing probe returned no object")
        total = value.get("totalLeaseCount")
        expected_static = {
            "migration": CONNECTION_FENCING_SCHEMA,
            "table": "connection_leases",
            "column": "connection_token",
            "dataType": "uuid",
            "nullable": "NO",
            "nullTokenCount": 0,
        }
        if (any(value.get(key) != expected for key, expected in expected_static.items())
                or not isinstance(total, int) or total < 0
                or value.get("nonNullTokenCount") != total
                or value.get("distinctTokenCount") != total):
            raise ProductionError("schema-031 connection fencing differs from the exact contract")
        return value

    def terminal_claim_fencing(self) -> dict[str, Any]:
        output = self.psql(
            r"""
WITH expected_columns(name,type_name,not_null) AS (VALUES
  ('relay_claim_sha256','bytea',false),
  ('relay_claim_epoch','bigint',true),
  ('relay_claimed_at','timestamp with time zone',false),
  ('relay_claim_expires_at','timestamp with time zone',false)
), checked_columns AS (
  SELECT count(attribute.attname)=4
         AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
         AND bool_and(attribute.attnotnull=expected.not_null) AS exact
    FROM expected_columns expected
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid='terminal_sessions'::regclass
     AND attribute.attname=expected.name AND NOT attribute.attisdropped
), claim_constraint AS (
  SELECT pg_get_expr(constraint_record.conbin,constraint_record.conrelid) AS expression
    FROM pg_constraint constraint_record
   WHERE constraint_record.conrelid='terminal_sessions'::regclass
     AND constraint_record.conname='terminal_sessions_relay_claim_shape'
     AND constraint_record.contype='c' AND constraint_record.convalidated
)
SELECT jsonb_build_object(
  'migration','032_terminal_session_claim_fencing.sql',
  'table','terminal_sessions',
  'constraint','terminal_sessions_relay_claim_shape',
  'columnsExact',coalesce((SELECT exact FROM checked_columns),false),
  'epochDefaultExact',EXISTS (
    SELECT 1 FROM pg_attribute attribute
    JOIN pg_attrdef definition
      ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
   WHERE attribute.attrelid='terminal_sessions'::regclass
     AND attribute.attname='relay_claim_epoch' AND attribute.attnotnull
     AND pg_get_expr(definition.adbin,definition.adrelid)='0'
  ),
  'constraintExact',EXISTS (
    SELECT 1 FROM claim_constraint
     WHERE position('relay_claim_sha256 IS NULL' in expression)>0
       AND position('relay_claim_epoch = 0' in expression)>0
       AND position('relay_claimed_at IS NULL' in expression)>0
       AND position('relay_claim_expires_at IS NULL' in expression)>0
       AND position('consumed_at IS NOT NULL' in expression)>0
       AND position('octet_length(relay_claim_sha256) = 32' in expression)>0
       AND position('relay_claim_epoch > 0' in expression)>0
       AND position('relay_claimed_at IS NOT NULL' in expression)>0
       AND position('relay_claim_expires_at IS NOT NULL' in expression)>0
       AND position('relay_claim_expires_at > relay_claimed_at' in expression)>0
  ),
  'openTerminalSessionCount',(SELECT count(*) FROM terminal_sessions
    WHERE closed_at IS NULL AND revoked_at IS NULL),
  'legacyOpenSessionCount',(SELECT count(*) FROM terminal_sessions
    WHERE consumed_at IS NOT NULL AND closed_at IS NULL
      AND (relay_claim_sha256 IS NULL OR relay_claim_epoch=0
        OR relay_claimed_at IS NULL OR relay_claim_expires_at IS NULL))
)::text;
""",
            "verify schema-032 terminal claim shape and drained legacy sessions",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-032 terminal claim probe returned invalid JSON") from error
        expected = {
            "migration": TERMINAL_CLAIM_FENCING_SCHEMA,
            "table": "terminal_sessions",
            "constraint": "terminal_sessions_relay_claim_shape",
            "columnsExact": True,
            "epochDefaultExact": True,
            "constraintExact": True,
            "openTerminalSessionCount": 0,
            "legacyOpenSessionCount": 0,
        }
        if value != expected:
            raise ProductionError("schema-032 terminal claim fencing or drain preflight is not exact")
        rolled_back = self.psql(
            TERMINAL_CLAIM_CAS_SQL,
            "verify schema-032 terminal claim CAS, lease, takeover and stale close",
            capture=True,
        ).decode("ascii").strip()
        if rolled_back != "0":
            raise ProductionError("schema-032 terminal claim CAS probe did not roll back")
        return {
            **value,
            "claimCas": "passed",
            "liveLeaseConflict": "passed",
            "takeoverEpochRotation": "passed",
            "staleCloseNoop": "passed",
            "exactClosePreservesFence": "passed",
            "transactionRollback": "passed",
        }

    def browser_owner_fencing(self) -> dict[str, Any]:
        output = self.psql(
            r"""
WITH expected_columns(name,type_name) AS (VALUES
  ('request_id','uuid'),
  ('request_sha256','bytea'),
  ('browser_owner_sha256','bytea'),
  ('browser_owner_generation','bigint')
), checked_columns AS (
  SELECT count(attribute.attname)=4
         AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
         AND bool_and(attribute.attnotnull) AS exact
    FROM expected_columns expected
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid='terminal_sessions'::regclass
     AND attribute.attname=expected.name AND NOT attribute.attisdropped
), owner_constraint AS (
  SELECT pg_get_expr(constraint_record.conbin,constraint_record.conrelid) AS expression
    FROM pg_constraint constraint_record
   WHERE constraint_record.conrelid='terminal_sessions'::regclass
     AND constraint_record.conname='terminal_sessions_browser_owner_shape'
     AND constraint_record.contype='c' AND constraint_record.convalidated
)
SELECT jsonb_build_object(
  'migration','033_terminal_browser_owner_fencing.sql',
  'table','terminal_sessions',
  'constraint','terminal_sessions_browser_owner_shape',
  'requestIndex','terminal_sessions_request_id_idx',
  'columnsExact',coalesce((SELECT exact FROM checked_columns),false),
  'constraintExact',EXISTS (
    SELECT 1 FROM owner_constraint
     WHERE position('octet_length(request_sha256) = 32' in expression)>0
       AND position('octet_length(browser_owner_sha256) = 32' in expression)>0
       AND position('browser_owner_generation > 0' in expression)>0
  ),
  'requestUniqueExact',EXISTS (
    SELECT 1 FROM pg_index index_record
    JOIN pg_class index_class ON index_class.oid=index_record.indexrelid
    JOIN pg_attribute request_attribute
      ON request_attribute.attrelid=index_record.indrelid
     AND request_attribute.attname='request_id' AND NOT request_attribute.attisdropped
   WHERE index_record.indrelid='terminal_sessions'::regclass
     AND index_class.relname='terminal_sessions_request_id_idx'
     AND index_record.indisunique AND index_record.indisvalid AND index_record.indisready
     AND index_record.indpred IS NULL AND index_record.indexprs IS NULL
     AND index_record.indnkeyatts=1 AND index_record.indnatts=1
     AND index_record.indkey[0]=request_attribute.attnum
  ),
  'openTerminalSessionCount',(SELECT count(*) FROM terminal_sessions
    WHERE closed_at IS NULL AND revoked_at IS NULL),
  'invalidStoredFenceCount',(SELECT count(*) FROM terminal_sessions
    WHERE octet_length(request_sha256)<>32 OR octet_length(browser_owner_sha256)<>32
       OR browser_owner_generation<=0),
  'rawOwnerColumnCount',(SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='terminal_sessions'
      AND (
        (column_name LIKE '%browser%owner%'
          AND column_name NOT IN ('browser_owner_sha256','browser_owner_generation'))
        OR column_name LIKE '%owner%token%'
      ))
)::text;
""",
            "verify schema-033 browser request and owner fencing shape",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-033 browser owner probe returned invalid JSON") from error
        expected = {
            "migration": BROWSER_OWNER_FENCING_SCHEMA,
            "table": "terminal_sessions",
            "constraint": "terminal_sessions_browser_owner_shape",
            "requestIndex": "terminal_sessions_request_id_idx",
            "columnsExact": True,
            "constraintExact": True,
            "requestUniqueExact": True,
            "openTerminalSessionCount": 0,
            "invalidStoredFenceCount": 0,
            "rawOwnerColumnCount": 0,
        }
        if value != expected:
            raise ProductionError("schema-033 browser owner fencing or drain preflight is not exact")
        rolled_back = self.psql(
            BROWSER_OWNER_CAS_SQL,
            "verify schema-033 request recovery, owner CAS and stale DELETE",
            capture=True,
        ).decode("ascii").strip()
        if rolled_back != "0":
            raise ProductionError("schema-033 browser owner CAS probe did not roll back")
        return {
            **value,
            "exactPostRecoveryNoRotation": "passed",
            "requestMismatchConflict": "passed",
            "requestUnique": "passed",
            "ownerTakeoverCas": "passed",
            "staleDeleteNoop": "passed",
            "exactDelete": "passed",
            "transactionRollback": "passed",
        }

    def relay_instance_fencing(self) -> dict[str, Any]:
        output = self.psql(
            r"""
WITH expected_columns(name,type_name,not_null) AS (VALUES
  ('relay_instance_id','text',false),
  ('relay_boot_id','uuid',false)
), checked_columns AS (
  SELECT count(attribute.attname)=2
         AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
         AND bool_and(attribute.attnotnull=expected.not_null) AS exact
    FROM expected_columns expected
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid='terminal_sessions'::regclass
     AND attribute.attname=expected.name AND NOT attribute.attisdropped
), instance_constraint AS (
  SELECT pg_get_expr(constraint_record.conbin,constraint_record.conrelid) AS expression
    FROM pg_constraint constraint_record
   WHERE constraint_record.conrelid='terminal_sessions'::regclass
     AND constraint_record.conname='terminal_sessions_relay_instance_shape'
     AND constraint_record.contype='c' AND constraint_record.convalidated
)
SELECT jsonb_build_object(
  'migration','034_terminal_relay_instance_fencing.sql',
  'table','terminal_sessions',
  'constraint','terminal_sessions_relay_instance_shape',
  'columnsExact',coalesce((SELECT exact FROM checked_columns),false),
  'constraintExact',EXISTS (
    SELECT 1 FROM instance_constraint
     WHERE position('relay_instance_id IS NULL' in expression)>0
       AND position('relay_boot_id IS NULL' in expression)>0
       AND position('closed_at IS NOT NULL' in expression)>0
       AND position('revoked_at IS NOT NULL' in expression)>0
       AND position('relay_instance_id ~ ' in expression)>0
       AND position('^[0-9a-f]{64}$' in expression)>0
       AND position('relay_claim_epoch = 0' in expression)>0
       AND position('relay_boot_id IS NOT NULL' in expression)>0
       AND position('relay_claim_epoch > 0' in expression)>0
       AND position('^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' in expression)>0
  ),
  'usableTerminalSessionCount',(SELECT count(*) FROM terminal_sessions
    WHERE closed_at IS NULL AND revoked_at IS NULL),
  'legacyUsableSessionCount',(SELECT count(*) FROM terminal_sessions
    WHERE closed_at IS NULL AND revoked_at IS NULL
      AND (relay_instance_id IS NULL OR
        (relay_claim_epoch>0 AND relay_boot_id IS NULL))),
  'invalidStoredFenceCount',(SELECT count(*) FROM terminal_sessions
    WHERE (relay_instance_id IS NULL AND relay_boot_id IS NOT NULL)
       OR (relay_instance_id IS NULL AND closed_at IS NULL AND revoked_at IS NULL)
       OR (relay_instance_id IS NOT NULL AND relay_instance_id !~ '^[0-9a-f]{64}$')
       OR (relay_instance_id IS NOT NULL AND relay_boot_id IS NULL AND relay_claim_epoch<>0)
       OR (relay_instance_id IS NOT NULL AND relay_boot_id IS NOT NULL
         AND (relay_claim_epoch<=0 OR relay_boot_id::text !~
           '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))
)::text;
""",
            "verify schema-034 relay instance shape and drained pre-034 sessions",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-034 relay instance probe returned invalid JSON") from error
        expected = {
            "migration": RELAY_INSTANCE_FENCING_SCHEMA,
            "table": "terminal_sessions",
            "constraint": "terminal_sessions_relay_instance_shape",
            "columnsExact": True,
            "constraintExact": True,
            "usableTerminalSessionCount": 0,
            "legacyUsableSessionCount": 0,
            "invalidStoredFenceCount": 0,
        }
        if value != expected:
            raise ProductionError("schema-034 relay instance fencing or drain preflight is not exact")
        rolled_back = self.psql(
            RELAY_INSTANCE_CAS_SQL,
            "verify schema-034 pinned relay, boot takeover and stale close",
            capture=True,
        ).decode("ascii").strip()
        if rolled_back != "0":
            raise ProductionError("schema-034 relay instance CAS probe did not roll back")
        return {
            **value,
            "pinnedInstanceClaim": "passed",
            "liveBootConflict": "passed",
            "expiredBootTakeover": "passed",
            "staleBootCloseNoop": "passed",
            "exactClosePreservesFence": "passed",
            "constraintCounterexamples": "passed",
            "transactionRollback": "passed",
        }

    def profile_runtime_adoption(self) -> dict[str, Any]:
        output = self.psql(
            r"""
WITH expected_columns(table_name,column_name,type_name,not_null) AS (VALUES
  ('agent_profile_runtime_expectations','tenant_id','text',true),
  ('agent_profile_runtime_expectations','alias','text',true),
  ('agent_profile_runtime_expectations','revision','bigint',true),
  ('agent_profile_runtime_expectations','generation','text',true),
  ('agent_profile_runtime_expectations','documents','jsonb',true),
  ('agent_profile_runtime_expectations','recorded_at','timestamp with time zone',true),
  ('agent_profile_runtime_expectations','updated_at','timestamp with time zone',true),
  ('agent_profile_runtime_adoptions','tenant_id','text',true),
  ('agent_profile_runtime_adoptions','alias','text',true),
  ('agent_profile_runtime_adoptions','revision','bigint',true),
  ('agent_profile_runtime_adoptions','generation','text',true),
  ('agent_profile_runtime_adoptions','documents','jsonb',true),
  ('agent_profile_runtime_adoptions','delivery_id','uuid',true),
  ('agent_profile_runtime_adoptions','attempt','integer',true),
  ('agent_profile_runtime_adoptions','instance_id','text',true),
  ('agent_profile_runtime_adoptions','epoch','bigint',true),
  ('agent_profile_runtime_adoptions','adopted_at','timestamp with time zone',true)
), checked_columns AS (
  SELECT count(attribute.attname)=17
         AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
         AND bool_and(attribute.attnotnull=expected.not_null) AS exact
    FROM expected_columns expected
    LEFT JOIN pg_class relation ON relation.relname=expected.table_name
      AND relation.relnamespace='public'::regnamespace
    LEFT JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      AND attribute.attname=expected.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
), actual_columns AS (
  SELECT count(*) AS count FROM pg_attribute attribute
  JOIN pg_class relation ON relation.oid=attribute.attrelid
   WHERE relation.relnamespace='public'::regnamespace
     AND relation.relname IN ('agent_profile_runtime_expectations','agent_profile_runtime_adoptions')
     AND attribute.attnum>0 AND NOT attribute.attisdropped
), constraint_shape AS (
  SELECT array_agg(constraint_record.conname ORDER BY constraint_record.conname) names,
         string_agg(pg_get_constraintdef(constraint_record.oid), E'\n'
           ORDER BY constraint_record.conname) definitions
    FROM pg_constraint constraint_record
   WHERE constraint_record.conrelid IN (
     'agent_profile_runtime_expectations'::regclass,
     'agent_profile_runtime_adoptions'::regclass
   ) AND constraint_record.convalidated
), function_shape AS (
  SELECT bool_and(
    CASE procedure.proname
      WHEN 'cauce_profile_runtime_documents_valid' THEN
        procedure.prorettype='boolean'::regtype AND procedure.provolatile='i'
        AND procedure.proparallel='s'
        AND pg_get_function_identity_arguments(procedure.oid)='candidate jsonb'
        AND position('jsonb_object_keys' in pg_get_functiondef(procedure.oid))>0
        AND position('count(DISTINCT value ->> ''name''::text)' in pg_get_functiondef(procedure.oid))>0
        AND position('count(DISTINCT value ->> ''path''::text)' in pg_get_functiondef(procedure.oid))>0
        AND position('^[a-f0-9]{64}$' in pg_get_functiondef(procedure.oid))>0
      WHEN 'cauce_profile_runtime_adoption_matches_expectation' THEN
        procedure.prorettype='trigger'::regtype
        AND position('expectation.revision = new.revision' in lower(pg_get_functiondef(procedure.oid)))>0
        AND position('expectation.generation = new.generation' in lower(pg_get_functiondef(procedure.oid)))>0
        AND position('expectation.documents = new.documents' in lower(pg_get_functiondef(procedure.oid)))>0
      ELSE false
    END
  ) AND count(*)=2 AS exact
    FROM pg_proc procedure
   WHERE procedure.pronamespace='public'::regnamespace
     AND procedure.proname IN (
       'cauce_profile_runtime_documents_valid',
       'cauce_profile_runtime_adoption_matches_expectation'
     )
), trigger_shape AS (
  SELECT count(*)=1
         AND bool_and(trigger_record.tgenabled='O' AND NOT trigger_record.tgisinternal)
         AND bool_and(position('BEFORE INSERT OR UPDATE' in pg_get_triggerdef(trigger_record.oid))>0)
         AND bool_and(position('EXECUTE FUNCTION cauce_profile_runtime_adoption_matches_expectation()'
           in pg_get_triggerdef(trigger_record.oid))>0) AS exact
    FROM pg_trigger trigger_record
   WHERE trigger_record.tgrelid='agent_profile_runtime_adoptions'::regclass
     AND trigger_record.tgname='agent_profile_runtime_adoptions_expectation_guard'
)
SELECT jsonb_build_object(
  'migration','035_agent_profile_runtime_adoption.sql',
  'expectationsTable','agent_profile_runtime_expectations',
  'adoptionsTable','agent_profile_runtime_adoptions',
  'tablesExact',coalesce((SELECT exact FROM checked_columns),false)
    AND (SELECT count=17 FROM actual_columns),
  'constraintsExact',coalesce((SELECT
    names @> ARRAY[
      'agent_profile_runtime_expectations_documents_valid',
      'agent_profile_runtime_expectations_pkey',
      'agent_profile_runtime_adoptions_documents_valid',
      'agent_profile_runtime_adoptions_pkey',
      'agent_profile_runtime_adoptions_delivery_id_key'
    ]::name[]
    AND position('PRIMARY KEY (tenant_id, alias)' in definitions)>0
    AND position('PRIMARY KEY (tenant_id, alias, revision, generation)' in definitions)>0
    AND position('UNIQUE (delivery_id)' in definitions)>0
    AND position('cauce_profile_runtime_documents_valid(documents)' in definitions)>0
    AND position('FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE RESTRICT' in definitions)>0
    FROM constraint_shape),false),
  'functionsExact',coalesce((SELECT exact FROM function_shape),false),
  'triggerExact',coalesce((SELECT exact FROM trigger_shape),false),
  'expectationCount',(SELECT count(*) FROM agent_profile_runtime_expectations),
  'adoptionCount',(SELECT count(*) FROM agent_profile_runtime_adoptions),
  'invalidStoredExpectationCount',(SELECT count(*) FROM agent_profile_runtime_expectations
    WHERE revision<=0 OR generation='' OR char_length(generation)>128
      OR NOT cauce_profile_runtime_documents_valid(documents)),
  'invalidStoredAdoptionCount',(SELECT count(*) FROM agent_profile_runtime_adoptions
    WHERE revision<=0 OR generation='' OR char_length(generation)>128 OR attempt<=0 OR epoch<=0
      OR instance_id='' OR char_length(instance_id)>128
      OR NOT cauce_profile_runtime_documents_valid(documents))
)::text;
""",
            "verify schema-035 profile runtime adoption shape",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-035 profile adoption probe returned invalid JSON") from error
        expected_shape = {
            "migration": PROFILE_RUNTIME_ADOPTION_SCHEMA,
            "expectationsTable": "agent_profile_runtime_expectations",
            "adoptionsTable": "agent_profile_runtime_adoptions",
            "tablesExact": True,
            "constraintsExact": True,
            "functionsExact": True,
            "triggerExact": True,
            "invalidStoredExpectationCount": 0,
            "invalidStoredAdoptionCount": 0,
        }
        if any(value.get(key) != expected for key, expected in expected_shape.items()):
            raise ProductionError("schema-035 profile runtime adoption shape is not exact")
        if (not isinstance(value.get("expectationCount"), int) or value["expectationCount"] < 0
                or not isinstance(value.get("adoptionCount"), int) or value["adoptionCount"] < 0):
            raise ProductionError("schema-035 profile runtime adoption counts are invalid")
        rolled_back = self.psql(
            PROFILE_RUNTIME_ADOPTION_CAS_SQL,
            "verify schema-035 exact adoption, mismatch and delivery uniqueness",
            capture=True,
        ).decode("ascii").strip()
        if rolled_back != "0":
            raise ProductionError("schema-035 profile runtime adoption probe did not roll back")
        return {
            **value,
            "exactExpectationAdoption": "passed",
            "mismatchRejected": "passed",
            "deliveryUnique": "passed",
            "historyRetained": "passed",
            "transactionRollback": "passed",
        }

    def shadow_target_phase(self) -> dict[str, Any]:
        output = self.psql(
            f"""
WITH expected_columns(position,name,type_name,not_null,default_expression) AS (VALUES
  (18,'claim_target_started','boolean',true,'false'::text)
), checked_columns AS (
  SELECT count(attribute.attname)=1
         AND bool_and(attribute.attnum=expected.position)
         AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
         AND bool_and(attribute.attnotnull=expected.not_null)
         AND bool_and(attribute.attidentity='' AND attribute.attgenerated='')
         AND bool_and(pg_get_expr(definition.adbin,definition.adrelid)
               IS NOT DISTINCT FROM expected.default_expression)
         AND (SELECT count(*)=18 FROM pg_attribute actual
           WHERE actual.attrelid='shadow_router_inbox'::regclass
             AND actual.attnum>0 AND NOT actual.attisdropped) AS exact
    FROM expected_columns expected
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid='shadow_router_inbox'::regclass
     AND attribute.attname=expected.name AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef definition
      ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
), constraint_shape AS (
  SELECT count(*)=1 AND bool_and(constraint_record.convalidated)
         AND bool_and(NOT constraint_record.connoinherit)
         AND bool_and(encode(digest(convert_to(
           pg_get_constraintdef(constraint_record.oid,true),'UTF8'
         ),'sha256'),'hex')='{SHADOW_PHASE_CONSTRAINT_SHA256}') AS exact
    FROM pg_constraint constraint_record
   WHERE constraint_record.conrelid='shadow_router_inbox'::regclass
     AND constraint_record.conname='shadow_router_inbox_claim_phase_shape'
     AND constraint_record.contype='c'
), expected_functions(name,body_sha256) AS (VALUES
  ('cauce_shadow_router_claim_phase_transition','{SHADOW_PHASE_FUNCTION_SHA256}'),
  ('cauce_shadow_router_mapping_status_monotonic','{SHADOW_MAPPING_MONOTONIC_FUNCTION_SHA256}'),
  ('cauce_shadow_router_mapping_terminal_reconcile','{SHADOW_MAPPING_RECONCILE_FUNCTION_SHA256}')
), function_shape AS (
  SELECT count(procedure.oid)=3
         AND bool_and(procedure.prorettype='trigger'::regtype)
         AND bool_and(procedure.provolatile='v' AND procedure.proparallel='u')
         AND bool_and(NOT procedure.prosecdef AND NOT procedure.proleakproof)
         AND bool_and(NOT procedure.proisstrict AND NOT procedure.proretset)
         AND bool_and(procedure.prokind='f' AND procedure.pronargdefaults=0)
         AND bool_and(procedure.proconfig IS NULL AND language_record.lanname='plpgsql')
         AND bool_and(pg_get_function_identity_arguments(procedure.oid)='')
         AND bool_and(encode(digest(convert_to(procedure.prosrc,'UTF8'),'sha256'),'hex')
           =expected.body_sha256) AS exact
    FROM expected_functions expected
    LEFT JOIN pg_proc procedure
      ON procedure.pronamespace='public'::regnamespace AND procedure.proname=expected.name
    LEFT JOIN pg_language language_record ON language_record.oid=procedure.prolang
), expected_triggers(table_name,name,definition) AS (VALUES
  ('shadow_router_inbox','shadow_router_inbox_claim_phase_transition',
   'CREATE TRIGGER shadow_router_inbox_claim_phase_transition BEFORE UPDATE ON shadow_router_inbox FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_claim_phase_transition()'),
  ('shadow_router_mappings','shadow_router_mapping_status_monotonic',
   'CREATE TRIGGER shadow_router_mapping_status_monotonic BEFORE UPDATE OF status ON shadow_router_mappings FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_status_monotonic()'),
  ('shadow_router_mappings','shadow_router_mapping_terminal_reconcile',
   'CREATE TRIGGER shadow_router_mapping_terminal_reconcile AFTER INSERT OR UPDATE ON shadow_router_mappings FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_terminal_reconcile()')
), trigger_shape AS (
  SELECT count(trigger_record.oid)=3 AND bool_and(trigger_record.tgenabled='O')
         AND bool_and(NOT trigger_record.tgisinternal)
         AND bool_and(pg_get_triggerdef(trigger_record.oid,true)=expected.definition) AS exact
    FROM expected_triggers expected
    LEFT JOIN pg_trigger trigger_record
      ON trigger_record.tgrelid=('public.'||expected.table_name)::regclass
     AND trigger_record.tgname=expected.name
)
SELECT jsonb_build_object(
  'migration','036_shadow_router_target_phase.sql',
  'migrationApplied',EXISTS(SELECT 1 FROM schema_migrations
    WHERE version='036_shadow_router_target_phase.sql'),
  'table','shadow_router_inbox',
  'column','claim_target_started',
  'constraint','shadow_router_inbox_claim_phase_shape',
  'functions',jsonb_build_array(
    'cauce_shadow_router_claim_phase_transition',
    'cauce_shadow_router_mapping_status_monotonic',
    'cauce_shadow_router_mapping_terminal_reconcile'
  ),
  'triggers',jsonb_build_array(
    'shadow_router_inbox_claim_phase_transition',
    'shadow_router_mapping_status_monotonic',
    'shadow_router_mapping_terminal_reconcile'
  ),
  'columnsExact',coalesce((SELECT exact FROM checked_columns),false),
  'constraintExact',coalesce((SELECT exact FROM constraint_shape),false),
  'functionsExact',coalesce((SELECT exact FROM function_shape),false),
  'triggersExact',coalesce((SELECT exact FROM trigger_shape),false),
  'processingCount',(SELECT count(*) FROM shadow_router_inbox WHERE status='processing'),
  'invalidStoredPhaseCount',(SELECT count(*) FROM shadow_router_inbox
    WHERE (status='processing' AND (
         claimed_by IS NULL OR claim_token IS NULL OR claim_expires_at IS NULL
       ))
       OR (status<>'processing' AND (
         claimed_by IS NOT NULL OR claim_token IS NOT NULL OR claim_expires_at IS NOT NULL
         OR claim_target_started
       )))
)::text;
""",
            "verify schema-036 shadow target phase shape and drained claims",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-036 shadow target phase probe returned invalid JSON") from error
        expected_shape = {
            "migration": SHADOW_TARGET_PHASE_SCHEMA,
            "migrationApplied": True,
            "table": "shadow_router_inbox",
            "column": "claim_target_started",
            "constraint": "shadow_router_inbox_claim_phase_shape",
            "functions": [
                "cauce_shadow_router_claim_phase_transition",
                "cauce_shadow_router_mapping_status_monotonic",
                "cauce_shadow_router_mapping_terminal_reconcile",
            ],
            "triggers": [
                "shadow_router_inbox_claim_phase_transition",
                "shadow_router_mapping_status_monotonic",
                "shadow_router_mapping_terminal_reconcile",
            ],
            "columnsExact": True,
            "constraintExact": True,
            "functionsExact": True,
            "triggersExact": True,
            "processingCount": 0,
            "invalidStoredPhaseCount": 0,
        }
        if value != expected_shape:
            raise ProductionError("schema-036 shadow target phase shape or drain is not exact")
        rolled_back = self.psql(
            SHADOW_TARGET_PHASE_CAS_SQL,
            "verify schema-036 eager rejection, replay, settlement and competing terminal phases",
            capture=True,
        ).decode("ascii").strip()
        if rolled_back != "0":
            raise ProductionError("schema-036 shadow target phase probe did not roll back")
        return {
            **value,
            "pre036EagerClaimRejected": "passed",
            "unstartedReplay": "passed",
            "armedReplay": "passed",
            "observedSettlement": "passed",
            "terminalMappingMonotonic": "passed",
            "terminalMappingReconciliation": "passed",
            "transactionRollback": "passed",
        }

    def console_publish_journal(self) -> dict[str, Any]:
        expected_definitions = {
            "audit_events_console_publish_head_037_idx": (
                "CREATE INDEX audit_events_console_publish_head_037_idx ON public.audit_events "
                "USING btree (tenant_id, actor_alias, ((metadata ->> "
                "'operator_scope_hash'::text)), ((metadata ->> 'conversation_hash'::text)), "
                "id DESC) WHERE (action = 'console.publish.head'::text)"
            ),
            "audit_events_console_publish_key_037_idx": (
                "CREATE INDEX audit_events_console_publish_key_037_idx ON public.audit_events "
                "USING btree (tenant_id, actor_alias, ((metadata ->> "
                "'idempotency_key'::text)), id) WHERE (action = ANY "
                "(ARRAY['console.publish.prepare'::text, 'console.publish.confirm'::text, "
                "'console.publish.expire'::text]))"
            ),
            "audit_events_console_publish_nonce_037_idx": (
                "CREATE INDEX audit_events_console_publish_nonce_037_idx ON public.audit_events "
                "USING btree (tenant_id, actor_alias, ((metadata ->> "
                "'operator_scope_hash'::text)), ((metadata ->> 'intent_nonce_hash'::text)), "
                "id DESC) WHERE (action = 'console.publish.prepare'::text)"
            ),
            "audit_events_console_publish_rate_037_idx": (
                "CREATE INDEX audit_events_console_publish_rate_037_idx ON public.audit_events "
                "USING btree (tenant_id, actor_alias, ((metadata ->> "
                "'operator_scope_hash'::text)), created_at DESC, id DESC) "
                "WHERE (action = 'console.publish.prepare'::text)"
            ),
        }
        index_names = sorted(expected_definitions)
        names_sql = ",".join(f"'{name}'" for name in index_names)
        output = self.psql(
            f"""
WITH selected AS (
  SELECT index_class.relname AS name,
         pg_get_indexdef(index_record.indexrelid) AS definition,
         index_record.indisvalid AND index_record.indisready
           AND NOT index_record.indisunique AND NOT index_record.indisexclusion AS usable
    FROM pg_index index_record
    JOIN pg_class index_class ON index_class.oid=index_record.indexrelid
    JOIN pg_class table_class ON table_class.oid=index_record.indrelid
    JOIN pg_namespace namespace_record ON namespace_record.oid=index_class.relnamespace
    JOIN pg_am access_method ON access_method.oid=index_class.relam
   WHERE namespace_record.nspname='public'
     AND table_class.relname='audit_events'
     AND access_method.amname='btree'
     AND index_class.relname IN ({names_sql})
), unexpected AS (
  SELECT count(*) AS count
    FROM pg_class index_class
    JOIN pg_namespace namespace_record ON namespace_record.oid=index_class.relnamespace
   WHERE namespace_record.nspname='public'
     AND index_class.relname LIKE 'audit_events_console_publish%037_idx'
     AND index_class.relname NOT IN ({names_sql})
)
SELECT jsonb_build_object(
  'migration','037_console_publish_intent_indexes.sql',
  'migrationApplied',EXISTS(
    SELECT 1 FROM schema_migrations
     WHERE version='037_console_publish_intent_indexes.sql'
  ),
  'table','audit_events',
  'indexes',to_jsonb(ARRAY(SELECT name FROM selected ORDER BY name)),
  'indexCount',(SELECT count(*) FROM selected),
  'unexpectedIndexCount',(SELECT count FROM unexpected),
  'allIndexesUsable',coalesce((SELECT bool_and(usable) FROM selected),false),
  'definitions',coalesce((
    SELECT jsonb_object_agg(name,definition ORDER BY name) FROM selected
  ),'{{}}'::jsonb)
)::text;
""",
            "verify schema-037 console publish journal index shape",
            capture=True,
        )
        try:
            value = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("schema-037 publish journal probe returned invalid JSON") from error
        if value != {
            "migration": CONSOLE_PUBLISH_INTENT_SCHEMA,
            "migrationApplied": True,
            "table": "audit_events",
            "indexes": index_names,
            "indexCount": 4,
            "unexpectedIndexCount": 0,
            "allIndexesUsable": True,
            "definitions": expected_definitions,
        }:
            raise ProductionError("schema-037 publish journal indexes are not exact")

        plan_probes = {
            "keyLookupPlan": (
                "console_key_037(text,text,text)",
                "SELECT action,metadata FROM audit_events "
                "WHERE tenant_id=$1 AND actor_alias=$2 "
                "AND metadata->>'idempotency_key'=$3 "
                "AND action IN ('console.publish.prepare','console.publish.confirm',"
                "'console.publish.expire') ORDER BY id LIMIT 4",
                "'Steven','kant','console:bridge-probe'",
                "audit_events_console_publish_key_037_idx",
            ),
            "nonceLookupPlan": (
                "console_nonce_037(text,text,text,text)",
                "SELECT metadata FROM audit_events "
                "WHERE tenant_id=$1 AND actor_alias=$2 "
                "AND action='console.publish.prepare' "
                "AND metadata->>'operator_scope_hash'=$3 "
                "AND metadata->>'intent_nonce_hash'=$4 ORDER BY id DESC LIMIT 2",
                f"'Steven','kant','{'a' * 64}','{'b' * 64}'",
                "audit_events_console_publish_nonce_037_idx",
            ),
            "rateLimitPlan": (
                "console_rate_037(text,text,text,integer,integer)",
                "WITH recent AS MATERIALIZED (SELECT created_at FROM audit_events "
                "WHERE tenant_id=$1 AND actor_alias=$2 "
                "AND action='console.publish.prepare' "
                "AND metadata->>'operator_scope_hash'=$3 "
                "AND created_at>now()-interval '24 hours' "
                "ORDER BY created_at DESC,id DESC LIMIT $5) "
                "SELECT created_at FROM recent "
                "WHERE created_at>now()-interval '10 minutes' OFFSET $4 LIMIT 1",
                f"'Steven','kant','{'a' * 64}',119,2000",
                "audit_events_console_publish_rate_037_idx",
            ),
            "headLookupPlan": (
                "console_head_037(text,text,text,text)",
                "SELECT metadata FROM audit_events "
                "WHERE tenant_id=$1 AND actor_alias=$2 "
                "AND action='console.publish.head' "
                "AND metadata->>'operator_scope_hash'=$3 "
                "AND metadata->>'conversation_hash'=$4 ORDER BY id DESC LIMIT 2",
                f"'Steven','kant','{'a' * 64}','{'c' * 64}'",
                "audit_events_console_publish_head_037_idx",
            ),
        }
        result = {
            key: "passed"
            for key, (signature, statement, parameters, expected_index) in plan_probes.items()
            if expected_index.encode("ascii") in self.psql(
                "BEGIN; SET LOCAL enable_seqscan=off; "
                "SET LOCAL plan_cache_mode='force_generic_plan'; "
                f"PREPARE {signature} AS {statement}; "
                f"EXPLAIN (COSTS OFF) EXECUTE {signature.split('(', 1)[0]}({parameters}); "
                "ROLLBACK;",
                f"verify schema-037 {key}",
                capture=True,
            )
        }
        if set(result) != set(plan_probes):
            raise ProductionError("schema-037 publish journal lookup plan is not index-backed")
        return {
            "migration": CONSOLE_PUBLISH_INTENT_SCHEMA,
            "migrationApplied": True,
            "table": "audit_events",
            "indexes": index_names,
            "indexCount": 4,
            "unexpectedIndexCount": 0,
            "allIndexesUsable": True,
            "indexDefinitionsExact": True,
            **result,
        }

    def model_free_roundtrip(self) -> None:
        self.psql(ROUNDTRIP_SQL, "candidate model-free publish-claim-ack")

    def assert_only_postgres_running(self, phase: str) -> None:
        output = run_checked([
            "docker", "ps", "--filter", f"label=com.docker.compose.project={self.project}",
            "--format", '{{.Label "com.docker.compose.service"}}',
        ], phase=phase, capture=True).stdout.decode("utf-8", "strict")
        services = sorted(filter(None, (line.strip() for line in output.splitlines())))
        if services != ["postgres"]:
            raise ProductionError(f"{phase} found an undrained project writer")

    def assert_running_service_image(self, service: str, phase: str) -> None:
        if service not in self.image_ids:
            raise ProductionError(f"{phase} requested an invalid service")
        container_id = self.command(
            "ps", "-q", service, phase=f"{phase} container identity", capture=True,
        ).stdout.decode("ascii").strip()
        if not container_id or "\n" in container_id:
            raise ProductionError(f"{phase} container identity is ambiguous")
        running_id = run_checked(
            ["docker", "inspect", "--format", "{{.Image}}", container_id],
            phase=f"{phase} running image identity", capture=True,
        ).stdout.decode("ascii").strip()
        if running_id != self.image_ids[service]:
            raise ProductionError(f"{phase} executed another image ID")

    def rollback_compensation(self, *, candidate_id: str, bridge_id: str) -> dict[str, Any]:
        transition_root = self.scratch / "rollback-transaction"
        transition_root.mkdir(mode=0o700)
        environment = self.environment.copy()
        environment.update({
            "CAUCE_ROLLBACK_EVIDENCE_MODE": "isolated-compose-v1",
            "CAUCE_ROLLBACK_EVIDENCE_ROOT": os.fspath(transition_root),
            "CAUCE_ROLLBACK_EVIDENCE_PROJECT": self.project,
            "CAUCE_ROLLBACK_EVIDENCE_COMPOSE_FILE": os.fspath(COMPOSE_FILE),
            "CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_IMAGE": self.candidate_image,
            "CAUCE_ROLLBACK_EVIDENCE_BRIDGE_IMAGE": self.bridge_image,
            "CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_ID": candidate_id,
            "CAUCE_ROLLBACK_EVIDENCE_BRIDGE_ID": bridge_id,
        })
        output = run_checked(
            [os.fspath(OPS / "scripts" / "rollback.sh"), "evidence-cycle"],
            phase="shared rollback transaction compensation", environment=environment, capture=True,
        ).stdout
        try:
            result = json.loads(output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductionError("shared rollback transaction returned invalid evidence") from error
        expected = {
            "rollbackAction": "rollback-sh-shared-transaction",
            "failureInjection": "postgres-unavailable-after-selector-swap",
            "failureObserved": True,
            "lostForwardCasResponseRecovered": True,
            "selectorCasRestored": True,
            "candidateImageRestored": True,
            "composeRecreateObserved": True,
            "servicesRestored": True,
            "transitionLockScope": "selector-deploy-health-compensation",
            "status": "passed",
        }
        if result != expected:
            raise ProductionError("shared rollback transaction observations are incomplete")
        return result

    def cleanup(self) -> None:
        run_checked(
            [*self.base, "down", "--volumes", "--remove-orphans", "--timeout", "10"],
            phase="remove isolated rollback project", environment=self.environment,
        )
        for kind, command in (
            ("containers", ["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={self.project}", "--format", "{{.ID}}"]),
            ("volumes", ["docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={self.project}", "--format", "{{.Name}}"]),
            ("networks", ["docker", "network", "ls", "--filter", f"label=com.docker.compose.project={self.project}", "--format", "{{.ID}}"]),
        ):
            residue = run_checked(
                command, phase=f"verify isolated rollback {kind} cleanup", capture=True,
            ).stdout.decode("utf-8", "strict").strip()
            if residue:
                raise ProductionError(f"isolated rollback cleanup left project {kind}")


def invariant_snapshots(snapshots: list[dict[str, Any]]) -> None:
    for field in ("migrationLedgerSha256", "reconciliationSha256", "profileContentSha256",
                  "profileRevisionSha256", "profileRuntimeSha256", "shadowTargetPhaseSha256",
                  "leasesSha256", "authSessionSha256",
                  "publishJournalSha256", "fullDatabaseStateSha256", "rowCounts"):
        serialized = {json.dumps(snapshot[field], sort_keys=True) for snapshot in snapshots}
        if len(serialized) != 1:
            raise ProductionError(f"rollback lifecycle changed canonical {field}")


def build_report(arguments: argparse.Namespace) -> tuple[dict[str, Any], str]:
    validate_compose_source()
    pull_enabled = pull_mode()
    require_image(arguments.candidate_image, "candidate image")
    require_image(arguments.postgres_image, "PostgreSQL image")
    require_repository(arguments.bridge_repository, "bridge repository")
    require_git_object(arguments.patch_source_commit, "patch source commit")
    for value, label in (
        (arguments.expected_backup_sha256, "expected backup SHA-256"),
        (arguments.expected_restore_evidence_sha256, "expected restore evidence SHA-256"),
        (arguments.expected_candidate_build_evidence_sha256, "expected candidate build evidence SHA-256"),
    ):
        require_digest(value, label)

    patch_commit, patch_source_tree = verify_clean_source(arguments.patch_source_commit)
    backup_digest = private_digest(arguments.backup, "backup")
    if backup_digest != arguments.expected_backup_sha256:
        raise ProductionError("backup SHA-256 differs from the authorized input")
    restore_evidence, restore_content = private_json(arguments.restore_evidence, "restore evidence")
    restore_digest = sha256_bytes(restore_content)
    if restore_digest != arguments.expected_restore_evidence_sha256:
        raise ProductionError("restore evidence SHA-256 differs from the authorized input")
    restore_identity = verify_restore_input(
        arguments.backup, backup_digest, restore_evidence, restore_digest,
    )
    restore_postgres_id = restore_identity["postgresImageId"]
    candidate_evidence, candidate_content = private_json(arguments.candidate_build_evidence, "candidate build evidence")
    candidate_evidence_digest = sha256_bytes(candidate_content)
    if candidate_evidence_digest != arguments.expected_candidate_build_evidence_sha256:
        raise ProductionError("candidate build evidence SHA-256 differs from the authorized input")
    candidate = verify_candidate_evidence(
        candidate_evidence, expected_image=arguments.candidate_image, expected_commit=arguments.patch_source_commit,
    )
    if candidate["sourceTree"] != patch_source_tree:
        raise ProductionError("candidate build evidence tree differs from the authorized candidate commit")

    metadata = read_bridge_metadata()
    patch_path = metadata.get("patchPath")
    if not isinstance(patch_path, str):
        raise ProductionError("rollback bridge metadata patch path is invalid")
    patch = run_checked(
        ["git", "-C", os.fspath(ROOT), "show", f"{patch_commit}:{patch_path}"],
        phase="resolve versioned rollback patch", capture=True,
    ).stdout
    patch_digest = sha256_bytes(patch)
    if patch_digest != metadata.get("patchSetSha256"):
        raise ProductionError("versioned rollback patch differs from bridge metadata")
    publication = metadata.get("imagePublication")
    if not isinstance(publication, dict):
        raise ProductionError("rollback bridge metadata lacks immutable base-image policy")
    node_base = publication.get("pinnedNodeBaseRepositoryDigest")
    if not isinstance(node_base, str):
        raise ProductionError("rollback bridge metadata lacks its pinned Node base")
    require_image(node_base, "rollback bridge Node base")
    python_base = publication.get("pinnedPythonBaseRepositoryDigest")
    if not isinstance(python_base, str):
        raise ProductionError("rollback bridge metadata lacks its pinned Python base")
    require_image(python_base, "rollback bridge Python base")
    if node_base == python_base:
        raise ProductionError("rollback bridge Node and Python bases must be role-distinct")
    if publication.get("targetPlatform") != TARGET_PLATFORM:
        raise ProductionError("rollback bridge metadata target platform is not linux/amd64")
    accepted_media_types = publication.get("acceptedManifestMediaTypes")
    if accepted_media_types != list(CHILD_MANIFEST_MEDIA_TYPES):
        raise ProductionError("rollback bridge metadata child-manifest policy is invalid")

    run_checked(["docker", "compose", "version"], phase="Docker Compose v2 prerequisite")
    run_checked(["docker", "build", "--help"], phase="Docker build prerequisite")
    candidate_identity = verify_recovered_image(
        arguments.candidate_image, candidate["imageId"], "candidate image",
        pull_enabled=pull_enabled, expected_labels=candidate["expectedLabels"],
    )
    for field in ("manifestDigest", "mediaType", "platform"):
        if candidate_identity[field] != candidate[field]:
            raise ProductionError("candidate registry identity differs from its build evidence")
    postgres_identity = verify_recovered_image(
        arguments.postgres_image, restore_postgres_id, "PostgreSQL image", pull_enabled=pull_enabled,
    )
    node_identity = verify_recovered_image(
        node_base, None, "rollback bridge Node base", pull_enabled=pull_enabled,
    )
    node_identity["role"] = "node"
    python_identity = verify_recovered_image(
        python_base, None, "rollback bridge Python base", pull_enabled=pull_enabled,
    )
    python_identity["role"] = "python"
    if (node_identity["manifestDigest"] == python_identity["manifestDigest"]
            or node_identity["imageId"] == python_identity["imageId"]):
        raise ProductionError("rollback bridge base manifests and image IDs must be role-distinct")

    with tempfile.TemporaryDirectory(prefix="cauce-rollback-bridge-") as scratch_name:
        scratch = pathlib.Path(scratch_name)
        archive = scratch / "bridge.tar"
        context = scratch / "source"
        context.mkdir(mode=0o700)
        run_checked([os.fspath(BRIDGE_TEST)], phase="rollback bridge source verification")
        run_checked([os.fspath(BRIDGE_BUILD), os.fspath(archive)], phase="rollback bridge source reconstruction")
        safe_extract(archive, context)
        bridge_tree = metadata.get("resultingBridgeTree")
        if not isinstance(bridge_tree, str):
            raise ProductionError("rollback bridge metadata tree is invalid")
        require_git_object(bridge_tree, "resulting bridge tree")
        if git_tree_for_directory(context) != bridge_tree:
            raise ProductionError("extracted rollback bridge context differs from its resulting Git tree")
        verify_bridge_migration_payload(context, metadata)
        source_digest = run_checked(
            [sys.executable, os.fspath(context / "ops" / "scripts" / "source-digest.py"),
             "--root", os.fspath(context), "--domain", "runtime"],
            phase="bridge runtime source digest", capture=True,
        ).stdout.decode("ascii").strip()
        require_digest(source_digest, "bridge runtime source digest")
        bridge_tag = f"{arguments.bridge_repository}:schema037-{bridge_tree}-{patch_commit}"
        build_environment = canonical_child_environment({"DOCKER_BUILDKIT": "0"})
        expected_bridge_labels = {
            "io.cauce.schema.compatible-through": TARGET_SCHEMA,
            "io.cauce.source.digest": source_digest,
            "io.cauce.source.runtime": source_digest,
            "io.cauce.rollback-bridge.tree": bridge_tree,
            "io.cauce.rollback-bridge.patch-sha256": patch_digest,
            "io.cauce.rollback-bridge.patch-source-commit": patch_commit,
            "io.cauce.rollback-bridge.read-only": "server-v2",
            "io.cauce.base.node.repository-digest": node_base,
            "io.cauce.base.python.repository-digest": python_base,
            "io.cauce.target-platform": TARGET_PLATFORM,
            "org.opencontainers.image.base.name": node_base,
        }
        build_command = bridge_build_command(
            context=context, tag=bridge_tag, node_base=node_base, python_base=python_base,
            source_digest=source_digest, bridge_tree=bridge_tree, patch_digest=patch_digest,
            patch_commit=patch_commit, pull_enabled=pull_enabled,
        )
        run_checked(build_command, phase="build exact rollback bridge image", environment=build_environment)
        run_checked(
            ["docker", "run", "--rm", "--network", "none", "--platform", TARGET_PLATFORM,
             "--entrypoint", "node", bridge_tag,
             "deploy/runtime-package-smoke.mjs"],
            phase="bridge final image package smoke",
        )
        run_checked(
            ["docker", "run", "--rm", "--network", "none", "--platform", TARGET_PLATFORM,
             "--entrypoint", "node", bridge_tag, "--check", "deploy/fleet-snapshot.mjs"],
            phase="bridge final image fleet snapshot syntax",
        )
        run_checked(
            ["docker", "run", "--rm", "--network", "none", "--platform", TARGET_PLATFORM,
             "--entrypoint", "python3", bridge_tag, "-c",
             "import asyncio, json; assert asyncio and json"],
            phase="bridge final image Python runtime smoke",
        )
        bridge_id = verify_local_runtime(
            bridge_tag, "bridge local image", expected_labels=expected_bridge_labels,
        )
        run_checked(["docker", "push", bridge_tag], phase="push rollback bridge image")
        bridge_image = one_repository_digest(bridge_tag, arguments.bridge_repository)
        bridge_identity = verify_recovered_image(
            bridge_image, bridge_id, "bridge image", pull_enabled=pull_enabled,
            expected_labels=expected_bridge_labels,
        )

        isolated_backup = scratch / "authorized-backup.dump"
        private_copy(arguments.backup, isolated_backup, "backup", backup_digest)

        cycle = IsolatedCycle(
            scratch=scratch, candidate_image=arguments.candidate_image, bridge_image=bridge_image,
            postgres_image=arguments.postgres_image, backup=isolated_backup,
            candidate_image_id=candidate_identity["imageId"], bridge_image_id=bridge_identity["imageId"],
            postgres_image_id=postgres_identity["imageId"],
        )
        snapshots: list[dict[str, Any]] = []
        compensation: dict[str, Any]
        try:
            cycle.resolve(arguments.candidate_image, bridge_image, arguments.postgres_image)
            cycle.start_and_restore()
            cycle.integrity("candidate", "pre")
            cycle.migrate("candidate", f"candidate migration through {TARGET_SCHEMA}")
            cycle.integrity("candidate", "post")
            latest = cycle.psql(
                "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
                f"verify {TARGET_SCHEMA}", capture=True,
            ).decode().strip()
            if latest != TARGET_SCHEMA:
                raise ProductionError(f"candidate migration did not reach exact {TARGET_SCHEMA}")
            fleet = cycle.fleet()
            connection_fencing = cycle.connection_fencing()
            terminal_claim_fencing = cycle.terminal_claim_fencing()
            browser_owner_fencing = cycle.browser_owner_fencing()
            relay_instance_fencing = cycle.relay_instance_fencing()
            profile_runtime_adoption = cycle.profile_runtime_adoption()
            shadow_target_phase = cycle.shadow_target_phase()
            console_publish_journal = cycle.console_publish_journal()
            snapshots.append(cycle.attested_snapshot(
                "candidate-after-migrate-037", "candidate", candidate_identity, postgres_identity,
                "probe-containers-attested-and-drained",
            ))

            cycle.assert_only_postgres_running("candidate-to-bridge writer drain")
            cycle.migrate("bridge", "bridge no-op migrator")
            cycle.health("bridge", "bridge")
            cycle.http_read_only_probe()
            snapshots.append(cycle.attested_snapshot(
                "bridge-after-noop-migrator-and-tests", "bridge", bridge_identity, postgres_identity,
                "probe-containers-attested-and-drained",
            ))

            cycle.assert_only_postgres_running("bridge-to-candidate writer drain")
            cycle.migrate("candidate", "candidate return no-op migrator")
            cycle.health("candidate", "candidate return")
            cycle.model_free_roundtrip()
            snapshots.append(cycle.attested_snapshot(
                "candidate-after-return-noop-migrator-and-model-free-ack",
                "candidate", candidate_identity, postgres_identity,
                "probe-containers-attested-and-drained",
            ))

            cycle.assert_only_postgres_running("pre-compensation writer drain")
            snapshots.append(cycle.attested_snapshot(
                "candidate-before-injected-rollback-failure",
                "candidate", candidate_identity, postgres_identity,
                "writers-drained-image-selected",
            ))
            compensation = cycle.rollback_compensation(
                candidate_id=candidate["imageId"], bridge_id=bridge_id,
            )
            cycle.assert_running_service_image("candidate", "post-compensation candidate")
            snapshots.append(cycle.attested_snapshot(
                "candidate-after-rollback-compensation",
                "candidate", candidate_identity, postgres_identity,
                "compensated-running-container-attested",
            ))
            if cycle.connection_fencing() != connection_fencing:
                raise ProductionError("rollback lifecycle changed schema-031 connection fencing")
            if cycle.terminal_claim_fencing() != terminal_claim_fencing:
                raise ProductionError("rollback lifecycle changed schema-032 terminal claim fencing")
            if cycle.browser_owner_fencing() != browser_owner_fencing:
                raise ProductionError("rollback lifecycle changed schema-033 browser owner fencing")
            if cycle.relay_instance_fencing() != relay_instance_fencing:
                raise ProductionError("rollback lifecycle changed schema-034 relay instance fencing")
            if cycle.profile_runtime_adoption() != profile_runtime_adoption:
                raise ProductionError("rollback lifecycle changed schema-035 profile runtime adoption")
            if cycle.shadow_target_phase() != shadow_target_phase:
                raise ProductionError("rollback lifecycle changed schema-036 shadow target phase")
            if cycle.console_publish_journal() != console_publish_journal:
                raise ProductionError("rollback lifecycle changed schema-037 publish journal indexes")
        finally:
            cycle.cleanup()
        invariant_snapshots(snapshots)
        database_digests_unchanged = all(
            len({json.dumps(snapshot[field], sort_keys=True) for snapshot in snapshots}) == 1
            for field in (
                "migrationLedgerSha256", "reconciliationSha256", "profileContentSha256",
                "profileRevisionSha256", "profileRuntimeSha256", "shadowTargetPhaseSha256",
                "leasesSha256", "authSessionSha256",
                "publishJournalSha256", "fullDatabaseStateSha256", "rowCounts",
            )
        )
        if not database_digests_unchanged:
            raise ProductionError("shared rollback compensation changed canonical database state")

        final_commit, final_tree = verify_clean_source(patch_commit)
        if (final_commit, final_tree) != (patch_commit, patch_source_tree):
            raise ProductionError("repository source changed during rollback bridge production")
        operations_digest = run_checked(
            [sys.executable, os.fspath(OPS / "scripts" / "container_ops_digest.py")],
            phase="rollback operations digest", capture=True,
        ).stdout.decode("ascii").strip()
        require_digest(operations_digest, "rollback operations digest")
        dockerfile_digest = sha256_bytes((context / "deploy" / "Dockerfile").read_bytes())
        compose_digest = sha256_bytes(COMPOSE_FILE.read_bytes())
        finished = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        restore_verified_at = dt.datetime.fromisoformat(restore_identity["verifiedAt"].replace("Z", "+00:00"))
        if restore_verified_at > finished + dt.timedelta(seconds=RESTORE_MAX_FUTURE_SKEW_SECONDS):
            raise ProductionError("restore evidence moved beyond clock-skew policy during bridge production")
        if finished - restore_verified_at > dt.timedelta(hours=RESTORE_MAX_AGE_HOURS):
            raise ProductionError("restore evidence became stale during bridge production")
        valid_until = finished + dt.timedelta(hours=arguments.valid_hours)
        def passed_test(name: str, mechanism: str) -> dict[str, object]:
            return {"name": name, "mechanism": mechanism, "status": "passed", "critical": True}
        report: dict[str, Any] = {
            "schemaVersion": EVIDENCE_SCHEMA_VERSION,
            "suite": "cauce-v3-rollback-bridge",
            "evidenceClass": "rollback-bridge",
            "mechanism": "isolated-restored-production-backup-runtime-image-cycle",
            "generatedAt": finished.isoformat().replace("+00:00", "Z"),
            "validUntil": valid_until.isoformat().replace("+00:00", "Z"),
            "sourceDigest": source_digest,
            "sourceDigestDomain": "runtime",
            "operationsDigest": operations_digest,
            "dockerfileSha256": dockerfile_digest,
            "composeFileSha256": compose_digest,
            "sourceRevision": {
                "originBaseCommit": metadata["originBaseCommit"],
                "patchSourceCommit": patch_commit,
                "patchPath": patch_path,
                "patchSetSha256": patch_digest,
                "resultingBridgeTree": bridge_tree,
                "worktreeStatus": "clean",
                "buildContext": "git-archive",
            },
            "runtime": {
                "bridgeKind": BRIDGE_KIND,
                **bridge_identity,
                "sourceDigest": source_digest,
                "sourceDigestDomain": "runtime",
                "baseImages": {"node": node_identity, "python": python_identity},
            },
            "candidateRuntime": {
                **candidate_identity,
                "sourceDigest": candidate["sourceDigest"],
                "sourceDigestDomain": "runtime",
                "sourceCommit": candidate["sourceCommit"],
                "sourceTree": candidate["sourceTree"],
                "buildEvidenceSha256": candidate_evidence_digest,
            },
            "database": {
                "restoreEvidenceSha256": restore_digest,
                "restoreEvidenceVerifiedAt": restore_identity["verifiedAt"],
                "restoreEvidenceMaxAgeHours": RESTORE_MAX_AGE_HOURS,
                "restoreEvidenceMaxFutureSkewSeconds": RESTORE_MAX_FUTURE_SKEW_SECONDS,
                "restoredBackupSha256": backup_digest,
                "postgresRepositoryDigest": arguments.postgres_image,
                "postgresImageId": restore_postgres_id,
                "postgresManifestDigest": postgres_identity["manifestDigest"],
                "postgresMediaType": postgres_identity["mediaType"],
                "postgresPlatform": postgres_identity["platform"],
                "postgresMajor": 16,
                "schemaLatest": TARGET_SCHEMA,
                "connectionFencing": connection_fencing,
                "terminalClaimFencing": terminal_claim_fencing,
                "browserOwnerFencing": browser_owner_fencing,
                "relayInstanceFencing": relay_instance_fencing,
                "profileRuntimeAdoption": profile_runtime_adoption,
                "shadowTargetPhase": shadow_target_phase,
                "consolePublishJournal": console_publish_journal,
                "isolated": True,
                "network": "private-test-network",
                "egress": "disabled",
                "productionConnected": False,
                "snapshots": snapshots,
            },
            "imageVerification": {
                "targetPlatform": TARGET_PLATFORM,
                "acceptedManifestMediaTypes": list(CHILD_MANIFEST_MEDIA_TYPES),
                "pullPolicy": (
                    "pull-exact-child-manifests" if pull_enabled else "no-pull-local-images-required"
                ),
                "registryPullPerformed": pull_enabled,
                "explicitRegistryPullCount": 5 if pull_enabled else 0,
                "composePullPolicy": "never-after-preflight",
                "stageAttestationCount": len(snapshots),
                "containerImageIdAttested": True,
                "stageAttestationMechanism": "compose-container-id-and-repodigest-reinspect",
            },
            "topology": {
                "composeFileSha256": compose_digest,
                "services": ["postgres", "candidate", "bridge"],
                "internalNetworkOnly": True,
                "publishedPorts": 0,
                "backupReadOnly": True,
                "productionCredentialsAccepted": False,
                "externalComponentsStarted": False,
            },
            "digestContract": DIGEST_CONTRACT,
            "fleet": fleet,
            "lifecycle": {
                "candidateInitial": {
                    "preMigrationIntegrity": "passed", "migratedThrough": TARGET_SCHEMA,
                    "postMigrationIntegrity": "passed",
                },
                "bridge": {
                    "allWritersDrained": True, "migratorResult": "no-op", "centralServicesOnly": True,
                    "serverSideReadOnly": True, "readOnlyCapability": "server-v2",
                    "mutationContract": "deny-all-data-api-with-operational-health-allowlist-and-oidc-get-head-denied-503",
                    "disabledExternalComponents": [
                        "adapters", "models", "telegram", "terminal-clients",
                    ],
                    "health": "passed",
                },
                "candidateReturn": {
                    "bridgeDrained": True, "migratorResult": "no-op", "health": "passed",
                    "modelFreeRoundtrip": "publish-claim-ack", "status": "passed",
                },
                "compensation": {
                    **compensation,
                    "databaseDigestsUnchanged": database_digests_unchanged,
                    "productionRollbackDependency": False,
                },
            },
            "shims": [
                "profile-role-writes-frozen", "unrelated-agent-update-omits-role-brief",
                "system-principals-filtered", "gate-probe-explicitly-rejected",
                "server-side-read-only-mutation-gate", "oidc-auth-reads-denied",
            ],
            "tests": [
                passed_test("profile-role-writes-frozen", "source-tree-and-runtime-image-bound-test"),
                passed_test("unrelated-agent-update-preserves-role", "source-tree-and-runtime-image-bound-test"),
                passed_test("system-principals-filtered", "source-tree-and-runtime-image-bound-test"),
                passed_test("gate-probe-explicitly-rejected", "source-tree-and-runtime-image-bound-test"),
                passed_test("oidc-auth-reads-denied", "exact-bridge-image-real-routes-and-full-database-digest"),
                passed_test("basic-read-delivery-compatible", "runtime-package-and-database-health"),
                passed_test("schema029-fleet-exact", "database-exact-set"),
                passed_test("agent-notify-role-exact", "application-role-policy"),
                passed_test("migration-ledger-and-reconciliation-noop", "canonical-state-digest"),
                passed_test("connection-leases-preserved", "canonical-state-digest"),
                passed_test("schema031-connection-fencing-exact", "database-column-and-token-set"),
                passed_test(
                    "schema032-terminal-claim-fencing-exact",
                    "database-shape-drain-and-transactional-cas",
                ),
                passed_test(
                    "schema033-browser-owner-fencing-exact",
                    "database-request-recovery-owner-cas-and-stale-delete",
                ),
                passed_test(
                    "schema034-relay-instance-fencing-exact",
                    "database-shape-drain-pinned-instance-and-boot-cas",
                ),
                passed_test(
                    "schema035-profile-runtime-adoption-exact",
                    "database-shape-trigger-exact-adoption-and-rollback",
                ),
                passed_test(
                    "schema036-shadow-target-phase-exact",
                    "database-shape-trigger-eager-rejection-crash-replay-race-reconciliation-and-rollback",
                ),
                passed_test(
                    "schema037-console-publish-journal-exact",
                    "four-index-shape-predicates-and-generic-plan-key-nonce-rate-head",
                ),
                passed_test("candidate-return-model-free-roundtrip", "publish-claim-ack"),
                passed_test(
                    "rollback-health-failure-compensates",
                    "rollback-sh-shared-transaction-postgres-outage",
                ),
            ],
            "summary": {"tests": 19, "passed": 19, "failed": 0, "skipped": 0, "criticalSkipped": 0},
        }
        validate_schema(report, SCHEMA_FILE, "rollback bridge evidence")
        preview = scratch / "rollback-bridge.preview.json"
        preview_payload = canonical_json(report)
        preview_digest = atomic_publish(preview, preview_payload)
        validator_command = [
            sys.executable, os.fspath(OPS / "scripts" / "validate-rollback-bridge-evidence.py"),
            "--evidence", os.fspath(preview),
            "--expected-evidence-sha256", preview_digest,
            "--expected-repository-digest", bridge_image,
            "--expected-image-id", bridge_id,
            "--expected-candidate-repository-digest", arguments.candidate_image,
            "--expected-candidate-image-id", candidate["imageId"],
            "--expected-candidate-source-digest", candidate["sourceDigest"],
            "--max-age-hours", str(arguments.valid_hours),
        ]
        if not pull_enabled:
            validator_command.append("--allow-no-pull-diagnostic")
        run_checked(validator_command, phase="independent rollback bridge evidence validator")
        return report, bridge_image


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--output", required=True, type=pathlib.Path,
                       help="absolute new evidence path; a .sha256 sibling is also created")
    value.add_argument("--backup", required=True, type=pathlib.Path,
                       help="absolute owned single-link mode-0600 pg_dump custom archive")
    value.add_argument("--expected-backup-sha256", required=True)
    value.add_argument("--restore-evidence", required=True, type=pathlib.Path,
                       help="absolute owned single-link mode-0600 host-backup restore evidence")
    value.add_argument("--expected-restore-evidence-sha256", required=True)
    value.add_argument("--candidate-build-evidence", required=True, type=pathlib.Path,
                       help="absolute owned single-link mode-0600 schema-v6 release build evidence")
    value.add_argument("--expected-candidate-build-evidence-sha256", required=True)
    value.add_argument("--candidate-image", required=True,
                       help="candidate runtime repository@sha256 digest")
    value.add_argument("--bridge-repository", required=True,
                       help="registry repository used to publish the reconstructed bridge")
    value.add_argument("--postgres-image", required=True,
                       help="exact PostgreSQL 16 repository@sha256 digest used by restore evidence")
    value.add_argument("--patch-source-commit", required=True,
                       help="full clean HEAD commit containing the versioned bridge and this producer")
    value.add_argument("--valid-hours", type=int, default=168)
    return value


def main(argv: list[str]) -> int:
    arguments = parser().parse_args(argv)
    if arguments.valid_hours < 1 or arguments.valid_hours > 168:
        print("rollback bridge production failed: valid-hours must be between 1 and 168", file=sys.stderr)
        return 2
    try:
        report, bridge_image = build_report(arguments)
        payload = canonical_json(report)
        digest = atomic_publish(arguments.output, payload)
    except (OSError, ProductionError, subprocess.SubprocessError) as error:
        print(f"rollback bridge production failed: {error}", file=sys.stderr)
        return 1
    print(f"rollback bridge evidence produced: sha256={digest} bridge={bridge_image}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
