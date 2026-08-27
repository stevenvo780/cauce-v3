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
TARGET_PLATFORM = {"os": "linux", "architecture": "amd64"}
TARGET_PLATFORM_NAME = "linux/amd64"
TARGET_SCHEMA = "037_console_publish_intent_indexes.sql"
CONNECTION_FENCING_SCHEMA = "031_connection_session_fencing.sql"
TERMINAL_CLAIM_FENCING_SCHEMA = "032_terminal_session_claim_fencing.sql"
BROWSER_OWNER_FENCING_SCHEMA = "033_terminal_browser_owner_fencing.sql"
RELAY_INSTANCE_FENCING_SCHEMA = "034_terminal_relay_instance_fencing.sql"
PROFILE_RUNTIME_ADOPTION_SCHEMA = "035_agent_profile_runtime_adoption.sql"
SHADOW_TARGET_PHASE_SCHEMA = "036_shadow_router_target_phase.sql"
CONSOLE_PUBLISH_INTENT_SCHEMA = "037_console_publish_intent_indexes.sql"
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


class BridgeError(ValueError):
    pass


def private_file(path: pathlib.Path, label: str = "evidence") -> bytes:
    if not path.is_absolute():
        raise BridgeError(f"{label} path must be absolute")
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid not in {0, os.geteuid()}):
        raise BridgeError(f"{label} must be an owned single-link mode-0600 regular file")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise BridgeError(f"{label} changed before it was opened")
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
            raise BridgeError(f"{label} changed while it was read")
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


def verify_sha_sidecar(evidence_path: pathlib.Path, expected_sha256: str) -> None:
    sidecar = pathlib.Path(os.fspath(evidence_path) + ".sha256")
    content = private_file(sidecar, "evidence SHA sidecar")
    if content != f"{expected_sha256}\n".encode("ascii"):
        raise BridgeError("evidence SHA sidecar differs from the authorized rollback record")


