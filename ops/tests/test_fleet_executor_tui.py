from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(OPS / 'cli'), str(OPS / 'container-runtime')]
import fleet_executor_container as container  # noqa: E402
import fleet_executor_container_tui as transport  # noqa: E402
import fleet_executor_tui as tui  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402


@unittest.skipUnless(shutil.which('tmux') and os.geteuid() != 0, 'real tmux requires a normal runtime user')
class CanonicalTuiShutdownTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='zz-canary-tui-shutdown-')
        self.state = pathlib.Path(self.temporary.name)
        self.workspace = self.state / 'space/projects'
        self.workspace.mkdir(parents=True, mode=0o700)
        self.directory = self.state / ('tmux-' + str(os.geteuid()))
        self.directory.mkdir(mode=0o700)
        self.socket = self.directory / 'cauce'
        self.sockets = {self.socket}
        self.names = set()
        command = '/usr/bin/sleep'
        self.request = {'action': 'observe', 'uid': os.geteuid(), 'gid': os.getegid(),
            'state_directory': str(self.state), 'workspace': str(self.workspace), 'runtime_key': 'owned',
            'harness_id': 'codex', 'command': command,
            'command_sha256': hashlib.sha256(pathlib.Path(command).read_bytes()).hexdigest()}

    def tearDown(self):
        for path in self.sockets:
            for name in self.names:
                subprocess.run(['/usr/bin/tmux', '-N', '-S', str(path), 'kill-session', '-t', '=cauce-' + name],
                    capture_output=True, timeout=2)
        self.temporary.cleanup()

    def tmux(self, *arguments, path=None):
        return subprocess.run(['/usr/bin/tmux', '-N', '-S', str(path or self.socket), *arguments],
            capture_output=True, text=True, timeout=2, check=True).stdout.strip()

    def start(self, name='owned', *, remain=False):
        self.names.add(name)
        subprocess.run(['/usr/bin/tmux', '-S', str(self.socket), '-f', '/dev/null', 'new-session', '-d',
            '-s', 'cauce-' + name, '-n', 'agente', '-c', str(self.workspace),
            'bash', '-lc', 'exec /usr/bin/sleep 120'], capture_output=True, check=True, timeout=2)
        self.tmux('set-option', '-t', 'cauce-' + name, '@cauce_alias', name)
        self.tmux('set-option', '-t', 'cauce-' + name, '@cauce_harness', 'codex')
        if remain:
            self.tmux('set-option', '-t', 'cauce-' + name, 'remain-on-exit', 'on')

    def observe(self):
        return tui.perform(self.request)

    def close(self, witness):
        return tui.perform({**self.request, 'action': 'close', 'witness': witness})

    def exists(self, name='owned', path=None):
        result = subprocess.run(['/usr/bin/tmux', '-N', '-S', str(path or self.socket), 'has-session',
            '-t', '=cauce-' + name], capture_output=True, timeout=2)
        return result.returncode == 0

    def test_missing_socket_is_observed_and_closed_idempotently(self):
        witness = self.observe()
        self.assertIsNone(witness['pane'])
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})

    def test_exact_shutdown_preserves_sibling_transcript_and_pointer(self):
        pointer = self.state / 'sessions.json'
        transcript = self.state / 'transcript.jsonl'
        pointer.write_text('{"native_id":"owned-conversation"}')
        transcript.write_text('owned transcript\n')
        self.start('sibling')
        self.start()
        witness = self.observe()
        self.assertIsInstance(witness['pane']['starttime'], int)
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})
        self.assertFalse(self.exists())
        self.assertTrue(self.exists('sibling'))
        self.assertEqual(pointer.read_text(), '{"native_id":"owned-conversation"}')
        self.assertEqual(transcript.read_text(), 'owned transcript\n')
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})

    def test_dead_canonical_pane_is_removed_without_a_process_guess(self):
        self.start('sibling')
        self.start(remain=True)
        pane = self.observe()['pane']
        os.kill(int(pane['pane_pid']), 15)
        deadline = time.monotonic() + 2
        while self.tmux('display-message', '-p', '-t', '=cauce-owned:agente', '#{pane_dead}') != '1':
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        witness = self.observe()
        self.assertIsNone(witness['pane']['starttime'])
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})
        self.assertFalse(self.exists())
        self.assertTrue(self.exists('sibling'))

    def test_retry_requires_the_original_process_identity_for_a_dead_pane(self):
        self.start('sibling')
        self.start(remain=True)
        witness = self.observe()
        os.kill(int(witness['pane']['pane_pid']), 15)
        deadline = time.monotonic() + 2
        while self.tmux('display-message', '-p', '-t', witness['pane']['pane_id'], '#{pane_dead}') != '1':
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        dead = self.observe()
        lost_identity = copy.deepcopy(dead)
        lost_identity['pane']['pane_pid'] = ''
        with mock.patch.object(tui.CanonicalTmux, 'observe', return_value=lost_identity), \
                mock.patch.object(tui.CanonicalTmux, 'cas') as mutation:
            with self.assertRaisesRegex(SafeFailure, 'generation changed'):
                self.close(witness)
        mutation.assert_not_called()
        self.assertTrue(self.exists())
        if dead['pane']['pane_pid'] == witness['pane']['pane_pid']:
            self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})
            self.assertFalse(self.exists())
        else:
            with self.assertRaisesRegex(SafeFailure, 'generation changed'):
                self.close(witness)
            self.assertTrue(self.exists())
        self.assertTrue(self.exists('sibling'))

    def test_post_signal_respawn_of_the_same_dead_pane_is_preserved(self):
        self.start('sibling')
        self.start(remain=True)
        witness = self.observe()
        original_signal = tui.signal_known_tree

        def signal_then_replace(*args, **kwargs):
            original_signal(*args, **kwargs)
            self.tmux('respawn-pane', '-k', '-t', witness['pane']['pane_id'],
                'bash', '-lc', 'exec /usr/bin/sleep 120')
            replacement = self.observe()['pane']
            self.assertNotEqual(replacement['pane_pid'], witness['pane']['pane_pid'])
            os.kill(int(replacement['pane_pid']), 15)
            deadline = time.monotonic() + 2
            while self.tmux('display-message', '-p', '-t', replacement['pane_id'], '#{pane_dead}') != '1':
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)

        with mock.patch.object(tui, 'signal_known_tree', side_effect=signal_then_replace):
            with self.assertRaisesRegex(SafeFailure, 'replacement was preserved'):
                self.close(witness)
        self.assertTrue(self.exists())
        self.assertTrue(self.exists('sibling'))

    def test_replay_preserves_a_new_generation_of_the_same_alias(self):
        self.start('sibling')
        self.start()
        witness = self.observe()
        self.close(witness)
        self.start()
        replacement = self.observe()
        self.assertNotEqual(replacement['pane']['pane_id'], witness['pane']['pane_id'])
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})
        self.assertEqual(self.observe(), replacement)

    def test_absence_witness_never_authorizes_a_new_session(self):
        self.start('sibling')
        witness = self.observe()
        self.start()
        with self.assertRaisesRegex(SafeFailure, 'appeared'):
            self.close(witness)
        self.assertTrue(self.exists())

    def test_absence_witness_remains_idempotent_after_the_server_disappears(self):
        self.start('sibling')
        witness = self.observe()
        self.tmux('kill-session', '-t', '=cauce-sibling')
        deadline = time.monotonic() + 2
        while True:
            try:
                if tui.proc_stat(witness['server']['pid'])['state'] in {'Z', 'X'}:
                    break
            except ProcessLookupError:
                break
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})

    def test_pid_starttime_mismatch_does_not_signal_the_live_pane(self):
        self.start()
        witness = self.observe()
        witness['pane']['starttime'] += 1
        with self.assertRaisesRegex(SafeFailure, 'generation changed'):
            self.close(witness)
        self.assertTrue(self.exists())

    def test_changed_markers_after_pinning_leave_the_process_untouched(self):
        self.start()
        witness = self.observe()
        original = tui.PinnedLeaderTree

        def pin(pid):
            tree = original(pid)
            self.tmux('set-option', '-t', 'cauce-owned', '@cauce_alias', 'replacement')
            return tree

        with mock.patch.object(tui, 'PinnedLeaderTree', side_effect=pin), \
                mock.patch.object(tui, 'signal_known_tree') as signal_tree:
            with self.assertRaisesRegex(SafeFailure, 'identity differs'):
                self.close(witness)
        signal_tree.assert_not_called()
        self.assertTrue(self.exists())

    def test_socket_replacement_cannot_retarget_the_original_process(self):
        self.start()
        witness = self.observe()
        old = self.directory / 'original'
        self.socket.rename(old)
        self.sockets.add(old)
        self.start()
        with self.assertRaisesRegex(SafeFailure, 'generation changed'):
            self.close(witness)
        self.assertTrue(self.exists(path=old))
        self.assertTrue(self.exists())

    def test_private_socket_and_directory_ownership_are_required(self):
        self.start()
        self.directory.chmod(0o755)
        with self.assertRaisesRegex(SafeFailure, 'directory ownership'):
            self.observe()
        self.directory.chmod(0o700)
        old = self.directory / 'original'
        self.socket.rename(old)
        self.sockets.add(old)
        self.socket.symlink_to(old)
        with self.assertRaisesRegex(SafeFailure, 'socket ownership'):
            self.observe()
        self.socket.unlink()
        old.rename(self.socket)

    def test_group_socket_mode_stays_private_below_owned_0700_directories(self):
        self.start()
        self.socket.chmod(0o660)
        witness = self.observe()
        self.assertIsNotNone(witness['pane'])
        self.assertEqual(self.close(witness), {'canonical_tui_stopped': True})

    def test_foreign_workspace_command_and_hooks_are_preserved(self):
        self.start()
        for changed in ({'workspace': str(self.state)}, {'command': '/usr/bin/false'}):
            with self.subTest(changed=changed), self.assertRaises(SafeFailure):
                tui.perform({**self.request, **changed})
        self.tmux('set-hook', '-g', 'after-list-panes', 'display-message unapproved')
        with self.assertRaisesRegex(SafeFailure, 'unapproved hooks'):
            self.observe()
        self.assertTrue(self.exists())


