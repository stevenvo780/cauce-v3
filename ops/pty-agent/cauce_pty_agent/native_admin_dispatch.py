from __future__ import annotations

from typing import Any

from .framing import encode_json
from .native_admin import execute_native_admin
from .native_admin_paths import NativeError, roots

TAG_NATIVE_ADMIN = 0x62
TAG_NATIVE_ADMIN_RESULT = 0x63


def native_admin_feature(agent: Any) -> list[str]:
    try:
        roots(agent.bundle)
        return ["native_admin_v1"] if agent.governance_write_journal is not None else []
    except (NativeError, OSError):
        return []


def dispatch_native_admin(agent: Any, tag: int, document: dict[str, Any]) -> bool:
    if tag != TAG_NATIVE_ADMIN:
        return False
    if (not native_admin_feature(agent) or agent.pending_writes or agent.pending_write_batches):
        outcome = {"type": "error", "error": "unavailable"}
    else:
        outcome = execute_native_admin(agent.bundle, agent.writer_instance_id, document)
    agent._queue(encode_json(TAG_NATIVE_ADMIN_RESULT, {"request_id": document.get("request_id"), "outcome": outcome}))
    return True
