#!/usr/bin/env python3
"""Contrato de escritura gobernada: CAS, creación explícita y E/S sin shell."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_agent(home: str) -> agent.PtyAgent:
    instance = agent.PtyAgent.__new__(agent.PtyAgent)
    config = os.path.join(os.path.realpath(home), ".claude")
    instance.bundle = {
        "home": os.path.realpath(home), "harness": "claude",
        "runtime_facts": {"claude_config_dir": config},
    }
    instance.pending_writes = {}
    instance.pending_write_batches = {}
    instance.outbound = bytearray()
    return instance


def frames(instance: agent.PtyAgent) -> list[tuple[int, dict]]:
    decoded = agent.FrameDecoder().feed(bytes(instance.outbound))
    instance.outbound.clear()
    return [(tag, json.loads(payload.decode("utf-8"))) for tag, payload in decoded]


def write(
    instance: agent.PtyAgent,
    request_id: str,
    path: str,
    content: bytes,
    operation: str,
    expected_sha: str | None = None,
) -> tuple[int, dict]:
    chunks = [content[offset:offset + agent.MAX_DATA] for offset in range(0, len(content), agent.MAX_DATA)]
    request = {
        "request_id": request_id,
        "path": path,
        "operation": operation,
        "content_sha": sha(content),
        "bytes": len(content),
        "chunks": len(chunks),
    }
    if expected_sha is not None:
        request["expected_sha"] = expected_sha
    instance._on_write(request)
    for chunk in chunks:
        instance._on_write_data(request_id, chunk)
    emitted = frames(instance)
    if len(emitted) != 1:
        raise AssertionError(f"expected one terminal outcome, got {emitted!r}")
    return emitted[0]


class WriteGovernanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.directory.name)
        self.config = os.path.join(self.home, ".claude")
        os.mkdir(self.config)
        self.path = os.path.join(self.config, "CLAUDE.md")
        self.instance = make_agent(self.home)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_create_is_explicit_and_acknowledges_the_bytes_on_disk(self) -> None:
        content = "# Manual\ncon acentos: acción\n".encode()
        tag, body = write(
            self.instance, "11111111-1111-1111-1111-111111111111",
            self.path, content, "create",
        )

        self.assertEqual(tag, agent.TAG_WRITE_OK)
        self.assertEqual(body, {
            "bytes": len(content),
            "operation": "create",
            "path": self.path,
            "request_id": "11111111-1111-1111-1111-111111111111",
            "sha": sha(content),
        })
        self.assertEqual(pathlib.Path(self.path).read_bytes(), content)

    def test_replace_requires_the_exact_current_sha_and_preserves_mode(self) -> None:
        old = b"old\n"
        pathlib.Path(self.path).write_bytes(old)
        os.chmod(self.path, 0o640)
        content = b"new\n"

        tag, body = write(
            self.instance, "22222222-2222-2222-2222-222222222222",
            self.path, content, "replace", sha(old),
        )

        self.assertEqual(tag, agent.TAG_WRITE_OK)
        self.assertEqual(body["sha"], sha(content))
        self.assertEqual(pathlib.Path(self.path).read_bytes(), content)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o640)

    def test_wrong_sha_is_conflict_and_never_changes_the_file(self) -> None:
        old = b"kept\n"
        pathlib.Path(self.path).write_bytes(old)

        tag, body = write(
            self.instance, "33333333-3333-3333-3333-333333333333",
            self.path, b"lost\n", "replace", "0" * 64,
        )

        self.assertEqual(tag, agent.TAG_WRITE_ERR)
        self.assertEqual(body["error"], "conflict")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), old)

    def test_missing_sha_is_not_interpreted_as_create_or_last_writer_wins(self) -> None:
        pathlib.Path(self.path).write_bytes(b"old")

        tag, body = write(
            self.instance, "44444444-4444-4444-4444-444444444444",
            self.path, b"new", "replace",
        )

        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_ERR, "invalid_path"))
        self.assertEqual(pathlib.Path(self.path).read_bytes(), b"old")

    def test_create_never_overwrites_an_existing_different_file(self) -> None:
        pathlib.Path(self.path).write_bytes(b"someone won")

        tag, body = write(
            self.instance, "55555555-5555-5555-5555-555555555555",
            self.path, b"mine", "create",
        )

        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_ERR, "conflict"))
        self.assertEqual(pathlib.Path(self.path).read_bytes(), b"someone won")

    def test_lost_ack_retry_is_idempotent_for_create_and_replace(self) -> None:
        created = b"same create"
        for suffix in (1, 2):
            tag, _ = write(
                self.instance, f"66666666-6666-6666-6666-{suffix:012d}",
                self.path, created, "create",
            )
            self.assertEqual(tag, agent.TAG_WRITE_OK)

        replacement = b"same replace"
        old_sha = sha(created)
        for suffix in (3, 4):
            tag, _ = write(
                self.instance, f"66666666-6666-6666-6666-{suffix:012d}",
                self.path, replacement, "replace", old_sha,
            )
            self.assertEqual(tag, agent.TAG_WRITE_OK)
        self.assertEqual(pathlib.Path(self.path).read_bytes(), replacement)

    def test_two_concurrent_edits_from_one_snapshot_have_one_winner(self) -> None:
        old = b"base"
        pathlib.Path(self.path).write_bytes(old)
        first = write(
            self.instance, "77777777-7777-7777-7777-777777777771",
            self.path, b"first", "replace", sha(old),
        )
        second = write(
            self.instance, "77777777-7777-7777-7777-777777777772",
            self.path, b"second", "replace", sha(old),
        )

        self.assertEqual(first[0], agent.TAG_WRITE_OK)
        self.assertEqual((second[0], second[1]["error"]), (agent.TAG_WRITE_ERR, "conflict"))
        self.assertEqual(pathlib.Path(self.path).read_bytes(), b"first")

    def test_target_and_parent_symlinks_never_redirect_the_write(self) -> None:
        outside = os.path.join(self.home, "outside")
        os.mkdir(outside)
        victim = os.path.join(outside, "CLAUDE.md")
        pathlib.Path(victim).write_bytes(b"secret")

        os.symlink(victim, self.path)
        tag, _ = write(
            self.instance, "88888888-8888-8888-8888-888888888881",
            self.path, b"attack", "replace", sha(b"secret"),
        )
        self.assertEqual(tag, agent.TAG_WRITE_ERR)
        self.assertEqual(pathlib.Path(victim).read_bytes(), b"secret")
        os.unlink(self.path)

        os.rmdir(self.config)
        os.symlink(outside, self.config)
        tag, _ = write(
            self.instance, "88888888-8888-8888-8888-888888888882",
            self.path, b"attack", "replace", sha(b"secret"),
        )
        self.assertEqual(tag, agent.TAG_WRITE_ERR)
        self.assertEqual(pathlib.Path(victim).read_bytes(), b"secret")

    def test_path_and_content_are_never_interpreted_by_a_shell(self) -> None:
        sentinel = os.path.join(self.home, "PWNED")
        hostile_path = os.path.join(self.config, "CLAUDE.md;touch PWNED")
        tag, body = write(
            self.instance, "99999999-9999-9999-9999-999999999991",
            hostile_path, b"x", "create",
        )
        self.assertEqual((tag, body["error"]), (agent.TAG_WRITE_ERR, "permission_denied"))

        literal = f"$(touch {sentinel})\n; touch {sentinel}\n".encode()
        tag, _ = write(
            self.instance, "99999999-9999-9999-9999-999999999992",
            self.path, literal, "create",
        )
        self.assertEqual(tag, agent.TAG_WRITE_OK)
        self.assertEqual(pathlib.Path(self.path).read_bytes(), literal)
        self.assertFalse(os.path.exists(sentinel))

    def test_cancel_discards_an_incomplete_transaction(self) -> None:
        request_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        content = b"not committed"
        self.instance._on_write({
            "request_id": request_id,
            "path": self.path,
            "operation": "create",
            "content_sha": sha(content),
            "bytes": len(content),
            "chunks": 1,
        })
        self.instance._on_write_cancel({"request_id": request_id})
        self.instance._on_write_data(request_id, content)

        self.assertEqual(frames(self.instance), [])
        self.assertFalse(os.path.exists(self.path))

    def test_empty_file_is_a_valid_explicit_creation(self) -> None:
        tag, body = write(
            self.instance, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            self.path, b"", "create",
        )
        self.assertEqual(tag, agent.TAG_WRITE_OK)
        self.assertEqual(body["bytes"], 0)
        self.assertEqual(pathlib.Path(self.path).read_bytes(), b"")


if __name__ == "__main__":
    unittest.main()
