from __future__ import annotations

import hashlib
import json
import signal
import time
import uuid
from typing import Any

from .native_admin import identity, valid_uuid
from .session import MAX_SESSIONS, TUI_MODES
from .session_recovery import SHA, outcome
from .tmux import resolve_openclaw_tui_command

PENDING_SECONDS = 60


def running(session: Any) -> bool:
    if session.reaped or session.kill_deadline is not None:
        return False
    try:
        with open(f"/proc/{session.pid}/stat", encoding="utf-8") as stream:
            value = stream.read(16384)
        return value[value.rfind(")") + 2:].split()[0] not in {"Z", "X"}
    except (OSError, IndexError):
        return False


def preview(agent: Any) -> tuple[dict[str, Any], list[str] | None]:
    argv = resolve_openclaw_tui_command(agent.bundle)
    if argv is None:
        return outcome("unsupported", "OpenClaw no tiene una conversación durable inicializada y segura; no se cerró ninguna TUI."), None
    sessions = [session for session in agent.sessions.values() if session.mode in TUI_MODES]
    if any(session.argv != argv for session in sessions if running(session)):
        return outcome("conflict", "Una terminal apunta a otra conversación de OpenClaw. Ciérrala y vuelve a consultar."), None
    fingerprint = hashlib.sha256(json.dumps({
        "identity": identity(agent.bundle, agent.writer_instance_id), "argv": argv,
    }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    present = any(running(session) for session in sessions)
    return {"type": "session", "state": "present" if present else "absent", "resumable": True,
            "fingerprint": fingerprint,
            "reason": "Se reabrirá la TUI de OpenClaw con --session en la conversación durable; el adaptador seguirá activo."}, argv


def retire(agent: Any, session: Any, deadline: float) -> bool:
    agent._reap()
    if not session.reaped:
        agent._signal(session, signal.SIGTERM)
    grace = min(deadline, time.monotonic() + 0.2)
    while time.monotonic() < grace:
        agent._reap()
        if session.reaped:
            break
        time.sleep(0.01)
    if not session.reaped:
        agent._signal(session, signal.SIGKILL)
        while time.monotonic() < min(deadline, grace + 0.4):
            agent._reap()
            if session.reaped:
                break
            time.sleep(0.01)
    if not session.reaped:
        return False
    session.close_reason = "agent_recovered"
    agent._retire(session)
    return True


def execute(agent: Any, command: dict[str, Any]) -> dict[str, Any]:
    op = command.get("op")
    expected = {"request_id", "identity", "op"} | ({"expected_fingerprint", "force", "expires_at"} if op == "session_recover" else set())
    if (set(command) != expected or op not in {"session_probe", "session_recover"}
            or not valid_uuid(command.get("request_id"))
            or command.get("identity") != identity(agent.bundle, agent.writer_instance_id)):
        return outcome("conflict", "La identidad del runtime o la solicitud cambió.")
    observed, argv = preview(agent)
    if op == "session_probe" or argv is None:
        return observed
    expires = command.get("expires_at")
    remaining = expires - time.time() * 1000 if isinstance(expires, int) and not isinstance(expires, bool) else -1
    if (not 0 < remaining <= 8000 or not isinstance(command.get("force"), bool)
            or not isinstance(command.get("expected_fingerprint"), str)
            or not SHA.fullmatch(command["expected_fingerprint"])
            or command["expected_fingerprint"] != observed["fingerprint"]
            or observed["state"] == "present" and not command["force"]):
        return outcome("conflict", "El puntero de OpenClaw cambió, la confirmación falta o la autorización venció; no se cerró ninguna TUI.")
    deadline = time.monotonic() + min(remaining / 1000, 7)
    sessions = [session for session in agent.sessions.values() if session.mode in TUI_MODES]
    if len(agent.sessions) - len(sessions) >= MAX_SESSIONS:
        return outcome("conflict", "Las terminales disponibles están ocupadas; no se cerró ninguna sesión.")
    for session in sessions:
        if not retire(agent, session, deadline):
            return outcome("failed", "No se confirmó el cierre de la TUI anterior de OpenClaw. Vuelve a consultar.")
    current, current_argv = preview(agent)
    if current_argv != argv or current["fingerprint"] != observed["fingerprint"] or time.monotonic() >= deadline:
        return outcome("conflict", "El puntero de OpenClaw cambió o venció la autorización antes de reabrir la TUI.")
    session = None
    try:
        session = agent._spawn(str(uuid.uuid4()), "harness", argv, 24, 80)
        session.recovery_pending_until = time.monotonic() + PENDING_SECONDS
        session.output_paused = True
        agent.sessions[session.session_id] = session
        time.sleep(min(0.15, max(0, deadline - time.monotonic())))
        agent._reap()
        verified, verified_argv = preview(agent)
        if (not running(session) or verified_argv != argv or verified["fingerprint"] != observed["fingerprint"]
                or time.monotonic() >= deadline):
            retire(agent, session, time.monotonic() + 0.6)
            return outcome("failed", "La TUI de OpenClaw no confirmó la reapertura de la conversación exacta.")
    except (OSError, ValueError):
        if session is not None and session.session_id in agent.sessions:
            retire(agent, session, time.monotonic() + 0.6)
        return outcome("failed", "No se pudo reabrir la TUI de OpenClaw.")
    return {**observed, "state": "resumed" if observed["state"] == "present" else "recreated",
            "reason": "OpenClaw reabrió su TUI con --session en la conversación durable. La terminal se conectará a esa TUI."}
