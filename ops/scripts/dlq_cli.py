#!/usr/bin/env python3
"""Private PostgreSQL transport and evidence helpers for DLQ operator CLIs."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
PRIVATE_POSTGRES = ROOT / "scripts" / "private-postgres-command.py"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
ALIAS = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
TENANT = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
CONTAINER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
PRIVATE_MODES = {0o400, 0o600}
MAX_PRIVATE_JSON = 64 * 1024
DISPOSITIONS = {"ambiguous", "safe_retry", "missing_final", "auth", "expected_offline", "unclassified"}
RULE = re.compile(r"^[a-z0-9_]+_v[0-9]+$")
DLQ_CURSOR = re.compile(r"^(?:[a-f0-9]{2}){1,512}$")
SAFE_ITEM_KEYS = {
    "target", "id", "tenantId", "kind", "adapter", "disposition", "open", "actionable",
    "evidenceSha256", "attempts", "resolutionRule", "createdAt", "dispositionAt", "resolvedAt",
    "reopenCount", "lastReopenedAt",
}


class CliError(RuntimeError):
    """Expected fail-closed operator error whose text contains no database output."""


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def actor_sha256(tenant: str, alias: str) -> str:
    return sha256_text(f"{tenant}\x1f{alias}")


def validate_actor(tenant: str, alias: str) -> None:
    # This is shape validation, not a second tenant catalog.  Existence, enablement, role and
    # control scope are all checked transactionally against PostgreSQL.
    if not TENANT.fullmatch(tenant) or not ALIAS.fullmatch(alias):
        raise CliError("actor tenant/alias is invalid")


def exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise CliError(f"{label} fields do not match the versioned contract")


def validate_inventory(value: object) -> None:
    if not isinstance(value, list):
        raise CliError("DLQ inventory is invalid")
    keys = {"source", "kind", "disposition", "open", "actionable", "count"}
    for item in value:
        if not isinstance(item, dict):
            raise CliError("DLQ inventory item is invalid")
        exact_keys(item, keys, "DLQ inventory item")
        if (
            item.get("source") not in {"delivery", "outbox"}
            or not isinstance(item.get("kind"), str)
            or item.get("disposition") not in DISPOSITIONS
            or not isinstance(item.get("open"), bool)
            or not isinstance(item.get("actionable"), bool)
            or not isinstance(item.get("count"), int)
            or item["count"] < 0
        ):
            raise CliError("DLQ inventory item values are invalid")


def bounded_reason(value: object) -> str:
    if not isinstance(value, str):
        raise CliError("reason must be text")
    reason = value.strip()
    if not 1 <= len(reason) <= 1000 or any(ord(character) < 0x20 or ord(character) == 0x7F for character in reason):
        raise CliError("reason must be 1..1000 printable characters")
    return reason


def sql_literal(value: str) -> str:
    if "\x00" in value:
        raise CliError("SQL parameter contains a zero byte")
    return "'" + value.replace("'", "''") + "'"


def private_json(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_absolute():
        raise CliError("private JSON path must be absolute")
    try:
        before = path.lstat()
    except OSError as error:
        raise CliError("private JSON file is unavailable") from error
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_IMODE(before.st_mode) not in PRIVATE_MODES
        or before.st_nlink != 1
        or before.st_uid not in {0, os.geteuid()}
        or not 0 < before.st_size <= MAX_PRIVATE_JSON
    ):
        raise CliError("private JSON file must be owned, single-link and mode 0400/0600")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise CliError("private JSON changed while opening")
        payload = os.read(descriptor, MAX_PRIVATE_JSON + 1)
        after = os.fstat(descriptor)
        if len(payload) != opened.st_size or (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ) != (
            opened.st_size,
            opened.st_mtime_ns,
            opened.st_ctime_ns,
        ):
            raise CliError("private JSON changed while reading")
    finally:
        os.close(descriptor)
    try:
        parsed = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CliError("private JSON is invalid") from error
    if not isinstance(parsed, dict):
        raise CliError("private JSON must contain an object")
    return parsed


def write_evidence(path: pathlib.Path, value: object) -> None:
    if not path.is_absolute():
        raise CliError("evidence path must be absolute")
    parent = path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        raise CliError("evidence path already exists")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=parent)
    temporary_path = pathlib.Path(temporary)
    try:
        os.fchmod(descriptor, 0o600)
        payload = canonical_json(value)
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.link(temporary_path, path)
        directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except FileExistsError as error:
        raise CliError("evidence path already exists") from error
    finally:
        temporary_path.unlink(missing_ok=True)


class PostgresRunner:
    def __init__(
        self,
        *,
        database_url_file: pathlib.Path | None = None,
        postgres_container: str | None = None,
        run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        if (database_url_file is None) == (postgres_container is None):
            raise CliError("choose exactly one PostgreSQL transport")
        self.database_url_file = database_url_file
        self.postgres_container = postgres_container
        self.run = run
        if postgres_container is not None:
            self._validate_container(postgres_container)

    def _validate_container(self, name: str) -> None:
        if not CONTAINER.fullmatch(name):
            raise CliError("PostgreSQL container name is invalid")
        inspected = self.run(
            [
                "docker", "inspect", "--format",
                '{{ index .Config.Labels "com.docker.compose.project" }}|'
                '{{ index .Config.Labels "com.docker.compose.service" }}|{{.State.Running}}',
                name,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if inspected.returncode != 0 or inspected.stdout.strip() != "cauce-v3-prod|postgres|true":
            raise CliError("PostgreSQL container is not the canonical running production service")

    def query_json(self, sql: str) -> dict[str, Any]:
        if self.database_url_file is not None:
            command = [
                sys.executable,
                os.fspath(PRIVATE_POSTGRES),
                os.fspath(self.database_url_file),
                "--",
                "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
            ]
        else:
            command = [
                "docker", "exec", "-i", self.postgres_container or "",
                "sh", "-ec",
                'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
            ]
        completed = self.run(command, input=sql, check=False, capture_output=True, text=True)
        if completed.returncode != 0:
            raise CliError("PostgreSQL rejected the requested DLQ transition")
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if len(lines) != 1:
            raise CliError("PostgreSQL returned an invalid DLQ evidence envelope")
        try:
            value = json.loads(lines[0])
        except json.JSONDecodeError as error:
            raise CliError("PostgreSQL returned non-JSON DLQ evidence") from error
        if not isinstance(value, dict):
            raise CliError("PostgreSQL returned a non-object DLQ evidence envelope")
        return value


def database_arguments(parser: argparse.ArgumentParser) -> None:
    database = parser.add_mutually_exclusive_group(required=True)
    database.add_argument("--database-url-file", type=pathlib.Path)
    database.add_argument("--postgres-container")


def runner_from(arguments: argparse.Namespace) -> PostgresRunner:
    return PostgresRunner(
        database_url_file=arguments.database_url_file,
        postgres_container=arguments.postgres_container,
    )


def validate_reconciliation(value: dict[str, Any], phase: str) -> None:
    if value.get("schemaVersion") != 1 or value.get("suite") != "cauce-v3-dlq-causal-reconciliation":
        raise CliError("DLQ reconciliation evidence contract mismatch")
    if value.get("phase") != phase:
        raise CliError("DLQ reconciliation phase mismatch")
    base = {"schemaVersion", "suite", "phase"}
    if "generatedAt" in value:
        if not isinstance(value["generatedAt"], str):
            raise CliError("DLQ reconciliation generation time is invalid")
        base.add("generatedAt")
    if phase == "inspect":
        exact_keys(value, base | {"inventory", "inventorySha256"}, "DLQ inspect evidence")
        validate_inventory(value.get("inventory"))
    elif phase == "plan":
        exact_keys(value, base | {"planSha256", "material"}, "DLQ plan evidence")
        material = value.get("material")
        if not isinstance(material, dict):
            raise CliError("DLQ plan material is invalid")
        exact_keys(material, {
            "schemaVersion", "actorSha256", "candidateCount", "candidateSetSha256",
            "inventory", "transitions",
        }, "DLQ plan material")
        validate_inventory(material.get("inventory"))
        transitions = material.get("transitions")
        if not isinstance(transitions, list):
            raise CliError("DLQ plan transitions are invalid")
        for transition in transitions:
            if not isinstance(transition, dict):
                raise CliError("DLQ plan transition is invalid")
            exact_keys(
                transition,
                {"target", "rule", "toDisposition", "count", "evidenceSha256"},
                "DLQ plan transition",
            )
    elif phase == "apply":
        exact_keys(value, base | {
            "planSha256", "alreadyApplied", "transitionCount", "resolvedCount",
            "recoveredSentCount", "dispositionCount",
        }, "DLQ apply evidence")
    elif phase == "post":
        exact_keys(value, base | {
            "planSha256", "appliedCounts", "inventory", "inventorySha256",
        }, "DLQ post evidence")
        validate_inventory(value.get("inventory"))
        counts = value.get("appliedCounts")
        if not isinstance(counts, dict):
            raise CliError("DLQ post counts are invalid")
        exact_keys(counts, {"transitions", "resolved", "recoveredSent", "dispositions"}, "DLQ post counts")
    else:
        raise CliError("unknown DLQ reconciliation phase")
    encoded = json.dumps(value, ensure_ascii=True)
    for forbidden in (
        "payload", "reason", "error", "origin", "provider_message_id", "message_id",
        "delivery_id", "outbox_id", "providerMessageId", "messageId", "deliveryId", "outboxId",
    ):
        if f'"{forbidden}"' in encoded:
            raise CliError("DLQ reconciliation evidence contains a forbidden field")


def reconcile_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Causal DLQ inspect/plan/apply/post workflow")
    parser.add_argument("phase", choices=("inspect", "plan", "apply", "post"))
    parser.add_argument("--actor-tenant", required=True)
    parser.add_argument("--actor-alias", required=True)
    parser.add_argument("--plan", type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    database_arguments(parser)
    arguments = parser.parse_args(argv)
    validate_actor(arguments.actor_tenant, arguments.actor_alias)
    runner = runner_from(arguments)
    tenant = sql_literal(arguments.actor_tenant)
    alias = sql_literal(arguments.actor_alias)
    if arguments.phase in {"inspect", "plan"}:
        if arguments.plan is not None:
            raise CliError("inspect/plan do not accept a plan file")
        function = "cauce_dlq_inspect_030" if arguments.phase == "inspect" else "cauce_dlq_plan_030"
        value = runner.query_json(f"SELECT {function}({tenant},{alias})::text;\n")
    else:
        if arguments.plan is None:
            raise CliError("apply/post require the private plan file")
        planned = private_json(arguments.plan)
        validate_reconciliation(planned, "plan")
        digest = planned.get("planSha256")
        material = planned.get("material")
        if not isinstance(digest, str) or not SHA256.fullmatch(digest) or not isinstance(material, dict):
            raise CliError("DLQ plan digest/material is invalid")
        if material.get("actorSha256") != actor_sha256(arguments.actor_tenant, arguments.actor_alias):
            raise CliError("DLQ plan belongs to a different actor")
        function = "cauce_dlq_apply_030" if arguments.phase == "apply" else "cauce_dlq_post_030"
        value = runner.query_json(
            f"SELECT {function}({tenant},{alias},{sql_literal(digest)})::text;\n"
        )
    validate_reconciliation(value, arguments.phase)
    value["generatedAt"] = utc_now()
    write_evidence(arguments.output, value)
    print(f"DLQ {arguments.phase} evidence written", file=sys.stdout)
    return 0


def private_request_main(kind: str, argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"Cauce V3 {kind} operator transition")
    parser.add_argument("--request", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    database_arguments(parser)
    arguments = parser.parse_args(argv)
    request = private_json(arguments.request)
    if request.get("schemaVersion") != 1:
        raise CliError("operator request schema version is invalid")
    tenant = request.get("actorTenant")
    alias = request.get("actorAlias")
    if not isinstance(tenant, str) or not isinstance(alias, str):
        raise CliError("operator request actor is invalid")
    validate_actor(tenant, alias)
    reason = bounded_reason(request.get("reason"))
    runner = runner_from(arguments)
    if kind == "telegram-manual-replay":
        exact_keys(request, {
            "schemaVersion", "requestId", "id", "evidenceSha256", "chunkIndex", "effectSha256",
            "expectedReplayCount", "reason", "actorTenant", "actorAlias", "duplicateRiskAcknowledged",
        }, "manual replay request")
        request_id = request.get("requestId")
        dead_letter_id = request.get("id")
        incident_evidence = request.get("evidenceSha256")
        chunk_index = request.get("chunkIndex")
        effect_sha = request.get("effectSha256")
        expected_replay_count = request.get("expectedReplayCount")
        acknowledged = request.get("duplicateRiskAcknowledged")
        if not isinstance(effect_sha, str) or not SHA256.fullmatch(effect_sha):
            raise CliError("manual replay effect SHA-256 is invalid")
        if not isinstance(chunk_index, int) or isinstance(chunk_index, bool) or chunk_index < 0:
            raise CliError("manual replay chunk index is invalid")
        if acknowledged is not True:
            raise CliError("manual replay duplicate risk was not acknowledged")
        if not isinstance(incident_evidence, str) or not SHA256.fullmatch(incident_evidence):
            raise CliError("manual replay incident evidence is invalid")
        if (
            not isinstance(expected_replay_count, int)
            or isinstance(expected_replay_count, bool)
            or expected_replay_count < 0
        ):
            raise CliError("manual replay expected replay count is invalid")
        try:
            import uuid
            request_id = str(uuid.UUID(str(request_id)))
            dead_letter_id = str(uuid.UUID(str(dead_letter_id)))
        except (ValueError, TypeError, AttributeError) as error:
            raise CliError("manual replay request id is invalid") from error
        sql = "SELECT cauce_manual_replay_telegram_030(" + ",".join((
            sql_literal(effect_sha), str(chunk_index), sql_literal(reason),
            sql_literal(tenant), sql_literal(alias), "true", f"{sql_literal(request_id)}::uuid",
            f"{sql_literal(dead_letter_id)}::uuid", sql_literal(incident_evidence),
            str(expected_replay_count),
        )) + ")::text;\n"
        expected_suite = "cauce-v3-telegram-manual-replay"
        expected_response = {
            "schemaVersion", "suite", "phase", "appliedCount", "alreadyApplied",
            "replaySequence", "effectSha256",
            "evidenceSha256", "duplicateRisk", "warning",
        }
    elif kind == "resolve-without-replay":
        exact_keys(request, {
            "schemaVersion", "target", "id", "evidenceSha256", "reason", "actorTenant",
            "actorAlias", "possibleDuplicateAcknowledged", "possibleNoDeliveryAcknowledged",
        }, "no-replay resolution request")
        target = request.get("target")
        letter_id = request.get("id")
        evidence = request.get("evidenceSha256")
        duplicate = request.get("possibleDuplicateAcknowledged")
        no_delivery = request.get("possibleNoDeliveryAcknowledged")
        try:
            import uuid
            uuid.UUID(str(letter_id))
        except (ValueError, TypeError, AttributeError) as error:
            raise CliError("DLQ resolution id is invalid") from error
        if target not in {"delivery", "outbox"} or not isinstance(evidence, str) or not SHA256.fullmatch(evidence):
            raise CliError("DLQ resolution target/evidence is invalid")
        if not isinstance(duplicate, bool) or not isinstance(no_delivery, bool):
            raise CliError("DLQ resolution acknowledgements must be explicit booleans")
        sql = "SELECT cauce_resolve_dlq_without_replay_030(" + ",".join((
            sql_literal(target), f"{sql_literal(str(letter_id))}::uuid", sql_literal(evidence),
            sql_literal(reason), sql_literal(tenant), sql_literal(alias),
            "true" if duplicate else "false", "true" if no_delivery else "false",
        )) + ")::text;\n"
        expected_suite = "cauce-v3-dlq-no-replay-resolution"
        expected_response = {
            "schemaVersion", "suite", "phase", "appliedCount", "alreadyApplied",
            "evidenceSha256", "reasonSha256", "possibleDuplicateAcknowledged",
            "possibleNoDeliveryAcknowledged",
        }
    else:
        raise CliError("unknown private operator request")
    value = runner.query_json(sql)
    if value.get("schemaVersion") != 1 or value.get("suite") != expected_suite:
        raise CliError("operator transition evidence contract mismatch")
    exact_keys(value, expected_response, "operator transition evidence")
    value["generatedAt"] = utc_now()
    write_evidence(arguments.output, value)
    print(f"{kind} evidence written", file=sys.stdout)
    return 0


def private_replay_inspect_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect scoped Telegram effects for manual replay")
    parser.add_argument("--request", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    database_arguments(parser)
    arguments = parser.parse_args(argv)
    request = private_json(arguments.request)
    exact_keys(request, {
        "schemaVersion", "id", "evidenceSha256", "actorTenant", "actorAlias",
    }, "Telegram replay inspect request")
    if request.get("schemaVersion") != 1:
        raise CliError("Telegram replay inspect schema version is invalid")
    tenant = request.get("actorTenant")
    alias = request.get("actorAlias")
    evidence = request.get("evidenceSha256")
    if not isinstance(tenant, str) or not isinstance(alias, str):
        raise CliError("Telegram replay inspect actor is invalid")
    validate_actor(tenant, alias)
    if not isinstance(evidence, str) or not SHA256.fullmatch(evidence):
        raise CliError("Telegram replay inspect evidence is invalid")
    try:
        import uuid
        letter_id = str(uuid.UUID(str(request.get("id"))))
    except (ValueError, TypeError, AttributeError) as error:
        raise CliError("Telegram replay inspect DLQ id is invalid") from error
    value = runner_from(arguments).query_json(
        "SELECT cauce_inspect_telegram_replay_030(" + ",".join((
            f"{sql_literal(letter_id)}::uuid", sql_literal(evidence),
            sql_literal(tenant), sql_literal(alias),
        )) + ")::text;\n"
    )
    exact_keys(value, {
        "schemaVersion", "suite", "phase", "id", "evidenceSha256", "items", "total",
    }, "Telegram replay inspect evidence")
    if (
        value.get("schemaVersion") != 1
        or value.get("suite") != "cauce-v3-telegram-replay-inspect"
        or value.get("phase") != "inspect"
        or value.get("id") != letter_id
        or value.get("evidenceSha256") != evidence
        or not isinstance(value.get("items"), list)
        or not isinstance(value.get("total"), int)
        or value["total"] != len(value["items"])
    ):
        raise CliError("Telegram replay inspect evidence contract mismatch")
    for item in value["items"]:
        if not isinstance(item, dict):
            raise CliError("Telegram replay inspect item is invalid")
        exact_keys(item, {
            "chunkIndex", "effectSha256", "state", "replayCount", "duplicateRisk",
        }, "Telegram replay inspect item")
        if (
            not isinstance(item.get("chunkIndex"), int)
            or isinstance(item.get("chunkIndex"), bool)
            or item["chunkIndex"] < 0
            or not isinstance(item.get("effectSha256"), str)
            or not SHA256.fullmatch(item["effectSha256"])
            or item.get("state") not in {"prepared", "ambiguous", "dead"}
            or not isinstance(item.get("replayCount"), int)
            or item["replayCount"] < 0
            or not isinstance(item.get("duplicateRisk"), bool)
            or item["duplicateRisk"] != (item["state"] != "prepared")
        ):
            raise CliError("Telegram replay inspect item values are invalid")
    value["generatedAt"] = utc_now()
    write_evidence(arguments.output, value)
    print("Telegram replay inspect evidence written", file=sys.stdout)
    return 0


def list_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="List safe, control-scoped DLQ incidents")
    parser.add_argument("--actor-tenant", required=True)
    parser.add_argument("--actor-alias", required=True)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--cursor")
    parser.add_argument("--output", required=True, type=pathlib.Path)
    database_arguments(parser)
    arguments = parser.parse_args(argv)
    validate_actor(arguments.actor_tenant, arguments.actor_alias)
    if not 1 <= arguments.limit <= 500:
        raise CliError("DLQ list limit must be between 1 and 500")
    if arguments.cursor is not None and not DLQ_CURSOR.fullmatch(arguments.cursor):
        raise CliError("DLQ list cursor is invalid")
    value = runner_from(arguments).query_json(
        "SELECT cauce_list_dlq_030(" + ",".join((
            sql_literal(arguments.actor_tenant), sql_literal(arguments.actor_alias), str(arguments.limit),
            "NULL" if arguments.cursor is None else sql_literal(arguments.cursor),
        )) + ")::text;\n"
    )
    if value.get("schemaVersion") != 1 or not isinstance(value.get("items"), list):
        raise CliError("DLQ list evidence contract mismatch")
    exact_keys(value, {"schemaVersion", "items", "total", "truncated", "nextCursor"}, "DLQ list evidence")
    if not isinstance(value.get("total"), int) or value["total"] < 0 or not isinstance(value.get("truncated"), bool):
        raise CliError("DLQ list counters are invalid")
    if value.get("nextCursor") is not None and (
        not isinstance(value["nextCursor"], str) or not DLQ_CURSOR.fullmatch(value["nextCursor"])
    ):
        raise CliError("DLQ list cursor is invalid")
    if value["truncated"] != (value["nextCursor"] is not None):
        raise CliError("DLQ list pagination state is inconsistent")
    for item in value["items"]:
        if not isinstance(item, dict):
            raise CliError("DLQ list item is invalid")
        exact_keys(item, SAFE_ITEM_KEYS, "DLQ list item")
        if (
            item.get("target") not in {"delivery", "outbox"}
            or not isinstance(item.get("id"), str)
            or not isinstance(item.get("tenantId"), str)
            or not TENANT.fullmatch(item["tenantId"])
            or item.get("disposition") not in DISPOSITIONS
            or not isinstance(item.get("attempts"), int)
            or item["attempts"] < 0
            or not isinstance(item.get("reopenCount"), int)
            or item["reopenCount"] < 0
            or (item.get("resolutionRule") is not None and not RULE.fullmatch(item["resolutionRule"]))
        ):
            raise CliError("DLQ list item values are invalid")
    value.update({"suite": "cauce-v3-dlq-safe-list", "phase": "list", "generatedAt": utc_now()})
    write_evidence(arguments.output, value)
    print("DLQ list evidence written", file=sys.stdout)
    return 0


def guarded(entrypoint: Callable[[], int]) -> int:
    try:
        return entrypoint()
    except CliError as error:
        print(str(error), file=sys.stderr)
        return 2
