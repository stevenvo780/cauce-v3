from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

# cauce:requiere none

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "ops" / "instances" / "hospital" / "muse-cli-backend.py"
SPEC = importlib.util.spec_from_file_location("hospital_muse_cli_backend", SOURCE)
assert SPEC is not None and SPEC.loader is not None
BACKEND = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BACKEND
SPEC.loader.exec_module(BACKEND)
SESSION = "01a0e53f-1799-71d0-8531-21ed64d15827"
RUN_ID = "e4d2761d-26c6-41f9-a190-370fdcd2fa92"


def envelope(payload: dict[str, object], session_id: str = SESSION) -> dict[str, object]:
    return {"schema_version": 1, "stream": {"kind": "session", "id": session_id}, "payload": payload}


def process_alive(pid: int) -> bool:
    try:
        return pathlib.Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except FileNotFoundError:
        return False


class MuseCliBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="muse-backend-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.report = self.directory / "report.json"
        self.frames: list[dict[str, object]] = []

    def assert_process_stopped(self, pid: int) -> None:
        deadline = time.monotonic() + 1.0
        while process_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(process_alive(pid))

    def fake_child(self, mode: str = "completed") -> pathlib.Path:
        child = self.directory / f"fake-{mode}.py"
        child.write_text(
            f"""import json, os, pathlib, signal, stat, subprocess, sys, time
MODE = {mode!r}
REPORT = pathlib.Path({str(self.report)!r})
SESSION = {SESSION!r}
RUN_ID = {RUN_ID!r}
args = sys.argv[1:]
prompt_path = pathlib.Path(args[args.index('--prompt-file') + 1])
report = {{'argv': args, 'prompt': prompt_path.read_text(), 'mode': stat.S_IMODE(prompt_path.stat().st_mode),
          'prompt_path': str(prompt_path), 'environment': dict(os.environ), 'pid': os.getpid()}}
def record(payload):
    if payload.get('kind') != 'command_accepted':
        payload.setdefault('command_id', RUN_ID)
        payload.setdefault('run_stream', {{'kind': 'run', 'id': RUN_ID}})
    print(json.dumps({{'schema_version': 1, 'stream': {{'kind': 'session', 'id': SESSION}}, 'payload': payload}}), flush=True)
if MODE == 'wrong-session':
    SESSION = '01a0e53f-1799-71d0-8531-21ed64d15828'
if MODE in ('hang', 'closed-pipes'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    descendant = subprocess.Popen([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report['descendant_pid'] = descendant.pid
REPORT.write_text(json.dumps(report))
record({{'kind': 'command_accepted', 'command_kind': 'turn.submit', 'command_id': RUN_ID}})
if MODE == 'malformed':
    print('not-json-sensitive-fixture', flush=True)
    sys.exit(0)
if MODE in ('hang', 'closed-pipes'):
    if MODE == 'closed-pipes':
        os.close(1)
        os.close(2)
    while True:
        time.sleep(1)
record({{'kind': 'run_output_delta', 'text': 'Ho', 'command_id': RUN_ID}})
record({{'kind': 'run_output_delta', 'text': 'la', 'run_stream': {{'kind': 'run', 'id': RUN_ID}}}})
if MODE != 'partial':
    terminal = 'failed' if MODE == 'failed' else 'completed'
    record({{'kind': 'run_terminal', 'terminal': terminal, 'text': '' if MODE == 'empty-terminal' else 'Hola',
            'command_id': RUN_ID, 'reason': 'sensitive-fixture-detail'}})
if MODE == 'later-failure':
    record({{'kind': 'run_terminal', 'terminal': 'failed', 'reason': 'sensitive-fixture-detail'}})
if MODE == 'nonzero':
    print('sensitive-fixture-stderr', file=sys.stderr)
    sys.exit(7)
""",
            encoding="utf-8",
        )
        return child

    def write_launcher(self, child: pathlib.Path, timeout_seconds: float = 5.0) -> pathlib.Path:
        launcher = self.directory / "launcher.py"
        launcher.write_text(
            f"""import functools, importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('test_muse_backend', {str(SOURCE)!r})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.TIMEOUT_SECONDS = {timeout_seconds!r}
original_read = module.read_prompt
def input_ready(*args):
    pathlib.Path({str(self.directory / 'input-ready')!r}).write_text('ready')
    return original_read(*args)
module.read_prompt = input_ready
module.run_backend = functools.partial(module.run_backend, command_prefix=({sys.executable!r}, {str(child)!r}),
                                      workspace={str(self.directory)!r}, timeout_seconds=5.0, kill_grace_seconds=0.15)
raise SystemExit(module.main())
""",
            encoding="utf-8",
        )
        return launcher

    def invoke(self, mode: str = "completed", **options: object) -> dict[str, object]:
        child = self.fake_child(mode)
        return BACKEND.run_backend(
            "Solicitud propia", options.pop("system_prompt", None), options.pop("session_id", None),
            self.frames.append, command_prefix=(sys.executable, str(child)), workspace=str(self.directory),
            timeout_seconds=options.pop("timeout_seconds", 3.0), kill_grace_seconds=0.15, **options,
        )

    def test_native_completion_normalizes_result_and_observed_session(self) -> None:
        result = self.invoke()
        self.assertEqual(result, {"type": "result", "result": "Hola", "session_id": SESSION,
                                  "item": {"type": "assistant_message", "text": "Hola"}})
        self.assertEqual(self.frames[0], {"type": "system", "session_id": SESSION})
        self.assertFalse(any("Hola" in json.dumps(frame) or "Ho" in json.dumps(frame) for frame in self.frames))
        self.assertEqual(sum(frame["type"] == "system" for frame in self.frames), 1)

    def test_native_argv_profile_and_private_prompt_are_fixed(self) -> None:
        with mock.patch.dict(os.environ, {
            "META_API_KEY": "fixture-meta", "MUSE_API_KEY": "fixture-muse",
            "OPENAI_API_KEY": "fixture-openai", "ANTHROPIC_API_KEY": "fixture-anthropic",
            "OPENCLAW_GATEWAY_TOKEN": "fixture-other-runtime", "MUSE_MODEL": "override",
        }):
            self.invoke(system_prompt="Instrucciones propias")
        report = json.loads(self.report.read_text())
        arguments = report["argv"]
        self.assertEqual(arguments[:7], ["exec", "--json", "--yolo", "--trust-workspace", "--provider", "meta", "--model"])
        self.assertEqual(arguments[arguments.index("--model") + 1], "muse-spark-1.3")
        self.assertEqual(arguments[arguments.index("--reasoning-effort") + 1], "max")
        self.assertNotIn("--session-id", arguments)
        self.assertIn("Instrucciones propias", report["prompt"])
        self.assertIn("Solicitud propia", report["prompt"])
        self.assertEqual(report["mode"], 0o600)
        self.assertFalse(pathlib.Path(report["prompt_path"]).exists())
        environment = report["environment"]
        self.assertEqual(environment["HOME"], "/home/node")
        self.assertEqual(environment["XDG_CONFIG_HOME"], "/home/node/.muse/config")
        self.assertEqual(environment["XDG_DATA_HOME"], "/home/node/.muse/data")
        for name in ("META_API_KEY", "MUSE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "MUSE_MODEL"):
            self.assertNotIn(name, environment)

    def test_resume_passes_only_the_real_muse_session_uuid(self) -> None:
        self.assertEqual(self.invoke(session_id=SESSION)["session_id"], SESSION)
        arguments = json.loads(self.report.read_text())["argv"]
        self.assertEqual(arguments[arguments.index("--session-id") + 1], SESSION)
        with self.assertRaises(BACKEND.BackendError) as raised:
            self.invoke("wrong-session", session_id=SESSION)
        self.assertEqual(raised.exception.code, "MUSE_SESSION_CHANGED")

    def test_completed_empty_terminal_uses_deltas_but_partial_only_never_succeeds(self) -> None:
        self.assertEqual(self.invoke("empty-terminal")["result"], "Hola")
        with self.assertRaises(BACKEND.BackendError) as raised:
            self.invoke("partial")
        self.assertEqual(raised.exception.code, "MUSE_RESULT_INCOMPLETE")

    def test_native_failure_nonzero_and_later_failure_cannot_be_promoted_to_success(self) -> None:
        for mode, code in (("failed", "MUSE_TERMINAL_FAILED"), ("nonzero", "MUSE_PROCESS_FAILED"),
                           ("later-failure", "MUSE_TERMINAL_FAILED"), ("malformed", "MUSE_OUTPUT_INVALID")):
            with self.subTest(mode=mode), self.assertRaises(BACKEND.BackendError) as raised:
                self.invoke(mode)
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("sensitive-fixture", str(raised.exception))
            self.assertFalse(any(frame["type"] == "result" for frame in self.frames))

    def test_session_and_run_identity_must_remain_consistent(self) -> None:
        for invalid in ("not-a-uuid", "../../another-tenant", ""):
            with self.subTest(session=invalid), self.assertRaises(BACKEND.BackendError):
                self.invoke(session_id=invalid)
        state = BACKEND.RunState(None, self.frames.append)
        state.record(envelope({"kind": "command_accepted", "command_kind": "turn.submit", "command_id": RUN_ID}))
        state.record(envelope({"kind": "run_output_delta", "text": "x", "command_id": RUN_ID,
                               "run_stream": {"kind": "run", "id": RUN_ID}}))
        with self.assertRaises(BACKEND.BackendError) as raised:
            state.record(envelope({"kind": "run_terminal", "terminal": "completed", "text": "answer",
                                   "command_id": "e4d2761d-26c6-41f9-a190-370fdcd2fa93",
                                   "run_stream": {"kind": "run", "id": RUN_ID}}))
        self.assertEqual(raised.exception.code, "MUSE_RUN_CHANGED")

    def test_timeout_kills_child_group_and_removes_prompt(self) -> None:
        for mode in ("hang", "closed-pipes"):
            started = time.monotonic()
            with self.subTest(mode=mode), self.assertRaises(BACKEND.BackendError) as raised:
                self.invoke(mode, timeout_seconds=0.25)
            self.assertEqual(raised.exception.code, "MUSE_TIMEOUT")
            self.assertLess(time.monotonic() - started, 2.0)
            report = json.loads(self.report.read_text())
            self.assert_process_stopped(report["pid"])
            self.assert_process_stopped(report["descendant_pid"])
            self.assertFalse(pathlib.Path(report["prompt_path"]).exists())

    def test_cli_final_result_is_unique_and_failed_stderr_never_leaks(self) -> None:
        for mode, expected_code in (("completed", 0), ("nonzero", 1), ("partial", 1)):
            with self.subTest(mode=mode):
                launcher = self.write_launcher(self.fake_child(mode))
                result = subprocess.run([sys.executable, str(launcher)], input=b"Solicitud propia",
                                        capture_output=True, timeout=3.0, check=False)
                self.assertEqual(result.returncode, expected_code)
                self.assertEqual(result.stderr, b"")
                self.assertNotIn(b"sensitive-fixture", result.stdout)
                frames = [json.loads(line) for line in result.stdout.splitlines()]
                results = [frame for frame in frames if frame["type"] == "result"]
                self.assertEqual(len(results), 1 if expected_code == 0 else 0)
                self.assertEqual(frames[-1]["type"], "result" if expected_code == 0 else "error")

    def test_cli_does_not_accept_model_or_provider_override(self) -> None:
        launcher = self.write_launcher(self.fake_child())
        result = subprocess.run([sys.executable, str(launcher), "--model", "sensitive-fixture-override"],
                                input=b"Solicitud propia", capture_output=True, timeout=3.0, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(b"sensitive-fixture", result.stdout)
        self.assertEqual(json.loads(result.stdout)["code"], "MUSE_ARGUMENTS_INVALID")
        self.assertFalse(self.report.exists())

    def test_generic_openclaw_item_parser_reads_the_answer_and_actual_muse_session(self) -> None:
        def generic_item_parse(stdout: bytes) -> tuple[str, str | None]:
            messages = []
            session_id = None
            for line in stdout.splitlines():
                parsed = json.loads(line)
                if isinstance(parsed.get("session_id"), str):
                    session_id = parsed["session_id"]
                item = parsed.get("item")
                if (isinstance(item, dict) and isinstance(item.get("type"), str)
                        and "message" in item["type"] and isinstance(item.get("text"), str)):
                    messages.append(item["text"])
            return "\n".join(messages), session_id

        result_only = json.dumps({"type": "result", "result": "Hola", "session_id": SESSION}).encode()
        self.assertEqual(generic_item_parse(result_only), ("", SESSION))
        launcher = self.write_launcher(self.fake_child())
        output = subprocess.run([sys.executable, str(launcher)], input=b"Solicitud propia", capture_output=True,
                                timeout=3.0, check=False)
        self.assertEqual(output.returncode, 0)
        self.assertEqual(output.stderr, b"")
        self.assertEqual(generic_item_parse(output.stdout), ("Hola", SESSION))
        self.assertEqual(sum(json.loads(line)["type"] == "result" for line in output.stdout.splitlines()), 1)

    def test_sigterm_to_wrapper_cancels_native_group_without_leaking_stderr(self) -> None:
        child = self.fake_child("hang")
        launcher = self.write_launcher(child)
        wrapper = subprocess.Popen([sys.executable, str(launcher)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: wrapper.kill() if wrapper.poll() is None else None)
        assert wrapper.stdin is not None
        wrapper.stdin.write(b"Solicitud propia")
        wrapper.stdin.close()
        wrapper.stdin = None
        deadline = time.monotonic() + 3.0
        while not self.report.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.report.exists())
        os.kill(wrapper.pid, signal.SIGTERM)
        stdout, stderr = wrapper.communicate(timeout=3.0)
        self.assertEqual(wrapper.returncode, 1)
        frames = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual(frames[-1]["type"], "error")
        self.assertEqual(frames[-1]["code"], "MUSE_CANCELLED")
        self.assertFalse(any(frame["type"] == "result" for frame in frames))
        self.assertEqual(stderr, b"")
        report = json.loads(self.report.read_text())
        self.assert_process_stopped(report["pid"])
        self.assert_process_stopped(report["descendant_pid"])

    def test_invalid_record_and_size_limits_are_fail_closed(self) -> None:
        state = BACKEND.RunState(None, self.frames.append)
        with self.assertRaises(BACKEND.BackendError):
            BACKEND.parse_record(b"not-json-sensitive-fixture", state)
        with mock.patch.object(BACKEND, "MAX_RECORD_BYTES", 8), self.assertRaises(BACKEND.BackendError):
            BACKEND.parse_record(b" " * 9, state)
        with mock.patch.object(BACKEND, "MAX_TEXT_BYTES", 1), self.assertRaises(BACKEND.BackendError):
            state.record(envelope({"kind": "command_accepted", "command_kind": "turn.submit", "command_id": RUN_ID}))
            state.record(envelope({"kind": "run_output_delta", "text": "too long", "command_id": RUN_ID,
                                   "run_stream": {"kind": "run", "id": RUN_ID}}))

    def test_unknown_schema_and_unadmitted_completion_never_succeed(self) -> None:
        terminal = {"kind": "run_terminal", "terminal": "completed", "text": "synthetic-unproven",
                    "command_id": RUN_ID, "run_stream": {"kind": "run", "id": RUN_ID}}
        for version in (None, 0, 2, 999, True):
            with self.subTest(version=version), self.assertRaises(BACKEND.BackendError) as raised:
                state = BACKEND.RunState(None, self.frames.append)
                state.record({**envelope(terminal), "schema_version": version})
            self.assertEqual(raised.exception.code, "MUSE_OUTPUT_INVALID")
        state = BACKEND.RunState(None, self.frames.append)
        with self.assertRaises(BACKEND.BackendError) as raised:
            state.record(envelope(terminal))
        self.assertEqual(raised.exception.code, "MUSE_RESULT_INCOMPLETE")
        with self.assertRaises(BACKEND.BackendError):
            state.result()

    def test_output_requires_accepted_turn_and_matching_inner_and_outer_stream(self) -> None:
        valid = {"kind": "run_terminal", "terminal": "completed", "text": "synthetic-answer",
                 "command_id": RUN_ID, "run_stream": {"kind": "run", "id": RUN_ID}}
        without_command = {key: value for key, value in valid.items() if key != "command_id"}
        without_stream = {key: value for key, value in valid.items() if key != "run_stream"}
        foreign_run = "e4d2761d-26c6-41f9-a190-370fdcd2fa93"
        invalid_events = [
            envelope(without_command), envelope(without_stream),
            envelope({**valid, "run_stream": {"kind": "run", "id": foreign_run}}),
            envelope({**valid, "command_id": foreign_run}),
            envelope(valid, "01a0e53f-1799-71d0-8531-21ed64d15828"),
            {**envelope(valid), "stream": {"kind": "run", "id": foreign_run}},
            {**envelope(valid), "payload_schema_version": 999},
        ]
        for event in invalid_events:
            with self.subTest(event=event):
                state = BACKEND.RunState(None, self.frames.append)
                state.record(envelope({"kind": "command_accepted", "command_kind": "turn.submit", "command_id": RUN_ID}))
                with self.assertRaises(BACKEND.BackendError):
                    state.record(event)
                with self.assertRaises(BACKEND.BackendError):
                    state.result()

    def test_precancelled_or_cancelled_before_launch_never_spawns_native_process(self) -> None:
        cancelled = threading.Event()
        cancelled.set()
        with mock.patch.object(BACKEND.subprocess, "Popen") as launch:
            with self.assertRaises(BACKEND.BackendError) as raised:
                self.invoke(cancelled=cancelled)
            self.assertEqual(raised.exception.code, "MUSE_CANCELLED")
            launch.assert_not_called()
        cancelled.clear()
        environment = BACKEND.native_environment()

        def cancel_before_launch() -> dict[str, str]:
            cancelled.set()
            return environment

        with mock.patch.object(BACKEND, "native_environment", side_effect=cancel_before_launch):
            with mock.patch.object(BACKEND.subprocess, "Popen") as launch:
                with self.assertRaises(BACKEND.BackendError) as raised:
                    self.invoke(cancelled=cancelled)
                self.assertEqual(raised.exception.code, "MUSE_CANCELLED")
                launch.assert_not_called()
        self.assertFalse(self.report.exists())

    def test_stdin_without_eof_obeys_sigterm_and_deadline_without_spawning(self) -> None:
        for mode in ("cancel", "timeout"):
            with self.subTest(mode=mode):
                marker = self.directory / "input-ready"
                marker.unlink(missing_ok=True)
                launcher = self.write_launcher(self.fake_child(), 0.25 if mode == "timeout" else 5.0)
                wrapper = subprocess.Popen([sys.executable, str(launcher)], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 2.0
                    while not marker.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(marker.exists())
                    if mode == "cancel":
                        os.kill(wrapper.pid, signal.SIGTERM)
                    wrapper.wait(timeout=1.0)
                    assert wrapper.stdout is not None and wrapper.stderr is not None
                    stdout, stderr = wrapper.stdout.read(), wrapper.stderr.read()
                    self.assertEqual(wrapper.returncode, 1)
                    self.assertEqual(stderr, b"")
                    error = json.loads(stdout)
                    self.assertEqual(error["type"], "error")
                    self.assertEqual(error["code"], "MUSE_CANCELLED" if mode == "cancel" else "MUSE_TIMEOUT")
                    self.assertFalse(self.report.exists())
                finally:
                    if wrapper.poll() is None:
                        wrapper.kill()
                        wrapper.wait()
                    for pipe in (wrapper.stdin, wrapper.stdout, wrapper.stderr):
                        if pipe is not None:
                            pipe.close()


if __name__ == "__main__":
    unittest.main()
