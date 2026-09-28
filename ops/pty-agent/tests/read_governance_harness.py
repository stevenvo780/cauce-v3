#!/usr/bin/env python3
"""Base compartida de los tests de read_governance (poda T060-D).

Movido byte a byte desde test_read_governance.py: constructores y caso base sin
metodos de prueba propios, para que test_read_governance.py y
test_read_governance_traversal.py los reutilicen sin duplicarlos.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402


def make_agent(home: str) -> agent.PtyAgent:
    instance = agent.PtyAgent.__new__(agent.PtyAgent)
    canonical_home = os.path.realpath(home)
    claude_config = f"{canonical_home}/.claude"
    os.makedirs(claude_config, exist_ok=True)
    instance.bundle = {
        "home": canonical_home,
        "harness": "claude",
        "runtime_facts": {"claude_config_dir": claude_config},
    }
    instance.outbound = bytearray()  # `_queue` hace self.outbound.extend(frame)
    return instance


def drain(instance: agent.PtyAgent) -> list[tuple[int, bytes]]:
    """Parte instance.outbound en (tag, payload) para poder afirmar sobre las tramas."""
    decoder = agent.FrameDecoder()
    frames = decoder.feed(bytes(instance.outbound))
    instance.outbound.clear()
    return frames


class ReadGovernanceBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.temp_dir.name)
        self.claude_config = f"{self.home}/.claude"
        self.claude_md = f"{self.claude_config}/CLAUDE.md"
        self.memory_root = f"{self.claude_config}/projects"
        os.makedirs(self.claude_config)
        os.makedirs(self.memory_root)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def expect_error(self, instance: agent.PtyAgent, code: str, **request) -> dict:
        instance.outbound.clear()
        instance._on_read(request)
        frames = drain(instance)

        self.assertEqual(len(frames), 1, f"Expected exactly 1 frame, got {len(frames)}")
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_READ_ERR, f"Expected TAG_READ_ERR (0x52), got {hex(tag)}")

        # Load JSON payload
        data = json.loads(payload.decode("utf-8"))
        self.assertEqual(data.get("error"), code)
        self.assertIn("reason", data)
        self.assertEqual(data.get("request_id"), request.get("request_id"))
        return data

    def assert_done(self, frame: tuple[int, bytes], request_id: str) -> None:
        tag, payload = frame
        self.assertEqual(tag, agent.TAG_READ_DONE)
        self.assertEqual(json.loads(payload.decode("utf-8")), {"request_id": request_id})

