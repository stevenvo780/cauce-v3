"""Protect supervisor controls and atomically preserve causal state."""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import stat
import tempfile
import uuid
from pathlib import Path

# cauce:requiere none

class SupervisionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def command_identity(command: list[str]) -> dict:
    if command[:2] != ["git", "-C"]:
        return {}
    owner = Path(command[2]).stat()
    if owner.st_uid == 0:
        raise SupervisionError("git_workspace_requires_unprivileged_owner")
    if os.geteuid() != 0:
        raise SupervisionError("git_requires_actor_isolation")
    if command[2] != "/opt/hospital-agent/runtime/praxis/operator" or owner.st_uid != 1000:
        raise SupervisionError("git_workspace_requires_actor_isolation")
    return {}


def isolated_command(command: list[str]) -> list[str]:
    if command[:2] != ["git", "-C"]:
        return command
    command_identity(command)
    return ["docker", "exec", "-u", "1000:1000", "hospital-agent-openclaw-operator-gateway-1",
            "git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C",
            "/home/node/.openclaw/workspace/praxis", *command[3:]]


def trusted_file(path: Path, directory: bool = False) -> None:
    metadata = path.lstat()
    valid_type = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not valid_type or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise SupervisionError("untrusted_control_file")


def readonly_descriptor(path: Path) -> int:
    absolute = Path(os.path.abspath(path))
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in absolute.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(absolute.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    except OSError as error:
        raise SupervisionError("unsafe_artifact") from error
    finally:
        os.close(directory)


def read_bytes(path: Path, maximum: int = 4_000_000) -> bytes:
    descriptor = readonly_descriptor(path)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > maximum:
            raise SupervisionError("unsafe_artifact")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise SupervisionError("artifact_too_large")
        return data
    finally:
        os.close(descriptor)


def scoped(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise SupervisionError("artifact_scope")
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()):
        raise SupervisionError("artifact_scope")
    if any(part.lower() in {".env", "secrets", "credentials", "sessions", ".git"}
           for part in Path(relative).parts):
        raise SupervisionError("artifact_scope")
    if (path.name.endswith((".token", ".key")) or path.name.startswith(".env")
            or path.name in {"auth.json", "settings.local.json"}):
        raise SupervisionError("artifact_scope")
    return path


def atomic_save(path: Path, value: dict) -> None:
    trusted_file(path.parent, directory=True)
    if path.exists() or path.is_symlink():
        trusted_file(path)
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class StateLock:
    def __init__(self, path: Path):
        self.path = path
        self.fd = None

    def __enter__(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        trusted_file(self.path.parent, directory=True)
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            trusted_file(self.path)
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            os.close(self.fd)
            self.fd = None
            raise SupervisionError("already_running") from error
        except (SupervisionError, OSError):
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)


def utc_day(now: float) -> str:
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y-%m-%d")


def reserve_notice_post(state: dict, now: float, limit: int) -> bool:
    day = utc_day(now)
    attempts = state.setdefault("notice_post_attempts", {})
    count = attempts.get(day, 0)
    if type(count) is not int or count < 0:
        raise SupervisionError("invalid_notice_fuel")
    if count >= limit:
        return False
    attempts[day] = count + 1
    return True


def seed_body_type(seed: dict) -> str:
    body = seed.get("body")
    encoded = body.get("type") if isinstance(body, dict) else None
    declared = seed.get("body_type")
    if declared and encoded and declared != encoded:
        raise SupervisionError("invalid_bootstrap_type")
    expected = declared or encoded
    if expected not in {"request", "praxis.supervision.continue"}:
        raise SupervisionError("invalid_bootstrap_type")
    return expected


def causal_binding(receipt: dict, body_hash: str, body_type: str) -> dict:
    try:
        request_id = str(uuid.UUID(receipt["request_id"]))
        delivery_ids = receipt["delivery_ids"]
        trace_id = receipt["trace_id"]
        if (not isinstance(delivery_ids, list) or len(delivery_ids) != 1
                or not isinstance(trace_id, str) or not 1 <= len(trace_id) <= 256
                or any(ord(char) < 32 for char in trace_id) or not re.fullmatch(r"[a-f0-9]{64}", body_hash)):
            raise ValueError("invalid binding")
        delivery_ids = [str(uuid.UUID(identifier)) for identifier in delivery_ids]
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise SupervisionError("invalid_causal_binding") from error
    return {"request_id": request_id, "trace_id": trace_id, "delivery_ids": delivery_ids,
            "body_sha256": body_hash, "body_type": body_type}


def receipt_matches(receipt: dict, root: dict) -> bool:
    deliveries = receipt.get("deliveries")
    if not isinstance(deliveries, list) or len(deliveries) != 1:
        return False
    body = receipt.get("body")
    expected_type = root.get("body_type")
    if (expected_type not in {"request", "praxis.supervision.continue"}
            or not isinstance(body, dict) or body.get("type") != expected_type):
        return False
    if (receipt.get("request_id") != root.get("request_id") or receipt.get("trace_id") != root.get("trace_id")
            or not root.get("body_sha256") or digest(canonical(body)) != root["body_sha256"]):
        return False
    return (all(isinstance(row, dict) and row.get("tenant_id") == "Hospital" and row.get("alias") == "operador"
                for row in deliveries)
            and [row.get("delivery_id") for row in deliveries] == root.get("delivery_ids"))


def auth_resume_event(goal_hash: str, now: float) -> dict:
    if not re.fullmatch(r"[a-f0-9]{64}", goal_hash):
        raise SupervisionError("invalid_goal_digest")
    return {"schema_version": 1, "goal_sha256": goal_hash, "reason": "provider_reauthenticated",
            "nonce": str(uuid.uuid4()), "created_at": dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat().replace("+00:00", "Z")}


def resumable_reservation(root: object, goal_hash: str) -> bool:
    if not isinstance(root, dict) or "message_id" in root or root.get("error") != "unauthorized":
        return False
    attempts = root.get("attempts")
    payload, baseline = root.get("payload"), root.get("baseline")
    if (type(attempts) is not int or not 1 <= attempts < 3 or not isinstance(payload, dict)
            or not isinstance(baseline, dict) or baseline.get("goal_sha256") != goal_hash):
        return False
    body = payload.get("body")
    key = payload.get("idempotency_key")
    if (not isinstance(body, dict) or body.get("type") != "praxis.supervision.continue"
            or not isinstance(key, str)
            or payload.get("room_id") != "grp.hospital"
            or payload.get("recipients") != [{"tenant_id": "Hospital", "alias": "operador"}]):
        return False
    if root.get("purpose") == "visual_review":
        supervision = body.get("supervision")
        cohort, review = root.get("review_cohort"), baseline.get("qa_review")
        return (isinstance(supervision, dict) and supervision.get("version") == 2
                and supervision.get("goal_sha256") == goal_hash and supervision.get("purpose") == "visual_review"
                and isinstance(cohort, str) and re.fullmatch(r"[a-f0-9]{64}", cohort) is not None
                and isinstance(review, dict) and review.get("cohort_sha256") == cohort
                and supervision.get("visual_review") == review
                and key == f"praxis-visual-review:{goal_hash[:16]}:{cohort}")
    prefix = f"praxis-engineering:{goal_hash[:16]}:"
    if not key.startswith(prefix):
        return False
    try:
        nonce = uuid.UUID(key[len(prefix):])
        return nonce.version == 4 and str(nonce) == key[len(prefix):]
    except ValueError:
        return False


def consume_auth_resume(state: dict, path: Path, goal_hash: str, now: float) -> bool:
    if state.get("phase") != "circuit_paused" or state.get("pause_reason") != "unauthorized":
        return False
    root = state.get("active_root")
    if root is not None and not resumable_reservation(root, goal_hash):
        return False
    if not path.exists() and not path.is_symlink():
        return False
    trusted_file(path.parent, directory=True)
    trusted_file(path)
    if stat.S_IMODE(path.lstat().st_mode) != 0o600:
        raise SupervisionError("untrusted_resume_mode")
    value = json.loads(read_bytes(path, 8192))
    required = {"schema_version", "goal_sha256", "reason", "nonce", "created_at"}
    try:
        if (not isinstance(value, dict) or set(value) != required or type(value["schema_version"]) is not int
                or value["schema_version"] != 1 or value["goal_sha256"] != goal_hash
                or value["reason"] != "provider_reauthenticated"):
            raise ValueError("invalid resume scope")
        nonce = uuid.UUID(value["nonce"])
        if nonce.version != 4 or str(nonce) != value["nonce"]:
            raise ValueError("invalid resume nonce")
        created = dt.datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
        if not created.tzinfo:
            raise ValueError("invalid resume timestamp")
        consumed = state.get("auth_resume_nonces", [])
        if value["nonce"] in consumed:
            return False
        if not 0 <= now - created.timestamp() <= 86400:
            raise ValueError("expired resume event")
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise SupervisionError("invalid_auth_resume") from error
    record = {"nonce": value["nonce"], "created_at": value["created_at"], "consumed_at": now,
              "pause_reason": state["pause_reason"], "backoff_until": state.get("backoff_until"),
              "failed_root": state.get("last_finished", {}).get("root")}
    state.setdefault("auth_resume_nonces", []).append(value["nonce"])
    state.setdefault("auth_recoveries", []).append(record)
    if root is not None:
        record["reserved_key"] = root["payload"]["idempotency_key"]
        record["reservation_error"] = root.pop("error")
    state["phase"] = "root_reserved" if root is not None else "observing"
    if root is not None:
        state["continuation_earned"] = False
    else:
        state["auth_retry_earned"] = True
    state.pop("backoff_until", None)
    return True


def apply_auth_resume_control(state: dict, path: Path, goal_hash: str, now: float) -> bool:
    try:
        return consume_auth_resume(state, path, goal_hash, now)
    except (SupervisionError, OSError, ValueError, TypeError, AttributeError, RecursionError) as error:
        code = error.code if isinstance(error, SupervisionError) else "invalid_auth_resume"
        state["auth_resume_rejection"] = {"code": code, "observed_at": now}
        return False


def resume_measured_progress(state: dict, engineering: dict, now: float, made_progress) -> bool:
    if (state.get("phase") != "circuit_paused" or state.get("active_root")
            or state.get("pause_reason") not in {"no_measured_progress", "no_new_progress"}
            or engineering.get("goal_sha256") != state.get("goal_sha256")
            or engineering.get("verified_engineering") is not True or visual_review_pending(engineering)):
        return False
    previous = state.get("progress_pause_baseline", state.get("last_finished", {}).get("engineering"))
    if not isinstance(previous, dict) or not made_progress(previous, engineering):
        return False
    recoveries = state.setdefault("progress_recoveries", [])
    recoveries.append({"at": now, "reason": state["pause_reason"], "root": state.get("last_finished", {}).get("root"),
                       "baseline_sha256": digest(canonical(previous)), "evidence_sha256": digest(canonical(engineering))})
    del recoveries[:-24]
    state["phase"] = "observing"
    state["continuation_earned"] = True
    state.pop("progress_pause_baseline", None)
    return True


def visual_review_pending(engineering: dict) -> bool:
    return (engineering.get("verified_engineering") is True and engineering.get("qa_executed") is True
            and engineering.get("gate_rejections", {}).get("qa") == "independent_visual_review_pending"
            and isinstance(engineering.get("qa_review"), dict))


def preserve_progress_baseline(state: dict, root: dict) -> None:
    baseline = root.get("baseline")
    if root.get("purpose") == "visual_review" or not isinstance(baseline, dict):
        return
    state["progress_pause_baseline"] = baseline
    state["progress_pause_binding"] = {"root": root.get("message_id"), "goal_sha256": state["goal_sha256"],
        "baseline_sha256": digest(canonical(baseline)),
        **{key: root[key] for key in ("request_id", "trace_id", "delivery_ids", "body_sha256", "body_type") if key in root}}


def reviewed_engineering_current(state: dict, engineering: dict) -> bool:
    review = engineering.get("qa_review")
    return (engineering.get("goal_sha256") == state.get("goal_sha256")
            and engineering.get("verified_engineering") is True
            and engineering.get("verification_source_current") is True
            and engineering.get("source_files_match") is True
            and {"qa", "tests", "snapshot"}.issubset(engineering.get("valid_gates", []))
            and isinstance(review, dict) and review.get("goal_sha256") == state.get("goal_sha256")
            and re.fullmatch(r"[a-f0-9]{64}", str(review.get("cohort_sha256", ""))) is not None
            and review.get("source_files") == engineering.get("source_hashes"))


def progress_baseline_bound(state: dict) -> bool:
    baseline, binding = state.get("progress_pause_baseline"), state.get("progress_pause_binding", {})
    if (not isinstance(baseline, dict) or baseline.get("goal_sha256") != state.get("goal_sha256")
            or binding.get("goal_sha256") != state.get("goal_sha256")
            or binding.get("baseline_sha256") != digest(canonical(baseline))
            or binding.get("root") != state.get("last_finished", {}).get("root")
            or binding.get("body_type") not in {"request", "praxis.supervision.continue"}):
        return False
    try:
        uuid.UUID(binding["root"])
        validated = causal_binding(binding, binding["body_sha256"], binding["body_type"])
        return validated == state.get("last_finished", {}).get("binding")
    except (KeyError, ValueError, TypeError, AttributeError, SupervisionError):
        return False


def held_review_credit_bound(state: dict, engineering: dict) -> bool:
    held, finished = state.get("review_held_continuation", {}), state.get("last_finished", {})
    measured, binding = finished.get("engineering", {}), held.get("binding", {})
    if (held.get("status") != "held" or held.get("goal_sha256") != state.get("goal_sha256")
            or held.get("source_sha256") != code_fingerprint(engineering)
            or finished.get("root") != held.get("root") or finished.get("binding") != binding
            or binding.get("body_type") not in {"request", "praxis.supervision.continue"}
            or measured.get("goal_sha256") != state.get("goal_sha256") or measured.get("verified_engineering") is not True
            or code_fingerprint(measured) != held.get("source_sha256")):
        return False
    try:
        root = str(uuid.UUID(held["root"]))
        binding = causal_binding(held["binding"], held["binding"]["body_sha256"], held["binding"]["body_type"])
        return held.get("credit_id") == digest(canonical({"root": root, "binding": binding, "goal_sha256": state["goal_sha256"]}))
    except (KeyError, ValueError, TypeError, AttributeError, SupervisionError):
        return False


def reconcile_review_cohort(state: dict, engineering: dict, now: float, made_progress) -> bool:
    pending, current = state.get("pending_visual_review"), engineering.get("qa_review")
    if (state.get("phase") != "waiting_visual_review" or state.get("active_root")
            or not isinstance(pending, dict) or not reviewed_engineering_current(state, engineering)
            or pending.get("goal_sha256") != state.get("goal_sha256")
            or pending.get("cohort_sha256") == current.get("cohort_sha256")):
        return False
    held = held_review_credit_bound(state, engineering)
    progressed = progress_baseline_bound(state) and made_progress(state["progress_pause_baseline"], engineering)
    if not held and not progressed:
        return False
    record = {"at": now, "old_cohort_sha256": pending["cohort_sha256"], "cohort_sha256": current["cohort_sha256"],
        "root": state.get("last_finished", {}).get("root"), "goal_sha256": state["goal_sha256"],
        "binding": state.get("last_finished", {}).get("binding"), "evidence_sha256": digest(canonical(engineering))}
    if held:
        record["credit_id"] = state["review_held_continuation"]["credit_id"]
    records = state.setdefault("visual_review_reconciliations", [])
    records.append(record)
    del records[:-24]
    state["pending_visual_review"] = current
    return True


def recover_reviewed_progress(state: dict, engineering: dict, now: float, made_progress) -> bool:
    pending = state.get("pending_visual_review")
    current = engineering.get("qa_review")
    baseline = state.get("progress_pause_baseline")
    if (state.get("phase") != "waiting_visual_review" or state.get("active_root") or not isinstance(pending, dict)
            or not isinstance(current, dict) or pending.get("cohort_sha256") != current.get("cohort_sha256")
            or not reviewed_engineering_current(state, engineering) or not progress_baseline_bound(state)
            or not made_progress(baseline, engineering)):
        return False
    state.setdefault("progress_recoveries", []).append({"at": now, "reason": "visual_review_completed",
        "root": state.get("progress_pause_binding", {}).get("root"), "cohort_sha256": current["cohort_sha256"],
        "baseline_sha256": digest(canonical(baseline)), "evidence_sha256": digest(canonical(engineering))})
    state["phase"], state["continuation_earned"] = "observing", True
    state["idle_since"], state["cooldown_until"] = now, now + state.get("review_cooldown_seconds", 1200)
    state.pop("pending_visual_review", None)
    return True


def recover_failed_visual_review(state: dict, engineering: dict, runtime: dict, now: float, idle_seconds: int, made_progress) -> bool:
    pending, finished = state.get("pending_visual_review"), state.get("last_review_finished", {})
    if (state.get("phase") != "circuit_paused" or state.get("pause_reason") != "visual_review_failed"
            or state.get("active_root") or runtime.get("active") != 0 or runtime.get("ready") is not True
            or not isinstance(runtime.get("observed_at"), (int, float)) or abs(now - runtime["observed_at"]) > 30
            or now - state.get("idle_since", now) < idle_seconds or not isinstance(pending, dict)
            or type(finished.get("at")) not in {int, float} or now - finished["at"] < idle_seconds
            or (isinstance(runtime.get("last_activity_at"), (int, float)) and now - runtime["last_activity_at"] < idle_seconds)
            or pending.get("goal_sha256") != state.get("goal_sha256")
            or not re.fullmatch(r"[a-f0-9]{64}", str(pending.get("cohort_sha256", "")))
            or finished.get("cohort_sha256") != pending["cohort_sha256"]
            or not reviewed_engineering_current(state, engineering) or not progress_baseline_bound(state)
            or not made_progress(state["progress_pause_baseline"], engineering)):
        return False
    request = state.get("visual_review_requests", {}).get(pending["cohort_sha256"], {})
    try:
        failed_root = str(uuid.UUID(finished["root"]))
    except (KeyError, ValueError, TypeError, AttributeError):
        return False
    if request.get("status") != "closed" or request.get("message_id") != failed_root:
        return False
    binding = state["progress_pause_binding"]
    credit_id = digest(canonical({"failed_review_root": failed_root, "binding": binding, "goal_sha256": state["goal_sha256"]}))
    recoveries = state.get("visual_review_failure_recoveries", [])
    if any(record.get("credit_id") == credit_id for record in recoveries):
        return False
    state["phase"] = "waiting_visual_review"
    reconcile_review_cohort(state, engineering, now, made_progress)
    if not recover_reviewed_progress(state, engineering, now, made_progress):
        state["phase"] = "circuit_paused"
        return False
    record = {"at": now, "reason": "visual_review_failed", "credit_id": credit_id, "failed_review_root": failed_root,
        "root": binding["root"], "binding": binding, "goal_sha256": state["goal_sha256"],
        "cohort_sha256": engineering["qa_review"]["cohort_sha256"], "evidence_sha256": digest(canonical(engineering))}
    state.setdefault("visual_review_failure_recoveries", []).append(record)
    del state["visual_review_failure_recoveries"][:-24]
    return True


def classify_reviewed_without_progress(state: dict, engineering: dict) -> bool:
    pending, current = state.get("pending_visual_review"), engineering.get("qa_review")
    if (state.get("phase") != "waiting_visual_review" or not isinstance(pending, dict) or not isinstance(current, dict)
            or pending.get("cohort_sha256") != current.get("cohort_sha256") or "qa" not in engineering.get("valid_gates", [])):
        return False
    state["phase"], state["pause_reason"], state["continuation_earned"] = "circuit_paused", "no_measured_progress", False
    return True


def code_fingerprint(engineering: dict) -> str | None:
    sources = engineering.get("source_hashes", {})
    if not isinstance(sources, dict):
        return None
    code = {path: sha for path, sha in sources.items() if Path(path).suffix in {".py", ".mjs", ".js", ".css", ".html"}}
    return digest(canonical(code)) if code and all(re.fullmatch(r"[a-f0-9]{64}", str(sha)) for sha in code.values()) else None


def hold_earned_review_credit(state: dict, engineering: dict, now: float) -> bool:
    finished, existing, origin = state.get("last_finished", {}), state.get("review_held_continuation", {}), state.get("earned_continuation_origin", {})
    recorded_origin = (origin.get("root") == finished.get("root") and origin.get("binding") == finished.get("binding")
                       and origin.get("goal_sha256") == state.get("goal_sha256")
                       and origin.get("source_sha256") == code_fingerprint(engineering))
    if (state.get("phase") != "observing" or state.get("continuation_earned") is not True
            or (state.get("last_action") != "root_finished_progress" and existing.get("status") != "restored" and not recorded_origin)):
        return False
    measured, binding = finished.get("engineering", {}), finished.get("binding", {})
    if (measured.get("goal_sha256") != state.get("goal_sha256") or measured.get("verified_engineering") is not True
            or code_fingerprint(measured) is None or code_fingerprint(measured) != code_fingerprint(engineering)
            or binding.get("body_type") not in {"request", "praxis.supervision.continue"}):
        return False
    try:
        root = str(uuid.UUID(finished["root"]))
        validated = causal_binding(binding, binding["body_sha256"], binding["body_type"])
    except (KeyError, ValueError, TypeError, AttributeError, SupervisionError):
        return False
    token = digest(canonical({"root": root, "binding": validated, "goal_sha256": state["goal_sha256"]}))
    if existing.get("credit_id") == token and existing.get("status") == "consumed":
        return False
    state["review_held_continuation"] = {"credit_id": token, "status": "held", "held_at": now,
        "root": root, "binding": validated, "goal_sha256": state["goal_sha256"],
        "source_sha256": code_fingerprint(engineering), "cohort_sha256": engineering["qa_review"]["cohort_sha256"]}
    return True


def restore_earned_review_credit(state: dict, engineering: dict, now: float) -> bool:
    held, current, pending = state.get("review_held_continuation", {}), engineering.get("qa_review"), state.get("pending_visual_review")
    reconciled = any(record.get("credit_id") == held.get("credit_id")
        and record.get("old_cohort_sha256") == held.get("cohort_sha256")
        and record.get("cohort_sha256") == (current or {}).get("cohort_sha256")
        and record.get("binding") == held.get("binding") and record.get("root") == held.get("root")
        and record.get("goal_sha256") == state.get("goal_sha256") for record in state.get("visual_review_reconciliations", []))
    if (state.get("phase") != "waiting_visual_review" or state.get("active_root") or held.get("status") != "held"
            or not isinstance(current, dict) or not isinstance(pending, dict) or not reviewed_engineering_current(state, engineering)
            or not held_review_credit_bound(state, engineering)
            or held.get("goal_sha256") != state.get("goal_sha256") or held.get("source_sha256") != code_fingerprint(engineering)
            or (held.get("cohort_sha256") != current.get("cohort_sha256") and not reconciled)
            or pending.get("cohort_sha256") != current.get("cohort_sha256")
            or state.get("last_finished", {}).get("root") != held.get("root")
            or state.get("last_finished", {}).get("binding") != held.get("binding")):
        return False
    held.update(status="restored", restored_at=now)
    state["phase"], state["continuation_earned"] = "observing", True
    state["idle_since"], state["cooldown_until"] = now, now + state.get("review_cooldown_seconds", 1200)
    state.pop("pending_visual_review", None)
    return True
