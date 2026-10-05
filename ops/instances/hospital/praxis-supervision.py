#!/usr/bin/env python3
"""Run one bounded supervision pass; durable deliveries remain owned by Cauce."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import io
import json
import re
import signal
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# cauce:requiere none

ACTORS = ("operador", "perseo", "teseo")
OPEN = {"pending", "retry", "leased", "accepted", "started"}
TERMINAL = {"done", "failed", "dead", "cancelled", "expired"}
ADVANCED = {"advanced", "validated", "accepted", "avanzada", "validada", "aceptada"}
ACCEPTED = {"validated", "accepted", "validada", "aceptada"}
CAPACITY_CODES = {
    "rate_limit_exceeded", "insufficient_quota", "quota_exhausted",
    "model_capacity", "model_overloaded", "auth_expired", "invalid_credentials",
    "unauthorized", "forbidden", "transport_cancelled_unknown",
}
HEX = re.compile(r"[a-f0-9]{64}\Z")
HEAD = re.compile(r"[a-f0-9]{40,64}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}\Z")
ROOT_TEXT = (
    "Continuá el GOAL autorizado de Praxis con ingeniería y datos sintéticos. "
    "Primero reconciliá el estado real, commits y evidencia; una entrega anterior "
    "con transport_cancelled_unknown no acredita ejecución ni permite replay ciego. "
    "El operador coordina, revisa e integra; Teseo y Perseo son dos developers "
    "generalistas con ownership disjunto. Elegí trabajo independiente y terminable "
    "para completar los criterios completos de las incidencias y del roadmap; "
    "evitá microflags. Comprobá pruebas, QA y snapshot antes de publicar con la "
    "autorización durable vigente. Los criterios clínicos o legales pendientes "
    "requieren decisión del dueño y sólo bloquean esa parte. No declarés el producto "
    "terminado por labels o entregas done. No leas datos clínicos privados ni secretos. "
    "Cerrá esta entrega sin esperar ni hacer polling. Si falla cuota, autenticación "
    "o capacidad, incluí un código técnico tipado en JSON: "
    '{"supervision":{"version":1,"outcome":"capacity_failure","code":'
    '"quota_exhausted"}}; usá el código observado, nunca lo inventes.'
)

RUNTIME_SQL = """
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
SELECT json_build_object(
 'observed_at',extract(epoch FROM now()),
 'open_gates',(SELECT count(*) FROM agent_chain_gates WHERE tenant_id='Hospital' AND status='open'),
 'actors',COALESCE((SELECT json_agg(json_build_object(
    'alias',a.alias,'enabled',a.enabled,
    'online',COALESCE(l.lease_until>now(),false),
    'heartbeat_age',extract(epoch FROM now()-l.last_heartbeat_at)))
    FROM agents a LEFT JOIN connection_leases l USING(tenant_id,alias)
    WHERE a.tenant_id='Hospital' AND a.enabled),'[]'::json),
 'work',json_build_object(
    'pending',count(*) FILTER(WHERE d.status='pending'),
    'retry',count(*) FILTER(WHERE d.status='retry'),
    'leased',count(*) FILTER(WHERE d.status='leased'),
    'accepted',count(*) FILTER(WHERE d.status='accepted'),
    'started',count(*) FILTER(WHERE d.status='started')),
 'last_activity_at',extract(epoch FROM max(COALESCE(d.terminal_at,d.created_at))))
