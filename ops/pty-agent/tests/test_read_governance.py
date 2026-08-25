#!/usr/bin/env python3
"""Tests for the read_governance features in ops/pty-agent/cauce_pty_agent.py.

This test file verifies the secure reading of governance files (like CLAUDE.md
and AGENTS.md) and memory index directory scans. Since this mechanism handles
potentially sensitive files, it must fail closed and strictly enforce boundary
containment, symlink rejection, canonical path validation, and never-serve rules.

Runs standalone (`python3 ops/pty-agent/tests/test_read_governance.py`) or under
`python3 -m unittest discover ops/pty-agent/tests`.
"""
from __future__ import annotations

import json
import os
import pathlib
import stat
import sys
import tempfile
import time
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


class ReadGovernanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.temp_dir.name)
        self.claude_config = f"{self.home}/.claude"
        self.claude_md = f"{self.claude_config}/CLAUDE.md"
        os.makedirs(self.claude_config)

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

    def test_test_home_is_canonical(self) -> None:
        """Asserts that the test environment's temp directory is canonical.
        
        If this test fails, it explains why other tests might have raised symlink_detected
        due to the test home directory itself not being canonical in the runner environment.
        """
        self.assertEqual(os.path.realpath(self.temp_dir.name), self.temp_dir.name)

    def test_read_real_claude_md(self) -> None:
        request_id = "11111111-2222-3333-4444-555555555555"
        path = self.claude_md
        content = b"Build: make\nTest: python3 -m unittest"
        with open(path, "wb") as f:
            f.write(content)
            
        instance = make_agent(self.home)
        instance._on_read({
            "request_id": request_id,
            "kind": "file",
            "path": path,
        })
        
        frames = drain(instance)
        self.assertGreaterEqual(len(frames), 2)
        
        tag_ok, payload_ok = frames[0]
        self.assertEqual(tag_ok, agent.TAG_READ_OK)
        meta = json.loads(payload_ok.decode("utf-8"))
        self.assertEqual(meta["request_id"], request_id)
        self.assertEqual(meta["kind"], "file")
        self.assertEqual(meta["path"], path)
        self.assertEqual(meta["bytes"], len(content))
        self.assertFalse(meta["truncated"])
        self.assertEqual(meta["chunks"], len(frames) - 1)
        self.assertIn("modified_at", meta)
        
        assembled = bytearray()
        for tag, payload in frames[1:]:
            self.assertEqual(tag, agent.TAG_READ_DATA)
            prefix = payload[:36].decode("ascii")
            self.assertEqual(prefix, request_id)
            assembled.extend(payload[36:])
            
        self.assertEqual(bytes(assembled), content)

    def test_truncate_file_above_max_document_bytes(self) -> None:
        request_id = "22222222-3333-4444-5555-666666666666"
        path = self.claude_md
        real_size = agent.MAX_DOCUMENT_BYTES + 5000
        content = b"A" * real_size
        with open(path, "wb") as f:
            f.write(content)
            
        instance = make_agent(self.home)
        instance._on_read({
            "request_id": request_id,
            "kind": "file",
            "path": path,
        })
        
        frames = drain(instance)
        self.assertGreaterEqual(len(frames), 2)
        
        tag_ok, payload_ok = frames[0]
        self.assertEqual(tag_ok, agent.TAG_READ_OK)
        meta = json.loads(payload_ok.decode("utf-8"))
        self.assertEqual(meta["bytes"], real_size)
        self.assertTrue(meta["truncated"])
        
        assembled = bytearray()
        for tag, payload in frames[1:]:
            self.assertEqual(tag, agent.TAG_READ_DATA)
            req_id, chunk_data = agent.decode_data(payload)
            self.assertEqual(req_id, request_id)
            assembled.extend(chunk_data)
            
        self.assertEqual(len(assembled), agent.MAX_DOCUMENT_BYTES)
        self.assertEqual(assembled, b"A" * agent.MAX_DOCUMENT_BYTES)

    def test_chunking_large_file(self) -> None:
        request_id = "33333333-4444-5555-6666-777777777777"
        path = self.claude_md
        size = agent.MAX_DATA + 1000
        content = b"B" * size
        with open(path, "wb") as f:
            f.write(content)
            
        instance = make_agent(self.home)
        instance._on_read({
            "request_id": request_id,
            "kind": "file",
            "path": path,
        })
        
        frames = drain(instance)
        self.assertGreaterEqual(len(frames), 3)
        
        tag_ok, payload_ok = frames[0]
        self.assertEqual(tag_ok, agent.TAG_READ_OK)
        meta = json.loads(payload_ok.decode("utf-8"))
        self.assertGreater(meta["chunks"], 1)
        
        assembled = bytearray()
        for tag, payload in frames[1:]:
            self.assertEqual(tag, agent.TAG_READ_DATA)
            self.assertTrue(len(payload) <= agent.MAX_FRAME)
            req_id, chunk_data = agent.decode_data(payload)
            self.assertEqual(req_id, request_id)
            assembled.extend(chunk_data)
            
        self.assertEqual(bytes(assembled), content)

    def test_reject_symlink(self) -> None:
        request_id = "44444444-4444-4444-4444-444444444444"
        os.makedirs(self.claude_config, exist_ok=True)
        real_path = f"{self.claude_config}/real.md"
        symlink_path = self.claude_md
        with open(real_path, "wb") as f:
            f.write(b"real content")
        os.symlink("real.md", symlink_path)
        
        instance = make_agent(self.home)
        self.expect_error(
            instance,
            "symlink_detected",
            request_id=request_id,
            kind="file",
            path=symlink_path
        )

    def test_reject_never_serve_basenames(self) -> None:
        """Every never-served basename is refused, and refused BY THAT RULE.

        Asserting only on `permission_denied` would stay green with the never-serve list
        deleted: `.env` is not a governance basename either, so the whitelist underneath
        returns the very same code. Two things pin the rule down. The reason string, which
        differs per rule, and a `dir` read — the whitelist only applies to `file`, so for a
        directory the never-serve list is the ONLY thing left that can refuse.
        """
        instance = make_agent(self.home)
        for idx, basename in enumerate(sorted(agent.NEVER_SERVE_BASENAMES)):
            path = f"{self.home}/{basename}"
            with open(path, "wb") as handle:
                handle.write(b"sensitive basename")
            self.assertTrue(os.path.exists(path))
            body = self.expect_error(
                instance,
                "permission_denied",
                request_id=f"55555555-5555-5555-5555-{(idx + 1):012d}",
                kind="file",
                path=path,
            )
            self.assertIn("never served", body["reason"])
            os.unlink(path)

            os.mkdir(path)
            body = self.expect_error(
                instance,
                "permission_denied",
                request_id=f"55555555-5555-5555-5555-{(idx + 101):012d}",
                kind="dir",
                path=path,
            )
            self.assertIn("never served", body["reason"])
            os.rmdir(path)

    def test_reject_never_serve_suffixes(self) -> None:
        """Same rule, same trap: the suffix list is checked in isolation, not through the whitelist."""
        instance = make_agent(self.home)
        for idx, suffix in enumerate(agent.NEVER_SERVE_SUFFIXES):
            path = f"{self.home}/test_cert{suffix}"
            with open(path, "wb") as handle:
                handle.write(b"sensitive suffix")
            self.assertTrue(os.path.exists(path))
            body = self.expect_error(
                instance,
                "permission_denied",
                request_id=f"66666666-6666-6666-6666-{(idx + 1):012d}",
                kind="file",
                path=path,
            )
            self.assertIn("credential material", body["reason"])
            os.unlink(path)

            os.mkdir(path)
            body = self.expect_error(
                instance,
                "permission_denied",
                request_id=f"66666666-6666-6666-6666-{(idx + 101):012d}",
                kind="dir",
                path=path,
            )
            self.assertIn("credential material", body["reason"])
            os.rmdir(path)

    def test_reject_non_governance_basename(self) -> None:
        path = f"{self.home}/NOTAS.md"
        with open(path, "wb") as f:
            f.write(b"some notes")
            
        instance = make_agent(self.home)
        self.expect_error(
            instance,
            "permission_denied",
            request_id="77777777-7777-7777-7777-777777777777",
            kind="file",
            path=path
        )

    def test_reject_outside_agent_home(self) -> None:
        """A governance document outside the home is refused BY CONTAINMENT.

        The path is canonical, the basename is whitelisted and the file really exists, so every
        other rule would wave it through: containment is the only thing between the console and
        a CLAUDE.md that belongs to somebody else. Pointing this at `/etc/hosts` would prove
        nothing — `hosts` is not a governance basename, so the whitelist refuses it with the
        same code even after containment is deleted.
        """
        with tempfile.TemporaryDirectory() as outside:
            path = os.path.join(os.path.realpath(outside), "CLAUDE.md")
            with open(path, "wb") as handle:
                handle.write(b"someone else's manual")
            self.assertTrue(os.path.exists(path))
            self.assertEqual(os.path.realpath(path), path)

            instance = make_agent(self.home)
            instance.bundle["runtime_facts"] = {"claude_config_dir": os.path.realpath(outside)}
            body = self.expect_error(
                instance,
                "permission_denied",
                request_id="88888888-8888-8888-8888-888888888888",
                kind="file",
                path=path,
            )
            self.assertIn("outside the agent home", body["reason"])

    def test_reject_non_canonical_paths(self) -> None:
        instance = make_agent(self.home)
        
        non_canonical = [
            "CLAUDE.md",                                 # Relative
            f"{self.home}/../CLAUDE.md",                 # With ..
            f"{self.home}/./CLAUDE.md",                  # With .
            f"{self.home}//CLAUDE.md",                   # Double slash
            f"{self.home}/subdir/",                      # Trailing slash
            f"{self.home}/CLAUDE.md\0",                  # Null byte
            f"{self.home}/" + ("a" * agent.MAX_READ_PATH) # Too long
        ]
        
        for idx, path in enumerate(non_canonical):
            request_id = f"99999999-9999-9999-9999-{(idx + 1):012d}"
            self.expect_error(
                instance,
                "invalid_path",
                request_id=request_id,
                kind="file",
                path=path
            )

    def test_invalid_request_id_raises_protocol_error(self) -> None:
        instance = make_agent(self.home)
        
        # Absent
        with self.assertRaises(agent.ProtocolError):
            instance._on_read({"kind": "file", "path": f"{self.home}/CLAUDE.md"})
            
        # Non-string
        with self.assertRaises(agent.ProtocolError):
            instance._on_read({"request_id": 12345, "kind": "file", "path": f"{self.home}/CLAUDE.md"})
            
        # Invalid format (non-UUID)
        with self.assertRaises(agent.ProtocolError):
            instance._on_read({"request_id": "not-a-uuid", "kind": "file", "path": f"{self.home}/CLAUDE.md"})
            
        # Uppercase UUID
        with self.assertRaises(agent.ProtocolError):
            instance._on_read({
                "request_id": "11111111-2222-3333-4444-55555555555F",
                "kind": "file",
                "path": f"{self.home}/CLAUDE.md"
            })

    def test_invalid_kind_gives_invalid_path_error(self) -> None:
        instance = make_agent(self.home)
        
        # kind = "other"
        self.expect_error(
            instance,
            "invalid_path",
            request_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            kind="other",
            path=f"{self.home}/CLAUDE.md"
        )
        
        # kind is None
        self.expect_error(
            instance,
            "invalid_path",
            request_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            kind=None,
            path=f"{self.home}/CLAUDE.md"
        )

    def test_mismatched_kind_and_filesystem_type(self) -> None:
        instance = make_agent(self.home)
        
        # 1. Directory requested as file
        # We name the directory "CLAUDE.md" to pass the governance name whitelist,
        # so it fails at the S_ISREG check and returns invalid_path.
        dir_path = self.claude_md
        os.makedirs(dir_path, exist_ok=True)
        self.expect_error(
            instance,
            "invalid_path",
            request_id="bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
            kind="file",
            path=dir_path
        )
        os.rmdir(dir_path)
        
        # 2. File requested as dir
        file_path = self.claude_md
        with open(file_path, "wb") as f:
            f.write(b"test")
        self.expect_error(
            instance,
            "invalid_path",
            request_id="bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
            kind="dir",
            path=file_path
        )


    def test_memory_index(self) -> None:
        request_id = "cccccccc-dddd-eeee-ffff-000000000000"
        instance = make_agent(self.home)
        
        dir1 = f"{self.home}/dir1"
        os.makedirs(dir1, exist_ok=True)
        
        file_newest = f"{self.home}/newest.txt"
        file_middle = f"{dir1}/middle.txt"
        file_oldest = f"{self.home}/oldest.txt"
        
        with open(file_newest, "wb") as f: f.write(b"newest")
        with open(file_middle, "wb") as f: f.write(b"middle")
        with open(file_oldest, "wb") as f: f.write(b"oldest")
        
        os.utime(file_newest, (1000, 1000))
        os.utime(file_middle, (900, 900))
        os.utime(file_oldest, (800, 800))
        
        env_file = f"{self.home}/.env"
        with open(env_file, "wb") as f: f.write(b"SECRET=123")
        key_file = f"{dir1}/mykey.pem"
        with open(key_file, "wb") as f: f.write(b"PRIVATE KEY")
        
        sym_file = f"{self.home}/symlink_file.txt"
        os.symlink("newest.txt", sym_file)
        
        instance._on_read({
            "request_id": request_id,
            "kind": "dir",
            "path": self.home,
        })
        
        frames = drain(instance)
        self.assertEqual(len(frames), 1)
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_READ_OK)
        
        meta = json.loads(payload.decode("utf-8"))
        self.assertEqual(meta["request_id"], request_id)
        self.assertEqual(meta["kind"], "dir")
        self.assertEqual(meta["path"], self.home)
        self.assertFalse(meta["truncated"])
        
        entries = meta["entries"]
        paths = [entry["path"] for entry in entries]
        
        self.assertIn(file_newest, paths)
        self.assertIn(file_middle, paths)
        self.assertIn(file_oldest, paths)
        
        self.assertNotIn(env_file, paths)
        self.assertNotIn(key_file, paths)
        self.assertNotIn(sym_file, paths)
        
        self.assertEqual(paths, [file_newest, file_middle, file_oldest])
        
        entry_map = {e["path"]: e for e in entries}
        self.assertEqual(entry_map[file_newest]["bytes"], 6)
        self.assertEqual(entry_map[file_middle]["bytes"], 6)
        self.assertEqual(entry_map[file_oldest]["bytes"], 6)

    def test_directory_depth_limit(self) -> None:
        request_id = "dddddddd-eeee-ffff-0000-111111111111"
        instance = make_agent(self.home)
        
        d1 = f"{self.home}/d1"
        d2 = f"{d1}/d2"
        d3 = f"{d2}/d3"
        os.makedirs(d3, exist_ok=True)
        
        file_ok = f"{d2}/ok.txt"
        file_deep = f"{d3}/deep.txt"
        
        with open(file_ok, "wb") as f: f.write(b"ok")
        with open(file_deep, "wb") as f: f.write(b"deep")
        
        instance._on_read({
            "request_id": request_id,
            "kind": "dir",
            "path": self.home,
        })
        
        frames = drain(instance)
        self.assertEqual(len(frames), 1)
        meta = json.loads(frames[0][1].decode("utf-8"))
        
        paths = [e["path"] for e in meta["entries"]]
        self.assertIn(file_ok, paths)
        self.assertNotIn(file_deep, paths)

    def test_memory_index_fits_in_one_frame(self) -> None:
        request_id = "eeeeeeee-ffff-0000-1111-222222222222"
        instance = make_agent(self.home)
        
        long_dir = f"{self.home}/" + ("a" * 150)
        os.makedirs(long_dir, exist_ok=True)
        
        for i in range(200):
            filename = f"file_{i:03d}_" + ("b" * 100) + ".txt"
            path = f"{long_dir}/{filename}"
            with open(path, "wb") as f:
                f.write(b"x")
                
        instance._on_read({
            "request_id": request_id,
            "kind": "dir",
            "path": self.home,
        })
        
        frames = drain(instance)
        self.assertEqual(len(frames), 1)
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_READ_OK)
        
        frame_size = 5 + len(payload)
        self.assertTrue(frame_size <= agent.MAX_FRAME, f"Frame size {frame_size} exceeds MAX_FRAME")
        
        meta = json.loads(payload.decode("utf-8"))
        self.assertTrue(meta["truncated"])

    def test_outbound_queue_congested(self) -> None:
        instance = make_agent(self.home)
        instance.outbound.extend(b"x" * (agent.OUTBOUND_HIGH_WATER + 1))
        
        request_id = "ffffffff-0000-1111-2222-333333333333"
        instance._on_read({
            "request_id": request_id,
            "kind": "file",
            "path": f"{self.home}/CLAUDE.md"
        })
        
        congested_len = agent.OUTBOUND_HIGH_WATER + 1
        new_data = instance.outbound[congested_len:]
        
        decoder = agent.FrameDecoder()
        frames = decoder.feed(bytes(new_data))
        self.assertEqual(len(frames), 1)
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_READ_ERR)
        
        meta = json.loads(payload.decode("utf-8"))
        self.assertEqual(meta["error"], "unavailable")
        self.assertEqual(meta["reason"], "outbound queue is congested")
        self.assertEqual(meta["request_id"], request_id)


if __name__ == "__main__":
    unittest.main()
