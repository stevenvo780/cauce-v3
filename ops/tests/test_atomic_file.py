#!/usr/bin/env python3
from __future__ import annotations

import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, os.fspath(SCRIPTS))
import atomic_file  # noqa: E402


class AtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-atomic-write-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.destination = self.root / "first" / "second" / "generated.txt"

    def temporary_files(self, destination: pathlib.Path | None = None) -> list[pathlib.Path]:
        target = destination or self.destination
        return list(target.parent.glob(f".{target.name}.*"))

    def test_publishes_text_and_syncs_each_missing_parent(self) -> None:
        with (
            mock.patch.object(atomic_file.os, "fsync", wraps=os.fsync) as fsync,
            mock.patch.object(
                atomic_file,
                "_fsync_directory",
                wraps=atomic_file._fsync_directory,
            ) as directory_fsync,
        ):
            atomic_file.atomic_write(self.destination, "ámbito\n", mode=0o640)

        self.assertEqual(self.destination.read_bytes(), "ámbito\n".encode())
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o640)
        self.assertEqual(fsync.call_count, 4)
        self.assertEqual(
            directory_fsync.call_args_list,
            [
                mock.call(self.root),
                mock.call(self.root / "first"),
                mock.call(self.root / "first" / "second"),
            ],
        )
        self.assertEqual(self.temporary_files(), [])

    def test_publishes_with_an_existing_parent_and_only_syncs_it_after_replace(self) -> None:
        destination = self.root / "existing-parent.txt"
        with (
            mock.patch.object(atomic_file.os, "fsync", wraps=os.fsync) as fsync,
            mock.patch.object(
                atomic_file,
                "_fsync_directory",
                wraps=atomic_file._fsync_directory,
            ) as directory_fsync,
        ):
            atomic_file.atomic_write(destination, "ready\n", mode=0o600)

        self.assertEqual(destination.read_text(encoding="utf-8"), "ready\n")
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        self.assertEqual(fsync.call_count, 2)
        self.assertEqual(directory_fsync.call_args_list, [mock.call(self.root)])
        self.assertEqual(self.temporary_files(destination), [])

    def test_publishes_binary_content(self) -> None:
        atomic_file.atomic_write(self.destination, b"\x00\xff\n")

        self.assertEqual(self.destination.read_bytes(), b"\x00\xff\n")
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o644)

    def test_file_fsync_failure_preserves_destination_and_removes_temporary(self) -> None:
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"previous\n")

        with (
            mock.patch.object(atomic_file.os, "fsync", side_effect=OSError("fsync failed")),
            self.assertRaisesRegex(OSError, "fsync failed"),
        ):
            atomic_file.atomic_write(self.destination, b"replacement\n")

        self.assertEqual(self.destination.read_bytes(), b"previous\n")
        self.assertEqual(self.temporary_files(), [])

    def test_replace_failure_preserves_destination_and_removes_temporary(self) -> None:
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"previous\n")

        with (
            mock.patch.object(atomic_file.os, "replace", side_effect=OSError("replace failed")),
            self.assertRaisesRegex(OSError, "replace failed"),
        ):
            atomic_file.atomic_write(self.destination, b"replacement\n")

        self.assertEqual(self.destination.read_bytes(), b"previous\n")
        self.assertEqual(self.temporary_files(), [])


if __name__ == "__main__":
    unittest.main()