FROM deliveries d WHERE d.recipient_tenant='Hospital';
COMMIT;
"""


STATE_SPEC = importlib.util.spec_from_file_location("praxis_supervision_state", Path(__file__).with_name("praxis-supervision-state.py"))
STATE = importlib.util.module_from_spec(STATE_SPEC)
STATE_SPEC.loader.exec_module(STATE)
SupervisionError = STATE.SupervisionError
canonical, digest = STATE.canonical, STATE.digest
trusted_file, read_bytes, scoped = STATE.trusted_file, STATE.read_bytes, STATE.scoped
atomic_save, StateLock = STATE.atomic_save, STATE.StateLock


class ApiError(SupervisionError):
    pass


def load_config(path: Path) -> dict:
    trusted_file(path)
    config = json.loads(read_bytes(path, 64_000))
    required = {"workspace", "goal_file", "goal_sha256", "issues_file", "roadmap_file",
                "preview_root", "preview_files", "verification_file", "evidence_file",
                "client_cert", "client_key", "ca_cert"}
    if not isinstance(config, dict) or not required.issubset(config):
        raise SupervisionError("invalid_configuration")
    if not HEX.fullmatch(config["goal_sha256"]):
        raise SupervisionError("invalid_goal_digest")
    url = urllib.parse.urlsplit(config.get("api_url", "https://172.17.0.1:18443"))
    if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment or url.path:
        raise SupervisionError("invalid_api_url")
    for key in ("workspace", "preview_root", "client_cert", "client_key", "ca_cert"):
        if not isinstance(config[key], str) or not Path(config[key]).is_absolute():
            raise SupervisionError("invalid_configuration")
    bounds = {"root_limit": (1, 12, 6), "notice_limit": (1, 3, 3),
              "idle_seconds": (480, 3600, 480), "cooldown_seconds": (1200, 86400, 1200),
              "api_timeout": (1, 10, 8), "pass_seconds": (10, 55, 55),
              "heartbeat_seconds": (30, 300, 180)}
    for key, (minimum, maximum, default) in bounds.items():
        value = config.get(key, default)
        if type(value) is not int or not minimum <= value <= maximum:
            raise SupervisionError("invalid_configuration")
        config[key] = value
    if not isinstance(config["preview_files"], dict) or not config["preview_files"]:
        raise SupervisionError("invalid_preview_files")
    if config.get("issue_count", 37) != 37 or config.get("roadmap_count", 216) != 216:
        raise SupervisionError("invalid_tracker_counts")
    if type(config.get("enabled", False)) is not bool:
        raise SupervisionError("invalid_configuration")
    if (type(config.get("bootstrap_generation", 0)) is not int or config.get("bootstrap_generation", 0) < 0
            or type(config.get("bootstrap_daily_roots", 1)) is not int or not 1 <= config.get("bootstrap_daily_roots", 1) <= 6):
        raise SupervisionError("invalid_configuration")
    return config


class Api:
    def __init__(self, config: dict, deadline: float):
        self.config, self.deadline, self.context = config, deadline, None

    def request(self, method: str, route: str, payload: dict | None = None) -> dict:
        timeout = min(self.config["api_timeout"], self.deadline - time.monotonic())
        if timeout <= 0:
            raise ApiError("pass_timeout")
        if self.context is None:
            self.context = ssl.create_default_context(cafile=self.config["ca_cert"])
            self.context.load_cert_chain(self.config["client_cert"], self.config["client_key"])
        request = urllib.request.Request(
            self.config.get("api_url", "https://172.17.0.1:18443") + route,
            data=canonical(payload) if payload is not None else None, method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=self.context), NoRedirect())
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ApiError("invalid_receipt")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ApiError("invalid_receipt")
            return value
        except urllib.error.HTTPError as error:
            code = {401: "unauthorized", 403: "forbidden", 429: "rate_limit_exceeded",
                    503: "model_capacity"}.get(error.code, "http_error")
            raise ApiError(code) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ApiError("transport_unknown") from error
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ApiError("invalid_receipt") from error

    def post(self, payload: dict) -> dict:
        return self.request("POST", "/v3/messages", payload)

    def get(self, message_id: str) -> dict:
        try:
            uuid.UUID(message_id)
        except (ValueError, TypeError, AttributeError) as error:
            raise ApiError("invalid_receipt") from error
        return self.request("GET", "/v3/messages/" + message_id)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        raise ApiError("unexpected_redirect")


def run_command(command: list[str], deadline: float, input_text: str | None = None) -> str:
    timeout = min(8, deadline - time.monotonic())
    if timeout <= 0:
        raise SupervisionError("pass_timeout")
    environment = {"PATH": "/usr/bin:/bin"}
    try:
        result = subprocess.run(STATE.isolated_command(command), input=input_text, text=True, capture_output=True,
                                timeout=timeout, check=True, env=environment, **STATE.command_identity(command))
        return result.stdout
    except (subprocess.SubprocessError, OSError) as error:
        raise SupervisionError("observation_unavailable") from error


def runtime_snapshot(config: dict, deadline: float) -> dict:
    container = config.get("postgres_container", "hospital-cauce-postgres-1")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", container):
        raise SupervisionError("invalid_configuration")
    raw = run_command(["docker", "exec", "-i", container, "psql", "-XAtq",
                       "-v", "ON_ERROR_STOP=1", "-U", "cauce_hospital", "-d", "cauce_hospital"],
                      deadline, RUNTIME_SQL)
    value = json.loads(raw)
    actors, work = value.get("actors"), value.get("work")
    if not isinstance(actors, list) or not isinstance(work, dict):
        raise SupervisionError("invalid_runtime_snapshot")
    if any(type(work.get(status)) is not int or work[status] < 0 for status in OPEN):
        raise SupervisionError("invalid_runtime_snapshot")
    if not isinstance(value.get("observed_at"), (int, float)) or abs(value["observed_at"] - time.time()) > 30:
        raise SupervisionError("stale_runtime_snapshot")
    if type(value.get("open_gates", 0)) is not int or value.get("open_gates", 0) < 0:
        raise SupervisionError("invalid_runtime_snapshot")
    value["active"] = sum(work[status] for status in OPEN) + value.get("open_gates", 0)
    value["ready"] = (sorted(actor.get("alias", "") for actor in actors) == list(ACTORS)
                      and all(actor.get("enabled") is True and actor.get("online") is True
                              and isinstance(actor.get("heartbeat_age"), (int, float))
                              and 0 <= actor["heartbeat_age"] <= config["heartbeat_seconds"]
                              for actor in actors))
    return value


def root_failure_metadata(config: dict, message_id: str, deadline: float) -> str | None:
    identifier = str(uuid.UUID(message_id))
    sql = "BEGIN READ ONLY; SET LOCAL statement_timeout='3000ms'; WITH owner_root AS ("
    sql += f"SELECT id,trace_id FROM messages WHERE id='{identifier}'::uuid AND tenant_id='Hospital' "
    sql += "AND actor_alias='praxis-supervisor' AND room_id='grp.hospital'), scope AS ("
    sql += "SELECT d.status,d.last_error FROM owner_root root JOIN messages m ON m.id=root.id OR "
    sql += "(m.trace_id=root.trace_id AND m.tenant_id='Hospital' AND m.body->>'type' IN "
    sql += "('agent.message','agent.response','agent.fanin','agent.notify')) JOIN deliveries d ON d.message_id=m.id "
    sql += "WHERE d.recipient_tenant='Hospital') SELECT json_build_object('root_found',EXISTS(SELECT 1 FROM owner_root),"
    sql += "'open',count(*) FILTER(WHERE status IN ('pending','retry','leased','accepted','started')),"
    sql += "'failed',count(*) FILTER(WHERE status IN ('failed','dead','cancelled','expired')),'errors',"
    sql += "COALESCE((SELECT json_agg(error) FROM (SELECT left(COALESCE(last_error,''),4000) error FROM scope "
    sql += "WHERE status IN ('failed','dead','cancelled','expired') LIMIT 8) errors),'[]'::json)) FROM scope; COMMIT;"
    container = config.get("postgres_container", "hospital-cauce-postgres-1")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", container):
        raise SupervisionError("invalid_configuration")
    raw = run_command(["docker", "exec", "-i", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1",
                       "-U", "cauce_hospital", "-d", "cauce_hospital"], deadline, sql)
    value = json.loads(raw)
    if (not isinstance(value, dict) or value.get("root_found") is not True
            or type(value.get("open")) is not int or type(value.get("failed")) is not int):
        raise SupervisionError("chain_verification_unknown")
    if value["open"]:
        return "chain_still_open"
    if not value["failed"]:
        return None
    for error in value.get("errors", [])[:8]:
        if not isinstance(error, str):
            continue
        match = re.fullmatch(r"OpenClaw API rejected the request \(HTTP (401|403|429|503); category=[a-z_-]{1,40}\)", error)
        if match:
            return {"401": "unauthorized", "403": "forbidden", "429": "rate_limit_exceeded", "503": "model_capacity"}[match[1]]
        if error in CAPACITY_CODES:
            return error
    return "chain_failed_unclassified"


def certificate_expiry(config: dict) -> float:
    certificate = ssl._ssl._test_decode_cert(config["client_cert"])
    observed = ssl.cert_time_to_seconds(certificate["notAfter"])
    metadata_path = config.get("identity_metadata_file")
    if metadata_path:
        path = Path(metadata_path)
        trusted_file(path)
        metadata = json.loads(read_bytes(path, 16_000))
        if isinstance(metadata, dict) and metadata.get("alias") == "praxis-supervisor" and metadata.get("cert_sha256") == digest(read_bytes(Path(config["client_cert"]), 64_000)):
            declared = dt.datetime.fromisoformat(metadata["expires_at"].replace("Z", "+00:00"))
            if declared.tzinfo and abs(declared.timestamp() - observed) <= 1:
                return declared.timestamp()
    return observed


def records(path: Path, config: dict, name: str) -> dict[str, str]:
    raw = read_bytes(path).decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(raw)))
    columns = config.get(name + "_columns", {"id": "id", "status": "status"})
    result = {}
    for row in rows:
        normalized = {str(key).strip().lower(): value for key, value in row.items() if key is not None}
        identifier = (normalized.get(columns["id"].lower()) or "").strip()
        status_value = (normalized.get(columns["status"].lower()) or "").strip().lower()
        if not ID.fullmatch(identifier) or identifier in result:
            raise SupervisionError("invalid_tracker")
        result[identifier] = status_value
    return result


def roadmap_records(path: Path, goal_hash: str) -> dict[str, str]:
    value = json.loads(read_bytes(path))
    if not isinstance(value, dict) or value.get("goal_sha256") != goal_hash:
        raise SupervisionError("foreign_roadmap_goal")
    issues, criteria = value.get("issues"), {}
    if not isinstance(issues, list) or len(issues) > 1000:
        raise SupervisionError("invalid_roadmap")
    for issue in issues:
        if not isinstance(issue, dict) or not ID.fullmatch(str(issue.get("id", ""))):
            raise SupervisionError("invalid_roadmap")
        entries = issue.get("criteria", [])
        if not isinstance(entries, list) or len(entries) > 1000:
            raise SupervisionError("invalid_roadmap")
        for criterion in entries:
            identifier = criterion.get("id") if isinstance(criterion, dict) else None
            if not isinstance(identifier, str) or not ID.fullmatch(identifier):
                raise SupervisionError("invalid_roadmap")
            key = issue["id"] + ":" + identifier
            if key in criteria:
                raise SupervisionError("invalid_roadmap")
            criteria[key] = "accepted"
    return criteria


def evidence_records(value: dict, name: str, expected: dict, workspace: Path) -> set[str]:
    accepted = set()
    entries = value.get(name, [])
    if not isinstance(entries, list) or len(entries) > 1000:
        return accepted
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("id") not in expected or entry.get("id") in accepted:
            continue
        if entry.get("outcome") not in ACCEPTED or expected[entry["id"]] not in ACCEPTED:
            continue
        artifacts = entry.get("artifacts")
        if not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 20:
            continue
        valid = True
        for artifact in artifacts:
            if not isinstance(artifact, dict) or not HEX.fullmatch(str(artifact.get("sha256", ""))):
                valid = False
                break
            if digest(read_bytes(scoped(workspace, artifact.get("path")))) != artifact["sha256"]:
                valid = False
                break
        if valid:
            accepted.add(entry["id"])
    return accepted


def criterion_evidence(value: dict, roadmap: dict, workspace: Path, commit_verified) -> set[str]:
    accepted = set()
    records_value = value.get("records", {})
    if not isinstance(records_value, dict) or len(records_value) > 1000:
        return accepted
    for issue, record in records_value.items():
        if not isinstance(record, dict) or not commit_verified(record.get("source_commit")):
            continue
        criteria = record.get("criteria", [])
        if not isinstance(criteria, list) or len(criteria) > 1000:
            continue
        for criterion in criteria:
            if not isinstance(criterion, dict) or criterion.get("outcome") not in ACCEPTED:
                continue
            key = issue + ":" + str(criterion.get("id", ""))
            artifact = criterion.get("artifact")
            if key not in roadmap or not isinstance(artifact, dict):
                continue
            path = scoped(workspace, artifact.get("path"))
            if HEX.fullmatch(str(artifact.get("sha256", ""))) and digest(read_bytes(path)) == artifact["sha256"]:
                accepted.add(key)
    return accepted


def engineering_snapshot(config: dict, deadline: float) -> dict:
    workspace, preview = Path(config["workspace"]), Path(config["preview_root"])
    goal_hash = digest(read_bytes(scoped(workspace, config["goal_file"])))
    if goal_hash != config["goal_sha256"]:
        raise SupervisionError("foreign_goal")
    head = run_command(["git", "-C", str(workspace), "rev-parse", "HEAD"], deadline).strip()
    if not HEAD.fullmatch(head):
        raise SupervisionError("invalid_git_head")
    working_tree_clean = not run_command(["git", "-C", str(workspace), "status", "--porcelain"], deadline).strip()
    ancestor_cache = {head: True}
    def commit_verified(commit):
        if not isinstance(commit, str) or not HEAD.fullmatch(commit):
            return False
        if commit not in ancestor_cache:
            try:
                run_command(["git", "-C", str(workspace), "merge-base", "--is-ancestor", commit, head], deadline)
                ancestor_cache[commit] = True
            except SupervisionError:
                ancestor_cache[commit] = False
        return ancestor_cache[commit]
    issues = records(scoped(workspace, config["issues_file"]), config, "issues")
    roadmap = roadmap_records(scoped(workspace, config["roadmap_file"]), goal_hash)
    if len(issues) != config.get("issue_count", 37) or len(roadmap) != config.get("roadmap_count", 216):
        raise SupervisionError("tracker_count_mismatch")
    published = {}
    for source, destination in config["preview_files"].items():
        source_hash = digest(read_bytes(scoped(workspace, source)))
        published[source] = {"source": source_hash, "published": digest(read_bytes(scoped(preview, destination)))}
    web_matches = all(row["source"] == row["published"] for row in published.values())
    evidence, verification = {}, {}
    for field, target in (("evidence_file", evidence), ("verification_file", verification)):
        path = scoped(workspace, config[field])
        if path.exists():
            try:
                value = json.loads(read_bytes(path))
                if isinstance(value, dict):
                    target.update(value)
            except (ValueError, UnicodeError):
                pass
    evidence_current = evidence.get("goal_sha256") == goal_hash
    accepted_roadmap = criterion_evidence(evidence, roadmap, workspace, commit_verified) if evidence_current else set()
    issue_records = evidence.get("records", {})
    validated_issues = {key for key, record in issue_records.items() if isinstance(record, dict)
                        and record.get("validation_status") in ACCEPTED} if isinstance(issue_records, dict) else set()
    accepted_issues = {key for key, status in issues.items() if status in ACCEPTED
                       and key in validated_issues
                       and any(item.startswith(key + ":") for item in roadmap)
                       and all(item in accepted_roadmap for item in roadmap if item.startswith(key + ":"))}
    gates = verification.get("gates", [])
    expected_gates = {"tests", "typecheck", "build", "qa", "snapshot"} | set(config.get("required_gates", []))
    valid_gates = evidence_records({"gates": gates}, "gates",
                                  {name: "accepted" for name in expected_gates}, workspace)
    source_files = verification.get("source_files", {})
    source_paths = set(config["preview_files"]) | (set(source_files) if isinstance(source_files, dict) else set())
    source_hashes = {path: digest(read_bytes(scoped(workspace, path))) for path in source_paths}
    source_matches = isinstance(source_files, dict) and bool(source_files)
    if source_matches:
        source_matches = all(HEX.fullmatch(str(expected)) and source_hashes[path] == expected
                             for path, expected in source_files.items())
    integration_commit = verification.get("integration_commit")
    unchanged_sources = False
    if source_matches and commit_verified(integration_commit):
        unchanged_sources = not run_command(["git", "-C", str(workspace), "diff", "--name-only",
                                             integration_commit, head, "--", *sorted(source_files)], deadline).strip()
    verification_source_current = (verification.get("status") in {"verified-preview", "validated", "accepted"}
                                    and commit_verified(verification.get("source_commit")) and unchanged_sources
                                    and set(config["preview_files"]).issubset(source_files))
    verification_current = (verification_source_current
                            and set(verification.get("accepted_issues", [])) == set(issues))
    gate_artifacts = sorted({gate["id"] + ":" + artifact["sha256"] for gate in gates
                             if isinstance(gate, dict) and gate.get("id") in valid_gates
                             for artifact in gate["artifacts"]}) if verification_source_current and isinstance(gates, list) else []
    complete = (len(accepted_issues) == len(issues) and len(accepted_roadmap) == len(roadmap)
                and valid_gates == expected_gates and web_matches and verification_current and working_tree_clean)
    return {"goal_sha256": goal_hash, "git_head": head, "issues_total": len(issues),
            "roadmap_total": len(roadmap), "advanced_issues": sorted(key for key, status in issues.items() if status in ADVANCED),
            "accepted_issues": sorted(accepted_issues), "accepted_roadmap": sorted(accepted_roadmap),
            "valid_gates": sorted(valid_gates), "web_matches": web_matches,
            "verification_current": verification_current, "source_files_match": bool(source_matches), "completion_candidate": complete,
            "working_tree_clean": working_tree_clean, "files": published, "source_hashes": source_hashes,
            "verification_source_current": verification_source_current, "gate_artifacts": gate_artifacts}


def made_progress(previous: dict, current: dict) -> bool:
    criteria_progress = any(set(current.get(field, [])) > set(previous.get(field, []))
                            for field in ("accepted_issues", "accepted_roadmap"))
    verified_code = (current["git_head"] != previous.get("git_head")
                     and current.get("source_hashes") != previous.get("source_hashes")
                     and bool(previous.get("source_hashes")) and bool(current.get("source_hashes"))
                     and current.get("verification_source_current") is True
                     and bool(set(current.get("gate_artifacts", [])) - set(previous.get("gate_artifacts", []))))
    return criteria_progress or verified_code


def typed_failure(receipt: dict) -> str | None:
    for delivery in receipt.get("deliveries", [])[:20]:
        value = delivery.get("reply")
        if isinstance(value, str) and len(value.encode()) <= 16_000:
            try:
                value = json.loads(value)
            except (ValueError, RecursionError):
                continue
        if isinstance(value, dict):
            value = value.get("supervision", value)
            if isinstance(value, dict) and value.get("code") in CAPACITY_CODES:
                return value["code"]
    return None


class Supervisor:
    def __init__(self, config: dict, state_path: Path, api, now: float, observe_only: bool = False, failure_reader=None, post_clock=None, runtime_reader=None):
        self.config, self.path, self.api, self.now = config, state_path, api, now
        self.failure_reader = failure_reader
        self.post_clock = post_clock or (lambda: self.now)
        self.runtime_reader = runtime_reader
        self.observe_only = observe_only or not config.get("enabled", False)
        if state_path.exists() or state_path.is_symlink():
            trusted_file(state_path)
            self.state = json.loads(read_bytes(state_path, 128_000))
            if not isinstance(self.state, dict) or self.state.get("schema_version") != 1:
                raise SupervisionError("invalid_state")
        else:
            self.state = {"schema_version": 1, "goal_sha256": config["goal_sha256"],
                          "roots": {}, "notices": {}, "phase": "observing"}
        if self.state.get("goal_sha256") != config["goal_sha256"]:
            raise SupervisionError("foreign_state_goal")

    def adopt_bootstrap(self, engineering: dict):
        bootstrap = self.config.get("bootstrap_receipt_path")
        generation = self.config.get("bootstrap_generation", 0)
        if not bootstrap or (self.state.get("bootstrap_message_id") and self.state.get("bootstrap_generation") == generation):
            return
        path = Path(bootstrap)
        if not path.exists():
            raise SupervisionError("bootstrap_receipt_missing")
        trusted_file(path)
        seed = json.loads(read_bytes(path, 32_000))
        if not seed.get("body_sha256") and not isinstance(seed.get("body"), dict):
            raise SupervisionError("invalid_bootstrap_receipt")
        body_hash = seed.get("body_sha256") or digest(canonical(seed.get("body")))
        binding = STATE.causal_binding(seed, body_hash, STATE.seed_body_type(seed))
        try:
            message_id = str(uuid.UUID(seed["message_id"]))
            key = seed["idempotency_key"]
            published = dt.datetime.fromisoformat(seed["published_at"].replace("Z", "+00:00"))
            if not published.tzinfo or not isinstance(key, str) or not 1 <= len(key) <= 200 or not HEAD.fullmatch(seed["head"]):
                raise ValueError("invalid seed")
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise SupervisionError("invalid_bootstrap_receipt") from error
        if self.state.get("bootstrap_message_id") == message_id:
            raise SupervisionError("bootstrap_generation_unchanged_receipt")
        if self.state.get("active_root"):
            if self.state["active_root"].get("message_id") != message_id:
                raise SupervisionError("bootstrap_root_conflict")
        else:
            baseline = dict(engineering, git_head=seed["head"])
            self.state["active_root"] = {"message_id": message_id, "baseline": baseline,
                                         "reserved_at": published.timestamp(), "bootstrap_key": key, **binding}
            day = published.astimezone(dt.timezone.utc).strftime("%Y-%m-%d")
            self.state["roots"][day] = max(self.state["roots"].get(day, 0) + 1, self.config.get("bootstrap_daily_roots", 1))
        self.state["bootstrap_message_id"] = message_id
        self.state["bootstrap_generation"] = generation
        self.state["phase"] = "root_reserved"
        self.save()

    def save(self):
        if not self.observe_only:
            atomic_save(self.path, self.state)

    def owner_stop(self) -> dict | None:
        stop_file = self.path.parent / "STOP"
        if stop_file.exists() or stop_file.is_symlink():
            trusted_file(stop_file)
            self.state["phase"] = "owner_stopped"
        if self.state["phase"] == "owner_stopped":
            return self.finish("owner_stopped")
        return None

    def finish(self, action: str) -> dict:
        self.state["last_observed_at"] = self.now
        self.state["last_action"] = action
        self.save()
        return {"action": action, "phase": self.state["phase"], "observe_only": self.observe_only}

    def payload(self, key: str, text: str, kind: str | None = None) -> dict:
        body = {"type": "praxis.supervision.notice" if kind else "praxis.supervision.continue", "text": text}
        if kind:
            body["kind"] = kind
        return {"room_id": "grp.hospital", "recipients": [{"tenant_id": "Hospital", "alias": "operador"}],
                "body": body, "lane": "interactive", "priority": 0, "idempotency_key": key}

    def publish(self, reserved: dict) -> bool:
        if self.observe_only:
            return False
        if (reserved["payload"]["body"]["type"] == "praxis.supervision.notice"
                and not STATE.reserve_notice_post(self.state, self.post_clock(), self.config["notice_limit"])):
            return False
        reserved["attempts"] = reserved.get("attempts", 0) + 1
        self.save()
        try:
            receipt = self.api.post(reserved["payload"])
            message_id = receipt.get("message_id")
            if not isinstance(message_id, str) or not uuid.UUID(message_id):
                raise ApiError("invalid_receipt")
            if receipt.get("idempotency_key") != reserved["payload"]["idempotency_key"]:
                raise ApiError("invalid_receipt")
            if receipt.get("tenant_id") != "Hospital" or receipt.get("actor_alias") != "praxis-supervisor":
                raise ApiError("invalid_receipt")
            reserved.update(STATE.causal_binding(receipt, digest(canonical(reserved["payload"]["body"])), reserved["payload"]["body"]["type"]))
            reserved["message_id"] = message_id
            reserved.pop("error", None)
        except (SupervisionError, ValueError) as error:
            reserved["error"] = error.code if isinstance(error, ApiError) else "invalid_receipt"
            reserved["retry_after"] = self.now + self.config["cooldown_seconds"]
        self.save()
        return "message_id" in reserved

    def notice(self, signature: str, kind: str, text: str):
        day = dt.datetime.fromtimestamp(self.now, dt.timezone.utc).strftime("%Y-%m-%d")
        notices = self.state.setdefault("notices", {})
        token = digest(signature.encode())[:24]
        record = notices.get(token)
        if record is not None and not record.get("message_id"):
            if self.now >= record.get("retry_after", 0) and record.get("attempts", 0) < 3:
                self.publish(record)
            return
        if record is not None and (record.get("day") == day or record.get("signature") == signature):
            return
        if self.state.get("notice_post_attempts", {}).get(STATE.utc_day(self.post_clock()), 0) >= self.config["notice_limit"]:
            return
        key = "praxis-notice:" + day + ":" + token
        record = {"day": day, "signature": signature, "payload": self.payload(key, text[:800], kind)}
        notices[token] = record
        self.save()
        self.publish(record)

    def pause(self, reason: str, kind: str = "alert") -> dict:
        self.state["phase"] = "circuit_paused"
        self.state["pause_reason"] = reason
        self.save()
        self.notice(reason, kind, "Praxis: supervisión de ingeniería pausada; causa medida: " + reason
                    + ". El monitor conserva observación; hace falta una decisión o evidencia nueva verificable.")
        return self.finish(reason)

    def refresh_before_post(self) -> dict | None:
        if time.monotonic() >= getattr(self.api, "deadline", float("inf")):
            raise SupervisionError("pass_timeout")
        if self.runtime_reader is None:
            raise SupervisionError("runtime_revalidation_unavailable")
        runtime = self.runtime_reader()
        if time.monotonic() >= getattr(self.api, "deadline", float("inf")):
            raise SupervisionError("pass_timeout")
        if not isinstance(runtime.get("observed_at"), (int, float)) or abs(self.post_clock() - runtime["observed_at"]) > 10:
            raise SupervisionError("stale_runtime_snapshot")
        self.state["observed"]["runtime"] = runtime
        if runtime["active"] or not runtime["ready"]:
            self.state["idle_since"] = self.post_clock()
            return self.finish("active_work" if runtime["active"] else "actors_not_ready")
        return None

    def pass_once(self, runtime: dict, engineering: dict) -> dict:
        stopped = self.owner_stop()
        if stopped is not None:
            return stopped
        self.state["observed"] = {"runtime": runtime, "engineering": engineering}
        if engineering["goal_sha256"] != self.config["goal_sha256"]:
            return self.pause("foreign_goal")
        self.adopt_bootstrap(engineering)
        if STATE.apply_auth_resume_control(self.state, self.path.parent / "RESUME.json", self.config["goal_sha256"], self.post_clock()):
            self.save()
        not_after = self.config.get("certificate_not_after")
        if isinstance(not_after, (int, float)):
            if self.now >= not_after:
                return self.pause("supervisor_certificate_expired")
            if not_after - self.now <= 172800:
                self.notice("supervisor_certificate_renewal", "alert",
                            "Praxis: el certificado propio del supervisor vence en menos de 48 horas; requiere renovación root con el mismo alcance.")
        root = self.state.get("active_root")
        if root:
            if not root.get("message_id"):
                if self.state["phase"] == "circuit_paused":
                    return self.finish("circuit_paused")
                if not runtime["active"] and runtime["ready"] and self.now >= root.get("retry_after", 0) and root.get("attempts", 0) < 3:
                    deferred = self.refresh_before_post()
                    if deferred is not None:
                        return deferred
                    self.publish(root)
                if root.get("error") in CAPACITY_CODES:
                    return self.pause(root["error"])
                if root.get("attempts", 0) >= 3 and not root.get("message_id"):
                    return self.pause("transport_reconciliation_required")
                return self.finish("root_transport_unknown")
            try:
                receipt = self.api.get(root["message_id"])
            except ApiError as error:
                self.state["receipt_error"] = error.code
                if error.code in CAPACITY_CODES:
                    return self.pause(error.code)
                return self.finish("receipt_unavailable")
            deliveries = receipt.get("deliveries")
            if (receipt.get("id") != root["message_id"] or receipt.get("tenant_id") != "Hospital"
                    or receipt.get("actor_alias") != "praxis-supervisor" or receipt.get("room_id") != "grp.hospital"):
                return self.pause("foreign_receipt")
            if not STATE.receipt_matches(receipt, root):
                return self.pause("causal_receipt_mismatch")
            if type(receipt.get("chain_open")) is not bool or not isinstance(deliveries, list) or not deliveries:
                return self.pause("invalid_receipt")
            if any(not isinstance(row, dict) or row.get("status") not in OPEN | TERMINAL for row in deliveries):
                return self.pause("invalid_receipt")
            if receipt["chain_open"] or any(row["status"] in OPEN for row in deliveries):
                return self.finish("root_pending")
            if not self.failure_reader:
                return self.pause("chain_verification_unavailable")
            try:
                chain_code = self.failure_reader(root["message_id"])
            except (SupervisionError, OSError, ValueError, TypeError, KeyError) as error:
                self.state["chain_receipt_error"] = error.code if isinstance(error, SupervisionError) else "chain_verification_unknown"
                return self.pause("chain_receipt_unavailable")
            if chain_code == "chain_still_open":
                return self.finish("root_pending")
            code = typed_failure(receipt) or chain_code
            failed = any(row["status"] != "done" for row in deliveries)
            self.state["last_finished"] = {"at": self.now, "engineering": engineering, "root": root["message_id"]}
            self.state.pop("active_root")
            if code:
                self.state["backoff_until"] = self.now + 21600
                return self.pause(code)
            if failed:
                return self.pause("root_failed_unclassified")
            if not made_progress(root["baseline"], engineering):
                return self.pause("no_measured_progress")
            if self.state["phase"] == "circuit_paused":
                return self.finish("circuit_paused")
            self.state["phase"] = "observing"
            self.state["continuation_earned"] = True
            self.state["cooldown_until"] = self.now + self.config["cooldown_seconds"]
            self.state["idle_since"] = self.now
            return self.finish("root_finished_progress")
        if runtime["active"]:
            self.state["idle_since"] = self.now
            return self.finish("active_work")
        if not runtime["ready"]:
            return self.pause("actors_unavailable")
        if engineering["completion_candidate"]:
            self.state["phase"] = "awaiting_final_review"
            self.save()
            self.notice("final_review:" + engineering["git_head"], "decision_request",
                        "Praxis: 37 incidencias y 216 criterios tienen evidencia aceptada; gates, verificación y publicación coinciden. "
                        "La ingeniería queda pausada para revisión final independiente y aprobación del dueño. El monitor continúa.")
            return self.finish("awaiting_final_review")
        if self.state["phase"] in {"circuit_paused", "awaiting_final_review"}:
            return self.finish(self.state["phase"])
        self.state.setdefault("idle_since", self.now)
        if self.now - self.state["idle_since"] < self.config["idle_seconds"]:
            return self.finish("idle_observation")
        if self.now < max(self.state.get("cooldown_until", 0), self.state.get("backoff_until", 0)):
            return self.finish("cooldown")
        previous = self.state.get("last_finished", {}).get("engineering")
        if previous is not None and not self.state.get("continuation_earned") and not made_progress(previous, engineering):
            return self.pause("no_new_progress")
        day = dt.datetime.fromtimestamp(self.now, dt.timezone.utc).strftime("%Y-%m-%d")
        roots = self.state.setdefault("roots", {})
        if roots.get(day, 0) >= self.config["root_limit"]:
            self.notice("root_fuel:" + day, "digest", "Praxis: límite diario de continuaciones alcanzado; el monitor conserva observación.")
            return self.finish("root_fuel_exhausted")
        deferred = self.refresh_before_post()
        if deferred is not None:
            return deferred
        key = "praxis-engineering:" + self.config["goal_sha256"][:16] + ":" + str(uuid.uuid4())
        roots[day] = roots.get(day, 0) + 1
        self.state["continuation_earned"] = False
        self.state["active_root"] = {"payload": self.payload(key, ROOT_TEXT), "baseline": engineering,
                                     "reserved_at": self.now}
        self.state["phase"] = "root_reserved"
        self.save()
        self.publish(self.state["active_root"])
        if self.state["active_root"].get("error") in CAPACITY_CODES:
            return self.pause(self.state["active_root"]["error"])
        if self.observe_only:
            return self.finish("would_publish_root")
        return self.finish("root_published" if self.state["active_root"].get("message_id") else "root_transport_unknown")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/etc/cauce-v3-hospital/praxis-supervision/config.json"))
    parser.add_argument("--state", type=Path, default=Path("/var/lib/praxis-supervision/state.json"))
    parser.add_argument("--observe-only", action="store_true")
    parser.add_argument("--once", action="store_true", help="Run one pass (also the default)")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(SupervisionError("pass_timeout")))
        signal.alarm(config["pass_seconds"])
        deadline = time.monotonic() + config["pass_seconds"]
        with StateLock(args.state.parent / "pass.lock"):
            supervisor = Supervisor(config, args.state, Api(config, deadline), time.time(), args.observe_only,
                                    lambda message_id: root_failure_metadata(config, message_id, deadline), post_clock=time.time,
                                    runtime_reader=lambda: runtime_snapshot(config, deadline))
            try:
                result = supervisor.owner_stop()
                if result is None:
                    engineering = engineering_snapshot(config, deadline)
                    config["certificate_not_after"] = certificate_expiry(config)
                    runtime = runtime_snapshot(config, deadline)
                    result = supervisor.pass_once(runtime, engineering)
            except (SupervisionError, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
                code = error.code if isinstance(error, SupervisionError) else "observation_invalid"
                result = supervisor.pause(code)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (SupervisionError, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
        code = error.code if isinstance(error, SupervisionError) else "configuration_unavailable"
        print(json.dumps({"action": code, "phase": "unavailable"}, sort_keys=True))
        return 0 if code == "already_running" else 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
