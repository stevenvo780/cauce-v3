#!/usr/bin/env python3
"""La medición del perfil OpenClaw usa el alias visible, no la clave física."""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from cauce_pty_agent.tui_environment import measured_environment, openclaw_local  # noqa: E402

GENERATION = "ab" * 32


class MeasuredOpenClawProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temporary.name)
        self.state = self.home / "state"
        self.state.mkdir(mode=0o700)
        self.paths = {
            "OPENCLAW_HOME": self.home / "openclaw",
            "OPENCLAW_STATE_DIR": self.home / "openclaw-state",
            "OPENCLAW_CONFIG_PATH": self.home / "openclaw.json",
            "OPENCLAW_AGENT_DIR": self.home / "agent",
            "TMPDIR": self.home / "tmp",
            "NODE_COMPILE_CACHE": self.home / "cache",
            "CODEX_HOME": self.home / "codex",
            "CLAUDE_CONFIG_DIR": self.home / "claude",
        }
        for path in self.paths.values():
            path.mkdir(mode=0o700) if path.suffix == "" else path.write_text("", encoding="utf-8")
        self.processes: list[subprocess.Popen[bytes]] = []

    def tearDown(self) -> None:
        for process in self.processes:
            process.terminate()
        for process in self.processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        self.temporary.cleanup()

    def bundle(self, alias: str = "argos") -> dict[str, object]:
        return {
            "alias": alias,
            "home": str(self.home),
            "harness": "openclaw",
            "container_id": "container-argos",
            "tenant_id": "Steven",
            "session_recovery": {
                "state_directory": str(self.state),
                "adapter_generation": GENERATION,
            },
        }

    def spawn(self, *, alias: str | None, runtime_key: str | None, local: bool = True) -> None:
        environment = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(self.home),
            "CAUCE_STATE_DIR": str(self.state),
            "CAUCE_CONTAINER_ID": "container-argos",
            "CAUCE_CONTAINER_GENERATION": GENERATION,
            "CAUCE_TENANT_ID": "Steven",
            "CAUCE_HARNESS_COMMAND": "/usr/bin/node",
            "CAUCE_OPENCLAW_DIST_DIR": "/usr/lib/openclaw/dist",
            **{key: str(path) for key, path in self.paths.items()},
        }
        if alias is not None:
            environment["CAUCE_ALIAS"] = alias
        if runtime_key is not None:
            environment["CAUCE_RUNTIME_KEY"] = runtime_key
        if local:
            environment["CAUCE_OPENCLAW_LOCAL"] = "1"
            environment["CAUCE_OPENCLAW_AGENT_ID"] = "main"
        self.processes.append(subprocess.Popen(["/bin/sleep", "30"], env=environment))

    def test_wire_alias_matches_when_the_physical_key_differs(self) -> None:
        self.spawn(alias="argos", runtime_key="argos-physical")
        bundle = self.bundle()
        measured = measured_environment(bundle)
        self.assertEqual(measured.get("CAUCE_HARNESS_COMMAND"), "/usr/bin/node")
        self.assertEqual(measured.get("CAUCE_OPENCLAW_DIST_DIR"), "/usr/lib/openclaw/dist")
        self.assertEqual(measured.get("OPENCLAW_HOME"), str(self.paths["OPENCLAW_HOME"]))
        self.assertTrue(openclaw_local(bundle))

    def test_runtime_key_still_identifies_a_process_without_a_wire_alias(self) -> None:
        self.spawn(alias=None, runtime_key="argos", local=False)
        measured = measured_environment(self.bundle())
        self.assertEqual(measured.get("CAUCE_HARNESS_COMMAND"), "/usr/bin/node")
        self.assertFalse(openclaw_local(self.bundle()))

    def test_another_wire_alias_does_not_match_via_its_physical_key(self) -> None:
        self.spawn(alias="other", runtime_key="argos")
        self.assertEqual(measured_environment(self.bundle()), {})
        self.assertFalse(openclaw_local(self.bundle()))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
