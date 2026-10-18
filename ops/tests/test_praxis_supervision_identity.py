import fcntl
import importlib.util
import json
import os
import pathlib
import queue
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

    def test_key_mismatch_prevents_registry_changes(self):
        with mock.patch.object(MODULE.subprocess, 'check_output', side_effect=[b'key-one', b'key-two']):
            with self.assertRaises(ValueError):
                MODULE.verify_owned_leaf(pathlib.Path('key'), pathlib.Path('cert'))

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

if __name__ == '__main__':
    unittest.main()
