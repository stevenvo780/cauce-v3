from __future__ import annotations

import fcntl
import hashlib
import importlib
import json
import os
import pathlib
import pwd
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
sys.path.insert(0, str(OPS / 'container-runtime'))
bundle_digest = importlib.import_module('cauce_container_base').bundle_digest
SupervisorFence = importlib.import_module('fleet_adoption_probe_fence').SupervisorFence
recover_fence = importlib.import_module('fleet_adoption_probe_fence').recover_fence
recover_custody = importlib.import_module('fleet_adoption_probe_lifecycle').recover_custody
ProbeFailure = importlib.import_module('fleet_adoption_probe_policy').ProbeFailure
load_policy = importlib.import_module('fleet_adoption_probe_policy').load_policy
packet = importlib.import_module('fleet_adoption_probe_supervisor').packet
receive = importlib.import_module('fleet_adoption_probe_supervisor').receive


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


class LegacySupervisorFenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-fence-')
        self.root = pathlib.Path(self.temporary.name)
        self.lock_root = self.root / 'locks'
        self.lock_root.mkdir(mode=0o700)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.state = self.home / 'state'
        self.state.mkdir(mode=0o700)
        self.control = self.root / 'control'
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir(mode=0o700)
        self.adapter = self.bundle / 'adapter.js'
        self.adapter.write_text('setInterval(() => {}, 1000);\n')
        self.command = self.root / 'native'
        self.command.write_text(f'#!/bin/sh\nexec {sys.executable} {OPS / "cli/fleet_adoption_probe_native.py"} "$@"\n')
        self.command.chmod(0o700)
        runtime = OPS / 'container-runtime'
        names = ['cauce_container_base.py', 'cauce_container_proc.py', 'cauce_container_tree.py',
                 'cauce_container_adoption.py', 'cauce-container-runtime.py']
        self.target = {'tenant_id': 'acme', 'alias': 'iza'}
        self.row = {'target': self.target, 'runtime_key': 'iza', 'harness_id': 'codex',
            'placement': {'host_id': 'local', 'mode': 'native', 'runtime_user': pwd.getpwuid(os.geteuid()).pw_name,
                'home_directory': str(self.home), 'state_directory': str(self.state), 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name},
            'supervisor': {'socket': str(self.root / 'supervisor.sock'), 'command': str(self.command), 'command_sha256': sha(self.command)},
            'observation': {'transport': 'local', 'control_directory': str(self.control), 'lifecycle_directory': str(runtime),
                'pins': {str(runtime / name): sha(runtime / name) for name in names}, 'bundle_directory': str(self.bundle),
                'bundle_digest': bundle_digest(str(self.bundle)), 'node_command': '/usr/bin/node', 'node_sha256': sha('/usr/bin/node'),
                'provider_command': '/usr/bin/node', 'provider_sha256': sha('/usr/bin/node'),
                'adapter_entry': str(self.adapter), 'adapter_sha256': sha(self.adapter)}, 'account': None}
        self.policy = self.root / 'policy.json'
        self.policy.write_text(json.dumps({'schemaVersion': 1, 'host_id': 'local', 'targets': [self.row]}))
        self.policy.chmod(0o600)
        self.environment = dict(os.environ, HOME=str(self.home), CAUCE_ADOPTION_PROBE_POLICY_FILE=str(self.policy), PYTHONDONTWRITEBYTECODE='1')
        self.wrapper = subprocess.Popen([sys.executable, str(OPS / 'scripts/alias-lock-exec.py'), 'run',
            '--lock-root', str(self.lock_root), '--alias', 'iza', '--', str(self.command), 'start', 'iza'],
            env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if self.wrapper.poll() is not None:
                self.fail(self.wrapper.stderr.read())
            receipt = self.control / 'cauce-v3-adapter.json'
            if receipt.exists() and json.loads(receipt.read_text()).get('phase') == 'running' \
                    and (self.control / 'cauce-v3-adoption.sock').exists():
                self.receipt = json.loads(receipt.read_text())
                break
            time.sleep(0.02)
        else:
            self.fail('physical runtime never became ready')
        self.fence = SupervisorFence(self.row)

    def tearDown(self):
        self.fence.close()
        self.wrapper.terminate()
        try:
            self.wrapper.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.wrapper.kill()
            self.wrapper.wait(timeout=5)
        self.wrapper.stderr.close()
        self.temporary.cleanup()

    def assert_locked(self, filename):
        fd = os.open(filename, os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def test_measured_unknown_account_and_real_four_lock_descriptors(self):
        self.fence.acquire()
        facts = self.fence.measure()
        self.assertEqual(facts['target'], self.target)
        self.assertEqual(facts['primary_account_id'], None)
        self.assertEqual(facts['account_provider'], None)
        self.assertFalse(facts['account_binding_approved'])
        self.assertEqual(len(self.fence.descriptors), 2)
        self.assertEqual(len(self.fence.lifecycle_descriptors), 2)
        for fd in [*self.fence.descriptors, *self.fence.lifecycle_descriptors]:
            self.assertIn('FLOCK', pathlib.Path(f'/proc/self/fdinfo/{fd}').read_text())
        self.assert_locked(self.control / 'cauce-v3-adoption.guard')
        self.assert_locked(self.control / 'cauce-v3-adapter.lock')
        with self.assertRaises(ValueError):
            recover_custody(self.row, 'b' * 64)
        self.assert_locked(self.control / 'cauce-v3-adoption.guard')
        self.fence.close()
        fd = os.open(self.control / 'cauce-v3-adoption.guard', os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def test_lowlevel_stop_cannot_bypass_adoption_guard(self):
        self.fence.acquire()
        helper = OPS / 'container-runtime/cauce-container-runtime.py'
        result = subprocess.run([sys.executable, str(helper), 'stop', '--alias', 'iza', '--state', str(self.state),
            '--control-dir', str(self.control), '--container-id', self.receipt['containerId'],
            '--generation', self.receipt['containerGeneration']], capture_output=True, text=True, env=self.environment)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('adoption holds the lifecycle fence', result.stderr)
        self.fence.assert_held()

    def test_controller_crash_preserves_both_physical_locks_until_release(self):
        self.fence.acquire()
        fd = os.pidfd_open(self.receipt['controllerPid'])
        try:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
        deadline = time.monotonic() + 3
        while pathlib.Path(f"/proc/{self.receipt['controllerPid']}").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assert_locked(self.control / 'cauce-v3-adapter.lock')
        self.assert_locked(self.control / 'cauce-v3-adoption.guard')
        with self.assertRaises((ProbeFailure, OSError)):
            self.fence.assert_held()
        self.fence.close()
        fd = os.pidfd_open(self.receipt['pid'])
        try:
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        finally:
            os.close(fd)

    def test_pending_exec_stop_waits_for_callback_release_and_blocks_new_adoption(self):
        self.fence.acquire()
        stop = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        stop.connect(self.row['supervisor']['socket'])
        packet(stop, {'action': 'control', 'target': self.target})
        stop.settimeout(0.15)
        with self.assertRaises(TimeoutError):
            receive(stop)
        self.fence.assert_held()
        self.fence.close()
        stop.settimeout(2)
        self.assertTrue(receive(stop)['ok'])
        other = SupervisorFence(self.row)
        try:
            with self.assertRaises(ProbeFailure):
                other.acquire()
        finally:
            other.close()
            stop.close()

    def test_wrapper_sigterm_defers_child_termination_until_release(self):
        self.fence.acquire()
        self.wrapper.terminate()
        time.sleep(0.15)
        self.assertIsNone(self.wrapper.poll())
        self.fence.assert_held()
        self.fence.close()
        self.wrapper.wait(timeout=5)

    def test_probe_process_crash_retains_guard_and_exec_stop_until_nonce_recovery(self):
        nonce = 'a' * 64
        stop = None
        probe = subprocess.Popen([sys.executable, '-B', str(OPS / 'cli/fleet-adoption-probe.py'), 'probe',
            '--policy', str(self.policy)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            probe.stdin.write(json.dumps({'id': 0, 'action': 'acquire', 'targets': [self.target], 'session_nonce': nonce}) + '\n')
            probe.stdin.flush()
            self.assertTrue(json.loads(probe.stdout.readline())['ok'])
            self.assert_locked(self.control / 'cauce-v3-adoption.guard')
            probe.kill()
            probe.wait(timeout=3)
            time.sleep(0.2)
            self.assert_locked(self.control / 'cauce-v3-adoption.guard')
            self.assert_locked(self.control / 'cauce-v3-adapter.lock')
            with self.assertRaises(ProbeFailure):
                recover_fence(self.row, 'b' * 64)
            stop = subprocess.Popen([sys.executable, '-B', str(OPS / 'cli/fleet-adoption-probe.py'), 'control',
                '--policy', str(self.policy), '--runtime-key', 'iza', '--', str(self.command), 'stop', 'iza'],
                env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.2)
            self.assertIsNone(stop.poll())
            self.assertTrue((self.control / 'cauce-v3-adapter.json').exists())
            recover_fence(self.row, nonce)
            self.assertEqual(stop.wait(timeout=5), 0)
            self.assertFalse((self.control / 'cauce-v3-adapter.json').exists())
        finally:
            probe.stdin.close()
            probe.stdout.close()
            if probe.poll() is None:
                probe.kill()
                probe.wait(timeout=3)
            if stop is not None and stop.poll() is None:
                stop.kill()
                stop.wait(timeout=3)

    def test_orphan_custody_survives_controller_crash_until_exact_recovery(self):
        self.fence.acquire()
        nonce = self.fence.session_nonce
        self.fence.abandon()
        descriptor = os.pidfd_open(self.receipt['controllerPid'])
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        finally:
            os.close(descriptor)
        time.sleep(0.15)
        self.assert_locked(self.control / 'cauce-v3-adapter.lock')
        self.assert_locked(self.control / 'cauce-v3-adoption.guard')
        recover_fence(self.row, nonce)
        descriptor = os.pidfd_open(self.receipt['pid'])
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        finally:
            os.close(descriptor)

    def test_guardian_crash_recovers_controller_orphan_and_allows_new_adoption(self):
        self.fence.acquire()
        nonce = self.fence.session_nonce
        guardian = self.fence.native_retainer.custody_pid
        os.kill(guardian, signal.SIGKILL)
        os.waitpid(guardian, 0)
        self.fence.abandon()
        time.sleep(0.15)
        self.assert_locked(self.control / 'cauce-v3-adoption.guard')
        recover_fence(self.row, nonce)
        recover_fence(self.row, nonce)
        self.fence = SupervisorFence(self.row)
        self.fence.acquire()
        self.fence.assert_held()

    def test_lowlevel_start_cannot_replace_crashed_controller_until_release(self):
        self.fence.acquire()
        descriptor = os.pidfd_open(self.receipt['controllerPid'])
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        finally:
            os.close(descriptor)
        helper = OPS / 'container-runtime/cauce-container-runtime.py'
        result = subprocess.run([sys.executable, str(helper), 'run', '--alias', 'iza', '--state', str(self.state),
            '--control-dir', str(self.control), '--container-id', self.receipt['containerId'],
            '--generation', self.receipt['containerGeneration'], '--runtime-uid', str(os.getuid()), '--runtime-gid', str(os.getgid()),
            '--bundle', str(self.bundle), '--bundle-digest', self.row['observation']['bundle_digest'], '/usr/bin/node', str(self.adapter)],
            capture_output=True, text=True, env=self.environment)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('adoption holds the lifecycle fence', result.stderr)
        self.assert_locked(self.control / 'cauce-v3-adapter.lock')
        self.fence.close()
        descriptor = os.pidfd_open(self.receipt['pid'])
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        finally:
            os.close(descriptor)

    def test_installer_renders_explicit_native_and_container_upgrades_without_installing(self):
        output = self.root / 'dropins'
        output.mkdir(mode=0o700)
        result = subprocess.run([sys.executable, str(OPS / 'cli/fleet-legacy-install.py'), '--policy', str(self.policy),
            '--lock-helper', str(OPS / 'scripts/alias-lock-exec.py'), '--probe', str(OPS / 'cli/fleet-adoption-probe.py'),
            '--lock-root', str(self.lock_root), '--output-directory', str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['unit'], 'cauce-v3-alias-iza.service')
        body = pathlib.Path(receipt['path']).read_text()
        self.assertIn('KillMode=process', body)
        self.assertIn('TimeoutStopSec=infinity', body)
        self.assertIn('CAUCE_ADOPTION_PROBE_POLICY_FILE=', body)
        self.assertIn('ExecStop=', body)
        self.assertEqual(sha(receipt['path']), receipt['dropin_sha256'])
        module = importlib.util.spec_from_file_location('installer', OPS / 'cli/fleet-legacy-install.py')
        installer = importlib.util.module_from_spec(module)
        module.loader.exec_module(installer)
        row = dict(self.row, placement=dict(self.row['placement'], mode='container', container_name='existing'))
        unit, _ = installer.render(row, str(self.policy), sys.executable, str(OPS / 'scripts/alias-lock-exec.py'),
            str(OPS / 'cli/fleet-adoption-probe.py'), str(self.lock_root))
        self.assertEqual(unit, 'cauce-v3-container-iza.service')

    def test_policy_symlink_and_changed_command_are_rejected(self):
        link = self.root / 'link.json'
        link.symlink_to(self.policy)
        with self.assertRaises(OSError):
            load_policy(str(link))
        self.command.write_text(self.command.read_text() + '\n')
        with self.assertRaises(ProbeFailure):
            self.fence.acquire()

    def test_baseline_without_cooperative_socket_fails_closed(self):
        self.row['supervisor']['socket'] = str(self.root / 'absent.sock')
        with self.assertRaises(OSError):
            self.fence.acquire()


if __name__ == '__main__':
    unittest.main()
