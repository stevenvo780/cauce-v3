from __future__ import annotations

from typing import Any

from .framing import TAG_WRITE, TAG_WRITE_BATCH, encode_json
from .native_admin import execute_native_admin
from .native_admin_paths import NativeError, roots
from .openclaw_recovery import execute as recover_openclaw
from .session_recovery import HARNESSES, descriptor
from .session_recovery import outcome as recovery_outcome
from .session_recovery import start as start_recovery

TAG_NATIVE_ADMIN = 0x62
TAG_NATIVE_ADMIN_RESULT = 0x63


def native_admin_feature(agent: Any) -> list[str]:
    features = []
    if (agent.writer_instance_id and ((agent.bundle.get("harness") in HARNESSES
            and descriptor(agent.bundle.get("session_recovery"), agent.bundle["runtime_uid"]) is not None)
            or agent.bundle.get("harness") == "openclaw" and agent.bundle.get("openclaw_tui") is not None)):
        features.append("agent_recovery_v1")
    try:
        roots(agent.bundle)
        if agent.governance_write_journal is not None:
            features.append("native_admin_v1")
    except (NativeError, OSError):
        pass
    return features


def dispatch_native_admin(agent: Any, tag: int, document: dict[str, Any]) -> bool:
    lock = getattr(agent, "session_recovery_lock", None)
    recovering = lock is not None and lock.locked()
    if recovering and tag in {TAG_WRITE, TAG_WRITE_BATCH}:
        reject = agent._write_batch_error if tag == TAG_WRITE_BATCH else agent._write_error
        reject(document.get("request_id"), "unavailable", "agent recovery is in progress")
        return True
    if tag != TAG_NATIVE_ADMIN:
        return False
    features = native_admin_feature(agent)
    def respond(value: dict[str, Any]) -> None:
        agent._queue(encode_json(TAG_NATIVE_ADMIN_RESULT, {"request_id": document.get("request_id"), "outcome": value}))
    if document.get("op") in {"session_probe", "session_recover"}:
        if "agent_recovery_v1" not in features:
            respond(recovery_outcome("unsupported", "Este runtime no publica recuperación de sesión compartida."))
        elif agent.pending_writes or agent.pending_write_batches or recovering:
            respond(recovery_outcome("conflict", "Hay una escritura o recuperación en curso. Relee el estado."))
        elif agent.bundle.get("harness") == "openclaw":
            respond(recover_openclaw(agent, document))
        elif not start_recovery(agent, document, respond):
            respond(recovery_outcome("conflict", "Hay una escritura o recuperación en curso. Relee el estado."))
        return True
    if ("native_admin_v1" not in features or recovering or agent.pending_writes or agent.pending_write_batches):
        outcome = {"type": "error", "error": "unavailable"}
    else:
        outcome = execute_native_admin(agent.bundle, agent.writer_instance_id, document)
    respond(outcome)
    return True
