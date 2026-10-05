import fcntl
import importlib.util
import json
import os
import pathlib
import queue
import shutil
import stat
import tempfile
import threading
import unittest
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[1] / 'instances/hospital/praxis-supervision-identity.py'
SPEC = importlib.util.spec_from_file_location('supervision_identity', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


REGISTER_PATH = PATH.with_name('register-console-identity.py')
REGISTER_SPEC = importlib.util.spec_from_file_location('console_identity_registration', REGISTER_PATH)
REGISTER = importlib.util.module_from_spec(REGISTER_SPEC)
REGISTER_SPEC.loader.exec_module(REGISTER)

class IdentityAuthorityTest(unittest.TestCase):
    def test_active_monitor_pass_prevents_all_renewal_mutations(self):
        with mock.patch.object(MODULE.os, 'geteuid', return_value=0), \
                mock.patch.object(MODULE.pathlib.Path, 'open', mock.mock_open()), \
                mock.patch.object(MODULE.fcntl, 'flock', side_effect=BlockingIOError), \
                mock.patch.object(MODULE, 'maintain_identity') as maintain:
            self.assertEqual(MODULE.main(), 0)
            maintain.assert_not_called()

    def test_foreign_identity_added_during_signing_is_preserved(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        foreign = {'principal': {'alias': 'operador'}, 'certificate_sha256': 'b' * 64}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'registry.json'
            path.write_text(json.dumps({'version': 1, 'identities': [own, foreign]}))
            path.chmod(0o400)
            replacement = {**own, 'certificate_sha256': 'c' * 64}
            MODULE.replace_owned_record(path, own, replacement, path.stat())
            written = json.loads(path.read_text())
            self.assertEqual(written['identities'][1], foreign)
            self.assertEqual(written['identities'][0], replacement)

    def test_key_mismatch_prevents_registry_changes(self):
        with mock.patch.object(MODULE.subprocess, 'check_output', side_effect=[b'key-one', b'key-two']):
            with self.assertRaises(ValueError):
                MODULE.verify_owned_leaf(pathlib.Path('key'), pathlib.Path('cert'))

    def test_concurrent_change_of_service_authority_is_rejected(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'registry.json'
            path.write_text(json.dumps({'version': 1, 'identities': [{**own, 'certificate_sha256': 'b' * 64}]}))
            path.chmod(0o400)
            with self.assertRaises(ValueError):
                MODULE.replace_owned_record(path, own, {**own, 'certificate_sha256': 'c' * 64}, path.stat())

    def test_only_one_exact_service_authority_is_renewable(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        foreign = {'principal': {'alias': 'operador', 'permissions': ['read', 'route']}}
        document = {'version': 1, 'identities': [foreign, own]}
        self.assertIs(MODULE.validate_record(document), own)
        self.assertEqual(document['identities'][0], foreign)
        altered = {'version': 1, 'identities': [{**own, 'principal': {**own['principal'], 'permissions': ['control']}}]}
        with self.assertRaises(ValueError):
            MODULE.validate_record(altered)

    def test_ambiguous_or_missing_service_is_rejected(self):
        own = {'principal': dict(MODULE.PRINCIPAL)}
        for identities in ([], [own, own]):
            with self.assertRaises(ValueError):
                MODULE.validate_record({'version': 1, 'identities': identities})

    def test_unsafe_registry_lock_paths_and_permissions_are_rejected(self):
        for kind in ('symlink', 'hardlink', 'mode', 'directory', 'owner'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                registry = pathlib.Path(directory) / 'registry.json'
                lock_path = registry.with_name('.registry.json.lock')
                target = pathlib.Path(directory) / 'target'
                target.write_text('')
                target.chmod(0o600)
                if kind == 'symlink':
                    lock_path.symlink_to(target)
                elif kind == 'hardlink':
                    os.link(target, lock_path)
                elif kind == 'directory':
                    lock_path.mkdir()
                else:
                    lock_path.write_text('')
                    lock_path.chmod(0o644 if kind == 'mode' else 0o600)
                real_fstat = os.fstat
                def observed_fstat(fd, kind=kind, real_fstat=real_fstat):
                    observed = real_fstat(fd)
                    if kind == 'owner' and stat.S_ISREG(observed.st_mode):
                        values = list(observed)
                        values[4] = 12345
                        return os.stat_result(values)
                    return observed
                with mock.patch.object(os, 'fstat', side_effect=observed_fstat), \
                        self.assertRaises((OSError, ValueError)):
                    with MODULE.RegistryLock(registry):
                        self.fail('unsafe lock entered')
                self.assertEqual(target.read_text(), '')

    def test_registry_lock_revalidates_inode_and_permissions_after_wait(self):
        for changed in ('inode', 'mode', 'links'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                registry = pathlib.Path(directory) / 'registry.json'
                lock_path = registry.with_name('.registry.json.lock')
                real_flock = fcntl.flock
                def acquire_then_change(fd, operation, changed=changed, lock_path=lock_path,
                                       real_flock=real_flock, directory=directory):
                    real_flock(fd, operation)
                    if changed == 'inode':
                        lock_path.unlink()
                        lock_path.write_text('')
                        lock_path.chmod(0o600)
                    elif changed == 'mode':
                        lock_path.chmod(0o644)
                    else:
                        os.link(lock_path, pathlib.Path(directory) / 'second-link')
                with mock.patch.object(fcntl, 'flock', side_effect=acquire_then_change), self.assertRaises(ValueError):
                    with MODULE.RegistryLock(registry):
                        self.fail('changed lock entered')

    def test_registry_lock_rejects_writable_or_symlinked_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = pathlib.Path(directory) / 'identities'
            folder.mkdir(mode=0o777)
            folder.chmod(0o777)
            with self.assertRaises(ValueError), MODULE.RegistryLock(folder / 'registry.json'):
                self.fail('writable directory entered')
            folder.chmod(0o700)
            alias = pathlib.Path(directory) / 'alias'
            alias.symlink_to(folder, target_is_directory=True)
            with self.assertRaises(OSError), MODULE.RegistryLock(alias / 'registry.json'):
                self.fail('symlink directory entered')

    def test_registry_lock_releases_on_failure_and_reuses_same_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = pathlib.Path(directory) / 'registry.json'
            first = MODULE.RegistryLock(registry)
            with self.assertRaisesRegex(ValueError, 'synthetic failure'):
                with first:
                    inode = os.fstat(first.fd).st_ino
                    raise ValueError('synthetic failure')
            self.assertIsNone(first.fd)
            self.assertIsNone(first.directory_fd)
            with REGISTER.RegistryLock(registry) as second:
                self.assertEqual(os.fstat(second.fd).st_ino, inode)
                self.assertEqual(os.fstat(second.fd).st_mode & 0o777, 0o600)

    def test_packaged_identity_scripts_import_the_adjacent_shared_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            for source in (PATH, REGISTER_PATH, PATH.with_name('identity-registry-lock.py')):
                shutil.copyfile(source, pathlib.Path(directory) / source.name)
            for name in (PATH.name, REGISTER_PATH.name):
                spec = importlib.util.spec_from_file_location('packaged_identity', pathlib.Path(directory) / name)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                registry = pathlib.Path(directory) / 'registry.json'
                with module.RegistryLock(registry):
                    self.assertEqual(registry.with_name('.registry.json.lock').stat().st_mode & 0o777, 0o600)

    def test_replacement_cannot_change_the_fixed_service_authority(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as directory:
            registry = pathlib.Path(directory) / 'registry.json'
            original = json.dumps({'version': 1, 'identities': [own]})
            registry.write_text(original)
            registry.chmod(0o400)
            replacement = {**own, 'principal': {**own['principal'], 'permissions': ['control']}}
            with self.assertRaises(ValueError):
                MODULE.replace_owned_record(registry, own, replacement, registry.stat())
            self.assertEqual(registry.read_text(), original)

    def test_console_registration_preserves_exact_authority_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = pathlib.Path(directory) / 'registry.json'
            own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
            registry.write_text(json.dumps({'version': 1, 'identities': [own]}))
            registry.chmod(0o400)
            certificate = pathlib.Path(directory) / 'console.crt'
            certificate.write_text('synthetic leaf')
            with mock.patch.object(REGISTER, 'certificate_fingerprint', return_value=('b' * 64, '2099-01-01T00:00:00Z')):
                REGISTER.register(registry, certificate)
                original = registry.read_bytes()
                REGISTER.register(registry, certificate)
                self.assertEqual(registry.read_bytes(), original)
            self.assertIn(own, json.loads(original)['identities'])

    def test_console_registration_rejects_conflicting_certificate_or_authority(self):
        for altered in ('certificate', 'authority', 'foreign-fingerprint'):
            with self.subTest(altered=altered), tempfile.TemporaryDirectory() as directory:
                registry = pathlib.Path(directory) / 'registry.json'
                principal = {'tenant_id': 'Hospital', 'alias': 'console-proxy', 'session_id': 'console-proxy',
                             'channel': 'console', 'roles': ['adapter'], 'permissions': ['read']}
                record = {'certificate_sha256': 'b' * 64, 'expires_at': '2099-01-01T00:00:00Z', 'principal': principal}
                if altered == 'certificate':
                    record['certificate_sha256'] = 'c' * 64
                elif altered == 'authority':
                    principal['permissions'] = ['control']
                else:
                    principal['alias'] = 'operador'
                registry.write_text(json.dumps({'version': 1, 'identities': [record]}))
                registry.chmod(0o400)
                original = registry.read_bytes()
                certificate = pathlib.Path(directory) / 'console.crt'
                certificate.write_text('synthetic leaf')
                with mock.patch.object(REGISTER, 'certificate_fingerprint', return_value=('b' * 64, '2099-01-01T00:00:00Z')), \
                        self.assertRaises((OSError, ValueError)):
                    REGISTER.register(registry, certificate)
                self.assertEqual(registry.read_bytes(), original)

    def test_registry_and_certificate_symlinks_fail_before_certificate_operations(self):
        for linked in ('registry', 'certificate'):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as directory:
                folder = pathlib.Path(directory)
                registry, certificate = folder / 'registry.json', folder / 'console.crt'
                registry.write_text(json.dumps({'version': 1, 'identities': []}))
                registry.chmod(0o400)
                certificate.write_text('synthetic leaf')
                target = folder / 'target'
                path = registry if linked == 'registry' else certificate
                path.rename(target)
                path.symlink_to(target)
                with mock.patch.object(REGISTER, 'certificate_fingerprint') as fingerprint, self.assertRaises((OSError, ValueError)):
                    REGISTER.register(registry, certificate)
                fingerprint.assert_not_called()

    def test_idempotent_registration_rejects_directory_change_during_certificate_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary)
            parent = base / 'identities'
            parent.mkdir(mode=0o700)
            registry = parent / 'registry.json'
            principal = {'tenant_id': 'Hospital', 'alias': 'console-proxy', 'session_id': 'console-proxy',
                         'channel': 'console', 'roles': ['adapter'], 'permissions': ['read']}
            record = {'certificate_sha256': 'c' * 64, 'expires_at': '2099-01-01T00:00:00Z', 'principal': principal}
            registry.write_text(json.dumps({'version': 1, 'identities': [record]}))
            registry.chmod(0o400)
            certificate = base / 'console.crt'
            certificate.write_text('synthetic leaf')
            replacement = json.dumps({'version': 1, 'identities': []})
            def fingerprint(_):
                parent.rename(base / 'original-identities')
                parent.mkdir(mode=0o700)
                registry.write_text(replacement)
                registry.chmod(0o400)
                return 'c' * 64, '2099-01-01T00:00:00Z'
            with mock.patch.object(REGISTER, 'certificate_fingerprint', side_effect=fingerprint), self.assertRaises(ValueError):
                REGISTER.register(registry, certificate)
            self.assertEqual(registry.read_text(), replacement)

    def directory_boundary(self, registration, change, waiting):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        foreign = {'principal': {'alias': 'operador'}, 'certificate_sha256': 'd' * 64}
        renewed = {**own, 'certificate_sha256': 'b' * 64}
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary)
            parent = base / 'identities'
            parent.mkdir(mode=0o700)
            registry = parent / 'registry.json'
            original = json.dumps({'version': 1, 'identities': [own, foreign]})
            registry.write_text(original)
            registry.chmod(0o400)
            certificate = base / 'console.crt'
            certificate.write_text('synthetic leaf')
            moved = base / 'original-identities'
            replacement = json.dumps({'version': 1, 'identities': [own, foreign, {'principal': {'alias': 'new-path'}}]})
            def change_directory():
                if change == 'mode':
                    parent.chmod(0o777)
                else:
                    parent.rename(moved)
                    fresh = base / 'fresh' if change == 'symlink' else parent
                    fresh.mkdir(mode=0o700)
                    (fresh / registry.name).write_text(replacement)
                    (fresh / registry.name).chmod(0o400)
                    if change == 'symlink':
                        parent.symlink_to(fresh, target_is_directory=True)
            def write():
                if registration:
                    REGISTER.register(registry, certificate)
                else:
                    MODULE.replace_owned_record(registry, own, renewed, registry.stat())
            real_flock, real_replace = fcntl.flock, os.replace
            entered = threading.Event()
            errors = []
            def observed_flock(fd, operation):
                entered.set()
                return real_flock(fd, operation)
            def change_before_replace(source, target, *args, **kwargs):
                if pathlib.Path(target).name == registry.name:
                    change_directory()
                return real_replace(source, target, *args, **kwargs)
            def worker():
                try:
                    write()
                except BaseException as error:
                    errors.append(error)
            with mock.patch.object(REGISTER, 'certificate_fingerprint', return_value=('c' * 64, '2099-01-01T00:00:00Z')):
                if waiting:
                    held = MODULE.RegistryLock(registry)
                    held.__enter__()
                    thread = threading.Thread(target=worker)
                    with mock.patch.object(fcntl, 'flock', side_effect=observed_flock):
                        thread.start()
                        try:
                            self.assertTrue(entered.wait(3))
                            change_directory()
                        finally:
                            held.__exit__()
                            thread.join(3)
                    self.assertFalse(thread.is_alive())
                else:
                    with mock.patch.object(os, 'replace', side_effect=change_before_replace):
                        worker()
            self.assertEqual(len(errors), 1, 'topology change must reject rather than announce success')
            self.assertIsInstance(errors[0], ValueError)
            if change == 'mode':
                parent.chmod(0o700)
                if waiting:
                    self.assertEqual(registry.read_text(), original)
            else:
                self.assertEqual(registry.read_text(), replacement, 'must never retarget the new pathname')
                old_document = json.loads((moved / registry.name).read_text())
                self.assertIn(foreign, old_document['identities'])
                if waiting:
                    self.assertEqual((moved / registry.name).read_text(), original)
            self.assertFalse(list(base.rglob('.registry-*.tmp')))

    def test_both_writers_reject_directory_rebinding_or_mode_change_during_lock_wait(self):
        for registration in (False, True):
            for change in ('rename', 'symlink', 'mode'):
                with self.subTest(registration=registration, change=change):
                    self.directory_boundary(registration, change, True)

    def test_both_writers_keep_replace_anchored_if_directory_changes_after_final_check(self):
        for registration in (False, True):
            for change in ('rename', 'symlink', 'mode'):
                with self.subTest(registration=registration, change=change):
                    self.directory_boundary(registration, change, False)

    def registry_race(self, registration_first):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        renewed = {**own, 'certificate_sha256': 'b' * 64}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'registry.json'
            path.write_text(json.dumps({'version': 1, 'identities': [own]}))
            path.chmod(0o400)
            certificate = pathlib.Path(directory) / 'console.crt'
            certificate.write_text('synthetic leaf')
            entered, release, finished = threading.Event(), threading.Event(), threading.Event()
            observations, errors = queue.Queue(), []
            original_replace, original_flock = os.replace, fcntl.flock
            second = None
            def observe_lock(fd, operation):
                if threading.current_thread() is second:
                    observations.put('lock_attempt')
                return original_flock(fd, operation)
            def pause_replace(source, target, *args, **kwargs):
                if threading.current_thread().name == 'first-writer' and pathlib.Path(target).name == path.name:
                    entered.set()
                    if not release.wait(3):
                        raise RuntimeError('registry race barrier timed out')
                return original_replace(source, target, *args, **kwargs)
            def update(registration):
                try:
                    if registration:
                        REGISTER.register(path, certificate)
                    else:
                        MODULE.replace_owned_record(path, own, renewed, path.stat())
                except Exception as error:
                    errors.append(error)
                finally:
                    if threading.current_thread() is second:
                        finished.set()
                        observations.put('completed')
            first = threading.Thread(target=update, args=(registration_first,), name='first-writer')
            second = threading.Thread(target=update, args=(not registration_first,), name='second-writer')
            with mock.patch.object(REGISTER, 'certificate_fingerprint', return_value=('c' * 64, '2099-01-01T00:00:00Z')), \
                    mock.patch.object(os, 'replace', side_effect=pause_replace), \
                    mock.patch.object(fcntl, 'flock', side_effect=observe_lock):
                first.start()
                try:
                    self.assertTrue(entered.wait(3))
                    second.start()
                    outcome = observations.get(timeout=3)
                    blocked = outcome == 'lock_attempt' and not finished.is_set()
                finally:
                    release.set()
                    first.join(3)
                    if second.ident is not None:
                        second.join(3)
                self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual(errors, [])
            records = json.loads(path.read_text())['identities']
            self.assertIn(renewed, records)
            self.assertEqual(len(records), 2)
            self.assertTrue(blocked, 'the second registry writer committed during the first replacement')
            self.assertEqual(path.stat().st_mode & 0o777, 0o400)

    def test_console_registration_waits_for_renewal_and_preserves_both_records(self):
        self.registry_race(False)

    def test_renewal_waits_for_console_registration_and_preserves_both_records(self):
        self.registry_race(True)


if __name__ == '__main__':
    unittest.main()
