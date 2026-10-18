from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
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
SESSION = "00000000-0000-4000-8000-f30219022182"
RUN_ID = "00000000-0000-4000-8000-a2ac7545efdc"


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
    SESSION = '00000000-0000-4000-8000-20c42b51800b'
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

    def test_native_failure_nonzero_and_later_failure_cannot_be_promoted_to_success(self) -> None:
        for mode, code in (("failed", "MUSE_TERMINAL_FAILED"), ("nonzero", "MUSE_PROCESS_FAILED"),
                           ("later-failure", "MUSE_TERMINAL_FAILED"), ("malformed", "MUSE_OUTPUT_INVALID")):
            with self.subTest(mode=mode), self.assertRaises(BACKEND.BackendError) as raised:
                self.invoke(mode)
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("sensitive-fixture", str(raised.exception))
            self.assertFalse(any(frame["type"] == "result" for frame in self.frames))

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

    def test_output_requires_accepted_turn_and_matching_inner_and_outer_stream(self) -> None:
        valid = {"kind": "run_terminal", "terminal": "completed", "text": "synthetic-answer",
                 "command_id": RUN_ID, "run_stream": {"kind": "run", "id": RUN_ID}}
        without_command = {key: value for key, value in valid.items() if key != "command_id"}
        without_stream = {key: value for key, value in valid.items() if key != "run_stream"}
        foreign_run = "00000000-0000-4000-8000-0ee9e0933576"
        invalid_events = [
            envelope(without_command), envelope(without_stream),
            envelope({**valid, "run_stream": {"kind": "run", "id": foreign_run}}),
            envelope({**valid, "command_id": foreign_run}),
            envelope(valid, "00000000-0000-4000-8000-20c42b51800b"),
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

if __name__ == "__main__":
    unittest.main()
