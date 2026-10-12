from __future__ import annotations

import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures  # noqa: E402
import test_fleet_executor_container as container_fixtures  # noqa: E402

DOCKER = '/usr/bin/docker'
CHECKPOINT = pathlib.Path(__file__).with_name('failure-drill-executor-checkpoint.py')


class ExecutorInterruptionDrill(unittest.TestCase):
    run_step = fixtures.PhysicalExecutorTest.run_step
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer
    configure_container = container_fixtures.DisposableContainerExecutorTest.configure_container
    setUpClass = classmethod(container_fixtures.DisposableContainerExecutorTest.setUpClass.__func__)

    def setUp(self):
        fixtures.PhysicalExecutorTest.setUp(self)
        self.addCleanup(self.temporary.cleanup)
        self.configure_container()
        old_name = self.container
        self.container = 'zz-canary-drill-executor-' + uuid.uuid4().hex[:12]
        self.policy['containers'][self.container] = self.policy['containers'].pop(old_name)
        self.policy['host_id'] = self.container
        self.agent.update(container_name=self.container, runtime_key=self.container,
                          host_id=self.container, state_directory='/tmp/cauce-state/' + self.container)
        parameters = self.context['request']['parameters']
        parameters['runtime_key'] = self.container
        parameters['placement'].update(container_name=self.container, host_id=self.container,
                                       state_directory=self.agent['state_directory'])
        self.configure_signer()
        self.save_policy()
        self.addCleanup(self.cleanup_owned_resources)
        self.baseline = self.resources('before')
        self.assertEqual(self.baseline, {'containers': [], 'volumes': []})

    def docker(self, *arguments):
        result = subprocess.run([DOCKER, *arguments], capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def resources(self, phase):
        selected = 'label=cauce.fleet.runtime_key=' + self.container
        rows = {'containers': self.docker('ps', '-aq', '--filter', selected).split(),
                'volumes': self.docker('volume', 'ls', '-q', '--filter', selected).split()}
        print('EXECUTOR_DRILL_RESOURCES ' + json.dumps({'phase': phase, 'runtime_key': self.container,
            'containers': len(rows['containers']), 'volumes': len(rows['volumes'])}), flush=True)
        return rows

    def inspect(self):
        return json.loads(self.docker('inspect', self.container))[0]

    def metadata(self):
        return json.loads(self.docker('exec', self.container, '/bin/cat',
            '/run/cauce-fleet/' + self.container + '/cauce-v3-adapter.json'))

    def journal(self):
        return json.loads((self.roots['state'] / 'operations' / self.context['operation_id'] / 'effects.json').read_text())

    def cleanup_owned_resources(self):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_container import discard_operation
        from fleet_executor_policy import load_policy
        discard_operation(load_policy(self.policy_file), self.agent, self.context['operation_id'])
        self.assertEqual(self.resources('cleanup'), {'containers': [], 'volumes': []})

    def interrupted_executor(self):
        checkpoint = self.root / 'checkpoint.json'
        process = subprocess.Popen([sys.executable, str(CHECKPOINT), str(fixtures.CLI), str(checkpoint),
            '--policy', str(self.policy_file), '--step', 'runtime'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            process.stdin.write(json.dumps(self.context))
            process.stdin.close()
            process.stdin = None
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    _stdout, stderr = process.communicate(timeout=5)
                    self.fail('executor exited before Docker create/start boundary: ' + stderr)
                if checkpoint.exists():
                    status = pathlib.Path(f'/proc/{process.pid}/status').read_text()
                    if any(line.startswith('State:\tT') for line in status.splitlines()):
                        break
                time.sleep(0.02)
            else:
                self.fail('executor did not stop at the real Docker create/start boundary')
            receipt = json.loads(checkpoint.read_text())
            self.assertEqual(receipt['executor_pid'], process.pid)
            self.assertEqual(receipt['status'], 'created')
            print('EXECUTOR_DRILL_CHECKPOINT ' + json.dumps(receipt), flush=True)
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=10)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            return receipt
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=10)

    def test_killed_executor_recovers_same_container_and_single_runtime_then_cleans(self):
        for step in ('artifacts', 'credentials'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, step + ': ' + result.stderr)
        checkpoint = self.interrupted_executor()
        interrupted = self.inspect()
        self.assertEqual(interrupted['Id'], checkpoint['container_id'])
        self.assertEqual(interrupted['State']['Status'], 'created')
        self.assertFalse(interrupted['State']['Running'])
        self.assertEqual(interrupted['State']['Pid'], 0)
        self.assertNotIn('runtime', self.journal())
        owned = self.resources('interrupted')
        self.assertEqual(len(owned['containers']), 1)
        self.assertEqual(owned['volumes'], [self.container + '-state'])
        expected_labels = {'cauce.fleet.runtime_key': self.container, 'cauce.fleet.tenant': self.agent['tenant_id'],
            'cauce.fleet.alias': self.agent['alias'], 'cauce.fleet.host': self.container,
            'cauce.fleet.owner': self.user, 'cauce.fleet.operation': self.context['operation_id']}
        for labels in (interrupted['Config']['Labels'],
                       json.loads(self.docker('volume', 'inspect', owned['volumes'][0]))[0]['Labels']):
            self.assertEqual({key: labels.get(key) for key in expected_labels}, expected_labels)
        resumed = self.run_step('runtime', timeout=50)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        evidence = json.loads(resumed.stdout)['evidence']
        self.assertEqual(self.journal()['runtime'], evidence['runtime_digest'])
        running = self.inspect()
        self.assertEqual(running['Id'], interrupted['Id'])
        self.assertTrue(running['State']['Running'])
        self.assertEqual(self.resources('resumed'), owned)
        metadata = self.metadata()
        self.assertEqual(metadata['runtimeUid'], 65534)
        self.assertEqual(metadata['alias'], self.container)
        self.assertEqual(metadata['tenantId'], self.agent['tenant_id'])
        replay = self.run_step('runtime', timeout=50)
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(json.loads(replay.stdout)['evidence'], evidence)
        self.assertEqual(self.metadata()['pid'], metadata['pid'])
        self.assertEqual(self.inspect()['Id'], interrupted['Id'])
        self.assertEqual(self.resources('replayed'), owned)
        stopped = self.run_step('stop', timeout=40)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertIs(json.loads(stopped.stdout)['evidence']['stopped_verified'], True)
        gone = subprocess.run([DOCKER, 'exec', self.container, 'test', '-e', '/proc/' + str(metadata['pid'])],
                              capture_output=True, timeout=40)
        self.assertNotEqual(gone.returncode, 0)
        print('EXECUTOR_DRILL_OUTCOME ' + json.dumps({'physical_effect': 'succeeded',
            'operation_id': self.context['operation_id'], 'same_container': True,
            'same_runtime_pid_after_replay': True, 'stopped_verified': True, 'durable_operation_status': 'not_exercised'}), flush=True)


if __name__ == '__main__':
    unittest.main()
