#!/usr/bin/env python3
"""Resolución segura y dinámica de la conversación OpenClaw por cada OPEN."""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402


class DynamicOpenClawSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temporary.name)
        self.state = self.home / ".openclaw" / "cauce-v3" / "jarvis"
        self.state.mkdir(parents=True, mode=0o700)
        self.store = self.state / "sessions.json"
        self.bundle = {
            "alias": "jarvis",
            "harness_command": None,
            "openclaw_tui": {
                "node": "/usr/bin/node",
                "entry": "/usr/lib/node_modules/openclaw/dist/index.js",
                "state_directory": str(self.state),
                "history_limit": 200,
            },
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write(self, native_id: str, *, initialized: bool = True, key: str | None = None) -> None:
        document = {
            "version": 1,
            "sessions": {
                key or "openclaw:jarvis:shared:jarvis": {
                    "native_id": native_id,
                    "initialized": initialized,
                },
            },
        }
        replacement = self.state / ".sessions.next"
        replacement.write_text(json.dumps(document), encoding="utf-8")
        replacement.chmod(0o600)
        os.replace(replacement, self.store)

    def test_each_open_reads_the_current_durable_pointer_not_mtime(self) -> None:
        self._write("conversation-first")
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle = self.bundle
        self.assertEqual(instance._resolve_command("harness")[-3:], ["conversation-first", "--history-limit", "200"])

        # El pointer cambia por rename atómico. No se reinicia agente ni launcher.
        self._write("conversation-second")
        # Un transcript más nuevo no participa de la decisión.
        decoy = self.home / ".openclaw" / "agents" / "main" / "sessions" / "newest.jsonl"
        decoy.parent.mkdir(parents=True)
        decoy.write_text("{}\n", encoding="utf-8")
        self.assertEqual(instance._resolve_command("harness")[-3:], ["conversation-second", "--history-limit", "200"])

    def test_missing_uninitialized_or_wrong_pointer_fails_closed(self) -> None:
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))
        self._write("not-ready", initialized=False)
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))
        self._write("other-conversation", key="openclaw:jarvis:alias-default")
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))

    def test_presence_advertises_harness_only_while_the_canonical_pointer_is_valid(self) -> None:
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle = self.bundle
        self.assertEqual(instance._advertised_modes(), ["shell"])
        self._write("conversation-safe")
        self.assertEqual(instance._advertised_modes(), ["shell", "harness"])
        self._write("conversation-not-ready", initialized=False)
        self.assertEqual(instance._advertised_modes(), ["shell"])

    def test_duplicate_canonical_pointer_is_ambiguous_and_fails_closed(self) -> None:
        key = "openclaw:jarvis:shared:jarvis"
        pointer = '{"native_id":"conversation-safe","initialized":true}'
        self.store.write_text(
            f'{{"version":1,"sessions":{{"{key}":{pointer},"{key}":{pointer}}}}}',
            encoding="utf-8",
        )
        self.store.chmod(0o600)
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))

    def test_pointer_degradation_forces_a_new_hello_instead_of_stale_presence(self) -> None:
        self._write("conversation-safe")
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle = self.bundle
        instance.modes = ["shell", "harness"]
        instance.sessions = {}
        instance.tombstones = {}
        instance.acknowledged = True
        instance.last_ping = 100.0
        instance.connected_at = 100.0
        instance.next_dynamic_capability_check = 0.0
        self.store.write_text("{corrupt", encoding="utf-8")
        self.store.chmod(0o600)
        with mock.patch.object(agent.time, "monotonic", return_value=100.0):
            with self.assertRaisesRegex(agent.ProtocolError, "dynamic harness capability changed"):
                instance._maintain()

    def test_hostile_native_id_and_permissive_store_are_rejected(self) -> None:
        self._write("value;touch-/tmp/no")
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))
        self._write("conversation-safe")
        self.store.chmod(0o644)
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))

    def test_a_symlink_store_is_never_followed(self) -> None:
        target = self.state / "target.json"
        self._write("conversation-safe")
        self.store.replace(target)
        self.store.symlink_to(target)
        self.assertIsNone(agent.resolve_openclaw_tui_command(self.bundle))


class OpenClawBundleValidationTests(unittest.TestCase):
    def test_resolver_must_be_inside_home_and_cannot_compete_with_static_argv(self) -> None:
        resolver = {
            "node": "/usr/bin/node",
            "entry": "/opt/openclaw/index.js",
            "state_directory": "/home/claw/.openclaw/cauce-v3/jarvis",
            "history_limit": 200,
        }
        self.assertEqual(agent._openclaw_tui_config(resolver, "openclaw", "/home/claw"), resolver)
        with self.assertRaises(agent.PermanentError):
            agent._openclaw_tui_config({**resolver, "state_directory": "/tmp/other"}, "openclaw", "/home/claw")
        with self.assertRaises(agent.PermanentError):
            agent._openclaw_tui_config(resolver, "codex", "/home/claw")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
