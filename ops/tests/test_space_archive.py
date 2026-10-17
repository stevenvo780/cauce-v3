import errno
import hashlib
import io
import json
import os
import pathlib
import shutil
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
        (self.space / 'projects/cookies.txt').write_text('jar')
        (self.space / 'projects/server.pem').write_text('pem')
        (self.space / 'projects/.env').write_text('API_KEY=synthetic-sensitive-credential')
        (self.space / 'config/service.json').write_text('{"access_token":"synthetic-sensitive-credential"}')
        (self.space / 'logs/session.txt').write_text('not backed up')
        result = self.backup()
        self.assertEqual({item['path'] for item in result['omissions']},
                         {'config/auth.json', 'projects/.codex', 'projects/cookies.txt', 'projects/server.pem', 'projects/.env', 'config/service.json'})
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertFalse((self.restored / 'config/service.json').exists())
        with zipfile.ZipFile(self.archive) as archived:
            self.assertFalse(any(b'synthetic-sensitive-credential' in archived.read(item) for item in archived.infolist()))

    def test_project_sources_named_auth_or_session_are_kept_and_git_omission_is_declared(self):
        project = self.space / 'projects/app'
        (project / 'src/auth').mkdir(parents=True, mode=0o700)
        (project / 'src/auth/login.ts').write_text('export const login = () => 1;\n')
        (project / 'session.py').write_text('SESSION_TTL = 3600\n')
        (project / 'token_utils.py').write_text('def parse(): pass\n')
        (project / '.env').write_text('A=1')
        (project / 'auth.json').write_text('{}')
        (project / 'credentials.prod.json').write_text('{}')
        (project / '.git').mkdir(mode=0o700)
        (project / '.git/config').write_text('[remote "origin"]\n')
        result = self.backup()
        self.assertEqual({item['path']: item['reason'] for item in result['omissions']},
                         {'projects/app/.env': 'sensitive_path', 'projects/app/auth.json': 'sensitive_path',
                          'projects/app/credentials.prod.json': 'sensitive_path', 'projects/app/.git': 'vcs_metadata'})
        restore_space(str(self.archive), str(self.restored), self.identity)
        for kept in ('src/auth/login.ts', 'session.py', 'token_utils.py'):
            self.assertTrue((self.restored / 'projects/app' / kept).is_file())
        self.assertFalse((self.restored / 'projects/app/.git').exists())

    def test_real_credential_names_are_omitted_while_lookalike_sources_stay(self):
        project = self.space / 'projects/app'
        names = ['.git-credentials', 'credentials', 'credentials.yaml', '.credentials.json', 'secrets.json', 'secrets.yaml',
                 'client_secret.json', 'token.json', 'bot.session', '.netrc', '.pgpass', 'id_rsa', 'id_ed25519', '.aws/credentials',
                 '.docker/config.json', '.kube/config', '.gemini/oauth.json']
        for name in names:
            target = project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('x')
        for kept in ('session.py', 'token_utils.py', 'id_rsa.pub', 'secrets_manager.py'):
            (project / kept).write_text('x = 1\n')
        omitted = {item['path'] for item in self.backup()['omissions']}
        for name in names:
            self.assertTrue(any(path == f'projects/app/{name}' or f'projects/app/{name}'.startswith(path + '/') for path in omitted), name)
        restore_space(str(self.archive), str(self.restored), self.identity)
        for kept in ('session.py', 'token_utils.py', 'id_rsa.pub', 'secrets_manager.py'):
            self.assertTrue((self.restored / 'projects/app' / kept).is_file(), kept)

    def test_extra_credential_files_and_token_content_are_omitted_while_cookie_sources_stay(self):
        project = self.space / 'projects/app'
        (project / 'src/lib').mkdir(parents=True, mode=0o700)
        names = ('.npmrc', '.pypirc', '.htpasswd', 'cookies', 'cookies.txt', 'cookies.json', 'cookies.sqlite', 'Cookies',
                 'cookies.sqlite-wal', 'cookies.sqlite-shm', 'cookies.sqlite-journal', 'Cookies-journal')
        for name in names:
            (project / name).write_text('x')
        for kept in ('src/lib/cookies.ts', 'cookie.js'):
            (project / kept).write_text('export const jar = 1;\n')
        omitted = {item['path'] for item in self.backup()['omissions']}
        for name in names:
            self.assertIn(f'projects/app/{name}', omitted, name)
        restore_space(str(self.archive), str(self.restored), self.identity)
        for kept in ('src/lib/cookies.ts', 'cookie.js'):
            self.assertTrue((self.restored / 'projects/app' / kept).is_file(), kept)

    def test_provider_tokens_and_url_credentials_in_content_are_omitted(self):
        samples = {
            'github': 'ghp_' + 'a' * 36, 'github_oauth': 'gho_' + 'b' * 36, 'github_user': 'ghu_' + 'c' * 36,
            'github_server': 'ghs_' + 'd' * 36, 'github_pat': 'github_pat_' + 'e' * 30, 'gitlab': 'glpat-' + 'f' * 20,
            'slack': 'xoxb-1234567890-abcdef', 'aws_key': 'AKIA' + 'A' * 16,
            'aws_secret': 'aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG',
            'npm_auth': '//registry.npmjs.org/:_authToken=abcd1234efgh', 'npm_token': 'npm_' + 'g' * 36,
            'url': 'git clone https://deploy:hunter2@example.test/repo.git'}
        for name, content in samples.items():
            (self.space / f'projects/{name}.txt').write_text(content)
        (self.space / 'projects/plain.txt').write_text('see https://example.test/docs and ghp_short\n')
        result = self.backup()
        self.assertEqual({item['path']: item['reason'] for item in result['omissions']},
                         {f'projects/{name}.txt': 'sensitive_content' for name in samples})
        with zipfile.ZipFile(self.archive) as archived:
            self.assertIn('projects/plain.txt', archived.namelist())

    def test_declared_external_mounts_are_omitted_with_their_reason(self):
        (self.space / 'projects/shared').mkdir(mode=0o700)
        (self.space / 'projects/shared/big.bin').write_text('x')
        (self.space / 'projects/keep.txt').write_text('keep')
        (self.space / 'config/external-mounts.json').write_text(json.dumps({'mounts': [
            {'path': str(self.space / 'projects/shared'), 'excluded_from_copy': True, 'reason': 'shared workspace'},
            {'path': '/workspace', 'excluded_from_copy': True, 'reason': 'outside the space'},
            {'path': 'projects/keep.txt', 'excluded_from_copy': False, 'reason': 'not excluded'}]}))
        result = self.backup()
        self.assertEqual(sorted(item['path'] for item in result['omissions'] if item['reason'] == 'external_mount'),
                         ['/workspace', 'projects/shared'])
        self.assertIn({'path': '/workspace', 'reason': 'external_mount'}, result['omissions'])
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertFalse((self.restored / 'projects/shared').exists())
        self.assertFalse((self.restored / 'workspace').exists())
        self.assertTrue((self.restored / 'projects/keep.txt').is_file())

    def test_external_mount_receipt_outside_the_space_must_be_a_normalized_absolute_path(self):
        for bad in ('/a/\x01b', '/', '/' + 'x' * 1100):
            (self.space / 'config/external-mounts.json').write_text(json.dumps({'mounts': [
                {'path': bad, 'excluded_from_copy': True, 'reason': 'x'}]}))
            with self.assertRaises(SpaceArchiveFailure):
                self.backup()
            self.assertFalse(self.archive.exists())

    def test_restore_rejects_external_mount_receipts_that_are_not_normalized_absolute_paths(self):
        for bad in ('/a/../b', '/a//b', 'workspace', 'projects/../x', '/a/\x01b'):
            (self.space / 'config/external-mounts.json').write_text(json.dumps({'mounts': [
                {'path': '/workspace', 'excluded_from_copy': True, 'reason': 'x'}]}))
            forged = self.root / 'forged.zip'
            forged.unlink(missing_ok=True)
            self.archive.unlink(missing_ok=True)
            self.backup()
            with zipfile.ZipFile(self.archive) as source, zipfile.ZipFile(forged, 'w') as target:
                for entry in source.infolist():
                    data = source.read(entry)
                    if entry.filename == 'space-manifest.json':
                        manifest = json.loads(data)
                        manifest['omissions'] = [{'path': bad, 'reason': 'external_mount'}]
                        data = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
                    target.writestr(entry, data)
            restored = self.root / 'forged-restored'
            with self.assertRaises(SpaceArchiveFailure):
                restore_space(str(forged), str(restored), self.identity)

    def test_malformed_external_mount_declaration_fails_closed(self):
        (self.space / 'config/external-mounts.json').write_text('{"mounts": 3}')
        with self.assertRaisesRegex(SpaceArchiveFailure, 'external mount declaration'):
            self.backup()
        self.assertFalse(self.archive.exists())

    def test_symlinks_fifos_and_hardlinks_are_typed_omissions_and_the_backup_continues(self):
        linked = self.space / 'projects/link'
        linked.symlink_to(self.root, target_is_directory=True)
        fifo = self.space / 'projects/queue'
        os.mkfifo(fifo)
        hard = self.space / 'data/mission-link'
        os.link(self.space / 'context/mission.md', hard)
        (self.space / 'projects/notes.py').write_text('password = "hunter2"\n')
        (self.space / 'config/local.json').write_text('{"password":"hunter2xx"}\n')
        result = self.backup()
        reasons = {item['path']: item['reason'] for item in result['omissions']}
        self.assertEqual(reasons['projects/link'], 'special_file')
        self.assertEqual(reasons['projects/queue'], 'special_file')
        self.assertEqual(reasons['data/mission-link'], 'special_file')
        self.assertEqual(reasons['config/local.json'], 'sensitive_content')
        self.assertNotIn('projects/notes.py', reasons)
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual((self.restored / 'projects/notes.py').read_text(), 'password = "hunter2"\n')
        self.assertFalse((self.restored / 'projects/link').exists())
        self.assertFalse((self.restored / 'config/local.json').exists())
        buffer = io.StringIO()
        with patch.object(sys, 'argv', ['space_archive.py', 'backup', '--archive', str(self.root / 'cli.zip'),
                                         '--directory', str(self.space), '--company-id', self.identity['company_id'],
                                         '--tenant-id', self.identity['tenant_id'], '--alias', self.identity['alias'],
                                         '--runtime-key', self.identity['runtime_key']]), \
                patch('sys.stderr', buffer):
            self.assertEqual(space_archive.main(), 0)
        text = buffer.getvalue()
        self.assertIn('omisiones:', text)
        self.assertIn('special_file projects/link', text)

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

    def test_literal_secrets_are_omitted_and_templates_stay_in_the_archive(self):
        kept = {
            'projects/aws-template.txt': 'aws_secret_access_key=${AWS_SECRET_ACCESS_KEY}\n',
            'projects/aws-env.txt': 'aws_secret_access_key=process.env.AWS_SECRET_ACCESS_KEY\n',
            'projects/aws-arrow-template.txt': "'aws_secret_access_key' => '${AWS_SECRET_ACCESS_KEY}'\n",
            'projects/aws-xml-template.txt': '<aws_secret_access_key>${AWS_SECRET_ACCESS_KEY}</aws_secret_access_key>\n',
            'projects/aws-spaces-template.txt': 'aws_secret_access_key ${AWS_SECRET_ACCESS_KEY}\n',
            'projects/aws-arrow-env.txt': 'aws_secret_access_key => process.env.AWS_SECRET_ACCESS_KEY\n',
            'projects/npm-template.txt': '_authToken=${NPM_TOKEN}\n',
            'projects/npm-env.txt': '_authToken=process.env.NPM_TOKEN\n',
            'projects/npm-quoted-template.txt': '_authToken="${NPM_TOKEN}"\n',
            'projects/url-template.txt': 'postgres://${DB_USER}:${DB_PASSWORD}@db/app\n',
            'projects/url-env.txt': 'postgres://process.env.DB_USER:process.env.DB_PASSWORD@db/app\n',
            'projects/url-password-template.txt': 'postgres://user:${PGPASS}@host\n',
            'projects/mention.txt': 'Document the aws_secret_access_key and _authToken fields.\n',
        }
        omitted = {
            'projects/aws-literal.txt': 'aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG+',
            'projects/aws-arrow.txt': "'aws_secret_access_key' => '" + 'wJalrXUtnFEMI/K7MDENG+' + "'\n",
            'projects/aws-xml.txt': '<aws_secret_access_key>' + 'wJalrXUtnFEMI/K7MDENG+' + '</aws_secret_access_key>\n',
            'projects/aws-spaces.txt': 'aws_secret_access_key ' + 'wJalrXUtnFEMI/K7MDENG+\n',
            'projects/npm-literal.txt': '//registry.npmjs.org/:_authToken=abcd1234efgh\n',
            'projects/npm-later-template.txt': "fs.writeFileSync('.npmrc', `//npm.corp.example/:_authToken=00000000-0000-4000-8000-40ed71cc50fb\\nemail=${email}\\n`)",
            'projects/npm-later-env.txt': '_authToken=TOKEN;x=process.env.X\n',
            'projects/url-literal.txt': 'git clone https://deploy:hunter2@example.test/repo.git\n',
            'projects/url-user-template.txt': 'postgres://${PGUSER}:S3cr3tLiteralPw@db.internal/app\n',
        }
        for path, content in {**kept, **omitted}.items():
            (self.space / path).write_text(content)
        reasons = {item['path']: item['reason'] for item in self.backup()['omissions']}
        self.assertEqual({path: reasons[path] for path in omitted}, {path: 'sensitive_content' for path in omitted})
        with zipfile.ZipFile(self.archive) as archived:
            manifest = json.loads(archived.read('space-manifest.json'))
            self.assertEqual(manifest['schema_version'], 2)
            for path, content in kept.items():
                self.assertEqual(archived.read(path).decode(), content, path)
                self.assertNotIn(path, reasons)
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual((self.restored / 'projects/mention.txt').read_text(), kept['projects/mention.txt'])

    def plant_legacy(self, text: str, schema_version: int):
        encoded = text.encode()

        def plant(item, data):
            if item.filename == 'projects/legacy.txt':
                data = encoded
            if item.filename == 'space-manifest.json':
                manifest = json.loads(data)
                manifest['schema_version'] = schema_version
                for entry in manifest['files']:
                    if entry['path'] == 'projects/legacy.txt':
                        entry['bytes'] = len(encoded)
                        entry['sha256'] = hashlib.sha256(encoded).hexdigest()
                manifest['bytes'] = sum(entry['bytes'] for entry in manifest['files'])
                data = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
            return item, data

        self.rewrite(plant)

    def test_schema_1_restores_plain_text_and_both_schemas_reject_literal_secrets(self):
        literal = 'aws_secret_access_key = ' + ('A' * 20) + '\n_authToken=abcd1234ef\nhttps://deploy:hunter2@example.test/repo.git\n'
        (self.space / 'projects/legacy.txt').write_text('plain notes\n')
        self.backup()
        self.plant_legacy('plain notes\n', 1)
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertEqual((self.restored / 'projects/legacy.txt').read_text(), 'plain notes\n')
        shutil.rmtree(self.restored)
        for schema_version in (1, 2):
            self.archive.unlink()
            self.backup()
            self.plant_legacy(literal, schema_version)
            with self.assertRaisesRegex(SpaceArchiveFailure, 'digest or content'):
                restore_space(str(self.archive), str(self.restored), self.identity)
            self.assertFalse(self.restored.exists())

    def test_missing_external_mount_file_does_not_require_a_private_config_directory(self):
        self.space.joinpath('config').chmod(0o755)
        result = self.backup()
        self.assertFalse(any(item['reason'] == 'external_mount' for item in result['omissions']))
        restore_space(str(self.archive), str(self.restored), self.identity)
        self.assertTrue((self.restored / 'config/context-state.json').is_file())

    def test_external_mount_file_still_requires_a_private_config_directory(self):
        (self.space / 'config/external-mounts.json').write_text(json.dumps({'mounts': []}))
        self.space.joinpath('config').chmod(0o755)
        with self.assertRaisesRegex(SpaceArchiveFailure, 'unsafe owner or mode'):
            self.backup()
        self.assertFalse(self.archive.exists())


