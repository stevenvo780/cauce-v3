#!/usr/bin/env python3
"""Pins the two primitives every source digest is folded from.

Both live digests are evidence: source-digest.py binds verification reports to the sources that can
change their result, and container_ops_digest.py binds OPERATIONS.sha256 to the container-operations
surface. A silent change in the mechanics below would move every digest ever issued by either tool
and invalidate the artifacts pinned to them, so the framing, the ordering and what does and does not
count as an input are asserted here against hand-built expectations rather than against whatever the
implementation happens to produce.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / "scripts"))

from digest_lib import (  # noqa: E402
    DigestError,
    fold_digest,
    tracked_files,
)


def expected_digest(entries: list[tuple[str, bytes]]) -> str:
    """Recompute the contract by hand, in the order and framing the tools depend on.

    The frame is a big-endian 8-byte length before the path and another before the content. It is a
    length prefix, NOT a separator byte, which is what makes the boundary unforgeable: no path and
    no content can contain a byte sequence that shifts it.
    """

    digest = hashlib.sha256()
    for name, content in sorted(entries, key=lambda entry: entry[0].encode("utf-8")):
        encoded = name.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


class FixtureTree(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="cauce-digest-lib-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def write(self, relative: str, content: bytes | str) -> pathlib.Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8") if isinstance(content, str) else content)
        return path

    def pairs(self, *relatives: str) -> list[tuple[str, pathlib.Path]]:
        return [(relative, self.root / relative) for relative in relatives]

    def git(self, *arguments: str) -> None:
        result = subprocess.run(
            ["git", "-C", str(self.root), *arguments],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class TestFoldDigest(FixtureTree):
    def test_prefix_and_framing_match_the_hand_built_contract(self) -> None:
        self.write("alpha.txt", "alpha bytes\n")
        self.write("nested/beta.bin", b"\x00\xff binary \x00")
        value = fold_digest(self.pairs("alpha.txt", "nested/beta.bin"))
        self.assertTrue(value.startswith("sha256:"), value)
        self.assertEqual(len(value), len("sha256:") + 64)
        self.assertEqual(
            value,
            expected_digest(
                [("alpha.txt", b"alpha bytes\n"), ("nested/beta.bin", b"\x00\xff binary \x00")]
            ),
        )

    def test_the_path_content_boundary_cannot_be_forged(self) -> None:
        """Concatenating path and content the same way under a different split must not collide.

        Without framing, ("ab", b"c") and ("a", b"bc") would hash identical byte streams, so a file
        could be renamed into another file's content and leave the digest still.
        """

        self.write("ab", "c")
        self.write("a", "bc")
        wide_name = fold_digest(self.pairs("ab"))
        wide_content = fold_digest(self.pairs("a"))
        self.assertNotEqual(wide_name, wide_content)

    def test_ordering_is_lc_all_c_and_independent_of_filesystem_order(self) -> None:
        names = ["Zebra.txt", "alpha.txt", "a-dash.txt", "a/nested.txt", "ñ.txt"]
        for name in names:
            self.write(name, f"content of {name}\n")
        pairs = self.pairs(*names)
        self.assertEqual(fold_digest(pairs), fold_digest(list(reversed(pairs))))
        self.assertEqual(
            fold_digest(pairs),
            expected_digest([(name, f"content of {name}\n".encode()) for name in names]),
        )
        byte_order = sorted(names, key=lambda name: name.encode("utf-8"))
        self.assertEqual(byte_order, ["Zebra.txt", "a-dash.txt", "a/nested.txt", "alpha.txt", "ñ.txt"])

    def test_a_content_change_moves_the_digest_and_a_rename_does_too(self) -> None:
        self.write("gate.sh", "#!/bin/sh\nexit 0\n")
        before = fold_digest(self.pairs("gate.sh"))
        self.write("gate.sh", "#!/bin/sh\nexit 7\n")
        self.assertNotEqual(fold_digest(self.pairs("gate.sh")), before)
        self.write("gate.sh", "#!/bin/sh\nexit 0\n")
        self.assertEqual(fold_digest(self.pairs("gate.sh")), before)
        renamed = self.write("renamed-gate.sh", "#!/bin/sh\nexit 0\n")
        self.assertNotEqual(fold_digest([("renamed-gate.sh", renamed)]), before)

    def test_metadata_only_changes_do_not_move_the_digest(self) -> None:
        path = self.write("gate.sh", "#!/bin/sh\nexit 0\n")
        before = fold_digest(self.pairs("gate.sh"))
        os.utime(path, (1_000_000_000, 1_000_000_000))
        self.assertEqual(fold_digest(self.pairs("gate.sh")), before)
        os.utime(path, (1_700_000_000, 1_700_000_000))
        path.chmod(0o755)
        self.assertEqual(fold_digest(self.pairs("gate.sh")), before)


class TestTrackedFiles(FixtureTree):
    def test_a_tree_without_git_is_its_own_source_tree(self) -> None:
        self.write("scripts/one.py", "print(1)\n")
        self.write("scripts/nested/two.py", "print(2)\n")
        self.write("outside/three.py", "print(3)\n")
        selected = tracked_files(self.root, ["scripts"])
        self.assertEqual(
            [path.relative_to(self.root).as_posix() for path in selected],
            ["scripts/nested/two.py", "scripts/one.py"],
        )

    def test_declared_inputs_may_be_single_files_and_are_deduplicated(self) -> None:
        self.write("scripts/one.py", "print(1)\n")
        selected = tracked_files(self.root, ["scripts", "scripts/one.py"])
        self.assertEqual([path.relative_to(self.root).as_posix() for path in selected], ["scripts/one.py"])

    def test_the_keep_predicate_receives_the_root_relative_logical_name(self) -> None:
        self.write("scripts/one.py", "print(1)\n")
        self.write("scripts/__pycache__/one.pyc", b"bytecode")
        seen: list[str] = []

        def keep(path: pathlib.Path, local: pathlib.PurePosixPath) -> bool:
            seen.append(local.as_posix())
            return "__pycache__" not in local.parts

        selected = tracked_files(self.root, ["scripts"], keep=keep)
        self.assertEqual([path.relative_to(self.root).as_posix() for path in selected], ["scripts/one.py"])
        self.assertIn("scripts/__pycache__/one.pyc", seen)

    def test_tracked_and_new_source_stay_while_ignored_files_leave(self) -> None:
        self.write(".gitignore", "*.bak\n")
        self.write("scripts/tracked.py", "print('tracked')\n")
        self.git("init", "--quiet")
        self.git("add", ".gitignore", "scripts/tracked.py")
        self.write("scripts/added-later.py", "print('not committed yet')\n")
        self.write("scripts/operator.bak", "operator backup\n")
        selected = [
            path.relative_to(self.root).as_posix()
            for path in tracked_files(self.root, ["scripts"])
        ]
        self.assertEqual(selected, ["scripts/added-later.py", "scripts/tracked.py"])

    def test_a_subdirectory_root_uses_the_enclosing_worktree_policy(self) -> None:
        self.write(".gitignore", "*.bak\n")
        self.write("ops/scripts/tracked.py", "print('tracked')\n")
        self.git("init", "--quiet")
        self.git("add", ".gitignore", "ops/scripts/tracked.py")
        self.write("ops/scripts/operator.bak", "operator backup\n")
        selected = [
            path.relative_to(self.root / "ops").as_posix()
            for path in tracked_files(self.root / "ops", ["scripts"])
        ]
        self.assertEqual(selected, ["scripts/tracked.py"])

    def test_an_unrunnable_git_fails_closed_under_worktree_root(self) -> None:
        """A probe that cannot even start must not be read as "this tree has no Git policy".

        Under *worktree_root* the caller has already declared the tree is a checkout, so treating an
        unrunnable `git` as an archive would quietly pull every ignored file -- an operator backup --
        into the digest and still exit 0, emitting a value no correct run reproduces. `git` missing
        from a PATH-restricted gate stage, or a fork refused under load, both land here.
        """

        self.write(".gitignore", "*.bak\n")
        self.write("scripts/tracked.py", "print('tracked')\n")
        self.git("init", "--quiet")
        self.git("add", ".gitignore", "scripts/tracked.py")
        self.write("scripts/operator.bak", "operator backup\n")
        empty = self.root / "no-tools"
        empty.mkdir()
        with unittest.mock.patch.dict(os.environ, {"PATH": str(empty)}, clear=False):
            with self.assertRaises(DigestError) as raised:
                tracked_files(self.root, ["scripts"], worktree_root=True)
            self.assertNotIn(str(self.root), str(raised.exception))
            tolerant = [
                path.relative_to(self.root).as_posix()
                for path in tracked_files(self.root, ["scripts"])
            ]
        self.assertEqual(tolerant, ["scripts/operator.bak", "scripts/tracked.py"])

    def test_worktree_root_rejects_a_root_that_is_not_the_top_of_the_checkout(self) -> None:
        self.write("ops/scripts/tracked.py", "print('tracked')\n")
        self.git("init", "--quiet")
        self.git("add", "ops/scripts/tracked.py")
        (self.root / "ops" / ".git").mkdir()
        with self.assertRaises(DigestError) as raised:
            tracked_files(self.root / "ops", ["scripts"], worktree_root=True)
        self.assertNotIn(str(self.root), str(raised.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
