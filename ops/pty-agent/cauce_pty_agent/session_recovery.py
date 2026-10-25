from __future__ import annotations

import json
import os
import re
import signal
import stat
import subprocess
import threading
import time
from typing import Any

HARNESSES = frozenset({"claude", "codex", "muse", "grok"})
SHA = re.compile(r"^[a-f0-9]{64}$")
ALIAS = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
ENVIRONMENT = frozenset({
    "HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMUX_TMPDIR", "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME",
    "CAUCE_ALIAS", "CAUCE_RUNTIME_KEY", "CAUCE_TENANT_ID", "CAUCE_TENANT", "CAUCE_STATE_DIR",
    "CAUCE_CONTAINER_ID", "CAUCE_CONTAINER_GENERATION", "CAUCE_SHARED_SESSION",
    "CAUCE_SHARED_SESSION_WORKSPACE", "CAUCE_MODEL_ID", "CAUCE_REASONING_EFFORT",
    "CAUCE_HARNESS_COMMAND", "CAUCE_HARNESS_COMMAND_SHA256", "CAUCE_HARNESS_COMMAND_FILES",
    "MUSE_REASONING_EFFORT", "MUSE_NO_AUTO_UPDATE", "NODE_COMPILE_CACHE",
    "CAUCE_MUSE_CLI_COMMAND", "CAUCE_MUSE_CLI_SHA256",
})
STATES = frozenset({"present", "absent", "resumed", "recreated", "unsupported", "conflict", "failed"})


def outcome(state: str, reason: str) -> dict[str, Any]:
    return {"type": "session", "state": state, "resumable": False, "fingerprint": None, "reason": reason}


def descriptor(value: Any, uid: int) -> dict[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"state_directory", "adapter_generation"}:
        return None
    path, generation = value["state_directory"], value["adapter_generation"]
    if (not isinstance(path, str) or not path.startswith("/") or path == "/" or "\0" in path
            or os.path.normpath(path) != path or os.path.realpath(path) != path
            or not isinstance(generation, str) or not SHA.fullmatch(generation)):
        return None
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        return None
    return {"state_directory": path, "adapter_generation": generation}


def trusted_file(path: str, *, executable: bool = False) -> bool:
    if not path.startswith("/") or "\0" in path or os.path.normpath(path) != path:
        return False
    try:
        info = os.lstat(path)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
                or (executable and not os.access(path, os.X_OK))):
            return False
        parent = os.path.dirname(path)
        while True:
            info = os.lstat(parent)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                return False
            if parent == "/":
                return True
            parent = os.path.dirname(parent)
    except OSError:
        return False


def process_environment(pid: str) -> dict[str, str]:
    with open(f"/proc/{pid}/environ", "rb") as stream:
        raw = stream.read(262145)
    if len(raw) > 262144:
        return {}
    values = {}
    for entry in raw.split(b"\0"):
        key, separator, value = entry.partition(b"=")
        if separator and key.decode("utf-8", "strict") in ENVIRONMENT:
            values[key.decode()] = value.decode("utf-8", "strict")
    return values


def adapter_command(bundle: dict[str, Any], deadline: float) -> tuple[list[str], dict[str, str]] | None:
    configuration = descriptor(bundle.get("session_recovery"), bundle["runtime_uid"])
    alias = bundle.get("alias")
    tmux_configuration = bundle.get("tmux_tui")
    physical_alias = tmux_configuration.get("alias", alias) if isinstance(tmux_configuration, dict) else alias
    if configuration is None or bundle.get("harness") not in HARNESSES or os.geteuid() != bundle["runtime_uid"]:
        return None
    if (not isinstance(alias, str) or not ALIAS.fullmatch(alias)
            or not isinstance(physical_alias, str) or not ALIAS.fullmatch(physical_alias)):
        return None
    candidates = []
    for pid in os.listdir("/proc"):
        if time.monotonic() >= deadline:
            return None
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != bundle["runtime_uid"]:
                continue
            environment = process_environment(pid)
            wire = environment.get("CAUCE_ALIAS")
            physical = environment.get("CAUCE_RUNTIME_KEY", wire)
            if (wire != alias or not isinstance(physical, str) or not ALIAS.fullmatch(physical)
                    or physical != physical_alias
                    or environment.get("CAUCE_TENANT_ID", environment.get("CAUCE_TENANT")) != bundle["tenant_id"]
                    or environment.get("HOME") != bundle["home"]
                    or environment.get("CAUCE_STATE_DIR") != configuration["state_directory"]
                    or environment.get("CAUCE_CONTAINER_ID") != bundle["container_id"]
                    or environment.get("CAUCE_CONTAINER_GENERATION") != configuration["adapter_generation"]
                    or environment.get("TMUX_TMPDIR", configuration["state_directory"]) != configuration["state_directory"]
                    or environment.get("CAUCE_SHARED_SESSION") != "1"):
                continue
            with open(f"/proc/{pid}/stat", encoding="utf-8") as stream:
                raw = stream.read(16384)
            fields = raw[raw.rfind(")") + 2:].split()
            if fields[2] != pid or fields[3] != pid:
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as stream:
                arguments = stream.read(65537).decode("utf-8", "strict").split("\0")
            scripts = [argument for argument in arguments if argument.endswith(f"/bin/{bundle['harness']}.js")]
            if len(scripts) != 1 or not trusted_file(scripts[0]):
                continue
            helper = os.path.join(os.path.dirname(scripts[0]), "shared-session.js")
            node = os.readlink(f"/proc/{pid}/exe")
            if not trusted_file(helper) or not trusted_file(node, executable=True):
                continue
            workspace = environment.get("CAUCE_SHARED_SESSION_WORKSPACE", "/workspace")
            if (not workspace.startswith("/") or os.path.normpath(workspace) != workspace
                    or not os.path.isdir(workspace) or os.path.realpath(workspace) != workspace):
                continue
            command = [node, helper, "recovery-preview", "--alias", physical,
                       "--harness", bundle["harness"], "--workspace", workspace,
                       "--state", configuration["state_directory"]]
            candidates.append((command, environment))
        except (OSError, ValueError, UnicodeError, IndexError):
            continue
    return candidates[0] if len(candidates) == 1 else None