class SpaceMigrationTests(unittest.TestCase):
    """Legacy harness cwd moved into space/projects by copy: inventory first, then manifests before and after without losses."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.identity = {'company_id': 'zz_canary', 'tenant_id': 'ZzCanary', 'alias': 'zz-canary-agent', 'runtime_key': 'zz-canary-agent'}
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir(mode=0o755)
        (self.workspace / 'CLAUDE.md').write_text('Legacy project instructions.\n')
        (self.workspace / 'nonce.txt').write_text('zz-canary-nonce-legacy\n')
        (self.workspace / 'src').mkdir()
        (self.workspace / 'src/app.py').write_text('print("hola")\n')
        (self.workspace / 'run.sh').write_text('exit 0\n')
        (self.workspace / 'run.sh').chmod(0o755)
        (self.workspace / 'empty').mkdir()
        (self.workspace / '.git/objects/ab').mkdir(parents=True)
        (self.workspace / '.git/HEAD').write_text('ref: refs/heads/main\n')
        (self.workspace / '.git/objects/ab/cdef').write_bytes(bytes(range(256)) * 64)
        (self.workspace / '.env').write_text('TOKEN=zz-canary-never-copied\n')
        (self.workspace / 'link').symlink_to('src/app.py')
        os.mkfifo(self.workspace / 'pipe')
        self.space = self.root / 'state/space'
        self.space.mkdir(parents=True, mode=0o700)
        for name in space_archive.STANDARD_DIRECTORIES:
            (self.space / name).mkdir(mode=0o700)
        (self.space / 'config/context-state.json').write_text(json.dumps({**self.identity, 'version': 1}))

    def tearDown(self):
        self.temporary.cleanup()

    def listing(self, base: pathlib.Path) -> dict:
        return {str(path.relative_to(base)): (path.lstat().st_mode, path.lstat().st_mtime_ns) for path in sorted(base.rglob('*'))}

    def cli(self, *arguments: str) -> tuple[int, str]:
        output = io.StringIO()
        identity = [item for field, value in self.identity.items() for item in ('--' + field.replace('_', '-'), value)]
        with patch.object(sys, 'argv', ['space_archive.py', *arguments, *identity]), patch('sys.stdout', output), \
                patch('sys.stderr', io.StringIO()):
            try:
                code = space_archive.main()
            except SystemExit as stop:
                code = stop.code
        return code, output.getvalue()

    def migrate(self, dry_run: bool = False) -> dict:
        return space_archive.migrate_workspace(str(self.workspace), str(self.space), self.identity, dry_run)

    def test_inventory_dry_run_classifies_every_path_and_backup_exclusion_without_content_or_writes(self):
        (self.space / 'CLAUDE.md').write_text('Native document.\n')
        (self.space / 'notas-sueltas.txt').write_text('Unknown purpose.\n')
        (self.space / 'logs/adapter.log').write_text('log line\n')
        (self.space / 'config/auth.json').write_text('{"token":"zz-canary-auth"}')
        (self.space / 'projects/notes.py').write_text('DSN = "postgres://zz:zz-canary-literal@db/app"\n')
        (self.space / 'data/big.bin').write_bytes(b'\0' * 1024)
        (self.space / 'data/big.bin').chmod(0o644)
        space_before, workspace_before = self.listing(self.space), self.listing(self.workspace)
        code, output = self.cli('inventory', '--dry-run', '--directory', str(self.space), '--workspace', str(self.workspace))
        self.assertEqual(code, 0)
        result = json.loads(output)
        self.assertEqual((result['state'], result['dry_run'], result['missing_directories']), ('inventoried', True, []))
        entries = {entry['path']: entry for entry in result['entries']}
        self.assertEqual(entries['CLAUDE.md']['classification'], 'native_document')
        self.assertEqual(entries['notas-sueltas.txt']['classification'], 'desconocida')
        self.assertEqual(result['unknown'], ['notas-sueltas.txt'])
        self.assertEqual(entries['logs/adapter.log']['backup'], 'excluded_root')
        self.assertEqual(entries['config/auth.json']['backup'], 'sensitive_path')
        self.assertEqual(entries['projects/notes.py']['backup'], 'sensitive_content')
        self.assertEqual(entries['data/big.bin'], {'path': 'data/big.bin', 'mode': 0o644, 'kind': 'file', 'bytes': 1024,
                                                    'sha256': hashlib.sha256(b'\0' * 1024).hexdigest(),
                                                    'classification': 'data', 'backup': None})
        legacy = {entry['path']: entry for entry in result['workspace']['entries']}
        self.assertEqual({path: legacy[path]['migration'] for path in ('.env', '.git/HEAD', 'link', 'pipe', 'run.sh')},
                         {'.env': 'sensitive_path', '.git/HEAD': 'copy', 'link': 'copy', 'pipe': 'special_file', 'run.sh': 'copy'})
        self.assertEqual(legacy['link']['target'], 'src/app.py')
        for secret in ('zz-canary-never-copied', 'zz-canary-auth', 'zz-canary-literal', 'Legacy project instructions'):
            self.assertNotIn(secret, output)
        self.assertEqual((self.listing(self.space), self.listing(self.workspace)), (space_before, workspace_before))
        self.assertEqual(self.cli('inventory', '--directory', str(self.space))[0], 2)

    def test_migration_copies_without_moving_and_its_manifest_diff_loses_nothing(self):
        workspace_before = self.listing(self.workspace)
        planned = self.migrate(dry_run=True)
        self.assertEqual((planned['state'], planned['lost'], planned['conflicts'], planned['after']), ('planned', [], [], None))
        self.assertEqual(list((self.space / 'projects').iterdir()), [])
        self.assertFalse((self.space / 'config/space-migration.json').exists())
        code, output = self.cli('migrate', '--directory', str(self.space), '--workspace', str(self.workspace))
        self.assertEqual(code, 0)
        result = json.loads(output)
        self.assertEqual((result['state'], result['lost'], result['conflicts']), ('migrated', [], []))
        self.assertEqual(result['before']['sha256'], planned['before']['sha256'])
        self.assertEqual({item['path']: item['reason'] for item in result['kept_at_origin']}, {'.env': 'sensitive_path', 'pipe': 'special_file'})
        after = {entry['path']: entry for entry in result['after']['entries']}
        for entry in result['before']['entries']:
            if entry['path'] in ('.env', 'pipe'):
                self.assertNotIn(entry['path'], after)
                continue
            self.assertTrue(space_archive.same_entry(entry, after[entry['path']]), entry['path'])
        projects = self.space / 'projects'
        self.assertEqual((projects / 'nonce.txt').read_text(), 'zz-canary-nonce-legacy\n')
        self.assertEqual((projects / '.git/objects/ab/cdef').read_bytes(), bytes(range(256)) * 64)
        self.assertEqual(os.readlink(projects / 'link'), 'src/app.py')
        self.assertEqual(stat.S_IMODE((projects / 'run.sh').stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((projects / 'src/app.py').stat().st_mode), 0o600)
        self.assertEqual((projects / 'src/app.py').stat().st_mtime_ns, (self.workspace / 'src/app.py').stat().st_mtime_ns)
        self.assertTrue((projects / 'empty').is_dir())
        self.assertFalse((projects / '.env').exists())
        self.assertEqual(self.listing(self.workspace), workspace_before)
        receipt_path = self.space / 'config/space-migration.json'
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(stat.S_IMODE(receipt_path.stat().st_mode), 0o600)
        self.assertEqual((receipt['state'], receipt['lost'], receipt['before_sha256'], receipt['after_sha256']),
                         ('migrated', [], result['before']['sha256'], result['after']['sha256']))
        self.assertIn('SPACE_CWD_MIGRATED', receipt['rollback'])
        archive, restored = self.root / 'migrated.zip', self.root / 'restored'
        backup_space(str(self.space), str(archive), self.identity)
        restore_space(str(archive), str(restored), self.identity)
        self.assertEqual((restored / 'projects/nonce.txt').read_text(), 'zz-canary-nonce-legacy\n')
        self.assertEqual((restored / 'projects/run.sh').read_text(), 'exit 0\n')

    def test_rerun_resumes_identical_copies_and_a_divergent_destination_stops_before_writing(self):
        first = self.migrate()
        again = self.migrate()
        self.assertEqual((again['state'], again['copied'], again['lost']), ('migrated', 0, []))
        self.assertEqual(again['existing'], len(first['before']['entries']) - len(first['kept_at_origin']))
        (self.space / 'projects/src/app.py').write_text('edited after the migration\n')
        (self.workspace / 'extra.txt').write_text('new legacy file\n')
        code, output = self.cli('migrate', '--directory', str(self.space), '--workspace', str(self.workspace))
        self.assertEqual(code, 1)
        result = json.loads(output)
        self.assertEqual((result['state'], result['conflicts']), ('conflict', ['src/app.py']))
        self.assertFalse((self.space / 'projects/extra.txt').exists())
        self.assertEqual((self.space / 'projects/src/app.py').read_text(), 'edited after the migration\n')

    def test_space_inside_the_workspace_is_skipped_and_a_workspace_inside_the_space_or_a_foreign_space_is_refused(self):
        home = self.root / 'home'
        shutil.copytree(self.workspace, home, symlinks=True, ignore=shutil.ignore_patterns('pipe'))
        nested = home / '.cauce/state/space'
        nested.mkdir(parents=True, mode=0o700)
        for name in space_archive.STANDARD_DIRECTORIES:
            (nested / name).mkdir(mode=0o700)
        result = space_archive.migrate_workspace(str(home), str(nested), self.identity)
        self.assertEqual(result['lost'], [])
        self.assertIn({'path': '.cauce/state/space', 'reason': 'space_root'}, result['kept_at_origin'])
        self.assertFalse((nested / 'projects/.cauce/state/space').exists())
        with self.assertRaisesRegex(SpaceArchiveFailure, 'already lives inside the space'):
            space_archive.migrate_workspace(str(self.space / 'projects'), str(self.space), self.identity)
        (self.space / 'config/context-state.json').write_text(json.dumps({**self.identity, 'alias': 'zz-canary-other'}))
        with self.assertRaisesRegex(SpaceArchiveFailure, 'another context identity'):
            self.migrate()
        self.assertEqual(list((self.space / 'projects').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
