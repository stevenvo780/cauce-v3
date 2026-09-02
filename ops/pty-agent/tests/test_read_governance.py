#!/usr/bin/env python3
"""Tests for the read_governance features in ops/pty-agent/cauce_pty_agent/governance_read.py.

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
import sys
import tempfile
import unittest
from unittest import mock

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

    def test_test_home_is_canonical(self) -> None:
        """Asserts that the test environment's temp directory is canonical.

        If this test fails, it explains why other tests might have raised symlink_detected
        due to the test home directory itself not being canonical in the runner environment.
        """
        self.assertEqual(os.path.realpath(self.temp_dir.name), self.temp_dir.name)

    def test_read_done_tag_feature_and_dispatch_order_are_wire_exact(self) -> None:
        request_id = "10101010-2020-3030-4040-505050505050"
        pathlib.Path(self.claude_md).write_bytes(b"directive")
        instance = make_agent(self.home)
        instance.acknowledged = True

        instance._dispatch(agent.TAG_READ, json.dumps({
            "request_id": request_id, "kind": "file", "path": self.claude_md,
        }).encode("utf-8"))

        frames = drain(instance)
        self.assertEqual(agent.TAG_READ_DONE, 0x5E)
        self.assertIn("read_governance_done_v1", agent.FEATURES)
        self.assertEqual([tag for tag, _ in frames], [
            agent.TAG_READ_OK, agent.TAG_READ_DATA, agent.TAG_READ_DONE,
        ])
        self.assert_done(frames[-1], request_id)

    def test_memory_roots_require_live_adapter_facts(self) -> None:
        instance = make_agent(self.home)
        self.assertEqual(instance._memory_root_for_harness(), self.memory_root)

        instance.bundle = {"home": self.home, "harness": "claude", "runtime_facts": {}}
        self.assertIsNone(instance._memory_root_for_harness())
        instance.bundle = {"home": self.home, "harness": "codex", "runtime_facts": {}}
        self.assertIsNone(instance._memory_root_for_harness())
        instance.bundle = {"home": self.home, "harness": "openclaw", "runtime_facts": {}}
        self.assertIsNone(instance._memory_root_for_harness())
        instance.bundle["runtime_facts"] = {"openclaw_workspace": f"{self.home}/workspace"}
        self.assertEqual(instance._memory_root_for_harness(), f"{self.home}/workspace/memory")

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
        self.assertGreaterEqual(len(frames), 3)

        tag_ok, payload_ok = frames[0]
        self.assertEqual(tag_ok, agent.TAG_READ_OK)
        meta = json.loads(payload_ok.decode("utf-8"))
        self.assertEqual(meta["request_id"], request_id)
        self.assertEqual(meta["kind"], "file")
        self.assertEqual(meta["path"], path)
        self.assertEqual(meta["bytes"], len(content))
        self.assertFalse(meta["truncated"])
        self.assertEqual(meta["chunks"], len(frames) - 2)
        self.assertIn("modified_at", meta)
        self.assert_done(frames[-1], request_id)

        assembled = bytearray()
        for tag, payload in frames[1:-1]:
            self.assertEqual(tag, agent.TAG_READ_DATA)
            prefix = payload[:36].decode("ascii")
            self.assertEqual(prefix, request_id)
            assembled.extend(payload[36:])

        self.assertEqual(bytes(assembled), content)

    def test_project_manuals_outside_home_follow_measured_claude_order(self) -> None:
        with tempfile.TemporaryDirectory() as raw_workspace:
            workspace = os.path.realpath(raw_workspace)
            nested = f"{workspace}/repo/packages/api"
            os.makedirs(f"{workspace}/.claude")
            os.makedirs(nested)
            paths = [
                f"{workspace}/repo/CLAUDE.md",
                f"{workspace}/repo/.claude/CLAUDE.md",
                f"{workspace}/repo/CLAUDE.local.md",
                f"{workspace}/repo/packages/CLAUDE.md",
                f"{workspace}/repo/packages/.claude/CLAUDE.md",
                f"{workspace}/repo/packages/CLAUDE.local.md",
                f"{nested}/CLAUDE.md",
                f"{nested}/.claude/CLAUDE.md",
                f"{nested}/CLAUDE.local.md",
            ]
            for path in paths:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                pathlib.Path(path).write_text(path, encoding="utf-8")
            instance = make_agent(self.home)
            instance.bundle["runtime_facts"].update({
                "cwd": nested, "workspace_root": workspace, "project_root": f"{workspace}/repo",
            })

            self.assertEqual(instance._project_manual_paths(), tuple(paths))
            for index, path in enumerate(paths):
                instance.outbound.clear()
                instance._on_read({
                    "request_id": f"12121212-3434-5656-7878-{index + 1:012d}",
                    "kind": "file", "path": path,
                })
                self.assertEqual(drain(instance)[0][0], agent.TAG_READ_OK)

            self.assertIsNotNone(instance._validate_read_path(f"{workspace}/CLAUDE.md", "file"))

    def test_empty_runtime_facts_keep_recovery_shell_but_authorize_no_governance_paths(self) -> None:
        instance = make_agent(self.home)
        instance.bundle = {"home": self.home, "harness": "claude", "runtime_facts": {}}
        self.assertEqual(instance._profile_governance_file_paths(), frozenset())
        self.assertEqual(instance._readable_global_governance_file_paths(), frozenset())
        self.assertEqual(instance._project_manual_paths(), ())
        self.assertIsNone(instance._memory_root_for_harness())
        self.assertIsNotNone(instance._validate_read_path(self.claude_md, "file"))
        self.assertIsNotNone(instance._validate_write_shape(self.claude_md))

    def test_codex_uses_project_root_not_the_workspace_mount_and_prefers_override(self) -> None:
        mount = f"{self.home}/mount"
        project = f"{mount}/repo"
        cwd = f"{project}/sub"
        codex_home = f"{self.home}/.codex"
        os.makedirs(codex_home)
        os.makedirs(cwd)
        instance = make_agent(self.home)
        instance.bundle = {
            "home": self.home,
            "harness": "codex",
            "runtime_facts": {
                "codex_home": codex_home, "cwd": cwd,
                "workspace_root": mount, "project_root": project,
            },
        }
        self.assertEqual(instance._project_manual_paths(), (
            f"{project}/AGENTS.override.md", f"{project}/AGENTS.md",
            f"{cwd}/AGENTS.override.md", f"{cwd}/AGENTS.md",
        ))
        self.assertIsNotNone(instance._validate_read_path(f"{mount}/AGENTS.md", "file"))
        self.assertIsNone(instance._validate_write_shape(f"{codex_home}/AGENTS.md"))
        self.assertIsNotNone(instance._validate_write_shape(f"{project}/AGENTS.md"))

    def test_one_shot_cwd_authorizes_one_exact_level_without_guessing_ancestors(self) -> None:
        cwd = f"{self.home}/repo/sub"
        os.makedirs(cwd)
        pathlib.Path(cwd, "CLAUDE.md").write_text("exact", encoding="utf-8")
        pathlib.Path(f"{self.home}/repo/CLAUDE.md").write_text("parent", encoding="utf-8")
        instance = make_agent(self.home)
        instance.bundle["runtime_facts"]["cwd"] = cwd
        self.assertEqual(instance._project_manual_paths(), (
            f"{cwd}/CLAUDE.md", f"{cwd}/.claude/CLAUDE.md", f"{cwd}/CLAUDE.local.md",
        ))
        self.assertIsNone(instance._validate_read_path(f"{cwd}/CLAUDE.md", "file"))
        self.assertIsNotNone(instance._validate_read_path(f"{self.home}/repo/CLAUDE.md", "file"))

    def test_same_basename_in_a_sibling_is_rejected_before_any_read(self) -> None:
        workspace = f"{self.home}/workspace"
        cwd = f"{workspace}/repo"
        sibling = f"{workspace}/sibling"
        os.makedirs(cwd)
        os.makedirs(sibling)
        pathlib.Path(sibling, "CLAUDE.md").write_text("sibling", encoding="utf-8")
        instance = make_agent(self.home)
        instance.bundle["runtime_facts"].update({"cwd": cwd, "workspace_root": cwd})
        body = self.expect_error(
            instance, "permission_denied",
            request_id="13131313-3535-5757-7979-141414141414",
            kind="file", path=f"{sibling}/CLAUDE.md",
        )
        self.assertIn("not a governance document", body["reason"])

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
        self.assertGreaterEqual(len(frames), 3)

        tag_ok, payload_ok = frames[0]
        self.assertEqual(tag_ok, agent.TAG_READ_OK)
        meta = json.loads(payload_ok.decode("utf-8"))
        self.assertEqual(meta["bytes"], real_size)
        self.assertTrue(meta["truncated"])
        self.assert_done(frames[-1], request_id)

        assembled = bytearray()
        for tag, payload in frames[1:-1]:
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
        self.assertGreaterEqual(len(frames), 4)

        tag_ok, payload_ok = frames[0]
        self.assertEqual(tag_ok, agent.TAG_READ_OK)
        meta = json.loads(payload_ok.decode("utf-8"))
        self.assertGreater(meta["chunks"], 1)
        self.assert_done(frames[-1], request_id)

        assembled = bytearray()
        for tag, payload in frames[1:-1]:
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
        """Every never-served FILE is refused, and refused BY THAT RULE.

        Asserting only on `permission_denied` would stay green with the never-serve list
        deleted: `.env` is not a governance basename either, so the whitelist underneath returns
        the very same code. The distinct reason pins the redaction rule down. Directory authority
        is deliberately independent and is tested against the exact measured root below.
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

        upper = f"{self.home}/AUTH.JSON"
        pathlib.Path(upper).write_bytes(b"case must not bypass redaction")
        body = self.expect_error(
            instance,
            "permission_denied",
            request_id="56565656-5656-5656-5656-565656565656",
            kind="file",
            path=upper,
        )
        self.assertIn("never served", body["reason"])

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

        upper = f"{self.home}/SECRET.PEM"
        pathlib.Path(upper).write_bytes(b"case must not bypass redaction")
        body = self.expect_error(
            instance,
            "permission_denied",
            request_id="67676767-6767-6767-6767-676767676767",
            kind="file",
            path=upper,
        )
        self.assertIn("credential material", body["reason"])

    def test_directory_authority_is_the_exact_measured_root_not_a_blacklist(self) -> None:
        instance = make_agent(self.home)
        secret_directory = f"{self.home}/.ssh"
        os.mkdir(secret_directory)
        pathlib.Path(secret_directory, "id_custom").write_bytes(b"must never be indexed")

        for index, path in enumerate((self.home, self.claude_config, secret_directory), start=1):
            body = self.expect_error(
                instance,
                "permission_denied",
                request_id=f"67676767-6767-6767-6767-{index:012d}",
                kind="dir",
                path=path,
            )
            self.assertEqual(body["reason"], "path is not the measured memory root")

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

        # 2. The exact measured memory root exists, but is a regular file.
        os.rmdir(self.memory_root)
        file_path = self.memory_root
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

        dir1 = f"{self.memory_root}/dir1"
        os.makedirs(dir1, exist_ok=True)

        file_newest = f"{self.memory_root}/newest.txt"
        file_middle = f"{dir1}/middle.txt"
        file_oldest = f"{self.memory_root}/oldest.txt"

        pathlib.Path(file_newest).write_bytes(b"newest")
        pathlib.Path(file_middle).write_bytes(b"middle")
        pathlib.Path(file_oldest).write_bytes(b"oldest")

        os.utime(file_newest, (1000, 1000))
        os.utime(file_middle, (900, 900))
        os.utime(file_oldest, (800, 800))

        env_file = f"{self.memory_root}/.env"
        pathlib.Path(env_file).write_bytes(b"SECRET=123")
        key_file = f"{dir1}/mykey.pem"
        pathlib.Path(key_file).write_bytes(b"PRIVATE KEY")
        upper_env_file = f"{self.memory_root}/AUTH.JSON"
        pathlib.Path(upper_env_file).write_bytes(b"SECRET")
        upper_key_file = f"{dir1}/SECRET.PEM"
        pathlib.Path(upper_key_file).write_bytes(b"PRIVATE KEY")

        sym_file = f"{self.memory_root}/symlink_file.txt"
        os.symlink("newest.txt", sym_file)

        instance._on_read({
            "request_id": request_id,
            "kind": "dir",
            "path": self.memory_root,
        })

        frames = drain(instance)
        self.assertEqual(len(frames), 2)
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_READ_OK)
        self.assert_done(frames[1], request_id)

        meta = json.loads(payload.decode("utf-8"))
        self.assertEqual(meta["request_id"], request_id)
        self.assertEqual(meta["kind"], "dir")
        self.assertEqual(meta["path"], self.memory_root)
        self.assertFalse(meta["truncated"])

        entries = meta["entries"]
        paths = [entry["path"] for entry in entries]

        self.assertIn(file_newest, paths)
        self.assertIn(file_middle, paths)
        self.assertIn(file_oldest, paths)

        self.assertNotIn(env_file, paths)
        self.assertNotIn(key_file, paths)
        self.assertNotIn(upper_env_file, paths)
        self.assertNotIn(upper_key_file, paths)
        self.assertNotIn(sym_file, paths)

        self.assertEqual(paths, [file_newest, file_middle, file_oldest])

        entry_map = {e["path"]: e for e in entries}
        self.assertEqual(entry_map[file_newest]["bytes"], 6)
        self.assertEqual(entry_map[file_middle]["bytes"], 6)
        self.assertEqual(entry_map[file_oldest]["bytes"], 6)

    def test_memory_root_symlink_is_rejected_without_a_done_frame(self) -> None:
        os.rmdir(self.memory_root)
        with tempfile.TemporaryDirectory() as outside:
            pathlib.Path(outside, "secret.txt").write_bytes(b"must not escape")
            os.symlink(outside, self.memory_root)
            body = self.expect_error(
                make_agent(self.home),
                "symlink_detected",
                request_id="cdcdcdcd-dede-efef-0101-020202020202",
                kind="dir",
                path=self.memory_root,
            )
            self.assertIn("symbolic link", body["reason"])

    def test_symlink_in_home_path_is_rejected_component_by_component(self) -> None:
        real_home = f"{self.home}/real-home"
        linked_home = f"{self.home}/linked-home"
        linked_root = f"{linked_home}/.claude/projects"
        os.makedirs(f"{real_home}/.claude/projects")
        os.symlink(real_home, linked_home)
        instance = make_agent(self.home)
        instance.bundle = {
            "home": linked_home,
            "harness": "claude",
            "runtime_facts": {"claude_config_dir": f"{linked_home}/.claude"},
        }

        body = self.expect_error(
            instance,
            "symlink_detected",
            request_id="cdcdcdcd-dede-efef-0101-030303030303",
            kind="dir",
            path=linked_root,
        )
        self.assertIn("symbolic link", body["reason"])

    def test_concurrent_directory_to_symlink_swap_never_escapes_the_open_dirfd(self) -> None:
        request_id = "cececece-dfdf-e0e0-1212-232323232323"
        branch = f"{self.memory_root}/branch"
        original_branch = f"{self.memory_root}/branch.original"
        os.mkdir(branch)
        pathlib.Path(branch, "local.txt").write_bytes(b"local")
        real_open = agent.os.open
        swapped = False

        with tempfile.TemporaryDirectory() as outside:
            secret = pathlib.Path(outside, "outside-secret.txt")
            secret.write_bytes(b"must never be indexed")

            def swapping_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal swapped
                if path == "branch" and dir_fd is not None and flags & os.O_DIRECTORY and not swapped:
                    self.assertTrue(flags & os.O_NOFOLLOW)
                    os.rename(branch, original_branch)
                    os.symlink(outside, branch)
                    swapped = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            instance = make_agent(self.home)
            with mock.patch.object(agent.os, "open", side_effect=swapping_open):
                instance._on_read({
                    "request_id": request_id, "kind": "dir", "path": self.memory_root,
                })

        frames = drain(instance)
        self.assertTrue(swapped)
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_READ_OK, agent.TAG_READ_DONE])
        meta = json.loads(frames[0][1].decode("utf-8"))
        self.assertEqual(meta["entries"], [])
        self.assert_done(frames[1], request_id)

    def test_concurrent_file_to_symlink_swap_does_not_publish_secret_metadata(self) -> None:
        request_id = "cececece-dfdf-e0e0-1212-242424242424"
        local = f"{self.memory_root}/local.txt"
        pathlib.Path(local).write_bytes(b"local")
        real_open = agent.os.open
        swapped = False

        with tempfile.TemporaryDirectory() as outside:
            secret = pathlib.Path(outside, "outside-secret.txt")
            original = pathlib.Path(outside, "preserved-local.txt")
            secret.write_bytes(b"secret-metadata-must-not-cross")

            def swapping_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal swapped
                if path == "local.txt" and dir_fd is not None and not swapped:
                    self.assertTrue(flags & os.O_NOFOLLOW)
                    os.rename(local, original)
                    os.symlink(secret, local)
                    swapped = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            instance = make_agent(self.home)
            with mock.patch.object(agent.os, "open", side_effect=swapping_open):
                instance._on_read({
                    "request_id": request_id, "kind": "dir", "path": self.memory_root,
                })

        frames = drain(instance)
        self.assertTrue(swapped)
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_READ_OK, agent.TAG_READ_DONE])
        meta = json.loads(frames[0][1].decode("utf-8"))
        self.assertEqual(meta["entries"], [])
        self.assert_done(frames[1], request_id)

    def test_scan_cap_reports_an_honest_lower_bound_and_truncation(self) -> None:
        request_id = "cfcfcfcf-e0e0-f1f1-2323-343434343434"
        for index in range(4):
            pathlib.Path(self.memory_root, f"memory-{index}.jsonl").write_bytes(b"x")
        instance = make_agent(self.home)

        with mock.patch.object(agent, "DIR_SCAN_CAP", 3):
            instance._on_read({
                "request_id": request_id, "kind": "dir", "path": self.memory_root,
            })

        frames = drain(instance)
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_READ_OK, agent.TAG_READ_DONE])
        meta = json.loads(frames[0][1].decode("utf-8"))
        self.assertIsNone(meta["total"])
        self.assertEqual(meta["observed_at_least"], 3)
        self.assertEqual(len(meta["entries"]), 3)
        self.assertTrue(meta["truncated"])
        self.assertEqual(len(list(pathlib.Path(self.memory_root).iterdir())), 4)
        self.assert_done(frames[1], request_id)

    def test_directory_depth_limit(self) -> None:
        request_id = "dddddddd-eeee-ffff-0000-111111111111"
        instance = make_agent(self.home)

        d1 = f"{self.memory_root}/d1"
        d2 = f"{d1}/d2"
        d3 = f"{d2}/d3"
        os.makedirs(d3, exist_ok=True)

        file_ok = f"{d2}/ok.txt"
        file_deep = f"{d3}/deep.txt"

        pathlib.Path(file_ok).write_bytes(b"ok")
        pathlib.Path(file_deep).write_bytes(b"deep")

        instance._on_read({
            "request_id": request_id,
            "kind": "dir",
            "path": self.memory_root,
        })

        frames = drain(instance)
        self.assertEqual(len(frames), 2)
        self.assert_done(frames[1], request_id)
        meta = json.loads(frames[0][1].decode("utf-8"))

        paths = [e["path"] for e in meta["entries"]]
        self.assertIn(file_ok, paths)
        self.assertNotIn(file_deep, paths)

    def test_memory_index_fits_in_one_frame(self) -> None:
        request_id = "eeeeeeee-ffff-0000-1111-222222222222"
        instance = make_agent(self.home)

        long_dir = f"{self.memory_root}/" + ("a" * 150)
        os.makedirs(long_dir, exist_ok=True)

        for i in range(200):
            filename = f"file_{i:03d}_" + ("b" * 100) + ".txt"
            path = f"{long_dir}/{filename}"
            with open(path, "wb") as f:
                f.write(b"x")

        instance._on_read({
            "request_id": request_id,
            "kind": "dir",
            "path": self.memory_root,
        })

        frames = drain(instance)
        self.assertEqual(len(frames), 2)
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_READ_OK)
        self.assert_done(frames[1], request_id)

        frame_size = 5 + len(payload)
        self.assertTrue(frame_size <= agent.MAX_FRAME, f"Frame size {frame_size} exceeds MAX_FRAME")

        meta = json.loads(payload.decode("utf-8"))
        self.assertTrue(meta["truncated"])
        self.assertEqual(meta["total"], 200)
        self.assertEqual(meta["observed_at_least"], 200)

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
