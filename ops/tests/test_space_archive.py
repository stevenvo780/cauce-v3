import errno
import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import space_archive
from space_archive import MAX_FILE, SpaceArchiveFailure, backup_space, restore_space, zip_entry


class SpaceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.space = self.root / 'space'
        self.space.mkdir(mode=0o700)
        self.identity = {'company_id': 'alpha', 'tenant_id': 'Alpha', 'alias': 'director', 'runtime_key': 'alpha-director'}
        for name in ('context', 'directives', 'projects', 'config', 'data', 'logs', 'tmp'):
            (self.space / name).mkdir(mode=0o700)
        (self.space / 'context/mission.md').write_text('Context preserved.\n')
        (self.space / 'context/profile.json').write_text(json.dumps({'purpose': 'Canonical agent purpose'}))
        (self.space / 'config/context-state.json').write_text(json.dumps({**self.identity, 'version': 3}))
        (self.space / 'projects/empty').mkdir(mode=0o700)
        (self.space / 'projects/run.sh').write_text('exit 0\n')
        (self.space / 'projects/run.sh').chmod(0o755)
        (self.space / 'data/pixels.bin').write_bytes(bytes(range(256)))
        self.archive = self.root / 'backup.zip'
        self.restored = self.root / 'restored'

    def tearDown(self):
        self.temporary.cleanup()

    def backup(self):
        return backup_space(str(self.space), str(self.archive), self.identity)

    def test_root_entries_share_the_export_limit_and_every_accepted_boundary_restores(self):
        source = self.root / 'entry-space'
        source.mkdir(mode=0o700)
        for name in space_archive.ROOTS:
            (source / name).mkdir(mode=0o700)
        for index in range(3):
            (source / 'config' / f'empty-{index}.txt').write_bytes(b'')
        with patch.object(space_archive, 'MAX_ENTRIES', 4):
            with self.assertRaisesRegex(SpaceArchiveFailure, 'too many archive entries'):
                backup_space(str(source), str(self.archive), self.identity)
        self.assertFalse(self.archive.exists())
        with patch.object(space_archive, 'MAX_ENTRIES', 8):
            result = backup_space(str(source), str(self.archive), self.identity)
            self.assertEqual(result['state'], 'backed_up')
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual(len(list((self.restored / 'config').iterdir())), 3)

    def rewrite(self, transform):
        with zipfile.ZipFile(self.archive) as source:
            entries = [(item, source.read(item)) for item in source.infolist()]
        with zipfile.ZipFile(self.archive, 'w') as destination:
            for item, data in entries:
                item, data = transform(item, data)
                destination.writestr(item, data)

    def test_full_allowlisted_space_roundtrip_preserves_bytes_identity_empty_directories_and_modes(self):
        backup = self.backup()
        result = restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual(result['state'], 'restored')
        self.assertEqual(result['manifest_sha256'], backup['manifest_sha256'])
        self.assertEqual((self.restored / 'context/mission.md').read_bytes(), (self.space / 'context/mission.md').read_bytes())
        self.assertEqual((self.restored / 'data/pixels.bin').read_bytes(), bytes(range(256)))
        self.assertTrue((self.restored / 'projects/empty').is_dir())
        self.assertEqual((self.restored / 'context/profile.json').read_text(), (self.space / 'context/profile.json').read_text())
        self.assertEqual(os.stat(self.archive).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.restored).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.restored / 'projects/run.sh').st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.restored / 'context/mission.md').st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.restored / 'space-restore-receipt.json').read_text())['identity'], self.identity)
        self.assertFalse((self.restored / 'logs').exists())
        self.assertFalse((self.restored / 'tmp').exists())

    def test_sensitive_paths_are_never_opened_and_known_sensitive_content_is_omitted(self):
        (self.space / 'config/auth.json').symlink_to('/unreadable/secret')
        (self.space / 'projects/.codex').symlink_to('/unreadable/profile')
        (self.space / 'data/sessions.sqlite').write_bytes(b'session fixture')
        (self.space / 'projects/.env').write_text('API_KEY=synthetic-sensitive-credential')
        (self.space / 'config/service.json').write_text('{"access_token":"synthetic-sensitive-credential"}')
        (self.space / 'logs/session.txt').write_text('not backed up')
        result = self.backup()
        self.assertEqual({item['path'] for item in result['omissions']},
                         {'config/auth.json', 'projects/.codex', 'data/sessions.sqlite', 'projects/.env', 'config/service.json'})
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertFalse((self.restored / 'config/service.json').exists())
        with zipfile.ZipFile(self.archive) as archived:
            self.assertFalse(any(b'synthetic-sensitive-credential' in archived.read(item) for item in archived.infolist()))

    def test_symlinks_and_hardlinks_outside_sensitive_paths_fail_without_leaving_an_archive(self):
        linked = self.space / 'projects/link'
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.backup()
        self.assertFalse(self.archive.exists())
        linked.unlink()
        os.link(self.space / 'context/mission.md', linked)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'links'):
            self.backup()
        self.assertFalse(self.archive.exists())

    def test_foreign_source_or_requested_restore_identity_is_refused_before_writes(self):
        (self.space / 'config/context-state.json').write_text(json.dumps({**self.identity, 'company_id': 'other'}))
        with self.assertRaisesRegex(SpaceArchiveFailure, 'another context identity'):
            self.backup()
        self.assertFalse(self.archive.exists())
        (self.space / 'config/context-state.json').write_text(json.dumps(self.identity))
        self.backup()
        with self.assertRaisesRegex(SpaceArchiveFailure, 'identity or schema'):
            restore_space(str(self.archive), str(self.restored), {**self.identity, 'runtime_key': 'foreign'})
        self.assertFalse(self.restored.exists())

    def test_nonempty_or_symlink_destination_is_refused_and_existing_bytes_are_preserved(self):
        self.backup()
        self.restored.mkdir(mode=0o700)
        file = self.restored / 'existing.txt'
        file.write_text('Preserve this.')
        with self.assertRaisesRegex(SpaceArchiveFailure, 'new or empty'):
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual(file.read_text(), 'Preserve this.')
        file.unlink()
        self.restored.rmdir()
        self.restored.symlink_to(self.space, target_is_directory=True)
        with self.assertRaises(OSError):
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual((self.space / 'context/mission.md').read_text(), 'Context preserved.\n')

    def test_tampered_digest_and_injected_path_are_refused_before_destination_creation(self):
        self.backup()
        def tamper(item, data):
            if item.filename == 'context/mission.md':
                data = b'Tampered bytes!!!!\n'
            return item, data
        self.rewrite(tamper)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'digest|receipt'):
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertFalse(self.restored.exists())
        self.archive.unlink()
        self.backup()
        with zipfile.ZipFile(self.archive, 'a') as zipped:
            zipped.writestr(zip_entry('../escape', 0o600), b'escape')
        with self.assertRaisesRegex(SpaceArchiveFailure, 'contents differ'):
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertFalse((self.root / 'escape').exists())
        self.assertFalse(self.restored.exists())

    def test_private_user_owned_paths_and_closed_zip_entry_types_are_required(self):
        self.space.chmod(0o755)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'private'):
            self.backup()
        self.space.chmod(0o700)
        self.backup()
        self.archive.chmod(0o644)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'private'):
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.archive.chmod(0o600)
        def symlink(item, data):
            if item.filename == 'context/mission.md':
                item.external_attr = (stat.S_IFLNK | 0o600) << 16
            return item, data
        self.rewrite(symlink)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'unsafe type'):
            restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertFalse(self.restored.exists())

    def test_archive_inside_source_and_existing_archive_are_refused(self):
        with self.assertRaisesRegex(SpaceArchiveFailure, 'outside'):
            backup_space(str(self.space), str(self.space / 'projects/backup.zip'), self.identity)
        self.backup()
        before = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaises(FileExistsError):
            self.backup()
        self.assertEqual(hashlib.sha256(self.archive.read_bytes()).hexdigest(), before)

    def test_file_and_total_limits_fail_without_an_incomplete_or_silently_omitted_archive(self):
        large = self.space / 'data/oversized.jsonl'
        with large.open('wb') as output:
            output.truncate(MAX_FILE + 1)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'size'):
            self.backup()
        self.assertFalse(self.archive.exists())
        large.unlink()
        with patch.object(space_archive, 'MAX_TOTAL', 128):
            with self.assertRaisesRegex(SpaceArchiveFailure, 'total byte limit'):
                self.backup()
        self.assertFalse(self.archive.exists())

    def test_disk_full_failure_removes_the_partial_archive_without_a_success_receipt(self):
        with patch.object(zipfile.ZipFile, 'writestr', side_effect=OSError(errno.ENOSPC, 'No space left on device')):
            with self.assertRaises(OSError) as failure:
                self.backup()
        self.assertEqual(failure.exception.errno, errno.ENOSPC)
        self.assertFalse(self.archive.exists())
        self.assertEqual((self.space / 'context/mission.md').read_text(), 'Context preserved.\n')


if __name__ == '__main__':
    unittest.main()
