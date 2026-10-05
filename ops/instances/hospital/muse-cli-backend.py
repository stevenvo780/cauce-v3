#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import json
import os
import select
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

MUSE_EXECUTABLE = "/opt/muse-code/muse"
WORKSPACE = "/home/node/clawd"
MODEL = "muse-spark-1.3"
CONFIG_HOME = "/home/node/.muse/config"
DATA_HOME = "/home/node/.muse/data"
TIMEOUT_SECONDS = 2400.0
KILL_GRACE_SECONDS = 2.0
MAX_PROMPT_BYTES = 16 * 1024 * 1024
MAX_RECORD_BYTES = 8 * 1024 * 1024
MAX_TEXT_BYTES = 8 * 1024 * 1024
MAX_STREAM_BYTES = 64 * 1024 * 1024
ERROR_MESSAGES = {
    "MUSE_ARGUMENTS_INVALID": "Muse backend arguments are invalid",
    "MUSE_INPUT_INVALID": "Muse backend input is invalid or too large",
    "MUSE_OUTPUT_INVALID": "Muse CLI returned invalid output",
    "MUSE_OUTPUT_LIMIT": "Muse CLI output exceeded the bounded limit",
    "MUSE_SESSION_INVALID": "Muse CLI did not provide a valid session identity",
    "MUSE_SESSION_CHANGED": "Muse CLI changed the requested session identity",
    "MUSE_RUN_CHANGED": "Muse CLI returned inconsistent run identity",
    "MUSE_TERMINAL_FAILED": "Muse CLI reported a failed or interrupted turn",
    "MUSE_RESULT_INCOMPLETE": "Muse CLI did not confirm a complete result",
    "MUSE_PROCESS_FAILED": "Muse CLI exited unsuccessfully",
    "MUSE_EXECUTION_FAILED": "Muse CLI could not be executed",
    "MUSE_TIMEOUT": "Muse CLI exceeded the execution deadline",
    "MUSE_CANCELLED": "Muse CLI execution was cancelled",
}


class BackendError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise BackendError("MUSE_ARGUMENTS_INVALID")


def session_uuid(value: str) -> str:
    try:
        canonical = str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise BackendError("MUSE_SESSION_INVALID") from error
    if canonical != value.lower():
        raise BackendError("MUSE_SESSION_INVALID")
    return canonical