def verify_source_revision(report: dict) -> str:
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
    try:
        dockerfile = subprocess.run(
            ["git", "-C", str(ROOT), "show", f"{resulting_tree}:deploy/Dockerfile"],
            check=True, capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise BridgeError("rollback bridge Dockerfile cannot be resolved from the reproduced tree") from error
    dockerfile_sha256 = f"sha256:{hashlib.sha256(dockerfile).hexdigest()}"
    if report.get("dockerfileSha256") != dockerfile_sha256:
        raise BridgeError("rollback bridge Dockerfile differs from the reproduced provenance tree")
    return resulting_tree


def verify_bridge_migration_payload(tree: str, metadata: dict) -> None:
    contract = metadata.get("schemaContract")
    if not isinstance(contract, dict):
        raise BridgeError("versioned rollback bridge migration contract is unavailable")
    for key, directory, required in (
        ("candidateMigrationInputs", "packages/store/migrations", REQUIRED_UP_MIGRATIONS),
        ("candidateDownMigrationInputs", "packages/store/migrations/down", REQUIRED_DOWN_MIGRATIONS),
    ):
        values = contract.get(key)
        if not isinstance(values, dict) or set(values) != set(required):
            raise BridgeError(f"versioned rollback bridge {key} is incomplete or ambiguous")
        for name in required:
            expected = values.get(name)
            if not isinstance(expected, str) or DIGEST.fullmatch(expected) is None:
                raise BridgeError(f"versioned rollback bridge {key} has an invalid digest")
            try:
                content = subprocess.run(
                    ["git", "-C", str(ROOT), "show", f"{tree}:{directory}/{name}"],
                    check=True, capture_output=True,
                ).stdout
            except (OSError, subprocess.CalledProcessError) as error:
                raise BridgeError(f"versioned rollback bridge {key} payload is unavailable") from error
            if f"sha256:{hashlib.sha256(content).hexdigest()}" != expected:
                raise BridgeError(f"versioned rollback bridge {key} payload differs from metadata")


def manifest_digest(reference: str, label: str) -> str:
    if IMAGE_REF.fullmatch(reference) is None:
        raise BridgeError(f"{label} repository digest is invalid")
    return reference.rsplit("@", 1)[1]


def validate_image_identity(
    identity: dict, label: str, *, expected_repository_digest: str | None = None,
    expected_image_id: str | None = None,
) -> None:
    reference = identity["repositoryDigest"]
    if expected_repository_digest is not None and reference != expected_repository_digest:
        raise BridgeError(f"{label} repository digest differs from its authorized image")
    if expected_image_id is not None and identity["imageId"] != expected_image_id:
        raise BridgeError(f"{label} image ID differs from its authorized image")
    if identity["manifestDigest"] != manifest_digest(reference, label):
        raise BridgeError(f"{label} manifest digest differs from its RepoDigest")
    if identity["mediaType"] not in CHILD_MANIFEST_MEDIA_TYPES:
        raise BridgeError(f"{label} is not a supported child manifest")
    if identity["platform"] != TARGET_PLATFORM:
        raise BridgeError(f"{label} is not linux/amd64")


def runtime_stage_identity(identity: dict) -> dict:
    return {
        key: identity[key]
        for key in ("repositoryDigest", "imageId", "manifestDigest", "mediaType", "platform", "labels")
    }


def postgres_stage_identity(database: dict) -> dict:
    return {
        "repositoryDigest": database["postgresRepositoryDigest"],
        "imageId": database["postgresImageId"],
        "manifestDigest": database["postgresManifestDigest"],
        "mediaType": database["postgresMediaType"],
        "platform": database["postgresPlatform"],
    }


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
    allow_no_pull_diagnostic: bool,
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
    verify_sha_sidecar(evidence_path, expected_evidence_sha256)
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

    resulting_tree = verify_source_revision(report)

    runtime = report["runtime"]
    validate_image_identity(
        runtime, "bridge runtime", expected_repository_digest=expected_repository_digest,
        expected_image_id=expected_image_id,
    )
    if runtime["sourceDigest"] != report["sourceDigest"]:
        raise BridgeError("bridge runtime and top-level source digests differ")
    revision = report["sourceRevision"]
    try:
        bridge_metadata = json.loads((OPS / "rollback-bridge" / "metadata.json").read_text(encoding="utf-8"))
        publication = bridge_metadata["imagePublication"]
        schema_contract = bridge_metadata["schemaContract"]
        pinned_node = publication["pinnedNodeBaseRepositoryDigest"]
        pinned_python = publication["pinnedPythonBaseRepositoryDigest"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise BridgeError("versioned rollback bridge base-image policy is unavailable") from error
    verify_bridge_migration_payload(resulting_tree, bridge_metadata)
    if (bridge_metadata.get("schemaVersion") != 7
            or publication.get("lifecycleEvidenceSchemaVersion") != 11
            or publication.get("targetPlatform") != TARGET_PLATFORM_NAME
            or publication.get("acceptedManifestMediaTypes") != list(CHILD_MANIFEST_MEDIA_TYPES)
            or schema_contract.get("schemaLatest") != TARGET_SCHEMA):
        raise BridgeError("versioned rollback bridge image policy is invalid")
    base_images = runtime["baseImages"]
    if (base_images["node"]["repositoryDigest"] != pinned_node
            or base_images["python"]["repositoryDigest"] != pinned_python):
        raise BridgeError("bridge image bases differ from the versioned immutable bases")
    validate_image_identity(base_images["node"], "bridge Node base")
    validate_image_identity(base_images["python"], "bridge Python base")
    if (base_images["node"]["manifestDigest"] == base_images["python"]["manifestDigest"]
            or base_images["node"]["imageId"] == base_images["python"]["imageId"]):
        raise BridgeError("bridge Node and Python base identities are not role-distinct")
    bridge_labels = runtime["labels"]
    expected_bridge_labels = {
        "io.cauce.schema.compatible-through": TARGET_SCHEMA,
        "io.cauce.source.digest": runtime["sourceDigest"],
        "io.cauce.source.runtime": runtime["sourceDigest"],
        "io.cauce.rollback-bridge.tree": revision["resultingBridgeTree"],
        "io.cauce.rollback-bridge.patch-sha256": revision["patchSetSha256"],
        "io.cauce.rollback-bridge.patch-source-commit": revision["patchSourceCommit"],
        "io.cauce.rollback-bridge.read-only": "server-v2",
        "io.cauce.base.node.repository-digest": pinned_node,
        "io.cauce.base.python.repository-digest": pinned_python,
        "io.cauce.target-platform": TARGET_PLATFORM_NAME,
        "org.opencontainers.image.base.name": pinned_node,
    }
    if bridge_labels != expected_bridge_labels:
        raise BridgeError("bridge image provenance labels differ from source and base identities")
    for field in ("originBaseCommit", "patchPath", "patchSetSha256", "resultingBridgeTree"):
        if revision[field] != bridge_metadata.get(field):
            raise BridgeError("bridge source revision differs from versioned bridge metadata")

    candidate = report["candidateRuntime"]
    validate_image_identity(
        candidate, "candidate runtime",
        expected_repository_digest=expected_candidate_repository_digest,
        expected_image_id=expected_candidate_image_id,
    )
    if expected_candidate_source_digest is not None and candidate["sourceDigest"] != expected_candidate_source_digest:
        raise BridgeError("bridge cycle candidate source digest differs from the forward release")
    if candidate["sourceCommit"] != revision["patchSourceCommit"]:
        raise BridgeError("bridge patch source commit differs from the forward candidate commit")
    try:
        candidate_tree = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--verify", f'{candidate["sourceCommit"]}^{{tree}}'],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise BridgeError("forward candidate source tree cannot be resolved from Git") from error
    if candidate["sourceTree"] != candidate_tree:
        raise BridgeError("forward candidate evidence tree differs from its Git commit")
    candidate_labels = candidate["labels"]
    if (candidate_labels["io.cauce.source.digest"] != candidate["sourceDigest"]
            or candidate_labels["org.opencontainers.image.revision"] != candidate["sourceCommit"]
            or candidate_labels["io.cauce.target-platform"] != TARGET_PLATFORM_NAME
            or candidate_labels["io.cauce.schema.compatible-through"]
            != TARGET_SCHEMA
            or candidate_labels["org.opencontainers.image.base.name"]
            != candidate_labels["io.cauce.base.node.repository-digest"]
            or candidate_labels["io.cauce.base.node.repository-digest"]
            == candidate_labels["io.cauce.base.python.repository-digest"]):
        raise BridgeError("candidate image provenance labels are internally inconsistent")

    verification = report["imageVerification"]
    if (verification["targetPlatform"] != TARGET_PLATFORM_NAME
            or verification["acceptedManifestMediaTypes"] != list(CHILD_MANIFEST_MEDIA_TYPES)
            or verification["stageAttestationCount"] != 5):
        raise BridgeError("rollback image verification policy is inconsistent")
    if not verification["registryPullPerformed"] and not allow_no_pull_diagnostic:
        raise BridgeError("no-pull diagnostic evidence cannot authorize a release rollback")

    compose_sha256 = f"sha256:{hashlib.sha256((OPS / 'compose.rollback-bridge.yaml').read_bytes()).hexdigest()}"
    if report["composeFileSha256"] != compose_sha256:
        raise BridgeError("bridge evidence used another isolated Compose topology")
    topology = report["topology"]
    if topology["composeFileSha256"] != compose_sha256:
        raise BridgeError("bridge topology and top-level Compose digests differ")

    database = report["database"]
    snapshots = database["snapshots"]
    fencing = database["connectionFencing"]
    if (fencing["migration"] != CONNECTION_FENCING_SCHEMA
            or fencing["nullTokenCount"] != 0
            or fencing["nonNullTokenCount"] != fencing["totalLeaseCount"]
            or fencing["distinctTokenCount"] != fencing["totalLeaseCount"]):
        raise BridgeError("schema-031 connection fencing evidence is inconsistent")
    terminal_fencing = database["terminalClaimFencing"]
    expected_terminal_fencing = {
        "migration": TERMINAL_CLAIM_FENCING_SCHEMA,
        "table": "terminal_sessions",
        "constraint": "terminal_sessions_relay_claim_shape",
        "columnsExact": True,
        "epochDefaultExact": True,
        "constraintExact": True,
        "openTerminalSessionCount": 0,
        "legacyOpenSessionCount": 0,
        "claimCas": "passed",
        "liveLeaseConflict": "passed",
        "takeoverEpochRotation": "passed",
        "staleCloseNoop": "passed",
        "exactClosePreservesFence": "passed",
        "transactionRollback": "passed",
    }
    if terminal_fencing != expected_terminal_fencing:
        raise BridgeError("schema-032 terminal claim fencing evidence is inconsistent")
    browser_fencing = database["browserOwnerFencing"]
    expected_browser_fencing = {
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
        "exactPostRecoveryNoRotation": "passed",
        "requestMismatchConflict": "passed",
        "requestUnique": "passed",
        "ownerTakeoverCas": "passed",
        "staleDeleteNoop": "passed",
        "exactDelete": "passed",
        "transactionRollback": "passed",
    }
    if browser_fencing != expected_browser_fencing:
        raise BridgeError("schema-033 browser owner fencing evidence is inconsistent")
    relay_fencing = database["relayInstanceFencing"]
    expected_relay_fencing = {
        "migration": RELAY_INSTANCE_FENCING_SCHEMA,
        "table": "terminal_sessions",
        "constraint": "terminal_sessions_relay_instance_shape",
        "columnsExact": True,
        "constraintExact": True,
        "usableTerminalSessionCount": 0,
        "legacyUsableSessionCount": 0,
        "invalidStoredFenceCount": 0,
        "pinnedInstanceClaim": "passed",
        "liveBootConflict": "passed",
        "expiredBootTakeover": "passed",
        "staleBootCloseNoop": "passed",
        "exactClosePreservesFence": "passed",
        "constraintCounterexamples": "passed",
        "transactionRollback": "passed",
    }
    if relay_fencing != expected_relay_fencing:
        raise BridgeError("schema-034 relay instance fencing evidence is inconsistent")
    profile_adoption = database["profileRuntimeAdoption"]
    expected_profile_shape = {
        "migration": PROFILE_RUNTIME_ADOPTION_SCHEMA,
        "expectationsTable": "agent_profile_runtime_expectations",
        "adoptionsTable": "agent_profile_runtime_adoptions",
        "tablesExact": True,
        "constraintsExact": True,
        "functionsExact": True,
        "triggerExact": True,
        "invalidStoredExpectationCount": 0,
        "invalidStoredAdoptionCount": 0,
        "exactExpectationAdoption": "passed",
        "mismatchRejected": "passed",
        "deliveryUnique": "passed",
        "historyRetained": "passed",
        "transactionRollback": "passed",
    }
    if any(profile_adoption.get(key) != expected for key, expected in expected_profile_shape.items()):
        raise BridgeError("schema-035 profile runtime adoption evidence is inconsistent")
    if (set(profile_adoption) != {*expected_profile_shape, "expectationCount", "adoptionCount"}
            or not isinstance(profile_adoption["expectationCount"], int)
            or profile_adoption["expectationCount"] < 0
            or not isinstance(profile_adoption["adoptionCount"], int)
            or profile_adoption["adoptionCount"] < 0):
        raise BridgeError("schema-035 profile runtime adoption counts are invalid")
    shadow_phase = database["shadowTargetPhase"]
    expected_shadow_phase = {
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
        "pre036EagerClaimRejected": "passed",
        "unstartedReplay": "passed",
        "armedReplay": "passed",
        "observedSettlement": "passed",
        "terminalMappingMonotonic": "passed",
        "terminalMappingReconciliation": "passed",
        "transactionRollback": "passed",
    }
    if shadow_phase != expected_shadow_phase:
        raise BridgeError("schema-036 shadow target phase evidence is inconsistent")
    console_publish_journal = database["consolePublishJournal"]
    expected_console_publish_journal = {
        "migration": CONSOLE_PUBLISH_INTENT_SCHEMA,
        "migrationApplied": True,
        "table": "audit_events",
        "indexes": [
            "audit_events_console_publish_head_037_idx",
            "audit_events_console_publish_key_037_idx",
            "audit_events_console_publish_nonce_037_idx",
            "audit_events_console_publish_rate_037_idx",
        ],
        "indexCount": 4,
        "unexpectedIndexCount": 0,
        "allIndexesUsable": True,
        "indexDefinitionsExact": True,
        "keyLookupPlan": "passed",
        "nonceLookupPlan": "passed",
        "rateLimitPlan": "passed",
        "headLookupPlan": "passed",
    }
    if console_publish_journal != expected_console_publish_journal:
        raise BridgeError("schema-037 publish journal index evidence is inconsistent")
    postgres_identity = postgres_stage_identity(database)
    validate_image_identity(postgres_identity, "PostgreSQL runtime")
    expected_stages = (
        ("candidate", "probe-containers-attested-and-drained"),
        ("bridge", "probe-containers-attested-and-drained"),
        ("candidate", "probe-containers-attested-and-drained"),
        ("candidate", "writers-drained-image-selected"),
        ("candidate", "compensated-running-container-attested"),
    )
    for snapshot, (expected_role, expected_observation) in zip(snapshots, expected_stages, strict=True):
        images = snapshot["images"]
        if images["runtimeRole"] != expected_role:
            raise BridgeError("rollback lifecycle runtime role differs from its stage")
        if images["runtimeObservation"] != expected_observation:
            raise BridgeError("rollback lifecycle runtime observation differs from its stage")
        expected_runtime = runtime if expected_role == "bridge" else candidate
        if images["runtime"] != runtime_stage_identity(expected_runtime):
            raise BridgeError(f"{snapshot['stage']} runtime identity differs from its attested image")
        if images["postgres"] != postgres_identity:
            raise BridgeError(f"{snapshot['stage']} PostgreSQL identity differs from the restored database")
    for field, label in (
        ("migrationLedgerSha256", "migration ledger or verification state"),
        ("reconciliationSha256", "fleet reconciliation state"),
        ("profileContentSha256", "canonical profile content"),
        ("profileRevisionSha256", "profile revision or applied-revision state"),
        ("profileRuntimeSha256", "profile runtime expectation or adoption state"),
        ("shadowTargetPhaseSha256", "shadow target phase or mapping state"),
        ("leasesSha256", "connection leases"),
        ("authSessionSha256", "OIDC login or session state"),
        ("publishJournalSha256", "durable publish journal"),
        ("fullDatabaseStateSha256", "full public database state"),
    ):
        if len({snapshot[field] for snapshot in snapshots}) != 1:
            raise BridgeError(f"bridge lifecycle changed {label}")
    if len({json.dumps(snapshot["rowCounts"], sort_keys=True) for snapshot in snapshots}) != 1:
        raise BridgeError("bridge lifecycle changed canonical row counts")
    if any(snapshot["rowCounts"]["leases"] != fencing["totalLeaseCount"] for snapshot in snapshots):
        raise BridgeError("schema-031 connection fencing count differs from lifecycle leases")

    generated = instant(report["generatedAt"], "generatedAt")
    valid_until = instant(report["validUntil"], "validUntil")
    restore_verified = instant(
        database["restoreEvidenceVerifiedAt"], "database.restoreEvidenceVerifiedAt",
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    maximum = datetime.timedelta(hours=max_age_hours)
    restore_maximum = datetime.timedelta(hours=database["restoreEvidenceMaxAgeHours"])
    restore_skew = datetime.timedelta(seconds=database["restoreEvidenceMaxFutureSkewSeconds"])
    if generated > now + datetime.timedelta(minutes=5):
        raise BridgeError("bridge evidence is from the future")
    if valid_until <= generated or valid_until - generated > maximum:
        raise BridgeError("bridge evidence validity window exceeds policy")
    if now > valid_until or now - generated > maximum:
        raise BridgeError("bridge evidence is stale")
    if restore_verified > generated + restore_skew or restore_verified > now + restore_skew:
        raise BridgeError("restore evidence verification timestamp exceeds clock-skew policy")
    if generated - restore_verified > restore_maximum or now - restore_verified > restore_maximum:
        raise BridgeError("restore evidence is older than rollback production policy")

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
    parser.add_argument(
        "--allow-no-pull-diagnostic", action="store_true",
        help="validate local diagnostic evidence that is forbidden as a release rollback baseline",
    )
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
            allow_no_pull_diagnostic=arguments.allow_no_pull_diagnostic,
        )
    except (OSError, BridgeError, subprocess.CalledProcessError) as error:
        print(f"rollback bridge evidence failed: {error}", file=sys.stderr)
        return 1
    print("rollback bridge evidence passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
