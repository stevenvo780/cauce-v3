#!/usr/bin/env python3
"""Run one bounded supervision pass; durable deliveries remain owned by Cauce."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
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
TRANSIENT_OBSERVATION_CODES = {"pass_timeout", "observation_unavailable", "chain_receipt_unavailable", "preview_activity_changed"}
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
    "evitá microflags. Elegí un criterio íntegro del SDD, actualizá "
    "su evidencia y dejá el siguiente criterio ejecutable o su bloqueo medido. "
    "next_work orienta; no obliga a repetir ni reemplaza elegir ingeniería independiente. "
    "Gobernanza se registra en paralelo, no sustituye código probado. "
    "Después de integrar y commitear el código canónico, el operador consulta --help "
    "y ejecuta /opt/praxis-qa-venv/bin/python -B /home/node/clawd/.cauce/runtime/praxis-proof.py "
    "con --workspace, --output, --artifact-prefix y --install-evidence, y --qa cuando "
    "corresponda; luego revisa imágenes independientes y sus hashes. Los developers "
    "pueden usar Python estándar para unidades sin navegador. Usá ese productor "
    "para renovar pruebas y snapshot con su contrato v2, "
    "comandos reales y hashes de los módulos y pruebas ejecutados. N/A requiere "
    "justificación explícita y no acredita una prueba aprobada. Comprobá pruebas, "
    "QA y snapshot antes de publicar con la "
    "autorización durable vigente. Los criterios clínicos o legales pendientes "
    "requieren decisión del dueño y sólo bloquean esa parte. No declarés el producto "
    "terminado por labels o entregas done. No leas datos clínicos privados ni secretos. "
    "El controlador publica el destino real del preview sintético con la autorización "
    "vigente; no requiere repetir un pedido humano de publicación. "
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
EVIDENCE_SPEC = importlib.util.spec_from_file_location("praxis_supervision_evidence", Path(__file__).with_name("praxis-supervision-evidence.py"))
EVIDENCE = importlib.util.module_from_spec(EVIDENCE_SPEC)
EVIDENCE_SPEC.loader.exec_module(EVIDENCE)
PREVIEW_SPEC = importlib.util.spec_from_file_location("praxis_supervision_preview", Path(__file__).with_name("praxis-supervision-preview.py"))
PREVIEW = importlib.util.module_from_spec(PREVIEW_SPEC)
PREVIEW_SPEC.loader.exec_module(PREVIEW)
REVIEW_SPEC = importlib.util.spec_from_file_location("praxis_supervision_review", Path(__file__).with_name("praxis-supervision-review.py"))
REVIEW = importlib.util.module_from_spec(REVIEW_SPEC)
REVIEW_SPEC.loader.exec_module(REVIEW)
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
    EVIDENCE.acceptance_path(config, STATE)
    PREVIEW.validate_config(config, STATE)
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
    return EVIDENCE.records(path, config, name, STATE)


def roadmap_records(path: Path, goal_hash: str) -> dict[str, str]:
    _, criteria = EVIDENCE.roadmap_document(path, goal_hash, STATE)
    return {key: "accepted" for key in criteria}


def evidence_records(value: dict, name: str, expected: dict, workspace: Path) -> set[str]:
    reader = EVIDENCE.EvidenceReader(workspace, STATE)
    entries = value.get(name, [])
    if not isinstance(entries, list) or len(entries) > 1000:
        return set()
    return {entry["id"] for entry in entries if isinstance(entry, dict) and entry.get("id") in expected
            and entry.get("outcome") in EVIDENCE.PASSED and EVIDENCE.artifact_list(entry, value.get("schema_version", 1))
            and all(reader.read_artifact(artifact) is not None
                    for artifact in EVIDENCE.artifact_list(entry, value.get("schema_version", 1)))}


def criterion_evidence(value: dict, roadmap: dict, workspace: Path, commit_verified) -> set[str]:
    reader = EVIDENCE.EvidenceReader(workspace, STATE, commit_verified)
    return reader.accepted_records(value, roadmap, {})[1]


def engineering_snapshot(config: dict, deadline: float) -> dict:
    return EVIDENCE.engineering_snapshot(config, deadline, run_command, STATE)


def made_progress(previous: dict, current: dict) -> bool:
    return EVIDENCE.made_progress(previous, current)


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
            if state_path.stat().st_size > STATE.STATE_MAX_BYTES:
                raise SupervisionError("state_too_large")
            self.state = json.loads(read_bytes(state_path, STATE.STATE_MAX_BYTES))
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
        else:
            body["supervision"] = {"version": 2, "goal_sha256": self.config["goal_sha256"],
                                   "authority": "existing_owner_goal", "evidence_contract": 2,
                                   "next_work": self.state.get("next_work")}
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
        if reason in {"no_measured_progress", "no_new_progress"} and not self.state.get("progress_pause_binding"):
            self.state["progress_pause_baseline"] = self.state.get("observed", {}).get("engineering", {})
        self.save()
        self.notice(reason, kind, "Praxis: supervisión de ingeniería pausada; causa medida: " + reason
                    + ". El monitor conserva observación; hace falta una decisión o evidencia nueva verificable.")
        return self.finish(reason)

    def observation_failure(self, reason: str) -> dict:
        self.state["observation_failure"] = {"code": reason, "at": self.now,
            "root": self.state.get("active_root", {}).get("message_id")}
        return self.finish(reason)

    def review_contract_incomplete(self, root: dict) -> dict:
        STATE.record_review_contract_incomplete(self.state, root["review_cohort"], root["message_id"], self.now)
        self.notice_review_contract_failure()
        return self.finish("review_contract_incomplete")

    def notice_review_contract_failure(self):
        failure = self.state.get("review_contract_failure", {})
        if not failure.get("root"):
            return
        self.notice("review_contract_incomplete:" + failure["root"], "alert",
            "Praxis: la entrega de revisión cerró sin contrato QA independiente vigente. El operador debe abrir las capturas, "
            "registrar observaciones reales y persistirlas con praxis-qa-review.py --help; si falta herramienta, debe informar "
            "su código técnico. Se conserva la raíz original y no se repite la petición por tiempo transcurrido.")

    def request_visual_review(self, engineering: dict) -> dict:
        return REVIEW.request_visual_review(self, engineering, STATE, CAPACITY_CODES)

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
        self.state["next_work"] = engineering.get("next_work")
        self.adopt_bootstrap(engineering)
        if STATE.apply_auth_resume_control(self.state, self.path.parent / "RESUME.json", self.config["goal_sha256"], self.post_clock()):
            self.save()
        if STATE.resume_measured_progress(self.state, engineering, self.now, made_progress):
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
                if isinstance(error, SupervisionError) and error.code == "chain_verification_unknown":
                    return self.pause("chain_verification_unknown")
                return self.observation_failure("chain_receipt_unavailable")
            if chain_code == "chain_still_open":
                return self.finish("root_pending")
            code = typed_failure(receipt) or chain_code
            failed = any(row["status"] != "done" for row in deliveries)
            if self.state["phase"] == "circuit_paused" and not code and not failed:
                if self.state.get("pause_reason") not in TRANSIENT_OBSERVATION_CODES:
                    return self.finish("circuit_paused")
                recoveries = self.state.setdefault("observation_recoveries", [])
                recoveries.append({"at": self.now, "reason": self.state["pause_reason"], "root": root["message_id"],
                    "binding": {key: root[key] for key in ("request_id", "trace_id", "delivery_ids", "body_sha256", "body_type")}})
                del recoveries[:-24]
                self.state["phase"] = "root_reserved"
            if root.get("purpose") == "visual_review":
                self.state["visual_review_requests"][root["review_cohort"]].update(status="closed", message_id=root["message_id"])
                self.state["last_review_finished"] = {"at": self.now, "root": root["message_id"], "cohort_sha256": root["review_cohort"]}
                self.state.pop("active_root")
                if code or failed:
                    return self.pause(code or "visual_review_failed")
                self.state["phase"] = "waiting_visual_review"
                if (STATE.restore_earned_review_credit(self.state, engineering, self.now)
                        or STATE.recover_reviewed_progress(self.state, engineering, self.now, made_progress)):
                    self.state["visual_review_requests"][root["review_cohort"]]["contract_status"] = "completed"
                    return self.finish("visual_review_completed")
                if not STATE.reviewed_engineering_current(self.state, engineering):
                    return self.review_contract_incomplete(root)
                return self.finish("visual_review_completed_no_progress" if STATE.classify_reviewed_without_progress(self.state, engineering)
                                   else "visual_review_pending")
            action = STATE.close_engineering_root(self.state, root, engineering, self.now, self.config["cooldown_seconds"], code, failed, made_progress)
            return self.pause(action) if code or failed or action == "no_measured_progress" else self.finish(action)
        if runtime["active"]:
            self.state["idle_since"] = self.now
            return self.finish("active_work")
        if not runtime["ready"]:
            if self.state["phase"] == "circuit_paused" and self.state.get("pause_reason") != "actors_unavailable":
                return self.finish("circuit_paused")
            self.state["idle_since"] = self.now
            return self.pause("actors_unavailable")
        if self.state["phase"] == "circuit_paused" and self.state.get("pause_reason") == "actors_unavailable":
            if (not isinstance(runtime.get("observed_at"), (int, float)) or abs(self.now - runtime["observed_at"]) > 30
                    or self.now - self.state.get("idle_since", self.now) < self.config["idle_seconds"]):
                return self.finish("actors_readiness_pending")
            self.state["phase"] = "observing"
            self.state.setdefault("readiness_recoveries", []).append({"at": self.now, "reason": "actors_unavailable"})
            del self.state["readiness_recoveries"][:-24]
            self.save()
        if STATE.recover_failed_visual_review(self.state, engineering, runtime, self.now, self.config["idle_seconds"], made_progress):
            return self.finish("visual_review_failed_recovered")
        remediation = REVIEW.request_qa_remediation(self, engineering, runtime, STATE, CAPACITY_CODES, ROOT_TEXT)
        if remediation is not None:
            return remediation
        if STATE.visual_review_pending(engineering) and (self.state["phase"] in {"observing", "waiting_visual_review"}
                or self.state.get("pause_reason") in {"no_measured_progress", "no_new_progress"}):
            return self.request_visual_review(engineering)
        if (isinstance(runtime.get("observed_at"), (int, float)) and abs(self.now - runtime["observed_at"]) <= 30
                and self.now - self.state.get("idle_since", self.now) >= self.config["idle_seconds"]
                and STATE.reconcile_review_cohort(self.state, engineering, self.now, made_progress)):
            self.save()
        if (STATE.restore_earned_review_credit(self.state, engineering, self.now)
                or STATE.recover_reviewed_progress(self.state, engineering, self.now, made_progress)):
            self.save()
        if STATE.classify_reviewed_without_progress(self.state, engineering):
            return self.finish("visual_review_completed_no_progress")
        if self.state["phase"] == "waiting_visual_review":
            STATE.diagnose_legacy_review_contract(self.state, engineering, self.now)
            self.notice_review_contract_failure()
            return self.finish("review_contract_incomplete" if self.state.get("review_contract_failure")
                               else "visual_review_pending")
        if engineering["completion_candidate"]:
            self.state["phase"] = "awaiting_final_review"
            self.save()
            self.notice("final_review:" + engineering["git_head"], "decision_request",
                        "Praxis: 37 incidencias y 216 criterios tienen evidencia aceptada; gates, verificación y publicación coinciden. "
                        "La ingeniería queda pausada para revisión final independiente y aprobación del dueño. El monitor continúa.")
            return self.finish("awaiting_final_review")
        if engineering.get("technical_milestone_candidate"):
            self.state["phase"] = "awaiting_technical_review"
            self.save()
            self.notice("technical_review:" + engineering["git_head"], "decision_request",
                        "Praxis: los criterios tienen prueba técnica específica y gates vigentes. "
                        "Se requiere revisión del hito técnico; la aceptación humana del GOAL permanece sin recibo autenticado.")
            return self.finish("awaiting_technical_review")
        if self.state["phase"] in {"circuit_paused", "awaiting_final_review", "awaiting_technical_review"}:
            return self.finish(self.state["phase"])
        self.state.setdefault("idle_since", self.now)
        if self.now - self.state["idle_since"] < self.config["idle_seconds"]:
            return self.finish("idle_observation")
        if self.now < max(self.state.get("cooldown_until", 0), self.state.get("backoff_until", 0)):
            return self.finish("cooldown")
        previous = self.state.get("last_finished", {}).get("engineering")
        if (previous is not None and not self.state.get("continuation_earned")
                and not self.state.get("auth_retry_earned") and not made_progress(previous, engineering)):
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
        self.state.pop("earned_continuation_origin", None)
        held = self.state.get("review_held_continuation", {})
        if held.get("status") == "restored":
            held.update(status="consumed", consumed_at=self.now, consumed_by=key)
        self.state["auth_retry_earned"] = False
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
                    if (supervisor.state["phase"] in {"observing", "root_reserved", "waiting_visual_review"}
                            or supervisor.state.get("pause_reason") in {"no_measured_progress", "no_new_progress"}):
                        publication = PREVIEW.publish(config, engineering, runtime, deadline, STATE, run_command,
                            lambda: runtime_snapshot(config, deadline),
                            EVIDENCE.EvidenceReader(Path(config["workspace"]), STATE).source_matches, supervisor.observe_only)
                        supervisor.state["preview_publication"] = publication
                        if publication["action"] == "preview_published":
                            engineering = engineering_snapshot(config, deadline)
                            runtime = runtime_snapshot(config, deadline)
                    result = supervisor.pass_once(runtime, engineering)
            except (SupervisionError, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
                code = error.code if isinstance(error, SupervisionError) else "observation_invalid"
                if code.startswith("preview_"):
                    supervisor.state["preview_failure"] = {"code": code, **getattr(error, "preview_diagnostics", {})}
                result = supervisor.observation_failure(code) if code in TRANSIENT_OBSERVATION_CODES else supervisor.pause(code)
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