def execute(bundle: dict[str, Any], writer: str, command: dict[str, Any], deadline: float | None = None) -> dict[str, Any]:
    from .native_admin import identity, valid_uuid
    received = time.monotonic()
    deadline = min(deadline, received + 7) if deadline is not None else received + 7
    op = command.get("op")
    expected = {"request_id", "identity", "op"} | ({"expected_fingerprint", "force", "expires_at"} if op == "session_recover" else set())
    if (set(command) != expected or op not in {"session_probe", "session_recover"}
            or not valid_uuid(command.get("request_id")) or command.get("identity") != identity(bundle, writer)):
        return outcome("conflict", "La identidad del runtime o la solicitud cambió.")
    if op == "session_recover" and (not isinstance(command.get("expected_fingerprint"), str)
            or not SHA.fullmatch(command["expected_fingerprint"]) or not isinstance(command.get("force"), bool)):
        return outcome("conflict", "La confirmación no contiene una huella válida.")
    if op == "session_recover":
        expires = command.get("expires_at")
        remaining = expires - time.time() * 1000 if isinstance(expires, int) and not isinstance(expires, bool) else -1
        if not 0 < remaining <= 8000:
            return outcome("conflict", "La autorización de recuperación venció o no tiene un plazo válido.")
        deadline = min(deadline, received + remaining / 1000)
    if time.monotonic() >= deadline:
        return outcome("failed", "La autorización venció antes de ejecutar la recuperación.")
    selected = adapter_command(bundle, deadline)
    if time.monotonic() >= deadline:
        return outcome("failed", "La autorización venció antes de ejecutar la recuperación.")
    if selected is None:
        return outcome("unsupported", "No se acreditó un adaptador con sesión compartida y recuperación exacta compatible.")
    argv, environment = selected
    if op == "session_recover":
        argv[2] = "recovery-apply"
        argv.extend(["--expected-fingerprint", command["expected_fingerprint"], "--force", "1" if command["force"] else "0"])
    child = None
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return outcome("failed", "La autorización venció antes de ejecutar la recuperación.")
        child = subprocess.Popen(argv, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True, cwd="/")
        raw, _ = child.communicate(timeout=max(0, deadline - time.monotonic()))
        if len(raw) > 16384:
            return outcome("failed", "La respuesta de recuperación excedió el límite.")
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {"type", "state", "resumable", "fingerprint", "reason"}
                or value.get("type") != "session" or value.get("state") not in STATES
                or not isinstance(value.get("resumable"), bool) or not isinstance(value.get("reason"), str)
                or len(value["reason"]) > 500 or any(ord(char) < 32 for char in value["reason"])
                or (value.get("fingerprint") is not None and (not isinstance(value["fingerprint"], str)
                    or not SHA.fullmatch(value["fingerprint"])))):
            return outcome("unsupported", "El helper instalado no publica recuperación verificable.")
        if child.returncode and value["state"] in {"present", "absent", "resumed", "recreated"}:
            return outcome("failed", "El helper no confirmó la recuperación.")
        return value
    except subprocess.TimeoutExpired:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
        return outcome("failed", "No se confirmó el efecto antes del plazo. Relee el estado antes de reintentar.")
    except (OSError, ValueError, TypeError):
        return outcome("unsupported", "El helper instalado no publica recuperación verificable.")


def start(agent: Any, document: dict[str, Any], respond: Any) -> bool:
    deadline = time.monotonic() + 7
    if document.get("op") == "session_recover":
        expires = document.get("expires_at")
        remaining = expires - time.time() * 1000 if isinstance(expires, int) and not isinstance(expires, bool) else -1
        if not 0 < remaining <= 8000:
            respond(outcome("conflict", "La autorización de recuperación venció o no tiene un plazo válido."))
            return True
        deadline = min(deadline, time.monotonic() + remaining / 1000)
    lock = getattr(agent, "session_recovery_lock", None)
    if lock is None:
        lock = threading.Lock()
        agent.session_recovery_lock = lock
    if not lock.acquire(blocking=False):
        return False
    connection = agent.connection

    def work() -> None:
        try:
            try:
                result = execute(agent.bundle, agent.writer_instance_id, document, deadline)
            except Exception:
                result = outcome("failed", "No se pudo verificar la recuperación.")
            if agent.connection is connection and agent.acknowledged:
                respond(result)
        finally:
            lock.release()

    try:
        threading.Thread(target=work, name="cauce-session-recovery", daemon=True).start()
    except RuntimeError:
        lock.release()
        return False
    return True
