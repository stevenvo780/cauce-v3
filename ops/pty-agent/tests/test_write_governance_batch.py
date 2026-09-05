#!/usr/bin/env python3
"""Perfil OpenClaw: preflight completo, verify sin mtime, ACK por fichero y rollback."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import stat
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


class DeviceMismatch:
    """Real stat that reports its directory on another device, like a mount point does."""

    def __init__(self, real: os.stat_result) -> None:
        self._real = real
        self.st_dev = real.st_dev + 1

    def __getattr__(self, name: str):
        return getattr(self._real, name)


def parent_on_another_device():
    """Makes every parent directory look like another filesystem: the target reads as a mount."""
    real_fstat = os.fstat

    def fstat(fd):
        info = real_fstat(fd)
        return DeviceMismatch(info) if stat.S_ISDIR(info.st_mode) else info

    return mock.patch.object(agent.os, "fstat", side_effect=fstat)


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
            # Simulates retry after a lost ACK: the desired bytes are already there and the
            # previous SHA no longer matches. It MUST be `unchanged`, not conflict nor rewrite.
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

    def test_each_document_can_have_its_own_partial_chunk(self) -> None:
        names = ("SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md")
        entries = [write_entry(self.path(name), b"x", "create") for name in names]
        tag, body = run_batch(self.instance, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", entries)
        self.assertEqual(tag, agent.TAG_WRITE_BATCH_OK)
        self.assertEqual(len(body["files"]), len(names))
        for name in names:
            self.assertEqual(pathlib.Path(self.path(name)).read_bytes(), b"x")

    def test_fragmented_profile_accepts_exact_byte_limit_and_preserves_verified_files(self) -> None:
        names = ("SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md")
        entries = [write_entry(self.path(name), b"x", "create") for name in names[:-1]]
        entries.append(write_entry(self.path(names[-1]), b"x" * (agent.MAX_WRITE_BATCH_BYTES - 4), "create"))
        for name in ("MEMORY.md", "HEARTBEAT.md"):
            pathlib.Path(self.path(name)).write_bytes(b"preserved")
            entries.append(verify_entry(self.path(name), "present", sha(b"preserved")))
        before = {name: os.stat(self.path(name)) for name in ("MEMORY.md", "HEARTBEAT.md")}
        tag, body = run_batch(self.instance, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", entries)
        self.assertEqual(tag, agent.TAG_WRITE_BATCH_OK)
        self.assertEqual(len(body["files"]), 7)
        for name, previous in before.items():
            current = os.stat(self.path(name))
            self.assertEqual((current.st_ino, current.st_mtime_ns), (previous.st_ino, previous.st_mtime_ns))
            self.assertEqual(pathlib.Path(self.path(name)).read_bytes(), b"preserved")

    def test_fragmentation_does_not_increase_the_total_byte_limit(self) -> None:
        tag, body = run_batch(self.instance, "cccccccc-cccc-cccc-cccc-cccccccccccc", [
            write_entry(self.path("SOUL.md"), b"x", "create"),
            write_entry(self.path("TOOLS.md"), b"x" * agent.MAX_WRITE_BATCH_BYTES, "create"),
        ])
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "too_large"))
        self.assertEqual(list(pathlib.Path(self.workspace).iterdir()), [])

    def test_fragmentation_does_not_increase_the_per_document_chunk_limit(self) -> None:
        entry = write_entry(self.path("SOUL.md"), b"x", "create")
        entry["chunks"] = (agent.MAX_DOCUMENT_BYTES + agent.MAX_DATA - 1) // agent.MAX_DATA + 1
        tag, body = run_batch(self.instance, "dddddddd-dddd-dddd-dddd-dddddddddddd", [entry])
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "too_large"))
        self.assertEqual(list(pathlib.Path(self.workspace).iterdir()), [])

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


    def test_bind_mounted_target_refuses_the_batch_instead_of_breaking_the_mount(self) -> None:
        """The rollback restores the ORIGINAL inode by hardlink; over a mount there is nothing
        to restore, so the profile refuses as a whole rather than detaching it."""
        soul = self.path("SOUL.md")
        tools = self.path("TOOLS.md")
        pathlib.Path(soul).write_bytes(b"old soul")
        before = os.stat(soul)

        with parent_on_another_device():
            tag, body = run_batch(self.instance, "77777777-7777-7777-7777-777777777777", [
                write_entry(soul, b"new soul", "replace", sha(b"old soul")),
                write_entry(tools, b"tools", "create"),
            ])

        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "bind_mount_target"))
        self.assertIn("SOUL.md", body.get("reason", ""))
        self.assertEqual(pathlib.Path(soul).read_bytes(), b"old soul")
        self.assertEqual(os.stat(soul).st_ino, before.st_ino)
        self.assertFalse(os.path.exists(tools))
        self.assertEqual(list(pathlib.Path(self.workspace).glob(".cauce-profile-*")), [])

    def test_a_same_filesystem_bind_refuses_the_batch_through_mountinfo(self) -> None:
        """The batch and the single write decide the mount question with the same routine."""
        soul = self.path("SOUL.md")
        pathlib.Path(soul).write_bytes(b"old soul")
        before = os.stat(soul)
        listing = f"31 30 0:35 / {soul} rw,relatime shared:1 - tmpfs tmpfs rw\n"

        with mock.patch.object(agent, "_read_mountinfo", return_value=listing):
            tag, body = run_batch(self.instance, "88888888-8888-8888-8888-888888888888", [
                write_entry(soul, b"new soul", "replace", sha(b"old soul")),
            ])

        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_BATCH_ERR, "bind_mount_target"))
        self.assertEqual(pathlib.Path(soul).read_bytes(), b"old soul")
        self.assertEqual(os.stat(soul).st_ino, before.st_ino)
        self.assertEqual(list(pathlib.Path(self.workspace).glob(".cauce-profile-*")), [])


if __name__ == "__main__":
    unittest.main()