def native_environment() -> dict[str, str]:
    allowed = (
        "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    )
    environment = {name: os.environ[name] for name in allowed if name in os.environ}
    environment.update(HOME="/home/node", XDG_CONFIG_HOME=CONFIG_HOME, XDG_DATA_HOME=DATA_HOME,
                       MUSE_NO_AUTO_UPDATE="1")
    return environment


@dataclass
class RunState:
    requested_session: str | None
    emit: Callable[[dict[str, object]], None]
    session_id: str | None = None
    accepted_turn_id: str | None = None
    run_id: str | None = None
    deltas: list[str] = field(default_factory=list)
    text_bytes: int = 0
    completed_text: str | None = None
    last_progress: float = 0.0

    def record(self, event: object) -> None:
        if (not isinstance(event, dict) or type(event.get("schema_version")) is not int
                or event["schema_version"] != 1):
            raise BackendError("MUSE_OUTPUT_INVALID")
        if "payload_schema_version" in event and (type(event["payload_schema_version"]) is not int
                                                   or event["payload_schema_version"] != 1):
            raise BackendError("MUSE_OUTPUT_INVALID")
        stream = event.get("stream")
        if not isinstance(stream, dict) or stream.get("kind") != "session":
            raise BackendError("MUSE_OUTPUT_INVALID")
        identity = stream.get("id")
        if not isinstance(identity, str):
            raise BackendError("MUSE_SESSION_INVALID")
        identity = session_uuid(identity)
        if (self.session_id is not None and identity != self.session_id
                or self.requested_session is not None and identity != self.requested_session):
            raise BackendError("MUSE_SESSION_CHANGED")
        if self.session_id is None:
            self.session_id = identity
            self.emit({"type": "system", "session_id": identity})
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return
        kind = payload.get("kind")
        if kind == "command_accepted":
            if payload.get("command_kind") != "turn.submit" or not isinstance(payload.get("command_id"), str):
                raise BackendError("MUSE_OUTPUT_INVALID")
            turn_id = session_uuid(payload["command_id"])
            if self.accepted_turn_id is not None and turn_id != self.accepted_turn_id:
                raise BackendError("MUSE_RUN_CHANGED")
            self.accepted_turn_id = turn_id
            if "run_stream" in payload:
                self.match_run(payload)
        elif ((isinstance(kind, str) and (kind.startswith("run_") or kind == "session_run_linked"))
              or "command_id" in payload or "run_stream" in payload):
            self.match_run(payload)
        if kind in ("run_output_delta", "run_terminal"):
            text = payload.get("text")
            if text is not None and not isinstance(text, str):
                raise BackendError("MUSE_OUTPUT_INVALID")
            if isinstance(text, str):
                self.text_bytes += len(text.encode("utf-8"))
                if self.text_bytes > MAX_TEXT_BYTES:
                    raise BackendError("MUSE_OUTPUT_LIMIT")
            if kind == "run_output_delta":
                if self.completed_text is not None:
                    raise BackendError("MUSE_OUTPUT_INVALID")
                if isinstance(text, str):
                    self.deltas.append(text)
            else:
                if payload.get("terminal") != "completed":
                    raise BackendError("MUSE_TERMINAL_FAILED")
                if self.completed_text is not None:
                    raise BackendError("MUSE_OUTPUT_INVALID")
                self.completed_text = text if isinstance(text, str) and text else "".join(self.deltas)
                self.deltas.clear()
        now = time.monotonic()
        if now - self.last_progress >= 1.0:
            self.emit({"type": "progress", "event": "muse_activity"})
            self.last_progress = now

    def match_run(self, payload: dict[str, object]) -> None:
        if self.session_id is None or self.accepted_turn_id is None:
            raise BackendError("MUSE_RESULT_INCOMPLETE")
        run_stream = payload.get("run_stream")
        command_id = payload.get("command_id")
        if (not isinstance(run_stream, dict) or run_stream.get("kind") != "run"
                or not isinstance(run_stream.get("id"), str) or not isinstance(command_id, str)):
            raise BackendError("MUSE_OUTPUT_INVALID")
        identity = session_uuid(run_stream["id"])
        if (identity != self.accepted_turn_id or session_uuid(command_id) != self.accepted_turn_id
                or self.run_id is not None and self.run_id != identity):
            raise BackendError("MUSE_RUN_CHANGED")
        self.run_id = identity

    def result(self) -> dict[str, object]:
        if self.session_id is None:
            raise BackendError("MUSE_SESSION_INVALID")
        if (self.accepted_turn_id is None or self.run_id is None
                or self.completed_text is None or not self.completed_text.strip()):
            raise BackendError("MUSE_RESULT_INCOMPLETE")
        return {"type": "result", "result": self.completed_text, "session_id": self.session_id,
                "item": {"type": "assistant_message", "text": self.completed_text}}


def kill_group(process: subprocess.Popen[bytes], sig: signal.Signals) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, sig)


