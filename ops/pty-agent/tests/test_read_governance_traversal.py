#!/usr/bin/env python3
"""Defensa contra traversal y symlinks de read_governance (poda T060-D).

Metodos movidos byte a byte desde test_read_governance.py: rechazos de symlinks,
escapes fuera del home, rutas no canonicas y swaps concurrentes fichero/simbolo.
La base (setUp, expect_error, ...) vive en read_governance_harness.
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

from tests.read_governance_harness import ReadGovernanceBase, drain, make_agent  # noqa: E402


class ReadGovernanceTraversalTests(ReadGovernanceBase):
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


if __name__ == "__main__":
    unittest.main()

