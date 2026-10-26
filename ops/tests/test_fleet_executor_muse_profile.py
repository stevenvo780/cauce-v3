from __future__ import annotations

import hashlib
import os
import pathlib
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from fleet_executor_profiles import prepare_empty_profile


class MuseProfileDataDirectoryTest(unittest.TestCase):
    """Production, 26-oct (Humanizar hegel): Muse had created data/muse with its own 0755 umask on first login; the
    shared-session adapter refuses a non-private profile directory, so every admitted start died with SHARED_TUI_UNAVAILABLE."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name) / 'profiles'
        self.profile = self.root / 'hegel' / hashlib.sha256(b'fixture').hexdigest()
        self.ids = os.getuid(), os.getgid()

    def tearDown(self):
        self.directory.cleanup()

    def prepare(self):
        prepare_empty_profile(str(self.root), str(self.profile), *self.ids, provider='muse')

    def mode(self, path: pathlib.Path) -> int:
        return stat.S_IMODE(path.lstat().st_mode)

    def test_a_new_muse_profile_owns_a_private_data_directory_before_muse_runs(self):
        self.prepare()
        self.assertEqual(self.mode(self.profile / 'data' / 'muse'), 0o700)

    def test_a_data_directory_muse_left_open_is_narrowed_without_touching_its_contents(self):
        self.prepare()
        muse = self.profile / 'data' / 'muse'
        (muse / 'plugins').mkdir(mode=0o755)
        os.chmod(muse / 'plugins', 0o755)
        os.chmod(muse, 0o755)
        self.prepare()
        self.assertEqual(self.mode(muse), 0o700)
        self.assertEqual(self.mode(muse / 'plugins'), 0o755)

    def test_a_symlinked_data_directory_is_refused(self):
        self.prepare()
        muse = self.profile / 'data' / 'muse'
        muse.rmdir()
        target = pathlib.Path(self.directory.name) / 'elsewhere'
        target.mkdir()
        os.chmod(target, 0o755)
        muse.symlink_to(target)
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(self.mode(target), 0o755)


if __name__ == '__main__':
    unittest.main()
