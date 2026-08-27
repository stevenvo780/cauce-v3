#!/usr/bin/env python3
"""Perfil OpenClaw: preflight completo, verify sin mtime, ACK por fichero y rollback."""
from __future__ import annotations

import hashlib
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


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_agent(home: str, workspace: str) -> agent.PtyAgent:
    instance = agent.PtyAgent.__new__(agent.PtyAgent)
    instance.bundle = {
        "home": home, "harness": "openclaw",
        "runtime_facts": {"openclaw_workspace": workspace},
    }
    instance.pending_writes = {}
    instance.pending_write_batches = {}
    instance.outbound = bytearray()
    return instance


def emitted(instance: agent.PtyAgent) -> tuple[int, dict]:
    frames = agent.FrameDecoder().feed(bytes(instance.outbound))
    instance.outbound.clear()
    if len(frames) != 1:
        raise AssertionError(f"expected one outcome, got {frames!r}")
    tag, payload = frames[0]
    return tag, json.loads(payload.decode("utf-8"))


def write_entry(path: str, content: bytes, operation: str, expected: str | None = None) -> dict:
    chunks = [content[offset:offset + agent.MAX_DATA] for offset in range(0, len(content), agent.MAX_DATA)]
    entry = {
        "path": path, "mode": "write", "operation": operation,
        "content_sha": sha(content), "bytes": len(content), "chunks": len(chunks),
    }
    if expected is not None:
        entry["expected_sha"] = expected
    entry["_chunks"] = chunks
    return entry


def verify_entry(path: str, operation: str, expected: str | None = None) -> dict:
    entry = {"path": path, "mode": "verify", "operation": operation, "bytes": 0, "chunks": 0}
    if expected is not None:
        entry["expected_sha"] = expected
    return entry


def run_batch(instance: agent.PtyAgent, request_id: str, entries: list[dict]) -> tuple[int, dict]:
    wire: list[dict] = []
    chunks: list[bytes] = []
    for entry in entries:
        copy = dict(entry)
        chunks.extend(copy.pop("_chunks", []))
        wire.append(copy)
    instance._on_write_batch({"request_id": request_id, "entries": wire})
    for chunk in chunks:
        instance._on_write_batch_data(request_id, chunk)
    return emitted(instance)


class WriteGovernanceBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.directory.name)
        self.workspace = os.path.join(self.home, ".openclaw", "workspace")
        os.makedirs(self.workspace)
        self.instance = make_agent(self.home, self.workspace)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def path(self, name: str) -> str:
        return os.path.join(self.workspace, name)

    def test_write_retry_and_verify_are_noops_with_explicit_ack(self) -> None:
        soul = self.path("SOUL.md")
        memory = self.path("MEMORY.md")
        pathlib.Path(soul).write_bytes(b"same")
        pathlib.Path(memory).write_bytes(b"agent memory")
        soul_before = os.stat(soul)
        memory_before = os.stat(memory)

        tag, body = run_batch(self.instance, "11111111-1111-1111-1111-111111111111", [
            # Simula retry después de ACK perdido: ya están los bytes deseados y el SHA anterior
            # ya no coincide. Debe ser `unchanged`, no conflicto ni rewrite.
            write_entry(soul, b"same", "replace", "0" * 64),
            verify_entry(memory, "present", sha(b"agent memory")),
            verify_entry(self.path("HEARTBEAT.md"), "absent"),
        ])

        self.assertEqual(tag, agent.TAG_WRITE_BATCH_OK)
        self.assertEqual([item["operation"] for item in body["files"]], ["unchanged", "unchanged", "absent"])
        self.assertEqual(body["files"][2]["sha"], None)
        self.assertEqual((os.stat(soul).st_ino, os.stat(soul).st_mtime_ns),
                         (soul_before.st_ino, soul_before.st_mtime_ns))
        self.assertEqual((os.stat(memory).st_ino, os.stat(memory).st_mtime_ns),
                         (memory_before.st_ino, memory_before.st_mtime_ns))

    def test_create_and_replace_commit_as_one_profile(self) -> None:
        soul = self.path("SOUL.md")
        tools = self.path("TOOLS.md")
        pathlib.Path(soul).write_bytes(b"old")
        tag, body = run_batch(self.instance, "22222222-2222-2222-2222-222222222222", [
            write_entry(soul, b"new", "replace", sha(b"old")),
            write_entry(tools, b"tools", "create"),
        ])
        self.assertEqual(tag, agent.TAG_WRITE_BATCH_OK)
        self.assertEqual([item["operation"] for item in body["files"]], ["replace", "create"])
        self.assertEqual(pathlib.Path(soul).read_bytes(), b"new")
        self.assertEqual(pathlib.Path(tools).read_bytes(), b"tools")

    def test_any_preflight_conflict_leaves_every_file_untouched(self) -> None:
        soul = self.path("SOUL.md")
        tools = self.path("TOOLS.md")
        pathlib.Path(soul).write_bytes(b"old")
        pathlib.Path(tools).write_bytes(b"changed elsewhere")
        tag, body = run_batch(self.instance, "33333333-3333-3333-3333-333333333333", [
            write_entry(soul, b"new", "replace", sha(b"old")),
            write_entry(tools, b"tools", "replace", sha(b"expected")),
        ])
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "conflict"))
        self.assertEqual(pathlib.Path(soul).read_bytes(), b"old")
        self.assertEqual(pathlib.Path(tools).read_bytes(), b"changed elsewhere")

    def test_commit_failure_rolls_back_the_already_replaced_prefix(self) -> None:
        soul = self.path("SOUL.md")
        tools = self.path("TOOLS.md")
        pathlib.Path(soul).write_bytes(b"old soul")
        pathlib.Path(tools).write_bytes(b"old tools")
        real_replace = os.replace
        failed = False

        def replace_once(source, destination, *args, **kwargs):
            nonlocal failed
            if str(source).endswith("-1.tmp") and not failed:
                failed = True
                raise OSError("injected second commit failure")
            return real_replace(source, destination, *args, **kwargs)

        with mock.patch.object(agent.os, "replace", side_effect=replace_once):
            tag, body = run_batch(self.instance, "44444444-4444-4444-4444-444444444444", [
                write_entry(soul, b"new soul", "replace", sha(b"old soul")),
                write_entry(tools, b"new tools", "replace", sha(b"old tools")),
            ])
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "unknown"))
        self.assertEqual(pathlib.Path(soul).read_bytes(), b"old soul")
        self.assertEqual(pathlib.Path(tools).read_bytes(), b"old tools")
        self.assertEqual(list(pathlib.Path(self.workspace).glob(".cauce-profile-*")), [])

    def test_allowlist_is_exact_and_rejects_non_governance_document(self) -> None:
        tag, body = run_batch(self.instance, "55555555-5555-5555-5555-555555555555", [
            write_entry(self.path("settings.json"), b"{}", "create"),
        ])
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "permission_denied"))
        self.assertIn("not a governance document", body.get("reason", ""))
        self.assertFalse(os.path.exists(self.path("settings.json")))

    def test_never_serve_rejects_openclaw_json_as_credential_file(self) -> None:
        tag, body = run_batch(self.instance, "55555555-5555-5555-5555-666666666666", [
            write_entry(self.path("openclaw.json"), b"{}", "create"),
        ])
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "permission_denied"))
        self.assertIn("never served", body.get("reason", ""))
        self.assertFalse(os.path.exists(self.path("openclaw.json")))


if __name__ == "__main__":
    unittest.main()
