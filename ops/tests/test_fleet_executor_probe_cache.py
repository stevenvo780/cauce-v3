from __future__ import annotations

import copy
import importlib
import json
import multiprocessing
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_probe_cache as cache  # noqa: E402


def simultaneous_probe(root, key, counter, ready, results):
    def probe():
        with open(counter, 'a', encoding='utf-8') as stream:
            stream.write('probe\n')
        time.sleep(0.15)
        return True

    try:
        ready.wait(timeout=10)
        results.put(cache.cached_probe(root, key, probe, now=100))
    except Exception as error:
        results.put(type(error).__name__)


class ProbeKeyTest(unittest.TestCase):
    def setUp(self):
        self.row = {'provider': 'grok', 'command': '/usr/bin/grok',
                    'command_sha256': 'a' * 64, 'runtime_mode': 'container',
                    'runtime_user': 'dev', 'login': {'sha256': 'b' * 64, 'method': 'terminal'}}
        self.placement = {'image': 'sha256:' + 'c' * 64, 'runtime_user': 'dev',
                          'python': '/usr/bin/python3', 'profile_root': '/profiles'}

    def key(self, row=None, placement=None, harness='grok', code='d' * 64):
        return cache.probe_key(self.row if row is None else row,
                               self.placement if placement is None else placement, harness, code)

    def test_key_is_a_canonical_digest_and_ignores_unrelated_placement_fields(self):
        reordered = dict(reversed(list(self.row.items())))
        reordered['login'] = dict(reversed(list(self.row['login'].items())))
        placement = dict(reversed(list(self.placement.items())), state_root='/elsewhere')
        placement['profile_root'] = '/another-profile'
        self.assertRegex(self.key(), r'^[0-9a-f]{64}$')
        self.assertEqual(self.key(), self.key(row=reordered, placement=placement))

    def test_every_probe_input_invalidates_the_key(self):
        original = self.key()
        mutations = [('command_sha256', 'e' * 64), ('runtime_mode', 'native'),
                     ('runtime_user', 'other'), ('command', '/opt/grok')]
        for name, value in mutations:
            with self.subTest(row=name):
                self.assertNotEqual(original, self.key(row=dict(self.row, **{name: value})))
        nested = copy.deepcopy(self.row)
        nested['login']['method'] = 'device'
        self.assertNotEqual(original, self.key(row=nested))
        for name, value in [('image', 'sha256:' + 'f' * 64), ('runtime_user', 'other'),
                            ('python', '/opt/python3')]:
            with self.subTest(placement=name):
                self.assertNotEqual(original, self.key(placement=dict(self.placement, **{name: value})))
        self.assertNotEqual(original, self.key(harness='muse'))
        self.assertNotEqual(original, self.key(code='e' * 64))

    def test_native_key_binds_the_python_interpreter_and_execution_mode(self):
        native = cache.probe_key(self.row, None, 'grok', 'd' * 64)
        self.assertNotEqual(native, self.key())
        with patch.object(cache.sys, 'executable', '/another/python3'):
            self.assertNotEqual(native, cache.probe_key(self.row, None, 'grok', 'd' * 64))

    def test_executor_code_digest_is_stable_and_has_sha256_shape(self):
        digest = cache.executor_code_sha256()
        self.assertRegex(digest, r'^[0-9a-f]{64}$')
        self.assertEqual(digest, cache.executor_code_sha256())

    def test_executor_digest_changes_for_each_import_source_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for directory in ('cli', 'scripts', 'container-runtime'):
                (root / directory).mkdir()
                (root / directory / 'helper.py').write_text('original', encoding='utf-8')
            with patch.object(cache, '__file__', str(root / 'cli/fleet_executor_probe_cache.py')):
                previous = cache.executor_code_sha256()
                for directory in ('cli', 'scripts', 'container-runtime'):
                    with self.subTest(directory=directory):
                        (root / directory / 'helper.py').write_text('changed', encoding='utf-8')
                        digest = cache.executor_code_sha256()
                        self.assertNotEqual(previous, digest)
                        previous = digest


class ProbeCacheTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.key = 'a' * 64
        self.directory = self.root / 'provider-probes'
        self.entry = self.directory / (self.key + '.json')
        self.lock = self.directory / (self.key + '.lock')

    def seed(self, result=True):
        self.assertEqual(cache.cached_probe(self.root, self.key, lambda: result, now=100), result)

    def write_entry(self, value):
        self.entry.write_text(json.dumps(value), encoding='utf-8')
        self.entry.chmod(0o600)

    def assert_replaced(self):
        probe = Mock(return_value=False)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=102), False)
        probe.assert_called_once_with()
        self.assertEqual(json.loads(self.entry.read_text()),
                         {'key': self.key, 'created_at': 101, 'result': False})
        self.assertEqual(stat.S_IMODE(self.entry.stat().st_mode), 0o600)

    def test_success_creates_private_files_and_is_reused(self):
        probe = Mock(return_value=True)
        self.assertIs(cache.cached_probe(str(self.root), self.key, probe, now=100), True)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), True)
        probe.assert_called_once_with()
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.entry.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.lock.stat().st_mode), 0o600)

    def test_false_is_a_definitive_cached_result(self):
        self.seed(False)
        probe = Mock(side_effect=AssertionError('unexpected repeated probe'))
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
        probe.assert_not_called()

    def test_ttl_reuses_until_the_exact_boundary(self):
        self.seed()
        probe = Mock(return_value=False)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=100 + 86400 - 0.1), True)
        probe.assert_not_called()
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=100 + 86400), False)
        probe.assert_called_once_with()

    def test_custom_ttl_is_respected(self):
        self.seed()
        probe = Mock(return_value=False)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=105, ttl=5), False)
        probe.assert_called_once_with()

    def test_future_timestamp_is_invalid(self):
        self.seed()
        self.write_entry({'key': self.key, 'created_at': 1000, 'result': True})
        self.assert_replaced()

    def test_corrupt_json_is_replaced(self):
        self.seed()
        self.entry.write_text('{broken', encoding='utf-8')
        self.assert_replaced()

    def test_malformed_schema_never_reuses_an_entry(self):
        self.seed()
        malformed = [None, [], {}, {'key': self.key, 'created_at': 100},
                     {'key': 'b' * 64, 'created_at': 100, 'result': True},
                     {'key': self.key, 'created_at': '100', 'result': True},
                     {'key': self.key, 'created_at': True, 'result': True},
                     {'key': self.key, 'created_at': float('nan'), 'result': True},
                     {'key': self.key, 'created_at': float('inf'), 'result': True},
                     {'key': self.key, 'created_at': 100, 'result': 1},
                     {'key': self.key, 'created_at': 100, 'result': None}]
        for value in malformed:
            with self.subTest(value=value):
                self.write_entry(value)
                self.assert_replaced()

    def test_exception_and_timeout_do_not_create_a_negative_entry(self):
        for error in (ValueError('probe failed'), subprocess.TimeoutExpired(['probe'], 1)):
            with self.subTest(error=type(error).__name__):
                probe = Mock(side_effect=error)
                with self.assertRaises(type(error)):
                    cache.cached_probe(self.root, self.key, probe, now=100)
                self.assertFalse(self.entry.exists())
                probe.assert_called_once_with()
        self.seed()

    def test_non_boolean_result_is_returned_without_caching(self):
        for value in (None, 0, 1, 'true', {}):
            with self.subTest(value=value):
                self.assertEqual(cache.cached_probe(self.root, self.key, lambda value=value: value, now=100), value)
                self.assertFalse(self.entry.exists())

    def test_unsafe_entry_permissions_are_replaced(self):
        self.seed()
        self.entry.chmod(0o644)
        self.assert_replaced()

    def test_entry_owned_by_another_user_is_replaced(self):
        self.seed()
        real_fstat = os.fstat

        def foreign_owner(fd):
            value = real_fstat(fd)
            if pathlib.Path(os.readlink('/proc/self/fd/' + str(fd))) == self.entry:
                fields = list(value)
                fields[4] = os.geteuid() + 1
                return os.stat_result(fields)
            return value

        with patch.object(cache.os, 'fstat', side_effect=foreign_owner):
            probe = Mock(return_value=False)
            self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
            probe.assert_called_once_with()
        probe.reset_mock()
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=102), False)
        probe.assert_not_called()
        self.assertEqual(stat.S_IMODE(self.entry.stat().st_mode), 0o600)

    def test_entry_symlink_is_replaced_without_modifying_its_target(self):
        self.seed()
        target = self.root / 'other-file'
        target.write_text('untouched', encoding='utf-8')
        self.entry.unlink()
        self.entry.symlink_to(target)
        self.assert_replaced()
        self.assertEqual(target.read_text(), 'untouched')

    def test_unsafe_directory_or_lock_bypasses_cache(self):
        self.seed()
        for path in (self.directory, self.lock):
            with self.subTest(path=path.name):
                original = json.loads(self.entry.read_text())
                path.chmod(0o777 if path.is_dir() else 0o644)
                probe = Mock(return_value=False)
                self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
                self.assertIs(cache.cached_probe(self.root, self.key, probe, now=102), False)
                self.assertEqual(probe.call_count, 2)
                self.assertEqual(json.loads(self.entry.read_text()), original)
                path.chmod(0o700 if path.is_dir() else 0o600)

    def test_lock_symlink_bypasses_cache_without_modifying_its_target(self):
        self.seed()
        target = self.root / 'other-lock'
        target.write_text('untouched', encoding='utf-8')
        self.lock.unlink()
        self.lock.symlink_to(target)
        probe = Mock(return_value=False)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
        self.assertEqual(target.read_text(), 'untouched')
        self.assertEqual(json.loads(self.entry.read_text())['result'], True)

    def test_foreign_directory_or_lock_owner_bypasses_cache(self):
        self.seed()
        real_fstat = os.fstat
        for path in (self.directory, self.lock):
            with self.subTest(path=path.name):
                def foreign_owner(fd, path=path):
                    value = real_fstat(fd)
                    if pathlib.Path(os.readlink('/proc/self/fd/' + str(fd))) == path:
                        fields = list(value)
                        fields[4] = os.geteuid() + 1
                        return os.stat_result(fields)
                    return value

                probe = Mock(return_value=False)
                with patch.object(cache.os, 'fstat', side_effect=foreign_owner):
                    self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
                    self.assertIs(cache.cached_probe(self.root, self.key, probe, now=102), False)
                self.assertEqual(probe.call_count, 2)
                self.assertEqual(json.loads(self.entry.read_text())['result'], True)

    def test_directory_symlink_bypasses_cache(self):
        self.seed()
        target = self.root / 'other-directory'
        self.directory.rename(target)
        self.directory.symlink_to(target, target_is_directory=True)
        probe = Mock(return_value=False)
        self.assertIs(cache.cached_probe(self.root, self.key, probe, now=101), False)
        probe.assert_called_once_with()
        self.assertEqual(json.loads(self.entry.read_text())['result'], True)

    def test_entry_is_replaced_only_after_a_complete_private_staged_write(self):
        self.seed()
        real_replace = os.replace
        observed = []

        def replace(source, target, **kwargs):
            descriptor = os.open(source, os.O_RDONLY, dir_fd=kwargs['src_dir_fd'])
            with os.fdopen(descriptor, 'r', encoding='utf-8') as stream:
                staged = json.load(stream)
                mode = stat.S_IMODE(os.fstat(stream.fileno()).st_mode)
            observed.append((staged, mode, json.loads(self.entry.read_text())['result']))
            real_replace(source, target, **kwargs)

        with patch.object(cache.os, 'replace', side_effect=replace):
            self.assertIs(cache.cached_probe(self.root, self.key, lambda: False, now=101, ttl=1), False)
        self.assertEqual(observed, [({'key': self.key, 'created_at': 101, 'result': False}, 0o600, True)])
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()),
                         [self.key + '.json', self.key + '.lock'])

    def test_failed_replace_preserves_existing_entry_and_cleans_the_staged_file(self):
        self.seed()
        previous = self.entry.read_bytes()
        with patch.object(cache.os, 'replace', side_effect=OSError('cannot replace')):
            self.assertIs(cache.cached_probe(self.root, self.key, lambda: False, now=101, ttl=1), False)
        self.assertEqual(self.entry.read_bytes(), previous)
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()),
                         [self.key + '.json', self.key + '.lock'])

    def test_two_processes_share_the_first_probe_under_the_same_lock(self):
        context = multiprocessing.get_context('fork')
        results = context.Queue()
        self.addCleanup(results.close)
        counter = self.root / 'probe-count'
        ready = context.Barrier(2)
        processes = [context.Process(target=simultaneous_probe,
            args=(self.root, self.key, counter, ready, results)) for _ in range(2)]
        try:
            for process in processes:
                process.start()
            for process in processes:
                process.join(timeout=15)
            self.assertEqual([process.exitcode for process in processes], [0, 0])
            self.assertEqual([results.get(timeout=2) for _ in processes], [True, True])
            self.assertEqual(counter.read_text().splitlines(), ['probe'])
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=2)


class ProviderCacheIntegrationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.key = 'a' * 64
        self.row = {'provider': 'grok', 'runtime_user': 'dev',
                    'openclaw': {'node_command': '/usr/bin/node'}}
        self.placement = {'image': 'sha256:' + 'c' * 64, 'runtime_user': 'dev', 'python': '/usr/bin/python3'}
        self.helper = importlib.import_module('fleet_provider_capability_probe')

    def container_probe(self):
        return self.helper.container_probe(self.row, self.placement, 'grok', tmpfs_size='64m')

    def docker_result(self, outcome):
        def run(command, **_kwargs):
            if command[1] == 'run':
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            return subprocess.CompletedProcess(command, 0, b'', b'')
        return run

    def test_native_providers_propagate_transient_errors_only_in_strict_mode(self):
        identity = importlib.import_module('fleet_provider_identity')
        for harness in ('grok', 'muse', 'openclaw'):
            module = importlib.import_module('fleet_provider_' + harness)
            for error in (ValueError('probe failed'), subprocess.TimeoutExpired(['provider'], 1)):
                with self.subTest(harness=harness, error=type(error).__name__), ExitStack() as stack:
                    stack.enter_context(patch.object(identity, 'provider_command', return_value='/fixture/provider'))
                    output = stack.enter_context(patch.object(identity, 'command_output', side_effect=error))
                    if harness == 'openclaw':
                        stack.enter_context(patch.object(module, 'prepare_temporary'))
                        stack.enter_context(patch.object(module, 'pinned_packet', side_effect=lambda packet: packet))
                    else:
                        stack.enter_context(patch.object(module, 'direct_login', return_value=True))
                    with self.assertRaises(type(error)) as raised:
                        module.measured_definition(self.row, strict=True)
                    self.assertIs(raised.exception, error)
                    self.assertIs(module.measured_definition(self.row), False)
                    self.assertEqual(output.call_count, 2)

    def test_container_definitive_true_and_false_verdicts_are_cached(self):
        for value, key in ((True, self.key), (False, 'b' * 64)):
            outcome = subprocess.CompletedProcess(['docker'], 0,
                b'cauce-probe:true\n' if value else b'cauce-probe:false\n', b'')
            with self.subTest(value=value), patch.object(self.helper.subprocess, 'run',
                    side_effect=self.docker_result(outcome)) as run:
                self.assertIs(cache.cached_probe(self.root, key, self.container_probe, now=100), value)
                self.assertIs(cache.cached_probe(self.root, key, self.container_probe, now=101), value)
                self.assertEqual([item.args[0][1] for item in run.call_args_list], ['run', 'rm'])

    def test_container_errors_and_missing_markers_are_never_cached(self):
        outcomes = [(subprocess.CompletedProcess(['docker'], code, b'cauce-probe:false\n', b''),
                     subprocess.CalledProcessError) for code in (1, 2, 125)]
        outcomes += [(subprocess.TimeoutExpired(['docker'], 40), subprocess.TimeoutExpired),
                     (subprocess.CompletedProcess(['docker'], 0, b'', b''), ValueError),
                     (subprocess.CompletedProcess(['docker'], 0, b'noise\ncauce-probe:true\n', b''), ValueError)]
        for outcome, error_type in outcomes:
            with self.subTest(outcome=outcome), patch.object(self.helper.subprocess, 'run',
                    side_effect=self.docker_result(outcome)) as run:
                for now in (100, 101):
                    with self.assertRaises(error_type):
                        cache.cached_probe(self.root, self.key, self.container_probe, now=now)
                    self.assertFalse((self.root / 'provider-probes' / (self.key + '.json')).exists())
                self.assertEqual([item.args[0][1] for item in run.call_args_list], ['run', 'rm', 'run', 'rm'])

    def test_measured_capability_retries_then_caches_and_invalidates_after_code_changes(self):
        module = importlib.import_module('fleet_provider_grok')
        policy = {'roots': {'state': str(self.root)}}
        for mode, placement in (('native', None), ('container', self.placement)):
            row = dict(self.row, runtime_mode=mode)
            method = 'measured_definition' if placement is None else 'measured_container_definition'
            expected = call(row, strict=True) if placement is None else call(row, placement, strict=True)
            with self.subTest(mode=mode), patch.object(module, method,
                    side_effect=[subprocess.TimeoutExpired(['provider'], 1), ValueError('probe failed'), True, False]) as probe:
                def measure(code='d' * 64, row=row, placement=placement):
                    return cache.measured_capability(policy, row, placement, 'grok', module, code)

                self.assertEqual([measure() for _ in range(4)], [False, False, True, True])
                self.assertEqual(probe.call_args_list, [expected] * 3)
                self.assertIs(measure(code='e' * 64), False)
                self.assertIs(measure(code='e' * 64), False)
                self.assertEqual(probe.call_args_list, [expected] * 4)


if __name__ == '__main__':
    unittest.main()
