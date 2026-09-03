#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import pathlib
import stat
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, os.fspath(SCRIPTS))
import secure_path  # noqa: E402
import update_alias_lib  # noqa: E402

PIN_SCRIPT = SCRIPTS / "pin-container-release.py"
PIN_SPEC = importlib.util.spec_from_file_location("pin_container_release", PIN_SCRIPT)
assert PIN_SPEC and PIN_SPEC.loader
PIN_MODULE = importlib.util.module_from_spec(PIN_SPEC)
PIN_SPEC.loader.exec_module(PIN_MODULE)


class SecurePathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-secure-path-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)

    def test_rejects_noncanonical_absolute_paths(self) -> None:
        for path in ("relative", "/", "/tmp//x", "/tmp/./x", "/tmp/../x", "/tmp/x\x00y"):
            with self.subTest(path=path), self.assertRaises(secure_path.InvalidAbsolutePath):
                secure_path.absolute_components(path)

    def test_callers_keep_their_domain_errors_for_invalid_paths(self) -> None:
        with self.assertRaises(PIN_MODULE.PinError):
            PIN_MODULE.validate_absolute(pathlib.Path("relative"), "config root")
        with self.assertRaises(update_alias_lib.ConfigUpdateError):
            update_alias_lib.validate_absolute(pathlib.Path("relative"), "raiz config")

    def test_opens_directory_without_following_a_symlink_component(self) -> None:
        real = self.root / "real"
        real.mkdir()
        link = self.root / "link"
        link.symlink_to(real, target_is_directory=True)

        descriptor = secure_path.open_absolute_directory(real)
        try:
            self.assertTrue(stat.S_ISDIR(os.fstat(descriptor).st_mode))
        finally:
            os.close(descriptor)
        with self.assertRaises(OSError):
            secure_path.open_absolute_directory(link)

    def test_regular_open_rejects_symlinks_and_applies_create_mode(self) -> None:
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            descriptor = secure_path.open_regular_at(
                directory,
                "created",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                mode=0o600,
            )
            os.close(descriptor)
            self.assertEqual(stat.S_IMODE((self.root / "created").stat().st_mode), 0o600)
            (self.root / "link").symlink_to("created")
            with self.assertRaises(OSError):
                secure_path.open_regular_at(directory, "link", os.O_RDONLY)
        finally:
            os.close(directory)


if __name__ == "__main__":
    unittest.main()