class CanonicalTuiContainerContractTest(unittest.TestCase):
    def setUp(self):
        self.agent = {'tenant_id': 'Canary', 'alias': 'wire', 'runtime_key': 'physical', 'harness_id': 'codex',
            'runtime_mode': 'container', 'container_name': 'zz-canary-tui', 'runtime_user': 'cauce',
            'state_directory': '/home/cauce/.cauce/physical', '_placement': {'python': '/usr/bin/python3'}}
        self.observed = {'Id': 'a' * 64, 'State': {'Running': True, 'Pid': 123, 'StartedAt': 'start'}}
        self.witness = {'socket': [1, 2], 'directories': [[1, 3], [1, 4]], 'server': {'pid': 222, 'starttime': 2}, 'pane': None}
        self.stack = self.enterContext(mock.patch.object(container, 'approve_agent', return_value=self.agent))
        self.enterContext(mock.patch.object(container, 'teardown_agent', return_value=self.agent))
        self.enterContext(mock.patch.object(container, 'provider_environment', return_value={}))
        self.enterContext(mock.patch.object(container, 'user_identity', return_value=('1500', '1500')))

    def test_observation_is_separate_from_mutation_and_uses_isolated_runtime_user(self):
        with mock.patch.object(container, 'inspect_container', return_value=self.observed), \
                mock.patch.object(container, 'checked_command', return_value=json.dumps(self.witness).encode()) as command:
            receipt = transport.observe_canonical_tui({}, self.agent)
        argv = command.call_args.args[0]
        self.assertEqual(argv[:7], ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', '1500:1500'])
        self.assertIn('-I', argv)
        self.assertIn('-B', argv)
        self.assertIn(transport.BOOTSTRAP, argv)
        payload = command.call_args.kwargs['input_data']
        self.assertEqual(hashlib.sha256(payload).hexdigest(), argv[-1])
        self.assertEqual(json.loads(payload)['request']['action'], 'observe')
        with mock.patch.object(container, 'inspect_container', return_value=self.observed), \
                mock.patch.object(container, 'checked_command', return_value=b'{"canonical_tui_stopped":true}') as command:
            self.assertEqual(transport.stop_canonical_tui({}, self.agent, receipt), {'canonical_tui_stopped': True})
        self.assertEqual(json.loads(command.call_args.kwargs['input_data'])['request']['witness'], self.witness)

    @unittest.skipIf(os.geteuid() == 0, 'canonical TUI requires a normal runtime user')
    def test_trusted_payload_runs_with_an_old_or_hostile_container_source_tree(self):
        with tempfile.TemporaryDirectory(prefix='zz-canary-old-source-') as temporary:
            directory = pathlib.Path(temporary)
            for filename in ('fleet_executor_tui.py', 'secure_path.py', 'cauce_container_proc.py'):
                (directory / filename).write_text('raise RuntimeError("foreign source was executed")\n')
            request = {'action': 'observe', 'runtime_key': 'owned', 'harness_id': 'codex',
                'state_directory': str(directory), 'workspace': str(directory / 'space/projects'),
                'uid': os.geteuid(), 'gid': os.getegid(), 'command': None, 'command_sha256': None}
            argv, payload = transport.helper_program(sys.executable, request)
            result = subprocess.run(argv, input=payload, cwd=directory, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIsNone(json.loads(result.stdout)['pane'])
            result = subprocess.run(argv, input=payload + b' ', cwd=directory, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'payload differs', result.stderr)

    def test_new_container_generation_is_preserved_without_launching_the_helper(self):
        with mock.patch.object(container, 'inspect_container', return_value=self.observed), \
                mock.patch.object(container, 'checked_command', return_value=json.dumps(self.witness).encode()):
            receipt = transport.observe_canonical_tui({}, self.agent)
        replacement = copy.deepcopy(self.observed)
        replacement['State']['StartedAt'] = 'replacement'
        with mock.patch.object(container, 'inspect_container', return_value=replacement), \
                mock.patch.object(container, 'checked_command') as command:
            with self.assertRaisesRegex(SafeFailure, 'container generation changed'):
                transport.stop_canonical_tui({}, self.agent, receipt)
        command.assert_not_called()

    def test_missing_container_is_idempotent_but_cannot_authorize_a_later_container(self):
        with mock.patch.object(container, 'inspect_container', return_value=None):
            receipt = transport.observe_canonical_tui({}, self.agent)
            self.assertEqual(transport.stop_canonical_tui({}, self.agent, receipt), {'canonical_tui_stopped': True})
        with mock.patch.object(container, 'inspect_container', return_value=self.observed):
            with self.assertRaisesRegex(SafeFailure, 'container generation changed'):
                transport.stop_canonical_tui({}, self.agent, receipt)


if __name__ == '__main__':
    unittest.main()
