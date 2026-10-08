from __future__ import annotations

import hashlib
import importlib
import json
import os
import pathlib
import pwd
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
SupervisorFence = importlib.import_module('fleet_adoption_probe_fence').SupervisorFence
recover_fence = importlib.import_module('fleet_adoption_probe_fence').recover_fence
ProbeFailure = importlib.import_module('fleet_adoption_probe_policy').ProbeFailure
IMAGE = os.environ.get('CAUCE_LEGACY_DOCKER_IMAGE', 'specorganon-codex:0.2.0rc3.dev12')


@unittest.skipUnless(os.environ.get('CAUCE_LEGACY_DOCKER_TEST') == '1', 'isolated Docker fixture is opt-in')
class DockerPhysicalFenceTests(unittest.TestCase):
    def docker(self, *arguments, input=None):
        result = subprocess.run(['docker', *arguments], input=input, check=False, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            self.fail(result.stderr)
        return result.stdout.strip()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-docker-fence-')
        self.root = pathlib.Path(self.temporary.name)
        self.policy = self.root / 'policy.json'
        self.container = None
        self.wrapper = None
        self.fence = None
        self.addCleanup(self.cleanup)
        setup = 'set -e; getent passwd 1000 >/dev/null 2>&1 || useradd --uid 1000 --no-create-home --home-dir /home/node node; mkdir -p /lifecycle /bundle /run/cauce-fence/control /home/node/state; cp /source/*.py /lifecycle/; chown -R 1000:1000 /home/node/state; chmod 700 /run/cauce-fence /run/cauce-fence/control /home/node/state; ln -sf /usr/local/bin/node /usr/bin/node; printf "setInterval(() => {}, 1000);\\n" > /bundle/adapter.js; exec sleep infinity'
        self.container = self.docker('run', '-d', '--user', '0', '--network', 'none', '--mount', f'type=bind,src={OPS / "container-runtime"},dst=/source,readonly',
            '--entrypoint', '/bin/sh', IMAGE, '-c', setup)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            ready = subprocess.run(['docker', 'exec', self.container, '/bin/test', '-f', '/bundle/adapter.js'], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.05)
        else:
            logs = subprocess.run(['docker', 'logs', self.container], capture_output=True, text=True)
            self.fail(logs.stderr + logs.stdout)
        inspect = json.loads(self.docker('inspect', self.container))[0]
        image = inspect['Image']
        started = inspect['State']['StartedAt']
        restart = inspect['RestartCount']
        init = self.docker('exec', self.container, '/usr/bin/python3', '-c', "import pathlib;raw=pathlib.Path('/proc/1/stat').read_text();print(raw[raw.rfind(')')+2:].split()[19])")
        generation = hashlib.sha256((f'{self.container}\0{started}\0{restart}\0{init}\0').encode()).hexdigest()
        bundle = self.docker('exec', self.container, '/usr/bin/python3', '/lifecycle/cauce-container-runtime.py', 'bundle-digest', '/bundle')
        runtime_user = self.docker('exec', self.container, '/usr/bin/python3', '-c', 'import pwd;print(pwd.getpwuid(1000).pw_name)')
        node_hash = self.docker('exec', self.container, '/usr/bin/sha256sum', '/usr/local/bin/node').split()[0]
        adapter_hash = self.docker('exec', self.container, '/usr/bin/sha256sum', '/bundle/adapter.js').split()[0]
        environment = ['HOME=/home/node', 'CAUCE_ALIAS=iza', 'CAUCE_RUNTIME_KEY=iza', 'CAUCE_TENANT_ID=acme',
            'CAUCE_STATE_DIR=/home/node/state', 'CAUCE_CONTROL_DIR=/run/cauce-fence/control',
            f'CAUCE_CONTAINER_ID={self.container}', f'CAUCE_CONTAINER_GENERATION={generation}', 'CAUCE_ADOPTION_LIFECYCLE_FENCE=1']
        command = ['docker', 'exec', '-i', '--user', '0', self.container, '/usr/bin/env', '-i', *environment,
            '/usr/bin/python3', '/lifecycle/cauce-container-runtime.py', 'run', '--alias', 'iza', '--wire-alias', 'iza', '--tenant', 'acme',
            '--state', '/home/node/state', '--control-dir', '/run/cauce-fence/control', '--container-id', self.container,
            '--generation', generation, '--runtime-uid', '1000', '--runtime-gid', '1000', '--bundle', '/bundle', '--bundle-digest', bundle,
            '/usr/local/bin/node', '/bundle/adapter.js']
        executable = self.root / 'supervisor'
        executable.write_text('#!/bin/sh\nexec ' + shlex.join(command) + '\n')
        executable.chmod(0o700)
        pins = {f'/lifecycle/{name}': hashlib.sha256((OPS / 'container-runtime' / name).read_bytes()).hexdigest() for name in
            ['cauce_container_base.py', 'cauce_container_proc.py', 'cauce_container_tree.py', 'cauce_container_adoption.py', 'cauce-container-runtime.py']}
        self.row = {'target': {'tenant_id': 'acme', 'alias': 'iza'}, 'runtime_key': 'iza', 'harness_id': 'codex',
            'placement': {'host_id': 'local', 'mode': 'container', 'container_name': inspect['Name'].lstrip('/'), 'runtime_user': runtime_user,
                'home_directory': '/home/node', 'state_directory': '/home/node/state', 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name},
            'supervisor': {'socket': str(self.root / 'wrapper.sock'), 'command': str(executable), 'command_sha256': hashlib.sha256(executable.read_bytes()).hexdigest()},
            'observation': {'transport': 'docker', 'container_id': self.container, 'container_image': image,
                'control_directory': '/run/cauce-fence/control', 'lifecycle_directory': '/lifecycle', 'pins': pins,
                'bundle_directory': '/bundle', 'bundle_digest': bundle, 'node_command': '/usr/bin/node', 'node_sha256': node_hash,
                'provider_command': '/usr/bin/node', 'provider_sha256': node_hash, 'adapter_entry': '/bundle/adapter.js', 'adapter_sha256': adapter_hash}, 'account': None}
        policy = self.policy
        policy.write_text(json.dumps({'schemaVersion': 1, 'host_id': 'local', 'targets': [self.row]}))
        policy.chmod(0o600)
        locks = self.root / 'locks'
        locks.mkdir(mode=0o700)
        self.wrapper = subprocess.Popen([sys.executable, '-B', str(OPS / 'scripts/alias-lock-exec.py'), 'run', '--lock-root', str(locks),
            '--alias', 'iza', '--', str(executable), 'start', 'iza'], env=dict(os.environ, CAUCE_ADOPTION_PROBE_POLICY_FILE=str(policy)),
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = subprocess.run(['docker', 'exec', self.container, '/bin/test', '-S', '/run/cauce-fence/control/cauce-v3-adoption.sock'], capture_output=True)
            if result.returncode == 0:
                break
            if self.wrapper.poll() is not None:
                self.fail(self.wrapper.stderr.read())
            time.sleep(0.05)
        else:
            self.fail('container lifecycle never became ready')
        self.fence = SupervisorFence(self.row)
        self.receipt = json.loads(self.docker('exec', self.container, '/bin/cat', '/run/cauce-fence/control/cauce-v3-adapter.json'))

    def cleanup(self):
        if self.fence:
            self.fence.close()
        if self.container:
            subprocess.run(['docker', 'rm', '-f', self.container], capture_output=True, timeout=15)
        if self.wrapper:
            self.wrapper.terminate()
            try:
                self.wrapper.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.wrapper.kill()
                self.wrapper.wait(timeout=5)
            self.wrapper.stderr.close()
        self.temporary.cleanup()

    def test_root_lifecycle_retainer_with_unprivileged_host_wrapper(self):
        self.assertNotEqual(os.geteuid(), 0)
        self.assertEqual(self.receipt['runtimeUid'], 1000)
        self.assertEqual(self.docker('exec', self.container, '/usr/bin/stat', '-c', '%u:%a', '/run/cauce-fence/control/cauce-v3-adoption.sock'), '0:600')
        self.fence.acquire()
        facts = self.fence.measure()
        self.assertTrue(facts['supervisor_fenced'])
        self.assertEqual(facts['primary_account_id'], None)
        self.assertEqual(len(self.fence.descriptors), 2)
        self.assertIsNotNone(self.fence.docker_retainer)
        self.fence.assert_held()
        result = subprocess.run(['docker', 'exec', '--user', '0', self.container, '/usr/bin/python3', '/lifecycle/cauce-container-runtime.py', 'stop',
            '--alias', 'iza', '--state', '/home/node/state', '--control-dir', '/run/cauce-fence/control', '--container-id', self.container,
            '--generation', self.receipt['containerGeneration']], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('adoption holds the lifecycle fence', result.stderr)
        self.fence.assert_held()
        self.fence.close()

    def test_probe_crash_retains_root_guard_until_private_nonce_recovery(self):
        nonce = 'a' * 64
        probe = subprocess.Popen([sys.executable, '-B', str(OPS / 'cli/fleet-adoption-probe.py'), 'probe', '--policy', str(self.policy)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            probe.stdin.write(json.dumps({'id': 0, 'action': 'acquire', 'targets': [self.row['target']], 'session_nonce': nonce}) + '\n')
            probe.stdin.flush()
            self.assertTrue(json.loads(probe.stdout.readline())['ok'])
            probe.kill()
            probe.wait(timeout=3)
            time.sleep(0.2)
            result = subprocess.run(['docker', 'exec', '--user', '0', self.container, '/usr/bin/python3', '-c',
                'import os,fcntl;fd=os.open("/run/cauce-fence/control/cauce-v3-adoption.guard",os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            with self.assertRaises(ProbeFailure):
                recover_fence(self.row, 'b' * 64)
            recover_fence(self.row, nonce)
            self.fence.acquire()
            self.fence.assert_held()
        finally:
            probe.stdin.close()
            probe.stdout.close()
            if probe.poll() is None:
                probe.kill()
                probe.wait(timeout=3)

    def test_controller_crash_keeps_internal_root_guard_until_release(self):
        self.fence.acquire()
        self.docker('exec', '--user', '0', self.container, '/usr/bin/python3', '-c',
            'import os,signal;fd=os.pidfd_open(int(__import__("sys").argv[1]));signal.pidfd_send_signal(fd,signal.SIGKILL)', str(self.receipt['controllerPid']))
        result = subprocess.run(['docker', 'exec', '--user', '0', self.container, '/usr/bin/python3', '-c',
            'import os,fcntl;fd=os.open("/run/cauce-fence/control/cauce-v3-adoption.guard",os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        with self.assertRaises((ProbeFailure, OSError)):
            self.fence.assert_held()
        after_failed_assert = subprocess.run(['docker', 'exec', '--user', '0', self.container, '/usr/bin/python3', '-c',
            'import os,fcntl;fd=os.open("/run/cauce-fence/control/cauce-v3-adoption.guard",os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)'], capture_output=True)
        self.assertNotEqual(after_failed_assert.returncode, 0)
        self.fence.close()
        self.docker('exec', '--user', '0', self.container, '/usr/bin/python3', '-c',
            'import os,fcntl;fd=os.open("/run/cauce-fence/control/cauce-v3-adoption.guard",os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)')


if __name__ == '__main__':
    unittest.main()