def run_backend(
    prompt: str, system_prompt: str | None, session_id: str | None,
    emit: Callable[[dict[str, object]], None], cancelled: threading.Event | None = None,
    *, command_prefix: Sequence[str] = (MUSE_EXECUTABLE,), workspace: str = WORKSPACE,
    timeout_seconds: float = TIMEOUT_SECONDS, kill_grace_seconds: float = KILL_GRACE_SECONDS,
) -> dict[str, object]:
    cancelled = cancelled if cancelled is not None else threading.Event()
    if cancelled.is_set():
        raise BackendError("MUSE_CANCELLED")
    if session_id is not None:
        session_id = session_uuid(session_id)
    if system_prompt:
        prompt = f"--- OPENCLAW SYSTEM INSTRUCTIONS ---\n{system_prompt}\n--- USER REQUEST ---\n{prompt}"
    encoded = prompt.encode("utf-8")
    if not prompt.strip() or len(encoded) > MAX_PROMPT_BYTES:
        raise BackendError("MUSE_INPUT_INVALID")
    state = RunState(session_id, emit)
    deadline = time.monotonic() + timeout_seconds
    with tempfile.TemporaryDirectory(prefix="muse-openclaw-") as directory:
        prompt_file = Path(directory) / "prompt"
        fd = os.open(prompt_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
        command = [*command_prefix, "exec", "--json", "--yolo", "--trust-workspace", "--provider", "meta",
                   "--model", MODEL, "--reasoning-effort", "max", "--workspace", workspace,
                   "--prompt-file", str(prompt_file)]
        if session_id is not None:
            command.extend(("--session-id", session_id))
        environment = native_environment()
        if cancelled.is_set():
            raise BackendError("MUSE_CANCELLED")
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, cwd=workspace, env=environment,
                                       start_new_session=True)
        except OSError as error:
            raise BackendError("MUSE_EXECUTION_FAILED") from error
        buffer = bytearray()
        stream_bytes = 0
        exited_at: float | None = None
        try:
            with selectors.DefaultSelector() as selector:
                for name, pipe in (("stdout", process.stdout), ("stderr", process.stderr)):
                    assert pipe is not None
                    os.set_blocking(pipe.fileno(), False)
                    selector.register(pipe, selectors.EVENT_READ, name)
                while selector.get_map():
                    if cancelled.is_set():
                        raise BackendError("MUSE_CANCELLED")
                    now = time.monotonic()
                    if now >= deadline:
                        raise BackendError("MUSE_TIMEOUT")
                    if process.poll() is not None:
                        if exited_at is None:
                            exited_at = now
                            kill_group(process, signal.SIGTERM)
                        elif now - exited_at >= kill_grace_seconds:
                            kill_group(process, signal.SIGKILL)
                    for key, _ in selector.select(min(0.1, max(0.0, deadline - now))):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        stream_bytes += len(chunk)
                        if stream_bytes > MAX_STREAM_BYTES:
                            raise BackendError("MUSE_OUTPUT_LIMIT")
                        if key.data == "stderr":
                            continue
                        buffer.extend(chunk)
                        while b"\n" in buffer:
                            line, _, rest = buffer.partition(b"\n")
                            buffer = bytearray(rest)
                            parse_record(line, state)
                        if len(buffer) > MAX_RECORD_BYTES:
                            raise BackendError("MUSE_OUTPUT_LIMIT")
                if buffer:
                    parse_record(buffer, state)
            while process.poll() is None:
                if cancelled.is_set():
                    raise BackendError("MUSE_CANCELLED")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BackendError("MUSE_TIMEOUT")
                time.sleep(min(0.1, remaining))
            code = process.returncode
            if cancelled.is_set():
                raise BackendError("MUSE_CANCELLED")
            if code != 0:
                raise BackendError("MUSE_PROCESS_FAILED")
            return state.result()
        finally:
            kill_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=kill_grace_seconds)
            except subprocess.TimeoutExpired:
                pass
            kill_group(process, signal.SIGKILL)
            process.wait()
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()


def parse_record(line: bytes | bytearray, state: RunState) -> None:
    if len(line) > MAX_RECORD_BYTES:
        raise BackendError("MUSE_OUTPUT_LIMIT")
    if not line.strip():
        return
    try:
        event = json.loads(line)
    except (ValueError, UnicodeDecodeError) as error:
        raise BackendError("MUSE_OUTPUT_INVALID") from error
    state.record(event)


def emit_json(value: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_prompt(cancelled: threading.Event, deadline: float) -> bytes:
    descriptor = sys.stdin.buffer.fileno()
    blocking = os.get_blocking(descriptor)
    os.set_blocking(descriptor, False)
    content = bytearray()
    try:
        while True:
            if cancelled.is_set():
                raise BackendError("MUSE_CANCELLED")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BackendError("MUSE_TIMEOUT")
            ready, _, _ = select.select([descriptor], [], [], min(0.1, remaining))
            if not ready:
                continue
            chunk = os.read(descriptor, min(65536, MAX_PROMPT_BYTES + 1 - len(content)))
            if not chunk:
                return bytes(content)
            content.extend(chunk)
            if len(content) > MAX_PROMPT_BYTES:
                raise BackendError("MUSE_INPUT_INVALID")
    finally:
        os.set_blocking(descriptor, blocking)


def main(argv: Sequence[str] | None = None) -> int:
    cancelled = threading.Event()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, lambda _sig, _frame: cancelled.set())
    try:
        parser = ArgumentParser(description="Muse CLI backend for the Hospital operator")
        parser.add_argument("--system-prompt")
        parser.add_argument("--session-id")
        options = parser.parse_args(argv)
        raw = read_prompt(cancelled, deadline)
        try:
            prompt = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise BackendError("MUSE_INPUT_INVALID") from error
        emit_json(run_backend(prompt, options.system_prompt, options.session_id, emit_json, cancelled,
                              timeout_seconds=max(0.0, deadline - time.monotonic())))
        return 0
    except BackendError as error:
        emit_json({"type": "error", "code": error.code, "error": str(error)})
        return 1
    except BrokenPipeError:
        return 1
    except OSError:
        emit_json({"type": "error", "code": "MUSE_EXECUTION_FAILED", "error": ERROR_MESSAGES["MUSE_EXECUTION_FAILED"]})
        return 1
    except Exception:
        emit_json({"type": "error", "code": "MUSE_EXECUTION_FAILED", "error": ERROR_MESSAGES["MUSE_EXECUTION_FAILED"]})
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
